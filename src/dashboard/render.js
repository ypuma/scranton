import {
  fitSegments, makePainter, padSegments, renderSegments, sanitize, segWidth, spread, textWidth,
  truncate, truncateStart,
} from './text.js';

const BRAND = 'SCRANTON';
const TAGLINE = 'Agent Orchestration';
const IDLE_MESSAGE = 'No run yet - start one with: scranton run "..."  or  scranton demo';

const UNICODE = {
  h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯', dot: '·', ell: '…',
  lampOn: '●', lampOff: '○', lampOpen: '', lampClose: '',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  passed: '✓', failed: '✕', active: '●', pending: '○', skipped: '–', aborted: '✕',
  idle: '○', waiting: '○', thinking: '◐', working: '●', blocked: '■', error: '✕', done: '✓', alert: '■',
  starting: '◌',
};

const ASCII = {
  h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', dot: '-', ell: '...',
  lampOn: '#', lampOff: '.', lampOpen: '[', lampClose: ']',
  spinner: ['|', '/', '-', '\\'],
  passed: '+', failed: 'x', active: '*', pending: 'o', skipped: '-', aborted: 'x',
  idle: 'o', waiting: 'o', thinking: '~', working: '*', blocked: '#', error: 'x', done: '+', alert: '!!',
  starting: 'o',
};

// Grayscale only: weight and inversion carry the emphasis, see text.js.
const MUTED = 'fg:245';
const FAINT = 'fg:240';
const LOUD = 'bold inverse';

const AGENTS = [
  { id: 'michael', name: 'MICHAEL', role: 'Orchestrator' },
  { id: 'dwight', name: 'DWIGHT', role: 'Developer' },
  { id: 'angela', name: 'ANGELA', role: 'QA' },
];

const DISPLAY_AGENTS = [
  ...AGENTS.slice(0, 2),
  { id: 'oscar', name: 'OSCAR', role: 'Code Reviewer' },
  { id: 'hank', name: 'HANK', role: 'Security Auditor' },
  AGENTS[2],
];
const GATE_LABEL = {
  REVIEW_APPROVED: 'APPROVED', CHANGES_REQUESTED: 'CHANGES',
  SECURITY_PASSED: 'SECURITY PASSED', SECURITY_ISSUES: 'SECURITY ISSUES',
  TEST_PASSED: 'TEST PASSED', TEST_FAILED: 'TEST FAILED', BLOCKED: 'BLOCKED',
};

const STATUS_STYLE = {
  idle: MUTED, thinking: 'bold', working: 'bold', waiting: null, blocked: 'bold', error: LOUD, done: null,
};
const ANIMATED = new Set(['thinking', 'working']);
const TIMED = new Set(['thinking', 'working', 'waiting', 'blocked']);

const RUN_BADGE = {
  idle: 'fg:248 bg:236', planning: 'bold fg:255 bg:238', running: 'bold fg:255 bg:238',
  paused: LOUD, finished: 'fg:252 bg:238', aborted: LOUD, failed: LOUD,
};

const MILESTONE_STYLE = {
  passed: null, active: 'bold', failed: 'bold', skipped: FAINT, aborted: 'bold', pending: FAINT, blocked: 'bold',
};

// Instance states (state.json instances) beyond the agent ones; terminal ones sort last and take no lane row first.
const TERMINAL = new Set(['done', 'finished', 'failed', 'aborted', 'stopped', 'cancelled']);
const LANE_PRIORITY = { error: 7, blocked: 6, working: 5, thinking: 4, starting: 3, waiting: 2, idle: 1 };
// unknown: the ACK timed out, it may or may not have arrived and is never resent automatically
const DELIVERY_STYLE = { queued: MUTED, delivered: null, rejected: LOUD, unknown: 'bold' };
const AGENT_ORDER = { michael: 0, dwight: 1, oscar: 2, hank: 3, angela: 4 };
// The event log keeps at least this many rows before lanes and messages take any.
const MIN_LOG_ROWS = 3;
const MAX_LANE_ROWS = 8;

const KIND_STYLE = { bug_report: 'bold', hitl: 'bold' };

const RESULT_STYLE = {
  success: 'bold', partial: 'bold', aborted: LOUD, failed: LOUD, passed: 'bold', skipped: MUTED,
};

const LEVEL_STYLE = { info: MUTED, warn: 'bold', error: LOUD };

const ENDED = new Set(['finished', 'aborted', 'failed']);

// How an ended run reports the milestones that did not pass, in this order.
const OUTCOME = [['skipped', 'skipped'], ['blocked', 'blocked'], ['failed', 'failed'], ['aborted', 'aborted'], ['active', 'unfinished'], ['pending', 'not started']];

const SPINNER_MS = 120;

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function has(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key);
}

function keywordStyle(keyword) {
  if (!keyword) return MUTED;
  return /FAILED|BLOCKED/.test(keyword) ? 'bold' : null;
}

// Formats are shared with the web dashboard (visualizer/public/js/format.js); keep them identical.

// Inverse text needs a cell of air on each side to read as a label, not a smear.
function label(text, style, ctx) {
  return [ctx.color && style && style.includes('inverse') ? ` ${text} ` : text, style];
}

export function formatTokens(n) {
  n = Math.max(0, num(n));
  if (Math.round(n) < 1000) return String(Math.round(n));
  // Integer rounding (not toFixed on a float) so 1150 reads 1.2k, exactly like the web dashboard.
  const k = Math.round(n / 100) / 10;
  if (k < 1000) return `${k.toFixed(1)}k`;
  return `${(Math.round(n / 1e5) / 10).toFixed(1)}M`;
}

export function formatCost(cost) {
  const v = Math.max(0, num(cost));
  return `$${v.toFixed(v > 0 && v < 0.9995 ? 3 : 2)}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(num(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function clock(ts) {
  const d = new Date(ts);
  if (typeof ts !== 'string' || Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function shortRunId(runId, ell) {
  const id = sanitize(runId);
  return id.length <= 20 ? id : ell + id.slice(-12);
}

function normalizeAgent(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const totals = a.totals && typeof a.totals === 'object' ? a.totals : {};
  const status = has(STATUS_STYLE, a.status) ? a.status : 'idle';
  return {
    status,
    activity: sanitize(a.activity) || (status === 'idle' ? 'Idle' : ''),
    lastKeyword: sanitize(a.lastKeyword) || null,
    updatedAt: str(a.updatedAt) || null,
    totals: { runs: num(totals.runs), input: num(totals.input), output: num(totals.output), cost: num(totals.cost) },
  };
}

function sandboxMode(v) {
  if (typeof v === 'string') return sanitize(v);
  return v && typeof v === 'object' ? sanitize(v.mode) : '';
}

// Case and trailing separators do not make a different directory on Windows.
function samePath(a, b) {
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  return typeof a === 'string' && typeof b === 'string' && a !== '' && b !== '' && norm(a) === norm(b);
}

// Only a reported directory other than the run workspace is a worktree.
function isWorktree(v, workspace) {
  if (v === null || v === undefined || v === false || v === 'shared') return false;
  if (typeof v === 'string') return !samePath(v, workspace);
  if (v && typeof v === 'object') return v.mode !== 'shared' && !samePath(v.dir ?? v.path, workspace);
  return v === true;
}

function normalizeInstances(raw, milestones, workspace) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const order = new Map(milestones.map((m, i) => [m.id, i]));
  const list = Object.entries(raw)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    .map(([key, v]) => ({
      id: sanitize(v.id) || sanitize(key) || '?',
      agent: /^[a-z][a-z0-9]{1,19}$/.test(v.agent) ? v.agent : null,
      milestoneId: sanitize(v.milestoneId) || null,
      status: sanitize(v.status) || 'idle',
      activity: sanitize(v.activity),
      tool: sanitize(typeof v.tool === 'string' ? v.tool : v.tool && typeof v.tool === 'object' ? v.tool.tool : ''),
      sessionId: sanitize(v.sessionId),
      worktree: isWorktree(v.worktree, workspace),
      sandbox: sandboxMode(v.sandbox),
    }));
  const rank = (i) => (i.milestoneId && order.has(i.milestoneId) ? order.get(i.milestoneId) : -1);
  return list.sort((a, b) => Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status))
    || rank(a) - rank(b) || (AGENT_ORDER[a.agent] ?? 9) - (AGENT_ORDER[b.agent] ?? 9) || a.id.localeCompare(b.id));
}

function normalizeChat(raw) {
  return (Array.isArray(raw) ? raw : []).filter((c) => c && typeof c === 'object').slice(-50).map((c) => ({
    from: sanitize(c.from) || '?',
    to: sanitize(c.to) || '?',
    text: sanitize(typeof c.text === 'string' ? c.text.slice(0, 2000) : ''),
    delivery: has(DELIVERY_STYLE, c.delivery) ? c.delivery : 'queued',
    reason: sanitize(c.reason),
    ts: str(c.ts) || null,
  }));
}

// A role box of a parallel run speaks for its loudest live instance, not for whichever lane wrote last.
// state.json has no event order per lane, so a role-level status no live lane reports (Michael overseeing,
// or blocked on a human after his lane ended idle or in error) is taken as the newer news while no lane is busy.
function withLanes(agent, id, instances) {
  const live = instances.filter((i) => i.agent === id && !TERMINAL.has(i.status));
  if (!live.length) return agent;
  const busy = live.filter((i) => ANIMATED.has(i.status));
  const roleSaid = !busy.length && agent.status !== 'idle' && agent.status !== 'done' && !live.some((i) => i.status === agent.status);
  if (roleSaid) return { ...agent, lanes: live.length };
  const top = [...live].sort((a, b) => (LANE_PRIORITY[b.status] ?? 0) - (LANE_PRIORITY[a.status] ?? 0))[0];
  const status = has(STATUS_STYLE, top.status) ? top.status : agent.status;
  const activity = busy.length > 1 ? `${busy.length} lanes: ${busy.map((i) => i.id).join(', ')}` : `${top.id}: ${top.activity || top.status}`;
  return { ...agent, status, activity, lanes: live.length };
}

function workflowGates(raw, roles = DISPLAY_AGENTS) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const seen = new Set();
  for (const stage of raw) {
    if (!Array.isArray(stage) || !stage.length) return null;
    for (const id of stage) {
      if (!roles.some((role) => role.id === id && (role.kind === 'gate' || ['oscar', 'hank', 'angela'].includes(id))) || seen.has(id)) return null;
      seen.add(id);
    }
  }
  return raw;
}

function normalizeReply(raw) {
  if (!raw || !['answer', 'report', 'summary'].includes(raw.kind) || typeof raw.text !== 'string') return null;
  return { kind: raw.kind, text: sanitize(raw.text.slice(0, 16000)) };
}

function normalizeState(state, events) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  if (!state.runId || state.status === 'idle' || !has(RUN_BADGE, state.status)) return null;
  const agents = state.agents && typeof state.agents === 'object' ? state.agents : {};
  const milestones = (Array.isArray(state.milestones) ? state.milestones : [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      id: sanitize(m.id),
      title: sanitize(m.title) || sanitize(m.id),
      status: has(MILESTONE_STYLE, m.status) ? m.status : 'pending',
      dependsOn: Array.isArray(m.dependsOn) ? m.dependsOn.map(sanitize).filter(Boolean) : [],
    }));
  const instances = normalizeInstances(state.instances, milestones, str(state.workspace));
  const known = new Set(milestones.map((m) => m.id));
  const started = lastEvent(events, (e) => e.type === 'run_started' && e.runId === state.runId);
  const snapshot = started?.roles ?? state.roles;
  const catalog = Array.isArray(snapshot) ? snapshot.filter((role, i, all) => role && role.builtin === false && !DISPLAY_AGENTS.some((a) => a.id === role.id) && /^[a-z][a-z0-9]{1,19}$/.test(role.id)
    && all.findIndex((other) => other?.id === role.id) === i).slice(0, 17).map((role) => {
    return { id: role.id, name: sanitize(role.name).toUpperCase() || role.id.toUpperCase(),
      role: sanitize(role.title) || 'Gate', kind: 'gate', builtin: false,
      passKeyword: role.passKeyword, failKeyword: role.failKeyword };
  }) : [];
  const available = [...DISPLAY_AGENTS, ...catalog];
  const workflow = workflowGates(started?.execution?.workflow?.gates, available) || workflowGates(state.execution?.workflow?.gates, available);
  const legacy = workflow?.length === 1 && workflow[0].length === 1 && workflow[0][0] === 'angela';
  const gates = legacy ? null : workflow;
  const roles = gates ? ['michael', 'dwight', ...gates.flat()].map((id) => available.find((a) => a.id === id)) : AGENTS;
  const gateResults = Object.create(null);
  for (const e of events) {
    if (e.type !== 'gate_result' || e.runId !== state.runId || !Number.isInteger(e.stage) || e.stage < 0 || !gates?.[e.stage]?.includes(e.agent)) continue;
    const milestone = (Array.isArray(state.milestones) ? state.milestones : []).find((m) => m?.id === e.milestoneId);
    const cycle = Number.isFinite(milestone?.cycle) ? milestone.cycle : state.cycle;
    if (e.cycle !== cycle || (!ENDED.has(state.status) && e.milestoneId !== state.currentMilestoneId)) continue;
    if (!gateResults[e.agent] || e.seq > gateResults[e.agent].seq) gateResults[e.agent] = e;
  }
  return {
    gates, roles, gateResults,
    runId: String(state.runId),
    status: state.status,
    request: sanitize(state.request),
    workspace: str(state.workspace),
    updatedAt: str(state.updatedAt) || null,
    milestones,
    currentMilestoneId: str(state.currentMilestoneId) || null,
    activeMilestoneIds: (Array.isArray(state.activeMilestoneIds) ? state.activeMilestoneIds : []).filter((id) => known.has(id)),
    instances,
    chat: normalizeChat(state.chat),
    reply: normalizeReply(state.reply) || normalizeReply(lastEvent(events, (e) => e.type === 'run_reply' && e.runId === state.runId)),
    cycle: num(state.cycle),
    failedCycles: num(state.failedCycles),
    maxFailedCycles: num(state.maxFailedCycles, 3),
    breaker: state.breaker === 'tripped' ? 'tripped' : 'closed',
    agents: Object.fromEntries(roles.map((a) => [a.id, withLanes(normalizeAgent(agents[a.id]), a.id, instances)])),
  };
}

function idleAgents() {
  return Object.fromEntries(AGENTS.map((a) => [a.id, normalizeAgent(null)]));
}

function lastEvent(events, test) {
  for (let i = events.length - 1; i >= 0; i--) if (test(events[i])) return events[i];
  return null;
}

// ---------------------------------------------------------------- header

function badge(status, ctx) {
  const label = status.toUpperCase();
  return ctx.color ? [` ${label} `, RUN_BADGE[status]] : [`[${label}]`, null];
}

function firstFitting(options, width, ell) {
  for (const [left, right] of options) {
    if (segWidth(left) + (right.length ? segWidth(right) + 2 : 0) <= width) return spread(left, right, width, ell);
  }
  const [left, right] = options[options.length - 1];
  return spread(left, right, width, ell);
}

function runInfo(st, events, ctx) {
  const status = st.status;
  const info = [['run ', MUTED], [shortRunId(st.runId, ctx.ell), null]];
  const started = lastEvent(events, (e) => e.type === 'run_started');
  const startMs = started ? Date.parse(started.ts) : NaN;
  if (Number.isFinite(startMs)) {
    const ended = lastEvent(events, (e) => e.type === 'run_finished');
    let endMs = ended ? Date.parse(ended.ts) : ctx.now;
    if (!ended && ENDED.has(status) && st.updatedAt) endMs = Date.parse(st.updatedAt);
    if (Number.isFinite(endMs)) info.push(['  ', null], [formatDuration(endMs - startMs), MUTED]);
  }
  return info;
}

// Returns the line and whether the run id made it onto it.
function brandLine(st, info, ctx) {
  const brand = [[BRAND, 'bold'], ['   ' + TAGLINE, MUTED]];
  const right = [badge(st ? st.status : 'idle', ctx)];
  const withInfo = [...info, ...(info.length ? [['   ', null]] : []), ...right];
  const full = segWidth(brand) + segWidth(withInfo) + 2 <= ctx.cw;
  const line = full
    ? spread(brand, withInfo, ctx.cw, ctx.ell)
    : firstFitting([[brand, right], [[[BRAND, 'bold']], right]], ctx.cw, ctx.ell);
  return { line, hasInfo: full };
}

function breakerMeter(st, ctx) {
  const g = ctx.g;
  const max = Math.max(0, st.maxFailedCycles);
  const failed = Math.max(0, Math.min(st.failedCycles, max || st.failedCycles));
  const tripped = st.breaker === 'tripped';
  const segs = [];
  if (max > 0 && max <= 10) {
    segs.push([g.lampOpen, FAINT], [g.lampOn.repeat(failed), 'bold'], [g.lampOff.repeat(max - failed), FAINT], [g.lampClose, FAINT], [' ', null]);
  }
  segs.push(label(`${st.failedCycles}/${max}`, tripped ? LOUD : failed ? 'bold' : null, ctx));
  return segs;
}

// An ended run has no current milestone, cycle or breaker worth showing: it gets its outcome instead.
function outcomeLine(st, ctx) {
  const g = ctx.g;
  const total = st.milestones.length;
  const count = (status) => st.milestones.filter((m) => m.status === status).length;
  const left = total
    ? [[`${count('passed')}/${total}`, 'bold'], [' milestones passed', MUTED]]
    : [['no milestones ran', MUTED]];
  for (const [status, word] of OUTCOME) {
    const n = count(status);
    if (n) left.push([` ${g.dot} `, FAINT], [String(n), status === 'pending' ? null : 'bold'], [` ${word}`, MUTED]);
  }
  const sum = { runs: 0, tokens: 0, cost: 0 };
  for (const a of Object.values(st.agents)) {
    sum.runs += a.totals.runs;
    sum.tokens += a.totals.input + a.totals.output;
    sum.cost += a.totals.cost;
  }
  const right = [
    [String(sum.runs), null], [sum.runs === 1 ? ' agent run' : ' agent runs', MUTED], [` ${g.dot} `, FAINT],
    [formatTokens(sum.tokens), null], [' tok', MUTED], [` ${g.dot} `, FAINT], [formatCost(sum.cost), null],
  ];
  return segWidth(left) + segWidth(right) + 2 <= ctx.cw ? spread(left, right, ctx.cw, ctx.ell) : fitSegments(left, ctx.cw, ctx.ell);
}

function milestoneLine(st, ctx) {
  if (ENDED.has(st.status)) return outcomeLine(st, ctx);
  const total = st.milestones.length;
  const index = st.milestones.findIndex((m) => m.id === st.currentMilestoneId);
  const active = st.activeMilestoneIds.map((id) => st.milestones.find((m) => m.id === id));
  let left;
  if (active.length > 1) {
    left = [['Milestones ', MUTED], [`${active.length} in parallel`, 'bold'], [': ', MUTED],
      ...active.flatMap((m, i) => [...(i ? [[` ${ctx.g.dot} `, FAINT]] : []), [m.id, 'bold'], [' ' + m.title, null]])];
    const meter = breakerMeter(st, ctx);
    const full = [['Breaker ', MUTED], ...meter];
    return spread(left, ctx.cw - segWidth(full) >= 40 ? full : meter, ctx.cw, ctx.ell);
  }
  if (index >= 0) {
    left = [['Milestone ', MUTED], [`${index + 1}/${total}`, 'bold'], [': ', MUTED], [st.milestones[index].title, 'bold']];
  } else if (!total) {
    left = [['Milestone ', MUTED], ['-/-', 'bold'], ['  planning milestones...', MUTED]];
  } else {
    const passed = st.milestones.filter((m) => m.status === 'passed').length;
    left = [['Milestones ', MUTED], [`${passed}/${total}`, 'bold'], [' passed', MUTED]];
  }
  const meter = breakerMeter(st, ctx);
  const cycle = index >= 0 && st.cycle > 0 ? [['Cycle ', MUTED], [String(st.cycle), 'bold'], ['   ', null]] : [];
  const full = [...cycle, ['Breaker ', MUTED], ...meter];
  const right = ctx.cw - segWidth(full) >= 24 ? full : meter;
  return spread(left, right, ctx.cw, ctx.ell);
}

function alertLines(st, events, ctx) {
  const g = ctx.g;
  const lines = [];
  const loud = (text, glyph = g.alert) => (ctx.color
    ? padSegments([[` ${glyph}  ${text}`, LOUD]], ctx.cw, LOUD)
    : [[`${ASCII.alert} ${text} ${ASCII.alert}`, null]]);
  const say = (text, short) => {
    const line = loud(text);
    if (segWidth(line) <= ctx.cw) lines.push(line);
    else lines.push(loud(short[0]), loud(short[1]));
  };
  // The run end wins: an aborted run keeps breaker "tripped" and may leave a hitl_request unanswered.
  if (ENDED.has(st.status)) {
    const done = lastEvent(events, (e) => e.type === 'run_finished');
    const result = done && has(RESULT_STYLE, done.status) ? done.status : st.status === 'finished' ? 'success' : st.status;
    const good = result === 'success';
    const summary = done && done.summary ? '  ' + sanitize(done.summary) : '';
    if (st.status === 'finished' && result !== 'aborted' && result !== 'failed') {
      lines.push([[`${good ? g.passed : g.failed} Run ${st.status}: `, 'bold'], [result, 'bold'], [summary, null]]);
    } else {
      const text = `Run ${st.status}${result === st.status ? '' : `: ${result}`}${summary}`;
      lines.push(fitSegments(loud(text, g.failed), ctx.cw, ctx.ell));
    }
    if (st.reply) {
      lines.push([[`${g.h.repeat(2)} Reply (${st.reply.kind}) ${g.h.repeat(2)}`, 'bold']]);
      lines.push(fitSegments([[st.reply.text, null]], ctx.cw, ctx.ell));
    }
    return lines;
  }
  if (st.breaker === 'tripped') {
    say('CIRCUIT BREAKER TRIPPED - answer in the orchestrator terminal', ['CIRCUIT BREAKER TRIPPED', 'answer in the orchestrator terminal']);
  } else if (st.status === 'paused') {
    say('PAUSED - a human is needed - answer in the orchestrator terminal', ['PAUSED - a human is needed', 'answer in the orchestrator terminal']);
  }
  if (lines.length) {
    const open = lastEvent(events, (e) => e.type === 'hitl_request' || e.type === 'hitl_response');
    if (open && open.type === 'hitl_request') {
      const options = Array.isArray(open.options) ? open.options.map(sanitize).filter(Boolean) : [];
      lines.push([
        ['Human needed: ', 'bold'], [sanitize(open.reason), null],
        ...(options.length ? [[`  options: ${options.join(' / ')}`, MUTED]] : []),
      ]);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- agent panels

function statusSegments(status, ctx) {
  const style = STATUS_STYLE[status];
  const glyphStyle = style === LOUD ? 'bold' : style;
  return [[ctx.g[status], glyphStyle], [' ', null], label(status.toUpperCase(), style, ctx)];
}

function agentBits(meta, agent, events, ctx) {
  const g = ctx.g;
  const busy = ANIMATED.has(agent.status);
  const since = agent.updatedAt ? Date.parse(agent.updatedAt) : NaN;
  const elapsed = TIMED.has(agent.status) && Number.isFinite(since) ? formatDuration(ctx.now - since) : '';
  const spinner = busy ? g.spinner[Math.floor(ctx.now / SPINNER_MS) % g.spinner.length] : '';
  const tool = lastEvent(events, (e) => e.type === 'agent_tool' && e.agent === meta.id);
  const loud = agent.status === 'blocked' || agent.status === 'error';
  return {
    border: loud ? 'bold' : busy ? null : FAINT,
    status: statusSegments(agent.status, ctx),
    elapsed: [
      ...(spinner ? [[spinner, 'bold'], ...(elapsed ? [[' ', null]] : [])] : []),
      ...(elapsed ? [[elapsed, MUTED]] : []),
    ],
    activity: [[agent.activity || '-', agent.status === 'idle' ? MUTED : null]],
    tool: tool
      ? [[sanitize(tool.tool), busy ? null : MUTED], ['  ', null], [sanitize(tool.detail), MUTED]]
      : [['no tool calls yet', MUTED]],
    keyword: ctx.gates && ctx.gates.flat().includes(meta.id)
      ? [['gate  ', MUTED], [gateText(ctx.gateResults[meta.id] || (meta.builtin === false && agent.lastKeyword ? { keyword: agent.lastKeyword } : null), meta), 'bold']]
      : [['last  ', MUTED], [agent.lastKeyword || '-', keywordStyle(agent.lastKeyword)]],
    totals: [
      [String(agent.totals.runs), null], [agent.totals.runs === 1 ? ' run' : ' runs', MUTED], [` ${g.dot} `, FAINT],
      [formatTokens(agent.totals.input + agent.totals.output), null], [' tok', MUTED], [` ${g.dot} `, FAINT],
      [formatCost(agent.totals.cost), null],
    ],
    title: [[meta.name, 'bold'], [` ${g.dot} `, FAINT], [meta.role, MUTED]],
  };
}

function gateText(event, meta) {
  if (!event) return '-';
  if (meta?.builtin === false) {
    if (event.keyword === 'BLOCKED') return 'BLOCKED';
    if (event.keyword === meta.failKeyword) return 'FAILED';
    if (event.keyword === meta.passKeyword) return 'PASSED';
    return event.result === 'blocked' ? 'BLOCKED' : event.result === 'error' ? 'ERROR' : 'FAILED';
  }
  return has(GATE_LABEL, event.keyword) ? GATE_LABEL[event.keyword] : sanitize(event.result).toUpperCase() || '-';
}

function workflowLine(ctx) {
  const join = ctx.ascii ? ' || ' : ' ∥ ';
  const text = ctx.gates.map((stage, i) => `Stage ${i + 1}: ${stage.join(join)}${stage.length > 1 ? ' (parallel)' : ''}`).join(' -> ');
  if (ctx.roles.length > 5 && textWidth(text) > ctx.cw) {
    return [[ctx.gates.map((stage, i) => `Stage ${i + 1}: ${stage.length > 1 ? `${stage.length} gates (parallel)` : stage[0]}`).join(' -> '), MUTED]];
  }
  return [[text, MUTED]];
}

function workflowPanels(mode, agents, events, ctx) {
  const group = (roles) => {
    if (!roles.length) return [];
    const gap = 2;
    const base = Math.floor((ctx.cw - gap * (roles.length - 1)) / roles.length);
    const boxes = roles.map((meta, i) => {
      const w = i === roles.length - 1 ? ctx.cw - (base + gap) * i : base;
      const b = agentBits(meta, agents[meta.id], events, ctx);
      return [
        boxTop(b.title, [], w, b.border, ctx),
        boxRow(spread(b.status, b.elapsed, w - 4, ctx.ell), w, b.border, ctx),
        boxRow(b.activity, w, b.border, ctx),
        ...(!mode.endsWith('-short') ? [boxRow(b.tool, w, b.border, ctx)] : []),
        boxRow(segWidth(b.keyword) > w - 4 ? [b.keyword[1]] : b.keyword, w, b.border, ctx),
        ...(!mode.endsWith('-short') ? [boxRow(b.totals, w, b.border, ctx)] : []),
        boxBottom(w, b.border, ctx),
      ];
    });
    return boxes[0].map((_, row) => boxes.flatMap((box, i) => [...(i ? [[' '.repeat(gap), null]] : []), ...box[row]]));
  };
  return mode.startsWith('workflow-columns') ? group(ctx.roles)
    : [...group(ctx.roles.slice(0, 2)), ...group(ctx.roles.slice(2))];
}

function boxTop(title, right, width, border, ctx) {
  const g = ctx.g;
  const room = width - 6;
  let rightSegs = right;
  if (segWidth(title) + segWidth(right) + 3 > room) rightSegs = [];
  const t = fitSegments(title, room - (rightSegs.length ? segWidth(rightSegs) + 3 : 0), ctx.ell);
  const used = 3 + segWidth(t) + 1 + (rightSegs.length ? 1 + segWidth(rightSegs) + 1 : 0) + 1;
  const fill = Math.max(0, width - used);
  return [
    [g.tl + g.h + ' ', border], ...t, [' ' + g.h.repeat(fill), border],
    ...(rightSegs.length ? [[' ', null], ...rightSegs, [' ', null]] : []),
    [g.tr, border],
  ];
}

function boxRow(content, width, border, ctx) {
  const inner = width - 4;
  return [[ctx.g.v + ' ', border], ...padSegments(fitSegments(content, inner, ctx.ell), inner), [' ' + ctx.g.v, border]];
}

function boxBottom(width, border, ctx) {
  return [[ctx.g.bl + ctx.g.h.repeat(Math.max(0, width - 2)) + ctx.g.br, border]];
}

function columnPanels(agents, events, ctx) {
  const gap = 2;
  const base = Math.floor((ctx.cw - gap * 2) / 3);
  const widths = [base, base, ctx.cw - gap * 2 - base * 2];
  const boxes = AGENTS.map((meta, i) => {
    const w = widths[i];
    const b = agentBits(meta, agents[meta.id], events, ctx);
    return [
      boxTop(b.title, [], w, b.border, ctx),
      boxRow(spread(b.status, b.elapsed, w - 4, ctx.ell), w, b.border, ctx),
      boxRow(b.activity, w, b.border, ctx),
      boxRow(b.tool, w, b.border, ctx),
      boxRow(b.keyword, w, b.border, ctx),
      boxRow(b.totals, w, b.border, ctx),
      boxBottom(w, b.border, ctx),
    ];
  });
  const space = [' '.repeat(gap), null];
  return boxes[0].map((_, row) => [...boxes[0][row], space, ...boxes[1][row], space, ...boxes[2][row]]);
}

function stackedPanels(agents, events, ctx) {
  const w = ctx.cw;
  const lines = [];
  for (const meta of AGENTS) {
    const b = agentBits(meta, agents[meta.id], events, ctx);
    const status = [...b.status, ...(b.elapsed.length ? [[' ', null], ...b.elapsed] : [])];
    let left = [...status, ['  ', null], ...b.activity];
    // The last tool only goes in when there is room to make it readable.
    if (w - 4 - segWidth(b.keyword) - 2 - segWidth(left) >= 3 + 12) left = [...left, ['   ', null], ...b.tool];
    lines.push(
      boxTop(b.title, b.totals, w, b.border, ctx),
      boxRow(spread(left, b.keyword, w - 4, ctx.ell), w, b.border, ctx),
      boxBottom(w, b.border, ctx),
    );
  }
  return lines;
}

function compactPanels(agents, events, ctx) {
  const roles = ctx.roles || AGENTS;
  const shown = ctx.roleRows && roles.length > ctx.roleRows ? roles.slice(0, Math.max(0, ctx.roleRows - 1)) : roles;
  const lines = shown.map((meta) => {
    const b = agentBits(meta, agents[meta.id], events, ctx);
    const word = b.status[2];
    const left = [
      b.status[0], [' ', null], [(roles.length > 5 ? truncate(meta.name, Math.min(20, Math.max(9, Math.floor(ctx.cw / 4))), ctx.ell) : meta.name).padEnd(9), 'bold'],
      word, [' '.repeat(Math.max(1, 10 - textWidth(word[0]))), null], ...b.activity,
    ];
    return spread(left, [b.keyword[1]], ctx.cw, ctx.ell);
  });
  if (shown.length < roles.length) lines.push([[`+${roles.length - shown.length} more roles`, MUTED]]);
  return lines;
}

const PANEL_HEIGHT = { columns: 7, stacked: 9, compact: 3, 'workflow-columns': 7, 'workflow-grid': 14,
  'workflow-columns-short': 5, 'workflow-grid-short': 10 };

function panelHeight(mode, ctx) {
  return (mode === 'compact' ? Math.min(ctx.roleRows ?? 17, (ctx.roles || AGENTS).length) : PANEL_HEIGHT[mode]) + (ctx.gates ? 1 : 0);
}

function panels(mode, agents, events, ctx) {
  if (ctx.gates) return [workflowLine(ctx), ...(mode === 'compact' ? compactPanels(agents, events, ctx) : workflowPanels(mode, agents, events, ctx))];
  if (ctx.roles && ctx.roles !== AGENTS) return mode === 'compact' ? compactPanels(agents, events, ctx)
    : workflowPanels('workflow-columns', agents, events, ctx);
  if (mode === 'columns') return columnPanels(agents, events, ctx);
  if (mode === 'stacked') return stackedPanels(agents, events, ctx);
  return compactPanels(agents, events, ctx);
}

function panelMode(ctx, spareRows) {
  if (ctx.roles?.length > 5) {
    ctx.roleRows = Math.max(1, spareRows - MIN_LOG_ROWS - (ctx.gates ? 1 : 0));
    return 'compact';
  }
  if (ctx.gates) {
    if (ctx.height < 24 || ctx.width < 80) return 'compact';
    const mode = ctx.width >= 120 ? 'workflow-columns' : 'workflow-grid';
    if (spareRows - panelHeight(mode, ctx) >= MIN_LOG_ROWS) return mode;
    const short = `${mode}-short`;
    return spareRows - panelHeight(short, ctx) >= MIN_LOG_ROWS ? short : 'compact';
  }
  let mode = ctx.width >= 100 ? 'columns' : ctx.cw >= 44 ? 'stacked' : 'compact';
  if (mode !== 'compact' && spareRows - PANEL_HEIGHT[mode] < 4) mode = 'compact';
  return mode;
}

// ---------------------------------------------------------------- milestones and events

function milestoneRow(st, ctx) {
  const head = [['Milestones  ', MUTED]];
  if (!st.milestones.length) return [...head, ['waiting for the plan...', MUTED]];
  const build = (name) => st.milestones.flatMap((m, i) => [
    ...(i ? [['   ', null]] : []),
    [ctx.g[m.status], MILESTONE_STYLE[m.status]],
    ...(name ? [[' ' + name(m), m.status === 'active' ? 'bold' : m.status === 'pending' || m.status === 'skipped' ? MUTED : null]] : []),
  ]);
  const room = ctx.cw - segWidth(head);
  let row = build((m) => m.title);
  if (segWidth(row) > room) {
    const each = Math.floor(room / st.milestones.length) - 4;
    row = each >= 6 ? build((m) => truncate(m.title, each, ctx.ell)) : build((m) => m.id);
  }
  if (segWidth(row) > room) row = build(null);
  return [...head, ...row];
}

function who(id, pad = 0) {
  return [(sanitize(id) || '?').padEnd(pad), 'bold'];
}

function deliveryLabel(delivery, ctx) {
  const d = has(DELIVERY_STYLE, delivery) ? delivery : 'queued';
  return label(d, DELIVERY_STYLE[d], ctx);
}

// ---------------------------------------------------------------- instance lanes and messages

function laneLine(inst, ctx, idWidth) {
  const g = ctx.g;
  const status = inst.status;
  const style = has(STATUS_STYLE, status) ? STATUS_STYLE[status] : TERMINAL.has(status) ? MUTED : null;
  const glyph = has(g, status) && typeof g[status] === 'string' ? g[status] : TERMINAL.has(status) ? g.done : g.idle;
  const word = status.toUpperCase();
  const left = [
    [glyph, style === LOUD ? 'bold' : style], [' ', null], [inst.id.padEnd(idWidth), TERMINAL.has(status) ? MUTED : 'bold'], ['  ', null],
    label(word, style, ctx), [' '.repeat(Math.max(1, 10 - textWidth(word))), null],
    [inst.activity || '-', TERMINAL.has(status) || status === 'idle' ? MUTED : null],
    ...(inst.tool && ANIMATED.has(status) ? [['  ', null], [inst.tool, MUTED]] : []),
  ];
  const right = [];
  if (ctx.cw >= 70) {
    if (inst.milestoneId) right.push([inst.milestoneId, MUTED]);
    if (inst.worktree) right.push([` ${g.dot} `, FAINT], ['worktree', MUTED]);
    // host execution has no sandbox boundary, so it never reads as quietly as a container
    if (inst.sandbox) right.push([` ${g.dot} `, FAINT], [inst.sandbox, inst.sandbox === 'host' ? 'bold' : MUTED]);
    if (ctx.cw >= 110 && inst.sessionId) right.push([` ${g.dot} `, FAINT], [inst.sessionId.slice(0, 8), FAINT]);
    if (right[0] && right[0][1] === FAINT) right.shift();
  }
  return spread(left, right, ctx.cw, ctx.ell);
}

// Up to `room` rows: a rule and one row per lane (live ones first), or a one-row summary when room is 1.
function laneLines(st, ctx, room) {
  const lanes = st.instances;
  if (!lanes.length || room < 1) return [];
  const live = lanes.filter((i) => !TERMINAL.has(i.status));
  const done = lanes.length - live.length;
  if (room === 1) {
    const busy = live.filter((i) => ANIMATED.has(i.status));
    return [fitSegments([
      ['Lanes  ', MUTED], [`${live.length} live`, 'bold'], ...(done ? [[`  ${done} done`, MUTED]] : []),
      ...(busy.length ? [['  ', null], [busy.map((i) => `${i.id} ${i.status}`).join(', '), null]] : []),
    ], ctx.cw, ctx.ell)];
  }
  const shown = live.length ? live : lanes;
  const rows = Math.min(room - 1, MAX_LANE_ROWS);
  const head = rule(`Lanes  ${live.length} live${done ? `, ${done} done` : ''}`, ctx);
  const idWidth = Math.min(14, Math.max(...shown.map((i) => textWidth(i.id))));
  const fit = shown.length <= rows ? shown : shown.slice(0, Math.max(0, rows - 1));
  const lines = fit.map((i) => laneLine(i, ctx, idWidth));
  if (fit.length < shown.length) lines.push([[`+${shown.length - fit.length} more lanes`, MUTED]]);
  return [head, ...lines];
}

// The newest messages, at widths where a route and some text fit on a row.
function chatLines(st, ctx, room) {
  const chat = st.chat;
  if (!chat.length || room < 2 || ctx.cw < 60) return [];
  const queued = chat.filter((c) => c.delivery === 'queued').length;
  const rejected = chat.filter((c) => c.delivery === 'rejected').length;
  const unknown = chat.filter((c) => c.delivery === 'unknown').length;
  const title = `Messages  ${chat.length}${queued ? `, ${queued} queued` : ''}${rejected ? `, ${rejected} rejected` : ''}${unknown ? `, ${unknown} unknown` : ''}`;
  const recent = chat.slice(-Math.min(2, room - 1));
  return [rule(title, ctx), ...recent.map((c) => fitSegments([
    [clock(c.ts), MUTED], ['   ', null], who(c.from), [' -> ', FAINT], who(c.to), ['  ', null], deliveryLabel(c.delivery, ctx),
    ['  ' + (c.delivery === 'rejected' && c.reason ? `${c.reason}: ${c.text}` : c.text), null],
  ], ctx.cw, ctx.ell))];
}

function resultLabel(status, ctx) {
  return label(status, has(RESULT_STYLE, status) ? RESULT_STYLE[status] : 'bold', ctx);
}

function eventSegments(e, st, ctx) {
  switch (e.type) {
    case 'run_started':
      return [['run started', 'bold'], ['  ' + sanitize(e.request), null]];
    case 'plan_ready': {
      const list = Array.isArray(e.milestones) ? e.milestones.filter((m) => m && typeof m === 'object') : [];
      return [['plan ready', 'bold'], [`  ${list.length} milestone${list.length === 1 ? '' : 's'}: `, null],
        [list.map((m) => sanitize(m.title) || sanitize(m.id)).join(', '), MUTED]];
    }
    case 'milestone_started':
      return [[`milestone ${num(e.index) + 1}/${num(e.total)} started`, 'bold'], ['  ' + sanitize(e.title), null]];
    case 'milestone_finished': {
      const m = st && st.milestones.find((x) => x.id === e.milestoneId);
      return [[`milestone ${sanitize(e.milestoneId)} `, 'bold'], resultLabel(sanitize(e.status), ctx),
        ...(m ? [['  ' + m.title, MUTED]] : []), ...(e.reason ? [['  ' + sanitize(e.reason), MUTED]] : [])];
    }
    case 'milestone_integrated':
      return [[`milestone ${sanitize(e.milestoneId)} `, 'bold'], ['integrated', null]];
    case 'instance_started': {
      const sb = sandboxMode(e.sandbox);
      return [who(e.instanceId || e.id, 7), ['  started', 'bold'], ...(e.milestoneId ? [['  ' + sanitize(e.milestoneId), null]] : []),
        ...(isWorktree(e.worktree, st && st.workspace) ? [['  worktree', MUTED]] : []), ...(sb ? [['  ' + sb, sb === 'host' ? 'bold' : MUTED]] : [])];
    }
    case 'chat_message':
      return [who(e.from), [' -> ', FAINT], who(e.to), ['  ', null], deliveryLabel(e.delivery, ctx), ['  ' + sanitize(e.text), null]];
    case 'chat_delivery':
      return [['message ', 'bold'], [sanitize(e.id).slice(0, 8), MUTED], ['  ', null], deliveryLabel(e.delivery, ctx),
        ...(e.delivery === 'unknown' ? [['  not resent automatically', MUTED]] : []),
        ...(e.reason ? [['  ' + sanitize(e.reason), MUTED]] : [])];
    // a refused spool command carries no id or payload
    case 'chat_command_rejected':
      return [['chat command ', 'bold'], deliveryLabel('rejected', ctx), ...(e.reason ? [['  ' + sanitize(e.reason), MUTED]] : [])];
    case 'hive_write':
      return [who(e.from), [' -> ', FAINT], who(e.to), ['  ', null],
        [sanitize(e.kind), has(KIND_STYLE, e.kind) ? KIND_STYLE[e.kind] : MUTED], ['  ' + sanitize(e.summary), null]];
    case 'agent_status':
      return [who(e.instanceId || e.agent, 7), ['  ', null], label(sanitize(e.status), has(STATUS_STYLE, e.status) ? STATUS_STYLE[e.status] : null, ctx),
        ['  ' + sanitize(e.activity), MUTED]];
    case 'agent_tool':
      return [who(e.instanceId || e.agent, 7), ['  ', null], [sanitize(e.tool), null], ['  ' + sanitize(e.detail), MUTED]];
    case 'agent_finished': {
      const usage = e.usage && typeof e.usage === 'object' ? e.usage : null;
      const kw = sanitize(e.keyword);
      return [who(e.instanceId || e.agent, 7), ['  finished  ', null], [kw || 'no keyword', keywordStyle(kw)],
        [`  exit ${num(e.exitCode)}  ${formatDuration(e.durationMs)}`, MUTED],
        ...(usage ? [[`  ${formatTokens(num(usage.input) + num(usage.output))} tok  ${formatCost(usage.cost)}`, MUTED]] : [])];
    }
    case 'gate_result':
      return [who(e.agent), [' gate ', null], [sanitize(e.result), 'bold'], [' ' + (sanitize(e.keyword) || '-'), MUTED]];
    case 'cycle_result': {
      const failed = e.result === 'failed';
      return [[`cycle ${num(e.cycle)} `, 'bold'], label(failed ? 'FAILED' : 'PASSED', failed ? LOUD : 'bold', ctx),
        [`  ${sanitize(e.milestoneId)}`, null],
        ...(failed ? [[`  ${num(e.failedCycles)} failed in a row`, 'bold']] : []),
        ['  ' + sanitize(e.reason), MUTED]];
    }
    case 'circuit_breaker':
      return e.state === 'tripped'
        ? [label('CIRCUIT BREAKER TRIPPED', LOUD, ctx), [`  ${sanitize(e.milestoneId)}  ${num(e.failedCycles)}/${num(e.maxFailedCycles)} failed cycles`, null]]
        : [['circuit breaker reset', 'bold'], [`  ${sanitize(e.milestoneId)}`, null]];
    case 'hitl_request': {
      const options = Array.isArray(e.options) ? e.options.map(sanitize).filter(Boolean) : [];
      return [label('HUMAN NEEDED', LOUD, ctx), ['  ' + sanitize(e.reason), null],
        ...(options.length ? [[`  [${options.join('/')}]`, MUTED]] : [])];
    }
    case 'hitl_response':
      return [['human', 'bold'], ['  decided ', null], [sanitize(e.decision), 'bold'],
        ...(e.feedback ? [[`  "${sanitize(e.feedback)}"`, MUTED]] : [])];
    case 'agent_message':
      return null;
    case 'run_reply': {
      const reply = normalizeReply(e);
      return reply ? [['reply [', 'bold'], [reply.kind, MUTED], ['] ', 'bold'], [truncate(reply.text, 80, ctx.ell), null]] : null;
    }
    case 'run_finished':
      return [['run finished  ', 'bold'], resultLabel(sanitize(e.status), ctx), ['  ' + sanitize(e.summary), null]];
    case 'log': {
      const level = has(LEVEL_STYLE, e.level) ? e.level : 'info';
      return [[level.toUpperCase().padEnd(5), LEVEL_STYLE[level]], [' ', null], [sanitize(e.message), level === 'info' ? null : 'bold']];
    }
    default:
      return null;
  }
}

function eventLines(events, st, rows, ctx) {
  const lines = [];
  for (let i = events.length - 1; i >= 0 && lines.length < rows; i--) {
    const e = events[i];
    if (!e || typeof e !== 'object') continue;
    let segs = null;
    try {
      segs = eventSegments(e, st, ctx);
    } catch {
      segs = null;
    }
    if (segs) lines.unshift([[clock(e.ts), MUTED], ['   ', null], ...segs]);
  }
  if (!lines.length && rows > 0) lines.push([['No events yet', MUTED]]);
  return lines;
}

function rule(title, ctx) {
  const g = ctx.g;
  const head = g.h.repeat(2) + ' ';
  return [[head, FAINT], [title, 'bold'], [' ' + g.h.repeat(Math.max(0, ctx.cw - textWidth(head) - textWidth(title) - 1)), FAINT]];
}

function footer(st, ctx) {
  const g = ctx.g;
  // One cell short of the edge so the last row never triggers a wrap/scroll.
  const width = ctx.cw - 1;
  const left = [['q', 'bold'], [' quit', MUTED]];
  const right = st && st.updatedAt ? [['updated ', MUTED], [clock(st.updatedAt), MUTED]] : [];
  if (ctx.hiveDir) {
    const prefix = `  ${g.dot}  hive `;
    const room = width - segWidth(left) - textWidth(prefix) - (right.length ? segWidth(right) + 2 : 0);
    if (room >= 8) left.push([prefix, FAINT], [truncateStart(sanitize(ctx.hiveDir), room, ctx.ell), MUTED]);
  }
  return spread(left, right, width, ctx.ell);
}

// ---------------------------------------------------------------- screens

function idleScreen(ctx) {
  const top = [brandLine(null, [], ctx).line, []];
  const message = [[IDLE_MESSAGE, 'bold']];
  if (segWidth(message) <= ctx.cw) top.push(message);
  else top.push([['No run yet - start one with:', 'bold']], [['  scranton run "..."  or  scranton demo', 'bold']]);
  top.push([]);
  const foot = footer(null, ctx);
  const mode = panelMode(ctx, ctx.height - top.length - 1 + 4);
  const body = [...top, ...panels(mode, idleAgents(), [], ctx)];
  return layout(body, [], foot, ctx);
}

function runScreen(st, events, ctx) {
  const info = runInfo(st, events, ctx);
  const brand = brandLine(st, info, ctx);
  const request = [['Request  ', MUTED], [st.request || '-', null]];
  const body = [
    brand.hasInfo || segWidth(info) + 2 + 45 > ctx.cw ? request : spread(request, info, ctx.cw, ctx.ell),
    milestoneLine(st, ctx),
    ...alertLines(st, events, ctx),
  ];
  const ms = milestoneRow(st, ctx);
  const spare = ctx.height - body.length - 4;
  const mode = panelMode(ctx, spare);
  // rows the lanes and messages would like; they give way to the event log, never the other way round
  const live = st.instances.filter((i) => !TERMINAL.has(i.status)).length;
  const wanted = (st.instances.length ? 1 + Math.min(MAX_LANE_ROWS, live || st.instances.length) : 0)
    + (st.chat.length && ctx.cw >= 60 ? 1 + Math.min(2, st.chat.length) : 0);
  // Blank rows go in only while the event log keeps a useful height: under the brand, above the panels, above the log.
  const gaps = Math.max(0, Math.min(3, spare - panelHeight(mode, ctx) - 13 - wanted));
  const gap = (n) => (gaps >= n ? [[]] : []);
  const head = [brand.line, ...gap(1), ...body, ...gap(2), ...panels(mode, st.agents, events, ctx), ms];
  let room = Math.max(0, ctx.height - head.length - 2 - MIN_LOG_ROWS);
  const lanes = laneLines(st, ctx, Math.min(room, st.instances.length ? 1 + MAX_LANE_ROWS : 0));
  room -= lanes.length;
  const chat = chatLines(st, ctx, Math.min(room, 3));
  const top = [...head, ...lanes, ...chat, ...gap(3)];
  const rows = ctx.height - top.length - 2;
  const log = rows >= 1 ? [rule('Event log', ctx), ...eventLines(events, st, rows, ctx)] : [];
  return layout(top, log, footer(st, ctx), ctx);
}

function layout(top, log, foot, ctx) {
  const body = [...top, ...log].slice(0, Math.max(0, ctx.height - 1));
  while (body.length < ctx.height - 1) body.push([]);
  return ctx.height >= 1 ? [...body, foot] : [];
}

export function renderDashboard(state, events, { width, height, color = true, ascii = false, now = Date.now(), hiveDir = null } = {}) {
  width = Math.max(1, Math.floor(num(width, 80)));
  height = Math.max(1, Math.floor(num(height, 24)));
  const g = ascii ? ASCII : UNICODE;
  const margin = width >= 40 ? 1 : 0;
  const ctx = {
    width, height, color: Boolean(color), ascii: Boolean(ascii), now: num(now, Date.now()), hiveDir,
    g, ell: g.ell, cw: width - margin * 2,
  };
  const paint = makePainter(ctx.color);
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const st = normalizeState(state, list);
  if (st) Object.assign(ctx, { roles: st.roles, gates: st.gates, gateResults: st.gateResults });
  const lines = st ? runScreen(st, list, ctx) : idleScreen(ctx);
  const pad = margin ? [[' '.repeat(margin), null]] : [];
  return lines.map((segs) => {
    const safe = ctx.ascii ? segs.map(([text, style]) => [text.replace(/[^\x00-\x7f]/gu, '?'), style]) : segs;
    return renderSegments([...pad, ...fitSegments(safe, ctx.cw, ctx.ell)], paint).trimEnd();
  }).join('\n');
}
