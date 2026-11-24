// The first run in the dashboard as a newcomer meets it (usability audit, lane UI): what a run cannot do without is
// on screen without opening anything, the agents' protocol words arrive in the run panel's words, and the end of a
// run says what it produced and where.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, CONTROL } from './fixtures/run-drawer.js';
import { installDom } from './fixtures/fake-dom.js';
import { installTree } from './fixtures/tree-dom.js';
import { fakeStorage } from './fixtures/run-drawer.js';
import { parsePlanText } from '../../visualizer/public/js/plan.js';
import { keywordWords } from '../../visualizer/public/js/chat-entries.js';
import { teamChatAdapter } from '../../visualizer/public/js/chat-adapter-team.js';
import { createChatView } from '../../visualizer/public/js/chat-view.js';
import { renderPlanBrief } from '../../visualizer/public/js/plan-render.js';
import { createRunRail } from '../../visualizer/public/js/run-rail.js';
import { teamRunView } from '../../visualizer/public/js/activity-model.js';
import { reduceAll, reduce } from '../../visualizer/public/js/state.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createScope } from '../../visualizer/public/js/scope.js';
import { accountsMissing } from '../../visualizer/public/js/accounts.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const fence = '`'.repeat(3);
const PLAN = { milestones: [{ id: 'm1', title: 'Todo storage module', acceptanceCriteria: ['add works'] }, { id: 'm2', title: 'Command line interface', dependsOn: ['m1'] }] };
// what the planner says, as the fake pi and real models write it: a line, the fenced plan, the keyword
const PLANNER = `Here is the plan: two small milestones.\n\n${fence}json\n${JSON.stringify(PLAN, null, 2)}\n${fence}\n\n[PLAN_READY]`;

test('no account and no key: the note sits beside Start, outside Options, and the run can still start', async (t) => {
  const html = read('index.html');
  const form = html.slice(html.indexOf('<form id="run-form"'), html.indexOf('<div class="pf" id="pipeline-fields"'));
  const foldEnd = form.lastIndexOf('</details>');
  const at = form.indexOf('id="models-signin"');
  assert.ok(at > foldEnd && at < form.indexOf('id="f-trust-row"'), 'after the Options fold, before the acknowledgement');
  assert.match(form, /<p class="models-signin team-only" id="models-signin" hidden><span>No account is signed in and no API key was found, so the agents have no model to use unless an API key is set in the environment\.<\/span> <button type="button" class="link-btn" id="models-accounts">Open Accounts<\/button><\/p>/);

  const h = harness({ catalog: { providers: [{ id: 'openai', label: 'ChatGPT', signedIn: false, models: [] }] } });
  t.after(() => h.panel.setMode('demo'));
  h.models.setAccounts([]);
  await h.open();
  await h.tick();
  assert.equal(h.$('models-signin').hidden, false);
  assert.equal(h.$('run-options').open, false, 'seen without opening anything');
  // a warning, not a refusal: pi may have a key the page cannot see
  h.$('f-trusted').checked = true;
  await h.$('run-form').fire('submit');
  await h.tick();
  assert.equal(h.posts.length, 1);
});

test('the sign-in note follows the model list: hidden with a signed-in account and when the server has no list', async (t) => {
  const signed = harness();
  t.after(() => signed.panel.setMode('demo'));
  await signed.open();
  await signed.tick();
  assert.equal(signed.$('models-signin').hidden, true);
  signed.panel.setMode('demo');
  const none = harness();
  t.after(() => none.panel.setMode('demo'));
  // a server without the route (404): no model fields at all
  const served = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (url === '/api/models' ? { ok: false, status: 404, json: async () => null } : served(url, opts));
  await none.open();
  await none.tick();
  assert.equal(none.$('model-fields').hidden, true);
  assert.equal(none.$('models-signin').hidden, true, 'outside the model fields it is hidden with them');
});

test('a missing acknowledgement opens Options, where the sandboxes it names are, and the box gets the focus', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  await h.sandbox('host');
  h.$('f-trusted').checked = false;
  document.activeElement = h.$('run-submit');
  await h.$('run-form').fire('submit');
  assert.equal(h.posts.length, 0);
  assert.match(h.$('run-error').textContent, /or pick a sandbox\.$/);
  assert.equal(h.$('f-trusted').getAttribute('aria-invalid'), 'true');
  assert.equal(document.activeElement, h.$('f-trusted'));
  assert.equal(h.$('run-options').open, true);
});

test('stop says nothing is undone; New run during a run says why it does nothing', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.server.control = { ...CONTROL, run: { runId: 'r1', pid: 4, startedAt: '2026-11-16T10:00:00Z' } };
  h.panel.setMode('live');
  await h.tick();
  await h.panel.refresh();
  await h.$('stop-run').fire('click');
  assert.equal(h.$('confirm-dialog').open, true);
  assert.equal(h.$('confirm-detail').textContent, 'The orchestrator ends the active agent and finishes the run as aborted. Nothing is undone: what already reached the project folder stays there. If the process has not exited 15 s later, the server kills it.');
  h.$('confirm-dialog').close();
  assert.equal(h.$('new-run').getAttribute('aria-disabled'), 'true');
  assert.equal(h.$('new-run').title, 'A run is in progress in this chat');
  await h.$('new-run').fire('click');
  assert.equal(h.$('control-announcer').textContent, 'A run is in progress in this chat');
  assert.equal(h.$('run-dialog').open, false);
});

test('the planner\'s fenced plan after a line of prose is a plan; the same text without its keyword is not', () => {
  assert.deepEqual(parsePlanText(PLANNER).map((m) => [m.id, m.title, m.dependsOn]), [['m1', 'Todo storage module', []], ['m2', 'Command line interface', ['m1']]]);
  assert.equal(parsePlanText(PLANNER.replace('[PLAN_READY]', '[TASK_COMPLETE]')), null, 'a developer showing JSON is not a plan');
  assert.equal(parsePlanText('Here is the plan.\n\n[PLAN_READY]'), null);
});

test('the planner\'s plan with a fence inside one of its strings is still a plan', () => {
  const plan = { milestones: [{ id: 'm1', title: 'Docs', description: `Show usage in a ${fence}sh block${fence} in the README` }, { id: 'm2', title: 'CLI' }] };
  const said = `Here is the plan.\n\n${fence}json\n${JSON.stringify(plan, null, 2)}\n${fence}\n\n[PLAN_READY]`;
  assert.deepEqual(parsePlanText(said)?.map((m) => [m.id, m.description]), [['m1', plan.milestones[0].description], ['m2', '']]);
  // the plan alone in its fenced block, as before
  const bare = `${fence}json\n${JSON.stringify(plan)}\n${fence}\n[PLAN_READY]`;
  assert.deepEqual(parsePlanText(bare)?.map((m) => m.id), ['m1', 'm2']);
});

// the orchestrator's keywords (src/core/keywords.js and the conversation-mode planner's in orchestrator.js)
test('keywords read as the run panel words them; a custom keyword stays as it is', () => {
  const words = ['PLAN_READY', 'ANSWER_READY', 'REPORT_READY', 'TASK_COMPLETE', 'REVIEW_APPROVED', 'CHANGES_REQUESTED', 'SECURITY_PASSED', 'SECURITY_ISSUES', 'TEST_PASSED', 'TEST_FAILED', 'BLOCKED', 'LINT_CLEAN'].map(keywordWords);
  assert.deepEqual(words, ['Plan ready', 'Answer ready', 'Report ready', 'Work done', 'Approved', 'Changes requested', 'No security issues', 'Security issues', 'Tests passed', 'Tests failed', 'Blocked', 'LINT_CLEAN']);
  for (const odd of ['constructor', 'toString', '__proto__']) assert.equal(keywordWords(odd), odd, 'nothing from the prototype');
});

test('Chat: the planner\'s answer and report keywords as words, an unknown keyword as it is with its brackets in the title', () => {
  installTree();
  let entries = [];
  const view = createChatView({ getEntries: () => entries, currentRunId: () => 'r1' });
  let seq = 0;
  const ev = (type, fields) => ({ v: 1, seq: ++seq, ts: `2026-11-21T10:00:0${seq}Z`, runId: 'r1', type, ...fields });
  const say = (agent, text) => ev('agent_message', { agent, instanceId: agent, milestoneId: null, cycle: null, text, final: true });
  const events = [
    ev('run_started', { request: 'What does it do?' }),
    say('michael', 'It stores todos.\n\n[ANSWER_READY]'),
    say('michael', 'All done.\n\n[REPORT_READY]'),
    say('linter', 'Clean.\n\n[LINT_CLEAN]'),
  ];
  entries = teamChatAdapter({ events, state: reduceAll(events) });
  view.render();
  const chips = document.getElementById('chat-view-list').querySelectorAll('.chat-keyword');
  assert.deepEqual(chips.map((c) => [c.textContent, c.title]), [['Answer ready', '[ANSWER_READY]'], ['Report ready', '[REPORT_READY]'], ['LINT_CLEAN', '[LINT_CLEAN]']]);
});

test('Chat: the plan as its milestones with the raw message one click away, the keyword as words, a gate verdict as words', async () => {
  installTree();
  let opened = 0;
  let entries = [];
  const view = createChatView({ getEntries: () => entries, currentRunId: () => 'r1', plan: { brief: true, render: (items) => renderPlanBrief(items), open: () => { opened += 1; } } });
  let seq = 0;
  const ev = (type, fields) => ({ v: 1, seq: ++seq, ts: `2026-11-21T10:00:0${seq}Z`, runId: 'r1', type, ...fields });
  const events = [
    ev('run_started', { request: 'Build a todo CLI' }),
    ev('agent_message', { agent: 'michael', instanceId: 'michael', milestoneId: null, cycle: null, text: PLANNER, final: true }),
    ev('gate_result', { agent: 'hank', milestoneId: 'm1', cycle: 1, result: 'passed', keyword: 'SECURITY_PASSED' }),
  ];
  entries = teamChatAdapter({ events, state: reduceAll(events) });
  view.render();
  const list = document.getElementById('chat-view-list');
  const planner = list.querySelectorAll('.chat-entry').find((x) => x.dataset.kind === 'agent');
  assert.equal(planner.querySelector('.plan-brief-head').textContent, 'Plan · 2 milestones');
  assert.deepEqual(planner.querySelectorAll('.plan-brief-title').map((n) => n.textContent), ['Todo storage module', 'Command line interface']);
  const chip = planner.querySelector('.chat-keyword');
  assert.deepEqual([chip.textContent, chip.title], ['Plan ready', '[PLAN_READY]']);
  assert.equal(planner.querySelector('.chat-raw'), null, 'the JSON is not on screen at first');
  await planner.querySelector('button[data-plan]').click();
  assert.equal(opened, 1, 'Open the plan opens the Plan panel');
  let raw = planner.querySelector('button[data-toggle]');
  assert.deepEqual([raw.textContent, raw.getAttribute('aria-expanded')], ['Show the raw message', 'false']);
  await raw.click();
  raw = planner.querySelector('button[data-toggle]');
  assert.deepEqual([raw.textContent, raw.getAttribute('aria-expanded')], ['Hide the raw message', 'true']);
  assert.match(planner.querySelector('.chat-raw').textContent, /"milestones"/);
  assert.equal(entries.find((x) => x.kind === 'agent').text, PLANNER, 'the entry keeps the text verbatim');

  const gate = list.querySelectorAll('.chat-entry').find((x) => x.dataset.kind === 'activity');
  const line = gate.querySelector('.chat-act');
  assert.equal(line.textContent, 'Security Auditor · m1 · cycle 1 · No security issues');
  assert.equal(line.title, 'Security Auditor · m1 · cycle 1 · No security issues [SECURITY_PASSED]');
});

// writes, then reads: the files the developer wrote, then the ones it only read
function railEvents({ writes = ['todo.js', 'README.md'], reads = ['package.json'] } = {}) {
  let seq = 0;
  const ev = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 21, 10, 0, seq)).toISOString(), runId: 'r1', type, ...fields });
  const tool = (name, file) => ev('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: name, detail: file, targetFile: file });
  return [
    ev('run_started', { request: 'Build it', workspace: 'C:\\ws\\todo' }),
    ev('plan_ready', { milestones: [{ id: 'm1', title: 'Storage' }] }),
    ev('milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 1 }),
    ev('instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    ev('agent_usage', { agent: 'dwight', instanceId: 'dwight-m1', usage: { input: 900, output: 100, cost: 0.01 } }),
    ...writes.map((f, i) => tool(i % 2 ? 'edit' : 'write', f)),
    ...reads.map((f) => tool('read', f)),
    ev('milestone_finished', { milestoneId: 'm1', status: 'passed' }),
    ev('run_finished', { status: 'success', summary: 'All 1 milestones passed' }),
  ];
}

function railRun(runs = [], files = {}) {
  return teamRunView({ state: reduceAll(railEvents(files)), runs });
}

test('the outcome says how many files changed, in which folder, with one control to the Changes panel', async () => {
  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  let changes = 0;
  const rail = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} }, folder: () => 'C:\\ws\\todo', openChanges: () => { changes += 1; } });
  rail.render(railRun());
  assert.equal($('rail-outcome').hidden, false);
  assert.equal($('rail-outcome-files').hidden, false);
  // without a restore point the events say what the agents wrote, not what reached the folder
  assert.equal($('rail-outcome-files-text').textContent, '2 files written by the agents for C:\\ws\\todo', 'what was read is not a change');
  assert.equal($('rail-outcome-changes').hidden, false);
  await $('rail-outcome-changes').click();
  assert.equal(changes, 1);
  const html = read('index.html');
  assert.match(html, /<p class="outcome-files" id="rail-outcome-files" hidden><span id="rail-outcome-files-text"><\/span> <button type="button" class="link-btn" id="rail-outcome-changes" aria-controls="side-panel">Open changes<\/button><\/p>/);
  // the reply in the conversation says the same number in the same words
  const reply = teamChatAdapter({ events: railEvents(), state: reduceAll(railEvents()) }).find((x) => x.kind === 'reply');
  assert.match(reply.context, /^Success · 1\/1 milestones · 2 files written · /);

  // a pipeline run keeps its changes elsewhere until they are approved: no folder, no line
  const pipe = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} }, folder: () => null, openChanges() {} });
  pipe.render(railRun());
  assert.equal($('rail-outcome-files').hidden, true);
});

test('ten files written, then eight read: the rail and the reply both count ten, and a restore point\'s count wins in the rail', () => {
  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  const files = { writes: Array.from({ length: 10 }, (_, i) => `src/f${i}.js`), reads: Array.from({ length: 8 }, (_, i) => `lib/r${i}.js`) };
  let point = null;
  const undo = { render() {}, point: (runId) => (point?.runId === runId ? point : null) };
  const rail = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} }, folder: () => 'C:\\ws\\todo', openChanges() {}, undo });
  rail.render(railRun([], files));
  assert.equal($('rail-outcome-files').hidden, false);
  assert.equal($('rail-outcome-files-text').textContent, '10 files written by the agents for C:\\ws\\todo');
  const events = railEvents(files);
  const reply = teamChatAdapter({ events, state: reduceAll(events) }).find((x) => x.kind === 'reply');
  assert.match(reply.context, / · 10 files written · /);
  // an earlier run whose state is not the reducer's: counted from its events alike
  const replay = teamChatAdapter({ events }).find((x) => x.kind === 'reply');
  assert.match(replay.context, / · 10 files written · /);
  // what reached the folder, as the restore point recorded it
  point = { runId: 'r1', files: 9, undoneAt: null, remaining: 9, unreadable: false };
  rail.render(railRun([], files));
  assert.equal($('rail-outcome-files-text').textContent, '9 files changed in C:\\ws\\todo');
});

test('the chat header names the cost it shows: the last run, and the chat\'s total beside it', () => {
  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  let earlier = false;
  const rail = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} }, earlier: () => earlier });
  rail.render(railRun());
  assert.deepEqual([$('rail-toggle-label').textContent, $('rail-toggle-fig').textContent], ['Last run', '$0.010']);
  const runs = [{ runId: 'r0', usage: { tokens: 400, cost: 0.5 } }, { runId: 'r1', usage: null }];
  rail.render(railRun(runs));
  assert.deepEqual([$('rail-toggle-label').textContent, $('rail-toggle-fig').textContent], ['Last run', '$0.010 · chat $0.510']);
  earlier = true;
  rail.render(railRun(runs));
  assert.deepEqual([$('rail-toggle-label').textContent, $('rail-toggle-fig').textContent], ['Run', '$0.010'], 'an earlier run on screen is not the last one');
  assert.match(read('index.html'), /<span id="rail-toggle-label">Run<\/span> <span class="mono rail-toggle-fig" id="rail-toggle-fig"><\/span>/);
});

test('the empty states of a fresh installation lead to Accounts while nobody is signed in', async () => {
  const $ = installDom();
  globalThis.fetch = async () => { throw new Error('network'); };
  const state = { missing: true, opened: 0, projects: [] };
  const thread = createThread({
    scope: createScope({ project: null, chat: null }),
    nav: { doc: () => ({ mode: 'registry', maxConcurrentRuns: 4, running: 0, projects: state.projects }), refresh() {}, newChat() {}, newProject() {}, rename() {} },
    control: { snapshot: () => ({ control: { enabled: true }, mode: 'live', gates: { alive: false, recovery: false } }), openRun() {}, startFollowUp: async () => ({ ok: true }) },
    onReplay() {},
    accounts: { missing: () => state.missing, open: () => { state.opened += 1; } },
  });
  thread.activate();
  assert.equal($('thread-empty-title').textContent, 'No project yet.');
  assert.equal($('thread-empty-accounts').hidden, false);
  await $('thread-empty-accounts-open').fire('click');
  assert.equal(state.opened, 1);
  state.missing = false;
  thread.render();
  assert.equal($('thread-empty-accounts').hidden, true, 'a signed-in installation is not told');
  assert.match(read('index.html'), /<span class="thread-empty-accounts" id="thread-empty-accounts" hidden>No account is signed in and no API key was found, so the agents have no model to use unless an API key is set in the environment\. <button type="button" class="link-btn" id="thread-empty-accounts-open">Open Accounts<\/button><\/span>/);
});

test('the empty states ask for an account only when the Accounts panel can open and its list is known to be empty', () => {
  const panel = (available, list) => ({ available: () => available, accounts: () => list });
  assert.equal(accountsMissing(panel(true, [])), true, 'nobody signed in');
  assert.equal(accountsMissing(panel(true, [{ id: 'openai', status: 'signed_out' }])), true);
  assert.equal(accountsMissing(panel(true, [{ id: 'openai', status: 'signed_in' }])), false, 'a signed-in account');
  assert.equal(accountsMissing(panel(true, null)), false, 'an unknown list claims nothing');
  assert.equal(accountsMissing(panel(false, [])), false, 'a panel that cannot open is not offered');
  assert.equal(accountsMissing(null), false, 'no panel (single mode, the panel not built yet)');
});

test('newcomer words: roles before names, where the default folder is, and the Options line in plain words', () => {
  const html = read('index.html');
  assert.ok(html.includes('<span>Team <span class="hint">the Planner splits the request into milestones, the Developer builds each one, and the Code Reviewer, the Security Auditor and the QA Tester check every turn</span></span>'));
  assert.ok(html.includes('fixed steps: a planner writes a plan you approve, implementers build it, the project checks and a reviewer verify it, and you approve the changes before they reach the folder'));
  assert.ok(html.includes('Leave it empty to create a new folder for the project under Documents/Scranton/projects in your user folder.'));
});

test('six thousand distinct writes: the count is exact, the paths kept are capped, and the reducer stays as fast', () => {
  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  const events = railEvents({ writes: [], reads: [] });
  const finish = events.splice(-2);
  let seq = events.at(-1).seq;
  const write = (file) => {
    const e = { v: 1, seq: ++seq, ts: '2026-11-21T10:30:00.000Z', runId: 'r1', type: 'agent_tool', agent: 'dwight', instanceId: 'dwight-m1', tool: 'write', detail: file, targetFile: file };
    events.push(e);
    return e;
  };
  let s = reduceAll(events);
  const times = [];
  for (let c = 0; c < 6; c += 1) {
    const t = performance.now();
    for (let i = 0; i < 1000; i += 1) s = reduce(s, write(`src/dir/f${c * 1000 + i}.js`));
    times.push(performance.now() - t);
  }
  // written again: still one file each
  s = reduce(s, write('src/dir/f5999.js'));
  s = reduce(s, write('src/dir/f5800.js'));
  // uncapped, every event clones and scans every path so far: the last thousand took 1.8 times the second
  assert.ok(times[5] < times[1] * 1.4, `the last thousand writes (${Math.round(times[5])} ms) as fast as the second (${Math.round(times[1])} ms)`);
  assert.ok(s.written.length <= 500, `at most the log's 500 paths kept, not ${s.written.length}`);
  for (const e of finish) {
    events.push({ ...e, seq: ++seq });
    s = reduce(s, events.at(-1));
  }
  const view = teamRunView({ state: s });
  assert.equal(view.written, 6000);
  let point = null;
  const rail = createRunRail({ viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} }, folder: () => 'C:\\ws\\todo', openChanges() {}, undo: { render() {}, point: () => point } });
  rail.render(view);
  assert.equal($('rail-outcome-files-text').textContent, '6000 files written by the agents for C:\\ws\\todo');
  const reply = teamChatAdapter({ events, state: s }).find((x) => x.kind === 'reply');
  assert.match(reply?.context ?? '', / · 6000 files written · /);
  point = { runId: 'r1', files: 7, undoneAt: null, remaining: 7, unreadable: false };
  rail.render(view);
  assert.equal($('rail-outcome-files-text').textContent, '7 files changed in C:\\ws\\todo', 'the restore point\'s count wins');
});

test('the New run note and the empty state share one condition, the model list included, and one hedge', async (t) => {
  const panel = (available, list) => ({ available: () => available, accounts: () => list });
  const keyed = { providers: [{ id: 'custom', label: 'Custom', signedIn: true, models: [] }] };
  assert.equal(accountsMissing(panel(true, []), keyed), false, 'a provider of the model list has a key');
  assert.equal(accountsMissing(panel(true, []), { providers: [{ ...keyed.providers[0], signedIn: false }] }), true);
  const h = harness({ catalog: keyed });
  t.after(() => h.panel.setMode('demo'));
  h.models.setAccounts([]);
  await h.open();
  await h.tick();
  assert.equal(h.$('models-signin').hidden, true);
  assert.equal(accountsMissing(panel(true, []), h.models.catalog()), false, 'the empty state reads the list the New run drawer has');
  const hedge = 'unless an API key is set in the environment.';
  const html = read('index.html');
  for (const id of ['thread-empty-accounts', 'models-signin']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(html.slice(at, html.indexOf('<button', at)).includes(hedge), `${id} says ${hedge}`);
  }
});
