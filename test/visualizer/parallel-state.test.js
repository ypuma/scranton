import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createState, reduce, reduceAll, parseJsonl, roleView, lanesOf, dependencyState, roleOf, isLive, totals,
  normalizeExecution, CHAT_SIZE, CHAT_TEXT_MAX,
} from '../../visualizer/public/js/state.js';

// the serial demo recording from before parallel runs
const SAMPLE = fileURLToPath(new URL('./fixtures/serial-events.jsonl', import.meta.url));

function maker(runId) {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString(), runId, type, ...fields });
}

const PLAN = [
  { id: 'm1', title: 'Store', description: '', acceptanceCriteria: [], dependsOn: [] },
  { id: 'm2', title: 'CLI', description: '', acceptanceCriteria: [], dependsOn: [] },
  { id: 'm3', title: 'Docs', description: '', acceptanceCriteria: [], dependsOn: ['m1', 'm2'] },
];
const EXECUTION = { maxParallel: 3, isolation: 'worktree', persistentSessions: true, maxReplans: 2, sandbox: { mode: 'docker', image: 'scranton-tools:24-r1', network: 'bridge' } };

// The shapes the orchestrator writes: instance_started carries id and instanceId, hive_write.instanceId is the recipient.
function started(e, id, agent, milestoneId) {
  return e('instance_started', { id, instanceId: id, agent, milestoneId, sessionId: `${id}-0000-uuid`, worktree: `C:\\hive\\isolation\\${id}`, sandbox: 'docker' });
}

function parallelRun() {
  const e = maker('par');
  const events = [
    e('run_started', { request: 'Todo', workspace: 'C:\\w', maxFailedCycles: 3, execution: EXECUTION }),
    e('plan_ready', { milestones: PLAN }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 3, title: 'Store' }),
    e('hive_write', { from: 'michael', to: 'dwight', file: 'dwight-m1/inbox.md', kind: 'task', summary: 'm1: Store', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1 }),
    started(e, 'dwight-m1', 'dwight', 'm1'),
    e('milestone_started', { milestoneId: 'm2', index: 1, total: 3, title: 'CLI' }),
    e('hive_write', { from: 'michael', to: 'dwight', file: 'dwight-m2/inbox.md', kind: 'task', summary: 'm2: CLI', instanceId: 'dwight-m2', milestoneId: 'm2', cycle: 1 }),
    started(e, 'dwight-m2', 'dwight', 'm2'),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Writing todo.js' }),
    e('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'write', detail: 'todo.js' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'thinking', activity: 'Thinking...' }),
  ];
  return { e, events, state: reduceAll(events) };
}

test('parallel milestones: both pipelines are active, the oldest stays the scalar current one', () => {
  const { state: s } = parallelRun();
  assert.deepEqual(s.activeMilestoneIds, ['m1', 'm2']);
  assert.equal(s.currentMilestoneId, 'm1');
  assert.equal(s.milestoneIndex, 0, 'a second pipeline does not move the current index');
  assert.deepEqual(s.milestones.map((m) => [m.id, m.status]), [['m1', 'active'], ['m2', 'active'], ['m3', 'pending']]);
  assert.deepEqual(s.execution, { maxParallel: 3, isolation: 'worktree', sandbox: { mode: 'docker', image: 'scranton-tools:24-r1', network: 'bridge' }, persistentSessions: true, simulated: false, trustedHost: false });
});

test('instances get their own lane with session, worktree and sandbox', () => {
  const { state: s } = parallelRun();
  assert.deepEqual(lanesOf(s).map((i) => [i.id, i.agent, i.milestoneId, i.status]), [
    ['dwight-m1', 'dwight', 'm1', 'working'], ['dwight-m2', 'dwight', 'm2', 'thinking'],
  ]);
  const d1 = s.instances['dwight-m1'];
  assert.equal(d1.sessionId, 'dwight-m1-0000-uuid');
  assert.deepEqual(d1.worktree, { mode: 'worktree', dir: 'C:\\hive\\isolation\\dwight-m1', ref: '' });
  assert.deepEqual(d1.sandbox, { mode: 'docker', image: '', network: '' });
  assert.deepEqual(d1.tool, { tool: 'write', detail: 'todo.js', targetFile: 'todo.js', command: null, startedAt: '2026-11-08T12:00:10.000Z' });
});

test('a role card speaks for its loudest live lane, not for whichever lane wrote last', () => {
  const { e, state } = parallelRun();
  let view = roleView(state, 'dwight');
  assert.equal(view.lanes, 2);
  assert.equal(view.busy, 2);
  assert.equal(view.status, 'working');
  assert.match(view.activity, /^2 lanes: dwight-m1 working, dwight-m2 thinking$/);
  // dwight-m2 going idle must not make the role look idle while dwight-m1 still works
  const s = reduce(state, e('agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'idle', activity: 'Idle' }));
  assert.equal(s.agents.dwight.status, 'working', 'aggregate follows the busy instance like state.json');
  view = roleView(s, 'dwight');
  assert.equal(view.status, 'working');
  assert.equal(view.focus, 'dwight-m1');
  assert.equal(view.activity, 'dwight-m1: Writing todo.js');
  // a role without instances keeps the plain aggregate
  assert.equal(roleView(s, 'angela').lanes, 0);
  assert.equal(roleView(s, 'angela').status, 'idle');
});

test('dependencies: waiting, queued for a slot, and blocked by a prerequisite that did not pass', () => {
  const { e, state } = parallelRun();
  const m3 = (s) => s.milestones.find((m) => m.id === 'm3');
  assert.deepEqual(dependencyState(state, m3(state)), { kind: 'waiting', on: ['m1', 'm2'] });
  assert.deepEqual(dependencyState(state, state.milestones[0]), { kind: 'none', on: [] });
  let s = reduce(state, e('milestone_finished', { milestoneId: 'm1', status: 'passed' }));
  assert.deepEqual(dependencyState(s, m3(s)), { kind: 'waiting', on: ['m2'] });
  const passed = reduce(s, e('milestone_finished', { milestoneId: 'm2', status: 'passed' }));
  assert.deepEqual(dependencyState(passed, m3(passed)), { kind: 'queued', on: [] });
  // a skipped prerequisite never counts as passed
  const skipped = reduce(s, e('milestone_finished', { milestoneId: 'm2', status: 'skipped' }));
  assert.deepEqual(dependencyState(skipped, m3(skipped)), { kind: 'blocked', on: ['m2'] });
  s = reduce(skipped, e('milestone_finished', { milestoneId: 'm3', status: 'blocked', reason: 'Prerequisites did not pass: m2' }));
  assert.equal(m3(s).status, 'blocked');
  assert.equal(m3(s).lastReason, 'Prerequisites did not pass: m2');
  assert.deepEqual(dependencyState(s, m3(s)), { kind: 'blocked', on: ['m2'] });
  assert.match(s.log.at(-1).text, /m3 blocked: Prerequisites did not pass: m2/);
});

test('a finished milestone ends its lanes and hands the scalar current milestone to the next pipeline', () => {
  const { e, state } = parallelRun();
  let s = reduce(state, e('milestone_integrated', { milestoneId: 'm1' }));
  assert.equal(s.milestones[0].integrated, true);
  s = reduce(s, e('milestone_finished', { milestoneId: 'm1', status: 'passed' }));
  assert.deepEqual(s.activeMilestoneIds, ['m2']);
  assert.equal(s.currentMilestoneId, 'm2');
  assert.equal(s.milestoneIndex, 1);
  assert.equal(s.instances['dwight-m1'].status, 'done');
  assert.equal(isLive(s.instances['dwight-m1']), false);
  assert.equal(s.instances['dwight-m2'].status, 'thinking');
  s = reduce(s, e('agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'error', activity: 'Failed: no image' }));
  s = reduce(s, e('run_finished', { status: 'partial', summary: 'x' }));
  assert.deepEqual(s.activeMilestoneIds, []);
  assert.equal(s.currentMilestoneId, null);
  assert.equal(s.instances['dwight-m2'].status, 'error', 'a real error stays on its lane');
  assert.ok(lanesOf(s).every((i) => i.status === 'done' || i.status === 'error'));
});

test('a parallel lane that is not the current milestone counts its own cycles', () => {
  const { e, state } = parallelRun();
  let s = reduce(state, e('cycle_result', { milestoneId: 'm2', cycle: 1, result: 'failed', failedCycles: 1, reason: 'boom' }));
  assert.equal(s.cycle, 1, 'the current milestone m1 is unaffected');
  s = reduce(s, e('agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'thinking', activity: 'Reading bug report...' }));
  assert.equal(s.milestones[1].cycles, 2);
  assert.equal(s.cycle, 1);
  s = reduce(s, e('agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'working', activity: 'Fixing' }));
  assert.equal(s.milestones[1].cycles, 2, 'one cycle per pickup');
});

test('instance mailboxes land in their role mailbox and name the instance', () => {
  const { state: s } = parallelRun();
  assert.equal(s.mailboxes.dwight.file, 'dwight-m2/inbox.md');
  assert.equal(s.mailboxes.dwight.instance, 'dwight-m2');
  assert.equal(roleOf('angela-m4'), 'angela');
  assert.equal(roleOf('human'), 'human');
  assert.equal(roleOf('mallory'), null);
});

test('instance events without instance_started still get a lane, and replay changes nothing', () => {
  const { e, events, state } = parallelRun();
  const s = reduce(state, e('agent_status', { agent: 'angela', instanceId: 'angela-m1', status: 'thinking', activity: 'Reviewing' }));
  assert.equal(s.instances['angela-m1'].agent, 'angela');
  assert.equal(s.instances['angela-m1'].milestoneId, null);
  assert.equal(reduceAll(events, state), state, 'a reconnect replay returns the same state object');
  // usage is counted once: per instance and per role, but totals() sums roles only
  const f = reduce(s, e('agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 10, usage: { input: 100, output: 20, cost: 0.01 } }));
  assert.equal(f.instances['dwight-m1'].totals.input, 100);
  assert.equal(f.instances['dwight-m1'].status, 'idle');
  assert.equal(totals(f).tokens, 120);
});

test('chat: queued, then delivered; a late queued echo never undoes a settled delivery', () => {
  const { e, state } = parallelRun();
  let s = reduce(state, e('chat_message', { id: 'c1', from: 'human', to: 'dwight-m1', text: 'Use todos.json', delivery: 'queued' }));
  assert.deepEqual(s.chat.map((c) => [c.id, c.from, c.to, c.delivery]), [['c1', 'human', 'dwight-m1', 'queued']]);
  assert.equal(s.log.at(-1).category, 'handoffs');
  assert.equal(s.log.at(-1).source, 'human');
  s = reduce(s, e('chat_delivery', { id: 'c1', delivery: 'delivered' }));
  assert.equal(s.chat[0].delivery, 'delivered');
  s = reduce(s, e('chat_delivery', { id: 'c1', delivery: 'queued' }));
  s = reduce(s, e('chat_message', { id: 'c1', from: 'human', to: 'dwight-m1', text: 'Use todos.json', delivery: 'queued' }));
  assert.equal(s.chat.length, 1);
  assert.equal(s.chat[0].delivery, 'delivered');
  s = reduce(s, e('chat_message', { id: 'c2', from: 'dwight-m1', to: 'angela-m9', text: 'hi', delivery: 'rejected', reason: 'Unknown recipient angela-m9' }));
  assert.equal(s.chat[1].delivery, 'rejected');
  assert.equal(s.chat[1].reason, 'Unknown recipient angela-m9');
  assert.equal(s.log.at(-1).tone, 'bad');
  s = reduce(s, e('chat_delivery', { id: 'nope', delivery: 'delivered' }));
  assert.equal(s.chat.length, 2, 'a delivery for an unknown message adds nothing');
  s = reduce(s, e('chat_message', { id: 'c3', from: 'human', to: 'dwight-m1', text: 'x', delivery: 'teleported' }));
  assert.equal(s.chat[2].delivery, 'queued', 'an unknown delivery state is never shown as delivered');
});

test('chat is bounded in count and text, and scrubbed of bidi controls', () => {
  const { e, state } = parallelRun();
  let s = state;
  for (let i = 0; i < CHAT_SIZE + 25; i += 1) s = reduce(s, e('chat_message', { id: `m${i}`, from: 'dwight-m1', to: 'angela-m1', text: `n${i}`, delivery: 'queued' }));
  assert.equal(s.chat.length, CHAT_SIZE);
  assert.equal(s.chat[0].id, 'm25');
  s = reduce(s, e('chat_message', { id: 'big', from: 'dwight-m1', to: 'angela-m1', text: `a\u202Eb${'x'.repeat(CHAT_TEXT_MAX + 100)}`, delivery: 'queued' }));
  const big = s.chat.at(-1);
  assert.equal(big.text.length, CHAT_TEXT_MAX);
  assert.equal(big.truncated, true);
  assert.ok(big.text.startsWith('abx'), 'bidi override removed');
});

test('old serial event streams keep working without lanes', () => {
  const s = reduceAll(parseJsonl(readFileSync(SAMPLE, 'utf8')));
  assert.deepEqual(s.instances, {});
  assert.deepEqual(lanesOf(s), []);
  assert.equal(s.execution, null);
  assert.deepEqual(s.chat, []);
  for (const id of ['michael', 'dwight', 'angela']) {
    const view = roleView(s, id);
    assert.equal(view.lanes, 0);
    assert.equal(view.status, s.agents[id].status);
  }
  assert.ok(s.milestones.every((m) => m.dependsOn === null && dependencyState(s, m).kind === 'none'));
  assert.equal(createState().activeMilestoneIds.length, 0);
});

test('normalizeExecution: host is trusted host, missing input is null', () => {
  assert.equal(normalizeExecution(null), null);
  assert.equal(normalizeExecution({ sandbox: { mode: 'host' } }).trustedHost, true);
  assert.equal(normalizeExecution({ sandbox: 'docker', maxParallel: 0 }).maxParallel, null);
  assert.equal(normalizeExecution({ simulated: true }).simulated, true);
});

test('new event types have readable log lines', () => {
  const { e, state } = parallelRun();
  const s = reduceAll([
    e('chat_delivery', { id: 'zz', delivery: 'rejected', reason: 'Recipient completed before acknowledgement' }),
    e('milestone_integrated', { milestoneId: 'm1' }),
  ], state);
  const started = state.log.find((l) => l.type === 'instance_started');
  assert.equal(started.text, 'dwight-m1 started for m1 · worktree · sandbox docker');
  assert.equal(started.source, 'dwight-m1');
  assert.equal(s.log.at(-1).text, 'm1 integrated into the workspace');
  assert.equal(state.log.find((l) => l.type === 'agent_tool').source, 'dwight-m1');
});
