import { createContextStore } from './store.js';
import { readTurns } from './turns.js';
import { buildTeamPack, buildPipelineContext, pipelineSections, safeText } from './pack.js';
import { LIMITS as L } from './limits.js';
import { PIPELINE_TERMINAL } from './shared.js';
import { redact as defaultRedact } from '../dreaming/reflection.js';
import { listRuns, formatThreadContext, countContextRuns } from '../thread.js';
import { teamDreamingContext } from '../dreaming-sources.js';
import { buildPipelineHistory, listPipelineHistoryRuns, readPipelineHistoryJson } from '../pipeline-history.js';

export function createContext({ dataDir, registry, redact = defaultRedact, now = () => new Date().toISOString() }) {
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
  function team(g, memory) { return buildTeamPack({ ...g.own, notes: g.notes.text, memory, otherChats: g.others, redact }); }
  function legacyTeam(p, c, memory) {
    let text = '';
    try { text = teamDreamingContext(formatThreadContext(listRuns(scope(p, c).hiveDir), { maxChars: 8000 }), memory); } catch {}
    text = text.toWellFormed();
    return { text, developer: '', sections: text ? [{ id: 'recent', title: 'Earlier runs (legacy fallback)', chars: text.length, text, exact: true }] : [], meta: { degraded: true } };
  }
  function pipeline(p, c, g, options) {
    const wire = buildPipelineHistory({ dataDir, projectId: p, chatId: c, redact: options.redact ?? redact, projectMemory: options.projectMemory ?? [],
      context: buildPipelineContext({ turns: g.own.turns, notes: g.notes.text, otherChats: g.others, redact: options.redact ?? redact }), since: g.resetAt, budget: g.budget, excludedRunId: options.activeRunId });
    if (wire) wire.truncated ||= g.own.truncated || Boolean(g.budget.exhausted);
    return wire;
  }
  function legacyPipeline(p, c, options, since) {
    try { scope(p, c); since ??= store(p, c).state().resetAt; return buildPipelineHistory({ dataDir, projectId: p, chatId: c, redact: options.redact ?? redact, projectMemory: options.projectMemory ?? [], since }); } catch { return null; }
  }
  function status(p) {
    registry.getProject(p);
    const project = store(p);
    let degraded = false;
    const result = { v: 1, settings: project.settings(), notes: project.notes(), chats: registry.listChats(p).filter((c) => c.projectId === p).map((chat) => {
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
    const chat = scope(p, c), engine = chat.engine === 'pipeline' ? 'pipeline' : 'team';
    let g, pack, wire, degraded = false;
    try {
      g = gather(p, c, { ...options, inspect: true });
      if (engine === 'team') pack = team(g, typeof options.memory === 'string' ? options.memory : '');
      else wire = pipeline(p, c, g, { projectMemory: Array.isArray(options.memory) ? options.memory : [], activeRunId: options.activeRunId });
    } catch {
      degraded = true;
      g ??= { settings: store(p).settings(), notes: store(p).notes(), resetAt: store(p, c).state().resetAt, own: { turns: [], total: 0, unread: 0, truncated: false }, others: [] };
      if (engine === 'team') pack = legacyTeam(p, c, options.memory);
      else wire = legacyPipeline(p, c, { projectMemory: Array.isArray(options.memory) ? options.memory : [] }, g.resetAt);
    }
    const sections = engine === 'team' ? pack.sections : pipelineSections(wire), runs = wire?.runs ?? [], context = wire?.context;
    const meta = engine === 'team' ? { turns: { total: g.own.total, visible: g.own.turns.length, detailed: 0, condensed: 0, omitted: 0 }, otherChats: { chats: 0, turns: 0 },
      notes: { chars: 0 }, memory: { chars: 0 }, budget: { limit: L.teamAccepted, used: pack.text.length }, truncated: false, ...pack.meta } : {
      turns: { total: g.own.total, visible: g.own.turns.length + g.own.unread, detailed: runs.length, condensed: context?.earlier?.length ?? 0, omitted: Math.max(0, g.own.turns.length - runs.length - (context?.earlier?.length ?? 0)) + g.own.unread },
      otherChats: { chats: context?.other_chats?.length ?? 0, turns: context?.other_chats?.reduce((n, o) => n + o.turns.length, 0) ?? 0 }, notes: { chars: context?.notes?.length ?? 0 },
      memory: { chars: wire?.project_memory?.reduce((n, m) => n + m.text.length, 0) ?? 0 }, budget: { limit: L.pipelineBytes, used: wire ? Buffer.byteLength(JSON.stringify(wire)) : 0 }, truncated: Boolean(wire?.truncated || g.own.truncated) };
    return { v: 1, engine, settings: g.settings, reset: g.resetAt ? { at: g.resetAt } : null, ...meta, notes: { ...meta.notes, limit: L.notes }, degraded: Boolean(degraded || g.own.degraded || g.budget?.degraded || pack?.meta.degraded),
      sections, developer: engine === 'team' ? { chars: pack.developer.length, text: pack.developer } : null };
  }
  return { status, inspect,
    configure(p, value) { registry.getProject(p); store(p).configure(value); return status(p); },
    setNotes(p, text) { registry.getProject(p); store(p).setNotes(text); return status(p); },
    reset(p, c) { scope(p, c); store(p, c).setReset(new Date(now()).toISOString()); return inspect(p, c); },
    restore(p, c) { scope(p, c); store(p, c).setReset(null); return inspect(p, c); },
    forTeam(p, c, { memory = '' } = {}) {
      try { const { text, developer, meta } = team(gather(p, c), memory); return { text, developer, meta }; }
      catch { const { text, developer, meta } = legacyTeam(p, c, memory); return { text, developer, meta }; }
    },
    forPipeline(p, c, options = {}) {
      let g;
      try { g = gather(p, c, options); return pipeline(p, c, g, options); }
      catch { return legacyPipeline(p, c, options, g?.resetAt); }
    }
  };
}
