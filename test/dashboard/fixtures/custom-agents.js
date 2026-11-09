import { roleFixture } from './roles.js';

export function customFixture(kind = 'mid-stage') {
  const f = roleFixture();
  const roles = [
    ['michael', 'Michael', 'Planner', 'planner', true, 'PLAN_READY'],
    ['dwight', 'Dwight', 'Developer', 'developer', true, 'TASK_COMPLETE', 'BLOCKED'],
    ['oscar', 'Oscar', 'Code Reviewer', 'gate', true, 'REVIEW_APPROVED', 'CHANGES_REQUESTED'],
    ['seclint', 'SecLint', 'Static security', 'gate', false, 'SECLINT_CLEAN', 'SECLINT_DIRTY'],
    ['policy', 'Policy', 'Policy checks', 'gate', false, 'POLICY_CLEAN', 'POLICY_DIRTY'],
    ['angela', 'Angela', 'Quality Assurance', 'gate', true, 'TEST_PASSED', 'TEST_FAILED'],
  ].map(([id, name, title, roleKind, builtin, pass, fail]) => ({ id, name, title, kind: roleKind, builtin,
    keywords: roleKind === 'gate' ? [pass, fail, 'BLOCKED'] : [pass, ...(fail ? [fail] : [])],
    ...(roleKind === 'gate' ? { passKeyword: pass, failKeyword: fail } : {}), definitionHash: 'a'.repeat(64),
  }));
  const gates = [['oscar', 'seclint', 'policy'], ['angela']];
  f.state.roles = roles;
  f.state.execution.workflow.gates = gates;
  f.events = [{ ...f.events[0], roles, execution: { workflow: { gates } } }];
  f.state.instances = {};
  f.state.agents.hank.status = 'idle';
  for (const role of roles) {
    f.state.agents[role.id] ??= { status: 'idle', activity: 'Waiting for stage', lastKeyword: null, totals: {} };
  }
  for (const id of gates[0]) {
    f.state.instances[`${id}-m1`] = { id: `${id}-m1`, agent: id, milestoneId: 'm1', status: 'working',
      activity: 'Checking storage', worktree: `C:\\isolated\\${id}-m1`, sandbox: 'docker' };
  }
  const result = (agent, keyword, outcome) => {
    f.state.instances[`${agent}-m1`].status = 'idle';
    f.events.push({ v: 1, seq: f.events.length + 1, ts: f.state.updatedAt, runId: f.state.runId,
      type: 'gate_result', agent, keyword, result: outcome, stage: 0, milestoneId: 'm1', cycle: 2, instanceId: `${agent}-m1` });
  };
  if (kind === 'failed') {
    result('seclint', 'SECLINT_DIRTY', 'failed');
    result('oscar', 'CHANGES_REQUESTED', 'failed');
  } else result('seclint', 'SECLINT_CLEAN', 'passed');
  if (kind === 'hostile') {
    roles[3].name = '\x1b[31mSec\x07\nLint\u202e会社😀';
    roles[3].title = '\x1b]0;evil\x07Static\u202e会社😀';
    roles[4].name = 'N'.repeat(200);
    roles[4].title = 'T'.repeat(200) + '\x1b[2J';
  }
  return f;
}
