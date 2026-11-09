// A Docker run needs an explicit model for every role it starts (src/core/sandbox.js validateDockerModels): the
// drawer and the follow-up composer stop such a run before posting it, and the server's 400 points at the
// model selects it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { createModelPicker } from '../../visualizer/public/js/accounts-panel.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createState } from '../../visualizer/public/js/state.js';
import {
  DOCKER_MODELS_NOTE, PI_DEFAULT_NOTE, parseModels, modelKey, buildModels, dockerGaps, dockerNote, piDefaultLabel, runRoles, planNote,
} from '../../visualizer/public/js/accounts.js';
import { errorField, modelErrorRoles, parseControl, WORKFLOW_KEY } from '../../visualizer/public/js/control.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const CATALOG = { providers: [{ id: 'openai', label: 'ChatGPT', signedIn: true, models: [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-b', name: 'GPT B' }] }] };
const GPT = modelKey('openai', 'gpt-a');
const ALL = { michael: GPT, dwight: GPT, angela: GPT };
const NONE = { michael: '', dwight: '', angela: '' };
const SERVER = (roles) => `Docker requires an explicit provider and model for ${roles}; choose a ChatGPT model for each role in Options → Models (not pi default), or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL`;
// the provider-neutral wording of the current server
const NEUTRAL = (roles) => `Docker requires an explicit provider and model for ${roles}; choose a model for each role in Options → Models (pi default cannot be used in the Docker sandbox), or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL`;
const CONTROL = {
  v: 1, enabled: true, workspace: 'C:\\work\\core', scenarios: ['happy'], run: null, lastExit: null, pendingHuman: null,
  instances: {}, recoveryRequired: false,
};
const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
// a current server: Michael's model comes from Scranton's configuration, the others have none
const CONFIGURED = { ...CONTROL, defaults: { models: { michael: SOL, dwight: null, angela: null } } };

test('dockerGaps: Docker needs every role it starts; the trusted host and a demo need none', () => {
  assert.deepEqual(dockerGaps(NONE, {}), ['michael', 'dwight', 'angela']);
  assert.deepEqual(dockerGaps({ ...ALL, dwight: '' }, {}), ['dwight']);
  assert.deepEqual(dockerGaps(ALL, {}), []);
  assert.deepEqual(dockerGaps(NONE, { host: true }), []);
  assert.deepEqual(dockerGaps(NONE, { demo: true }), []);
  assert.deepEqual(runRoles({ noPlan: true }), ['dwight', 'angela']);
  assert.deepEqual(dockerGaps(NONE, { noPlan: true }), ['dwight', 'angela'], 'without a plan Michael does not run');
  assert.deepEqual(dockerGaps({ ...NONE, dwight: GPT, angela: GPT }, { noPlan: true }), []);
});

test('dockerGaps: a role Scranton\'s configuration gives a model is no gap; an older server keeps every pi default a gap', () => {
  const configured = { michael: SOL, dwight: null, angela: null };
  assert.deepEqual(dockerGaps(NONE, { configured }), ['dwight', 'angela']);
  assert.deepEqual(dockerGaps({ ...NONE, dwight: GPT }, { configured }), ['angela']);
  assert.deepEqual(dockerGaps(NONE, { configured: { michael: SOL, dwight: SOL, angela: SOL } }), []);
  assert.deepEqual(dockerGaps(NONE, { configured: null }), ['michael', 'dwight', 'angela'], 'an older server');
  assert.deepEqual(dockerGaps(NONE, { configured, host: true }), []);
  assert.equal(piDefaultLabel(configured, 'michael'), 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(piDefaultLabel(configured, 'dwight'), 'pi default');
  assert.equal(piDefaultLabel(null, 'michael'), 'pi default');
  assert.equal(dockerNote(['dwight', 'angela'], null), DOCKER_MODELS_NOTE, 'an older server keeps its note');
  assert.equal(dockerNote([], configured), '');
  assert.match(dockerNote(['dwight', 'angela'], configured), /^The Docker sandbox needs a model for Dwight and Angela\. Scranton's configuration sets none/);
  assert.doesNotMatch(dockerNote(['angela'], configured), /ChatGPT|Michael/);
});

test('parseControl: defaults.models keeps only string provider/model pairs; an older server reports none', () => {
  const c = parseControl({ ...CONTROL, defaults: { models: {
    michael: { provider: 'openai', model: 'gpt-6.1-sol\u202E' }, dwight: { provider: 'openai', model: 7 }, angela: 'openai/gpt',
    oscar: { provider: 'x', model: 'y' },
  } } });
  assert.deepEqual(c.models, { michael: SOL, dwight: null, oscar: { provider: 'x', model: 'y' }, hank: null, angela: null });
  assert.deepEqual(parseControl({ ...CONTROL, defaults: { models: { michael: { provider: '', model: 'm' } } } }).models,
    { michael: null, dwight: null, oscar: null, hank: null, angela: null });
  assert.equal(parseControl(CONTROL).models, null);
  assert.equal(parseControl({ ...CONTROL, defaults: { models: [SOL] } }).models, null);
  assert.equal(parseControl(null).models, null);
});

test('buildModels with a run: a configured role passes in Docker, an unconfigured one is still blocked', () => {
  const cat = parseModels(CATALOG);
  const configured = { michael: SOL, dwight: null, angela: null };
  const r = buildModels(NONE, cat, { demo: false, host: false, noPlan: false, configured });
  assert.equal(r.field, 'models.dwight');
  assert.deepEqual(r.fields, ['models.dwight', 'models.angela']);
  assert.doesNotMatch(r.error, /Michael/);
  assert.deepEqual(buildModels({ ...NONE, dwight: GPT, angela: GPT }, cat, { demo: false, host: false, noPlan: false, configured }).models,
    { dwight: { provider: 'openai', model: 'gpt-a' }, angela: { provider: 'openai', model: 'gpt-a' } }, 'Michael stays on his agent default');
});

test('buildModels with a run: Docker on pi default is blocked at the first such select', () => {
  const cat = parseModels(CATALOG);
  const docker = { demo: false, host: false, noPlan: false };
  const r = buildModels(NONE, cat, docker);
  assert.equal(r.field, 'models.michael');
  assert.deepEqual(r.fields, ['models.michael', 'models.dwight', 'models.angela']);
  assert.match(r.error, /Docker sandbox needs a model for Michael, Dwight and Angela\. Pick one for each \(pi default only works on the trusted host\)/);
  assert.equal(buildModels({ ...ALL, angela: '' }, cat, docker).error.includes('for Angela. Pick one ('), true);
  assert.deepEqual(buildModels(ALL, cat, docker).models, { michael: { provider: 'openai', model: 'gpt-a' }, dwight: { provider: 'openai', model: 'gpt-a' }, angela: { provider: 'openai', model: 'gpt-a' } });
  assert.deepEqual(buildModels(NONE, cat, { ...docker, host: true }), { models: {} }, 'trusted host keeps pi default');
  assert.deepEqual(buildModels(NONE, cat, { ...docker, demo: true }), { models: {} }, 'a demo uses no model');
  assert.equal(buildModels(NONE, cat, { ...docker, noPlan: true }).field, 'models.dwight');
  assert.deepEqual(buildModels({ ...NONE, dwight: GPT, angela: GPT }, cat, { ...docker, noPlan: true }).models,
    { dwight: { provider: 'openai', model: 'gpt-a' }, angela: { provider: 'openai', model: 'gpt-a' } });
  assert.equal(buildModels({ angela: 'garbage' }, cat, docker).field, 'models.angela', 'an unavailable model is still named first');
});

test('the server\'s Docker model message points at the role selects it names', () => {
  assert.deepEqual(modelErrorRoles(SERVER('michael, dwight, angela')), ['michael', 'dwight', 'angela']);
  assert.equal(errorField(SERVER('michael, dwight, angela')), 'models.michael');
  assert.deepEqual(modelErrorRoles(SERVER('dwight, angela')), ['dwight', 'angela']);
  assert.equal(errorField(SERVER('dwight, angela')), 'models.dwight');
  assert.deepEqual(modelErrorRoles(SERVER('angela')), ['angela']);
  assert.equal(errorField(SERVER('angela')), 'models.angela');
  assert.deepEqual(modelErrorRoles(NEUTRAL('michael, dwight')), ['michael', 'dwight']);
  assert.equal(errorField(NEUTRAL('michael, dwight')), 'models.michael');
  assert.deepEqual(modelErrorRoles(NEUTRAL('angela')), ['angela']);
  assert.deepEqual(modelErrorRoles('Invalid model selection'), []);
  assert.deepEqual(modelErrorRoles(undefined), []);
});

test('planNote: only for a signed-in subscription with models, and it names no model', () => {
  const cat = parseModels(CATALOG);
  const oauth = [{ id: 'openai', kind: 'oauth', status: 'signed_in' }];
  const note = planNote(cat, oauth);
  assert.equal(note, 'Not every listed model is included in every ChatGPT plan. If a run reports a permission error, pick another model.');
  assert.doesNotMatch(note, /gpt-/);
  assert.equal(planNote(cat, [{ id: 'openai', kind: 'api_key', status: 'signed_in' }]), '', 'an API key has no plan');
  assert.equal(planNote(cat, [{ id: 'openai', kind: 'oauth', status: 'expired' }]), '');
  assert.equal(planNote(cat, null), '', 'unknown accounts claim nothing');
  assert.equal(planNote(null, oauth), '');
});

// The control panel with the real model picker; posts lists every POST. reject: the 400 message the server sends.
function harness({ reject = null, control = CONTROL } = {}) {
  const $ = installDom();
  // these tests are about the three roles of a run with the tests alone; workflow.test.js covers the gates
  const kept = new Map([[WORKFLOW_KEY, JSON.stringify({ stages: { angela: 1 } })]]);
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      return reject
        ? { ok: false, status: 400, json: async () => ({ error: reject }) }
        : { ok: true, status: 202, json: async () => ({ pid: 9, runId: 'run-new' }) };
    }
    if (url === '/api/models') return { ok: true, status: 200, json: async () => CATALOG };
    return { ok: true, status: 200, json: async () => control };
  };
  const models = createModelPicker({ openAccounts() {}, canOpenAccounts: () => false });
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({
    dashboard: stub, pipeline: stub, lanes: stub, models, getState: () => createState(),
    url: (suffix) => `/api/projects/core/chats/a/${suffix}`,
  });
  const pick = (values) => Promise.all(Object.entries(values).map(([role, v]) => {
    $(`f-model-${role}`).value = v;
    return $(`f-model-${role}`).fire('change');
  }));
  return { $, panel, posts, pick, tick: () => new Promise((r) => setTimeout(r, 10)) };
}

async function openDrawer(h) {
  h.panel.setMode('live');
  await h.tick();
  h.panel.openRun();
  await h.tick();
  h.$('f-request').value = 'Build it';
}

test('drawer: Docker with a role on pi default shows the note, refuses the submit and focuses the first select', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  assert.equal(h.$('models-need').hidden, false);
  assert.equal(h.$('models-need').textContent, DOCKER_MODELS_NOTE);
  await h.pick({ michael: GPT });
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.match(h.$('run-error').textContent, /needs a model for Dwight and Angela/);
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-angela').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null);
  assert.equal(globalThis.document.activeElement, h.$('f-model-dwight'));

  await h.pick({ dwight: GPT, angela: GPT });
  assert.equal(h.$('models-need').hidden, true, 'every role has a model');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.deepEqual(Object.keys(h.posts[0].body.models), ['michael', 'dwight', 'angela']);
  assert.equal(h.posts[0].body.sandbox, 'docker');
});

test('drawer: trusted host, a demo and a run without a plan are not blocked by pi default', async (t) => {
  const host = harness();
  t.after(() => host.panel.setMode('demo'));
  await openDrawer(host);
  host.$('f-sandbox-host').checked = true;
  await host.$('f-sandbox-host').fire('change');
  host.$('f-trusted').checked = true;
  assert.equal(host.$('models-need').hidden, true);
  await host.$('run-form').fire('submit');
  assert.equal(host.posts.length, 1);
  assert.equal(host.posts[0].body.sandbox, 'host');
  assert.equal(host.posts[0].body.models, undefined);

  const demo = harness();
  t.after(() => demo.panel.setMode('demo'));
  await openDrawer(demo);
  demo.$('f-demo').checked = true;
  await demo.$('f-demo').fire('change');
  demo.$('f-scenario').value = 'happy';
  assert.equal(demo.$('models-need').hidden, true);
  await demo.$('run-form').fire('submit');
  assert.equal(demo.posts.length, 1);
  assert.equal(demo.posts[0].body.demo.scenario, 'happy');
  assert.equal(demo.posts[0].body.sandbox, undefined);
  assert.equal(demo.posts[0].body.models, undefined);

  const noPlan = harness();
  t.after(() => noPlan.panel.setMode('demo'));
  await openDrawer(noPlan);
  noPlan.$('f-noplan').checked = true;
  await noPlan.$('f-noplan').fire('change');
  await noPlan.pick({ dwight: GPT });
  assert.equal(noPlan.$('models-need').hidden, false, 'Angela still runs');
  await noPlan.$('run-form').fire('submit');
  assert.deepEqual(noPlan.posts, []);
  assert.equal(globalThis.document.activeElement, noPlan.$('f-model-angela'));
  await noPlan.pick({ angela: GPT });
  assert.equal(noPlan.$('models-need').hidden, true, 'Michael is not needed without a plan');
  await noPlan.$('run-form').fire('submit');
  assert.equal(noPlan.posts.length, 1);
  assert.equal(noPlan.posts[0].body.noPlan, true);
});

test('drawer: the server\'s 400 marks the role selects it names', async (t) => {
  const h = harness({ reject: SERVER('dwight, angela') });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  await h.pick(ALL);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.match(h.$('run-error').textContent, /^Docker requires an explicit provider and model for dwight, angela/);
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-angela').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null);
  assert.equal(globalThis.document.activeElement, h.$('f-model-dwight'));
});

test('follow-up: Docker with pi default posts nothing and says why, with the fix in Options', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const r = await h.panel.startFollowUp('Next step');
  assert.deepEqual(h.posts, []);
  assert.equal(r.options, true);
  assert.equal(r.field, 'models.michael');
  assert.match(r.error, /Docker sandbox needs a model for Michael, Dwight and Angela/);
  assert.equal(h.$('run-dialog').open, false, 'the composer says it; the drawer opens only when asked');

  h.$('f-sandbox-host').checked = true;
  h.$('f-trusted').checked = true;
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true }, 'trusted host keeps pi default');
  assert.equal(h.posts[0].body.sandbox, 'host');
});

test('follow-up: a server 400 about models also leads to Options', async (t) => {
  const h = harness({ reject: SERVER('michael, dwight, angela') });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  // the first follow-up loads the model list, which refills the selects; pi default is refused before any POST
  await h.panel.startFollowUp('Next step');
  assert.deepEqual(h.posts, []);
  await h.pick(ALL);
  const r = await h.panel.startFollowUp('Next step');
  assert.equal(h.posts.length, 1);
  assert.equal(r.options, true);
  assert.equal(r.field, 'models.michael');
  assert.deepEqual(r.fields, ['models.michael', 'models.dwight', 'models.angela']);
});

test('composer: the reason goes to its status line, and Open Options shows it on the select', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  h.$('thread').querySelector = () => new FakeEl();
  const doc = { mode: 'projects', projects: [{ id: 'core', name: 'Core', workspace: 'C:\\work\\core', chats: [{ id: 'a', title: 'Chat a', status: 'idle', runs: 1 }] }] };
  const thread = createThread({
    scope: { get: () => ({ project: 'core', chat: 'a' }), url: () => null, gen: () => 1 },
    nav: { doc: () => doc, refresh() {}, rename() {}, newChat() {}, newProject() {} },
    control: h.panel, onReplay() {},
  });
  thread.activate();
  assert.equal(h.$('followup-fix').hidden, true);
  h.$('followup-text').value = 'Next step';
  await h.$('followup').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.match(h.$('followup-status').textContent, /Docker sandbox needs a model for Michael, Dwight and Angela/);
  assert.equal(h.$('followup-status').dataset.tone, 'error');
  assert.equal(h.$('followup-fix').hidden, false);
  assert.equal(globalThis.document.activeElement, h.$('followup-fix'));

  await h.$('followup-fix').fire('click');
  assert.equal(h.$('run-dialog').open, true);
  assert.equal(h.$('f-request').value, 'Next step');
  assert.match(h.$('run-error').textContent, /Docker sandbox needs a model/);
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('f-model-michael'));
});

test('drawer: a role with a configured model is not blocked in Docker and its pi default says what it uses', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  const def = (role) => h.$(`f-model-${role}`).childNodes[0];
  assert.equal(def('michael').textContent, 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(def('dwight').textContent, 'pi default');
  assert.equal(h.$('models-need').hidden, false);
  assert.match(h.$('models-need').textContent, /needs a model for Dwight and Angela\./);
  assert.equal(h.$('models-note').textContent.includes(PI_DEFAULT_NOTE), true);
  assert.doesNotMatch(h.$('models-note').textContent, /agent configuration/);

  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null, 'the configured role is not marked');
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('f-model-dwight'));

  await h.pick({ dwight: GPT, angela: GPT });
  assert.equal(h.$('models-need').hidden, true);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.sandbox, 'docker');
  assert.deepEqual(Object.keys(h.posts[0].body.models), ['dwight', 'angela'], 'Michael is sent on his agent default');
});

test('drawer: configured models hold for a run in any folder', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  for (const folder of ['C:/WORK/core/', 'D:\\other']) {
    h.$('f-workspace').value = folder;
    await h.$('f-workspace').fire('input');
    assert.equal(h.$('models-need').hidden, false, folder);
    assert.match(h.$('models-need').textContent, /for Dwight and Angela\./, folder);
    assert.equal(h.$('f-model-michael').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)', folder);
  }
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, [], 'the unconfigured roles are still refused in another folder');
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null);
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');

  await h.pick({ dwight: GPT, angela: GPT });
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.workspace, 'D:\\other');
  assert.deepEqual(Object.keys(h.posts[0].body.models), ['dwight', 'angela'], 'Michael is sent on his agent default');
});

test('follow-up: every role configured posts on pi default in Docker; one unconfigured role is still refused', async (t) => {
  const all = harness({ control: { ...CONTROL, defaults: { models: { michael: SOL, dwight: SOL, angela: SOL } } } });
  t.after(() => all.panel.setMode('demo'));
  all.panel.setMode('live');
  await all.tick();
  assert.deepEqual(await all.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(all.posts[0].body.sandbox, 'docker');
  assert.equal(all.posts[0].body.models, undefined);

  const some = harness({ control: CONFIGURED });
  t.after(() => some.panel.setMode('demo'));
  some.panel.setMode('live');
  await some.tick();
  const r = await some.panel.startFollowUp('Next step');
  assert.deepEqual(some.posts, []);
  assert.equal(r.field, 'models.dwight');
  assert.deepEqual(r.fields, ['models.dwight', 'models.angela']);
});
