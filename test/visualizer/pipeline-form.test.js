// The Pipeline part of the New run drawer with the fake DOM: setup rows from detect, row-level errors (client and
// server), the model note, and the team demo choice when the control document lists no scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { createPipelineForm } from '../../visualizer/public/js/pipeline-form.js';
import { createState } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';
import { harness as drawerHarness, CONTROL as TEAM_CONTROL } from './fixtures/run-drawer.js';

const CONTROL = { v: 1, enabled: true, workspace: 'C:\\code\\app', scenarios: [], run: null, lastExit: null, pendingHuman: null, instances: {}, recoveryRequired: false };
const INFO = {
  available: true, reason: null, version: '0.1.0', source: 'dev', sandbox: { dockerImage: 'scranton-sandbox:1.5.0' },
  models: [
    { provider: 'anthropic', label: 'Anthropic', supported: true, via: 'pi', reason: null, models: [{ id: 'claude', label: 'Claude' }] },
    { provider: 'odd', label: 'Odd', supported: false, reason: 'pi reports no model for it', models: [] },
  ],
};
const DETECT = {
  git: true, languages: { JavaScript: 3 },
  checks: [{ id: 'test', kind: 'test', command: 'npm test', reason: 'package.json has a test script' }],
  setup: [{ id: 'npm-ci', command: 'npm ci', network: true, reason: 'package-lock.json' }],
};
const MODEL = JSON.stringify(['anthropic', 'claude']);
const tick = () => new Promise((r) => setTimeout(r, 10));

// answer: what startPipeline resolves to; info: GET /api/pipeline, or a function of the call count;
// build: what POST /api/pipeline/sandbox/build answers; timers: fakes for the build poll
function harness({
  detect = DETECT, info = INFO, answer = { ok: true, status: 202, data: { ok: true, runId: 'abc123def456' } },
  build = { status: 202, data: { ok: true } }, timers = globalThis,
} = {}) {
  const $ = installDom();
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  const posts = [];
  let infoCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      if (url === '/api/pipeline/sandbox/build') return { ok: build.status < 400, status: build.status, json: async () => structuredClone(build.data) };
      return { ok: true, status: 200, json: async () => structuredClone(detect) };
    }
    if (url === '/api/pipeline') {
      const doc = typeof info === 'function' ? info(infoCalls++) : info;
      return { ok: true, status: 200, json: async () => structuredClone(doc) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(CONTROL) };
  };
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({
    dashboard: stub, pipeline: stub, lanes: stub, models: null, getState: () => createState(),
    url: () => '/api/control', pipelineForm: createPipelineForm({ timers }),
  });
  const sent = [];
  // ack: the human ticks the trusted host acknowledgement, as a run on the default host needs
  const open = async ({ ack = true } = {}) => {
    panel.setMode('live');
    await tick();
    panel.openRun({
      engine: 'pipeline',
      target: { title: 'New pipeline run', project: 'core', workspace: 'C:\\code\\app', startPipeline: async (body) => { sent.push(body); return answer; } },
    });
    await tick();
    await tick();
    $('pf-task').value = 'Fix the parser';
    for (const role of ['planner', 'implementer', 'reviewer']) $(`pf-model-${role}`).value = MODEL;
    if (ack) $('pf-trust').checked = true;
  };
  // the human picks Docker or Trusted host
  const pick = async (mode) => {
    $('pf-docker').checked = mode === 'docker';
    $('pf-host').checked = mode === 'host';
    await $(mode === 'docker' ? 'pf-docker' : 'pf-host').fire('change');
  };
  // a setup or check row: its inputs as the row builds them
  const row = (list, i) => {
    const li = $(list).childNodes[i];
    const top = li.childNodes[0];
    return {
      li, id: top.childNodes[1], toggle: top.childNodes[list === 'pf-setup' ? 2 : 4].childNodes[0], command: li.childNodes[2],
      error: li.childNodes.find((n) => n.className === 'form-status pf-row-error'),
    };
  };
  const submit = () => $('run-form').fire('submit');
  return { $, panel, posts, sent, open, pick, row, submit };
}

const done = (t, h) => t.after(() => h.panel.setMode('demo'));

// finding 1 (reverting `setup: setupRows.map(rowValue),` in build() fails this)
test('setup rows: prefilled from detect, editable, sent as setup, at most 4', async (t) => {
  const h = harness();
  done(t, h);
  await h.open();
  assert.deepEqual(h.posts.map((p) => p.url), ['/api/projects/core/pipeline/detect']);
  assert.equal(h.$('pf-setup').childNodes.length, 1);
  const s = h.row('pf-setup', 0);
  assert.deepEqual([s.id.value, s.command.value, s.toggle.checked], ['npm-ci', 'npm ci', true]);
  assert.equal(h.$('pf-setup-note').hidden, false);
  assert.match(h.$('pf-checks-status').textContent, /^1 setup command and 1 check suggested/);
  await h.submit();
  assert.deepEqual(h.sent[0].setup, [{ id: 'npm-ci', command: 'npm ci', network: true }]);
  assert.deepEqual(h.sent[0].checks, [{ id: 'test', kind: 'test', command: 'npm test', required: true }]);
  for (let i = 0; i < 3; i += 1) await h.$('pf-setup-add').fire('click');
  assert.equal(h.$('pf-setup').childNodes.length, 4);
  assert.equal(h.$('pf-setup-add').disabled, true, 'the engine takes at most 4');
  assert.equal(document.activeElement, h.row('pf-setup', 3).id, 'a new row gets the focus');
});

test('setup rows: none detected leaves just the Add setup command button', async (t) => {
  const h = harness({ detect: { ...DETECT, setup: [] } });
  done(t, h);
  await h.open();
  assert.deepEqual(h.$('pf-setup').childNodes, []);
  assert.equal(h.$('pf-setup-note').hidden, true);
  assert.equal(h.$('pf-setup-add').disabled, false);
  await h.submit();
  assert.deepEqual(h.sent[0].setup, []);
});

// finding 5, client side (reverting `if (!pipelineForm.markInvalid(built.field, built.error)) runError(built.error);` fails this)
test('an id the engine refuses is caught before the submit and named at its row', async (t) => {
  const h = harness();
  done(t, h);
  await h.open();
  const c = h.row('pf-checks', 0);
  c.id.value = 'unit.fast';
  await h.submit();
  assert.deepEqual(h.sent, [], 'nothing is sent');
  assert.match(c.error.textContent, /^Check id "unit\.fast": letters, digits, "_" and "-", up to 64 characters\.$/);
  assert.equal(c.id.getAttribute('aria-invalid'), 'true');
  assert.equal(c.id.getAttribute('aria-describedby'), c.error.id);
  assert.equal(h.$('run-error').hidden, true, 'said once, at the row');
  await c.id.fire('input');
  assert.equal(c.error.textContent, '', 'editing the row clears its message');
});

// finding 5, server side (reverting the `r.status === 400 && pipelineForm.markInvalid(...)` condition in
// control-panel.js submitPipeline fails this)
test('a field-named 400 from the server is shown next to the row it names, counting only the rows sent', async (t) => {
  const message = 'checks[0].id: Invalid command ID';
  const h = harness({ detect: { ...DETECT, checks: [] }, answer: { ok: false, status: 400, data: { error: message }, error: message } });
  done(t, h);
  await h.open();
  // detect found no check: one blank row, then the human adds the real one below it
  await h.$('pf-check-add').fire('click');
  const blank = h.row('pf-checks', 0);
  const unit = h.row('pf-checks', 1);
  unit.id.value = 'unit';
  unit.command.value = 'npm test';
  await h.submit();
  assert.deepEqual(h.sent[0].checks, [{ id: 'unit', kind: 'test', command: 'npm test', required: true }]);
  assert.equal(unit.error.textContent, message);
  assert.equal(blank.error.textContent, '');
  assert.equal(document.activeElement, unit.id);
  assert.equal(h.$('run-error').hidden, true);
});

// finding 6 (reverting the note text in fillModels fails this)
test('models: no API-key requirement is claimed; bridge models are marked via Scranton and unsupported ones keep their reason', async (t) => {
  const h = harness({ info: { ...INFO, models: [INFO.models[1]] } });
  done(t, h);
  await h.open();
  assert.doesNotMatch(h.$('pf-models-note').textContent, /API key for|OpenAI-compatible/);
  assert.match(h.$('pf-models-note').textContent, /The demo needs none/);
  const odd = h.$('pf-model-planner').childNodes[1];
  assert.deepEqual([odd.label, odd.disabled], ['Odd - pi reports no model for it', true]);

  const pi = harness();
  done(t, pi);
  await pi.open();
  assert.equal(pi.$('pf-model-planner').childNodes[1].label, 'Anthropic · via Scranton');
});

// finding 7 (reverting `e.fDemoRow.hidden = none;` in control-panel.js fillScenarios fails this)
test('team demo: without scenarios in the control document the choice is hidden with its reason, not refused on submit', async (t) => {
  const none = drawerHarness({ control: { ...TEAM_CONTROL, scenarios: [] } });
  t.after(() => none.panel.setMode('demo'));
  await none.open();
  assert.equal(none.$('f-demo-row').hidden, true);
  assert.equal(none.$('f-demo-none').hidden, false);
  assert.equal(none.$('f-demo').checked, false);

  const team = drawerHarness();
  t.after(() => team.panel.setMode('demo'));
  await team.open();
  assert.equal(team.$('f-demo-row').hidden, false, 'a team chat lists them and offers the demo');
  assert.equal(team.$('f-demo-none').hidden, true);
});

// ------------------------------------------------------------ section 18: the Docker probe and the image build

const IMAGE = 'scranton-pipeline-sandbox:0.2.0';
const sandbox = (over = {}) => ({
  dockerImage: IMAGE, docker: { available: true, version: '29.9.2', reason: null }, image: { name: IMAGE, present: true },
  build: { state: 'idle', startedAt: null, finishedAt: null, tail: '' }, ...over,
});
const withSandbox = (sb) => ({ ...INFO, sandbox: sb });
const missing = (build = {}) => sandbox({ image: { name: IMAGE, present: false }, build: { state: 'idle', tail: '', ...build } });

function fakeTimers() {
  const t = { delays: [], pending: new Map(), seq: 0 };
  t.setTimeout = (fn, ms) => { t.delays.push(ms); t.pending.set(++t.seq, fn); return t.seq; };
  t.clearTimeout = (id) => { t.pending.delete(id); };
  t.fire = async () => {
    const [id, fn] = [...t.pending.entries()].at(-1);
    t.pending.delete(id);
    fn();
    await tick();
  };
  return t;
}

// guards the host preselection in open() and that renderSandbox no longer preselects Docker from the probe
test('sandbox: Docker running with the image present is said in one quiet line, yet the Trusted host is preselected without its acknowledgement', async (t) => {
  const h = harness({ info: withSandbox(sandbox()) });
  done(t, h);
  await h.open({ ack: false });
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [false, true]);
  assert.equal(h.$('pf-trust').checked, false, 'the acknowledgement is never given for the human');
  assert.equal(h.$('pf-trust-row').hidden, false, 'the no-OS-isolation acknowledgement is on screen');
  assert.equal(h.$('pf-sandbox-status').textContent, `Docker 29.9.2 is running; the image ${IMAGE} is present.`);
  assert.equal(h.$('pf-build').hidden, true);
  assert.equal(h.$('pf-build-log').hidden, true);
  await h.submit();
  assert.deepEqual(h.sent, [], 'the host is not used without the acknowledgement');
  assert.equal(h.$('run-error').textContent, 'Confirm that the checks may run on this computer without OS isolation, or use Docker.');
  await h.pick('docker');
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'docker' });
});

// guards `e.trust.checked = false;` in open() and that a Docker that is down changes nothing about the choice
test('sandbox: Docker not running says why and offers no build; the Trusted host stays preselected and still waits for its acknowledgement', async (t) => {
  const h = harness({ info: withSandbox(sandbox({ docker: { available: false, version: null, reason: 'the Docker daemon does not answer' } })) });
  done(t, h);
  await h.open({ ack: false });
  assert.equal(h.$('pf-sandbox-status').textContent, 'Docker is not running: the Docker daemon does not answer');
  assert.equal(h.$('pf-sandbox-status').dataset.tone, 'error');
  assert.equal(h.$('pf-build').hidden, true, 'there is nothing to build with');
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [false, true]);
  await h.submit();
  assert.deepEqual(h.sent, []);
  assert.equal(h.$('run-error').textContent, 'Confirm that the checks may run on this computer without OS isolation, or use Docker.');
  assert.equal(document.activeElement, h.$('pf-trust'));
  assert.equal(h.$('pf-trust-row').hidden, false, 'Trusted host stays available with its acknowledgement');
  h.$('pf-trust').checked = true;
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'host', trustHost: true });
});

// guards the build click handler, schedulePoll and that a finished build does not preselect Docker
test('sandbox: a missing image is named and built from the form; the tail is shown on demand while it runs, and the Trusted host stays chosen', async (t) => {
  const timers = fakeTimers();
  const states = [missing(), missing({ state: 'running', tail: 'Step 2/9 : RUN apt-get update' }), missing({ state: 'running', tail: 'Step 5/9 : RUN pip install pytest' }),
    sandbox({ build: { state: 'succeeded', tail: 'Successfully tagged' } })];
  const h = harness({ timers, info: (n) => withSandbox(states[Math.min(n, states.length - 1)]) });
  done(t, h);
  await h.open();
  assert.equal(h.$('pf-sandbox-status').textContent, `The sandbox image ${IMAGE} has not been built yet.`);
  assert.equal(h.$('pf-build').hidden, false);
  assert.equal(h.$('pf-docker').checked, false);
  assert.equal(timers.pending.size, 0, 'no poll while nothing builds');

  await h.$('pf-build').fire('click');
  assert.deepEqual(h.posts.at(-1), { url: '/api/pipeline/sandbox/build', body: {} });
  assert.equal(h.$('pf-build').disabled, true);
  assert.equal(h.$('pf-build').textContent, 'Building...');
  assert.equal(timers.delays.at(-1), 1000, 'polls about once a second');

  await timers.fire();
  assert.equal(h.$('pf-sandbox-status').textContent, `Building the sandbox image ${IMAGE}...`);
  assert.equal(h.$('pf-build-log').hidden, false);
  assert.equal(h.$('pf-build-log').open, false, 'the output is there on demand, closed');
  assert.equal(h.$('pf-build-tail').textContent, 'Step 2/9 : RUN apt-get update');
  await timers.fire();
  assert.equal(h.$('pf-build-tail').textContent, 'Step 5/9 : RUN pip install pytest');
  await timers.fire();
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [false, true], 'built: the probe does not move the choice');
  assert.equal(h.$('pf-build').hidden, true);
  assert.equal(h.$('pf-build-log').hidden, true);
  assert.equal(timers.pending.size, 0, 'polling stopped');
});

// review F5 finding 3: a finished build never forces Docker or clears the acknowledgement (the old `justBuilt` branch did)
test('sandbox: a build that finishes keeps an explicit Trusted host pick and its acknowledgement', async (t) => {
  const timers = fakeTimers();
  const states = [missing(), missing({ state: 'running', tail: 'Step 1/9' }), sandbox({ build: { state: 'succeeded', tail: '' } })];
  const h = harness({ timers, info: (n) => withSandbox(states[Math.min(n, states.length - 1)]) });
  done(t, h);
  await h.open({ ack: false });
  await h.pick('host');
  h.$('pf-trust').checked = true;
  await h.$('pf-build').fire('click');
  await timers.fire();
  await timers.fire();
  assert.equal(h.$('pf-sandbox-status').textContent, `Docker 29.9.2 is running; the image ${IMAGE} is present.`, 'the build finished');
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked, h.$('pf-trust').checked], [false, true, true]);
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'host', trustHost: true });

  // a new drawer session keeps the host, never the old acknowledgement, and the ready Docker is not preselected
  await h.open({ ack: false });
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked, h.$('pf-trust').checked], [false, true, false]);
});

// guards `if (e.docker.checked) sandboxPick = 'docker';`, `e.docker.checked = sandboxPick === 'docker';` in open() and
// that renderSandbox leaves the radio buttons alone on every probe
test('sandbox: an explicit Docker pick survives every probe of a build, a failed one included, and the next drawer session', async (t) => {
  const timers = fakeTimers();
  const states = [missing(), missing({ state: 'running', tail: 'Step 1/9' }), missing({ state: 'failed', tail: 'pull access denied' })];
  const h = harness({ timers, info: (n) => withSandbox(states[Math.min(n, states.length - 1)]) });
  done(t, h);
  await h.open({ ack: false });
  await h.pick('docker');
  assert.equal(h.$('pf-trust-row').hidden, true, 'Docker asks for no acknowledgement');
  await h.$('pf-build').fire('click');
  await timers.fire();
  await timers.fire();
  assert.equal(h.$('pf-sandbox-status').textContent, `The sandbox image ${IMAGE} could not be built. Its output is below.`);
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [true, false], 'the probes keep Docker');

  await h.open({ ack: false });
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [true, false], 'the next session keeps the pick');
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'docker' });

  await h.open({ ack: false });
  await h.pick('host');
  await h.open({ ack: false });
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked, h.$('pf-trust').checked], [false, true, false], 'and so is a host pick, without its acknowledgement');
});

// review F5 finding 2: the demo on the host needs no acknowledgement; turning the demo on or off never moves the choice
test('sandbox: a demo starts on the preselected Trusted host without an acknowledgement; a run still waits for it', async (t) => {
  const down = sandbox({ docker: { available: false, version: null, reason: 'the Docker daemon does not answer' } });
  const h = harness({ info: withSandbox(down) });
  done(t, h);
  await h.open({ ack: false });
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [false, true], 'a run: the host');
  assert.equal(h.$('pf-trust-row').hidden, false, 'with its acknowledgement');
  await demoOn(h);
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked], [false, true], 'a demo: the host');
  assert.equal(h.$('pf-trust-demo').hidden, false, 'with the line saying no acknowledgement is needed');
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'host' });

  await h.open({ ack: false });
  await demoOn(h);
  await demoOn(h, false);
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked, h.$('pf-trust').checked], [false, true, false], 'back to a run: the host, unacknowledged');
  await h.submit();
  assert.equal(h.sent.length, 1, 'the run is refused without the acknowledgement');

  const ready = harness({ info: withSandbox(sandbox()) });
  done(t, ready);
  await ready.open();
  await demoOn(ready);
  assert.deepEqual([ready.$('pf-docker').checked, ready.$('pf-host').checked], [false, true], 'a demo with Docker ready: still the host');

  const picked = harness({ info: withSandbox(down) });
  done(t, picked);
  await picked.open();
  await picked.pick('docker');
  await demoOn(picked);
  assert.deepEqual([picked.$('pf-docker').checked, picked.$('pf-host').checked], [true, false], 'an explicit pick stays');
});

// guards the `state === 'failed'` branch of sandboxView and that a failed build does not preselect Docker
test('sandbox: a failed build keeps its tail, offers the build again, and Docker stays unchosen', async (t) => {
  const timers = fakeTimers();
  const states = [missing({ state: 'running', tail: 'Step 1/9' }), missing({ state: 'failed', tail: 'pull access denied for debian' })];
  const h = harness({ timers, info: (n) => withSandbox(states[Math.min(n, 1)]) });
  done(t, h);
  await h.open();
  assert.equal(h.$('pf-build').disabled, true, 'a build started elsewhere is running');
  await timers.fire();
  assert.equal(h.$('pf-sandbox-status').textContent, `The sandbox image ${IMAGE} could not be built. Its output is below.`);
  assert.equal(h.$('pf-build-tail').textContent, 'pull access denied for debian');
  assert.equal(h.$('pf-build-log').hidden, false);
  assert.deepEqual([h.$('pf-build').hidden, h.$('pf-build').disabled], [false, false]);
  assert.equal(h.$('pf-docker').checked, false);
});

// guards `buildError = r.status === 404 ? ... : r.error` in the build click handler
test('sandbox: a refused build request is said in the sandbox line', async (t) => {
  const h = harness({ info: withSandbox(missing()), build: { status: 503, data: { error: 'Docker is not available' } } });
  done(t, h);
  await h.open();
  await h.$('pf-build').fire('click');
  assert.equal(h.$('pf-sandbox-status').textContent, 'The sandbox image could not be built: Docker is not available');
  assert.equal(h.$('pf-build').disabled, false);
});

// guards `if (!docker || typeof docker.available !== 'boolean') return { known: false, ...` for the form
test('sandbox: an older server that only names the image gets the Trusted host default, with no line and no build button', async (t) => {
  const h = harness();
  done(t, h);
  await h.open({ ack: false });
  assert.deepEqual([h.$('pf-docker').checked, h.$('pf-host').checked, h.$('pf-trust').checked], [false, true, false]);
  assert.equal(h.$('pf-sandbox-status').textContent, '');
  assert.equal(h.$('pf-build').hidden, true);
  assert.equal(h.$('pf-image').placeholder, 'scranton-sandbox:1.5.0');
});

// guards `|| pipelineForm.sandboxRefused?.(r)` in control-panel.js submitPipeline
test('sandbox: the server refusing a run for a missing image is said at the sandbox section, not in the drawer error line', async (t) => {
  const message = 'The sandbox image my/img:2 is not available locally';
  const h = harness({ info: withSandbox(sandbox()), answer: { ok: false, status: 409, data: { error: message }, error: message } });
  done(t, h);
  await h.open();
  await h.pick('docker');
  h.$('pf-image').value = 'my/img:2';
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'docker', image: 'my/img:2' }, 'a custom image is sent unchecked');
  assert.equal(h.$('pf-sandbox-status').textContent, message);
  assert.equal(h.$('pf-sandbox-status').dataset.tone, 'error');
  assert.equal(h.$('run-error').hidden, true, 'said once');
  assert.equal(h.$('pf-image').getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, h.$('pf-image'));
  await h.$('pf-image').fire('input');
  assert.equal(h.$('pf-sandbox-status').textContent, `Docker 29.9.2 is running; the image ${IMAGE} is present.`, 'editing the image goes back to the probe');
  // review F5 finding 4: guards `e.image.removeAttribute('aria-invalid');` in clearRefused
  assert.equal(h.$('pf-image').getAttribute('aria-invalid'), null, 'and the image is no longer marked invalid');
  assert.equal(h.$('pf-image').getAttribute('aria-describedby'), null);

  await h.submit();
  assert.equal(h.$('pf-image').getAttribute('aria-invalid'), 'true', 'refused again');
  h.$('pf-host').checked = true;
  h.$('pf-docker').checked = false;
  await h.$('pf-host').fire('change');
  assert.equal(h.$('pf-image').getAttribute('aria-invalid'), null, 'changing the sandbox clears it too');
});

// guards `replans: e.replans.value, parallelSteps: e.parallel.value` in build() and the demo lines of sync()
test('execution: re-planning and parallel steps are sent with the run, and are off for the demo', async (t) => {
  const h = harness({ info: withSandbox(sandbox()) });
  done(t, h);
  await h.open();
  h.$('pf-replans').value = '0';
  h.$('pf-parallel').value = '3';
  await h.submit();
  assert.deepEqual([h.sent[0].replans, h.sent[0].parallelSteps], [0, 3]);

  const d = harness({ info: withSandbox(sandbox()) });
  done(t, d);
  await d.open();
  d.$('pf-demo').checked = true;
  await d.$('pf-demo').fire('change');
  assert.deepEqual([d.$('pf-replans').disabled, d.$('pf-parallel').disabled, d.$('pf-exec-row').dataset.disabled], [true, true, 'true']);
  await d.submit();
  assert.equal('replans' in d.sent[0] || 'parallelSteps' in d.sent[0], false);
});

// guards `grounding: e.grounding.value, guidance: e.guidance.checked` in build(), the two resets in open() and
// `e.execRow.dataset.disabled = String(demo);` in sync()
test('execution: evidence checks and guidance are sent explicitly, reset when the drawer opens again, and stay operable for the demo', async (t) => {
  const h = harness({ info: withSandbox(sandbox()) });
  done(t, h);
  await h.open();
  assert.deepEqual([h.$('pf-grounding').value, h.$('pf-guidance').checked], ['enforce', false], 'enforce and off by default');
  h.$('pf-grounding').value = 'observe';
  h.$('pf-guidance').checked = true;
  await h.submit();
  assert.deepEqual([h.sent[0].grounding, h.sent[0].guidance], ['observe', true]);
  await h.open();
  assert.deepEqual([h.$('pf-grounding').value, h.$('pf-guidance').checked], ['enforce', false], 'a new drawer starts from the defaults');
  await h.submit();
  assert.deepEqual([h.sent[1].grounding, h.sent[1].guidance], ['enforce', false], 'sent although nothing was chosen');

  await h.open();
  await demoOn(h);
  assert.deepEqual([h.$('pf-grounding').disabled, h.$('pf-guidance').disabled, h.$('pf-exec-row').dataset.disabled], [false, false, 'true'],
    'only re-planning and parallel steps are off for the demo');
  h.$('pf-guidance').checked = true;
  await h.submit();
  assert.deepEqual([h.sent[2].demo, h.sent[2].grounding, h.sent[2].guidance], [true, 'enforce', true]);
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  for (const s of ['<option value="enforce" selected>Enforce - reject output that is not backed by evidence</option>',
    '<option value="observe">Observe only - record and score, reject nothing</option>', '<label for="pf-grounding">Evidence checks</label>',
    '<input type="checkbox" id="pf-guidance" aria-describedby="pf-guidance-hint"><span>Procedural guidance (experimental) <span class="hint" id="pf-guidance-hint">Adds situational advice to the models\' prompts. Off by default until a graph has been validated.</span>']) {
    assert.ok(html.includes(s), s);
  }
});

const demoOn = async (h, on = true) => {
  h.$('pf-demo').checked = on;
  await h.$('pf-demo').fire('change');
};

// section 19. Guards `e.scenarioRow.hidden = !demo;`, `e.scenarioHint.textContent = demoScenario(e.scenario.value).hint;`,
// `e.scenario.addEventListener('change', sync);` and `demoScenario: e.scenario.value` in build()
test('demo scenario: the select is shown only for a demo, its line follows the choice, and the choice is sent', async (t) => {
  const h = harness({ info: withSandbox(sandbox()) });
  done(t, h);
  await h.open();
  assert.equal(h.$('pf-scenario-row').hidden, true, 'not for a real run');
  await demoOn(h);
  assert.equal(h.$('pf-scenario-row').hidden, false);
  assert.equal(h.$('pf-scenario-hint').textContent, 'One bug, one step, both approvals.', 'the basic fix by default');
  for (const [id, line] of [['replan', 'The first plan gets stuck; you approve a revised plan.'], ['parallel', 'Two independent fixes run side by side and are merged.']]) {
    h.$('pf-scenario').value = id;
    await h.$('pf-scenario').fire('change');
    assert.equal(h.$('pf-scenario-hint').textContent, line, id);
  }
  await h.submit();
  assert.deepEqual(h.sent[0], { task: 'Fix the parser', demo: true, demoScenario: 'parallel', delivery: 'apply', sandbox: { mode: 'host' }, grounding: 'enforce', guidance: false, conversation: true });

  // a started run closes the drawer; the next one opens it again
  await h.open();
  await demoOn(h, false);
  assert.equal(h.$('pf-scenario-row').hidden, true);
  await h.submit();
  assert.equal('demoScenario' in h.sent[1], false, 'a real run never names a scenario');
});

// section 25b. Guards the enforced branch of sync() (hold, value, disabled, hint, aria-describedby), the restore
// branch, `groundingHeld = null;` in open() and the evidence option in index.html
test('demo scenario: the evidence demo holds Evidence checks on Enforce and gives the earlier choice back', async (t) => {
  const h = harness({ info: withSandbox(sandbox()) });
  done(t, h);
  await h.open();
  const g = h.$('pf-grounding');
  const state = () => [g.value, g.disabled, h.$('pf-grounding-hint').hidden, g.getAttribute('aria-describedby')];
  const free = (value) => [value, false, true, null];
  const held = ['enforce', true, false, 'pf-grounding-hint'];
  const pick = async (id) => {
    h.$('pf-scenario').value = id;
    await h.$('pf-scenario').fire('change');
  };
  g.value = 'observe';
  await demoOn(h);
  assert.deepEqual(state(), free('observe'), 'the basic demo leaves the choice alone');
  await pick('evidence');
  assert.deepEqual(state(), held);
  assert.equal(h.$('pf-scenario-hint').textContent, 'Ungrounded output is rejected and repaired; at delivery one criterion is shown by checks, one passed before the change too.');
  await pick('replan');
  assert.deepEqual(state(), free('observe'), 'another scenario gives Observe only back');
  await pick('evidence');
  await demoOn(h, false);
  assert.deepEqual(state(), free('observe'), 'so does turning the demo off');
  await demoOn(h);
  assert.deepEqual(state(), held, 'the demo on again with the evidence scenario');
  await h.submit();
  assert.deepEqual(h.sent[0], { task: 'Fix the parser', demo: true, demoScenario: 'evidence', delivery: 'apply', sandbox: { mode: 'host' }, grounding: 'enforce', guidance: false, conversation: true });

  // the scenario and the demo stay as they were; the held choice does not survive a new drawer
  await h.open();
  assert.deepEqual(state(), held);
  await demoOn(h, false);
  assert.deepEqual(state(), free('enforce'), 'a new drawer starts from the default, not the old Observe only');
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  for (const s of ['<option value="parallel">Parallel steps</option>\n              <option value="evidence">Evidence checks</option>',
    '</select>\n              <span class="hint" id="pf-grounding-hint" hidden>The evidence demo needs Enforce.</span>']) {
    assert.ok(html.includes(s), s);
  }
});

// Guards the removed `demo ||` on e.docker/e.host/e.image/e.build in sync() and `|| e.demo.checked` in renderSandbox,
// and that the sandbox set is no longer dimmed while the rest stays off
test('demo scenario: the sandbox choice and the image build stay operable for a demo; everything else stays off', async (t) => {
  const h = harness({ info: withSandbox(missing()) });
  done(t, h);
  await h.open();
  await demoOn(h);
  assert.equal(h.$('pf-host').checked, true, 'the demo keeps the host default');
  await h.pick('docker');
  assert.deepEqual([h.$('pf-docker').disabled, h.$('pf-host').disabled, h.$('pf-image').disabled, h.$('pf-build').disabled], [false, false, false, false]);
  assert.notEqual(h.$('pf-sandbox-set').dataset.demo, 'true', 'not dimmed');
  assert.equal(h.$('pf-sandbox-status').textContent, `The sandbox image ${IMAGE} has not been built yet.`);
  await h.$('pf-build').fire('click');
  assert.deepEqual(h.posts.at(-1), { url: '/api/pipeline/sandbox/build', body: {} });
  assert.deepEqual([h.$('pf-check-add').disabled, h.$('pf-setup-add').disabled, h.$('pf-model-planner').disabled, h.$('pf-approval').disabled, h.$('pf-replans').disabled],
    [true, true, true, true, true]);
  assert.deepEqual([h.$('pf-checks-set').dataset.demo, h.$('pf-models-set').dataset.demo, h.$('pf-policy-set').dataset.demo], ['true', 'true', 'true']);
});

// Guards `e.trustDemo.hidden = !demo || !host;`, `if (e.host.checked && !e.demo.checked) e.trust.focus();` and
// `if (demo) return { sandbox: { mode: 'host' } };` in sandboxOf
test('demo scenario: the trusted host needs no acknowledgement for a demo, says so, and still needs it for a real run', async (t) => {
  const h = harness({ info: withSandbox(sandbox()) });
  done(t, h);
  await h.open({ ack: false });
  h.$('pf-docker').checked = false;
  h.$('pf-host').checked = true;
  await h.$('pf-host').fire('change');
  assert.deepEqual([h.$('pf-trust-row').hidden, h.$('pf-trust-demo').hidden], [false, true]);
  assert.equal(document.activeElement, h.$('pf-trust'), 'a real run asks for the acknowledgement');
  await h.submit();
  assert.deepEqual(h.sent, [], 'refused without the acknowledgement');
  assert.equal(h.$('run-error').textContent, 'Confirm that the checks may run on this computer without OS isolation, or use Docker.');

  await demoOn(h);
  assert.deepEqual([h.$('pf-trust-row').hidden, h.$('pf-trust-demo').hidden], [true, false]);
  h.$('pf-docker').checked = true;
  h.$('pf-host').checked = false;
  await h.$('pf-docker').fire('change');
  assert.equal(h.$('pf-trust-demo').hidden, true, 'nothing to say while Docker is picked');
  h.$('pf-docker').checked = false;
  h.$('pf-host').checked = true;
  document.activeElement = null;
  await h.$('pf-host').fire('change');
  assert.equal(h.$('pf-trust-demo').hidden, false);
  assert.notEqual(document.activeElement, h.$('pf-trust'), 'focus does not go to a hidden checkbox');
  assert.match(readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8'),
    /<p class="hint pf-note" id="pf-trust-demo" hidden>No acknowledgement is needed for the demo: only the bundled sample project runs/);
  assert.notEqual(document.activeElement, h.$('pf-trust'), 'focus does not go to a hidden checkbox');
  assert.equal(h.$('pf-image').disabled, true, 'the image is a Docker setting');
  assert.equal(h.$('pf-trust').checked, false);
  await h.submit();
  assert.deepEqual(h.sent[0].sandbox, { mode: 'host' });
});

// Conversation starts use the same form defaults, but never infer a demo from a question.
test('Pipeline Chat dock starts a real conversation using detected checks and stored models, even in the pipeline read-only Team scope', async (t) => {
  const h = harness();
  done(t, h);
  await h.open();
  await h.$('pf-model-planner').fire('change');
  h.panel.setReadOnly(true);
  const sent = [];
  const target = { project: 'core', startPipeline: async (body) => { sent.push(body); return { ok: true, status: 202, data: { runId: 'chatanswer' } }; } };
  // the default host: the acknowledgement of the drawer is not carried into the dock, the fix is in the drawer
  assert.deepEqual(await h.panel.startPipelineFollowUp('Why does addition subtract?', target),
    { error: 'Confirm that the checks may run on this computer without OS isolation, or use Docker.', field: 'trustHost', options: true });
  assert.equal(sent.length, 0);
  await h.pick('docker');
  const result = await h.panel.startPipelineFollowUp('Why does addition subtract?', target);
  assert.equal(result.ok, true, result.error);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].sandbox, { mode: 'docker' }, 'an explicit Docker pick holds for the dock');
  assert.equal(sent[0].task, 'Why does addition subtract?');
  assert.equal(sent[0].conversation, true);
  assert.equal(sent[0].demo, undefined);
  assert.deepEqual(sent[0].checks, [{ id: 'test', kind: 'test', command: 'npm test', required: true }]);
  assert.deepEqual(sent[0].models.planner, { provider: 'anthropic', model: 'claude' });
});

test('Direct answer demo is selectable in the mounted form and starts with conversation enabled', async (t) => {
  const h = harness();
  done(t, h);
  await h.open();
  h.$('pf-demo').checked = true;
  await h.$('pf-demo').fire('change');
  h.$('pf-scenario').value = 'answer';
  await h.$('pf-scenario').fire('change');
  assert.match(h.$('pf-scenario-hint').textContent, /Nothing is changed/);
  await h.submit();
  assert.equal(h.sent[0].demoScenario, 'answer');
  assert.equal(h.sent[0].conversation, true);
  assert.equal(h.sent[0].demo, true);
});
