// The live panels' view of a run (.enma/live-activity-contract.md): who is doing what now, the board and the usage,
// in one shape for both engines: { agents, board, usage }. The Team side reads the reducer state and the /live
// poll, the Pipeline side the run document its view polls. Pure: no DOM, no fetch.
import {
  AGENT_IDS, lanesOf, isLive, isBusy, laneGate, gateView, displayName, roleTitle, own, activeRoles, workflowOf, isGate,
  dependencyState, humanNeeded, customRoles, freshUsage, addUsage, USAGE_POINTS_MAX, TOUCHED_MAX,
} from './state.js';
import { stripBidi } from './format.js';
import { ROLE_LABEL, TERMINAL, lastWorkNode, stepper } from './pipeline-model.js';

// a /live answer older than this is no longer what the model is producing now
export const LIVE_STALE_MS = 5000;
export const TAIL_MAX = 2000;
export const RAIL_KEY = 'scranton.run_rail';
// the rail stands beside the transcript from this window width on; below it, it opens over the page
export const RAIL_WIDE = '(min-width: 1200px)';
export const BOARD_COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'in_review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
];
export const NO_REASONING = 'This model shows no reasoning; its answer is shown instead.';

const LANE_ROLE = { michael: 'Planner', dwight: 'Developer', oscar: 'Reviewer', hank: 'Security', angela: 'QA' };
const ACTIVE = new Set(['starting', 'thinking', 'working']);
const PHASES = ['thinking', 'text', 'tool', 'idle'];
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const str = (v) => (typeof v === 'string' ? v : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const stamp = (ts) => {
  const t = Date.parse(ts ?? '');
  return Number.isFinite(t) ? t : null;
};

// What a lane is called by its role: a custom gate by the title the run gave it.
export function laneRole(agent, state = null) {
  return own(LANE_ROLE, agent) ?? (roleTitle(agent, state) || displayName(agent, state));
}

// ------------------------------------------------------------ live text

// The END of an untrusted text: no bidi or control characters, at most max characters. -> { body, cut } | null
function tailOf(v, cut = false, max = TAIL_MAX) {
  if (typeof v !== 'string') return null;
  const t = stripBidi(v).replace(/\r\n?/g, '\n').replace(CONTROLS, '');
  if (!t.trim()) return null;
  return t.length > max ? { body: t.slice(t.length - max), cut: true } : { body: t, cut: cut === true };
}

// GET .../live (contract section 3) -> { runId, updatedAt, instances: { id: { agent, phase, thinking, text } } }, or
// null for anything else. thinking / text: { body, cut } | null.
export function parseLive(doc) {
  const d = obj(doc);
  if (!d || !obj(d.instances)) return null;
  const instances = {};
  for (const [id, raw] of Object.entries(d.instances)) {
    const i = obj(raw);
    if (!i) continue;
    instances[id] = {
      agent: str(i.agent), phase: PHASES.includes(i.phase) ? i.phase : 'idle',
      thinking: tailOf(i.thinking, i.thinkingCut), text: tailOf(i.text, i.textCut), updatedAt: str(i.updatedAt) || null,
    };
  }
  return { runId: str(d.runId) || null, updatedAt: str(d.updatedAt) || null, instances };
}

// The tails that may be shown for a run: the document is about that run and the page got it a moment ago.
// live: { doc: parseLive(...), at: when the page got it } -> { [instanceId]: tail } | null
export function liveTails(live, runId, now = Date.now()) {
  if (!live?.doc || !runId || live.doc.runId !== runId) return null;
  if (!Number.isFinite(live.at) || now - live.at > LIVE_STALE_MS) return null;
  return live.doc.instances;
}

// What is shown under an agent's line: the reasoning while there is one, the answer once the model writes it or
// when it shows no reasoning. -> { text: { kind, label, body, cut } | null, note }
function liveText(tail) {
  if (!tail) return { text: null, note: '' };
  const reasoning = tail.thinking ? { kind: 'reasoning', label: 'Reasoning', ...tail.thinking } : null;
  const answer = tail.text ? { kind: 'answer', label: 'Answer', ...tail.text } : null;
  return { text: tail.phase === 'text' && answer ? answer : reasoning ?? answer, note: !reasoning && answer ? NO_REASONING : '' };
}

// ------------------------------------------------------------ what an agent is doing now

// A tool call as a sentence: "Editing src/cli.js", "Running node --test". A journal from before targetFile and
// command says both in detail.
export function toolLine(t) {
  if (!t) return '';
  const detail = str(t.detail).trim();
  const file = str(t.targetFile).trim() || detail;
  switch (t.tool) {
    case 'read': return `Reading ${file || 'a file'}`;
    case 'write': return `Writing ${file || 'a file'}`;
    case 'edit': return `Editing ${file || 'a file'}`;
    case 'bash':
    case 'powershell': return `Running ${str(t.command).trim() || detail || 'a command'}`;
    case 'grep':
    case 'find': return detail ? `Searching for ${detail}` : 'Searching the workspace';
    case 'ls': return `Listing ${detail || '.'}`;
    default: return [`Using ${str(t.tool) || 'a tool'}`, detail].filter(Boolean).join(' ');
  }
}

// the engine's activity text when it says more than the status word does
function said(activity, word) {
  const t = str(activity).replace(/\s*(\.{3}|…)$/, '').trim();
  return t && t.toLowerCase() !== word ? t : '';
}

// x: an instance or a role aggregate of the reducer state
function teamLine(x, tail, gate) {
  if (x.tool) return toolLine(x.tool);
  switch (x.status) {
    case 'starting': return 'Starting';
    case 'thinking': return said(x.activity, 'thinking') || (tail?.phase === 'text' ? 'Writing' : 'Thinking');
    case 'working': return said(x.activity, 'working') || 'Working';
    case 'waiting': return said(x.activity, 'waiting') || 'Waiting';
    case 'blocked': return ['Blocked', said(x.activity, 'blocked')].filter(Boolean).join(': ');
    case 'error': return ['Failed', said(x.activity, 'error')].filter(Boolean).join(': ');
    case 'interrupted': return 'Run process exited';
    default:
      if (gate) return `${gate.label}${gate.cycle ? ` · cycle ${gate.cycle}` : ''}`;
      return x.lastKeyword ? `Finished: ${x.lastKeyword}` : said(x.activity, 'idle') || (x.status === 'done' ? 'Done' : 'Idle');
  }
}

function teamAgent(state, x, id, tails, { name, role, gate, tailId = id }) {
  const active = ACTIVE.has(x.status);
  const tail = active && tails ? own(tails, tailId) ?? null : null;
  const shown = active || x.status === 'error' || x.status === 'blocked' ? null : gate;
  return {
    id, agent: x.agent ?? id, name, role, status: x.status, live: isLive(x) && x.status !== 'idle', busy: isBusy(x),
    line: teamLine(x, tail, shown), gate: shown?.result ?? null, ...liveText(tail), files: x.touchedFiles ?? [],
  };
}

// One entry per instance in reading order; a serial run has no instances, its roles speak instead.
export function teamAgents(state, tails = null) {
  if (!state?.runId) return [];
  const lanes = lanesOf(state);
  if (lanes.length) {
    return lanes.map((i) => teamAgent(state, i, i.id, tails, {
      name: i.id, gate: laneGate(state, i),
      role: [laneRole(i.agent, state), i.milestoneId && i.milestoneId !== 'plan' ? i.milestoneId : ''].filter(Boolean).join(' · '),
    }));
  }
  // JSON transport has role-only statuses, but live.json uses the same exact invocation ids as RPC.
  const current = state.currentMilestoneId;
  const milestone = state.activeMilestoneIds?.length === 1 && state.activeMilestoneIds[0] === current
    && state.milestones.some((m) => m.id === current && m.status === 'active') ? current : null;
  return activeRoles(state).filter((id) => own(state.agents, id)).map((id) => teamAgent(state, state.agents[id], id, tails, {
    name: displayName(id, state), role: laneRole(id, state), gate: isGate(state, id) ? gateView(state, id, null) : null,
    tailId: id === 'michael' ? id : milestone ? `${id}-${milestone}` : current || state.activeMilestoneIds?.length ? null : id,
  }));
}

// ------------------------------------------------------------ board: Team

// Dependencies stay visible after work starts, including on completed cards.
export function dependencyText(dep, m) {
  if (dep.kind === 'blocked') return dep.on.length ? `blocked by ${dep.on.join(', ')}: a prerequisite did not pass` : 'blocked: a prerequisite did not pass';
  if (dep.kind === 'waiting') return `waiting on ${dep.on.join(', ')}`;
  if (dep.kind === 'queued') return 'prerequisites passed - waiting for a free parallel slot';
  if (dep.kind === 'met' && m.dependsOn?.length) return `after ${m.dependsOn.join(', ')}`;
  return '';
}

// Cycles of a milestone that failed: every one it began but the one in flight or the one that passed.
function failedCycles(m) {
  const open = m.cycleOpen || m.status === 'passed' || m.lastResult === 'passed' || m.lastResult === null;
  return Math.max(0, (m.cycles ?? 0) - (open ? 1 : 0));
}

// Gates check the work: one of them runs, or the developer handed the cycle over and a result is still out.
function inReview(state, m, mine) {
  const serial = !Object.keys(state.instances ?? {}).length && state.currentMilestoneId === m.id;
  const lanes = serial ? activeRoles(state).filter((id) => own(state.agents, id)).map((id) => ({ ...state.agents[id], agent: id })) : mine;
  const gates = lanes.filter((i) => isGate(state, i.agent));
  if (gates.some((i) => ACTIVE.has(i.status))) return true;
  const devs = lanes.filter((i) => !isGate(state, i.agent) && i.agent !== 'michael');
  if (!m.cycleOpen || !devs.length || devs.some((i) => ACTIVE.has(i.status)) || !devs.some((i) => i.totals?.runs > 0)) return false;
  return workflowOf(state).flat().some((g) => !((own(m.gates ?? {}, g)?.cycle ?? 0) >= m.cycles));
}

// Contract section 5, first match wins. -> { column, word }
export function milestoneColumn(state, m) {
  if (m.status === 'passed' || m.status === 'skipped') return { column: 'done', word: m.status };
  // 'interrupted' is the view's word for a milestone whose run process exited
  if (['blocked', 'failed', 'aborted', 'interrupted'].includes(m.status)) return { column: 'blocked', word: m.status };
  if (m.status !== 'active') {
    const dep = dependencyState(state, m).kind;
    return { column: 'todo', word: { waiting: 'waiting', queued: 'queued', blocked: 'blocked' }[dep] ?? 'pending' };
  }
  const mine = Object.values(state.instances ?? {}).filter((i) => i.milestoneId === m.id);
  const asked = state.hitl?.milestoneId ?? null;
  if (state.breaker === 'tripped') return { column: 'blocked', word: !asked || asked === m.id ? 'breaker tripped' : 'paused by the breaker' };
  if (asked === m.id) return { column: 'blocked', word: 'needs you' };
  if (mine.some((i) => i.status === 'blocked')) return { column: 'blocked', word: 'blocked' };
  return inReview(state, m, mine) ? { column: 'in_review', word: 'in review' } : { column: 'in_progress', word: 'in progress' };
}

// The gates of a milestone's cycle in workflow order. result: a gate result, 'running' or 'pending'.
function milestoneGates(state, m, mine) {
  if (m.status === 'pending') return [];
  return workflowOf(state).flat().map((id) => {
    const g = own(m.gates ?? {}, id);
    const current = g && !(Number.isInteger(g.cycle) && m.cycles > g.cycle) ? g.result : null;
    const running = mine.some((i) => i.agent === id && ACTIVE.has(i.status));
    return { id, name: displayName(id, state), result: running ? 'running' : current ?? 'pending' };
    // a milestone that is over has no gate still to run: only the results it recorded are shown (a journal from
    // before gate_result recorded none)
  }).filter((g) => m.status === 'active' || (g.result !== 'pending' && g.result !== 'running'));
}

function board(kind, cards, { notice = null, empty = '', note = '' } = {}) {
  const columns = BOARD_COLUMNS.map((c) => ({ ...c, cards: cards.filter((x) => x.column === c.id) }));
  return {
    kind, columns, total: cards.length, counts: Object.fromEntries(columns.map((c) => [c.id, c.cards.length])),
    notice, note, empty: cards.length ? '' : empty,
  };
}

// agents: teamAgents(state, tails), so a card says what its instances do in the same words as everything else
export function teamBoard(state, agents = teamAgents(state)) {
  if (!state?.runId) return board('milestone', [], { empty: 'No run yet' });
  const lines = new Map(agents.map((a) => [a.id, a]));
  const cards = (state.milestones ?? []).map((m) => {
    const { column, word } = milestoneColumn(state, m);
    const mine = lanesOf(state).filter((i) => i.milestoneId === m.id);
    const dep = dependencyState(state, m);
    const failed = m.lastResult === 'failed' && m.lastReason && column !== 'done' && column !== 'todo';
    return {
      id: m.id, title: m.title, column, state: word, loud: column === 'blocked' || word === 'blocked',
      note: dependencyText(dep, m),
      reason: failed ? m.lastReason : m.status !== 'passed' && m.status !== 'active' && m.status !== 'pending' ? str(m.lastReason) : '',
      agents: m.status === 'active' ? mine.filter(isLive).map((i) => ({ id: i.id, status: i.status, line: lines.get(i.id)?.line ?? i.status })) : [],
      attempt: m.cycles ?? 0, failed: failedCycles(m), gates: milestoneGates(state, m, mine),
      description: str(m.description), criteria: m.acceptanceCriteria ?? [],
    };
  });
  let notice = null;
  if (state.status === 'exited') notice = { text: 'The run process exited before the run finished.', loud: true };
  else if (humanNeeded(state)) notice = { text: ['Waiting for your answer', str(state.hitl?.reason).split('\n')[0]].filter(Boolean).join(': '), loud: true };
  const empty = state.result ? 'This run had no milestones.' : 'Waiting for the plan...';
  return board('milestone', cards, { notice, empty });
}

// ------------------------------------------------------------ board and agents: Pipeline

const stepId = (v) => str(v).replace(/^step:/, '');

// The implemented steps of a pipeline run: what the server says, else what the events and the status imply.
export function doneSteps(run) {
  const steps = run?.plan?.steps ?? [];
  const s = run?.status ?? null;
  if (Array.isArray(run?.stepsDone)) return run.stepsDone.map(stepId).filter(Boolean);
  if (!s || !steps.length) return [];
  const all = steps.map((x) => x.id);
  if (s.status === 'succeeded' || ['review', 'deliver', 'done'].includes(s.phase)) return all;
  const done = new Set();
  for (const e of run.events ?? []) if (e.type === 'wave_merged') for (const id of Array.isArray(e.data?.merged) ? e.data.merged : []) done.add(stepId(id));
  for (const l of s.progress.lanes) if (l.state === 'merged') done.add(l.stepId);
  // without lanes the steps run in plan order: the ones before the current step are done
  if (!s.progress.lanes.length && s.phase === 'implement') for (const id of all.slice(0, Math.max(0, s.progress.stepIndex))) done.add(id);
  return all.filter((id) => done.has(id));
}

const STOPPED = new Set(['suspended', 'failed', 'cancelled', 'rejected']);
const LANE_WORD = { running: 'in progress', passed: 'passed, waiting for the merge', merged: 'merged', failed: 'lane failed' };
const CHECK_RESULT = { passed: 'passed', failed: 'failed', timed_out: 'failed', error: 'error' };
const NODE_LINE = {
  implement: 'Implementing', implement_context: 'Reading files for', apply_edits: 'Applying edits to', verify: 'Running the checks for',
  select_step: 'Starting', run_lane: 'Implementing', merge_wave: 'Merging',
};

function stepLine(s, step, index, total) {
  const verb = own(NODE_LINE, s.node ?? '') ?? 'Implementing';
  const attempt = s.progress.attempt > 1 ? ` (attempt ${s.progress.attempt})` : '';
  return `${verb} step ${index + 1}/${total}${step.title ? `: ${step.title}` : ''}${attempt}`;
}

// Contract section 5, Pipeline steps, first match wins.
export function pipelineBoard(run) {
  const s = run?.status ?? null;
  const steps = run?.plan?.steps ?? [];
  if (!s) return board('step', [], { empty: 'No run yet' });
  const done = new Set(doneSteps(run));
  const delivered = s.phase === 'deliver' || s.phase === 'done';
  const stopped = STOPPED.has(s.status) || TERMINAL.has(s.status);
  const cards = steps.map((step, i) => {
    const lane = s.progress.lanes.find((l) => l.stepId === step.id) ?? null;
    const current = !s.progress.lanes.length && s.phase === 'implement' && s.progress.stepIndex === i;
    let column = 'todo';
    let word = 'to do';
    if (done.has(step.id)) [column, word] = delivered ? ['done', 'done'] : ['in_review', 'implemented'];
    else if (lane || current) {
      column = stopped ? 'blocked' : 'in_progress';
      word = stopped ? s.status : lane ? own(LANE_WORD, lane.state) ?? lane.state.replace(/_/g, ' ') : 'in progress';
    }
    const attempt = lane?.attempt || (current ? s.progress.attempt : 0);
    const working = s.status === 'running' && column === 'in_progress' && (!lane || lane.state === 'running');
    return {
      id: step.id, title: step.title, column, state: word, loud: column === 'blocked' || lane?.state === 'failed',
      note: step.files?.length ? `${step.files.length} file${step.files.length === 1 ? '' : 's'}` : '',
      reason: column === 'blocked' ? str(s.failure?.message) : '',
      agents: working ? [{ id: 'implementer', status: 'working', line: lane ? 'Implementing in its own lane' : stepLine(s, step, i, steps.length) }] : [],
      attempt, failed: Math.max(0, attempt - 1),
      // the checks are the run's last verification, which is that of the step in flight
      gates: current ? s.checks.map((c) => ({ id: c.id, name: c.id, result: own(CHECK_RESULT, c.status) ?? 'error' })) : [],
      description: str(step.description), criteria: step.criteria ?? [],
    };
  });
  let notice = null;
  if (s.status === 'awaiting_approval' && s.pending) {
    notice = { loud: true, text: s.pending.gate === 'plan' ? (s.pending.revision > 0 ? `The revised plan (revision ${s.pending.revision}) waits for your approval.` : 'The plan waits for your approval.') : 'The changes wait for your decision.' };
  } else if (STOPPED.has(s.status)) notice = { loud: true, text: `The run is ${s.status}.` };
  const empty = TERMINAL.has(s.status) ? 'This run had no steps.' : 'Waiting for the plan...';
  // the engine only stores the exact done steps once a run has ended; until then they are derived from its events
  const derived = run.stepsDoneExact === false || (!Array.isArray(run.stepsDone) && !TERMINAL.has(s.status));
  const note = cards.length && derived ? 'Step states are approximate for this run.' : '';
  return board('step', cards, { notice, empty, note });
}

const ROLE_TITLE = { planner: 'Planning', implementer: 'Implementation', reviewer: 'Review' };
const PHASE_ROLE = { plan: 'planner', approve_plan: 'planner', implement: 'implementer', review: 'reviewer' };

// the newest message a role wrote, lane: only what it said in that lane
function lastMessage(events, role, lane = null) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type !== 'agent_message' || e.data?.role !== role || (lane && e.lane !== lane)) continue;
    const t = tailOf(e.data.text);
    if (t) return { kind: 'message', label: 'Latest message', ...t };
  }
  return null;
}

function editedFiles(events, lane = null) {
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < TOUCHED_MAX; i -= 1) {
    const e = events[i];
    if (e.type !== 'edits_applied' || (lane && e.lane !== lane)) continue;
    for (const path of Array.isArray(e.data?.files) ? e.data.files : []) {
      if (typeof path === 'string' && path && !out.some((f) => f.path === path) && out.length < TOUCHED_MAX) out.push({ path: stripBidi(path), kind: 'edit', ts: e.ts || null });
    }
  }
  return out;
}

// The three roles of a pipeline run, the implementer once per lane of a parallel wave. Without liveText the live
// text is the role's latest message. tails: liveTails of the run's liveText.
export function pipelineAgents(run, tails = null) {
  const s = run?.status ?? null;
  if (!s) return [];
  const events = run.events ?? [];
  const steps = run.plan?.steps ?? [];
  const going = s.status === 'running';
  // Finalize always reports phase done; use the stepper's failure/last-work inference for stopped runs.
  const phase = STOPPED.has(s.status) ? stepper(s, lastWorkNode(events)).find((p) => p.state === 'stopped' || p.state === 'failed')?.id : s.phase;
  const at = going || STOPPED.has(s.status) || s.status === 'awaiting_approval' ? own(PHASE_ROLE, s.pending?.gate === 'plan' ? 'plan' : phase ?? '') ?? null : null;
  const spoke = (role) => events.some((e) => e.type === 'agent_message' && e.data?.role === role);
  const row = (role, { id = role, where = '', lane = null, status, line }) => {
    const tail = status === 'working' && tails ? own(tails, id) ?? own(tails, role) ?? null : null;
    const live = liveText(tail);
    return {
      id, agent: role, name: own(ROLE_LABEL, role) ?? role, role: [own(ROLE_TITLE, role), where].filter(Boolean).join(' · '), status,
      live: !['done', 'idle', 'cancelled', 'rejected'].includes(status), busy: status === 'working', line, gate: null,
      text: live.text ?? lastMessage(events, role, lane), note: live.note, files: role === 'implementer' ? editedFiles(events, lane) : [],
    };
  };
  const state = (role) => {
    if (at !== role) return { status: spoke(role) ? 'done' : 'idle', line: spoke(role) ? 'Done' : 'Not started' };
    if (s.status === 'awaiting_approval') return { status: 'waiting', line: 'Waiting for your approval of the plan' };
    if (!going) return {
      status: s.status === 'failed' ? 'error' : s.status === 'suspended' ? 'blocked' : s.status,
      line: [s.status[0].toUpperCase() + s.status.slice(1), str(s.failure?.message)].filter(Boolean).join(': '),
    };
    const i = s.progress.stepIndex;
    const line = role === 'planner' ? (s.node === 'plan_context' ? 'Reading the project for the plan' : s.progress.planRevision > 0 ? `Revising the plan (revision ${s.progress.planRevision})` : 'Planning')
      : role === 'reviewer' ? (s.node === 'ground' ? 'Checking the evidence' : `Reviewing the changes${s.progress.reviewRound > 1 ? ` (round ${s.progress.reviewRound})` : ''}`)
        : steps[i] ? stepLine(s, steps[i], i, steps.length) : 'Implementing';
    return { status: 'working', line };
  };
  const lanes = at === 'implementer' ? s.progress.lanes : [];
  const implementers = lanes.length
    ? lanes.map((l) => row('implementer', {
      id: `implementer:${l.stepId}`, where: l.stepId, lane: l.stepId,
      status: !going ? state('implementer').status : l.state === 'running' ? 'working' : l.state === 'failed' ? 'error' : 'done',
      line: !going ? state('implementer').line : l.state === 'running' ? `Implementing ${l.title || l.stepId}${l.attempt > 1 ? ` (attempt ${l.attempt})` : ''}` : own(LANE_WORD, l.state) ?? l.state,
    }))
    : [row('implementer', state('implementer'))];
  return [row('planner', state('planner')), ...implementers, row('reviewer', state('reviewer'))];
}

// ------------------------------------------------------------ usage

// A usage object from a server (contract section 2 shape, `estimated` for a pipeline run) -> the same shape with
// every number checked, or null. A point's cost is null where the server has no per-call cost.
export function parseUsage(doc) {
  const d = obj(doc);
  if (!d) return null;
  const cost = (v) => (v === null || v === undefined ? null : count(Number(v)));
  const part = (v) => ({ input: count(v?.input), output: count(v?.output), cost: cost(v?.cost), tokens: count(v?.tokens) || count(v?.input) + count(v?.output), calls: count(v?.calls) });
  const byAgent = {};
  for (const [id, a] of Object.entries(obj(d.byAgent) ?? {})) if (obj(a)) byAgent[stripBidi(id)] = part(a);
  const series = (Array.isArray(d.series) ? d.series : []).slice(-2 * USAGE_POINTS_MAX).map((p) => (obj(p) ? {
    ts: str(p.ts) || null, tokens: count(p.tokens), cost: cost(p.cost),
    byAgent: Object.fromEntries(Object.entries(obj(p.byAgent) ?? {}).filter(([, a]) => obj(a)).map(([id, a]) => [stripBidi(id), { tokens: count(a.tokens), cost: cost(a.cost) }])),
  } : null)).filter(Boolean);
  return { ...part(d), startedAt: str(d.startedAt) || null, byAgent, series, ...(d.estimated === true ? { estimated: true } : {}) };
}

// The same fold as the reducer's for a pipeline run whose server sends no usage: its llm_call events, tokens only.
// usage: what was folded so far (not changed). -> usage
export function foldCalls(usage, events) {
  const calls = (events ?? []).filter((e) => e?.type === 'llm_call' && obj(e.data));
  if (!calls.length) return usage ?? null;
  const u = usage ? structuredClone(usage) : freshUsage();
  for (const e of calls) addUsage(u, str(e.data.role) || '?', { input: count(e.data.input_tokens), output: count(e.data.output_tokens), cost: 0 }, e.ts || null);
  // llm_call reports tokens only; zero in the shared fold is not a reported price.
  u.cost = null;
  for (const a of Object.values(u.byAgent)) a.cost = null;
  for (const p of u.series) {
    p.cost = null;
    for (const a of Object.values(p.byAgent)) a.cost = null;
  }
  return u;
}

// What a chat has used: the listed runs that report it, with the run on screen counted as it stands now.
// rows: [{ runId, usage: { tokens, cost } | null }]. -> { tokens, cost, runs, of, estimated } | null (no total)
function chatTotal(rows, runId, current) {
  const others = (rows ?? []).filter((r) => r && r.runId !== runId);
  const known = others.filter((r) => obj(r.usage));
  if ((others.length && !known.length) || (!known.length && !current)) return null;
  const all = [...known.map((r) => r.usage), ...(current ? [current] : [])];
  return {
    tokens: all.reduce((n, u) => n + count(u.tokens), 0), cost: all.some((u) => typeof u.cost === 'number') ? all.reduce((n, u) => n + count(u.cost), 0) : null,
    runs: all.length, of: others.length + (current ? 1 : 0), estimated: all.some((u) => u.estimated === true),
  };
}

// usage: contract section 2 shape. names(id) -> what an agent is called. order: agent ids in display order.
function usageView(usage, { rows = [], runId = null, names = (id) => id, order = [], total = null, estimated = false, costSeries = true } = {}) {
  const u = usage ?? freshUsage();
  const run = {
    cost: total ? total.cost : u.cost, tokens: total?.tokens ?? u.tokens, input: total?.input ?? u.input, output: total?.output ?? u.output,
    calls: total?.calls ?? u.calls, estimated: estimated || u.estimated === true,
  };
  const ids = [...order.filter((id) => own(u.byAgent, id)), ...Object.keys(u.byAgent).filter((id) => !order.includes(id))];
  const byCost = count(u.cost) > 0 && ids.every((id) => typeof u.byAgent[id].cost === 'number');
  const whole = byCost ? u.cost : u.tokens;
  const agents = ids.map((id) => {
    const a = u.byAgent[id];
    return { id, name: names(id), calls: a.calls, tokens: a.tokens, input: a.input, output: a.output, cost: a.cost, share: whole > 0 ? (byCost ? count(a.cost) : a.tokens) / whole : 0 };
  });
  let last = stamp(u.startedAt);
  const series = u.series.map((p) => {
    last = stamp(p.ts) ?? last;
    return { at: last, tokens: p.tokens, cost: costSeries ? p.cost : null, by: p.byAgent };
  }).filter((p) => p.at !== null);
  const started = Boolean(runId) || run.calls > 0;
  return {
    run, agents, series, shareMetric: byCost ? 'cost' : 'tokens',
    startedAt: stamp(u.startedAt) ?? series[0]?.at ?? null, hasCost: run.cost !== null,
    costSeries: series.some((p) => p.cost !== null),
    chat: chatTotal(rows, runId, started ? { tokens: run.tokens, cost: run.cost, estimated: run.estimated } : null),
  };
}

export function teamUsage(state, runs = []) {
  const order = [...AGENT_IDS, ...customRoles(state).map((r) => r.id)];
  return usageView(state?.usage, { rows: runs, runId: state?.runId ?? null, names: (id) => displayName(id, state), order });
}

// run.usage: parseUsage of the response; run.calls: foldCalls of its llm_call events, for a server without usage.
// The run total is the engine's own (status.usage) wherever the points carry no cost.
export function pipelineUsage(run, list = null) {
  const s = run?.status ?? null;
  const reported = run?.usage ?? null;
  const exact = Boolean(reported) && reported.cost !== null && reported.series.every((p) => p.cost !== null);
  const total = s?.usage && !exact ? { cost: s.usage.cost, tokens: s.usage.inputTokens + s.usage.outputTokens, input: s.usage.inputTokens, output: s.usage.outputTokens, calls: s.usage.calls } : null;
  return usageView(reported ?? run?.calls ?? null, {
    rows: list?.runs ?? [], runId: run?.runId ?? null, names: (id) => own(ROLE_LABEL, id) ?? id, order: Object.keys(ROLE_LABEL), total,
    // the engine prices its calls from a table: its total is an estimate
    estimated: Boolean(total) && total.cost !== null, costSeries: Boolean(reported),
  });
}

// ------------------------------------------------------------ the run as the panels show it

// state: the reducer state (or its interrupted view). live: { doc, at } of the /live poll, or null.
// runs: the chat's run list. -> { runId, live, agents, board, usage }
export function teamRunView({ state, live = null, runs = [], now = Date.now() } = {}) {
  const going = ['planning', 'running', 'paused'].includes(state?.status);
  const agents = teamAgents(state, going ? liveTails(live, state?.runId, now) : null);
  return { runId: state?.runId ?? null, live: going, agents, board: teamBoard(state, agents), usage: teamUsage(state, runs) };
}

// run: the run document as the pipeline view holds it ({ runId, status, live, events, plan, usage, calls, liveText,
// stepsDone, stepsDoneExact }). list: the chat's run list.
export function pipelineRunView({ run = null, list = null, now = Date.now() } = {}) {
  const going = Boolean(run?.status) && !TERMINAL.has(run.status.status);
  const tails = going && run.liveText ? liveTails({ doc: { ...run.liveText, runId: run.liveText.runId ?? run.runId }, at: run.liveAt ?? now }, run.runId, now) : null;
  return { runId: run?.runId ?? null, live: going, agents: pipelineAgents(run, tails), board: pipelineBoard(run), usage: pipelineUsage(run, list) };
}

// ------------------------------------------------------------ what the rail says in one line

// "1 in progress · 1 in review · 2 of 5 done"
export function boardSummary(b) {
  if (!b?.total) return b?.empty || 'No board yet';
  const said = [['in_progress', 'in progress'], ['in_review', 'in review'], ['blocked', 'blocked']].filter(([id]) => b.counts[id]).map(([id, word]) => `${b.counts[id]} ${word}`);
  return [...said, `${b.counts.done} of ${b.total} done`].join(' · ');
}

// "2 active · 3 finished"
export function agentsSummary(agents) {
  const active = (agents ?? []).filter((a) => a.live).length;
  const rest = (agents ?? []).length - active;
  return [active ? `${active} active` : '', rest ? `${rest} ${active ? 'finished' : rest === 1 ? 'agent' : 'agents'}` : ''].filter(Boolean).join(' · ');
}

// Where the run rail is. view: 'chat' | 'dashboard'. run: a run is on screen. wide: the window has room for it
// beside the transcript (RAIL_WIDE). collapsed: the human closed it there. overlay: it was opened over a narrow page.
// -> 'none' | 'open' (beside the transcript) | 'overlay' | 'closed'
export function railMode({ view, run, wide, collapsed = false, overlay = false }) {
  if (view !== 'chat' || !run) return 'none';
  if (wide) return collapsed ? 'closed' : 'open';
  return overlay ? 'overlay' : 'closed';
}

export const parseRailChoice = (v) => v === 'closed';

// The single line above the composer while the rail is out of sight: who is busy and with what. '' = no line.
export function liveLine(view, mode) {
  if (mode !== 'closed' || !view?.live) return '';
  const busy = view.agents.filter((a) => a.busy);
  if (!busy.length) return view.board.notice?.text ?? '';
  // one that runs a tool says more than one that thinks
  const first = busy.find((a) => a.status === 'working') ?? busy[0];
  return `${first.name} · ${first.line}${busy.length > 1 ? ` · +${busy.length - 1} more` : ''}`;
}
