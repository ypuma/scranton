// A Docker run uses the agent default of every role it starts (GET /api/control defaults.models), never a model
// picked or saved in the New run drawer: the selects show the defaults and are locked, a role without one points to
// Agents, and the saved picks come back untouched on the trusted host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_DEFAULTS_NOTE, MODELS_KEY, modelKey } from '../../visualizer/public/js/accounts.js';
import { harness, CONTROL, CATALOG } from './fixtures/run-drawer.js';
import { FakeEl } from './fixtures/fake-dom.js';

// as in a browser, a disabled control does not take focus (the fake DOM's focus() accepts anything)
const fakeFocus = FakeEl.prototype.focus;
FakeEl.prototype.focus = function focus() {
  if (!this.disabled) fakeFocus.call(this);
};

const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
const PICK = { provider: 'openai', model: 'gpt-a' };
const GPT = modelKey('openai', 'gpt-a');
const SAVED = { michael: PICK, dwight: PICK, angela: PICK };
const entry = (id, name, title) => ({ id, name, title, kind: 'gate', builtin: false, gate: true, passKeyword: `${id.toUpperCase()}_PASSED`, failKeyword: `${id.toUpperCase()}_FAILED` });
const AGENTS = [
  { id: 'michael', name: 'Michael', title: 'Orchestrator', kind: 'planner', builtin: true, gate: false },
  { id: 'dwight', name: 'Dwight', title: 'Developer', kind: 'developer', builtin: true, gate: false },
  { id: 'oscar', name: 'Oscar', title: 'Reviewer', kind: 'gate', builtin: true, gate: true },
  { id: 'hank', name: 'Hank', title: 'Security', kind: 'gate', builtin: true, gate: true },
  { id: 'angela', name: 'Angela', title: 'QA', kind: 'gate', builtin: true, gate: true },
  entry('seclint', 'Seclint', 'Lint'),
  entry('docs2', 'Doris', 'Docs'),
];
const defaults = (models, agents) => ({ ...CONTROL, defaults: { models, ...(agents ? { agents } : {}) } });
const EVERY = defaults({ michael: SOL, dwight: SOL, oscar: SOL, hank: SOL, angela: SOL });
const ROLES = ['michael', 'dwight', 'angela'];
const saved = (h) => JSON.parse(h.storage.map.get(MODELS_KEY));
const TWO = { providers: [{ ...CATALOG.providers[0], models: [...CATALOG.providers[0].models, { id: 'gpt-b', name: 'GPT B' }] }] };
// a custom gate's row is made by the picker, not found by id
const rowOf = (h, role) => h.select(role).parentNode;

test('Docker: a saved pick is not sent; the locked selects show each agent default', async (t) => {
  const h = harness({ control: EVERY, models: SAVED, stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  for (const role of ROLES) {
    assert.equal(h.select(role).disabled, true, role);
    assert.equal(h.select(role).value, '', `${role} shows its agent default, not the saved pick`);
    assert.equal(h.select(role).childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)', role);
    assert.equal(h.$(`f-model-${role}-note`).hidden, true, role);
  }
  assert.equal(h.$('models-note').textContent, DOCKER_DEFAULTS_NOTE);
  assert.equal(h.$('models-need').hidden, true, 'nothing to duplicate in New run');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.sandbox, 'docker');
  assert.equal(h.posts[0].body.models, undefined, 'the server resolves the agent defaults');
  assert.deepEqual(saved(h), SAVED, 'the saved picks are kept for the trusted host');
});

test('switching to the trusted host brings the saved picks back, and Docker again neither uses nor drops them', async (t) => {
  const h = harness({ control: EVERY, models: SAVED, stored: { stages: { angela: 1 } }, catalog: TWO });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.sandbox(true);
  for (const role of ROLES) {
    assert.equal(h.select(role).disabled, false, role);
    assert.equal(h.select(role).value, GPT, role);
  }
  await h.pick({ michael: modelKey('openai', 'gpt-b') });
  await h.sandbox(false);
  assert.equal(h.select('michael').value, '');
  assert.equal(h.select('michael').disabled, true);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[0].body.models, undefined);
  assert.deepEqual(saved(h), { ...SAVED, michael: { provider: 'openai', model: 'gpt-b' } }, 'Docker leaves the host picks alone');

  await h.open();
  await h.sandbox(true);
  assert.equal(h.select('michael').value, modelKey('openai', 'gpt-b'), 'the trusted host gets its pick back');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[1].body.sandbox, 'host');
  assert.deepEqual(h.posts[1].body.models, { michael: { provider: 'openai', model: 'gpt-b' }, dwight: PICK, angela: PICK });
});

test('Docker: a role without an agent default points to Agents and is not filled from a saved pick; a save there clears it', async (t) => {
  const h = harness({ control: defaults({ michael: SOL, dwight: null, angela: null }), models: SAVED, stored: { stages: { angela: 1 } }, agents: true });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('models-need').hidden, false);
  assert.equal(h.$('models-need-text').textContent,
    'The Docker sandbox runs every agent on its agent default, and Dwight and Angela have none. Set one for each in Agents.');
  assert.equal(h.$('models-agents').hidden, false);
  assert.equal(h.select('dwight').childNodes[0].textContent, 'No agent default');
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, [], 'no host or saved model stands in');
  assert.equal(h.select('dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(h.select('angela').getAttribute('aria-invalid'), 'true');
  assert.equal(h.select('michael').getAttribute('aria-invalid'), null);
  assert.equal(globalThis.document.activeElement, h.$('models-agents'), 'the locked select cannot take the fix; Agents can');
  await h.$('models-agents').fire('click');
  assert.equal(h.opened.agents, 1);

  // the Agents drawer saved the defaults: its onChange polls the control document
  h.server.control = defaults({ michael: SOL, dwight: SOL, angela: SOL });
  await h.panel.refresh();
  assert.equal(h.$('models-need').hidden, true);
  assert.equal(h.select('dwight').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);
});

test('Docker: the Open Agents button is offered only where the Agents drawer is', async (t) => {
  const h = harness({ control: defaults({ michael: SOL, dwight: null, angela: SOL }), stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('models-need').hidden, false);
  assert.equal(h.$('models-agents').hidden, true);
  globalThis.document.activeElement = null;
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.select('dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('run-error'), 'the locked select cannot take focus; the message can');
  assert.equal(h.$('run-error').getAttribute('tabindex'), '-1');
});

const REFUSED = 'Docker requires an explicit provider and model for dwight; set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL';

test('Docker: a server 400 naming a role the cached defaults cover leads to Agents, never to the locked select', async (t) => {
  const h = harness({ control: EVERY, stored: { stages: { angela: 1 } }, reject: REFUSED, agents: true });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('models-need').hidden, true, 'the cached defaults cover every role');
  globalThis.document.activeElement = null;
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);
  assert.equal(h.select('dwight').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('models-need').hidden, false);
  assert.equal(h.$('models-agents').hidden, false);
  assert.equal(globalThis.document.activeElement, h.$('models-agents'));
});

test('Docker: the same server 400 without an Agents drawer focuses the message', async (t) => {
  const h = harness({ control: EVERY, stored: { stages: { angela: 1 } }, reject: REFUSED });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  globalThis.document.activeElement = null;
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.match(h.$('run-error').textContent, /^Docker requires an explicit provider and model for dwight/);
  assert.equal(h.$('models-agents').hidden, true);
  assert.equal(globalThis.document.activeElement, h.$('run-error'));
});

test('trusted host: a server 400 naming a role still focuses its enabled select', async (t) => {
  const h = harness({ control: EVERY, stored: { stages: { angela: 1 } }, reject: REFUSED, agents: true });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.sandbox(true);
  globalThis.document.activeElement = null;
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(globalThis.document.activeElement, h.select('dwight'));
});

test('Docker: only the roles the run starts need a default: no plan, custom gates and unused gates', async (t) => {
  const control = defaults({ michael: null, dwight: SOL, oscar: null, hank: null, angela: SOL, seclint: SOL, docs2: null }, AGENTS);
  const h = harness({ control, models: { seclint: PICK }, stored: { stages: { angela: 1, seclint: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.select('seclint').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)');
  assert.equal(h.select('seclint').disabled, true);
  assert.equal(h.select('seclint').value, '');
  assert.equal(rowOf(h, 'docs2').hidden, true, 'Doris does not run');
  assert.equal(h.$('model-row-oscar').hidden, true, 'nor does Oscar');
  assert.equal(h.$('models-need-text').textContent, 'The Docker sandbox runs every agent on its agent default, and Michael has none. Set one in Agents.');

  h.$('f-noplan').checked = true;
  await h.$('f-noplan').fire('change');
  assert.equal(h.$('models-need').hidden, true, 'without a plan Michael does not run');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.noPlan, true);
  assert.deepEqual(h.posts[0].body.workflow, { gates: [['angela', 'seclint']] });
  assert.equal(h.posts[0].body.models, undefined, 'the saved Seclint pick is not sent');

  await h.open();
  await h.toggle('docs2', true);
  assert.equal(rowOf(h, 'docs2').hidden, false);
  assert.equal(h.$('models-need-text').textContent, 'The Docker sandbox runs every agent on its agent default, and Doris has none. Set one in Agents.');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1, 'a custom gate without a default is refused');
  assert.equal(h.select('docs2').getAttribute('aria-invalid'), 'true');
});

test('Docker: a model list that failed to load or a stale saved pick does not matter; the trusted host still says so', async (t) => {
  const h = harness({ control: EVERY, catalog: null, models: { angela: { provider: 'openai', model: 'gone' } }, stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('models-status').hidden, false);
  assert.equal(h.$('models-status').textContent, 'The model list could not be loaded; every role uses its default.');
  assert.equal(h.$('f-model-angela-note').hidden, true, 'no stale-pick note in Docker');
  assert.equal(h.select('angela').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);

  await h.open();
  await h.sandbox(true);
  assert.equal(h.$('f-model-angela-note').hidden, false);
  assert.match(h.$('f-model-angela-note').textContent, /Saved choice gone is not available/);
  assert.equal(h.select('angela').value, '');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[1].body.sandbox, 'host');
  assert.equal(h.posts[1].body.models, undefined);
  assert.deepEqual(saved(h), { angela: { provider: 'openai', model: 'gone' } }, 'the stale pick is kept, not rewritten');
});

test('a demo stays scripted: no model and no Docker check, whatever the agent defaults', async (t) => {
  const h = harness({ control: defaults({ michael: null, dwight: null, angela: null }), models: SAVED, stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-demo').checked = true;
  await h.$('f-demo').fire('change');
  h.$('f-scenario').value = 'happy';
  assert.equal(h.$('models-need').hidden, true);
  assert.equal(h.select('michael').childNodes[0].textContent, 'pi default');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);
  assert.equal(h.posts[0].body.sandbox, undefined);
});
