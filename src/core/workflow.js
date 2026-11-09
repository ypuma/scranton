export const GATE_ROLES = ['oscar', 'hank', 'angela'];
export const PASS_KEYWORDS = { oscar: 'REVIEW_APPROVED', hank: 'SECURITY_PASSED', angela: 'TEST_PASSED' };
export const ROLE_NAMES = { michael: 'Michael', dwight: 'Dwight', oscar: 'Oscar', hank: 'Hank', angela: 'Angela' };
export function normalizeWorkflow(value = { gates: [['angela']] }, availableGateIds = GATE_ROLES) {
  const gates = value?.gates;
  const seen = new Set();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => k !== 'gates') || !Array.isArray(gates) || !gates.length) throw Object.assign(Error('workflow requires non-empty gates'), { status: 400 });
  for (const stage of gates) {
    if (!Array.isArray(stage) || !stage.length) throw Object.assign(Error('Gate stages must not be empty'), { status: 400 });
    for (const role of stage) {
      if (!availableGateIds.includes(role) || seen.has(role)) throw Object.assign(Error(`Unknown, non-gate or duplicate gate role: ${role}`), { status: 400 });
      seen.add(role);
    }
  }
  return { gates: gates.map((stage) => [...stage]) };
}
export function activeRoles(config, noPlan = false) { return [...(noPlan ? [] : ['michael']), 'dwight', ...normalizeWorkflow(config.workflow, config.roles?.filter((r) => r.kind === 'gate').map((r) => r.id)).gates.flat()]; }
