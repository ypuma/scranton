// Docker is an optional tool executor: the model calls stay on this computer, so a Docker run needs no agent
// default per role and takes the drawer's model picks like any other sandbox. The Models section says where the
// credentials stay; the server's 400 about models still points at the selects it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { createModelPicker } from '../../visualizer/public/js/accounts-panel.js';
import { createState } from '../../visualizer/public/js/state.js';
import * as accounts from '../../visualizer/public/js/accounts.js';
import { errorField, modelErrorRoles, parseControl, WORKFLOW_KEY } from '../../visualizer/public/js/control.js';
import { installDom } from './fixtures/fake-dom.js';

const { DOCKER_NOTE, AUTOMATIC_NOTE, parseModels, modelKey, buildModels, defaultLabel, planNote } = accounts;
const CATALOG = { providers: [{ id: 'openai', label: 'ChatGPT', signedIn: true, models: [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-b', name: 'GPT B' }] }] };
const GPT = modelKey('openai', 'gpt-a');
const ALL = { michael: GPT, dwight: GPT, angela: GPT };
const NONE = { michael: '', dwight: '', angela: '' };
const A = { provider: 'openai', model: 'gpt-a' };
const SERVER = (roles) => `The run requires an explicit provider and model for ${roles}; choose a model for each role in Options → Models, or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL`;
const CONTROL = {
  v: 1, enabled: true, workspace: 'C:\\work\\core', scenarios: ['happy'], run: null, lastExit: null, pendingHuman: null,
  instances: {}, recoveryRequired: false,
};
const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
const DOCKER = { execution: { sandbox: { mode: 'docker' } } };
// a Docker workspace whose server reports no agent defaults, and one where only Michael has one
const NO_DEFAULTS = { ...CONTROL, defaults: DOCKER };
const CONFIGURED = { ...CONTROL, defaults: { ...DOCKER, models: { michael: SOL, dwight: null, angela: null } } };

test('the Docker gap logic is gone: no export refuses a role for a missing agent default', () => {
  for (const name of ['dockerGaps', 'dockerNote', 'usesAgentDefaults', 'piDefaultLabel', 'DOCKER_MODELS_NOTE', 'DOCKER_DEFAULTS_NOTE', 'DOCKER_KEY_NOTE', 'PI_DEFAULT_NOTE']) {
    assert.equal(Object.hasOwn(accounts, name), false, name);
  }
  assert.equal(defaultLabel({ michael: SOL }, 'michael'), 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(defaultLabel({ dwight: null }, 'dwight'), 'Automatic');
  assert.equal(defaultLabel(null, 'michael'), 'Automatic');
  assert.match(AUTOMATIC_NOTE, /runs on Automatic: the first signed-in account in this order: Claude, ChatGPT, Gemini, Google Antigravity\.$/);
  assert.doesNotMatch(AUTOMATIC_NOTE, /\bpi\b|trusted host/);
});

test('buildModels: the picks are checked and sent whatever the sandbox; a demo sends none', () => {
  const cat = parseModels(CATALOG);
  assert.deepEqual(buildModels(NONE, cat, { noPlan: false }), { models: {} }, 'every role on its default');
  assert.deepEqual(buildModels(ALL, cat, {}).models, { michael: A, dwight: A, angela: A });
  assert.deepEqual(buildModels({ ...NONE, dwight: GPT }, cat, { noPlan: true }).models, { dwight: A });
  assert.equal(buildModels({ angela: 'garbage' }, cat, {}).field, 'models.angela', 'an unavailable model is named');
  assert.equal(buildModels({ angela: modelKey('openai', 'gone') }, cat, {}).error, "Angela's model is not available any more. Pick another one or the default.");
  assert.deepEqual(buildModels(ALL, cat, { demo: true }), { models: {} }, 'a demo uses no model');
});

test('parseControl: defaults.models keeps only string provider/model pairs; an older server reports none', () => {
  const c = parseControl({ ...CONTROL, defaults: { models: {
    michael: { provider: 'openai', model: 'gpt-6.1-sol\u202E' }, dwight: { provider: 'openai', model: 7 }, angela: 'openai/gpt',
    oscar: { provider: 'x', model: 'y' },
  } } });
  assert.deepEqual(c.models, { michael: SOL, dwight: null, oscar: { provider: 'x', model: 'y' }, hank: null, angela: null });
  assert.equal(parseControl(CONTROL).models, null);
  assert.equal(parseControl({ ...CONTROL, defaults: { models: [SOL] } }).models, null);
});

test('the server\'s model message points at the role selects it names', () => {
  assert.deepEqual(modelErrorRoles(SERVER('michael, dwight, angela')), ['michael', 'dwight', 'angela']);
  assert.equal(errorField(SERVER('dwight, angela')), 'models.dwight');
  assert.deepEqual(modelErrorRoles(SERVER('angela')), ['angela']);
  assert.deepEqual(modelErrorRoles('Invalid model selection'), []);
  assert.deepEqual(modelErrorRoles(undefined), []);
});

test('planNote: only for a signed-in subscription with models, and it names no model', () => {
  const cat = parseModels(CATALOG);
  const oauth = [{ id: 'openai', kind: 'oauth', status: 'signed_in' }];
  assert.equal(planNote(cat, oauth), 'Not every listed model is included in every ChatGPT plan. If a run reports a permission error, pick another model.');
  assert.equal(planNote(cat, [{ id: 'openai', kind: 'api_key', status: 'signed_in' }]), '', 'an API key has no plan');
  assert.equal(planNote(cat, null), '', 'unknown accounts claim nothing');
});

// The control panel with the real model picker; posts lists every POST. reject: the 400 message the server sends.
function harness({ reject = null, control = CONTROL } = {}) {
  const $ = installDom();
  const kept = new Map([[WORKFLOW_KEY, JSON.stringify({ stages: { angela: 1 } })]]);
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      return reject ? { ok: false, status: 400, json: async () => ({ error: reject }) } : { ok: true, status: 202, json: async () => ({ pid: 9, runId: 'run-new' }) };
    }
    if (url === '/api/models') return { ok: true, status: 200, json: async () => CATALOG };
    return { ok: true, status: 200, json: async () => control };
  };
  const models = createModelPicker({ openAccounts() {}, canOpenAccounts: () => false });
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({ dashboard: stub, pipeline: stub, lanes: stub, models, getState: () => createState(), url: (s) => `/api/projects/core/chats/a/${s}` });
  const pick = (values) => Promise.all(Object.entries(values).map(([role, v]) => {
    $(`f-model-${role}`).value = v;
    return $(`f-model-${role}`).fire('change');
  }));
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const open = async () => {
    panel.setMode('live');
    await tick();
    panel.openRun();
    await tick();
    $('f-request').value = 'Build it';
  };
  return { $, panel, posts, pick, tick, open };
}

test('drawer: Docker without any agent default starts on Automatic, the selects open, and the credential note shown', async (t) => {
  const h = harness({ control: NO_DEFAULTS });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-sandbox-docker').checked, true);
  assert.equal(h.$('f-model-michael').disabled, false);
  assert.equal(h.$('f-model-michael').childNodes[0].textContent, 'Automatic');
  assert.equal(h.$('models-docker-note').hidden, false);
  assert.equal(h.$('models-docker-note').textContent, DOCKER_NOTE);
  assert.equal(h.$('models-note').textContent, `Only models of signed-in accounts and configured API keys can be picked. ${AUTOMATIC_NOTE}`);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1, 'nothing is refused for a missing agent default');
  assert.equal(h.posts[0].body.sandbox, 'docker');
  assert.equal(h.posts[0].body.models, undefined);
  assert.equal(h.$('run-error').textContent, '', 'no refusal was shown');
});

test('drawer: Docker sends the picks, and the note goes with the Scranton sandbox', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  const def = (role) => h.$(`f-model-${role}`).childNodes[0];
  assert.equal(def('michael').textContent, 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(def('dwight').textContent, 'Automatic');
  await h.pick({ dwight: GPT });
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.models, { dwight: A }, 'Michael is sent on his agent default');
  assert.equal(h.posts[0].body.sandbox, 'docker');

  h.$('f-sandbox-docker').checked = false;
  h.$('f-sandbox-scranton').checked = true;
  await h.$('f-sandbox-scranton').fire('change');
  assert.equal(h.$('models-docker-note').hidden, true);
});

test('drawer: the server\'s 400 marks the role selects it names, which can take the focus in Docker too', async (t) => {
  const h = harness({ control: NO_DEFAULTS, reject: SERVER('dwight, angela') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.pick(ALL);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-angela').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null);
  assert.equal(globalThis.document.activeElement, h.$('f-model-dwight'));
});

test('follow-up: Docker without agent defaults posts, with the picks; a demo stays scripted', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  await h.pick(ALL);
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(h.posts[0].body.sandbox, 'docker');
  assert.deepEqual(h.posts[0].body.models, { michael: A, dwight: A, angela: A });

  const demo = harness();
  t.after(() => demo.panel.setMode('demo'));
  await demo.open();
  demo.$('f-demo').checked = true;
  await demo.$('f-demo').fire('change');
  demo.$('f-scenario').value = 'happy';
  assert.equal(demo.$('models-note').textContent, 'A demo uses a scripted model; no real model is used.');
  await demo.$('run-form').fire('submit');
  assert.equal(demo.posts[0].body.demo.scenario, 'happy');
  assert.equal(demo.posts[0].body.sandbox, undefined);
  assert.equal(demo.posts[0].body.models, undefined);
});
