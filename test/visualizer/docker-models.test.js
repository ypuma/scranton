// A Docker run uses the agent default of every role it starts and needs one for each (src/core/sandbox.js
// validateDockerModels): the drawer and the follow-up composer stop a run with a gap before posting it and point at
// Agents; a model picked in the drawer is for the trusted host only. The server's 400 points at the selects it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { createModelPicker } from '../../visualizer/public/js/accounts-panel.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createState } from '../../visualizer/public/js/state.js';
import {
  DOCKER_MODELS_NOTE, DOCKER_DEFAULTS_NOTE, PI_DEFAULT_NOTE, parseModels, modelKey, buildModels, dockerGaps, dockerNote, piDefaultLabel, runRoles,
  planNote, usesAgentDefaults,
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
// a workspace configured for Docker: the drawer opens on it
const DOCKER = { execution: { sandbox: { mode: 'docker' } } };
// a server that reports no agent defaults, in a Docker workspace
const NO_DEFAULTS = { ...CONTROL, defaults: DOCKER };
// a current server: Michael's model comes from Scranton's configuration, the others have none
const CONFIGURED = { ...CONTROL, defaults: { ...DOCKER, models: { michael: SOL, dwight: null, angela: null } } };
const EVERY = { ...CONTROL, defaults: { ...DOCKER, models: { michael: SOL, dwight: SOL, angela: SOL } } };

test('dockerGaps: Docker needs an agent default for every role it starts; the trusted host and a demo need none', () => {
  const every = { michael: SOL, dwight: SOL, angela: SOL };
  assert.deepEqual(dockerGaps({ configured: every }), []);
  assert.deepEqual(dockerGaps({ configured: { ...every, dwight: null } }), ['dwight']);
  assert.deepEqual(dockerGaps({}), ['michael', 'dwight', 'angela'], 'an older server reports no defaults');
  assert.deepEqual(dockerGaps({ host: true }), []);
  assert.deepEqual(dockerGaps({ demo: true }), []);
  assert.deepEqual(runRoles({ noPlan: true }), ['dwight', 'angela']);
  assert.deepEqual(dockerGaps({ noPlan: true }), ['dwight', 'angela'], 'without a plan Michael does not run');
  assert.deepEqual(dockerGaps({ noPlan: true, configured: { ...every, michael: null } }), []);
  assert.equal(usesAgentDefaults({}), true);
  assert.equal(usesAgentDefaults({ host: true }), false);
  assert.equal(usesAgentDefaults({ demo: true }), false);
});

test('dockerGaps: a role with an agent default is no gap; the labels and notes say what Docker uses and point to Agents', () => {
  const configured = { michael: SOL, dwight: null, angela: null };
  assert.deepEqual(dockerGaps({ configured }), ['dwight', 'angela']);
  assert.deepEqual(dockerGaps({ configured: null }), ['michael', 'dwight', 'angela'], 'an older server');
  assert.deepEqual(dockerGaps({ configured, host: true }), []);
  assert.equal(piDefaultLabel(configured, 'michael'), 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(piDefaultLabel(configured, 'michael', true), 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(piDefaultLabel(configured, 'dwight'), 'pi default');
  assert.equal(piDefaultLabel(configured, 'dwight', true), 'No agent default', 'Docker never offers pi default');
  assert.equal(piDefaultLabel(null, 'michael'), 'pi default');
  assert.equal(piDefaultLabel(null, 'michael', true), 'Agent default', 'an older server: unknown, not none');
  assert.equal(dockerNote(['dwight', 'angela'], null), DOCKER_MODELS_NOTE, 'an older server keeps its note');
  assert.match(DOCKER_MODELS_NOTE, /in Agents\.$/);
  assert.equal(dockerNote([], configured), '');
  assert.equal(dockerNote(['dwight', 'angela'], configured),
    'The Docker sandbox runs every agent on its agent default, and Dwight and Angela have none. Set one for each in Agents.');
  assert.equal(dockerNote(['angela'], configured), 'The Docker sandbox runs every agent on its agent default, and Angela has none. Set one in Agents.');
  assert.doesNotMatch(dockerNote(['angela'], configured), /ChatGPT|Michael|Pick/);
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

test('buildModels in Docker: a picked or saved model is never sent; the agent defaults decide', () => {
  const cat = parseModels(CATALOG);
  const docker = { demo: false, host: false, noPlan: false, configured: { michael: SOL, dwight: SOL, angela: SOL } };
  assert.deepEqual(buildModels(ALL, cat, docker), { models: {} }, 'the agent defaults win over the picks');
  assert.deepEqual(buildModels({ angela: modelKey('openai', 'gone') }, cat, docker), { models: {} }, 'a stale pick is no error in Docker');
  assert.deepEqual(buildModels({ angela: 'garbage' }, null, docker), { models: {} }, 'nor is a model list that failed to load');
  const r = buildModels(ALL, cat, { ...docker, configured: { michael: SOL, dwight: null, angela: null } });
  assert.equal(r.field, 'models.dwight', 'a pick does not fill a missing agent default');
  assert.deepEqual(r.fields, ['models.dwight', 'models.angela']);
  assert.match(r.error, /Dwight and Angela have none\. Set one for each in Agents\./);
  assert.doesNotMatch(r.error, /Michael/);
  const old = buildModels(NONE, cat, { demo: false, host: false });
  assert.deepEqual([old.field, old.fields, old.error], ['models.michael', ['models.michael', 'models.dwight', 'models.angela'], DOCKER_MODELS_NOTE]);
  assert.deepEqual(buildModels(ALL, cat, { ...docker, configured: { michael: null, dwight: SOL, angela: SOL }, noPlan: true }), { models: {} },
    'without a plan Michael needs no default');
});

test('buildModels on the trusted host: the picks are checked and sent as before; a demo sends none', () => {
  const cat = parseModels(CATALOG);
  const host = { demo: false, host: true, noPlan: false, configured: { michael: SOL, dwight: null, angela: null } };
  assert.deepEqual(buildModels(NONE, cat, host), { models: {} }, 'the trusted host keeps the defaults');
  assert.deepEqual(buildModels(ALL, cat, host).models, { michael: { provider: 'openai', model: 'gpt-a' }, dwight: { provider: 'openai', model: 'gpt-a' }, angela: { provider: 'openai', model: 'gpt-a' } });
  assert.deepEqual(buildModels({ ...NONE, dwight: GPT }, cat, { ...host, noPlan: true }).models, { dwight: { provider: 'openai', model: 'gpt-a' } });
  assert.equal(buildModels({ angela: 'garbage' }, cat, host).field, 'models.angela', 'an unavailable model is named');
  assert.match(buildModels({ angela: modelKey('openai', 'gone') }, cat, host).error, /Angela's model is not available/);
  assert.deepEqual(buildModels(ALL, cat, { ...host, host: false, demo: true }), { models: {} }, 'a demo uses no model');
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
  const host = async () => {
    $('f-sandbox-host').checked = true;
    await $('f-sandbox-host').fire('change');
    $('f-trusted').checked = true;
  };
  return { $, panel, posts, pick, host, tick: () => new Promise((r) => setTimeout(r, 10)) };
}

async function openDrawer(h) {
  h.panel.setMode('live');
  await h.tick();
  h.panel.openRun();
  await h.tick();
  h.$('f-request').value = 'Build it';
}

test('drawer: a server that reports no agent defaults refuses Docker with its note; the trusted host and a demo run', async (t) => {
  const h = harness({ control: NO_DEFAULTS });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  assert.equal(h.$('models-need').hidden, false);
  assert.equal(h.$('models-need-text').textContent, DOCKER_MODELS_NOTE);
  assert.equal(h.$('f-model-michael').disabled, true, 'Docker picks no model');
  assert.equal(h.$('f-model-michael').childNodes[0].textContent, 'Agent default');
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.$('run-error').textContent, DOCKER_MODELS_NOTE);
  for (const role of ['michael', 'dwight', 'angela']) assert.equal(h.$(`f-model-${role}`).getAttribute('aria-invalid'), 'true', role);

  await h.host();
  assert.equal(h.$('models-need').hidden, true);
  assert.equal(h.$('f-model-michael').disabled, false);
  assert.equal(h.$('f-model-michael').childNodes[0].textContent, 'pi default');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.sandbox, 'host');
  assert.equal(h.posts[0].body.models, undefined);

  const demo = harness();
  t.after(() => demo.panel.setMode('demo'));
  await openDrawer(demo);
  demo.$('f-demo').checked = true;
  await demo.$('f-demo').fire('change');
  demo.$('f-scenario').value = 'happy';
  assert.equal(demo.$('models-need').hidden, true, 'the scripted demo needs no model');
  await demo.$('run-form').fire('submit');
  assert.equal(demo.posts.length, 1);
  assert.equal(demo.posts[0].body.demo.scenario, 'happy');
  assert.equal(demo.posts[0].body.sandbox, undefined);
  assert.equal(demo.posts[0].body.models, undefined);
});

test('drawer: the server\'s 400 marks the role selects it names', async (t) => {
  const h = harness({ reject: SERVER('dwight, angela') });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  await h.host();
  await h.pick(ALL);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.match(h.$('run-error').textContent, /^Docker requires an explicit provider and model for dwight, angela/);
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-angela').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null);
  assert.equal(globalThis.document.activeElement, h.$('f-model-dwight'));
});

test('follow-up: Docker without agent defaults posts nothing and says why, with the fix in Options', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const r = await h.panel.startFollowUp('Next step');
  assert.deepEqual(h.posts, []);
  assert.equal(r.options, true);
  assert.equal(r.field, 'models.dwight');
  assert.deepEqual(r.fields, ['models.dwight', 'models.angela']);
  assert.match(r.error, /Dwight and Angela have none\. Set one for each in Agents\./);
  assert.equal(h.$('run-dialog').open, false, 'the composer says it; the drawer opens only when asked');

  await h.host();
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true }, 'the trusted host keeps pi default');
  assert.equal(h.posts[0].body.sandbox, 'host');
});

test('follow-up: a server 400 about models also leads to Options', async (t) => {
  const h = harness({ reject: SERVER('michael, dwight, angela') });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  await h.host();
  await h.pick(ALL);
  const r = await h.panel.startFollowUp('Next step');
  assert.equal(h.posts.length, 1);
  assert.equal(r.options, true);
  assert.equal(r.field, 'models.michael');
  assert.deepEqual(r.fields, ['models.michael', 'models.dwight', 'models.angela']);
});

test('composer: the reason goes to its status line, and Open Options shows it on the select', async (t) => {
  const h = harness({ control: NO_DEFAULTS });
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
  assert.equal(h.$('followup-status').textContent, DOCKER_MODELS_NOTE);
  assert.equal(h.$('followup-status').dataset.tone, 'error');
  assert.equal(h.$('followup-fix').hidden, false);
  assert.equal(globalThis.document.activeElement, h.$('followup-fix'));

  await h.$('followup-fix').fire('click');
  assert.equal(h.$('run-dialog').open, true);
  assert.equal(h.$('f-request').value, 'Next step');
  assert.equal(h.$('run-error').textContent, DOCKER_MODELS_NOTE);
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('f-model-michael').disabled, true, 'Docker keeps the select locked');
  assert.equal(h.$('run-error').getAttribute('tabindex'), '-1');
  assert.equal(globalThis.document.activeElement, h.$('run-error'), 'no Agents drawer here: the message, never the locked select');
});

test('drawer: an agent default shows on its locked select in Docker, and only the roles without one are refused', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  const def = (role) => h.$(`f-model-${role}`).childNodes[0];
  assert.equal(def('michael').textContent, 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(def('dwight').textContent, 'No agent default');
  assert.equal(h.$('models-need').hidden, false);
  assert.match(h.$('models-need-text').textContent, /Dwight and Angela have none\./);
  assert.equal(h.$('models-note').textContent, DOCKER_DEFAULTS_NOTE);

  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.$('f-model-michael').getAttribute('aria-invalid'), null, 'the configured role is not marked');
  assert.equal(h.$('f-model-dwight').getAttribute('aria-invalid'), 'true');

  await h.host();
  assert.equal(def('dwight').textContent, 'pi default');
  assert.equal(h.$('models-note').textContent.includes(PI_DEFAULT_NOTE), true);
  assert.doesNotMatch(h.$('models-note').textContent, /agent configuration/);
  await h.pick({ dwight: GPT });
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.sandbox, 'host');
  assert.deepEqual(h.posts[0].body.models, { dwight: { provider: 'openai', model: 'gpt-a' } }, 'Michael is sent on his agent default');
});

test('drawer: agent defaults hold for a run in any folder', async (t) => {
  const h = harness({ control: CONFIGURED });
  t.after(() => h.panel.setMode('demo'));
  await openDrawer(h);
  for (const folder of ['C:/WORK/core/', 'D:\\other']) {
    h.$('f-workspace').value = folder;
    await h.$('f-workspace').fire('input');
    assert.equal(h.$('models-need').hidden, false, folder);
    assert.match(h.$('models-need-text').textContent, /Dwight and Angela have none\./, folder);
    assert.equal(h.$('f-model-michael').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)', folder);
  }
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, [], 'the roles without a default are still refused in another folder');
});

test('follow-up: every role with an agent default posts no models in Docker, even after picks; one without is refused', async (t) => {
  const all = harness({ control: EVERY });
  t.after(() => all.panel.setMode('demo'));
  all.panel.setMode('live');
  await all.tick();
  await all.pick(ALL);
  assert.deepEqual(await all.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(all.posts[0].body.sandbox, 'docker');
  assert.equal(all.posts[0].body.models, undefined);

  const some = harness({ control: CONFIGURED });
  t.after(() => some.panel.setMode('demo'));
  some.panel.setMode('live');
  await some.tick();
  await some.pick(ALL);
  const r = await some.panel.startFollowUp('Next step');
  assert.deepEqual(some.posts, []);
  assert.equal(r.field, 'models.dwight');
  assert.deepEqual(r.fields, ['models.dwight', 'models.angela']);
});
