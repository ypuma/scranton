// The Team New run drawer opens on Scranton's own sandbox unless the workspace configuration names Docker or the
// trusted host. The host's no-sandbox acknowledgement is shown and left for the human; a human's pick survives
// control refreshes and reopens. Network blocking and "Ask before" go with the run and its follow-ups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, CONTROL } from './fixtures/run-drawer.js';

const HTML = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');

const ACK = 'Confirm that the agents may run commands directly on this computer, or pick a sandbox.';
const SOL = { provider: 'openai', model: 'gpt-6.1-sol' };
const MODELS = Object.fromEntries(['michael', 'dwight', 'oscar', 'hank', 'angela'].map((r) => [r, SOL]));
const exec = (mode, network = 'allow') => ({ ...CONTROL, defaults: { models: MODELS, execution: { maxParallel: 3, sandbox: { mode, image: 'scranton-tools:24-r2', network } } } });
// [Scranton, Docker, Trusted host, acknowledgement]
const radios = (h) => [h.$('f-sandbox-scranton').checked, h.$('f-sandbox-docker').checked, h.$('f-sandbox-host').checked, h.$('f-trusted').checked];

// guards `e.fScranton.checked = !e.fHost.checked && !e.fDocker.checked;` in fillExecution and the fallback of executionDefaults
for (const [name, control] of [['a server without defaults.execution', CONTROL], ['a configuration naming the Scranton sandbox', exec('scranton')], ['an unknown mode', exec('vm')]]) {
  test(`${name}: the drawer opens on the Scranton sandbox and starts without an acknowledgement`, async (t) => {
    const h = harness({ control });
    t.after(() => h.panel.setMode('demo'));
    await h.open();
    assert.deepEqual(radios(h), [true, false, false, false]);
    assert.equal(h.$('f-trust-row').hidden, true, 'nothing to acknowledge in a sandbox');
    assert.equal(h.$('f-image').disabled, true, 'the image is a Docker setting');
    assert.equal(h.$('f-network').disabled, false, 'the Scranton sandbox can be asked to block the network');
    assert.equal(h.$('run-options-summary').textContent.includes('Scranton sandbox'), true);
    await h.$('run-form').fire('submit');
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].body.sandbox, 'scranton');
    assert.equal(h.posts[0].body.trustedHost, undefined);
    assert.equal(h.posts[0].body.approvals, undefined);
  });
}

// guards `e.fHost.checked = d.sandbox === 'host';`
test('a configuration that names the trusted host opens on it, its acknowledgement visible and unchecked', async (t) => {
  const h = harness({ control: exec('host') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(radios(h), [false, false, true, false]);
  assert.equal(h.$('f-trust-row').hidden, false);
  assert.equal(h.$('f-network').disabled, true, 'the host has no boundary to block the network with');
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, [], 'never sent without the acknowledgement');
  assert.equal(h.$('run-error').textContent, ACK);
  assert.equal(h.$('f-trusted').getAttribute('aria-invalid'), 'true');
  h.$('f-trusted').checked = true;
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 1);
  assert.deepEqual([h.posts[0].body.sandbox, h.posts[0].body.trustedHost], ['host', true]);
});

// guards `e.fDocker.checked = d.sandbox === 'docker';`
test('a configuration that names Docker opens on Docker, without an acknowledgement to give', async (t) => {
  const h = harness({ control: exec('docker') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.deepEqual(radios(h), [false, true, false, false]);
  assert.equal(h.$('f-trust-row').hidden, true);
  assert.equal(h.$('f-image').disabled, false);
  h.$('f-image').value = 'my/img:2';
  await h.$('run-form').fire('submit');
  assert.deepEqual([h.posts[0].body.sandbox, h.posts[0].body.sandboxImage], ['docker', 'my/img:2']);
});

// guards `sandboxTouched = true;` in the change handlers and `if (!sandboxTouched)` in fillExecution
test('a human pick holds against the configured default on every reopen; untouched, the drawer follows the configuration', async (t) => {
  const h = harness({ control: exec('scranton') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.server.control = exec('docker');
  await h.panel.refresh();
  h.$('run-dialog').close();
  await h.open();
  assert.deepEqual(radios(h), [false, true, false, false], 'untouched: the new configuration');

  await h.sandbox('scranton');
  h.server.control = exec('host');
  await h.panel.refresh();
  h.$('run-dialog').close();
  await h.open();
  assert.deepEqual(radios(h), [true, false, false, false], 'the Scranton pick holds over a host configuration');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.at(-1).body.sandbox, 'scranton');

  const back = harness({ control: exec('docker') });
  t.after(() => back.panel.setMode('demo'));
  await back.open();
  await back.sandbox(true);
  back.$('run-dialog').close();
  await back.open();
  assert.deepEqual(radios(back), [false, false, true, true], 'a host pick holds over a Docker configuration, with the acknowledgement the human gave');
});

// guards `if (!e.fHost.checked) e.fTrusted.checked = false;` in fillExecution: a follow-up never opens the drawer, so
// nothing else drops the acknowledgement between two follow-ups
test('the configuration moving off the host drops an acknowledgement, so a later host follow-up asks again', async (t) => {
  const h = harness({ control: exec('host') });
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-trusted').checked = true;
  h.$('run-dialog').close();
  h.server.control = exec('scranton');
  await h.panel.refresh();
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.equal(h.posts[0].body.sandbox, 'scranton');
  assert.deepEqual(radios(h), [true, false, false, false]);
  h.server.control = exec('host');
  await h.panel.refresh();
  const r = await h.panel.startFollowUp('Next step');
  assert.deepEqual(r, { error: ACK, field: 'trustedHost', fields: [], options: true }, 'back on the host, the acknowledgement is not given back');
  assert.equal(h.posts.length, 1);
});

test('Block network: sent as none in the Scranton sandbox and Docker, dropped on the host, preset from the configuration', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-network').checked, false);
  assert.match(HTML, /<span class="hint" id="f-network-note">On Windows the default Scranton sandbox cannot block the network: a run that asks for it does not start there\. Docker can block it\.<\/span>/);
  h.$('f-network').checked = true;
  await h.$('f-network').fire('change');
  assert.match(h.$('run-options-summary').textContent, /Scranton sandbox \u00b7 no network/);
  await h.$('run-form').fire('submit');
  assert.deepEqual([h.posts[0].body.sandbox, h.posts[0].body.sandboxNetwork], ['scranton', 'none']);
  await h.open();
  await h.sandbox('docker');
  await h.$('run-form').fire('submit');
  assert.deepEqual([h.posts[1].body.sandbox, h.posts[1].body.sandboxNetwork], ['docker', 'none'], 'the tick holds across the sandboxes');
  await h.open();
  await h.sandbox(true);
  assert.equal(h.$('f-network').disabled, true);
  await h.$('run-form').fire('submit');
  assert.deepEqual([h.posts[2].body.sandbox, h.posts[2].body.sandboxNetwork], ['host', undefined]);

  const blocked = harness({ control: exec('scranton', 'none') });
  t.after(() => blocked.panel.setMode('demo'));
  await blocked.open();
  assert.equal(blocked.$('f-network').checked, true, 'the configuration blocks it');
  await blocked.$('run-form').fire('submit');
  assert.equal(blocked.posts[0].body.sandboxNetwork, undefined, 'the configured value is not sent again');
  blocked.$('f-network').checked = false;
  await blocked.$('f-network').fire('change');
  await blocked.open();
  await blocked.$('run-form').fire('submit');
  assert.equal(blocked.posts[1].body.sandboxNetwork, 'allow', 'unticking it is a choice to send');
});

test('Ask before: the boxes send approvals with the wait, a follow-up carries them, and a demo turns them off', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('f-approve-timeout').disabled, true, 'no wait to set while nothing is asked');
  h.$('f-approve-shell').checked = true;
  await h.$('f-approve-shell').fire('change');
  assert.equal(h.$('f-approve-timeout').disabled, false);
  h.$('f-approve-timeout').value = '120';
  assert.match(h.$('run-options-summary').textContent, /asks before commands/);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts[0].body.approvals, { tools: ['bash', 'powershell'], timeoutSeconds: 120 });

  h.$('f-approve-files').checked = true;
  await h.$('f-approve-files').fire('change');
  assert.match(h.$('run-options-summary').textContent, /asks before commands and file changes/);
  assert.deepEqual(await h.panel.startFollowUp('Next step'), { ok: true });
  assert.deepEqual(h.posts[1].body.approvals, { tools: ['bash', 'powershell', 'write', 'edit'], timeoutSeconds: 120 });

  h.$('f-approve-timeout').value = '3';
  const r = await h.panel.startFollowUp('Next step');
  assert.deepEqual(r, { error: 'The approval wait must be a whole number of seconds from 10 to 86400.', field: 'approvalTimeout', fields: [], options: true });
  assert.equal(h.posts.length, 2);

  await h.open();
  h.$('f-approve-timeout').value = '600';
  h.$('f-demo').checked = true;
  await h.$('f-demo').fire('change');
  h.$('f-scenario').value = 'happy';
  assert.equal(h.$('f-approve-shell').disabled, true);
  await h.$('run-form').fire('submit');
  assert.equal(h.posts[2].body.approvals, undefined, 'a demo asks nothing');
});

test('a wait out of range in the drawer marks the field and opens Options', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  h.$('f-approve-files').checked = true;
  await h.$('f-approve-files').fire('change');
  h.$('f-approve-timeout').value = '0';
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
  assert.equal(h.$('f-approve-timeout').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('run-options').open, true);
  assert.equal(globalThis.document.activeElement, h.$('f-approve-timeout'));
});
