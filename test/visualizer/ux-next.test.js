// One Messages tab with the inboxes folded under it, a view bar that names its icons, a New run drawer that asks for
// the request and keeps the rest in one fold, a Start that says why it cannot be pressed, and a no-sandbox
// acknowledgement that a chat gives once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startBlock, parseControl } from '../../visualizer/public/js/control.js';
import { TRUST_KEY, trustKey, parseTrusted, isTrusted, rememberTrust, forgetTrust } from '../../visualizer/public/js/trust.js';
import { harness, CONTROL } from './fixtures/run-drawer.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');

test('messages: one tab, the inboxes that hold a message fold under the transcript', () => {
  const html = read('index.html');
  const tabs = html.match(/<div class="tabs"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...tabs.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]), ['events', 'chat']);
  assert.doesNotMatch(html, /mail-panel|tab-mail|Mailboxes/);
  assert.match(html, /<\/ol>\s*<p class="log-empty" id="chat-empty">No messages yet<\/p>\s*<\/div>\s*<details class="inboxes" id="inboxes" hidden>\s*<summary>Inboxes <span class="tab-count" id="inbox-count">0<\/span>[^\n]*<\/summary>\s*<ul class="mailboxes" id="mailboxes"><\/ul>\s*<\/details>\s*<form class="chat-form"/);
  const js = read('js/dashboard.js');
  assert.match(js, /const boxes = s\?\.runId \? ids\.filter\(\(id\) => s\.mailboxes\?\.\[id\]\) : \[\];/, 'an inbox nobody wrote to is not listed');
  assert.match(js, /e\.inboxes\.hidden = boxes\.length === 0;/);
  assert.doesNotMatch(js, /mb-file|mb-meta', 'empty'/, 'no file path column, no empty rows');
});

test('sidebar and view bar: plain words for the one project, a name under every icon, a tab bar on a phone', () => {
  const html = read('index.html');
  assert.match(html, /<span class="badge" id="nav-mode" title="[^"]+" hidden>One project<\/span>/);
  assert.match(readFileSync(new URL('../../src/server/registry-router.js', import.meta.url), 'utf8'),
    /const title = !registry && runs\[0\]\?\.goal \? derivedChatTitle\(String\(runs\[0\]\.goal\)\) : chat\.title;/, 'the one chat is called what it was first asked');
  const css = read('styles.css');
  assert.match(css, /\.viewbar \{[^}]*flex: 0 0 4rem;\s*width: 4rem;/);
  assert.match(css, /\.bar-label \{ font-size: 0\.6875rem; line-height: 1; font-weight: 500; white-space: nowrap; \}/);
  const phone = css.slice(css.indexOf('/* a phone has no width to give to a column'));
  assert.match(phone, /^[^\n]*\n@media \(max-width: 600px\) \{\s*body \{ padding-bottom: 3\.5rem; \}[\s\S]*?\.viewbar \{\s*position: fixed; top: auto; right: 0; bottom: 0; left: 0; width: auto; height: 3\.5rem;\s*flex-direction: row;/);
  assert.match(css, /\.side \{ position: fixed; top: var\(--topbar-h\); right: 4rem; bottom: 0;/, 'the overlaid side panel ends at the wider bar');
});

test('Start says why it cannot be pressed', () => {
  const on = parseControl({ ...CONTROL });
  const block = (over) => startBlock({ control: on, mode: 'live', ...over });
  assert.equal(block({}), '');
  assert.equal(block({ control: parseControl({ ...CONTROL, run: { runId: 'r', pid: 1 } }) }), 'A run is in progress');
  assert.equal(block({ control: parseControl({ ...CONTROL, run: { runId: 'r', pid: 1 } }), target: true }), '', 'a chat made for the run is not held up by this one');
  assert.equal(block({ control: parseControl({ ...CONTROL, recoveryRequired: true }) }), 'Recovery required');
  assert.equal(block({ replaying: true }), 'Showing an earlier run: go back to live first');
  assert.equal(block({ control: parseControl(null) }), 'This server is read only: it does not start runs');
  assert.equal(block({ control: parseControl(null), mode: 'connecting' }), 'Connecting to the server');
  assert.equal(block({ mode: 'demo' }), 'The page shows a demo: no run can be started here');
  assert.equal(block({ mode: 'demo', submitting: true }), '', 'the button itself says Starting...');
});

test('New run: the request, Options in one closed fold with its choices in a line, and the reason beside Start', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('run-options').open, false);
  assert.equal(h.$('run-options-summary').textContent, 'Checks: Review + Security, then Tests · Scranton sandbox · up to 3 milestones at once');
  assert.equal(h.$('run-busy').hidden, true);
  assert.equal(h.$('run-submit').disabled, false);
  await h.sandbox(false);
  h.$('f-parallel').value = '1';
  await h.$('f-parallel').fire('input');
  assert.equal(h.$('run-options-summary').textContent, 'Checks: Review + Security, then Tests · Docker sandbox · one milestone at a time');
  // a mistake inside the fold opens it; one in the request does not
  await h.sandbox(true);
  h.$('f-request').value = '';
  await h.$('run-form').fire('submit');
  assert.equal(h.$('f-request').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('run-options').open, false);
  h.$('f-request').value = 'Build it';
  h.$('f-parallel').value = '99';
  await h.$('run-form').fire('submit');
  assert.equal(h.$('run-options').open, true);
  assert.equal(h.$('f-parallel').getAttribute('aria-invalid'), 'true');

  const html = read('index.html');
  const form = html.slice(html.indexOf('<form id="run-form"'), html.indexOf('<div class="pf" id="pipeline-fields"'));
  const fold = form.slice(form.indexOf('<details class="run-options team-only" id="run-options">'), form.lastIndexOf('</details>'));
  for (const id of ['f-workspace', 'workflow-fields', 'exec-fields', 'model-fields', 'run-advanced']) assert.ok(fold.includes(`id="${id}"`), `${id} is an option`);
  assert.ok(!fold.includes('id="f-request"') && !fold.includes('id="f-trust-row"'), 'the request and the acknowledgement are never folded away');
  assert.match(html, /<span class="hint run-reason" id="run-busy" role="status" hidden>/);

  // a run that is going: Start is off, and the line beside it says so
  h.server.control = { ...CONTROL, run: { runId: 'r1', pid: 4, startedAt: '2026-11-16T10:00:00Z' } };
  await h.panel.refresh();
  assert.equal(h.$('run-submit').disabled, true);
  assert.deepEqual([h.$('run-busy').hidden, h.$('run-busy').textContent], [false, 'A run is in progress']);
});

test('trust: the list is bounded and tolerant, a chat is named by project and chat', () => {
  const map = new Map();
  const store = { get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v) };
  assert.equal(trustKey({ project: 'core', chat: 'a' }), 'core/a');
  assert.equal(trustKey({ project: 'core' }), null, 'no chat on screen: nothing to remember');
  assert.equal(trustKey(null, { projects: false }), 'single');
  assert.deepEqual(parseTrusted('{"a":1}'), []);
  assert.deepEqual(parseTrusted('["a", 3, "", "a", "b"]'), ['a', 'b']);
  assert.equal(isTrusted(store, 'core/a'), false);
  rememberTrust(store, null);
  assert.equal(map.size, 0);
  rememberTrust(store, 'core/a');
  rememberTrust(store, 'core/b');
  rememberTrust(store, 'core/a');
  assert.deepEqual(JSON.parse(map.get(TRUST_KEY)), ['core/b', 'core/a']);
  assert.deepEqual([isTrusted(store, 'core/a'), isTrusted(store, 'core/c'), isTrusted(store, null)], [true, false, false]);
  forgetTrust(store, 'core/a');
  assert.equal(isTrusted(store, 'core/a'), false);
  for (let i = 0; i < 250; i += 1) rememberTrust(store, `p/${i}`);
  assert.equal(parseTrusted(map.get(TRUST_KEY)).length, 200);
});

test('trust: asked once per chat - the chat that ran on the host has it ticked, another chat is asked', async (t) => {
  let key = 'core/a';
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  // the fixture's panel has no chat: a panel that knows which chat is on screen
  const { createControlPanel } = await import('../../visualizer/public/js/control-panel.js');
  const { createState } = await import('../../visualizer/public/js/state.js');
  h.panel.setMode('demo');
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({ dashboard: stub, pipeline: stub, lanes: stub, models: h.models, getState: () => createState(), url: (s) => `/api/projects/core/chats/a/${s}`, chatKey: () => key });
  t.after(() => panel.setMode('demo'));
  const open = async () => {
    panel.setMode('live');
    await h.tick();
    panel.openRun();
    await h.tick();
    h.$('f-request').value = 'Build it';
  };
  await open();
  // the trusted host is picked, never preselected
  await h.sandbox('host');
  h.$('f-trusted').checked = false;
  assert.equal(h.$('f-trust-row').hidden, false);
  assert.deepEqual([h.$('f-trusted').checked, h.$('f-trust-kept').hidden], [false, true], 'a chat that never ran asks');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 0, 'and nothing starts without the answer');
  h.$('f-trusted').checked = true;
  await h.$('run-form').fire('submit');
  await h.tick();
  assert.equal(h.posts.length, 1);
  assert.deepEqual(JSON.parse(h.storage.map.get(TRUST_KEY)), ['core/a']);

  await open();
  assert.deepEqual([h.$('f-trusted').checked, h.$('f-trust-kept').hidden], [true, false], 'the same chat is not asked again');
  // Docker and back: still given; the follow-up composer starts with it as well
  await h.sandbox(false);
  assert.equal(h.$('f-trust-row').hidden, true);
  for (const m of ['scranton', 'docker']) h.$(`f-sandbox-${m}`).checked = false;
  h.$('f-sandbox-host').checked = true;
  await h.$('f-sandbox-host').fire('change');
  assert.equal(h.$('f-trusted').checked, true);
  h.$('run-dialog').close();
  h.$('f-trusted').checked = false;
  assert.deepEqual(await panel.startFollowUp('And the tests'), { ok: true });
  assert.equal(h.posts.at(-1).body.trustedHost, true);

  key = 'core/b';
  await open();
  assert.deepEqual([h.$('f-trusted').checked, h.$('f-trust-kept').hidden], [false, true], 'another chat asks for itself');
  // a chat made for the run (+ New chat) is new: it asks, and the chat the server made keeps the answer
  h.$('run-dialog').close();
  const sent = [];
  panel.openRun({ target: { title: 'New chat in Core', workspace: 'C:\\work\\core', project: 'core', start: async (body) => { sent.push(body); return { ok: true, status: 202, data: { pid: 3 }, chat: { project: 'core', chat: 'n1' } }; } } });
  await h.tick();
  assert.equal(h.$('f-trusted').checked, false);
  h.$('f-request').value = 'Another';
  h.$('f-trusted').checked = true;
  await h.$('run-form').fire('submit');
  await h.tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(h.storage.map.get(TRUST_KEY)), ['core/a', 'core/n1']);
});

// ------------------------------------------------------------ findings 9 to 12
test('controls: 28px with a pointer, 40px where the screen is touched, 16px check boxes', () => {
  const css = read('styles.css');
  assert.match(css, /\.fold-toggle \{ flex: none; display: inline-grid; place-items: center; width: 1\.75rem; height: 1\.75rem;/);
  assert.match(css, /\.seg \{[^}]*height: 1\.75rem;/);
  assert.match(css, /\.nav-add, \.nav-more \{ width: 1\.75rem; height: 1\.75rem;/);
  assert.match(css, /\.check input \{ width: 1rem; height: 1rem;/);
  const touch = css.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/)[0];
  assert.match(touch, /\.fold-toggle, \.nav-add, \.nav-more, \.icon-btn \{ width: 2\.5rem; height: 2\.5rem; \}/);
  assert.match(touch, /\.seg, \.btn-small, \.tab, \.msg-more \{ min-height: 2\.5rem; \}/);
  assert.match(touch, /\.check input \{ width: 1\.25rem; height: 1\.25rem;/);
});

test('plan in Chat: the message names the milestones, the Plan panel holds the rest', async () => {
  const { installDom } = await import('./fixtures/fake-dom.js');
  installDom();
  const { renderPlanBrief } = await import('../../visualizer/public/js/plan-render.js');
  const text = (n) => (n.childNodes?.length ? n.childNodes.map(text).join('|') : n.textContent ?? '');
  const items = [{ id: 'm1', title: 'Site', description: 'A long description', criteria: ['a', 'b'] }, { id: 'm2', title: 'Tests', description: '', criteria: [] }];
  assert.equal(text(renderPlanBrief(items)), 'Plan · 2 milestones|m1|Site|m2|Tests', 'no description, no criteria');
  assert.match(text(renderPlanBrief(items.slice(0, 1), { unit: 'step' })), /^Plan · 1 step\|/);
  assert.match(read('js/main.js'), /plan: \{ brief: true, render: \(items\) => renderPlanBrief\(items\), open: \(\) => side\.set\('plan', \{ focus: true \}\) \},/);
});

test('run panel: a run that is over says how it ended first; a run that is going has no outcome', async () => {
  const { reduceAll } = await import('../../visualizer/public/js/state.js');
  const { teamRunView, pipelineOutcome } = await import('../../visualizer/public/js/activity-model.js');
  let seq = 0;
  const ev = (type, rest = {}) => ({ v: 1, seq: ++seq, ts: `2026-11-16T01:10:${String(seq).padStart(2, '0')}Z`, runId: 'r1', type, ...rest });
  const events = [
    ev('run_started', { request: 'Create a website.' }),
    ev('plan_ready', { milestones: [{ id: 'm1', title: 'Site' }, { id: 'm2', title: 'Tests' }] }),
    ev('milestone_started', { milestoneId: 'm1', title: 'Site', index: 0, total: 2 }),
    ev('milestone_finished', { milestoneId: 'm1', status: 'passed' }),
  ];
  assert.equal(teamRunView({ state: reduceAll(events) }).outcome, null);
  const over = teamRunView({ state: reduceAll([...events, ev('run_finished', { status: 'aborted', summary: 'Interrupted by stop request' })]) }).outcome;
  assert.deepEqual(over, { label: 'Aborted', tone: 'bad', unit: 'Milestones', done: '1/2', duration: '4s' });
  assert.deepEqual(teamRunView({ state: reduceAll([...events, ev('run_finished', { status: 'success' })]) }).outcome.label, 'Succeeded');
  assert.deepEqual(pipelineOutcome({ status: { status: 'suspended' } }, { total: 3, counts: { done: 1 } }), { label: 'Suspended', tone: 'warn', unit: 'Steps', done: '1/3', duration: '' });
  assert.equal(pipelineOutcome({ status: { status: 'running' } }, null), null);

  const html = read('index.html');
  const rail = html.slice(html.indexOf('<div class="rail-body" id="rail-body">'), html.indexOf('<aside class="side" id="side-panel"'));
  assert.deepEqual([...rail.matchAll(/<h3 id="rail-([a-z]+)-title">/g)].map((m) => m[1]), ['outcome', 'access', 'agents', 'usage', 'board']);
  assert.match(rail, /<section class="rail-sec rail-outcome" id="rail-outcome" aria-labelledby="rail-outcome-title" hidden>/);
  assert.match(rail, /<button type="button" class="msg-more" id="rail-usage-more" aria-controls="rail-usage" aria-expanded="true" hidden>Hide chart<\/button>/);
  const js = read('js/run-rail.js');
  assert.match(js, /const open = view\.live \|\| chart\.open;/, 'the diagram of a run that is going is never folded');
  assert.match(js, /if \(chart\.run !== view\.runId\) chart = \{ run: view\.runId, open: false \};/, 'another run starts folded again');
  assert.match(read('styles.css'), /#rail-usage\[data-chart="closed"\] \.usage > :not\(\.usage-figs\) \{ display: none; \}/, 'the totals stay');
});

test('dates: a time stamp of another day carries its date in the event log, the inboxes and the messages', () => {
  for (const file of ['js/log.js', 'js/dashboard.js', 'js/chat-panel.js', 'js/pipeline-view.js']) {
    const js = read(file);
    assert.match(js, /formatWhen\(/, file);
    assert.doesNotMatch(js, /formatClock/, file);
  }
  assert.match(read('styles.css'), /\.log\[data-dated="true"\] \{ --c-time: calc\(16ch \+ 1\.5rem\); \}/, 'the time column makes room for the date');
});
