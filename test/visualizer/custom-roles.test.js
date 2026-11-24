// Custom gate agents in a run (.enma/custom-agents-contract.md section 10): the reducer keeps the built-ins and adds
// the run's custom roles from run_started.roles, a custom gate_result counts like a built-in one, the pipeline gives
// a custom gate a card in its stage column with Passed / Failed / Blocked, and its lanes carry its title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AGENT_IDS, reduceAll, parseJsonl, createState, roleOf, lanesOf, activeRoles, workflowText, workflowOf, stepNames, gateView, laneGate, describe,
  displayName, roleTitle, totals, customRoles,
} from '../../visualizer/public/js/state.js';
import { createPipeline, pipelineColumns } from '../../visualizer/public/js/pipeline.js';
import { createLanes } from '../../visualizer/public/js/lanes.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const SERIAL = parseJsonl(readFileSync(fileURLToPath(new URL('./fixtures/serial-events.jsonl', import.meta.url)), 'utf8'));
const builtin = (id, name, title, kind, keywords) => ({ id, name, title, kind, builtin: true, keywords, definitionHash: 'a'.repeat(64) });
const custom = (id, name, title) => ({
  id, name, title, kind: 'gate', builtin: false, keywords: [`${id.toUpperCase()}_PASSED`, `${id.toUpperCase()}_FAILED`, 'BLOCKED'],
  passKeyword: `${id.toUpperCase()}_PASSED`, failKeyword: `${id.toUpperCase()}_FAILED`, definitionHash: 'b'.repeat(64),
});
// what the engine lists: only the roles the run invokes, in run order (the pinned section 10.1)
const ROLES = [
  builtin('michael', 'Michael', 'Orchestrator', 'planner', ['PLAN_READY']),
  builtin('dwight', 'Dwight', 'Developer', 'developer', ['TASK_COMPLETE', 'BLOCKED']),
  builtin('oscar', 'Oscar', 'Reviewer', 'gate', ['REVIEW_APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']),
  custom('seclint', 'Seclint', 'Lint'),
  custom('docs2', 'Doris', 'Docs'),
  builtin('angela', 'Angela', 'QA', 'gate', ['TEST_PASSED', 'TEST_FAILED', 'BLOCKED']),
];
const GATES = [['oscar', 'seclint', 'docs2'], ['angela']];

function run(extra = [], { roles = ROLES, gates = GATES } = {}) {
  let seq = 0;
  const e = (type, fields) => ({ v: 1, seq: ++seq, ts: `2026-11-09T12:00:${String(seq).padStart(2, '0')}.000Z`, runId: 'r1', type, ...fields });
  return reduceAll([
    e('run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 3, execution: { maxParallel: 1, isolation: 'worktree', workflow: { gates } }, ...(roles ? { roles } : {}) }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One', description: '', acceptanceCriteria: [] }] }),
    e('milestone_started', { milestoneId: 'm1', index: 0, total: 1, title: 'One' }),
    ...extra.map(([type, fields]) => e(type, fields)),
  ]);
}

const lint = (result, keyword, cycle = 1) => [
  ['instance_started', { instanceId: 'seclint-m1', agent: 'seclint', milestoneId: 'm1', sessionId: 's-lint', worktree: 'C:\\wt', sandbox: { mode: 'docker' } }],
  ['agent_finished', { agent: 'seclint', instanceId: 'seclint-m1', milestoneId: 'm1', cycle, keyword, exitCode: 0, durationMs: 5, usage: { input: 10, output: 5, cost: 0.01 } }],
  ['gate_result', { milestoneId: 'm1', cycle, stage: 0, agent: 'seclint', instanceId: 'seclint-m1', result, keyword }],
];

test('agents: the five built-ins in order, then the custom roles of the run in run_started.roles order', () => {
  const s = run();
  assert.deepEqual(Object.keys(s.agents), [...AGENT_IDS, 'seclint', 'docs2']);
  assert.deepEqual(s.roles, ROLES, 'roles is a copy of the event\'s list');
  assert.deepEqual(customRoles(s).map((r) => [r.id, r.name, r.title]), [['seclint', 'Seclint', 'Lint'], ['docs2', 'Doris', 'Docs']]);
  assert.equal(s.agents.seclint.status, 'idle');
  assert.deepEqual(s.workflow, { gates: GATES }, 'custom gates of the run are known gates');
  assert.deepEqual(activeRoles(s), ['michael', 'dwight', 'oscar', 'seclint', 'docs2', 'angela']);
  assert.equal(workflowText(workflowOf(s), stepNames(s)), 'Review + Seclint + Doris \u2192 Tests');
  assert.equal(displayName('docs2', s), 'Doris');
  assert.equal(roleTitle('docs2', s), 'Docs');
  // the built-ins keep their own names, also when the run does not list them
  assert.equal(displayName('hank', s), 'Security Auditor');
  assert.equal(roleTitle('hank', s), 'Checks security');

  assert.equal(createState().roles, undefined, 'absent before any run');
  assert.equal('roles' in createState(), false);
  // the next run starts over: its own custom roles only
  const next = reduceAll([{ v: 1, seq: 1, runId: 'r2', type: 'run_started', ts: '2026-11-09T13:00:00.000Z', roles: [ROLES[0], ROLES[1], custom('perf', 'Perf', 'Speed')] }], s);
  assert.deepEqual(Object.keys(next.agents), [...AGENT_IDS, 'perf']);
});

test('every run_started replaces the roles: one without a list after a custom run of the same id drops the custom roles', () => {
  const s = run(lint('passed', 'SECLINT_PASSED'));
  assert.deepEqual(Object.keys(s.agents), [...AGENT_IDS, 'seclint', 'docs2']);
  const restart = (fields) => reduceAll([{ v: 1, seq: s.lastSeq + 1, runId: 'r1', type: 'run_started', ts: '2026-11-09T12:10:00.000Z', request: 'Build', ...fields }], s);
  const bare = restart({ execution: { workflow: { gates: GATES } } });
  assert.deepEqual(bare.roles, [], 'a missing list is []');
  assert.deepEqual(Object.keys(bare.agents), AGENT_IDS, 'the stale custom roles are gone');
  assert.deepEqual(customRoles(bare), []);
  assert.equal(displayName('seclint', bare), 'seclint');
  assert.deepEqual(bare.agents.dwight, s.agents.dwight, 'a built-in keeps what it had');
  assert.deepEqual(bare.workflow, { gates: [['oscar'], ['angela']] }, 'custom gates of the old list are no gates any more');
  // a new list replaces the old one: docs2 stays, seclint goes, perf comes
  const next = restart({ roles: [ROLES[0], ROLES[1], custom('docs2', 'Doris', 'Docs'), custom('perf', 'Perf', 'Speed')] });
  assert.deepEqual(Object.keys(next.agents), [...AGENT_IDS, 'docs2', 'perf']);
  assert.deepEqual(next.roles.map((r) => r.id), ['michael', 'dwight', 'docs2', 'perf']);
  assert.equal(next.agents.seclint, undefined);
  // a list that is not a list counts as none
  assert.deepEqual(Object.keys(restart({ roles: { seclint: ROLES[3] } }).agents), AGENT_IDS);
});

test('roles that are not custom agents never become keys: bad ids, built-ins, duplicates, prototype names', () => {
  const s = run([], { roles: [...ROLES, custom('seclint', 'Again', 'Twice'), { id: 'Bad-Id', kind: 'gate' }, { id: '__proto__' }, { id: 'constructor', kind: 'gate' }, null, 'x'] });
  assert.deepEqual(Object.keys(s.agents), [...AGENT_IDS, 'seclint', 'docs2', 'constructor']);
  assert.equal(Object.getPrototypeOf(s.agents), Object.prototype);
  assert.equal(customRoles(s).find((r) => r.id === 'seclint').name, 'Seclint', 'the first entry wins');
  // an event naming a prototype key never reaches the prototype
  const p = run([['agent_status', { agent: 'hasOwnProperty', status: 'working', activity: 'x' }]]);
  assert.equal(typeof p.agents.hasOwnProperty, 'function');
  assert.equal(Object.hasOwn(p.agents, 'hasOwnProperty'), false);
});

test('an old run is unchanged: no roles, five agents, a custom-looking gate_result ignored', () => {
  const serial = reduceAll(SERIAL);
  assert.deepEqual(Object.keys(serial.agents), AGENT_IDS);
  assert.deepEqual(serial.roles, [], 'a run_started without roles has none (section 11.1)');
  assert.equal(serial.applied, SERIAL.length);
  const old = run([...lint('passed', 'SECLINT_PASSED')], { roles: null, gates: [['oscar', 'hank'], ['angela']] });
  assert.deepEqual(Object.keys(old.agents), AGENT_IDS);
  assert.equal(old.gates.seclint, undefined, 'without the role in the run, seclint is no gate');
  assert.equal(roleOf('seclint-m1', old), null);
  assert.deepEqual(old.workflow, { gates: [['oscar', 'hank'], ['angela']] });
});

test('gate_result of a custom gate: per role, milestone and lane, its totals, and the log line names it', () => {
  const s = run(lint('failed', 'SECLINT_FAILED'));
  assert.equal(roleOf('seclint-m1', s), 'seclint');
  assert.equal(s.instances['seclint-m1'].agent, 'seclint');
  assert.deepEqual([s.gates.seclint.result, s.gates.seclint.keyword, s.gates.seclint.instanceId], ['failed', 'SECLINT_FAILED', 'seclint-m1']);
  assert.equal(s.milestones[0].gates.seclint.result, 'failed');
  assert.equal(s.agents.seclint.totals.runs, 1);
  assert.equal(totals(s).tokens, 15, 'custom roles count in the totals');
  assert.equal(gateView(s, 'seclint').label, 'Failed');
  assert.equal(laneGate(s, s.instances['seclint-m1']).label, 'Failed');
  const lines = s.log.filter((l) => ['gate_result', 'agent_finished'].includes(l.type));
  assert.deepEqual(lines.map((l) => [l.type, l.tone]), [['agent_finished', 'bad'], ['gate_result', 'bad']], 'its own fail keyword reads as a failure');
  assert.equal(lines[1].text, 'Seclint gate failed: SECLINT_FAILED \u00b7 m1 \u00b7 cycle 1 \u00b7 stage 1');
  assert.equal(gateView(run(lint('passed', 'SECLINT_PASSED')), 'seclint').label, 'Passed');
  assert.equal(gateView(run(lint('blocked', 'BLOCKED')), 'seclint').label, 'Blocked');
  assert.equal(describe({ type: 'agent_finished', agent: 'seclint', keyword: 'SECLINT_PASSED', exitCode: 0, durationMs: 1 }, s).tone, 'good');
  // the built-ins keep their words
  assert.equal(gateView(run([['gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'oscar', instanceId: 'oscar-m1', result: 'passed', keyword: 'REVIEW_APPROVED' }]]), 'oscar').label, 'Approved');
});

test('lanes: custom lanes after the built-in roles, shown with their name, where they work and the custom title', () => {
  const s = run([
    ...lint('passed', 'SECLINT_PASSED'),
    ['instance_started', { instanceId: 'docs2-m1', agent: 'docs2', milestoneId: 'm1' }],
    ['instance_started', { instanceId: 'angela-m1', agent: 'angela', milestoneId: 'm1' }],
    ['instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }],
  ]);
  assert.deepEqual(lanesOf(s).map((i) => i.id), ['dwight-m1', 'angela-m1', 'seclint-m1', 'docs2-m1']);
  installDom();
  const list = new FakeEl();
  createLanes({ block: new FakeEl(), list, exec: new FakeEl() }).render(s);
  const rows = Object.fromEntries(list.childNodes.map((li) => [li.dataset.lane, li]));
  const said = (id) => rows[id].childNodes[1].childNodes.map((n) => n.textContent);
  assert.deepEqual(said('seclint-m1'), ['Seclint \u00b7 m1', 'Lint'], 'the name the run gave it, never the raw id');
  assert.deepEqual(said('docs2-m1'), ['Doris \u00b7 m1', 'Docs']);
  assert.match(rows['seclint-m1'].childNodes[1].childNodes[0].title, /\(id seclint-m1\)$/, 'the id is a hover away');
  assert.equal(rows['seclint-m1'].dataset.gate, 'passed');
  assert.equal(rows['seclint-m1'].childNodes[3].textContent, '\u2713 Passed \u00b7 cycle 1');
  assert.deepEqual(said('angela-m1'), ['QA Tester \u00b7 m1', 'Tests the result'], 'a built-in says its name and what it does');
});

function mount() {
  installDom();
  const root = new FakeEl();
  const pipeline = createPipeline(root);
  const find = (nodes, id) => nodes.flatMap((n) => (n.dataset?.node === id ? [n] : find(n.childNodes ?? [], id)));
  return { root, pipeline, card: (id) => find(root.childNodes, id)[0] };
}
const text = (node) => (typeof node === 'string' ? node : node.childNodes.length ? node.childNodes.map(text).join('') : node.textContent);

test('pipeline: three gates side by side stack in one stage column, then Angela; custom cards carry name and title', () => {
  const s = run();
  const { root, pipeline, card } = mount();
  pipeline.render(s);
  assert.deepEqual(pipelineColumns(s), [['michael'], ['dwight'], ['oscar', 'seclint', 'docs2'], ['angela']]);
  const stack = root.childNodes[6];
  assert.match(stack.className, /\bstage-column\b/);
  assert.equal(stack.dataset.count, '3');
  assert.deepEqual(stack.childNodes.map((slot) => slot.childNodes[0].dataset.node), ['oscar', 'seclint', 'docs2']);
  assert.equal(stack.getAttribute('aria-label'), 'Stage 1, in parallel: Review + Seclint + Doris');
  assert.equal(root.childNodes[8].dataset.node, 'angela');
  assert.equal(root.dataset.stacked, 'true');
  const doris = card('docs2');
  assert.equal(doris.childNodes[0].childNodes[0].textContent, 'Doris');
  assert.equal(doris.childNodes[0].childNodes[0].id, 'agent-docs2');
  assert.equal(doris.childNodes[1].childNodes[0], 'Docs');
  assert.equal(text(card('angela').childNodes[2]), 'After review + seclint + doris');
  assert.equal(card('hank'), undefined, 'a built-in the run does not use has no card');
});

test('pipeline: a custom gate\'s verdict reads Passed, Failed or Blocked on its card', () => {
  for (const [result, keyword, line] of [['passed', 'SECLINT_PASSED', '\u2713 Passed'], ['failed', 'SECLINT_FAILED', '\u2715 Failed'], ['blocked', 'BLOCKED', '\u25a0 Blocked']]) {
    const { pipeline, card } = mount();
    pipeline.render(run(lint(result, keyword)));
    assert.equal(card('seclint').dataset.gate, result, result);
    assert.equal(text(card('seclint').childNodes[2]), `${line} m1 \u00b7 cycle 1`, result);
  }
});

test('pipeline: a custom gate in a stage of its own is a card in its column, and six columns mark the row as many', () => {
  const { root, pipeline } = mount();
  const s = run([], { gates: [['oscar'], ['seclint'], ['docs2'], ['angela']] });
  pipeline.render(s);
  assert.deepEqual(root.childNodes.filter((n) => n.dataset.node).map((n) => n.dataset.node), ['human', 'michael', 'dwight', 'oscar', 'seclint', 'docs2', 'angela']);
  assert.equal(root.dataset.columns, '6');
  assert.equal(root.dataset.many, 'true');
  pipeline.render(run());
  assert.equal(root.dataset.many, undefined, 'four columns are not many');
  // the old layouts look as before
  pipeline.render(run([], { roles: null, gates: [['oscar', 'hank'], ['angela']] }));
  assert.deepEqual(root.childNodes.filter((n) => n.dataset.node).map((n) => n.dataset.node), ['human', 'michael', 'dwight', 'angela']);
  assert.deepEqual(root.childNodes[6].childNodes.map((slot) => slot.childNodes[0].dataset.node), ['oscar', 'hank']);
  assert.equal(root.dataset.columns, '4');
});

test('a custom gate with the id constructor gets its own card, name and verdict', () => {
  const roles = [...ROLES.slice(0, 2), custom('constructor', 'Connie', 'Build check')];
  const s = run([['gate_result', { milestoneId: 'm1', cycle: 1, stage: 0, agent: 'constructor', instanceId: 'constructor-m1', result: 'passed', keyword: 'CONSTRUCTOR_PASSED' }]],
    { roles, gates: [['constructor']] });
  assert.equal(displayName('constructor', s), 'Connie');
  assert.equal(workflowText(workflowOf(s), stepNames(s)), 'Connie');
  assert.equal(gateView(s, 'constructor').label, 'Passed');
  const { pipeline, card } = mount();
  pipeline.render(s);
  assert.equal(card('constructor').childNodes[0].childNodes[0].textContent, 'Connie');
  assert.equal(text(card('constructor').childNodes[2]), '\u2713 Passed m1 \u00b7 cycle 1');
});
