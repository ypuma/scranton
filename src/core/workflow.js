export const GATE_ROLES = ['oscar', 'hank', 'angela'];
export const PASS_KEYWORDS = { oscar: 'REVIEW_APPROVED', hank: 'SECURITY_PASSED', angela: 'TEST_PASSED' };
// The one table of built-in agent words (.enma/agent-names-contract.md); ids stay what machines read.
export const ROLE_NAMES = { michael: 'Planner', dwight: 'Developer', oscar: 'Code Reviewer', hank: 'Security Auditor', angela: 'QA Tester' };
export const ROLE_SHORT = { michael: 'Planner', dwight: 'Developer', oscar: 'Reviewer', hank: 'Security', angela: 'QA' };
export const ROLE_TITLES = { michael: 'Plans the work', dwight: 'Writes the code', oscar: 'Reviews the changes', hank: 'Checks security', angela: 'Tests the result' };
export const ROLE_DESCRIPTIONS = {
  michael: 'Breaks the request into milestones, judges progress when a milestone fails and, in a chat, writes the final reply.',
  dwight: 'Implements one milestone at a time and fixes what the checks report.',
  oscar: "Reviews each milestone's changes for defects, regressions and test coverage. Never edits the project.",
  hank: "Audits each milestone's changes for exploitable weaknesses. Never edits the project.",
  angela: 'Runs the tests and the program against every acceptance criterion. Never edits the project.'
};
const builtin = (id) => typeof id === 'string' && Object.hasOwn(ROLE_NAMES, id);
/** A role inside a sentence: built-in names take an article ("the Developer"), custom names stand alone. */
export function roleInSentence(id, name = ROLE_NAMES[id], start = false) {
  if (!builtin(id) || name !== ROLE_NAMES[id]) return name;
  return `${start ? 'The' : 'the'} ${name}`;
}
/** A name in a model-facing list or label: a custom name is user text, so nothing in it may read as list syntax. */
export const promptName = (name, id) => String(name ?? '').replace(/[^\p{L}\p{M}\p{N} _.&/+'-]+/gu, ' ').replace(/ {2,}/g, ' ').trim() || id;
/** Where a human types or recognises the id: "Developer (id dwight)"; unknown ids stay as given. */
export const roleWithId = (id) => builtin(id) ? `${ROLE_NAMES[id]} (id ${id})` : id;
export function normalizeWorkflow(value = { gates: [['angela']] }, availableGateIds = GATE_ROLES) {
  const gates = value?.gates;
  const seen = new Set();
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => k !== 'gates') || !Array.isArray(gates) || !gates.length) throw Object.assign(Error('workflow requires non-empty gates'), { status: 400 });
  for (const stage of gates) {
    if (!Array.isArray(stage) || !stage.length) throw Object.assign(Error('Gate stages must not be empty'), { status: 400 });
    for (const role of stage) {
      if (!availableGateIds.includes(role) || seen.has(role)) throw Object.assign(Error(`Unknown, non-gate or duplicate gate role: ${roleWithId(role)}`), { status: 400 });
      seen.add(role);
    }
  }
  return { gates: gates.map((stage) => [...stage]) };
}
export function activeRoles(config, noPlan = false) { return [...(noPlan ? [] : ['michael']), 'dwight', ...normalizeWorkflow(config.workflow, config.roles?.filter((r) => r.kind === 'gate').map((r) => r.id)).gates.flat()]; }
