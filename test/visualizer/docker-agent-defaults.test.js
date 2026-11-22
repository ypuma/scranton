// Agent defaults and saved picks are the same in every sandbox: a role's default option names its agent default
// (GET /api/control defaults.models) or Automatic, a saved pick is shown and sent in the Scranton sandbox, in Docker
// and on the trusted host alike, and switching between them never drops or rewrites it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS_KEY, modelKey } from '../../visualizer/public/js/accounts.js';
import { harness, CONTROL, CATALOG } from './fixtures/run-drawer.js';

const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
const PICK = { provider: 'openai', model: 'gpt-a' };
const GPT = modelKey('openai', 'gpt-a');
const SAVED = { michael: PICK, dwight: PICK, angela: PICK };
const defaults = (mode, models) => ({ ...CONTROL, defaults: { execution: { sandbox: { mode } }, models } });
const ROLES = ['michael', 'dwight', 'angela'];
const saved = (h) => JSON.parse(h.storage.map.get(MODELS_KEY));
const TWO = { providers: [{ ...CATALOG.providers[0], models: [...CATALOG.providers[0].models, { id: 'gpt-b', name: 'GPT B' }] }] };

for (const mode of ['scranton', 'docker', 'host']) {
  test(`${mode}: the saved picks are shown on open selects and sent`, async (t) => {
    const h = harness({ control: defaults(mode, { michael: SOL, dwight: SOL, oscar: SOL, hank: SOL, angela: SOL }), models: SAVED, stored: { stages: { angela: 1 } } });
    t.after(() => h.panel.setMode('demo'));
    await h.open();
    assert.equal(h.$(`f-sandbox-${mode}`).checked, true);
    for (const role of ROLES) {
      assert.equal(h.select(role).disabled, false, role);
      assert.equal(h.select(role).value, GPT, role);
      assert.equal(h.select(role).childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)', role);
    }
    if (mode === 'host') h.$('f-trusted').checked = true;
    await h.$('run-form').fire('submit');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].body.sandbox, mode);
    assert.deepEqual(h.posts[0].body.models, SAVED);
  });
}

test('switching sandboxes keeps a pick where it is; nothing is reset to an agent default', async (t) => {
  const h = harness({ control: defaults('scranton', null), models: SAVED, stored: { stages: { angela: 1 } }, catalog: TWO });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.pick({ michael: modelKey('openai', 'gpt-b') });
  await h.sandbox('docker');
  assert.equal(h.select('michael').value, modelKey('openai', 'gpt-b'));
  await h.sandbox(true);
  assert.equal(h.select('michael').value, modelKey('openai', 'gpt-b'));
  await h.sandbox('scranton');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[0].body.sandbox, 'scranton');
  assert.deepEqual(h.posts[0].body.models, { ...SAVED, michael: { provider: 'openai', model: 'gpt-b' } });
  assert.deepEqual(saved(h), { ...SAVED, michael: { provider: 'openai', model: 'gpt-b' } });
});

test('a role without an agent default reads Automatic and runs on it, without a pick and without a refusal', async (t) => {
  const h = harness({ control: defaults('docker', { michael: SOL, dwight: null, angela: null }), stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.select('dwight').childNodes[0].textContent, 'Automatic');
  assert.equal(h.select('michael').childNodes[0].textContent, 'Agent default (openai/gpt-6.1-sol)');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);
});

test('a stale saved pick says so in every sandbox, falls back to the default and is kept', async (t) => {
  const h = harness({ control: defaults('docker', null), models: { angela: { provider: 'openai', model: 'gone' } }, stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-model-angela-note').hidden, false);
  assert.match(h.$('f-model-angela-note').textContent, /Saved choice gone is not available.*the default is used\.$/);
  assert.equal(h.select('angela').value, '');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[0].body.models, undefined);
  assert.deepEqual(saved(h), { angela: { provider: 'openai', model: 'gone' } }, 'the stale pick is kept, not rewritten');
});

test('a model list that failed to load leaves every role on its default', async (t) => {
  const h = harness({ control: defaults('docker', { michael: SOL, dwight: SOL, angela: SOL }), catalog: null, stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('models-status').textContent, 'The model list could not be loaded; every role uses its default.');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);
});

test('a demo stays scripted: no model, no sandbox, whatever the agent defaults', async (t) => {
  const h = harness({ control: defaults('docker', { michael: null, dwight: null, angela: null }), models: SAVED, stored: { stages: { angela: 1 } } });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-demo').checked = true;
  await h.$('f-demo').fire('change');
  h.$('f-scenario').value = 'happy';
  assert.equal(h.select('michael').childNodes[0].textContent, 'Automatic');
  assert.equal(h.select('michael').disabled, true, 'a demo picks no model');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.models, undefined);
  assert.equal(h.posts[0].body.sandbox, undefined);
});
