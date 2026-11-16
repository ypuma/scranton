// The Team New run drawer opens on the trusted host unless the workspace configuration names Docker. The host's
// no-sandbox acknowledgement is shown and left for the human; a human's pick survives control refreshes and reopens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, CONTROL } from './fixtures/run-drawer.js';

const ACK = 'Confirm that the agents may run commands directly on this computer, or pick the Docker sandbox.';
const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
const MODELS = Object.fromEntries(['michael', 'dwight', 'oscar', 'hank', 'angela'].map((r) => [r, SOL]));
const exec = (mode) => ({ ...CONTROL, defaults: { models: MODELS, execution: { maxParallel: 3, sandbox: { mode, image: 'scranton-sandbox:1.5.0-r2', network: 'bridge' } } } });
const radios = (h) => [h.$('f-sandbox-docker').checked, h.$('f-sandbox-host').checked, h.$('f-trusted').checked];

// guards `e.fHost.checked = d.sandbox === 'host';` in fillExecution and the host fallback of executionDefaults
for (const [name, control] of [['a server without defaults.execution', CONTROL], ['a configuration without a sandbox', exec('host')]]) {
  test(`${name}: the drawer opens on the trusted host, its acknowledgement visible and unchecked`, async (t) => {
    const h = harness({ control });
    t.after(() => h.panel.setMode('demo'));
    await h.open();
    assert.deepEqual(radios(h), [false, true, false]);
    assert.equal(h.$('f-trust-row').hidden, false, 'the no-sandbox acknowledgement is on screen');
    assert.equal(h.$('f-image').disabled, true, 'the Docker settings are off');
    await h.$('run-form').fire('submit');
    assert.deepEqual(h.posts, [], 'never sent without the acknowledgement');
    assert.equal(h.$('run-error').textContent, ACK);
    assert.equal(h.$('f-trusted').getAttribute('aria-invalid'), 'true');
    h.$('f-trusted').checked = true;
    await h.$('run-form').fire('submit');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].body.sandbox, 'host');
    assert.equal(h.posts[0].body.trustedHost, true);
  });
}

// guards `e.fDocker.checked = d.sandbox === 'docker';`
test('a configuration that names Docker opens on Docker, without an acknowledgement to give', async (t) => {
  const h = harness({ control: exec('docker') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(radios(h), [true, false, false]);
  assert.equal(h.$('f-trust-row').hidden, true);
});

// guards `sandboxTouched = true;` in both change handlers and `if (!sandboxTouched)` in fillExecution
test('a human pick holds against the configured default on every reopen; untouched, the drawer follows the configuration', async (t) => {
  const h = harness({ control: exec('host') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.server.control = exec('docker');
  await h.panel.refresh();
  h.$('run-dialog').close();
  await h.open();
  assert.deepEqual(radios(h), [true, false, false], 'untouched: the new configuration');

  await h.sandbox(false);
  h.server.control = exec('host');
  await h.panel.refresh();
  h.$('run-dialog').close();
  await h.open();
  assert.deepEqual(radios(h), [true, false, false], 'the Docker pick holds over a host configuration');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.at(-1).body.sandbox, 'docker');

  const back = harness({ control: exec('docker') });
  t.after(() => back.panel.setMode('demo'));
  await back.open();
  await back.sandbox(true);
  back.$('run-dialog').close();
  await back.open();
  assert.deepEqual(radios(back), [false, true, true], 'a host pick holds over a Docker configuration, with the acknowledgement the human gave');
});

// guards `if (!e.fHost.checked) e.fTrusted.checked = false;` in fillExecution: a follow-up never opens the drawer, so
// nothing else drops the acknowledgement between two follow-ups
test('the configuration moving to Docker drops an acknowledgement, so a later host follow-up asks again', async (t) => {
  const h = harness({ control: exec('host') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-trusted').checked = true;
  h.$('run-dialog').close();
  h.server.control = exec('docker');
  await h.panel.refresh();
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(h.posts[0].body.sandbox, 'docker');
  assert.deepEqual(radios(h), [true, false, false]);
  h.server.control = exec('host');
  await h.panel.refresh();
  const r = await h.panel.startFollowUp('Next step');
  assert.equal(r.field, 'trustedHost', 'back on the host, the acknowledgement is not given back');
  assert.equal(h.posts.length, 1);
});

test('follow-up on the default host: nothing is posted until the acknowledgement is given, and the fix is in Options', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const r = await h.panel.startFollowUp('Next step');
  assert.deepEqual(h.posts, []);
  assert.deepEqual(r, { error: ACK, field: 'trustedHost', fields: [], options: true });
  h.$('f-trusted').checked = true;
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(h.posts[0].body.sandbox, 'host');
});
