// The Pipeline part of the New run drawer with the fake DOM: setup rows from detect, row-level errors (client and
// server), the model note, and the team demo choice when the control document lists no scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// answer: what startPipeline resolves to
function harness({ detect = DETECT, info = INFO, answer = { ok: true, status: 202, data: { ok: true, runId: 'abc123def456' } } } = {}) {
  const $ = installDom();
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => structuredClone(detect) };
    }
    if (url === '/api/pipeline') return { ok: true, status: 200, json: async () => structuredClone(info) };
    return { ok: true, status: 200, json: async () => structuredClone(CONTROL) };
  };
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({
    dashboard: stub, pipeline: stub, lanes: stub, models: null, getState: () => createState(),
    url: () => '/api/control', pipelineForm: createPipelineForm(),
  });
  const sent = [];
  const open = async () => {
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
  return { $, panel, posts, sent, open, row, submit };
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
test('models: no API-key requirement is claimed; pi models are marked and unsupported ones keep their reason', async (t) => {
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
  assert.equal(pi.$('pf-model-planner').childNodes[1].label, 'Anthropic · via pi');
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
