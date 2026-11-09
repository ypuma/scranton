// The Workflow section as a stage editor over the server's catalog (GET /api/control defaults.agents): one row per
// gate, built-in and custom, each on or off with a stage number; a stored choice drops deleted or unknown agents;
// a custom gate gets a model select whose default names its agent default, and is no Docker gap with one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelKey, dockerGaps, runRoles, buildModels, parseModels, piDefaultLabel, parseStoredModels, resolveChoices } from '../../visualizer/public/js/accounts.js';
import {
  WORKFLOW_KEY, WORKFLOW_ERROR, parseControl, gateCatalog, roleIds, parseStoredWorkflow, buildWorkflow, buildRunRequest, workflowGates,
  modelErrorRoles, errorField, configuredChoice,
} from '../../visualizer/public/js/control.js';
import { buildFollowUp } from '../../visualizer/public/js/scope.js';
import { harness, CATALOG, CONTROL } from './fixtures/run-drawer.js';

const GPT = modelKey('openai', 'gpt-a');
const PICK = { provider: 'openai', model: 'gpt-a' };
const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
const entry = (id, name, title, extra = {}) => ({ id, name, title, kind: 'gate', builtin: false, gate: true, passKeyword: `${id.toUpperCase()}_PASSED`, failKeyword: `${id.toUpperCase()}_FAILED`, ...extra });
const AGENTS = [
  { id: 'michael', name: 'Michael', title: 'Orchestrator', kind: 'planner', builtin: true, gate: false },
  { id: 'dwight', name: 'Dwight', title: 'Developer', kind: 'developer', builtin: true, gate: false },
  { id: 'oscar', name: 'Oscar', title: 'Reviewer', kind: 'gate', builtin: true, gate: true },
  { id: 'hank', name: 'Hank', title: 'Security', kind: 'gate', builtin: true, gate: true },
  { id: 'angela', name: 'Angela', title: 'QA', kind: 'gate', builtin: true, gate: true },
  entry('seclint', 'Seclint', 'Lint'),
  entry('docs2', 'Doris', 'Docs'),
];
const withAgents = (agents = AGENTS, defaults = {}) => ({ ...CONTROL, defaults: { agents, ...defaults } });
const ALL = (ids) => Object.fromEntries(ids.map((r) => [r, GPT]));
const RUN = ['michael', 'dwight', 'oscar', 'hank', 'angela'];

test('parseControl: defaults.agents is the catalog; gates in catalog order, models for every role of it', () => {
  const c = parseControl(withAgents([...AGENTS, { id: 'Bad-Id' }, entry('seclint', 'Twice', 'x')], {
    models: { seclint: PICK, docs2: { provider: 'openai' }, kevin: PICK },
    workflow: { gates: [['oscar', 'seclint'], ['nobody', 'angela']] },
  }));
  assert.deepEqual(gateCatalog(c).map((g) => [g.id, g.name, g.builtin]), [
    ['oscar', 'Oscar', true], ['hank', 'Hank', true], ['angela', 'Angela', true], ['seclint', 'Seclint', false], ['docs2', 'Doris', false],
  ]);
  assert.deepEqual(roleIds(c), [...RUN, 'seclint', 'docs2']);
  assert.deepEqual(c.models, { michael: null, dwight: null, oscar: null, hank: null, angela: null, seclint: PICK, docs2: null }, 'an id outside the catalog is no role');
  assert.deepEqual(c.workflow, { gates: [['oscar', 'seclint'], ['angela']] });
  assert.deepEqual(gateCatalog(parseControl(CONTROL)).map((g) => g.id), ['oscar', 'hank', 'angela'], 'an older server: the built-in gates');
});

test('the stage choice with custom gates: grouped by number, catalog order inside a stage, ids outside the catalog dropped', () => {
  const order = ['oscar', 'hank', 'angela', 'seclint', 'docs2'];
  assert.deepEqual(workflowGates({ stages: { seclint: 2, oscar: 1, hank: 1, angela: 2 } }, order), [['oscar', 'hank'], ['angela', 'seclint']]);
  assert.deepEqual(workflowGates({ stages: { gone: 1, angela: 2 } }, order), [['angela']]);
  assert.equal(buildWorkflow({ stages: { gone: 1 } }, order).error, WORKFLOW_ERROR);
  assert.equal(buildWorkflow({ stages: { docs2: '6' } }, order, { docs2: 'Doris' }).error, "Doris's stage must be a whole number from 1 to 5.");
  assert.deepEqual(parseStoredWorkflow(JSON.stringify({ stages: { gone: 1, seclint: 2 } }), order), { stages: { seclint: 2 } });
  assert.equal(parseStoredWorkflow(JSON.stringify({ stages: { gone: 1 } }), order), null, 'a choice left without a gate is no choice');
  const c = parseControl(withAgents());
  assert.deepEqual(buildRunRequest({ request: 'x', workflow: { stages: { oscar: 1, seclint: 1, angela: 2 } } }, c).body.workflow, { gates: [['oscar', 'seclint'], ['angela']] });
  assert.deepEqual(buildRunRequest({ request: 'x', workflow: { stages: { seclint: 1 } } }, parseControl(CONTROL)), { error: WORKFLOW_ERROR, field: 'workflow' },
    'a server without the agent cannot run it');
  assert.deepEqual(buildFollowUp({ goal: 'Next', execution: { workflow: { stages: { docs2: 1 } } } }, c).body.workflow, { gates: [['docs2']] });
  assert.deepEqual(configuredChoice({ gates: [['seclint'], ['angela']] }, order), { stages: { seclint: 1, angela: 2 } });
});

test('drawer: one row per gate of the catalog, custom gates off; turned on, a custom gate joins the last stage', async (t) => {
  const h = harness({ control: withAgents() });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(h.ids(), ['oscar', 'hank', 'angela', 'seclint', 'docs2']);
  assert.deepEqual(h.shown(), { oscar: 1, hank: 1, angela: 2, seclint: 0, docs2: 0 });
  assert.equal(h.row('seclint').name.textContent, 'Seclint');
  assert.equal(h.row('seclint').stage.value, '2');
  assert.equal(h.row('seclint').stage.disabled, true);
  assert.equal(h.row('seclint').stage.getAttribute('aria-label'), 'Stage of Seclint, 1 to 5');
  assert.equal(h.$('model-row-seclint'), h.models.field('seclint') && h.$('model-row-seclint'), 'no fixed row in the page');
  assert.equal(h.models.field('seclint').hidden, false);

  await h.toggle('seclint', true);
  assert.equal(h.$('f-gates-summary').textContent, 'Review + Security \u2192 Tests + Seclint, after each developer turn');
  assert.deepEqual(JSON.parse(h.storage.map.get(WORKFLOW_KEY)), { stages: { oscar: 1, hank: 1, angela: 2, seclint: 2 } });
  await h.stage('docs2', 1);
  await h.toggle('docs2', true);
  assert.equal(h.$('f-gates-summary').textContent, 'Review + Security + Doris \u2192 Tests + Seclint, after each developer turn');

  await h.pick(ALL([...RUN, 'seclint', 'docs2']));
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['oscar', 'hank', 'docs2'], ['angela', 'seclint']] });
  assert.deepEqual(Object.keys(h.posts[0].body.models), [...RUN, 'docs2', 'seclint'], 'custom gates in stage order after the built-ins');
});

test('drawer: a stored choice with a custom gate is applied once the catalog arrives; a deleted agent drops out', async (t) => {
  const h = harness({ control: withAgents(), stored: { stages: { oscar: 1, seclint: 2, gone: 3 } } });
  t.after(() => h.panel.setMode('demo'));
  assert.deepEqual(h.shown(), { oscar: 1, hank: 0, angela: 0 }, 'before the first poll only the built-ins are known');
  await h.open();
  assert.deepEqual(h.shown(), { oscar: 1, hank: 0, angela: 0, seclint: 2, docs2: 0 });
  assert.equal(h.$('f-gates-summary').textContent, 'Review \u2192 Seclint, after each developer turn');

  // seclint is deleted in the Agents drawer: the next poll has no row for it and the run does not send it
  h.server.control = withAgents(AGENTS.filter((a) => a.id !== 'seclint'));
  await h.panel.refresh();
  assert.deepEqual(h.ids(), ['oscar', 'hank', 'angela', 'docs2']);
  assert.equal(h.$('f-gates-summary').textContent, 'Review, after each developer turn');
  await h.pick(ALL(RUN));
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['oscar']] });
  // the next change keeps only what the server has
  await h.toggle('angela', true);
  assert.deepEqual(JSON.parse(h.storage.map.get(WORKFLOW_KEY)), { stages: { oscar: 1, angela: 2 } });
});

test('drawer: a stored choice whose gates are all gone opens on the default, still with at least one gate', async (t) => {
  const h = harness({ control: withAgents(), stored: { stages: { gone: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(h.shown(), { oscar: 1, hank: 1, angela: 2, seclint: 0, docs2: 0 });
  for (const id of ['oscar', 'hank', 'angela']) await h.toggle(id, false);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.$('run-error').textContent, WORKFLOW_ERROR);
  assert.equal(globalThis.document.activeElement, h.row('oscar').box);
});

test('drawer: a configured workflow with a custom gate is respected without a stored choice', async (t) => {
  const h = harness({ control: withAgents(AGENTS, { workflow: { gates: [['seclint'], ['angela']] } }) });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(h.shown(), { oscar: 0, hank: 0, angela: 2, seclint: 1, docs2: 0 });
  assert.equal(h.$('f-gates-summary').textContent, 'Seclint \u2192 Tests, after each developer turn');
  assert.equal(h.$('f-gates-config').hidden, true);
  await h.pick(ALL(['michael', 'dwight', 'angela', 'seclint']));
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['seclint'], ['angela']] });
  assert.equal(h.storage.map.has(WORKFLOW_KEY), false);
});

test('models: a custom gate\'s default option names its agent default, and it is then no Docker gap', async (t) => {
  assert.equal(piDefaultLabel({ seclint: SOL }, 'seclint'), 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(piDefaultLabel({ seclint: null }, 'seclint'), 'pi default');
  assert.deepEqual(runRoles({ gates: [['seclint'], ['angela']] }), ['michael', 'dwight', 'angela', 'seclint']);
  const none = { michael: GPT, dwight: GPT, angela: GPT, seclint: '' };
  assert.deepEqual(dockerGaps(none, { gates: [['seclint'], ['angela']], configured: { seclint: null } }), ['seclint']);
  assert.deepEqual(dockerGaps(none, { gates: [['seclint'], ['angela']], configured: { seclint: SOL } }), [], 'the agent default counts');
  const r = buildModels(none, parseModels(CATALOG), { gates: [['seclint']], configured: { michael: null }, names: { seclint: 'Seclint' } });
  assert.deepEqual([r.field, r.fields], ['models.seclint', ['models.seclint']]);
  assert.match(r.error, /needs a model for Seclint\./);
  assert.deepEqual(parseStoredModels(JSON.stringify({ seclint: PICK, 'Bad-Id': PICK }), null), { seclint: PICK }, 'the picker keeps a custom choice');
  assert.equal(resolveChoices({ seclint: PICK }, parseModels(CATALOG), ['seclint']).seclint.value, GPT);

  const h = harness({ control: withAgents(AGENTS, { models: { michael: SOL, dwight: SOL, angela: SOL, seclint: SOL, docs2: null } }), stored: { stages: { angela: 1, seclint: 1, docs2: 2 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.select('seclint').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(h.select('docs2').childNodes[0].textContent, 'pi default');
  assert.equal(h.$('model-row-oscar').hidden, true, 'Oscar does not run');
  assert.match(h.$('models-need').textContent, /needs a model for Doris\./);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.select('docs2').getAttribute('aria-invalid'), 'true');
  assert.equal(h.select('seclint').getAttribute('aria-invalid'), null, 'the agent default is no gap');
  assert.equal(globalThis.document.activeElement, h.select('docs2'));
  await h.pick({ docs2: GPT });
  assert.deepEqual(JSON.parse(h.storage.map.get('scranton.models')), { docs2: PICK }, 'the custom choice is kept like the others');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].body.models, { docs2: PICK });
});

test('models: the server 400 for a custom gate marks its select', async (t) => {
  const msg = 'Docker requires an explicit provider and model for dwight, seclint; choose a model for each role';
  const roles = [...RUN, 'seclint', 'docs2'];
  assert.deepEqual(modelErrorRoles(msg, roles), ['dwight', 'seclint']);
  assert.equal(errorField('models.docs2: unknown provider', roles), 'models.docs2');
  assert.equal(errorField('models.docs2: unknown provider'), 'models', 'a role the server does not list has no select');

  const h = harness({ control: withAgents(), stored: { stages: { seclint: 1 } }, reject: msg });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.pick(ALL(['michael', 'dwight', 'seclint']));
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.select('seclint').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('f-model-dwight'));
});

test('drawer: a demo sends no gates, custom ones included; a follow-up carries them', async (t) => {
  const h = harness({ control: withAgents(), stored: { stages: { seclint: 1, angela: 2 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-demo').checked = true;
  await h.$('f-demo').fire('change');
  h.$('f-scenario').value = 'happy';
  assert.equal(h.row('seclint').box.disabled, true);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[0].body.workflow, undefined);
  h.$('f-demo').checked = false;
  await h.$('f-demo').fire('change');
  h.$('run-dialog').close();

  h.$('f-sandbox-host').checked = true;
  h.$('f-trusted').checked = true;
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.deepEqual(h.posts[1].body.workflow, { gates: [['seclint'], ['angela']] });
});

test('a custom agent with the id constructor is an agent like any other, never the prototype', async (t) => {
  const odd = [...AGENTS, entry('constructor', 'Connie', 'Build check')];
  const h = harness({ control: withAgents(odd, { models: { constructor: null } }), stored: { stages: { constructor: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.row('constructor').stage.value, '1');
  assert.equal(h.$('f-gates-summary').textContent, 'Connie, after each developer turn');
  assert.equal(h.select('constructor').childNodes[0].textContent, 'pi default');
  assert.equal(h.select('toString'), null);
  assert.match(h.$('models-need').textContent, /for Michael, Dwight and Connie\./);
});
