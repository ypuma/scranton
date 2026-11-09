import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDashboard } from '../../src/dashboard/index.js';
import { createHiveSource } from '../../src/dashboard/source.js';
import { stripAnsi, visibleWidth } from '../../src/dashboard/text.js';

const T0 = Date.parse('2026-11-08T12:00:00.000Z');
const ts = (s) => new Date(T0 + s * 1000).toISOString();

// The shape src/core/state.js writes for a parallel run (instances, activeMilestoneIds, chat).
function parallelState(over = {}) {
  return {
    v: 1, runId: 'run-20261108-120000-ab12', status: 'running', request: 'Build a tiny todo CLI', workspace: 'C:\\ws',
    updatedAt: ts(60), lastSeq: 40,
    milestones: [
      { id: 'm1', title: 'Todo storage module', dependsOn: [], status: 'active', cycle: 1, failedCycles: 0 },
      { id: 'm2', title: 'Command line interface', dependsOn: [], status: 'active', cycle: 2, failedCycles: 1 },
      { id: 'm3', title: 'Tests and README', dependsOn: ['m1', 'm2'], status: 'pending', cycle: 0, failedCycles: 0 },
    ],
    currentMilestoneId: 'm1', activeMilestoneIds: ['m1', 'm2'],
    instances: {
      michael: { id: 'michael', agent: 'michael', milestoneId: null, sessionId: '7d2d2f61-c282-41e1-a931-58fec062a8d1', worktree: 'C:\\hive\\isolation\\michael-plan', sandbox: 'docker', status: 'done', tool: null, activity: 'Idle' },
      'dwight-m1': { id: 'dwight-m1', agent: 'dwight', milestoneId: 'm1', sessionId: '0ccce64c-15a5-4ec5-8afe-0803c3a14b51', worktree: 'C:\\hive\\isolation\\dwight-m1', sandbox: 'docker', status: 'working', tool: 'write', activity: 'Writing todo.js' },
      'dwight-m2': { id: 'dwight-m2', agent: 'dwight', milestoneId: 'm2', sessionId: 'a7ffc7c7-d628-457d-a6c4-da0ad92ffc23', worktree: 'C:\\hive\\isolation\\dwight-m2', sandbox: 'host', status: 'thinking', tool: null, activity: 'Reading bug report...' },
      'angela-m2': { id: 'angela-m2', agent: 'angela', milestoneId: 'm2', sessionId: '4b505760-7b4c-457c-bc38-20d07b7f656f', worktree: 'C:\\hive\\isolation\\angela-m2', sandbox: 'docker', status: 'waiting', tool: null, activity: 'Waiting for dwight-m2' },
    },
    chat: [
      { id: 'c1', from: 'dwight-m1', to: 'dwight-m2', text: 'I export load() and save() from todo.js', delivery: 'delivered', ts: ts(40) },
      { id: 'c2', from: 'human', to: 'dwight-m2', text: 'Keep the CLI flags short', delivery: 'queued', ts: ts(55) },
    ],
    execution: { maxParallel: 3, isolation: 'worktree', sandbox: { mode: 'docker', image: 'scranton-sandbox:1.5.0-r2', network: 'bridge' } },
    cycle: 1, failedCycles: 0, maxFailedCycles: 3, breaker: 'closed',
    agents: {
      michael: { status: 'waiting', activity: 'Overseeing m1', lastKeyword: 'PLAN_READY', updatedAt: ts(10), totals: { runs: 1, input: 1932, output: 407, cost: 0.006 } },
      // the last lane to write left the role aggregate idle; the box must still show the working lane
      dwight: { status: 'idle', activity: 'Idle', lastKeyword: 'TASK_COMPLETE', updatedAt: ts(50), totals: { runs: 2, input: 8000, output: 1400, cost: 0.024 } },
      angela: { status: 'waiting', activity: 'Waiting for dwight-m2', lastKeyword: 'TEST_FAILED', updatedAt: ts(45), totals: { runs: 1, input: 4100, output: 1000, cost: 0.012 } },
    },
    ...over,
  };
}

function events() {
  let seq = 0;
  const e = (s, type, f) => ({ v: 1, seq: ++seq, ts: ts(s), runId: 'run-20261108-120000-ab12', type, ...f });
  return [
    e(0, 'run_started', { request: 'Build a tiny todo CLI', workspace: 'C:\\ws', maxFailedCycles: 3 }),
    e(5, 'instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1', worktree: 'C:\\hive\\x', sandbox: 'docker' }),
    e(6, 'instance_started', { id: 'dwight-m2', instanceId: 'dwight-m2', agent: 'dwight', milestoneId: 'm2', worktree: 'C:\\hive\\y', sandbox: 'host' }),
    e(30, 'agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'write', detail: 'todo.js' }),
    e(40, 'chat_message', { id: 'c1', from: 'dwight-m1', to: 'dwight-m2', text: 'I export load()', delivery: 'queued' }),
    e(41, 'chat_delivery', { id: 'c1', delivery: 'delivered' }),
    e(42, 'milestone_integrated', { milestoneId: 'm0' }),
    e(50, 'agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'thinking', activity: 'Reading bug report...' }),
  ];
}

const render = (state, opts = {}) => renderDashboard(state, events(), { width: 120, height: 40, color: false, now: T0 + 61000, ...opts });

test('parallel run: lanes, parallel milestones and the message summary', () => {
  const out = render(parallelState());
  for (const text of [
    'Milestones 2 in parallel: m1 Todo storage module · m2 Command line interface',
    'Lanes  3 live, 1 done', 'dwight-m1', 'WORKING', 'Writing todo.js  write', 'm1 · worktree · docker · 0ccce64c',
    'dwight-m2', 'THINKING', 'm2 · worktree · host · a7ffc7c7', 'angela-m2', 'WAITING',
    'Messages  2, 1 queued', 'dwight-m1 -> dwight-m2  delivered  I export load() and save() from todo.js',
    'human -> dwight-m2  queued  Keep the CLI flags short',
    'dwight-m1  started  m1  worktree  docker', 'dwight-m2  started  m2  worktree  host',
    'dwight-m1  write  todo.js', 'message c1  delivered', 'milestone m0 integrated', 'dwight-m2  thinking  Reading bug report...',
  ]) assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);
  // the finished planner lane is counted but takes no row while live lanes need them
  assert.doesNotMatch(out, /^ . michael +DONE/m);
});

test('a role box follows its busiest live lane, not the stale aggregate', () => {
  const out = render(parallelState());
  const box = out.split('\n').find((l) => l.includes('2 lanes: dwight-m1, dwight-m2'));
  assert.ok(box, out);
  assert.ok(out.includes('● WORKING'), 'DWIGHT box shows the working lane');
  // without instances the aggregate is shown as before
  const legacy = render(parallelState({ instances: {}, activeMilestoneIds: [], chat: [] }));
  assert.doesNotMatch(legacy, /Lanes|Messages {2}/);
  assert.ok(legacy.includes('Milestone 1/3: Todo storage module'));
});

test('dependency outcomes: a blocked milestone is counted in the ended outcome', () => {
  const st = parallelState({
    status: 'finished', activeMilestoneIds: [], currentMilestoneId: null,
    milestones: [
      { id: 'm1', title: 'A', dependsOn: [], status: 'passed' },
      { id: 'm2', title: 'B', dependsOn: [], status: 'skipped' },
      { id: 'm3', title: 'C', dependsOn: ['m2'], status: 'blocked' },
    ],
    instances: { 'dwight-m1': { id: 'dwight-m1', agent: 'dwight', milestoneId: 'm1', status: 'done', activity: 'Done' } },
    chat: [],
  });
  const out = render(st);
  assert.ok(out.includes('1/3 milestones passed · 1 skipped · 1 blocked'), out);
  assert.ok(out.includes('■ C'), 'blocked milestone glyph');
  assert.ok(out.includes('Lanes  0 live, 1 done'));
});

test('size, ASCII and colour invariants hold with lanes and messages at every size', () => {
  const st = parallelState();
  for (const width of [24, 39, 40, 59, 60, 80, 100, 120, 160]) {
    for (const height of [8, 12, 24, 40]) {
      for (const color of [false, true]) {
        for (const ascii of [false, true]) {
          const raw = render(st, { width, height, color, ascii });
          const lines = raw.split('\n');
          assert.equal(lines.length, height, `${width}x${height} color=${color} ascii=${ascii}`);
          for (const l of lines) assert.ok(visibleWidth(l) <= width, `${width}x${height}: ${visibleWidth(l)} > ${width}\n${stripAnsi(l)}`);
          if (ascii) assert.match(raw, /^[\x00-\x7f]*$/, `${width}x${height} color=${color}: non-ASCII in ascii mode`);
          if (!color) assert.doesNotMatch(raw, /\x1b/, `${width}x${height} ascii=${ascii}: escape without colour`);
        }
      }
    }
  }
});

test('the event log keeps rows: lanes and messages give way on short screens', () => {
  const out = render(parallelState(), { height: 24 });
  assert.ok(out.includes('Event log'), out);
  const lines = out.split('\n');
  const log = lines.findIndex((l) => l.includes('Event log'));
  assert.ok(lines.length - log - 2 >= 3, `only ${lines.length - log - 2} log rows\n${out}`);
  // at narrow widths the message summary is left out instead of being cut to nothing
  assert.doesNotMatch(render(parallelState(), { width: 50 }), /Messages {2}2/);
});

test('parallel fixture (the recorded RPC demo, cut mid-run) renders lanes, both pipelines and the delivered human message', async () => {
  const source = createHiveSource(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'parallel'));
  await source.poll();
  const { state, events } = source;
  assert.deepEqual(state.activeMilestoneIds, ['m1', 'm2']);
  const out = renderDashboard(state, events, { width: 120, height: 40, color: false, now: Date.parse(state.updatedAt) + 2000 });
  for (const text of [
    '[RUNNING]', 'Milestones 2 in parallel: m1 Todo storage module · m2 Command line interface', 'Lanes  2 live, 1 done',
    'm1 · worktree · host', 'm2 · worktree · host', 'Messages  1', 'human -> dwight-m2  delivered  Keep the commands short: add, list and done.',
    'Overseeing m2: Command line interface', '2 lanes: dwight-m1, dwight-m2',
  ]) assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);
});

test('hostile instance and chat text is sanitised', () => {
  const st = parallelState({
    instances: { 'dwight-m1': { id: 'dwight-m1\x1b[31m', agent: 'dwight', milestoneId: 'm1', status: 'working', activity: 'a\u202Eb\nc', sandbox: { mode: 'docker' } } },
    chat: [{ id: 'x', from: 'dwight-m1', to: 'human\x07', text: '\x1b]0;pwned\x07evil\u2066 text', delivery: 'rejected', reason: 'Unknown recipient' }],
  });
  const raw = render(st, { color: false });
  assert.doesNotMatch(raw, /[\x07\x1b\u202E\u2066]/);
  assert.ok(raw.includes('rejected  Unknown recipient: evil text'), raw);
  assert.ok(raw.includes('ab c'));
});
