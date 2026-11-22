// Pure reducer: Contract v1 events -> dashboard view model.
// No DOM, so Node can import it for tests.
import { formatDuration, formatTokens, stripBidi } from './format.js';

export const AGENT_IDS = ['michael', 'dwight', 'oscar', 'hank', 'angela'];
export const PARTICIPANTS = [...AGENT_IDS, 'human'];
export const GATE_ROLES = ['oscar', 'hank', 'angela'];
// what the engine runs when run_started reports no workflow (every run before gates existed)
export const LEGACY_GATES = Object.freeze([Object.freeze(['angela'])]);
export const ROLE_TITLES = { michael: 'Orchestrator', dwight: 'Developer', oscar: 'Reviewer', hank: 'Security', angela: 'QA' };
// a gate in the workflow summary: "Review + Security -> Tests"
export const GATE_STEP = { oscar: 'Review', hank: 'Security', angela: 'Tests' };
export const GATE_RESULTS = ['passed', 'failed', 'blocked', 'error'];
// a custom agent id (.enma/custom-agents-contract.md section 2): no dash, so 'seclint-m1' splits cleanly
export const ROLE_ID_RE = /^[a-z][a-z0-9]{1,19}$/;
const ROLE_KINDS = ['planner', 'developer', 'gate'];
export const LOG_SIZE = 500;
export const CHAT_SIZE = 200;
// The control route and agent_chat accept 16000; the view keeps a bounded copy.
export const CHAT_TEXT_MAX = 16000;
// An error log line or a failed agent's activity is kept this long, so the open log row can show it in full.
export const FAILURE_TEXT_MAX = 2000;
// Live activity (.enma/live-activity-contract.md sections 1 and 2): the files an instance last touched, and the
// points the usage series keeps.
export const TOUCHED_MAX = 8;
export const USAGE_POINTS_MAX = 120;
// The paths of the files a run wrote that are kept, newest last, as many as the log keeps rows: a path that fell out
// of them and is written again counts once more.
export const WRITTEN_MAX = LOG_SIZE;
const FILE_TOOLS = { read: 'read', write: 'write', edit: 'edit' };
const SHELL_TOOLS = new Set(['bash', 'powershell']);
// Instance states after which nothing is delivered any more (the control route's list, plus the view-only
// 'interrupted' of a run whose process exited).
export const TERMINAL_STATUSES = new Set(['finished', 'failed', 'aborted', 'stopped', 'cancelled', 'done', 'interrupted']);
// 'unknown': the ACK timed out, so it may or may not have arrived; it is never resent automatically.
export const DELIVERIES = ['queued', 'delivered', 'rejected', 'unknown'];
// Milestone outcomes that never satisfy a dependency.
const UNMET = new Set(['skipped', 'failed', 'aborted', 'blocked', 'interrupted']);
// The progress check after a failed cycle and why the breaker asks (.enma/adaptive-cycles-contract.md).
export const PROGRESS_REASON_MAX = 300;
export const DEFAULT_MAX_FAILED_CYCLES = 12;
const VERDICTS = ['progress', 'stalled'];
const CHECK_SOURCES = ['rule', 'michael'];
const CHECK_RULES = ['no_change', 'repeat'];
export const TRIP_CAUSES = ['stalled', 'budget', 'limit'];
const VERDICT_WORD = { progress: 'Progress', stalled: 'No progress' };
const CHECK_HOW = { no_change: 'nothing changed', repeat: 'same failure again' };
// what the breaker tile and a milestone card say a trip is
export const TRIP_WORD = { stalled: 'No progress', budget: 'Budget used', limit: 'Cycle limit' };

const NAMES = { michael: 'Michael', dwight: 'Dwight', oscar: 'Oscar', hank: 'Hank', angela: 'Angela', human: 'Human' };
// what a gate card says about its result for the cycle
const GATE_LABEL = {
  oscar: { passed: 'Approved', failed: 'Changes requested' },
  hank: { passed: 'No security issues', failed: 'Security issues' },
  angela: { passed: 'Tests passed', failed: 'Tests failed' },
};
// a custom gate: its own pass and fail keywords read the same for every agent
const CUSTOM_GATE_LABEL = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', error: 'Gate error' };

const KNOWN_TYPES = new Set([
  'run_started', 'plan_ready', 'milestone_started', 'hive_write', 'agent_status', 'agent_tool',
  'agent_finished', 'cycle_result', 'circuit_breaker', 'hitl_request', 'hitl_response',
  'milestone_finished', 'run_finished', 'log', 'instance_started', 'chat_message', 'chat_delivery', 'milestone_integrated',
  'chat_command_rejected', 'gate_result', 'agent_message', 'run_reply', 'agent_usage', 'progress_check',
]);

const CATEGORY = {
  hive_write: 'handoffs',
  chat_message: 'handoffs',
  chat_delivery: 'handoffs',
  chat_command_rejected: 'handoffs',
  agent_tool: 'tools',
  agent_finished: 'results',
  cycle_result: 'results',
  milestone_finished: 'results',
  milestone_integrated: 'results',
  gate_result: 'results',
  run_finished: 'results',
  run_reply: 'results',
  circuit_breaker: 'results',
  progress_check: 'results',
  hitl_request: 'results',
  hitl_response: 'results',
};

const RUN_STATUS_BY_RESULT = { success: 'finished', partial: 'finished', aborted: 'aborted', failed: 'failed' };

// The custom roles of the run on screen (run_started.roles without the built-ins), in the order the engine listed
// them. The built-ins keep their own names and titles.
export function customRoles(state) {
  const out = [];
  for (const r of Array.isArray(state?.roles) ? state.roles : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ROLE_ID_RE.test(r.id) || AGENT_IDS.includes(r.id)) continue;
    if (out.some((x) => x.id === r.id)) continue;
    out.push({
      id: r.id, name: text(r.name) || r.id, title: text(r.title), kind: ROLE_KINDS.includes(r.kind) ? r.kind : 'gate',
      passKeyword: text(r.passKeyword) || null, failKeyword: text(r.failKeyword) || null,
    });
  }
  return out;
}

// a lookup that never answers from the prototype: 'constructor' is a valid custom agent id
export const own = (map, k) => (typeof k === 'string' && Object.hasOwn(map, k) ? map[k] : undefined);
const customRole = (state, id) => (state?.roles ? customRoles(state).find((r) => r.id === id) ?? null : null);
const knownRole = (state, id) => AGENT_IDS.includes(id) || Boolean(customRole(state, id));

export function isGate(state, id) {
  return GATE_ROLES.includes(id) || customRole(state, id)?.kind === 'gate';
}

// Every gate a run may name: the built-in ones, then its custom gates.
export function gateIds(state) {
  return [...GATE_ROLES, ...customRoles(state).filter((r) => r.kind === 'gate').map((r) => r.id)];
}

export function displayName(id, state = null) {
  return own(NAMES, id) ?? customRole(state, id)?.name ?? String(id ?? '?');
}

export function roleTitle(id, state = null) {
  return own(ROLE_TITLES, id) ?? customRole(state, id)?.title ?? '';
}

// What workflowText calls the custom gates of a run: their names.
export function stepNames(state) {
  return Object.fromEntries(customRoles(state).map((r) => [r.id, r.name]));
}

// Role of a participant or instance id: 'dwight-m2' -> 'dwight'. Known instances answer from their own agent field.
export function roleOf(id, state = null) {
  if (typeof id !== 'string') return null;
  if (Object.hasOwn(NAMES, id)) return id;
  const known = state?.instances?.[id]?.agent;
  if (knownRole(state, known)) return known;
  const m = /^(michael|dwight|oscar|hank|angela)-/.exec(id);
  if (m) return m[1];
  const c = /^([a-z][a-z0-9]{1,19})(?:-|$)/.exec(id);
  return c && customRole(state, c[1]) ? c[1] : null;
}

// run_started.execution.workflow -> { gates } with known gate roles, each at most once; null when not reported
// or unusable, which reads as LEGACY_GATES. known: the gate ids the run has (its custom gates included).
export function normalizeWorkflow(w, known = GATE_ROLES) {
  if (!w || typeof w !== 'object' || !Array.isArray(w.gates)) return null;
  const seen = new Set();
  const gates = [];
  for (const stage of w.gates) {
    if (!Array.isArray(stage)) continue;
    const roles = stage.filter((r) => known.includes(r) && !seen.has(r) && seen.add(r));
    if (roles.length) gates.push(roles);
  }
  return gates.length ? { gates } : null;
}

export function workflowOf(state) {
  return state?.workflow?.gates ?? LEGACY_GATES;
}

// The roles a run uses, in pipeline order; the planner and the developer are in every run.
export function activeRoles(state) {
  return ['michael', 'dwight', ...workflowOf(state).flat()];
}

// names: { id: name } of custom gates (stepNames)
export function workflowText(gates, names = null) {
  return (gates ?? LEGACY_GATES).map((stage) => stage.map((r) => own(GATE_STEP, r) ?? (names ? own(names, r) : undefined) ?? displayName(r)).join(' + ')).join(' → ');
}

export function gateLabel(agent, result) {
  return own(GATE_LABEL, agent)?.[result] ?? own(CUSTOM_GATE_LABEL, result) ?? String(result ?? '');
}

// A gate result while it still speaks for its cycle: none once its milestone opened a newer one.
function currentGate(state, g) {
  if (!g) return null;
  const m = (state?.milestones ?? []).find((x) => x.id === g.milestoneId);
  return m && Number.isInteger(g.cycle) && m.cycles > g.cycle ? null : g;
}

// The gate result a role card shows: that of the lane the card speaks for (roleView's focus), so a later pass on
// another milestone never hides it; the role's latest one when no lane is live (a serial run, a finished run).
export function gateView(state, id, focus = roleView(state, id).focus) {
  const g = currentGate(state, focus ? state?.instances?.[focus]?.gate : state?.gates?.[id]);
  return g ? { ...g, label: gateLabel(id, g.result) } : null;
}

// One lane's own gate result for its cycle.
export function laneGate(state, inst) {
  const g = isGate(state, inst?.agent) ? currentGate(state, inst.gate) : null;
  return g ? { ...g, label: gateLabel(inst.agent, g.result) } : null;
}

const text = (v) => (typeof v === 'string' ? v : '');
const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// run_started.execution and GET /api/control defaults.execution -> one shape; null when not reported.
export function normalizeExecution(x) {
  if (!x || typeof x !== 'object') return null;
  const sb = typeof x.sandbox === 'string' ? { mode: x.sandbox } : x.sandbox && typeof x.sandbox === 'object' ? x.sandbox : {};
  const mode = text(sb.mode) || null;
  return {
    maxParallel: posInt(x.maxParallel),
    isolation: text(x.isolation) || null,
    sandbox: { mode, image: text(sb.image) || null, network: text(sb.network) || null },
    persistentSessions: x.persistentSessions === true,
    simulated: x.simulated === true || x.fake === true,
    trustedHost: x.trustedHost === true || mode === 'host',
  };
}

// Instance worktree as reported: a path, { dir, ref }, or a marker that the instance shares the workspace.
// A directory that is the run workspace itself is the shared workspace, whatever it is called.
export function normalizeWorktree(v, workspace = null) {
  if (v === null || v === undefined || v === false) return null;
  if (v === true) return { mode: 'worktree', dir: '', ref: '' };
  if (typeof v === 'string') {
    if (['shared', 'none', 'off'].includes(v)) return { mode: 'shared', dir: '', ref: '' };
    return { mode: samePath(v, workspace) ? 'shared' : 'worktree', dir: v, ref: '' };
  }
  if (typeof v !== 'object') return null;
  const dir = text(v.dir ?? v.path);
  return { mode: text(v.mode) === 'shared' || samePath(dir, workspace) ? 'shared' : 'worktree', dir, ref: text(v.ref) };
}

// Case and trailing separators do not make a different directory on Windows.
export function samePath(a, b) {
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  return typeof a === 'string' && typeof b === 'string' && a !== '' && b !== '' && norm(a) === norm(b);
}

export function normalizeSandbox(v) {
  if (typeof v === 'string' && v) return { mode: v, image: '', network: '' };
  if (!v || typeof v !== 'object' || !text(v.mode)) return null;
  return { mode: text(v.mode), image: text(v.image), network: text(v.network) };
}

function freshInstance(id, agent, milestoneId, state) {
  return {
    id,
    agent: knownRole(state, agent) ? agent : roleOf(id, state),
    milestoneId: milestoneId ?? null,
    status: 'starting',
    activity: 'Starting',
    tool: null,
    lastTool: null,
    touchedFiles: [],
    lastKeyword: null,
    lastExitCode: null,
    sessionId: null,
    worktree: null,
    sandbox: null,
    startedAt: null,
    updatedAt: null,
    // seq of the last event about this instance; a newer role-only status outranks it on the role card
    seq: 0,
    totals: { runs: 0, input: 0, output: 0, cost: 0, durationMs: 0 },
  };
}

function freshAgent() {
  return {
    status: 'idle',
    activity: 'Idle',
    tool: null,
    lastTool: null,
    touchedFiles: [],
    lastKeyword: null,
    lastExitCode: null,
    updatedAt: null,
    // seq of the last agent_status for the role itself (no instanceId): Michael overseeing or waiting on a human
    roleSeq: 0,
    totals: { runs: 0, input: 0, output: 0, cost: 0, durationMs: 0 },
  };
}

export function freshUsage() {
  return { input: 0, output: 0, cost: 0, tokens: 0, calls: 0, startedAt: null, byAgent: {}, series: [] };
}

export function createState() {
  return {
    runId: null,
    status: 'idle',
    result: null,
    summary: null,
    request: null,
    workspace: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: null,
    lastSeq: 0,
    applied: 0,
    milestones: [],
    currentMilestoneId: null,
    milestoneIndex: -1,
    milestoneTotal: 0,
    cycle: 0,
    cycleOpen: false,
    failedCycles: 0,
    maxFailedCycles: DEFAULT_MAX_FAILED_CYCLES,
    // null: not reported (a run from before the progress check)
    maxStalledCycles: null,
    milestoneTokenBudget: null,
    breaker: 'closed',
    // why the breaker tripped: { cause, milestoneId, ... }; cause null for a run from before the progress check
    trip: null,
    hitl: null,
    lastDecision: null,
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, freshAgent()])),
    mailboxes: Object.fromEntries(PARTICIPANTS.map((id) => [id, null])),
    log: [],
    execution: null,
    workflow: null,
    gates: {},
    activeMilestoneIds: [],
    instances: {},
    chat: [],
    usage: freshUsage(),
    // per instance: the agent_usage deltas folded since its last agent_finished
    usagePending: {},
    // the files the run's agents wrote or edited (writtenFile): how many, each once, and the last WRITTEN_MAX of them
    written: [],
    writtenCount: 0,
  };
}

function isEvent(e) {
  return e !== null && typeof e === 'object' && typeof e.type === 'string'
    && Number.isInteger(e.seq) && typeof e.runId === 'string';
}

// Classifies an event against the current state without applying it.
// 'reset' = it belongs to a different run, 'stale' = seq already applied, 'invalid' = not an event.
export function classify(state, event) {
  if (!isEvent(event)) return 'invalid';
  if (event.runId !== state.runId) return 'reset';
  if (event.seq <= state.lastSeq) return 'stale';
  return 'apply';
}

// Every string of an event is cleaned once on the way in, so no view can show a bidi control.
function scrub(v) {
  if (typeof v === 'string') return stripBidi(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

export function reduce(state, raw) {
  const event = scrub(raw);
  const kind = classify(state, event);
  if (kind === 'invalid' || kind === 'stale') return state;
  const s = structuredClone(kind === 'reset' ? createState() : state);
  s.runId = event.runId;
  s.lastSeq = event.seq;
  if (typeof event.ts === 'string') s.updatedAt = event.ts;
  if (!KNOWN_TYPES.has(event.type)) return s;
  s.applied += 1;
  apply(s, event);
  const line = describe(event, s);
  if (line) {
    s.log.push({
      seq: event.seq,
      ts: event.ts ?? null,
      type: event.type,
      source: sourceOf(event),
      category: CATEGORY[event.type] ?? 'status',
      ...line,
    });
    if (s.log.length > LOG_SIZE) s.log.splice(0, s.log.length - LOG_SIZE);
  }
  return s;
}

export function reduceAll(events, state = createState()) {
  return events.reduce(reduce, state);
}

function sourceOf(e) {
  if (e.type === 'hive_write' || e.type === 'chat_message') return e.from ?? 'orchestrator';
  // the fallback summary is the orchestrator's own
  if (e.type === 'run_reply') return typeof e.from === 'string' && e.from !== 'system' ? e.from : 'orchestrator';
  if (e.type === 'hitl_response') return 'human';
  return (typeof e.instanceId === 'string' && e.instanceId) || (e.agent ?? 'orchestrator');
}

// The instance an event belongs to, created on first sight so lanes survive a missed instance_started.
// agent_tool names its instance even in serial JSON runs, which have no lanes, so it never creates one.
function instanceOf(s, e, { create = true } = {}) {
  const id = typeof e.instanceId === 'string' && e.instanceId ? e.instanceId : null;
  if (!id) return null;
  if (!Object.hasOwn(s.instances, id)) {
    if (!create) return null;
    s.instances[id] = freshInstance(id, e.agent, e.milestoneId, s);
  }
  const inst = s.instances[id];
  if (typeof e.sessionId === 'string' && e.sessionId) inst.sessionId = e.sessionId;
  inst.seq = e.seq;
  return inst;
}

function addActive(s, id) {
  if (!s.activeMilestoneIds.includes(id)) s.activeMilestoneIds.push(id);
}

function boundText(v) {
  const t = text(v);
  return t.length > CHAT_TEXT_MAX ? { text: t.slice(0, CHAT_TEXT_MAX), truncated: true } : { text: t, truncated: false };
}

function milestone(s, id) {
  return s.milestones.find((m) => m.id === id) ?? null;
}

function freshMilestone(id, title) {
  return {
    id: String(id), title: String(title ?? id), description: '', acceptanceCriteria: [], status: 'pending', cycles: 0,
    lastReason: null, lastResult: null, dependsOn: null, blockedBy: [], cycleOpen: false, integrated: false, gates: {},
    // tokens: this milestone's tokens since the last human decision, live from agent_usage like state.json
    progressCheck: null, trip: null, tokens: 0,
  };
}

// progress_check -> what the view keeps of it; null when it names no known verdict
function progressCheckOf(e) {
  if (!VERDICTS.includes(e.verdict)) return null;
  return {
    cycle: posInt(e.cycle), verdict: e.verdict,
    source: CHECK_SOURCES.includes(e.source) ? e.source : null,
    rule: CHECK_RULES.includes(e.rule) ? e.rule : null,
    reason: clip(e.reason, PROGRESS_REASON_MAX),
    changed: typeof e.changed === 'boolean' ? e.changed : null,
    stalledCycles: count(e.stalledCycles), maxStalledCycles: posInt(e.maxStalledCycles),
    // tokenBudget 0: no budget
    tokens: count(e.tokens), tokenBudget: count(e.tokenBudget),
    seq: e.seq, ts: e.ts ?? null,
  };
}

function tripOf(s, e) {
  const m = milestone(s, e.milestoneId);
  return {
    cause: TRIP_CAUSES.includes(e.cause) ? e.cause : null,
    milestoneId: text(e.milestoneId) || null,
    failedCycles: count(e.failedCycles), maxFailedCycles: posInt(e.maxFailedCycles),
    stalledCycles: count(e.stalledCycles), maxStalledCycles: posInt(e.maxStalledCycles),
    tokens: count(e.tokens), tokenBudget: count(e.tokenBudget),
    // the check that stopped it says why
    reason: m?.progressCheck?.reason ?? '',
  };
}

function apply(s, e) {
  switch (e.type) {
    case 'run_started':
      s.status = 'planning';
      s.request = e.request ?? null;
      s.workspace = e.workspace ?? null;
      s.startedAt = e.ts ?? null;
      // absent until a run_reply, like state.json (chat-view-contract 13.11)
      delete s.reply;
      s.execution = normalizeExecution(e.execution);
      // like state.json: every run_started replaces the roles (none listed is none), and the agents are the built-ins,
      // then the custom roles of this run in the order it lists them
      s.roles = Array.isArray(e.roles) ? e.roles : [];
      s.agents = Object.fromEntries([...AGENT_IDS, ...customRoles(s).map((r) => r.id)].map((id) => [id, own(s.agents, id) ?? freshAgent()]));
      s.workflow = normalizeWorkflow(e.execution?.workflow, gateIds(s));
      if (Number.isInteger(e.maxFailedCycles) && e.maxFailedCycles > 0) s.maxFailedCycles = e.maxFailedCycles;
      s.maxStalledCycles = posInt(e.maxStalledCycles);
      s.milestoneTokenBudget = count(e.milestoneTokenBudget);
      break;

    case 'plan_ready':
      s.milestones = (Array.isArray(e.milestones) ? e.milestones : []).map((m) => ({
        ...freshMilestone(m.id, m.title),
        description: String(m.description ?? ''),
        acceptanceCriteria: Array.isArray(m.acceptanceCriteria) ? m.acceptanceCriteria.map(String) : [],
        // null = not reported (a serial run before dependencies existed)
        dependsOn: Array.isArray(m.dependsOn) ? m.dependsOn.map(String) : null,
      }));
      s.milestoneTotal = s.milestones.length;
      break;

    case 'instance_started': {
      const inst = instanceOf(s, { ...e, instanceId: e.instanceId ?? e.id });
      if (!inst) break;
      if (knownRole(s, e.agent)) inst.agent = e.agent;
      if (e.milestoneId !== undefined) inst.milestoneId = e.milestoneId ?? null;
      inst.worktree = normalizeWorktree(e.worktree, s.workspace);
      inst.sandbox = normalizeSandbox(e.sandbox);
      // what state.json says until the first callback (the planner gets no initial agent_status)
      inst.status = 'thinking';
      inst.activity = 'Thinking...';
      inst.tool = null;
      inst.startedAt = e.ts ?? null;
      inst.updatedAt = e.ts ?? null;
      break;
    }

    case 'chat_message': {
      const id = text(e.id) || `seq-${e.seq}`;
      const body = boundText(e.text);
      const entry = {
        id, seq: e.seq, ts: e.ts ?? null, from: text(e.from) || '?', to: text(e.to) || '?', ...body,
        milestoneId: text(e.milestoneId) || null,
        delivery: DELIVERIES.includes(e.delivery) ? e.delivery : 'queued',
        reason: text(e.reason) || null,
      };
      const known = s.chat.find((c) => c.id === id);
      if (known) Object.assign(known, entry, keeps(known, entry.delivery) ? { delivery: known.delivery, reason: known.reason } : {});
      else s.chat.push(entry);
      if (s.chat.length > CHAT_SIZE) s.chat.splice(0, s.chat.length - CHAT_SIZE);
      break;
    }

    case 'chat_delivery': {
      const c = s.chat.find((x) => x.id === e.id);
      // delivered and rejected are final; a late queued echo must not undo them or an unknown outcome
      if (!c || !DELIVERIES.includes(e.delivery) || keeps(c, e.delivery)) break;
      c.delivery = e.delivery;
      c.reason = text(e.reason) || null;
      c.settledAt = e.ts ?? null;
      break;
    }

    case 'milestone_started': {
      let m = milestone(s, e.milestoneId);
      if (!m) {
        m = freshMilestone(e.milestoneId, e.title);
        s.milestones.push(m);
      }
      m.status = 'active';
      m.cycles = Math.max(m.cycles, 1);
      m.cycleOpen = true;
      if (e.title) m.title = e.title;
      addActive(s, m.id);
      s.milestoneTotal = Number.isInteger(e.total) ? e.total : s.milestones.length;
      if (s.status === 'planning' || s.status === 'idle') s.status = 'running';
      // like the orchestrator: the oldest active pipeline is the scalar current one
      const prev = s.currentMilestoneId;
      s.currentMilestoneId = s.activeMilestoneIds[0] ?? m.id;
      closeBreaker(s);
      if (s.currentMilestoneId !== m.id && s.currentMilestoneId === prev) break;
      s.milestoneIndex = Number.isInteger(e.index) ? e.index : s.milestones.indexOf(m);
      s.cycle = 1;
      s.cycleOpen = true;
      break;
    }

    case 'milestone_integrated': {
      const m = milestone(s, e.milestoneId);
      if (m) m.integrated = true;
      break;
    }

    case 'hive_write': {
      // instance mailboxes (dwight-m2/inbox.md) are shown under their role
      const box = PARTICIPANTS.includes(e.to) ? e.to : roleOf(e.to, s);
      if (box) {
        s.mailboxes[box] = {
          from: e.from, to: e.to, kind: e.kind, summary: e.summary ?? '', file: e.file ?? '', seq: e.seq, ts: e.ts ?? null, read: false,
          // hive_write.instanceId names the recipient instance whose inbox was written
          instance: text(e.instanceId) || (box !== e.to ? text(e.to) : '') || null,
        };
      }
      break;
    }

    case 'agent_status': {
      const inst = instanceOf(s, e);
      if (inst) {
        inst.status = e.status;
        inst.activity = e.activity ?? '';
        inst.updatedAt = e.ts ?? null;
        if (e.status !== 'working') inst.tool = null;
      }
      const a = agentOf(s, e.agent);
      if (!a) break;
      a.status = e.status;
      a.activity = e.activity ?? '';
      a.updatedAt = e.ts ?? null;
      if (!inst) a.roleSeq = e.seq;
      if (e.status !== 'working') a.tool = null;
      // same aggregate as state.json: a role stays busy while any of its instances is
      const busyLane = inst ? Object.values(s.instances).find((i) => i.agent === e.agent && BUSY.has(i.status)) : null;
      if (busyLane) {
        a.status = busyLane.status;
        a.activity = busyLane.activity || 'Thinking...';
      }
      if (e.agent !== 'dwight' || (e.status !== 'thinking' && e.status !== 'working')) break;
      // Dwight picking up work after a failed cycle opens the next one.
      const lane = inst?.milestoneId ?? s.currentMilestoneId;
      if (lane === s.currentMilestoneId) {
        if (!s.cycleOpen && s.currentMilestoneId) {
          s.cycle += 1;
          s.cycleOpen = true;
          const m = milestone(s, s.currentMilestoneId);
          if (m) {
            m.cycles = Math.max(m.cycles, s.cycle);
            m.cycleOpen = true;
          }
        }
      } else {
        // a parallel lane that is not the scalar current milestone counts its own cycles
        const m = milestone(s, lane);
        if (m && m.status === 'active' && !m.cycleOpen) {
          m.cycles += 1;
          m.cycleOpen = true;
        }
      }
      break;
    }

    case 'agent_tool': {
      const call = toolCall(e);
      const inst = instanceOf(s, e, { create: false });
      for (const x of [inst, agentOf(s, e.agent)]) {
        if (!x) continue;
        x.tool = { ...call, startedAt: e.ts ?? null };
        x.lastTool = { ...call, ts: e.ts ?? null };
        x.updatedAt = e.ts ?? null;
        touch(x, call, e.ts ?? null);
      }
      const file = writtenFile(e);
      if (file) noteWritten(s, file);
      break;
    }

    case 'agent_usage': {
      const d = usageDelta(e.usage);
      const key = pendingKey(e);
      const p = own(s.usagePending, key) ?? { input: 0, output: 0, cost: 0 };
      s.usagePending[key] = { input: p.input + d.input, output: p.output + d.output, cost: p.cost + d.cost };
      addUsage(s.usage, e.agent, d, e.ts);
      // a stream from before milestoneId on agent_usage counts no milestone tokens
      const m = milestone(s, e.milestoneId);
      if (m) {
        m.tokens += d.input + d.output;
        if (m.progressCheck) m.progressCheck = { ...m.progressCheck, tokens: m.tokens };
      }
      const a = agentOf(s, e.agent);
      if (a) for (const key of ['input', 'output', 'cost']) a.totals[key] += d[key];
      break;
    }

    case 'agent_finished': {
      // Legacy JSON finishes omit instanceId; explicit ids only settle an existing lane.
      const inst = instanceOf(s, e, { create: false });
      if (inst) finishInto(inst, e);
      const delta = settleUsage(s, e);
      const a = agentOf(s, e.agent);
      if (!a) break;
      a.lastKeyword = e.keyword ?? null;
      a.lastExitCode = Number.isInteger(e.exitCode) ? e.exitCode : null;
      a.tool = null;
      a.updatedAt = e.ts ?? null;
      a.totals.runs += 1;
      a.totals.durationMs += Number(e.durationMs) || 0;
      if (e.usage) {
        for (const key of ['input', 'output', 'cost']) a.totals[key] += delta[key];
      }
      if (a.status === 'thinking' || a.status === 'working') {
        a.status = 'idle';
        a.activity = e.keyword ? `Finished: ${e.keyword}` : 'Idle';
      }
      if (s.mailboxes[e.agent]) s.mailboxes[e.agent].read = true;
      if (Number.isInteger(e.cycle) && e.milestoneId === s.currentMilestoneId && e.cycle > s.cycle) {
        s.cycle = e.cycle;
        const m = milestone(s, s.currentMilestoneId);
        if (m) m.cycles = Math.max(m.cycles, e.cycle);
      }
      break;
    }

    case 'cycle_result': {
      const m = milestone(s, e.milestoneId);
      if (m) {
        if (Number.isInteger(e.cycle)) m.cycles = Math.max(m.cycles, e.cycle);
        m.lastReason = e.reason ?? null;
        m.lastResult = e.result ?? null;
        m.cycleOpen = false;
      }
      if (e.milestoneId === s.currentMilestoneId || !s.currentMilestoneId) {
        if (Number.isInteger(e.cycle)) s.cycle = e.cycle;
        s.cycleOpen = false;
        s.failedCycles = Number.isInteger(e.failedCycles) ? e.failedCycles : (e.result === 'failed' ? s.failedCycles + 1 : 0);
      }
      break;
    }

    case 'gate_result': {
      if (!isGate(s, e.agent)) break;
      const g = {
        milestoneId: text(e.milestoneId) || null,
        cycle: Number.isInteger(e.cycle) ? e.cycle : null,
        stage: Number.isInteger(e.stage) ? e.stage : null,
        result: GATE_RESULTS.includes(e.result) ? e.result : 'error',
        keyword: text(e.keyword) || null,
        instanceId: text(e.instanceId) || null,
        seq: e.seq,
        ts: e.ts ?? null,
      };
      s.gates[e.agent] = g;
      const m = milestone(s, g.milestoneId);
      if (m) m.gates = { ...m.gates, [e.agent]: g };
      // a serial run names an instance without having lanes
      const inst = instanceOf(s, e, { create: false });
      if (inst) inst.gate = g;
      break;
    }

    case 'progress_check': {
      const m = milestone(s, e.milestoneId);
      const c = progressCheckOf(e);
      if (!m || !c) break;
      m.progressCheck = c;
      if (c.tokens !== null) m.tokens = c.tokens;
      if (c.maxStalledCycles) s.maxStalledCycles = c.maxStalledCycles;
      if (c.tokenBudget !== null) s.milestoneTokenBudget = c.tokenBudget;
      break;
    }

    case 'circuit_breaker': {
      const m = milestone(s, e.milestoneId);
      if (m && e.state !== 'reset' && count(e.tokens) !== null) m.tokens = e.tokens;
      if (Number.isInteger(e.maxFailedCycles) && e.maxFailedCycles > 0) s.maxFailedCycles = e.maxFailedCycles;
      if (Number.isInteger(e.failedCycles)) s.failedCycles = e.failedCycles;
      if (e.state === 'tripped') {
        s.breaker = 'tripped';
        s.status = 'paused';
        s.trip = tripOf(s, e);
        if (m) m.trip = s.trip;
      } else if (e.state === 'reset') {
        s.breaker = 'closed';
        s.trip = null;
        for (const x of s.milestones) if (!e.milestoneId || x.id === e.milestoneId) x.trip = null;
        // like src/core/state.js: the reset drops the check, and its tokens count only next to stalledCycles
        if (m) {
          m.progressCheck = null;
          if (e.stalledCycles !== undefined) m.tokens = count(e.tokens) ?? 0;
        }
        if (s.status === 'paused' && !s.hitl) s.status = 'running';
      }
      break;
    }

    case 'hitl_request':
      s.hitl = { milestoneId: e.milestoneId ?? null, reason: e.reason ?? '', options: Array.isArray(e.options) ? e.options : [] };
      s.status = 'paused';
      break;

    // Any answer ends the wait; the breaker closes on reset or once the milestone is over, because
    // skip and [BLOCKED]/infra pauses do not always come with a reset.
    case 'hitl_response': {
      // feedback or retry starts the milestone's count again: the last check is dropped and the token window is 0
      const m = milestone(s, e.milestoneId ?? s.hitl?.milestoneId);
      if (m && (e.decision === 'feedback' || e.decision === 'retry')) {
        m.progressCheck = null;
        m.tokens = 0;
      }
      if (m) m.trip = null;
      s.hitl = null;
      if (s.mailboxes.human) s.mailboxes.human.read = true;
      s.lastDecision = { decision: e.decision, feedback: e.feedback ?? null };
      if (s.status === 'paused') s.status = 'running';
      break;
    }

    case 'milestone_finished': {
      const m = milestone(s, e.milestoneId);
      if (m) {
        m.status = e.status;
        m.cycleOpen = false;
        m.trip = null;
        const by = Array.isArray(e.blockedBy) ? e.blockedBy : Array.isArray(e.dependsOn) ? e.dependsOn : null;
        if (by) m.blockedBy = by.map(String);
        if (e.reason) m.lastReason = e.reason;
      }
      s.activeMilestoneIds = s.activeMilestoneIds.filter((id) => id !== e.milestoneId);
      // the milestone is over for every lane, a failed one too; its error text stays as the lane's activity
      for (const i of Object.values(s.instances)) {
        if (i.milestoneId === e.milestoneId) {
          i.status = 'done';
          i.tool = null;
        }
      }
      if (e.milestoneId === s.currentMilestoneId || !s.currentMilestoneId) {
        s.cycleOpen = false;
        closeBreaker(s);
        // the next oldest pipeline becomes current, with its own cycle count
        const next = milestone(s, s.activeMilestoneIds[0]);
        s.currentMilestoneId = next?.id ?? null;
        if (next) {
          s.milestoneIndex = s.milestones.indexOf(next);
          s.cycle = next.cycles;
          s.cycleOpen = next.cycleOpen;
        }
      }
      break;
    }

    case 'run_reply':
      s.reply = { from: e.from, kind: e.kind, text: e.text, ...(e.truncated ? { truncated: true } : {}) };
      break;

    case 'run_finished':
      s.status = RUN_STATUS_BY_RESULT[e.status] ?? 'finished';
      s.result = e.status ?? null;
      s.summary = e.summary ?? null;
      s.finishedAt = e.ts ?? null;
      s.hitl = null;
      s.cycleOpen = false;
      closeBreaker(s);
      // A finished run has nobody working or waiting any more; real errors stay on their cards.
      for (const a of Object.values(s.agents)) {
        if (a.status !== 'done' && a.status !== 'error' && a.status !== 'idle') {
          a.status = 'idle';
          a.tool = null;
        }
      }
      for (const i of Object.values(s.instances)) {
        if (i.status === 'error') continue;
        i.status = 'done';
        i.tool = null;
      }
      s.activeMilestoneIds = [];
      s.currentMilestoneId = null;
      break;

    default:
      break;
  }
  // the engine may publish its own list of active pipelines; it wins over the derived one
  if (Array.isArray(e.activeMilestoneIds)) s.activeMilestoneIds = e.activeMilestoneIds.filter((x) => typeof x === 'string');
}

// agent_tool as an instance keeps it. A journal from before targetFile and command says both in detail.
function toolCall(e) {
  const tool = e.tool ?? '';
  const detail = e.detail ?? '';
  return {
    tool, detail,
    targetFile: text(e.targetFile) || (Object.hasOwn(FILE_TOOLS, tool) ? text(detail) : '') || null,
    command: text(e.command) || (SHELL_TOOLS.has(tool) ? text(detail) : '') || null,
  };
}

// The file an agent_tool event wrote or edited, '' for any other event. What "N files written" counts, in the run
// rail and under the reply in the Chat view alike.
export function writtenFile(e) {
  if (e?.type !== 'agent_tool' || (e.tool !== 'write' && e.tool !== 'edit')) return '';
  return toolCall(e).targetFile ?? '';
}

// How many files the run's agents wrote, as "N files written" says it.
export const countWritten = (s) => (Number.isInteger(s?.writtenCount) ? s.writtenCount : Array.isArray(s?.written) ? s.written.length : 0);

function noteWritten(s, file) {
  const count = countWritten(s);
  const list = (s.written ??= []);
  const at = list.lastIndexOf(file);
  if (at >= 0) list.splice(at, 1);
  s.writtenCount = at >= 0 ? count : count + 1;
  list.push(file);
  if (list.length > WRITTEN_MAX) list.splice(0, list.length - WRITTEN_MAX);
}

// newest first, each path once
function touch(x, call, ts) {
  const kind = own(FILE_TOOLS, call.tool);
  if (!kind || !call.targetFile) return;
  x.touchedFiles = [{ path: call.targetFile, kind, ts }, ...(x.touchedFiles ?? []).filter((f) => f.path !== call.targetFile)].slice(0, TOUCHED_MAX);
}

const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// Even an all-zero report is a call, like the server's foldUsage.
function usageDelta(u) {
  return { input: amount(u?.input), output: amount(u?.output), cost: amount(u?.cost) };
}

const pendingKey = (e) => text(e.instanceId) || text(e.agent) || '?';

// One delta { input, output, cost } into a usage object (changed in place): the totals, the agent's share and one
// more cumulative point.
export function addUsage(u, agent, d, ts, calls = 1) {
  const id = typeof agent === 'string' && agent ? agent : '?';
  if (!Object.hasOwn(u.byAgent, id)) u.byAgent[id] = { input: 0, output: 0, cost: 0, tokens: 0, calls: 0 };
  for (const x of [u, u.byAgent[id]]) {
    x.input += d.input;
    x.output += d.output;
    x.cost += d.cost;
    x.tokens = x.input + x.output;
    x.calls += calls;
  }
  if (!u.startedAt) u.startedAt = ts ?? null;
  u.series.push({
    ts: ts ?? null, tokens: u.tokens, cost: u.cost,
    byAgent: Object.fromEntries(Object.entries(u.byAgent).map(([k, a]) => [k, { tokens: a.tokens, cost: a.cost }])),
  });
  // the series halves instead of growing: every odd point goes, the newest stays
  if (u.series.length > USAGE_POINTS_MAX) u.series = u.series.filter((_, i, all) => i % 2 === 0 || i === all.length - 1);
}

// Reconciliation adds a point, not another call. Old journals without per-call usage still count a launch.
function settleUsage(s, e) {
  const scoped = e.milestoneId ? `${e.agent}-${e.milestoneId}` : e.agent;
  const key = e.instanceId ?? (own(s.usagePending, scoped) ? scoped : e.agent);
  const pending = own(s.usagePending, key);
  const u = usageDelta(e.usage);
  const rest = Object.fromEntries(['input', 'output', 'cost'].map((k) => [k, Math.max(0, u[k] - (pending?.[k] ?? 0))]));
  if (rest.input || rest.output || rest.cost) addUsage(s.usage, e.agent, rest, e.ts, pending ? 0 : 1);
  delete s.usagePending[key];
  return rest;
}

// an own role key only: an event naming 'constructor' must not reach the prototype
function agentOf(s, id) {
  return typeof id === 'string' && Object.hasOwn(s.agents, id) ? s.agents[id] : null;
}

function settled(c) {
  return c.delivery === 'delivered' || c.delivery === 'rejected';
}

// Whether a message keeps its delivery state when `next` is reported for it.
function keeps(c, next) {
  return settled(c) || (c.delivery === 'unknown' && next === 'queued');
}

function finishInto(a, e) {
  a.lastKeyword = e.keyword ?? null;
  a.lastExitCode = Number.isInteger(e.exitCode) ? e.exitCode : null;
  a.tool = null;
  a.updatedAt = e.ts ?? null;
  a.totals.runs += 1;
  a.totals.durationMs += Number(e.durationMs) || 0;
  if (e.usage) {
    a.totals.input += Number(e.usage.input) || 0;
    a.totals.output += Number(e.usage.output) || 0;
    a.totals.cost += Number(e.usage.cost) || 0;
  }
  if (a.status === 'thinking' || a.status === 'working' || a.status === 'starting') {
    a.status = 'idle';
    a.activity = e.keyword ? `Finished: ${e.keyword}` : 'Idle';
  }
}

// ------------------------------------------------------------ derived views of parallel runs

const BUSY = new Set(['thinking', 'working']);
// Which instance a role card speaks for: the loudest live one.
const PRIORITY = { error: 7, blocked: 6, working: 5, thinking: 4, starting: 3, waiting: 2, idle: 1, done: 0 };
const GATE_FAILS = new Set(['failed', 'blocked', 'error']);
const AGENT_ORDER = { michael: 0, dwight: 1, oscar: 2, hank: 3, angela: 4 };

export function isLive(inst) {
  return Boolean(inst) && !TERMINAL_STATUSES.has(inst.status);
}

export function isBusy(inst) {
  return Boolean(inst) && BUSY.has(inst.status);
}

// The reducer keeps a lane that is over 'done' and a role between turns 'idle', whatever came of it (as state.json
// does). What a card says instead once it is over: 'failed' when its last turn or its milestone failed, 'stopped'
// when the run was aborted under it, 'unused' for a role the run never called. Anything still going keeps its word.
// x: an instance, or (role: true) a role aggregate or roleView.
export function settledStatus(state, x, { role = false } = {}) {
  const status = x?.status ?? 'idle';
  if (status !== 'done' && !(role && state?.result && status === 'idle')) return status;
  const runs = x.totals?.runs ?? 0;
  if (role && !runs && !x.lanes) return 'unused';
  const ended = role ? null : (state?.milestones ?? []).find((m) => m.id === x.milestoneId)?.status;
  const bad = (Number.isInteger(x.lastExitCode) && x.lastExitCode !== 0) || /^Failed/.test(x.activity ?? '') || ended === 'failed' || ended === 'aborted';
  if (bad || (!runs && state?.result === 'aborted')) return state?.result === 'aborted' || ended === 'aborted' ? 'stopped' : 'failed';
  return 'done';
}

// Instances in reading order: planner, then by milestone plan order, developer before QA.
export function lanesOf(state) {
  const order = new Map((state?.milestones ?? []).map((m, i) => [m.id, i]));
  const rank = (i) => (i.milestoneId === null || i.milestoneId === 'plan' ? -1 : order.get(i.milestoneId) ?? 1e6);
  // custom gates after the built-ins, in the order the run lists them
  const extra = customRoles(state).map((r) => r.id);
  const role = (a) => own(AGENT_ORDER, a) ?? (extra.includes(a) ? 5 + extra.indexOf(a) : 99);
  return Object.values(state?.instances ?? {}).sort((a, b) => rank(a) - rank(b)
    || role(a.agent) - role(b.agent) || a.id.localeCompare(b.id));
}

// The role card of a parallel run: status of the loudest live lane, never the last event's lane alone.
// A role-only status newer than every live lane (Michael overseeing, or blocked on a human after his lane
// ended idle or in error) is the role's current word and wins.
// -> the role aggregate plus { lanes, live, busy, focus } (focus = instance id the card speaks for)
export function roleView(state, id) {
  const a = state?.agents?.[id] ?? freshAgent();
  const mine = lanesOf(state).filter((i) => i.agent === id);
  if (!mine.length) return { ...a, lanes: 0, live: 0, busy: 0, focus: null };
  const live = mine.filter(isLive);
  const busy = live.filter(isBusy);
  const roleSaid = (a.roleSeq ?? 0) > 0 && live.every((i) => (i.seq ?? 0) < a.roleSeq);
  // between lanes in the same state, one whose gate sent the work back is the louder
  const loud = (i) => (PRIORITY[i.status] ?? 1) * 2 + (GATE_FAILS.has(currentGate(state, i.gate)?.result) ? 1 : 0);
  const top = roleSaid ? null : [...live].sort((x, y) => loud(y) - loud(x))[0] ?? null;
  const view = { ...a, lanes: mine.length, live: live.length, busy: busy.length, focus: top?.id ?? null };
  if (!top) return view;
  view.status = top.status;
  view.tool = top.tool;
  view.activity = busy.length > 1
    ? `${busy.length} lanes: ${busy.map((i) => `${i.id} ${i.status}`).join(', ')}`
    : `${top.id}: ${top.activity || top.status}`;
  return view;
}

// Agent states that mean something is still going on; a run whose process exited has none of them left.
const ONGOING = new Set(['thinking', 'working', 'waiting', 'blocked', 'starting']);

// The view of a run whose process exited without a run_finished. Nothing runs or waits any more, but no
// result, event or completion is invented: the result stays null and the reducer state is not touched.
// exit = { at: ISO time of the exit, exitCode }
export function interruptedView(state, exit = {}) {
  if (!state?.runId || state.result) return state;
  const s = structuredClone(state);
  s.status = 'exited';
  s.exit = { at: exit.at ?? null, exitCode: Number.isInteger(exit.exitCode) ? exit.exitCode : null };
  // the clock stops when the process did
  if (exit.at) s.finishedAt = exit.at;
  s.cycleOpen = false;
  for (const m of s.milestones) {
    if (m.status !== 'active') continue;
    m.status = 'interrupted';
    m.cycleOpen = false;
  }
  for (const a of Object.values(s.agents)) {
    if (!ONGOING.has(a.status)) continue;
    a.status = 'interrupted';
    a.activity = 'Run process exited';
    a.tool = null;
  }
  for (const i of Object.values(s.instances)) {
    if (!isLive(i) || i.status === 'error') continue;
    i.status = 'interrupted';
    i.activity = 'Run process exited';
    i.tool = null;
  }
  s.activeMilestoneIds = [];
  s.currentMilestoneId = null;
  return s;
}

// How a milestone stands with its prerequisites.
// -> { kind: 'none' | 'waiting' | 'queued' | 'blocked' | 'met', on: [milestone ids] }
export function dependencyState(state, m) {
  const status = (id) => (state?.milestones ?? []).find((x) => x.id === id)?.status ?? 'pending';
  const deps = Array.isArray(m?.dependsOn) ? m.dependsOn : [];
  if (m?.status === 'blocked') {
    const on = m.blockedBy?.length ? m.blockedBy : deps.filter((d) => UNMET.has(status(d)));
    return { kind: 'blocked', on };
  }
  if (!deps.length) return { kind: 'none', on: [] };
  if (m.status !== 'pending') return { kind: 'met', on: deps };
  const failed = deps.filter((d) => UNMET.has(status(d)));
  if (failed.length) return { kind: 'blocked', on: failed };
  const open = deps.filter((d) => status(d) !== 'passed');
  // all prerequisites passed and integrated: it waits for a free parallel slot
  return open.length ? { kind: 'waiting', on: open } : { kind: 'queued', on: [] };
}

function closeBreaker(s) {
  s.breaker = 'closed';
  s.failedCycles = 0;
  s.trip = null;
}

// "no progress 1 of 2"; '' when the check did not report it
export function stalledText(c) {
  return Number.isInteger(c?.stalledCycles) && c.maxStalledCycles ? `no progress ${c.stalledCycles} of ${c.maxStalledCycles}` : '';
}

// "120.0k of 500.0k tokens", or "120.0k tokens" without a budget
export function budgetText(c) {
  if (!Number.isInteger(c?.tokens)) return '';
  return c.tokenBudget ? `${formatTokens(c.tokens)} of ${formatTokens(c.tokenBudget)} tokens` : `${formatTokens(c.tokens)} tokens`;
}

// A milestone's last progress check in words; null for a milestone without one (or a run from before the check).
// -> { cycle, verdict, word, how, reason, meter }
export function checkView(m) {
  const c = m?.progressCheck;
  if (!c) return null;
  const how = c.source === 'rule' ? CHECK_HOW[c.rule] ?? 'rule' : c.source === 'michael' ? 'judged by Michael' : '';
  return {
    cycle: c.cycle, verdict: c.verdict, word: VERDICT_WORD[c.verdict], how, reason: c.reason,
    meter: [stalledText(c), budgetText(c)].filter(Boolean).join(' · '),
  };
}

// The contract's title for a tripped breaker: why it asks the human. null when the breaker is closed, when the run
// is from before the progress check, or when milestoneId names another milestone than the one that tripped.
export function breakerTitle(state, milestoneId = null) {
  const t = state?.trip;
  if (state?.breaker !== 'tripped' || !t?.cause) return null;
  if (milestoneId && t.milestoneId && t.milestoneId !== milestoneId) return null;
  const m = t.milestoneId || milestoneId || 'The milestone';
  if (t.cause === 'stalled') return t.reason ? `No progress on ${m}: ${t.reason}` : `No progress on ${m}`;
  if (t.cause === 'budget') return `${m} used ${formatTokens(t.tokens ?? 0)} tokens without passing`;
  return `${m} reached the cycle limit (${t.maxFailedCycles ?? state.maxFailedCycles})`;
}

// True only while the orchestrator actually waits for an answer in its terminal.
export function humanNeeded(state) {
  return Boolean(state?.hitl) || state?.status === 'paused';
}

// Sums over all agents: { runs, input, output, tokens, cost, durationMs }
export function totals(state) {
  const t = { runs: 0, input: 0, output: 0, tokens: 0, cost: 0, durationMs: 0 };
  for (const id of [...AGENT_IDS, ...customRoles(state).map((r) => r.id)]) {
    const a = state.agents[id]?.totals;
    if (!a) continue;
    t.runs += a.runs;
    t.input += a.input;
    t.output += a.output;
    t.cost += a.cost;
    t.durationMs += a.durationMs;
  }
  t.tokens = t.input + t.output;
  return t;
}

function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

// The first line of a message that says something, for a one-line log row.
function firstLine(text, max) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim());
  const head = clip(lines[0] ?? '', max);
  return lines.length > 1 && !head.endsWith('...') ? `${head} ...` : head;
}

// Keywords that end a role's turn without passing it on.
export const FAIL_KEYWORDS = new Set(['BLOCKED', 'TEST_FAILED', 'CHANGES_REQUESTED', 'SECURITY_ISSUES']);

// A built-in fail keyword, or the fail keyword of the custom gate that said it.
export function isFailKeyword(state, agent, keyword) {
  return FAIL_KEYWORDS.has(keyword) || (Boolean(keyword) && customRole(state, agent)?.failKeyword === keyword);
}

// Readable one-line form of an event for the log. tone: info | good | bad | warn | muted
export function describe(e, state = null) {
  switch (e.type) {
    case 'run_started':
      return { tone: 'info', text: `Run started: ${clip(e.request, 160)}` };
    case 'plan_ready':
      return { tone: 'good', text: `Plan ready with ${Array.isArray(e.milestones) ? e.milestones.length : 0} milestones` };
    case 'milestone_started':
      return { tone: 'info', text: `Milestone ${(e.index ?? 0) + 1}/${e.total ?? '?'} started: ${clip(e.title, 120)}` };
    case 'hive_write':
      return { tone: e.kind === 'bug_report' ? 'bad' : e.kind === 'hitl' || e.kind === 'feedback' ? 'warn' : 'info',
        text: `${displayName(e.from)} -> ${displayName(e.to)} ${String(e.kind ?? 'note').replace('_', ' ')}: ${clip(e.summary, 140)}` };
    case 'agent_status':
      if (e.status === 'idle') return null;
      if (e.status === 'error' || e.status === 'blocked') return { tone: 'bad', text: `${e.status}: ${clip(e.activity, FAILURE_TEXT_MAX)}` };
      return { tone: 'muted', text: `${e.status}: ${clip(e.activity, 120)}` };
    case 'agent_tool':
      return { tone: 'muted', text: `${e.tool} ${clip(e.detail, 140)}` };
    case 'agent_finished': {
      const ok = e.exitCode === 0 && !isFailKeyword(state, e.agent, e.keyword);
      return { tone: ok ? 'good' : 'bad',
        text: `${e.keyword ?? 'no keyword'} - exit ${e.exitCode}, ${formatDuration(Number(e.durationMs) || 0)}` };
    }
    case 'cycle_result':
      return { tone: e.result === 'passed' ? 'good' : 'bad',
        text: `${e.milestoneId} cycle ${e.cycle} ${e.result} (${e.failedCycles} consecutive failed): ${clip(e.reason, 120)}` };
    case 'circuit_breaker': {
      if (e.state !== 'tripped') return { tone: 'good', text: 'Circuit breaker reset' };
      const title = state && TRIP_CAUSES.includes(e.cause) ? breakerTitle(state, e.milestoneId) : null;
      return { tone: 'bad', text: title ? `Circuit breaker tripped: ${clip(title, 200)}` : `Circuit breaker tripped after ${e.failedCycles}/${e.maxFailedCycles} failed cycles` };
    }
    case 'progress_check': {
      const v = checkView({ progressCheck: progressCheckOf(e) });
      if (!v) return null;
      const head = `${e.milestoneId} cycle ${e.cycle} ${v.word.toLowerCase()}${v.how ? ` (${v.how})` : ''}`;
      return { tone: v.verdict === 'progress' ? 'info' : 'warn', text: [`${head}${v.reason ? `: ${v.reason}` : ''}`, v.meter].filter(Boolean).join(' · ') };
    }
    case 'hitl_request':
      return { tone: 'bad', text: `Human input requested: ${clip(e.reason, 140)}` };
    case 'hitl_response':
      return { tone: 'warn', text: `Decision: ${e.decision}${e.feedback ? ` - ${clip(e.feedback, 120)}` : ''}` };
    case 'milestone_finished':
      return { tone: e.status === 'passed' ? 'good' : 'bad', text: `${e.milestoneId} ${e.status}${e.reason ? `: ${clip(e.reason, 140)}` : ''}` };
    case 'milestone_integrated':
      return { tone: 'good', text: `${e.milestoneId} integrated into the workspace` };
    case 'gate_result': {
      const where = [e.milestoneId, Number.isInteger(e.cycle) && `cycle ${e.cycle}`, Number.isInteger(e.stage) && `stage ${e.stage + 1}`].filter(Boolean).join(' · ');
      return { tone: e.result === 'passed' ? 'good' : 'bad',
        text: `${displayName(e.agent, state)} gate ${e.result}: ${e.keyword || 'no keyword'}${where ? ` · ${where}` : ''}` };
    }
    case 'run_finished':
      return { tone: e.status === 'success' ? 'good' : 'bad', text: `Run ${e.status}: ${clip(e.summary, 140)}` };
    // the Chat view shows these in full; the log keeps one line of each
    case 'agent_message':
      return { tone: e.final ? 'info' : 'muted', text: firstLine(e.text, 140) };
    case 'run_reply':
      return { tone: 'info', text: `Reply (${e.kind}): ${firstLine(e.text, 140)}` };
    case 'instance_started': {
      const wt = normalizeWorktree(e.worktree, state?.workspace);
      const sb = normalizeSandbox(e.sandbox);
      const bits = [wt?.mode === 'worktree' ? 'worktree' : wt ? 'shared workspace' : null, sb ? `sandbox ${sb.mode}` : null].filter(Boolean);
      return { tone: 'info', text: `${e.instanceId} started${e.milestoneId ? ` for ${e.milestoneId}` : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}` };
    }
    case 'chat_message':
      return { tone: e.delivery === 'rejected' ? 'bad' : 'info',
        text: `${e.from} -> ${e.to} message${e.delivery === 'rejected' ? ' rejected' : ''}: ${clip(e.text, 140)}` };
    case 'chat_delivery':
      if (e.delivery === 'unknown') {
        return { tone: 'warn', text: `Message ${clip(e.id, 12)} delivery unknown - not resent automatically${e.reason ? `: ${clip(e.reason, 120)}` : ''}` };
      }
      return { tone: e.delivery === 'rejected' ? 'bad' : e.delivery === 'delivered' ? 'good' : 'muted',
        text: `Message ${clip(e.id, 12)} ${e.delivery}${e.reason ? `: ${clip(e.reason, 120)}` : ''}` };
    // a refused spool command carries no id or payload, so it never joins the transcript
    case 'chat_command_rejected':
      return { tone: 'bad', text: `Chat command rejected${e.reason ? `: ${clip(e.reason, 120)}` : ''}` };
    case 'log':
      return { tone: e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'muted',
        text: clip(e.message, e.level === 'error' ? FAILURE_TEXT_MAX : 180) };
    default:
      return null;
  }
}

// Parses JSON Lines text, skipping lines that are not valid JSON objects.
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // partial or garbage line
    }
  }
  return out;
}
