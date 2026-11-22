// The terminal dashboard on what the real orchestrator and its state.json reducer produce in parallel RPC runs
// (scripted LLM in project scratch): role boxes with role-only statuses, lanes, messages and worktree metadata.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scratchDir, createRun, capture, until, spoolChat, readEvents } from '../visualizer/fixtures/real-orchestrator.js';
import { initialState, reduce } from '../../src/core/state.js';
import { renderDashboard } from '../../src/dashboard/index.js';

const runs = {};
const dirs = [];
const scratch = () => {
  const dir = scratchDir();
  dirs.push(dir);
  return dir;
};

after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

before(async () => {
  {
    let calls = 0;
    const { orchestrator, hive } = createRun(scratch(), {
      env: { SCRANTON_FAKE_FAIL: 'exit1', SCRANTON_FAKE_FAIL_ROLE: 'michael' },
      hitl: async () => (++calls === 1 ? { decision: 'retry' } : { decision: 'skip' }),
    });
    runs.planner = { result: await orchestrator.run('Build a tiny todo CLI'), events: readEvents(hive) };
  }
  {
    const { orchestrator, hive } = createRun(scratch(), { env: { SCRIPTED_MODE: 'hang' } });
    const running = orchestrator.run('Build a tiny todo CLI');
    await until(() => orchestrator.active.has('dwight-m1') && orchestrator.active.has('dwight-m2'));
    const id = spoolChat(hive, readEvents(hive)[0].runId, 'dwight-m2', 'Keep the CLI flags short');
    await until(() => readEvents(hive).some((e) => e.type === 'chat_delivery' && e.id === id));
    runs.parallel = capture(hive);
    orchestrator.abort('test over');
    await running;
  }
  {
    const { orchestrator, hive, config } = createRun(scratch(), { maxParallel: 1 });
    config.execution.isolation = 'shared';
    await orchestrator.run('Build a tiny todo CLI');
    runs.shared = capture(hive);
  }
});

const fold = (events) => events.reduce(reduce, initialState());
const at = (events) => Date.parse(events.at(-1).ts) + 1000;
// compact panels put each role on one line: "<glyph> MICHAEL  <STATUS>  <activity>"
function roleLine(events, role, state = fold(events)) {
  // a short screen keeps the panels compact
  const out = renderDashboard(state, events, { width: 90, height: 12, color: false, now: at(events) });
  const line = out.split('\n').find((l) => new RegExp(`^ \\S+ ${role.toUpperCase()} `).test(l));
  assert.ok(line, out);
  return line;
}

test('every role-only status of the real run is what the MICHAEL box shows, even over an error lane', () => {
  const { events, result } = runs.planner;
  assert.equal(result.status, 'success', result.summary);
  let checked = 0;
  events.forEach((e, i) => {
    if (e.type !== 'agent_status' || e.instanceId) return;
    const prefix = events.slice(0, i + 1);
    const line = roleLine(prefix, e.agent);
    assert.match(line, new RegExp(`${e.agent.toUpperCase()} +${e.status.toUpperCase()}\\b`), `after seq ${e.seq}: ${line}`);
    checked += 1;
  });
  assert.ok(checked >= 6, `${checked} role-only statuses`);
  const ask = events.findIndex((e) => e.type === 'hitl_request');
  const st = fold(events.slice(0, ask + 1));
  assert.equal(st.instances.michael.status, 'error');
  assert.match(roleLine(events.slice(0, ask + 1), 'michael'), /MICHAEL +BLOCKED +Needs a human!/);
});

test('mid-run: MICHAEL waits while the planner lane is done or (older producers) idle', () => {
  const { events, state } = runs.parallel;
  assert.equal(state.instances.michael.status, 'done');
  assert.match(roleLine(events, 'michael', state), /MICHAEL +WAITING +Overseeing m2/);
  const older = events.filter((e) => !(e.type === 'agent_status' && e.instanceId === 'michael' && e.status === 'done'));
  assert.equal(fold(older).instances.michael.status, 'idle');
  assert.match(roleLine(older, 'michael'), /MICHAEL +WAITING +Overseeing m2/);
  assert.match(roleLine(events, 'dwight', state), /DWIGHT +(THINKING|WORKING) +2 lanes: dwight-m1, dwight-m2/);
});

test('lanes, worktrees and messages of the real parallel run', () => {
  const { events, state } = runs.parallel;
  const out = renderDashboard(state, events, { width: 120, height: 40, color: false, now: at(events) });
  for (const text of ['Lanes  2 live, 1 done', 'dwight-m1', 'm1 · worktree · host', 'm2 · worktree · host', 'Messages  1',
    'human -> dwight-m2  delivered  Keep the CLI flags short', 'dwight-m1  started  m1  worktree  host']) {
    assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);
  }
});

test('a shared trusted-host run shows no worktree anywhere, and neither does the workspace named as one', () => {
  const { events, state } = runs.shared;
  assert.ok(Object.values(state.instances).every((i) => i.worktree === null));
  const out = renderDashboard(state, events, { width: 120, height: 60, color: false, now: at(events) });
  assert.ok(out.includes('started'), out);
  assert.doesNotMatch(out, /worktree/);
  const named = structuredClone(state);
  for (const i of Object.values(named.instances)) i.worktree = `${state.workspace.toLowerCase()}/`;
  named.status = 'running';
  for (const i of Object.values(named.instances)) i.status = 'thinking';
  assert.doesNotMatch(renderDashboard(named, [], { width: 120, height: 40, color: false, now: at(events) }), /worktree/);
});

test('unknown deliveries and refused chat commands are shown for what they are', () => {
  const { events, state } = runs.parallel;
  const st = structuredClone(state);
  st.chat.push({ id: 'u1', ts: st.updatedAt, from: 'dwight-m1', to: 'angela-m1', text: 'ping', delivery: 'unknown' });
  const extra = [
    { v: 1, seq: 900, ts: st.updatedAt, runId: st.runId, type: 'chat_delivery', id: 'u1', delivery: 'unknown', reason: 'steer ACK timed out' },
    { v: 1, seq: 901, ts: st.updatedAt, runId: st.runId, type: 'chat_command_rejected', delivery: 'rejected', reason: 'Stale chat command' },
  ];
  const out = renderDashboard(st, [...events, ...extra], { width: 120, height: 40, color: false, now: at(events) });
  for (const text of ['Messages  2, 1 unknown', 'dwight-m1 -> angela-m1  unknown  ping', 'message u1  unknown  not resent automatically  steer ACK timed out',
    'chat command rejected  Stale chat command']) {
    assert.ok(out.includes(text), `missing ${JSON.stringify(text)}\n${out}`);
  }
});
