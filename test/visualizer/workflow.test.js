// The Workflow section of the New run drawer: which gates run, side by side or one stage after the other, at least
// one of them, kept across reloads; the request carries it as { workflow: { gates } } (never for a demo), and the
// models and the Docker check cover exactly the roles the run uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModels, modelKey, buildModels, dockerGaps, runRoles } from '../../visualizer/public/js/accounts.js';
import {
  WORKFLOW_KEY, WORKFLOW_DEFAULT, WORKFLOW_ERROR, parseStoredWorkflow, workflowGates, buildWorkflow, buildRunRequest, parseControl, errorField,
  modelErrorRoles, configuredChoice, workflowNote,
} from '../../visualizer/public/js/control.js';
import { buildFollowUp } from '../../visualizer/public/js/scope.js';
import { harness, CATALOG, CONTROL } from './fixtures/run-drawer.js';

const GPT = modelKey('openai', 'gpt-a');
const PICK = { provider: 'openai', model: 'gpt-a' };
const ROLES5 = ['michael', 'dwight', 'oscar', 'hank', 'angela'];
const SERVER = (roles) => `Docker requires an explicit provider and model for ${roles}; choose a model for each role in Options → Models (pi default cannot be used in the Docker sandbox), or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL`;
const stages = (s) => ({ stages: s });
// the three-box choice the drawer stored before the stage editor
const legacy = (over = {}) => ({ review: true, security: true, tests: true, parallel: true, ...over });

test('workflowGates: gates on the same stage side by side, the stages in order', () => {
  assert.deepEqual(workflowGates(WORKFLOW_DEFAULT), [['oscar', 'hank'], ['angela']], 'the default of a new user');
  assert.deepEqual(workflowGates(stages({ oscar: 1, hank: 2, angela: 3 })), [['oscar'], ['hank'], ['angela']]);
  assert.deepEqual(workflowGates(stages({ oscar: 1, angela: 2 })), [['oscar'], ['angela']]);
  assert.deepEqual(workflowGates(stages({ angela: 1 })), [['angela']], 'the engine default');
  assert.deepEqual(workflowGates(stages({ oscar: 1, hank: 1 })), [['oscar', 'hank']]);
  assert.deepEqual(workflowGates(stages({ hank: 2 })), [['hank']], 'a gap in the numbers is no empty stage');
  assert.deepEqual(workflowGates(stages({ angela: '1', hank: ' 1 ' })), [['hank', 'angela']], 'typed numbers count; catalog order inside a stage');
  assert.deepEqual(buildWorkflow(stages({})), { error: WORKFLOW_ERROR, field: 'workflow' });
  assert.equal(WORKFLOW_ERROR, 'Turn on at least one gate.');
  assert.deepEqual(buildWorkflow(stages({ oscar: '9' })), { error: "Oscar's stage must be a whole number from 1 to 3.", field: 'stage.oscar' });
  assert.deepEqual(buildWorkflow(stages({ oscar: 'x' })).field, 'stage.oscar');
  assert.deepEqual(buildWorkflow(stages({ oscar: '0' })).field, 'stage.oscar');
});

test('parseStoredWorkflow: whole stage numbers only, and the three-box choice of before reads as its stages', () => {
  assert.deepEqual(parseStoredWorkflow(JSON.stringify(stages({ oscar: 1, hank: 2 }))), stages({ oscar: 1, hank: 2 }));
  assert.equal(parseStoredWorkflow(null), null);
  assert.equal(parseStoredWorkflow('{'), null);
  assert.equal(parseStoredWorkflow(JSON.stringify({ review: true })), null, 'an incomplete old choice');
  assert.equal(parseStoredWorkflow(JSON.stringify({ ...legacy(), tests: 'yes' })), null);
  assert.deepEqual(parseStoredWorkflow(JSON.stringify(stages({ oscar: 1.5, hank: '2', angela: 3, 'Bad-Id': 1 }))), stages({ angela: 3 }));
  assert.equal(parseStoredWorkflow(JSON.stringify(stages({}))), null, 'a choice without a gate is none');
  assert.deepEqual(parseStoredWorkflow(JSON.stringify(legacy())), stages({ oscar: 1, hank: 1, angela: 2 }));
  assert.deepEqual(parseStoredWorkflow(JSON.stringify(legacy({ parallel: false }))), stages({ oscar: 1, hank: 2, angela: 3 }));
  assert.deepEqual(parseStoredWorkflow(JSON.stringify(legacy({ review: false, tests: false }))), stages({ hank: 1 }));
});

test('buildRunRequest and buildFollowUp send the workflow as the contract says, never for a demo', () => {
  assert.deepEqual(buildRunRequest({ request: 'Build', workflow: WORKFLOW_DEFAULT }, parseControl(CONTROL)).body,
    { request: 'Build', workflow: { gates: [['oscar', 'hank'], ['angela']] }, conversation: true });
  assert.deepEqual(buildRunRequest({ request: 'Build', workflow: stages({}) }, parseControl(CONTROL)), { error: WORKFLOW_ERROR, field: 'workflow' });
  const demo = buildRunRequest({ demo: true, scenario: 'happy', workflow: WORKFLOW_DEFAULT }, parseControl(CONTROL));
  assert.equal(demo.body.workflow, undefined, 'a demo replays its scripted agents');
  assert.equal(buildRunRequest({ request: 'Build' }, parseControl(CONTROL)).body.workflow, undefined, 'an older form leaves the engine default');
  assert.deepEqual(buildFollowUp({ goal: 'Next', execution: { workflow: stages({ oscar: 1, hank: 2, angela: 3 }) } }, parseControl(CONTROL)).body.workflow,
    { gates: [['oscar'], ['hank'], ['angela']] });
});

test('parseControl reads defaults.workflow and defaults.models for every role', () => {
  const c = parseControl({ ...CONTROL, defaults: { workflow: { gates: [['hank'], ['angela', 'nobody']] }, models: { oscar: PICK, hank: { provider: 'openai' } } } });
  assert.deepEqual(c.workflow, { gates: [['hank'], ['angela']] });
  assert.deepEqual(c.models, { michael: null, dwight: null, oscar: PICK, hank: null, angela: null });
  assert.equal(parseControl(CONTROL).workflow, null, 'an older server reports none');
});

test('runRoles and dockerGaps cover exactly the roles of the workflow', () => {
  const some = { michael: PICK, dwight: PICK, oscar: null, hank: null, angela: null };
  assert.deepEqual(runRoles({ gates: [['oscar', 'hank'], ['angela']] }), ROLES5);
  assert.deepEqual(runRoles({ noPlan: true, gates: [['hank']] }), ['dwight', 'hank']);
  assert.deepEqual(runRoles(), ['michael', 'dwight', 'angela'], 'no gates given: the engine default');
  assert.deepEqual(dockerGaps({ gates: [['oscar', 'hank'], ['angela']] }), ROLES5);
  assert.deepEqual(dockerGaps({ gates: [['oscar']], configured: some }), ['oscar'], 'Hank and Angela do not run');
  assert.deepEqual(dockerGaps({ gates: [['oscar']], configured: { ...some, oscar: PICK } }), []);
  assert.deepEqual(dockerGaps({ gates: [['oscar', 'hank']], host: true }), []);
});

test('buildModels sends only the roles the run uses on the trusted host, and none in Docker', () => {
  const cat = parseModels(CATALOG);
  const all = Object.fromEntries(ROLES5.map((r) => [r, GPT]));
  const host = { host: true };
  assert.deepEqual(Object.keys(buildModels(all, cat, { ...host, gates: [['hank']] }).models), ['michael', 'dwight', 'hank']);
  assert.deepEqual(Object.keys(buildModels(all, cat, { ...host, gates: [['oscar', 'hank'], ['angela']] }).models), ROLES5);
  assert.deepEqual(Object.keys(buildModels(all, cat, { ...host, noPlan: true, gates: [['angela']] }).models), ['dwight', 'angela']);
  const configured = { michael: PICK, dwight: PICK, oscar: null, hank: null, angela: PICK };
  const r = buildModels(all, cat, { gates: [['oscar', 'hank'], ['angela']], configured });
  assert.equal(r.field, 'models.oscar');
  assert.deepEqual(r.fields, ['models.oscar', 'models.hank']);
  assert.match(r.error, /Oscar and Hank have none\./);
  assert.deepEqual(buildModels(all, cat, { gates: [['angela']], configured }), { models: {} });
});

test('the server 400 about models maps onto the Oscar and Hank selects', () => {
  assert.deepEqual(modelErrorRoles(SERVER('oscar, hank')), ['oscar', 'hank']);
  assert.equal(errorField(SERVER('oscar, hank')), 'models.oscar');
  assert.deepEqual(modelErrorRoles(SERVER('dwight, hank, angela')), ['dwight', 'hank', 'angela']);
  assert.equal(errorField(SERVER('hank')), 'models.hank');
  assert.equal(errorField('models.oscar: unknown provider'), 'models.oscar');
  assert.equal(errorField('workflow requires non-empty gates'), 'workflow');
});

// ------------------------------------------------------------ the drawer

test('drawer: a new user gets review and security side by side, then the tests, and every role needs an agent default in Docker', async (t) => {
  const h = harness({ control: { ...CONTROL, defaults: { models: { michael: PICK, dwight: PICK, oscar: null, hank: null, angela: PICK } } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(h.ids(), ['oscar', 'hank', 'angela'], 'an older server: the built-in gates');
  assert.deepEqual(h.shown(), { oscar: 1, hank: 1, angela: 2 });
  assert.deepEqual(['oscar', 'hank', 'angela'].map((id) => h.row(id).name.textContent), ['Oscar', 'Hank', 'Angela']);
  assert.equal(h.$('f-gates-summary').textContent, 'Review + Security \u2192 Tests, after each developer turn');
  for (const role of ROLES5) assert.equal(h.$(`model-row-${role}`).hidden, false, role);
  assert.match(h.$('models-need-text').textContent, /Oscar and Hank have none\./);

  await h.pick({ oscar: GPT, hank: GPT });
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, [], 'a pick does not fill a missing agent default');
  assert.match(h.$('run-error').textContent, /Oscar and Hank have none\./);
  assert.equal(h.$('f-model-oscar').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-hank').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-oscar').disabled, true, 'Docker keeps the select locked');
  assert.equal(h.$('run-error').getAttribute('tabindex'), '-1');
  assert.equal(globalThis.document.activeElement, h.$('run-error'), 'the message, never the locked select');

  await h.sandbox(true);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['oscar', 'hank'], ['angela']] });
  assert.deepEqual(Object.keys(h.posts[0].body.models), ['oscar', 'hank'], 'the trusted host sends the picks');
});

test('drawer: a stage number of its own runs a gate after the others, and the selects follow the gates', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.toggle('hank', false);
  assert.equal(h.row('hank').stage.disabled, true, 'an off gate has no stage to set');
  assert.equal(h.$('f-gates-summary').textContent, 'Review \u2192 Tests, after each developer turn');
  assert.equal(h.$('model-row-hank').hidden, true);
  assert.equal(h.$('model-row-oscar').hidden, false);
  await h.toggle('hank', true);
  await h.stage('hank', 2);
  await h.stage('angela', 3);
  assert.equal(h.$('f-gates-summary').textContent, 'Review \u2192 Security \u2192 Tests, after each developer turn');
  await h.toggle('oscar', false);
  await h.toggle('angela', false);
  assert.deepEqual(ROLES5.map((r) => h.$(`model-row-${r}`).hidden), [false, false, true, false, true]);

  await h.sandbox(true);
  await h.pick({ michael: GPT, dwight: GPT, hank: GPT });
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1, 'the inactive roles need no model');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['hank']] });
  assert.deepEqual(Object.keys(h.posts[0].body.models), ['michael', 'dwight', 'hank']);
});

test('drawer: no gate at all is a field error, and nothing is sent', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.sandbox(true);
  await h.pick(Object.fromEntries(ROLES5.map((r) => [r, GPT])));
  for (const id of ['oscar', 'hank', 'angela']) await h.toggle(id, false);
  assert.equal(h.$('f-gates-summary').dataset.tone, 'error');
  assert.equal(h.$('f-gates-summary').textContent, WORKFLOW_ERROR);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.$('run-error').hidden, false);
  assert.equal(h.$('run-error').textContent, WORKFLOW_ERROR);
  assert.equal(h.row('oscar').box.getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.row('oscar').box);

  await h.toggle('angela', true);
  assert.equal(h.$('f-gates-summary').dataset.tone, '');
  assert.equal(h.row('oscar').box.getAttribute('aria-invalid'), null);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['angela']] });
});

test('drawer: a stage out of range is an error on that stage, and nothing is sent', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.pick(Object.fromEntries(ROLES5.map((r) => [r, GPT])));
  await h.stage('hank', 7);
  assert.equal(h.$('f-gates-summary').textContent, "Hank's stage must be a whole number from 1 to 3.");
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.row('hank').stage.getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.row('hank').stage);
  assert.equal(h.storage.map.has(WORKFLOW_KEY), false, 'the bad number is never kept');
  await h.stage('hank', 2);
  assert.deepEqual(JSON.parse(h.storage.map.get(WORKFLOW_KEY)), stages({ oscar: 1, hank: 2, angela: 2 }));
});

test('drawer: the choice is kept like the model choice; a choice without any gate is not', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.stage('hank', 2);
  assert.deepEqual(JSON.parse(h.storage.map.get(WORKFLOW_KEY)), stages({ oscar: 1, hank: 2, angela: 2 }));
  await h.toggle('oscar', false);
  await h.toggle('hank', false);
  await h.toggle('angela', false);
  assert.deepEqual(JSON.parse(h.storage.map.get(WORKFLOW_KEY)), stages({ angela: 1 }), 'the last choice with a gate, as its stages');

  const again = harness({ stored: stages({ hank: 1, angela: 2 }) });
  t.after(() => again.panel.setMode('demo'));
  assert.deepEqual(again.shown(), { oscar: 0, hank: 1, angela: 2 }, 'a reload opens on the stored choice');
  const old = harness({ stored: legacy({ review: false, parallel: false }) });
  t.after(() => old.panel.setMode('demo'));
  assert.deepEqual(old.shown(), { oscar: 0, hank: 1, angela: 2 }, 'the three-box choice of before opens as its stages');
});

test('drawer: a demo sends no workflow and needs no model', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-demo').checked = true;
  await h.$('f-demo').fire('change');
  h.$('f-scenario').value = 'happy';
  assert.equal(h.row('oscar').box.disabled, true);
  assert.equal(h.row('oscar').stage.disabled, true);
  assert.equal(h.$('f-gates-summary').textContent, 'A demo runs its scripted agents; no gate choice is sent.');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.workflow, undefined);
  assert.equal(h.posts[0].body.models, undefined);
});

test('drawer: the server 400 for Oscar and Hank marks their selects', async (t) => {
  const h = harness({ reject: SERVER('oscar, hank') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.sandbox(true);
  await h.pick(Object.fromEntries(ROLES5.map((r) => [r, GPT])));
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.$('f-model-oscar').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-hank').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-angela').getAttribute('aria-invalid'), null);
  assert.equal(globalThis.document.activeElement, h.$('f-model-oscar'));
});

test('follow-up: the drawer\'s gates go along, and the Docker check covers them', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const r = await h.panel.startFollowUp('Next step');
  assert.deepEqual(h.posts, []);
  assert.equal(r.options, true);
  assert.match(r.error, /does not report them\. Set a model for each agent in Agents\./);

  await h.toggle('oscar', false);
  await h.toggle('hank', false);
  await h.toggle('angela', false);
  const none = await h.panel.startFollowUp('Next step');
  assert.deepEqual(none, { error: WORKFLOW_ERROR, field: 'workflow', fields: [], options: true });

  await h.toggle('angela', true);
  h.$('f-sandbox-host').checked = true;
  h.$('f-trusted').checked = true;
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['angela']] });
});

// ------------------------------------------------------------ the server's configured workflow

const configured = (gates) => ({ ...CONTROL, defaults: { workflow: { gates }, models: Object.fromEntries(ROLES5.map((r) => [r, PICK])) } });
const ALL = Object.fromEntries(ROLES5.map((r) => [r, GPT]));

test('configuredChoice: the engine default means nothing is configured; other gates become the stages', () => {
  assert.equal(configuredChoice(null), null);
  assert.equal(configuredChoice({ gates: [['angela']] }), null, 'what a server without configuration reports');
  assert.deepEqual(configuredChoice({ gates: [['oscar'], ['angela']] }), stages({ oscar: 1, angela: 2 }));
  assert.deepEqual(configuredChoice({ gates: [['oscar'], ['hank']] }), stages({ oscar: 1, hank: 2 }));
  assert.deepEqual(configuredChoice({ gates: [['hank'], ['oscar']] }), stages({ hank: 1, oscar: 2 }), 'any stage order is a set of numbers');
  // an order inside a stage the catalog does not have is kept as it is
  const odd = configuredChoice({ gates: [['hank', 'oscar']] });
  assert.deepEqual(odd.gates, [['hank', 'oscar']]);
  assert.deepEqual(workflowGates(odd), [['hank', 'oscar']]);
  assert.equal(workflowNote({ gates: [['angela']] }, [['oscar', 'hank'], ['angela']]), '', 'the engine default is no configuration');
  assert.equal(workflowNote({ gates: [['oscar']] }, [['oscar']]), '');
  assert.equal(workflowNote({ gates: [['oscar']] }, [['oscar', 'hank'], ['angela']]),
    "The server's configuration sets Review. A run started here uses the gates above.");
});

test('drawer: with no stored choice the configured workflow is what a run sends, and no note', async (t) => {
  const h = harness({ control: configured([['oscar'], ['angela']]) });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(h.shown(), { oscar: 1, hank: 0, angela: 2 });
  assert.equal(h.$('f-gates-summary').textContent, 'Review \u2192 Tests, after each developer turn');
  assert.equal(h.$('f-gates-config').hidden, true);
  await h.pick(ALL);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['oscar'], ['angela']] }, 'not the full pipeline over the configuration');
  assert.equal(h.storage.map.has(WORKFLOW_KEY), false, 'adopting the configuration stores nothing');
});

test('drawer: a configured order the stage numbers cannot say is sent exactly, until the human picks', async (t) => {
  const h = harness({ control: configured([['hank', 'oscar']]) });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-gates-summary').textContent, 'Security + Review, after each developer turn');
  await h.pick(ALL);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['hank', 'oscar']] });
  await h.toggle('angela', true);
  assert.deepEqual(JSON.parse(h.storage.map.get(WORKFLOW_KEY)), stages({ oscar: 1, hank: 1, angela: 2 }), 'the rows say the choice now');
  assert.deepEqual(h.panel.snapshot().control.workflow, { gates: [['hank', 'oscar']] });
  assert.match(h.$('f-gates-config').textContent, /sets Security \+ Review\./);
});

test('drawer: the engine default as defaults.workflow leaves the full pipeline; a stored choice wins with a quiet note', async (t) => {
  const plain = harness({ control: configured([['angela']]) });
  t.after(() => plain.panel.setMode('demo'));
  await plain.open();
  assert.equal(plain.$('f-gates-summary').textContent, 'Review + Security \u2192 Tests, after each developer turn');
  assert.equal(plain.$('f-gates-config').hidden, true);

  const h = harness({ control: configured([['oscar'], ['angela']]), stored: stages({ oscar: 1, hank: 2, angela: 3 }) });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-gates-summary').textContent, 'Review \u2192 Security \u2192 Tests, after each developer turn');
  assert.equal(h.$('f-gates-config').hidden, false);
  assert.equal(h.$('f-gates-config').textContent, "The server's configuration sets Review \u2192 Tests. A run started here uses the gates above.");
  await h.pick(ALL);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['oscar'], ['hank'], ['angela']] }, 'the stored choice wins');
});
