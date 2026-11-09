// Five roles and gate stages (.enma/roles-contract.md): the reducer reads run_started.execution.workflow and
// gate_result, and a run from before the gates looks exactly as it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AGENT_IDS, reduceAll, parseJsonl, roleOf, lanesOf, normalizeWorkflow, workflowOf, activeRoles, workflowText, gateView, describe,
} from '../../visualizer/public/js/state.js';

const SERIAL = parseJsonl(readFileSync(fileURLToPath(new URL('./fixtures/serial-events.jsonl', import.meta.url)), 'utf8'));
const GATES = [['oscar', 'hank'], ['angela']];

function maker(runId = 'r1') {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 9, 12, 0, seq)).toISOString(), runId, type, ...fields });
}

// a run with the given gates, planned and on its first milestone
function started(gates = GATES) {
  const e = maker();
  const events = [
    e('run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 3, execution: { maxParallel: 2, isolation: 'worktree', ...(gates ? { workflow: { gates } } : {}) } }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One', description: '', acceptanceCriteria: [] }] }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 1, title: 'One' }),
  ];
  return { e, events };
}

test('five roles in contract order; instances of the new roles have their own lanes', () => {
  assert.deepEqual(AGENT_IDS, ['michael', 'dwight', 'oscar', 'hank', 'angela']);
  assert.equal(roleOf('oscar-m1'), 'oscar');
  assert.equal(roleOf('hank-m2'), 'hank');
  const { e, events } = started();
  for (const id of ['angela-m1', 'hank-m1', 'oscar-m1', 'dwight-m1']) {
    events.push(e('instance_started', { instanceId: id, agent: roleOf(id), milestoneId: 'm1', sessionId: `s-${id}`, worktree: 'C:\\wt', sandbox: { mode: 'docker' } }));
  }
  const s = reduceAll(events);
  assert.deepEqual(lanesOf(s).map((i) => i.id), ['dwight-m1', 'oscar-m1', 'hank-m1', 'angela-m1'], 'developer, review, security, QA');
});

test('run_started.execution.workflow sets the gates; the summary reads in stage order', () => {
  const s = reduceAll(started().events);
  assert.deepEqual(s.workflow, { gates: GATES });
  assert.deepEqual(activeRoles(s), ['michael', 'dwight', 'oscar', 'hank', 'angela']);
  assert.equal(workflowText(workflowOf(s)), 'Review + Security \u2192 Tests');
  const one = reduceAll(started([['hank']]).events);
  assert.deepEqual(activeRoles(one), ['michael', 'dwight', 'hank']);
  assert.equal(workflowText(workflowOf(one)), 'Security');
  assert.equal(workflowText([['oscar'], ['hank'], ['angela']]), 'Review \u2192 Security \u2192 Tests');
});

test('normalizeWorkflow keeps known gate roles once each and drops empty stages', () => {
  assert.deepEqual(normalizeWorkflow({ gates: [['oscar', 'dwight', 'oscar'], [], ['angela', 'hank'], 'x', ['hank']] }), { gates: [['oscar'], ['angela', 'hank']] });
  assert.equal(normalizeWorkflow({ gates: [] }), null);
  assert.equal(normalizeWorkflow({ gates: [['michael']] }), null, 'not a gate role');
  assert.equal(normalizeWorkflow([['angela']]), null, 'the contract shape is { gates }');
  assert.equal(normalizeWorkflow(undefined), null);
});

test('an older run without a workflow shows Human, Michael, Dwight and Angela, as before', () => {
  const s = reduceAll(started(null).events);
  assert.equal(s.workflow, null);
  assert.deepEqual(workflowOf(s), [['angela']]);
  assert.deepEqual(activeRoles(s), ['michael', 'dwight', 'angela']);
  assert.equal(workflowText(workflowOf(s)), 'Tests');

  // the serial recording reduces as before: the new roles stay idle and nothing new reaches the log
  const serial = reduceAll(SERIAL);
  assert.equal(serial.status, 'finished');
  assert.equal(serial.workflow, null);
  assert.deepEqual(activeRoles(serial), ['michael', 'dwight', 'angela']);
  for (const id of ['oscar', 'hank']) {
    assert.equal(serial.agents[id].status, 'idle');
    assert.equal(serial.agents[id].totals.runs, 0);
  }
  assert.deepEqual(serial.gates, {});
  assert.equal(serial.log.some((l) => l.type === 'gate_result'), false);
  assert.equal(serial.applied, SERIAL.length);
});

test('gate_result: state per role, milestone and instance, and a results line in the log', () => {
  const { e, events } = started();
  events.push(
    e('instance_started', { instanceId: 'oscar-m1', agent: 'oscar', milestoneId: 'm1', sessionId: 's1' }),
    e('gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'oscar', instanceId: 'oscar-m1', result: 'failed', keyword: 'CHANGES_REQUESTED' }),
    e('gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'hank', instanceId: 'hank-m1', result: 'passed', keyword: 'SECURITY_PASSED' }),
  );
  const s = reduceAll(events);
  assert.equal(s.applied, events.length, 'gate_result is a known event type');
  assert.deepEqual([s.gates.oscar.result, s.gates.oscar.keyword, s.gates.oscar.cycle, s.gates.oscar.stage], ['failed', 'CHANGES_REQUESTED', 1, 0]);
  assert.equal(s.milestones[0].gates.hank.result, 'passed');
  assert.equal(s.instances['oscar-m1'].gate.result, 'failed');
  assert.equal(s.instances['hank-m1'], undefined, 'a gate_result never invents a lane');

  const lines = s.log.filter((l) => l.type === 'gate_result');
  assert.deepEqual(lines.map((l) => [l.category, l.tone, l.source]), [['results', 'bad', 'oscar-m1'], ['results', 'good', 'hank-m1']]);
  assert.equal(lines[0].text, 'Oscar gate failed: CHANGES_REQUESTED \u00b7 m1 \u00b7 cycle 1 \u00b7 stage 1');
  assert.equal(describe({ type: 'gate_result', agent: 'angela', result: 'blocked', keyword: null }).text, 'Angela gate blocked: no keyword');

  assert.deepEqual([gateView(s, 'oscar').label, gateView(s, 'hank').label], ['Changes requested', 'No security issues']);
  assert.equal(gateView(s, 'angela'), null, 'stage 2 was skipped');
});

test('gate_result: a result belongs to its cycle; the next developer turn clears it', () => {
  const { e, events } = started();
  events.push(e('gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'oscar', instanceId: 'oscar-m1', result: 'failed', keyword: 'CHANGES_REQUESTED' }));
  events.push(e('cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Oscar reported [CHANGES_REQUESTED]: x' }));
  assert.equal(gateView(reduceAll(events), 'oscar').result, 'failed', 'shown until Dwight picks the work up again');
  events.push(e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'thinking', activity: 'Fixing' }));
  const s = reduceAll(events);
  assert.equal(s.milestones[0].cycles, 2);
  assert.equal(gateView(s, 'oscar'), null);
  events.push(e('gate_result', { milestoneId: 'm1', cycle: 2, stage: 0, agent: 'oscar', instanceId: 'oscar-m1', result: 'passed', keyword: 'REVIEW_APPROVED' }));
  assert.equal(gateView(reduceAll(events), 'oscar').label, 'Approved');
});

test('gate_result: an unknown agent is ignored and an unknown result never reads as passed', () => {
  const { e, events } = started();
  events.push(e('gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'dwight', result: 'passed', keyword: 'TASK_COMPLETE' }));
  events.push(e('gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'hank', result: 'maybe', keyword: null }));
  const s = reduceAll(events);
  assert.equal(s.gates.dwight, undefined);
  assert.equal(s.gates.hank.result, 'error');
});

test('a fail keyword of the new gates reads as a failure in the log', () => {
  for (const keyword of ['CHANGES_REQUESTED', 'SECURITY_ISSUES', 'TEST_FAILED', 'BLOCKED']) {
    assert.equal(describe({ type: 'agent_finished', agent: 'oscar', keyword, exitCode: 0, durationMs: 1 }).tone, 'bad', keyword);
  }
  for (const keyword of ['REVIEW_APPROVED', 'SECURITY_PASSED']) {
    assert.equal(describe({ type: 'agent_finished', agent: 'hank', keyword, exitCode: 0, durationMs: 1 }).tone, 'good', keyword);
  }
});
