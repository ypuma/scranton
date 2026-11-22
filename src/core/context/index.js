import path from 'node:path';
import { createInstructionCache } from '../instructions.js';
import { loadAgentsMd, PACKAGE_ROOT } from '../config.js';
import { createContextStore } from './store.js';
import { readTurns } from './turns.js';
import { buildTeamPack, buildPipelineContext, pipelineSections, safeText } from './pack.js';
import { LIMITS as L, DEFAULT_BUDGET, UNKNOWN_RECIPIENT, budgetFor, briefFor, pipelineAllowance } from './limits.js';
import { tokens } from './tokens.js';
import { PIPELINE_TERMINAL, maskHistoricalText } from './shared.js';
import { redact as defaultRedact } from '../dreaming/reflection.js';
import { listRuns, formatThreadContext, countContextRuns } from '../thread.js';
import { teamDreamingContext } from '../dreaming-sources.js';
import { buildPipelineHistory, listPipelineHistoryRuns, readPipelineHistoryJson } from '../pipeline-history.js';

export function createContext({ dataDir, registry, redact = defaultRedact, now = () => new Date().toISOString(), agentsMd, env = process.env }) {
  const cachedInstructions = createInstructionCache();
  const instructions = (p) => {
    const project = registry.getProject(p);
    const enabled = agentsMd ?? loadAgentsMd({ cwd: PACKAGE_ROOT, env });
    let exclude = [];
    try { exclude = registry.listChats(p).map(chat => chat.hiveDir).filter(dir => typeof dir === 'string'); } catch { /* Instructions remain available when chat history is degraded. */ }
    return cachedInstructions(project.workspace, { enabled, scratchDir: path.join(dataDir, '.scratch'), exclude });
  };
  const store = (p, c) => createContextStore(dataDir, p, c);
  const scope = (p, c) => { registry.getProject(p); return registry.getChat(p, c); };
  function gather(p, c, options = {}) {
    const chat = scope(p, c), project = store(p), state = store(p, c);
    if (project.degraded || state.degraded) throw Error('Unavailable context storage');
    const settings = project.settings(), notes = project.notes(), resetAt = state.state().resetAt;
    const budget = { bytes: L.readBytes - Buffer.byteLength(notes.text), cache: new Map() };
    const own = readTurns({ dataDir, projectId: p, chat, activeRunId: options.activeRunId, inspect: options.inspect, since: resetAt, redact: options.redact ?? redact, budget });
    own.degraded ||= project.degraded || state.degraded;
    const others = [];
    if (settings.crossChat) {
      const siblings = registry.listChats(p).filter((s) => s.id !== c && !s.error && s.projectId === p)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id)).slice(0, L.siblings);
      for (const sibling of siblings) {
        try {
          const state = store(p, sibling.id);
          const source = readTurns({ dataDir, projectId: p, chat: sibling, since: state.state().resetAt, sibling: true, maxRuns: L.siblingRuns, redact: options.redact ?? redact, budget });
          own.truncated ||= source.truncated; own.degraded ||= source.degraded || state.degraded;
          if (source.turns.length) others.push({ title: sibling.title, engine: sibling.engine === 'pipeline' ? 'pipeline' : 'team', turns: source.turns.slice(-L.otherTurns) });
        } catch { own.truncated = true; own.degraded = true; }
      }
    }
    return { chat, settings, notes, resetAt, own, others, budget };
  }
  const recipientsFor = (options) => ({ planner: options.recipients?.planner ?? UNKNOWN_RECIPIENT, developer: options.recipients?.developer ?? UNKNOWN_RECIPIENT });
  const settingsFor = (p) => { try { return store(p).settings(); } catch { return { crossChat: true, budget: { ...DEFAULT_BUDGET }, models: {} }; } };
  function team(g, memory, recipients) { return buildTeamPack({ ...g.own, notes: g.notes.text, memory, otherChats: g.others, redact,
    units: 4 * budgetFor(g.settings, recipients.planner).tokens, developerUnits: 4 * briefFor(g.settings, recipients.developer) }); }
  function legacyTeam(p, c, memory, recipients) {
    let text = '';
    try { text = teamDreamingContext(formatThreadContext(listRuns(scope(p, c).hiveDir), { maxChars: 8000 }), memory); } catch {}
    text = text.toWellFormed();
    const settings = settingsFor(p);
    return { text, developer: '', sections: text ? [{ id: 'recent', title: 'Earlier runs (legacy fallback)', chars: text.length, tokens: tokens(text), text, exact: true }] : [],
      meta: { degraded: true, budget: { tokens: budgetFor(settings, recipients.planner).tokens, used: tokens(text) }, developer: { tokens: briefFor(settings, recipients.developer), used: 0 } } };
  }
  function pipeline(p, c, g, options) {
    const { historyBytes, contextBytes } = pipelineAllowance(g.settings, recipientsFor(options).planner);
    const wire = buildPipelineHistory({ dataDir, projectId: p, chatId: c, redact: options.redact ?? redact, projectMemory: options.projectMemory ?? [],
      context: buildPipelineContext({ turns: g.own.turns, notes: g.notes.text, otherChats: g.others, redact: options.redact ?? redact }), since: g.resetAt, budget: g.budget, excludedRunId: options.activeRunId,
      allowance: { historyBytes, contextBytes } });
    if (wire) wire.truncated ||= g.own.truncated || Boolean(g.budget.exhausted);
    return wire;
  }
  function legacyPipeline(p, c, options, since) {
    try { scope(p, c); since ??= store(p, c).state().resetAt; return buildPipelineHistory({ dataDir, projectId: p, chatId: c, redact: options.redact ?? redact, projectMemory: options.projectMemory ?? [], since }); } catch { return null; }
  }
  function status(p) {
    registry.getProject(p);
    return instructions(p).then(value => statusDocument(p, value));
  }
  function statusDocument(p, instructionStatus) {
    const project = store(p);
    let degraded = false;
    const result = { v: 2, instructions: instructionStatus, settings: project.settings(), defaults: { budget: { ...DEFAULT_BUDGET }, window: L.window, percent: [L.percentMin, L.percentMax], tokens: [L.tokensMin, L.tokensMax], models: L.overrides,
      pipeline: [Math.floor((L.pipelineHistoryFloor + L.pipelineContextFloor) / 4), Math.floor((Math.floor(L.enginePromptBytes / 4) + Math.floor(L.enginePromptBytes / 8)) / 4)], pipelineBytes: { history: [L.pipelineHistoryFloor, Math.floor(L.enginePromptBytes / 4)], context: [L.pipelineContextFloor, Math.floor(L.enginePromptBytes / 8)] } }, notes: project.notes(), chats: registry.listChats(p).filter((c) => c.projectId === p).map((chat) => {
      const state = store(p, chat.id), resetAt = state.state().resetAt;
      degraded ||= state.degraded;
      let turns = 0;
      if (chat.engine !== 'pipeline') turns = countContextRuns(chat.hiveDir);
      else {
        const scope = `projects/${p}/chats/${chat.id}/pipeline/runs`;
        for (const id of listPipelineHistoryRuns(dataDir, p, chat.id).ids) {
          const status = readPipelineHistoryJson(dataDir, `${scope}/${id}/status.json`);
          if (PIPELINE_TERMINAL.includes(status?.status)) turns++;
        }
      }
      return { id: chat.id.toWellFormed(), title: safeText(chat.title, redact), engine: chat.engine === 'pipeline' ? 'pipeline' : 'team', turns,
        lastActiveAt: typeof chat.updatedAt === 'string' ? chat.updatedAt.toWellFormed() : null, reset: Boolean(resetAt) };
    }) };
    if (degraded || project.degraded) result.degraded = true;
    return result;
  }
  function inspect(p, c, options = {}) {
    scope(p, c);
    return instructions(p).then(value => inspectDocument(p, c, options, value));
  }
  function inspectDocument(p, c, options, instructionStatus) {
    const chat = scope(p, c), engine = chat.engine === 'pipeline' ? 'pipeline' : 'team';
    const recipients = recipientsFor(options);
    let g, pack, wire, pipelineNotes = '', degraded = false;
    try {
      g = gather(p, c, { ...options, inspect: true });
      if (engine === 'team') pack = team(g, typeof options.memory === 'string' ? options.memory : '', recipients);
      else {
        pipelineNotes = maskHistoricalText((options.redact ?? redact)(safeText(g.notes.text, options.redact ?? redact).trim()).toWellFormed().replace(/<\/?(?:earlier-runs|conversation-context)\s*>/gi, (tag) => '[' + tag.replace(/[<>/\s]/g, '') + ']'), true);
        wire = pipeline(p, c, g, { ...options, projectMemory: Array.isArray(options.memory) ? options.memory : [], activeRunId: options.activeRunId });
      }
    } catch {
      degraded = true;
      g ??= { settings: store(p).settings(), notes: store(p).notes(), resetAt: store(p, c).state().resetAt, own: { turns: [], total: 0, unread: 0, truncated: false }, others: [] };
      if (engine === 'team') pack = legacyTeam(p, c, options.memory, recipients);
      else wire = legacyPipeline(p, c, { projectMemory: Array.isArray(options.memory) ? options.memory : [] }, g.resetAt);
    }
    const sections = engine === 'team' ? pack.sections : pipelineSections(wire), runs = wire?.runs ?? [], context = wire?.context;
    const meta = engine === 'team' ? { turns: { total: g.own.total, visible: g.own.turns.length, detailed: 0, condensed: 0, omitted: 0 }, otherChats: { chats: 0, turns: 0 },
      notes: { chars: 0, tokens: 0, cut: false }, memory: { chars: 0, tokens: 0 }, truncated: false, ...pack.meta } : {
      turns: { total: g.own.total, visible: g.own.turns.length + g.own.unread, detailed: runs.length, condensed: context?.earlier?.length ?? 0, omitted: Math.max(0, g.own.turns.length - runs.length - (context?.earlier?.length ?? 0)) + g.own.unread },
      otherChats: { chats: context?.other_chats?.length ?? 0, turns: context?.other_chats?.reduce((n, o) => n + o.turns.length, 0) ?? 0 }, notes: { chars: context?.notes?.length ?? 0, tokens: tokens(context?.notes), cut: (context?.notes?.length ?? 0) < pipelineNotes.length },
      memory: { chars: wire?.project_memory?.reduce((n, m) => n + m.text.length, 0) ?? 0, tokens: tokens(wire?.project_memory?.map((m) => m.text).join('\n')) }, truncated: Boolean(wire?.truncated || g.own.truncated) };
    const allowance = pipelineAllowance(g.settings, recipients.planner), contextBytes = context ? Buffer.byteLength(JSON.stringify(context)) : 0;
    const wireBytes = wire ? Buffer.byteLength(JSON.stringify(wire)) : 0;
    const budget = engine === 'team' ? { ...budgetFor(g.settings, recipients.planner), used: tokens(pack.text) } : { ...allowance,
      used: Math.ceil((Math.min(wireBytes - contextBytes, allowance.historyBytes) + Math.min(contextBytes, allowance.contextBytes)) / 4) };
    return { v: 2, instructions: instructionStatus, engine, settings: g.settings, reset: g.resetAt ? { at: g.resetAt } : null, ...meta, model: recipients.planner, budget,
      notes: { ...meta.notes, limit: L.notes }, degraded: Boolean(degraded || g.own.degraded || g.budget?.degraded || pack?.meta.degraded),
      sections, developer: engine === 'team' ? { model: recipients.developer, budget: { tokens: briefFor(g.settings, recipients.developer), used: tokens(pack.developer) }, chars: pack.developer.length, tokens: tokens(pack.developer), text: pack.developer } : null };
  }
  return { status, inspect,
    configure(p, value) { registry.getProject(p); store(p).configure(value); return status(p); },
    setNotes(p, text) { registry.getProject(p); store(p).setNotes(text); return status(p); },
    reset(p, c) { scope(p, c); store(p, c).setReset(new Date(now()).toISOString()); return inspect(p, c); },
    restore(p, c) { scope(p, c); store(p, c).setReset(null); return inspect(p, c); },
    forTeam(p, c, options = {}) {
      const memory = options.memory ?? '', recipients = recipientsFor(options);
      try { const { text, developer, meta } = team(gather(p, c), memory, recipients); return { text, developer, meta }; }
      catch { const { text, developer, meta } = legacyTeam(p, c, memory, recipients); return { text, developer, meta }; }
    },
    forPipeline(p, c, options = {}) {
      let g;
      try { g = gather(p, c, options); return pipeline(p, c, g, options); }
      catch { return legacyPipeline(p, c, options, g?.resetAt); }
    }
  };
}
