// The Agents drawer (.enma/roles-contract.md section 4): one row per role, a prompt editor that saves with
// PUT /api/agents/:id/prompt and resets with DELETE after a confirm, read only for a prompt pinned in
// scranton.config.json, an advisory keyword warning, and a guard against losing unsaved edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentsPanel } from '../../visualizer/public/js/agents-panel.js';
import {
  parseAgents, buildPrompt, missingKeywords, missingNote, roleView, promptUrl, PROMPT_MAX_BYTES, isDirty, probeDelay, PROBE_RETRY_MAX_MS,
} from '../../visualizer/public/js/agents.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const role = (id, name, title, keywords, prompt, extra = {}) => ({
  id, name, title, keywords, tools: ['read', 'grep', 'find', 'ls', 'bash'], gate: ['oscar', 'hank', 'angela'].includes(id),
  prompt: { editable: true, builtinText: `built-in ${id}`, missingKeywords: [], ...prompt }, ...extra,
});
const DOC = {
  roles: [
    role('angela', 'Angela', 'QA', ['TEST_PASSED', 'TEST_FAILED', 'BLOCKED'], { source: 'builtin', text: 'Test it and say [TEST_PASSED].', missingKeywords: ['TEST_FAILED', 'BLOCKED'] }),
    role('michael', 'Michael', 'Orchestrator', ['PLAN_READY'], { source: 'builtin', text: 'Plan. [PLAN_READY]' }),
    role('dwight', 'Dwight', 'Developer', ['TASK_COMPLETE', 'BLOCKED'], { source: 'builtin', text: 'Build. [TASK_COMPLETE] [BLOCKED]' }),
    role('oscar', 'Oscar', 'Reviewer', ['REVIEW_APPROVED', 'CHANGES_REQUESTED', 'BLOCKED'], { source: 'custom', text: 'Review it. [REVIEW_APPROVED] [CHANGES_REQUESTED] [BLOCKED]' }),
    role('hank', 'Hank', 'Security', ['SECURITY_PASSED', 'SECURITY_ISSUES', 'BLOCKED'], { source: 'config', editable: false, text: 'Audit. [SECURITY_PASSED] [SECURITY_ISSUES] [BLOCKED]' }),
  ],
  workflow: { default: [['oscar', 'hank'], ['angela']] },
};

test('parseAgents: rows in contract order, pinned prompts never editable, unknown shapes dropped', () => {
  const p = parseAgents({ ...DOC, roles: [...DOC.roles, { id: 'Bad Id' }, DOC.roles[0], { id: 'x', keywords: ['ok', 'FINE_1'], prompt: { source: 'magic', editable: true } }] });
  assert.deepEqual(p.roles.map((r) => r.id), ['michael', 'dwight', 'oscar', 'hank', 'angela', 'x']);
  assert.equal(p.roles.find((r) => r.id === 'hank').prompt.editable, false);
  const x = p.roles.at(-1);
  assert.deepEqual([x.prompt.source, x.keywords, x.name], ['builtin', ['FINE_1'], 'x']);
  assert.deepEqual(parseAgents({ roles: [role('hank', 'Hank', '', [], { source: 'config', editable: true, text: 't' })] }).roles[0].prompt.editable, false, 'config wins over the flag');
  assert.deepEqual(p.defaultGates, [['oscar', 'hank'], ['angela']]);
  assert.equal(parseAgents({ agents: [] }), null);
  assert.equal(promptUrl('oscar'), '/api/agents/oscar/prompt');
  assert.equal(promptUrl('../x'), null);
});

test('buildPrompt: trimmed non-empty, at most 32 KiB of UTF-8, read only refused', () => {
  const oscar = parseAgents(DOC).roles.find((r) => r.id === 'oscar');
  const hank = parseAgents(DOC).roles.find((r) => r.id === 'hank');
  assert.deepEqual(buildPrompt('  Review.\n', oscar), { body: { text: '  Review.\n' } }, 'sent as typed');
  assert.match(buildPrompt(' \n\t', oscar).error, /empty/);
  assert.equal(buildPrompt('a'.repeat(PROMPT_MAX_BYTES), oscar).body.text.length, PROMPT_MAX_BYTES);
  const wide = '\u00e9'.repeat(PROMPT_MAX_BYTES / 2 + 1);
  assert.equal(buildPrompt(wide, oscar).error, `The prompt is ${PROMPT_MAX_BYTES + 2} bytes; the limit is ${PROMPT_MAX_BYTES}.`, 'bytes, not characters');
  assert.equal(buildPrompt('Audit', hank).error, "Hank's prompt is read only here.");
  assert.equal(isDirty(hank, 'other'), false, 'a read-only prompt has nothing to lose');
  assert.equal(roleView(hank).source, 'Set by config');
  assert.equal(roleView(oscar).source, 'Custom');
  assert.deepEqual(missingKeywords('say [REVIEW_APPROVED] or REVIEW_DENIED', ['REVIEW_APPROVED', 'CHANGES_REQUESTED']), ['CHANGES_REQUESTED']);
  assert.match(missingNote(['TEST_FAILED', 'BLOCKED']), /never mentions \[TEST_FAILED\] and \[BLOCKED\]/);
  assert.equal(missingNote([]), '');
});

// the drawer with a fake server; requests lists every call, confirms every confirm the drawer asked
function harness({ answer = DOC, put = { ok: true }, on = { value: true } } = {}) {
  const $ = installDom();
  const close = new FakeEl();
  $('agents-dialog').querySelectorAll = () => [close];
  const requests = [];
  let doc = structuredClone(answer);
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body === undefined ? undefined : JSON.parse(opts.body) });
    if (!opts.method) return doc === null ? { ok: false, status: 404, json: async () => null } : { ok: true, status: 200, json: async () => structuredClone(doc) };
    if (put.status) return { ok: false, status: put.status, json: async () => ({ error: put.error ?? 'nope' }) };
    const id = /\/api\/agents\/([a-z]+)\/prompt/.exec(url)[1];
    const r = doc.roles.find((x) => x.id === id);
    if (opts.method === 'PUT') Object.assign(r.prompt, { source: 'custom', text: JSON.parse(opts.body).text });
    else Object.assign(r.prompt, { source: 'builtin', text: r.prompt.builtinText });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const confirms = [];
  const panel = createAgentsPanel({ getControl: () => ({ gates: { on: on.value } }), confirm: (c) => confirms.push(c) });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const rows = () => $('agents-list').childNodes;
  const row = (i) => {
    const [head, detail, actions] = rows()[i].childNodes;
    return { name: head.childNodes[0], title: head.childNodes[1], source: head.childNodes[2], keywords: detail.childNodes[0], tools: detail.childNodes[1], edit: actions.childNodes[0] };
  };
  const ready = async () => {
    panel.render();
    await tick();
    panel.open();
    await tick();
  };
  const type = (text) => {
    $('prompt-text').value = text;
    return $('prompt-text').fire('input');
  };
  return { $, panel, requests, confirms, tick, rows, row, ready, type, close, on };
}

test('the Agents button shows only with control on and a server that has the agents route', async () => {
  const h = harness();
  assert.equal(h.$('agents-open').hidden, false, 'nothing known yet');
  h.panel.render();
  assert.equal(h.$('agents-open').hidden, true, 'until /api/agents answers');
  await h.tick();
  assert.equal(h.$('agents-open').hidden, false);
  assert.deepEqual(h.requests.map((r) => [r.method, r.url, r.headers['X-Scranton-Client']]), [['GET', '/api/agents', '1']]);

  const old = harness({ answer: null });
  old.panel.render();
  await old.tick();
  assert.equal(old.$('agents-open').hidden, true, 'an older server has no agents route');
  assert.equal(old.panel.open(), false);

  const off = harness({ on: { value: false } });
  off.panel.render();
  await off.tick();
  assert.equal(off.$('agents-open').hidden, true);
  assert.deepEqual(off.requests, [], 'without control nothing is asked');
});

test('list: one row per role with name, title, keyword chips, tools and the prompt source', async () => {
  const h = harness();
  await h.ready();
  assert.equal(h.$('agents-dialog').open, true);
  assert.equal(h.$('agents-list').hidden, false);
  assert.equal(h.rows().length, 5);
  const seen = h.rows().map((_, i) => {
    const r = h.row(i);
    return [r.name.textContent, r.title.textContent, r.source.textContent, r.keywords.childNodes.map((c) => c.textContent).join(' '), r.edit.textContent];
  });
  assert.deepEqual(seen, [
    ['Michael', 'Orchestrator', 'Built-in', 'PLAN_READY', 'Edit prompt'],
    ['Dwight', 'Developer', 'Built-in', 'TASK_COMPLETE BLOCKED', 'Edit prompt'],
    ['Oscar', 'Reviewer', 'Custom', 'REVIEW_APPROVED CHANGES_REQUESTED BLOCKED', 'Edit prompt'],
    ['Hank', 'Security', 'Set by config', 'SECURITY_PASSED SECURITY_ISSUES BLOCKED', 'View prompt'],
    ['Angela', 'QA', 'Built-in', 'TEST_PASSED TEST_FAILED BLOCKED', 'Edit prompt'],
  ]);
  assert.ok(h.row(2).keywords.childNodes.every((c) => c.className === 'kw-chip mono'));
  assert.equal(h.row(2).tools.textContent, 'read · grep · find · ls · bash');
  assert.equal(globalThis.document.activeElement, h.row(0).edit, 'the first row takes the focus once the list is there');
});

test('edit and save: PUT with the control headers and the text only, then the row reports Custom', async () => {
  const h = harness();
  await h.ready();
  await h.row(1).edit.fire('click');
  assert.equal(h.$('prompt-panel').hidden, false);
  assert.equal(h.$('prompt-title').textContent, "Dwight's system prompt");
  assert.equal(h.$('prompt-text').value, 'Build. [TASK_COMPLETE] [BLOCKED]');
  assert.equal(h.$('prompt-text').readOnly, false);
  assert.equal(globalThis.document.activeElement, h.$('prompt-text'));
  assert.equal(h.row(1).edit.getAttribute('aria-expanded'), 'true');
  assert.equal(h.$('prompt-save').disabled, true, 'nothing to save yet');
  assert.equal(h.$('prompt-reset').hidden, true, 'a built-in prompt has nothing to reset');

  await h.type('Build carefully. [TASK_COMPLETE] [BLOCKED]');
  assert.equal(h.$('prompt-save').disabled, false);
  assert.equal(h.$('agents-foot').textContent, 'Unsaved changes');
  await h.$('prompt-panel').fire('submit');
  const put = h.requests.find((r) => r.method === 'PUT');
  assert.equal(put.url, '/api/agents/dwight/prompt');
  assert.deepEqual(put.body, { text: 'Build carefully. [TASK_COMPLETE] [BLOCKED]' });
  assert.equal(put.headers['X-Scranton-Client'], '1');
  assert.equal(put.headers['Content-Type'], 'application/json');
  assert.equal(h.$('prompt-panel').hidden, true);
  assert.equal(h.$('prompt-text').value, '', 'the editor lets go of the text');
  assert.equal(h.row(1).source.textContent, 'Custom', 'reloaded from the server');
  assert.equal(h.$('agents-status').textContent, "Saved Dwight's prompt. Runs started from now on use it.");
  assert.equal(globalThis.document.activeElement, h.row(1).edit);
});

test('reset to built-in asks first and only then sends DELETE', async () => {
  const h = harness();
  await h.ready();
  await h.row(2).edit.fire('click');
  assert.equal(h.$('prompt-reset').hidden, false, 'a custom prompt can be reset');
  await h.$('prompt-reset').fire('click');
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].title, "Reset Oscar's prompt?");
  assert.equal(h.confirms[0].ok, 'Reset to built-in');
  assert.equal(h.requests.some((r) => r.method === 'DELETE'), false, 'nothing is deleted before the confirm');
  const r = await h.confirms[0].action();
  const del = h.requests.find((x) => x.method === 'DELETE');
  assert.equal(del.url, '/api/agents/oscar/prompt');
  assert.equal(del.headers['X-Scranton-Client'], '1');
  assert.equal(r.focus, h.row(2).edit);
  assert.equal(h.row(2).source.textContent, 'Built-in');
  assert.equal(h.$('prompt-panel').hidden, true);
});

test('a prompt set by scranton.config.json is read only, with a note saying where it comes from', async () => {
  const h = harness();
  await h.ready();
  await h.row(3).edit.fire('click');
  assert.equal(h.$('prompt-text').readOnly, true);
  assert.equal(h.$('prompt-save').hidden, true);
  assert.equal(h.$('prompt-reset').hidden, true);
  assert.equal(h.$('prompt-cancel').textContent, 'Close');
  assert.equal(h.$('prompt-note').hidden, false);
  assert.match(h.$('prompt-note').textContent, /agents\.hank\.skill in scranton\.config\.json/);
  await h.type('anything');
  await h.$('prompt-panel').fire('submit');
  assert.equal(h.requests.some((r) => r.method === 'PUT'), false);
  await h.$('prompt-cancel').fire('click');
  assert.equal(h.confirms.length, 0, 'nothing to lose, nothing to ask');
  assert.equal(h.$('prompt-panel').hidden, true);
});

test('a prompt without some of its keywords gets an advisory warning that names them', async () => {
  const h = harness();
  await h.ready();
  await h.row(4).edit.fire('click');
  assert.equal(h.$('prompt-warning').hidden, false);
  assert.match(h.$('prompt-warning').textContent, /never mentions \[TEST_FAILED\] and \[BLOCKED\]/);
  await h.type('Test it. [TEST_PASSED] [TEST_FAILED] [BLOCKED]');
  assert.equal(h.$('prompt-warning').hidden, true, 'the draft is checked as it is typed');
  await h.type('Test it. [TEST_PASSED]');
  assert.match(h.$('prompt-warning').textContent, /\[TEST_FAILED\] and \[BLOCKED\]/);
  assert.equal(h.$('prompt-save').disabled, false, 'only advice: saving stays possible');
});

test('unsaved edits: closing, Escape and another row ask first; Cancel keeps the draft', async () => {
  const h = harness();
  await h.ready();
  await h.row(2).edit.fire('click');
  await h.type('Draft review prompt');

  let prevented = false;
  await h.$('agents-dialog').fire('cancel', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'Escape does not close over unsaved edits');
  assert.equal(h.$('agents-dialog').open, true);
  assert.equal(h.confirms.at(-1).title, "Discard changes to Oscar's prompt?");

  await h.row(0).edit.fire('click');
  assert.equal(h.confirms.length, 2, 'another row asks too');
  assert.equal(h.$('prompt-text').value, 'Draft review prompt', 'until confirmed, the draft stays');

  await h.close.fire('click');
  assert.equal(h.confirms.length, 3);
  assert.equal(h.$('agents-dialog').open, true);
  h.confirms[2].action();
  assert.equal(h.$('agents-dialog').open, false, 'discarded and closed');
  assert.equal(h.$('prompt-text').value, '');
  assert.deepEqual(h.rows(), [], 'no prompt text is kept once the drawer is closed');
  assert.equal(h.requests.some((r) => r.method === 'PUT'), false);
});

test('a prompt file with Windows line endings is not an unsaved edit once the textarea shows it', async () => {
  const crlf = structuredClone(DOC);
  crlf.roles.find((r) => r.id === 'dwight').prompt.text = '# Dwight\r\n\r\nBuild. [TASK_COMPLETE] [BLOCKED]\r\n';
  const h = harness({ answer: crlf });
  await h.ready();
  await h.row(1).edit.fire('click');
  // a browser textarea turns CRLF into LF; the fake one does not, so do what the browser does
  await h.type(h.$('prompt-text').value.replace(/\r\n/g, '\n'));
  assert.equal(h.$('prompt-save').disabled, true, 'nothing was edited');
  assert.equal(h.$('agents-foot').textContent, '');
  await h.close.fire('click');
  assert.equal(h.confirms.length, 0, 'closing asks nothing');
  assert.equal(h.$('agents-dialog').open, false);
});

test('a refused save is shown in the editor, which keeps the draft and the focus', async () => {
  const h = harness({ put: { status: 409 } });
  await h.ready();
  await h.row(2).edit.fire('click');
  await h.type('New review prompt [REVIEW_APPROVED] [CHANGES_REQUESTED] [BLOCKED]');
  await h.$('prompt-panel').fire('submit');
  assert.equal(h.$('prompt-error').hidden, false);
  assert.equal(h.$('prompt-error').textContent, "Oscar's prompt is set by scranton.config.json and cannot be changed here.");
  assert.equal(h.$('prompt-text').getAttribute('aria-invalid'), 'true');
  assert.equal(globalThis.document.activeElement, h.$('prompt-text'));
  assert.equal(h.$('prompt-text').value, 'New review prompt [REVIEW_APPROVED] [CHANGES_REQUESTED] [BLOCKED]');

  const before = h.requests.length;
  await h.type('   ');
  await h.$('prompt-panel').fire('submit');
  assert.equal(h.requests.length, before, 'an empty prompt is never sent');
  assert.match(h.$('prompt-error').textContent, /empty/);
});

test('prompt text is never stored or logged on the client', async (t) => {
  const writes = [];
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
  globalThis.sessionStorage = globalThis.localStorage;
  const logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, m, (...a) => logged.push(a));
  const h = harness();
  await h.ready();
  await h.row(2).edit.fire('click');
  await h.type('Secretive review prompt [REVIEW_APPROVED]');
  await h.$('prompt-panel').fire('submit');
  await h.close.fire('click');
  assert.deepEqual(writes, []);
  assert.deepEqual(logged, []);
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});

test('control turning off closes the drawer and hides the button', async () => {
  const h = harness();
  await h.ready();
  await h.row(1).edit.fire('click');
  await h.type('half written');
  h.on.value = false;
  h.panel.render();
  assert.equal(h.$('agents-dialog').open, false);
  assert.equal(h.$('agents-open').hidden, true);
  assert.equal(h.$('prompt-text').value, '');
  assert.equal(h.panel.available(), false);
});

// ------------------------------------------------------------ the probe and late replies

// the probe for the button alone, with answers given in order (the last one repeats); fetch counts every ask
function probe(t, answers) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const $ = installDom();
  let calls = 0;
  globalThis.fetch = async () => answers[Math.min(calls++, answers.length - 1)]();
  const panel = createAgentsPanel({ getControl: () => ({ gates: { on: true } }), confirm() {} });
  // the mocked setTimeout does not cover setImmediate, so the replies can settle in between
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  return { $, panel, flush, calls: () => calls };
}
const offline = () => { throw new TypeError('Failed to fetch'); };
const status = (code, body = {}) => () => ({ ok: code < 300, status: code, json: async () => structuredClone(body) });

test('the Agents probe asks again with a growing delay until the server answers', async (t) => {
  const p = probe(t, [offline, status(503), status(200, DOC)]);
  p.panel.render();
  await p.flush();
  assert.equal(p.calls(), 1);
  assert.equal(p.$('agents-open').hidden, true, 'no answer yet');
  t.mock.timers.tick(probeDelay(0) - 1);
  await p.flush();
  assert.equal(p.calls(), 1, 'not before the delay');
  t.mock.timers.tick(1);
  await p.flush();
  assert.equal(p.calls(), 2, 'a network error is asked again');
  assert.equal(p.$('agents-open').hidden, true);
  assert.ok(probeDelay(1) > probeDelay(0), 'the delay grows');
  t.mock.timers.tick(probeDelay(1));
  await p.flush();
  assert.equal(p.calls(), 3, 'a 5xx is asked again');
  assert.equal(p.$('agents-open').hidden, false, 'the 200 shows the button');
  t.mock.timers.tick(PROBE_RETRY_MAX_MS * 4);
  await p.flush();
  assert.equal(p.calls(), 3, 'a definitive answer ends the probing');
});

test('a 404 is definitive: the button stays hidden and nothing is asked again', async (t) => {
  const p = probe(t, [status(503), status(404)]);
  p.panel.render();
  await p.flush();
  t.mock.timers.tick(probeDelay(0));
  await p.flush();
  assert.equal(p.calls(), 2);
  t.mock.timers.tick(PROBE_RETRY_MAX_MS * 4);
  await p.flush();
  assert.equal(p.calls(), 2, 'no agents routes on this server');
  assert.equal(p.$('agents-open').hidden, true);
  assert.equal(probeDelay(50), PROBE_RETRY_MAX_MS, 'the delay is capped');
});

test('a save reply that arrives after the drawer was closed and reopened acts on nothing', async () => {
  const h = harness();
  const server = globalThis.fetch;
  let release = null;
  globalThis.fetch = (url, opts = {}) => (opts.method === 'PUT' ? new Promise((r) => { release = () => r(server(url, opts)); }) : server(url, opts));
  await h.ready();
  await h.row(1).edit.fire('click');
  await h.type('Build carefully. [TASK_COMPLETE] [BLOCKED]');
  const saving = h.$('prompt-panel').fire('submit');
  await h.tick();
  assert.equal(h.$('prompt-status').textContent, 'Saving...');

  // the human leaves with the save still out (it asks, the draft is unsaved), then opens Oscar's prompt
  await h.close.fire('click');
  h.confirms.at(-1).action();
  assert.equal(h.$('agents-dialog').open, false);
  h.panel.open();
  await h.tick();
  await h.row(2).edit.fire('click');
  await h.type('Oscar draft');
  const asked = h.confirms.length;

  release();
  await saving;
  await h.tick();
  assert.equal(h.panel.editing(), 'oscar', 'the other editor stays open');
  assert.equal(h.$('prompt-panel').hidden, false);
  assert.equal(h.$('prompt-text').value, 'Oscar draft', 'its draft is not discarded');
  assert.equal(h.confirms.length, asked, 'and nothing was asked about it');
  assert.equal(h.$('agents-status').textContent, '', 'no "Saved Dwight\'s prompt" for a drawer that is gone');
  assert.equal(h.$('prompt-save').disabled, false, 'the new editor is not left busy');
  assert.equal(h.row(1).source.textContent, 'Custom', 'the reopened rows learn about the save');
});
