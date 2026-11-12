import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createState, reduce, reduceAll, parseJsonl, classify, totals, humanNeeded, LOG_SIZE } from '../../visualizer/public/js/state.js';

// the serial demo recording from before parallel runs
const SAMPLE = fileURLToPath(new URL('./fixtures/serial-events.jsonl', import.meta.url));

function maker(runId) {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 6, 12, 12, 0, seq)).toISOString(), runId, type, ...fields });
}

const plan = [
  { id: 'm1', title: 'One', description: '', acceptanceCriteria: [] },
  { id: 'm2', title: 'Two', description: '', acceptanceCriteria: [] },
];

function startedRun(runId = 'r1') {
  const e = maker(runId);
  const events = [
    e('run_started', { request: 'Do the thing', workspace: 'C:\\w', maxFailedCycles: 3 }),
    e('plan_ready', { milestones: plan }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 2, title: 'One' }),
  ];
  return { e, state: reduceAll(events) };
}

test('initial state is idle with all agents present', () => {
  const s = createState();
  assert.equal(s.status, 'idle');
  assert.equal(s.runId, null);
  assert.deepEqual(Object.keys(s.agents), ['michael', 'dwight', 'oscar', 'hank', 'angela']);
  assert.equal(s.agents.dwight.status, 'idle');
});

test('run_started and plan_ready set up planning and milestones', () => {
  const e = maker('r1');
  let s = reduce(createState(), e('run_started', { request: 'Req', workspace: 'C:\\w', maxFailedCycles: 4 }));
  assert.equal(s.status, 'planning');
  assert.equal(s.request, 'Req');
  assert.equal(s.maxFailedCycles, 4);
  s = reduce(s, e('plan_ready', { milestones: plan }));
  assert.deepEqual(s.milestones.map((m) => [m.id, m.status]), [['m1', 'pending'], ['m2', 'pending']]);
  assert.equal(s.status, 'planning');
  s = reduce(s, e('milestone_started', { milestoneId: 'm1', index: 0, total: 2, title: 'One' }));
  assert.equal(s.status, 'running');
  assert.equal(s.currentMilestoneId, 'm1');
  assert.equal(s.milestoneIndex, 0);
  assert.equal(s.cycle, 1);
  assert.equal(s.milestones[0].status, 'active');
});

test('a run_started with a different runId resets the view', () => {
  let { state } = startedRun('r1');
  state = reduce(state, { v: 1, seq: 4, ts: '2026-07-12T12:00:04.000Z', runId: 'r1', type: 'agent_status', agent: 'dwight', status: 'working', activity: 'Coding' });
  assert.equal(state.agents.dwight.status, 'working');
  const e2 = maker('r2');
  const next = reduce(state, e2('run_started', { request: 'Other', workspace: 'C:\\x', maxFailedCycles: 3 }));
  assert.equal(next.runId, 'r2');
  assert.equal(next.request, 'Other');
  assert.equal(next.milestones.length, 0);
  assert.equal(next.agents.dwight.status, 'idle');
  assert.equal(next.lastSeq, 1);
  assert.equal(next.log.length, 1);
  assert.equal(next.mailboxes.dwight, null);
  // the old state object is untouched
  assert.equal(state.runId, 'r1');
});

test('events with seq <= last applied seq of the same run are ignored (replay on reconnect)', () => {
  const e = maker('r1');
  const events = [
    e('run_started', { request: 'Req', workspace: 'C:\\w', maxFailedCycles: 3 }),
    e('agent_status', { agent: 'michael', status: 'thinking', activity: 'Planning milestones...' }),
    e('plan_ready', { milestones: plan }),
  ];
  const once = reduceAll(events);
  const replayed = reduceAll(events, once);
  assert.equal(replayed, once, 'a full replay returns the very same state object');
  assert.equal(classify(once, events[1]), 'stale');
  assert.equal(once.applied, 3);
  // the same seq with different content still counts as already applied
  const dup = { ...events[1], activity: 'Changed' };
  assert.equal(reduce(once, dup), once);
});

test('invalid events and unknown types are ignored', () => {
  const { e, state } = startedRun();
  assert.equal(reduce(state, null), state);
  assert.equal(reduce(state, { type: 'log' }), state);
  assert.equal(reduce(state, { seq: 'x', runId: 'r1', type: 'log' }), state);
  const unknown = reduce(state, e('coffee_break', { agent: 'dwight', status: 'error' }));
  assert.equal(unknown.lastSeq, 4);
  assert.equal(unknown.applied, state.applied);
  assert.deepEqual(unknown.agents, state.agents);
  assert.deepEqual(unknown.log, state.log);
  assert.equal(unknown.status, state.status);
});

test('unknown fields are ignored', () => {
  const { e, state } = startedRun();
  const s = reduce(state, e('agent_status', { agent: 'angela', status: 'thinking', activity: 'Hmm', mood: 'judgy' }));
  assert.equal(s.agents.angela.status, 'thinking');
  assert.equal(s.agents.angela.mood, undefined);
});

test('agent transitions: status, tool, finished', () => {
  const { e, state } = startedRun();
  let s = reduce(state, e('agent_status', { agent: 'dwight', status: 'working', activity: 'Writing code...' }));
  s = reduce(s, e('agent_tool', { agent: 'dwight', tool: 'write', detail: 'src/a.js' }));
  // an event from before targetFile and command says the file in detail (live-activity-contract section 1)
  assert.deepEqual(s.agents.dwight.tool, { tool: 'write', detail: 'src/a.js', targetFile: 'src/a.js', command: null, startedAt: '2026-07-12T12:00:05.000Z' });
  assert.equal(s.agents.dwight.activity, 'Writing code...');
  s = reduce(s, e('agent_finished', { agent: 'dwight', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 1000, usage: { input: 10, output: 5, cost: 0.5 } }));
  assert.equal(s.agents.dwight.lastKeyword, 'TASK_COMPLETE');
  assert.equal(s.agents.dwight.tool, null);
  assert.equal(s.agents.dwight.status, 'idle');
  assert.deepEqual(s.agents.dwight.totals, { runs: 1, input: 10, output: 5, cost: 0.5, durationMs: 1000 });
  assert.deepEqual(s.agents.dwight.lastTool, { tool: 'write', detail: 'src/a.js', targetFile: 'src/a.js', command: null, ts: '2026-07-12T12:00:05.000Z' }, 'last tool survives the finish');
  assert.equal(s.agents.dwight.lastExitCode, 0);
  s = reduce(s, e('agent_status', { agent: 'dwight', status: 'waiting', activity: 'Waiting for QA' }));
  assert.equal(s.agents.dwight.status, 'waiting');
  s = reduce(s, e('agent_status', { agent: 'nobody', status: 'working', activity: 'x' }));
  assert.equal(s.agents.nobody, undefined);
});

test('hive_write keeps the latest message per inbox, read once that agent finishes', () => {
  const { e, state } = startedRun();
  let s = reduce(state, e('hive_write', { from: 'michael', to: 'dwight', file: 'dwight/inbox.md', kind: 'task', summary: 'Build it' }));
  assert.equal(s.mailboxes.dwight.kind, 'task');
  assert.equal(s.mailboxes.dwight.from, 'michael');
  assert.equal(s.mailboxes.dwight.read, false);
  assert.equal(s.mailboxes.dwight.ts, s.updatedAt);
  s = reduce(s, e('agent_finished', { agent: 'dwight', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 1 }));
  assert.equal(s.mailboxes.dwight.read, true);
  assert.equal(s.mailboxes.dwight.summary, 'Build it');
  s = reduce(s, e('hive_write', { from: 'angela', to: 'dwight', file: 'dwight/inbox.md', kind: 'bug_report', summary: 'Broken' }));
  assert.equal(s.mailboxes.dwight.kind, 'bug_report');
  assert.equal(s.mailboxes.dwight.read, false);
  s = reduce(s, e('hive_write', { from: 'michael', to: 'human', file: 'human/inbox.md', kind: 'hitl', summary: 'Help' }));
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'retry' }));
  assert.equal(s.mailboxes.human.read, true);
});

test('plan_ready keeps descriptions and acceptance criteria; cycles are counted per milestone', () => {
  const e = maker('r1');
  let s = reduceAll([
    e('run_started', { request: 'Req', workspace: 'C:\\w', maxFailedCycles: 3 }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One', description: 'Do one', acceptanceCriteria: ['a', 'b'] }] }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 1, title: 'One' }),
  ]);
  assert.deepEqual(s.milestones[0].acceptanceCriteria, ['a', 'b']);
  assert.equal(s.milestones[0].description, 'Do one');
  assert.equal(s.milestones[0].cycles, 1);
  s = reduce(s, e('cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Off by one' }));
  assert.equal(s.milestones[0].lastReason, 'Off by one');
  assert.equal(s.milestones[0].lastResult, 'failed');
  s = reduce(s, e('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Fixing' }));
  assert.equal(s.milestones[0].cycles, 2);
});

test('log entries carry source and filter category', () => {
  const { e, state } = startedRun();
  let s = reduce(state, e('hive_write', { from: 'dwight', to: 'angela', file: 'angela/inbox.md', kind: 'handoff', summary: 'Done' }));
  s = reduce(s, e('agent_tool', { agent: 'angela', tool: 'bash', detail: 'npm test' }));
  s = reduce(s, e('cycle_result', { milestoneId: 'm1', cycle: 1, result: 'passed', failedCycles: 0, reason: 'ok' }));
  s = reduce(s, e('agent_status', { agent: 'angela', status: 'idle', activity: 'Idle' }));
  const tail = s.log.slice(-3).map((l) => [l.type, l.source, l.category]);
  assert.deepEqual(tail, [['hive_write', 'dwight', 'handoffs'], ['agent_tool', 'angela', 'tools'], ['cycle_result', 'orchestrator', 'results']]);
  assert.equal(s.log.at(0).category, 'status', 'run_started is a status line');
});

test('cycles, circuit breaker and human in the loop', () => {
  const { e, state } = startedRun();
  let s = state;
  const fail = (cycle) => {
    s = reduce(s, e('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Fixing' }));
    s = reduce(s, e('cycle_result', { milestoneId: 'm1', cycle, result: 'failed', failedCycles: cycle, reason: 'nope' }));
  };
  fail(1);
  assert.equal(s.cycle, 1);
  assert.equal(s.failedCycles, 1);
  fail(2);
  assert.equal(s.cycle, 2, 'Dwight starting again opens cycle 2');
  fail(3);
  assert.equal(s.failedCycles, 3);
  s = reduce(s, e('circuit_breaker', { milestoneId: 'm1', state: 'tripped', failedCycles: 3, maxFailedCycles: 3 }));
  assert.equal(s.breaker, 'tripped');
  assert.equal(s.status, 'paused');
  s = reduce(s, e('hitl_request', { milestoneId: 'm1', reason: 'Stuck', options: ['feedback', 'retry', 'skip', 'abort'] }));
  assert.equal(s.hitl.reason, 'Stuck');
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'feedback', feedback: 'Use cents' }));
  assert.equal(s.hitl, null);
  assert.equal(s.status, 'running', 'the answer ends the pause');
  assert.equal(humanNeeded(s), false);
  assert.equal(s.breaker, 'tripped', 'until the orchestrator resets it');
  s = reduce(s, e('circuit_breaker', { milestoneId: 'm1', state: 'reset', failedCycles: 0, maxFailedCycles: 3 }));
  assert.equal(s.breaker, 'closed');
  assert.equal(s.status, 'running');
  assert.equal(s.failedCycles, 0);
  s = reduce(s, e('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Again' }));
  assert.equal(s.cycle, 4);
  s = reduce(s, e('cycle_result', { milestoneId: 'm1', cycle: 4, result: 'passed', failedCycles: 0, reason: 'ok' }));
  s = reduce(s, e('milestone_finished', { milestoneId: 'm1', status: 'passed' }));
  assert.equal(s.milestones[0].status, 'passed');
});

test('skip and abort decisions finish milestones and the run', () => {
  const { e, state } = startedRun();
  let s = reduce(state, e('milestone_finished', { milestoneId: 'm1', status: 'skipped' }));
  assert.equal(s.milestones[0].status, 'skipped');
  s = reduce(s, e('milestone_started', { milestoneId: 'm2', index: 1, total: 2, title: 'Two' }));
  s = reduce(s, e('hitl_request', { milestoneId: 'm2', reason: 'Stuck', options: ['abort'] }));
  s = reduce(s, e('hitl_response', { milestoneId: 'm2', decision: 'abort' }));
  s = reduce(s, e('milestone_finished', { milestoneId: 'm2', status: 'aborted' }));
  s = reduce(s, e('run_finished', { status: 'aborted', summary: 'Gave up' }));
  assert.equal(s.status, 'aborted');
  assert.equal(s.result, 'aborted');
  assert.equal(s.milestones[1].status, 'aborted');
});

// m1 fails three cycles in a row and trips the breaker; the human is asked.
function trippedRun() {
  const { e, state } = startedRun();
  let s = state;
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    s = reduce(s, e('agent_status', { agent: 'dwight', status: 'thinking', activity: 'Fixing' }));
    s = reduce(s, e('cycle_result', { milestoneId: 'm1', cycle, result: 'failed', failedCycles: cycle, reason: 'nope' }));
  }
  s = reduce(s, e('circuit_breaker', { milestoneId: 'm1', state: 'tripped', failedCycles: 3, maxFailedCycles: 3 }));
  s = reduce(s, e('agent_status', { agent: 'michael', status: 'blocked', activity: 'Needs a human!' }));
  s = reduce(s, e('hitl_request', { milestoneId: 'm1', reason: 'Stuck', options: ['feedback', 'retry', 'skip', 'abort'] }));
  assert.equal(humanNeeded(s), true);
  return { e, s };
}

function assertSettled(s, status) {
  assert.equal(s.status, status);
  assert.equal(s.breaker, 'closed');
  assert.equal(s.hitl, null);
  assert.equal(s.failedCycles, 0);
  assert.equal(humanNeeded(s), false);
  for (const id of ['michael', 'dwight', 'angela']) assert.notEqual(s.agents[id].status, 'blocked', `${id} still blocked`);
}

test('skip without a breaker reset: the pause ends on the answer, the breaker on the next milestone', () => {
  let { e, s } = trippedRun();
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'skip' }));
  assert.equal(s.status, 'running');
  assert.equal(humanNeeded(s), false);
  s = reduce(s, e('agent_status', { agent: 'michael', status: 'waiting', activity: 'Overseeing the run' }));
  s = reduce(s, e('milestone_finished', { milestoneId: 'm1', status: 'skipped' }));
  assert.equal(s.breaker, 'closed', 'the tripped milestone is over');
  assert.equal(s.failedCycles, 0);
  s = reduce(s, e('milestone_started', { milestoneId: 'm2', index: 1, total: 2, title: 'Two' }));
  assert.equal(s.breaker, 'closed');
  s = reduce(s, e('cycle_result', { milestoneId: 'm2', cycle: 1, result: 'passed', failedCycles: 0, reason: 'ok' }));
  s = reduce(s, e('milestone_finished', { milestoneId: 'm2', status: 'passed' }));
  s = reduce(s, e('run_finished', { status: 'partial', summary: '1 passed, 1 skipped' }));
  assertSettled(s, 'finished');
  assert.deepEqual(s.milestones.map((m) => m.status), ['skipped', 'passed']);
});

test('skip with a breaker reset ends in the same settled state', () => {
  let { e, s } = trippedRun();
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'skip' }));
  s = reduce(s, e('circuit_breaker', { milestoneId: 'm1', state: 'reset', failedCycles: 0, maxFailedCycles: 3 }));
  assert.equal(s.breaker, 'closed');
  assert.equal(s.status, 'running');
  s = reduce(s, e('milestone_finished', { milestoneId: 'm1', status: 'skipped' }));
  s = reduce(s, e('milestone_started', { milestoneId: 'm2', index: 1, total: 2, title: 'Two' }));
  s = reduce(s, e('milestone_finished', { milestoneId: 'm2', status: 'passed' }));
  s = reduce(s, e('run_finished', { status: 'partial', summary: '1 passed, 1 skipped' }));
  assertSettled(s, 'finished');
});

test('a milestone_started of another milestone closes a breaker nobody reset', () => {
  let { e, s } = trippedRun();
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'skip' }));
  s = reduce(s, e('milestone_started', { milestoneId: 'm2', index: 1, total: 2, title: 'Two' }));
  assert.equal(s.breaker, 'closed');
  assert.equal(s.status, 'running');
  assert.equal(s.failedCycles, 0);
});

test('run_finished alone clears a tripped breaker and an open human request', () => {
  let { e, s } = trippedRun();
  s = reduce(s, e('run_finished', { status: 'aborted', summary: 'Ctrl+C' }));
  assertSettled(s, 'aborted');
  const { e: e2, s: s2 } = trippedRun();
  const done = reduce(reduce(s2, e2('hitl_response', { milestoneId: 'm1', decision: 'abort' })), e2('run_finished', { status: 'aborted', summary: 'Gave up' }));
  assertSettled(done, 'aborted');
});

test('an abort answer ends the pause before run_finished arrives', () => {
  let { e, s } = trippedRun();
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'abort' }));
  assert.notEqual(s.status, 'paused');
  assert.equal(humanNeeded(s), false);
});

test('a [BLOCKED] / infra pause without any circuit_breaker event', () => {
  const { e, state } = startedRun();
  let s = reduce(state, e('agent_status', { agent: 'dwight', status: 'error', activity: 'pi exited with code 1' }));
  s = reduce(s, e('log', { level: 'error', message: 'pi exited with code 1' }));
  s = reduce(s, e('agent_status', { agent: 'michael', status: 'blocked', activity: 'Needs a human!' }));
  s = reduce(s, e('hitl_request', { milestoneId: 'm1', reason: 'Dwight failed to run', options: ['retry', 'skip', 'abort'] }));
  assert.equal(s.status, 'paused');
  assert.equal(s.breaker, 'closed');
  assert.equal(humanNeeded(s), true);
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'retry' }));
  assert.equal(s.status, 'running');
  assert.equal(humanNeeded(s), false);
  s = reduce(s, e('hitl_request', { milestoneId: 'm1', reason: 'Angela reported [BLOCKED]', options: ['retry', 'skip', 'abort'] }));
  assert.equal(humanNeeded(s), true);
  s = reduce(s, e('hitl_response', { milestoneId: 'm1', decision: 'abort' }));
  assert.equal(s.status, 'running', 'aborting, no longer waiting for the human');
  assert.equal(humanNeeded(s), false);
  s = reduce(s, e('milestone_finished', { milestoneId: 'm1', status: 'aborted' }));
  s = reduce(s, e('run_finished', { status: 'aborted', summary: 'Aborted by the human' }));
  assertSettled(s, 'aborted');
  assert.equal(s.agents.dwight.status, 'error', 'a real failure stays visible on its card');
});

test('bidi controls in event text never reach the view model', () => {
  const RLO = '\u202E';
  const { e, state } = startedRun();
  let s = reduce(state, e('plan_ready', { milestones: [{ id: 'm1', title: `Fix ${RLO}gnp.exe`, description: `d\u2066x\u2069`, acceptanceCriteria: [`a\u200Fb`] }] }));
  s = reduce(s, e('hive_write', { from: 'dwight', to: 'angela', file: 'angela/inbox.md', kind: 'handoff', summary: `Done ${RLO}fdp.exe` }));
  s = reduce(s, e('agent_status', { agent: 'angela', status: 'working', activity: `Running \u202Bnpm test` }));
  s = reduce(s, e('agent_tool', { agent: 'angela', tool: `ba\u200Esh`, detail: `cat ${RLO}txt.js` }));
  s = reduce(s, e('agent_finished', { agent: 'angela', milestoneId: 'm1', cycle: 1, keyword: `TEST${RLO}_PASSED`, exitCode: 0, durationMs: 1 }));
  s = reduce(s, e('hitl_request', { milestoneId: 'm1', reason: `Stuck ${RLO}here`, options: [`re\u2067try`] }));
  s = reduce(s, e('log', { level: 'warn', message: `model said \u202Aodd\u202C` }));
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/u);
  assert.equal(s.milestones[0].title, 'Fix gnp.exe');
  assert.equal(s.mailboxes.angela.summary, 'Done fdp.exe');
  assert.equal(s.agents.angela.lastTool.detail, 'cat txt.js');
  assert.equal(s.agents.angela.lastKeyword, 'TEST_PASSED');
  assert.deepEqual(s.hitl.options, ['retry']);
  assert.equal(s.log.at(-1).text, 'model said odd');
  // a bidi control in the runId does not split one run into two
  const sneaky = reduce(s, { ...e('log', { level: 'info', message: 'x' }), runId: `r1${RLO}` });
  assert.equal(sneaky.runId, 'r1');
  assert.equal(sneaky.milestones.length, 1);
});

test('the log line of agent_finished uses the shared duration format', () => {
  const { e, state } = startedRun();
  const s = reduce(state, e('agent_finished', { agent: 'dwight', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 323_000 }));
  assert.equal(s.log.at(-1).text, 'TASK_COMPLETE - exit 0, 5m 23s');
});

test('the event log keeps only the last LOG_SIZE entries', () => {
  const { e, state } = startedRun();
  let s = state;
  for (let i = 0; i < LOG_SIZE + 20; i += 1) s = reduce(s, e('log', { level: 'info', message: `line ${i}` }));
  assert.equal(s.log.length, LOG_SIZE);
  assert.equal(s.log.at(-1).text, `line ${LOG_SIZE + 19}`);
});

test('parseJsonl skips invalid and partial lines', () => {
  const text = '{"a":1}\n\nnot json\n{"b":2}\n{"c":';
  assert.deepEqual(parseJsonl(text), [{ a: 1 }, { b: 2 }]);
});

test('the serial recording follows the contract and reduces to a finished success', () => {
  const events = parseJsonl(readFileSync(SAMPLE, 'utf8'));
  assert.ok(events.length >= 80 && events.length <= 150, `${events.length} events`);
  const runIds = new Set(events.map((ev) => ev.runId));
  assert.equal(runIds.size, 1);
  events.forEach((ev, i) => {
    assert.equal(ev.v, 1);
    assert.equal(ev.seq, i + 1);
    assert.ok(!Number.isNaN(Date.parse(ev.ts)));
    if (i > 0) assert.ok(Date.parse(ev.ts) >= Date.parse(events[i - 1].ts), `ts order at seq ${ev.seq}`);
    if (ev.type === 'hive_write') assert.ok(ev.summary.length <= 140, `summary too long at seq ${ev.seq}`);
    if (ev.type === 'agent_tool') assert.ok(ev.detail.length <= 140);
  });
  assert.equal(events[0].type, 'run_started');
  assert.equal(events.at(-1).type, 'run_finished');
  const types = events.map((ev) => ev.type);
  assert.equal(types.filter((t) => t === 'circuit_breaker').length, 2);
  assert.ok(types.includes('hitl_request') && types.includes('hitl_response'));
  const bugReports = events.filter((ev) => ev.type === 'hive_write' && ev.kind === 'bug_report');
  assert.deepEqual(bugReports.map((ev) => ev.to), ['dwight', 'dwight', 'dwight']);
  assert.ok(events.some((ev) => ev.type === 'hive_write' && ev.from === 'human' && ev.to === 'dwight' && ev.kind === 'feedback'));

  const s = reduceAll(events);
  assert.equal(s.status, 'finished');
  assert.equal(s.result, 'success');
  assert.equal(s.breaker, 'closed');
  assert.equal(s.hitl, null);
  assert.deepEqual(s.milestones.map((m) => m.status), ['passed', 'passed', 'passed']);
  // like state.json since parallel runs: an ended run has no current milestone
  assert.equal(s.currentMilestoneId, null);
  assert.equal(s.cycle, 4);
  assert.equal(s.lastSeq, events.length);
  for (const id of ['michael', 'dwight', 'angela']) assert.equal(s.agents[id].status, 'done');
  assert.deepEqual(s.milestones.map((m) => m.cycles), [1, 2, 4]);
  assert.ok(s.finishedAt && Date.parse(s.finishedAt) > Date.parse(s.startedAt));
  const t = totals(s);
  const usage = events.filter((ev) => ev.type === 'agent_finished');
  assert.equal(t.runs, usage.length);
  assert.equal(t.tokens, usage.reduce((n, ev) => n + ev.usage.input + ev.usage.output, 0));
  assert.ok(Math.abs(t.cost - usage.reduce((n, ev) => n + ev.usage.cost, 0)) < 1e-9);
  // agents run one at a time here, so at every point their summed time fits inside the elapsed run time
  let agentMs = 0;
  for (const ev of events.filter((x) => x.type === 'agent_finished')) {
    agentMs += ev.durationMs;
    const elapsed = Date.parse(ev.ts) - Date.parse(events[0].ts);
    assert.ok(ev.durationMs > 0 && agentMs <= elapsed, `seq ${ev.seq}: agent time ${agentMs} > elapsed ${elapsed}`);
  }
  assert.equal(s.mailboxes.human.kind, 'hitl');
  assert.equal(s.mailboxes.human.read, true);

  // reducing the sample twice (a reconnect replay) changes nothing
  assert.equal(reduceAll(events, s), s);
});

test('the breaker trips in the serial recording exactly after the third failed cycle of m3', () => {
  const events = parseJsonl(readFileSync(SAMPLE, 'utf8'));
  const trip = events.findIndex((ev) => ev.type === 'circuit_breaker' && ev.state === 'tripped');
  const s = reduceAll(events.slice(0, trip + 1));
  assert.equal(s.currentMilestoneId, 'm3');
  assert.equal(s.failedCycles, 3);
  assert.equal(s.breaker, 'tripped');
  assert.equal(s.status, 'paused');
  assert.deepEqual(s.milestones.map((m) => m.status), ['passed', 'passed', 'active']);
});
