const TS = '2026-11-09T12:00:00.000Z';
const IDS = ['michael', 'dwight', 'oscar', 'hank', 'angela'];

export function roleFixture(kind = 'parallel') {
  const gates = kind === 'passed' ? [['hank'], ['oscar'], ['angela']] : [['oscar', 'hank'], ['angela']];
  const agents = Object.fromEntries(IDS.map((id) => [id, {
    status: 'waiting', activity: 'Waiting for stage', lastKeyword: null, updatedAt: TS,
    totals: { runs: 0, input: 0, output: 0, cost: 0 },
  }]));
  agents.michael = { ...agents.michael, status: 'done', activity: 'Plan ready', lastKeyword: 'PLAN_READY' };
  agents.dwight = { ...agents.dwight, status: 'idle', activity: 'Snapshot ready', lastKeyword: 'TASK_COMPLETE' };
  const state = {
    v: 1, runId: 'roles-run', status: 'running', request: 'Review and audit the storage module', workspace: 'C:\\workspace',
    updatedAt: TS, lastSeq: 20, currentMilestoneId: 'm1', activeMilestoneIds: ['m1'],
    cycle: 2, failedCycles: 0, maxFailedCycles: 3, breaker: 'closed',
    milestones: [{ id: 'm1', title: 'Storage module', status: 'active', cycle: 2, failedCycles: 0 }],
    execution: { workflow: { gates } }, agents, instances: {}, chat: [],
  };
  let seq = 0;
  const event = (type, fields = {}) => ({ v: 1, seq: ++seq, runId: state.runId, ts: TS, type, ...fields });
  const events = [event('run_started', { execution: { workflow: { gates } } })];
  const result = (agent, stage, keyword, outcome = 'passed', cycle = 2) => events.push(event('gate_result', {
    agent, stage, keyword, result: outcome, milestoneId: 'm1', instanceId: `${agent}-m1`, cycle,
  }));
  if (kind === 'legacy') {
    delete state.execution;
    delete events[0].execution;
    state.agents = Object.fromEntries(['michael', 'dwight', 'angela'].map((id) => [id, agents[id]]));
  } else if (kind === 'passed') {
    result('hank', 0, 'SECURITY_PASSED');
    result('oscar', 1, 'REVIEW_APPROVED');
    result('angela', 2, 'TEST_PASSED');
    state.status = 'finished';
    state.currentMilestoneId = null;
    state.activeMilestoneIds = [];
    state.milestones[0].status = 'passed';
    for (const a of Object.values(agents)) { a.status = 'done'; a.activity = 'Done'; }
    events.push(event('run_finished', { status: 'success', summary: 'All three stages passed' }));
  } else if (kind === 'failed') {
    result('oscar', 0, 'CHANGES_REQUESTED', 'failed');
    result('hank', 0, 'SECURITY_ISSUES', 'failed');
    state.failedCycles = state.milestones[0].failedCycles = 1;
    events.push(event('cycle_result', { milestoneId: 'm1', cycle: 2, result: 'failed', failedCycles: 1,
      reason: 'Stage 1 failed: Oscar [CHANGES_REQUESTED], Hank [SECURITY_ISSUES]' }));
  } else {
    result('oscar', 0, 'CHANGES_REQUESTED', 'failed', 1);
    for (const agent of ['oscar', 'hank']) {
      agents[agent].status = 'working';
      state.instances[`${agent}-m1`] = { id: `${agent}-m1`, agent, milestoneId: 'm1', status: 'working',
        activity: agent === 'oscar' ? 'Reviewing storage' : 'Auditing storage', worktree: `C:\\isolated\\${agent}-m1`, sandbox: 'docker' };
    }
    result('oscar', 0, 'REVIEW_APPROVED');
    // Oscar settled while Hank is still running in the same parallel stage.
    state.instances['oscar-m1'].status = 'idle';
    agents.oscar.status = 'idle';
    events.push(event('agent_tool', { agent: 'hank', instanceId: 'hank-m1', tool: 'read', detail: 'src/storage.js' }));
  }
  return { state, events, now: Date.parse(TS) + 4000 };
}
