// The offline demo (visualizer/public/demo/sample-events.jsonl) is a normalized recording of a real parallel
// RPC run against the scripted pi (fixtures/record-demo.js). It must keep showing lanes, dependencies and chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reduceAll, parseJsonl, lanesOf, roleView, dependencyState, totals, activeRoles } from '../../visualizer/public/js/state.js';
import { executionBadges, laneBadges } from '../../visualizer/public/js/lanes.js';
import { demoDelays } from '../../visualizer/public/js/feed.js';

const SAMPLE = fileURLToPath(new URL('../../visualizer/public/demo/sample-events.jsonl', import.meta.url));
const text = readFileSync(SAMPLE, 'utf8');
const events = parseJsonl(text);

test('the demo recording follows the contract and holds no machine path', () => {
  assert.ok(events.length >= 120 && events.length <= 260, `${events.length} events`);
  events.forEach((e, i) => {
    assert.equal(e.v, 1);
    assert.equal(e.seq, i + 1);
    assert.equal(e.runId, events[0].runId);
    if (i) assert.ok(Date.parse(e.ts) >= Date.parse(events[i - 1].ts), `ts order at ${e.seq}`);
  });
  assert.doesNotMatch(text, /Users|pumas|scratch|AppData/i);
  assert.equal(events[0].type, 'run_started');
  assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(events.at(-1).status, 'success');
});

test('the demo shows parallel pipelines, a dependency, instance lanes and chat', () => {
  const at = (pred) => events.findIndex(pred);
  // m1 and m2 overlap; m3 starts only after both were integrated
  assert.ok(at((e) => e.type === 'milestone_started' && e.milestoneId === 'm2') < at((e) => e.type === 'milestone_finished' && e.milestoneId === 'm1'));
  const m3 = at((e) => e.type === 'milestone_started' && e.milestoneId === 'm3');
  for (const id of ['m1', 'm2']) assert.ok(at((e) => e.type === 'milestone_integrated' && e.milestoneId === id) < m3);
  const mid = reduceAll(events.slice(0, at((e) => e.type === 'agent_tool' && e.instanceId === 'dwight-m2') + 1));
  assert.deepEqual(mid.activeMilestoneIds, ['m1', 'm2']);
  assert.equal(roleView(mid, 'dwight').busy, 2);
  assert.equal(roleView(mid, 'michael').status, 'waiting');
  assert.deepEqual(dependencyState(mid, mid.milestones[2]), { kind: 'waiting', on: ['m1', 'm2'] });
  const chat = events.filter((e) => e.type === 'chat_message');
  assert.deepEqual(chat.map((e) => [e.from, e.to]), [['human', 'dwight-m2'], ['dwight-m1', 'dwight-m2']]);
  for (const c of chat) assert.ok(events.some((e) => e.type === 'chat_delivery' && e.id === c.id && e.delivery === 'delivered'));
  assert.ok(events.some((e) => e.type === 'circuit_breaker' && e.state === 'tripped'));
  assert.ok(events.some((e) => e.type === 'hitl_response' && e.decision === 'feedback'));
});

test('the demo ends as a finished success with every lane done and honest execution badges', () => {
  const s = reduceAll(events);
  assert.equal(s.status, 'finished');
  assert.deepEqual(s.milestones.map((m) => [m.id, m.status]), [['m1', 'passed'], ['m2', 'passed'], ['m3', 'passed']]);
  assert.deepEqual(lanesOf(s).map((i) => i.id), ['michael', 'dwight-m1', 'angela-m1', 'dwight-m2', 'angela-m2', 'dwight-m3', 'angela-m3']);
  assert.ok(lanesOf(s).every((i) => i.status === 'done' && i.worktree?.mode === 'worktree'));
  // the 3-agent recording predates the gates: its run uses the tests alone
  assert.deepEqual(activeRoles(s), ['michael', 'dwight', 'angela']);
  for (const id of activeRoles(s)) assert.equal(s.agents[id].status, 'done');
  assert.equal(s.execution.simulated, true);
  assert.ok(executionBadges(s.execution).some(([t]) => t === 'simulated'));
  assert.ok(laneBadges(s.instances['dwight-m1'], { simulated: true }).some(([t]) => t === 'simulated'));
  assert.ok(totals(s).tokens > 0);
  assert.equal(s.chat.length, 2);
  // replays at a readable pace
  const total = demoDelays(events).reduce((a, b) => a + b, 0);
  assert.ok(total >= 60_000 && total <= 90_000, `${total} ms`);
});
