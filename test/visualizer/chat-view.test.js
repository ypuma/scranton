// The Chat view (.enma/chat-view-contract.md sections 7 and 13.7): the transcript drawn from an adapter's entries,
// the Chat | Dashboard switch, earlier runs loaded on demand, the dock under the transcript and the one steering
// composer both views mount. Driven with fake DOMs: a tree where nodes move, the plain one where they do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDashboard } from '../../visualizer/public/js/dashboard.js';
import { createChatView } from '../../visualizer/public/js/chat-view.js';
import { teamChatAdapter } from '../../visualizer/public/js/chat-adapter-team.js';
import { createViewMode, createDock, parseViewMode, VIEW_KEY } from '../../visualizer/public/js/view-mode.js';
import { createThread } from '../../visualizer/public/js/thread.js';
import { createChatPanel } from '../../visualizer/public/js/chat-panel.js';
import { createScope, parseProjects, composerGate, detailError } from '../../visualizer/public/js/scope.js';
import { parseControl } from '../../visualizer/public/js/control.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';
import { installTree, TreeEl, all } from './fixtures/tree-dom.js';
import { Scroller, installObservers, VIEW_PX } from './fixtures/fake-scroll.js';
import { fakeStorage } from './fixtures/run-drawer.js';

const PUBLIC = new URL('../../visualizer/public/', import.meta.url);
const read = (file) => readFileSync(new URL(file, PUBLIC), 'utf8');
const RUN = 'run-b';
const START = ['run_started', { request: 'How does the CLI parse flags?', workspace: 'C:\\ws', maxFailedCycles: 3 }];
const msg = (agent, text, fields = {}) => ['agent_message', { agent, instanceId: agent, milestoneId: null, cycle: null, text, final: false, ...fields }];
const LONG = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of a long message.`).join('\n');
const tick = () => new Promise((r) => setTimeout(r, 5));

// The transcript of one chat. add([type, fields], ...) appends events to the run on screen and renders.
function viewHarness({ loadRun, runs = [] } = {}) {
  const $ = installTree();
  const { show, resize } = installObservers();
  const list = $('chat-view-list');
  const scroller = new Scroller(() => list.querySelectorAll('.chat-entry').length);
  const byId = document.getElementById;
  document.getElementById = (id) => (id === 'chat-view-scroll' ? scroller : byId(id));
  const h = { $, list, scroller, said: [], current: RUN, events: [], detail: [], runs, entries: [] };
  h.view = createChatView({ getEntries: () => h.entries, currentRunId: () => h.current, loadRun, announce: (text, kind) => h.said.push([kind, text]) });
  h.draw = (opts) => {
    h.entries = teamChatAdapter({ events: [...h.detail, ...h.events], state: reduceAll(h.events.filter((e) => e.runId === h.current)), runs: h.runs });
    h.view.render(opts);
  };
  h.add = (...list2) => {
    for (const [type, fields] of list2) {
      const seq = h.events.length + 1;
      h.events.push({ v: 1, seq, ts: new Date(Date.UTC(2026, 10, 11, 9, 0, seq)).toISOString(), runId: h.current, type, ...fields });
    }
    h.draw(h.opts);
  };
  h.items = () => list.querySelectorAll('.chat-entry');
  h.item = (kind, n = 0) => h.items().filter((x) => x.dataset.kind === kind)[n];
  h.show = (on) => show(scroller, on);
  h.resize = (px, notify) => resize(scroller, px, notify);
  h.readBack = (top) => {
    scroller.scrollTop = top;
    scroller.fire('scroll');
  };
  return h;
}

// ------------------------------------------------------------ the transcript

test('each entry is drawn as its kind: a labelled article, one quiet line for activity, the reply with its outcome', (t) => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 12, 12));
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  const h = viewHarness();
  h.add(
    START,
    msg('michael', 'Looking at **bin** first.\n\n```js\nparseArgs()\n```', { final: true }),
    ['agent_tool', { agent: 'michael', instanceId: 'michael', tool: 'read', detail: 'bin/scranton.js' }],
    ['hitl_request', { milestoneId: 'm2', reason: 'Stuck on m2.', options: ['retry'] }],
    ['chat_message', { id: 'c1', from: 'human', to: 'michael', text: 'Check **src/core/cli.js**', delivery: 'delivered' }],
    ['run_reply', { from: 'michael', kind: 'answer', text: 'It uses `parseArgs`.' }],
    ['run_finished', { status: 'success', summary: 'Answered by Michael' }],
  );
  const runs = h.list.children;
  assert.deepEqual(runs.map((r) => [r.tagName, r.className, r.dataset.runId]), [['SECTION', 'chat-run', RUN]]);
  assert.deepEqual(h.items().map((x) => [x.tagName, x.dataset.kind]), [
    ['ARTICLE', 'request'], ['ARTICLE', 'agent'], ['P', 'activity'], ['ARTICLE', 'question'], ['ARTICLE', 'human'], ['ARTICLE', 'reply'],
  ]);
  for (const x of h.items().filter((n) => n.tagName === 'ARTICLE')) assert.ok(x.getAttribute('aria-label'), `${x.dataset.kind} has a label`);
  // The fixture is yesterday in this fixed clock and timezone.
  assert.equal(h.item('agent').getAttribute('aria-label'), 'Michael, Orchestrator, 2026-11-11 09:00');
  assert.equal(h.item('activity').getAttribute('aria-label'), null, 'an activity line is read as the text it is');
  assert.equal(h.item('activity').querySelector('.chat-act').textContent, 'Michael · read bin/scranton.js');

  // what a model wrote goes through the Markdown subset, what a person typed is shown as typed
  const agent = h.item('agent');
  assert.deepEqual(agent.querySelector('.chat-body').children.map((n) => n.tagName), ['P', 'PRE']);
  assert.equal(agent.querySelector('strong').textContent, 'bin');
  assert.equal(agent.querySelector('pre').textContent, 'parseArgs()');
  assert.equal(h.item('human').querySelector('.chat-body').children.length, 0);
  assert.equal(h.item('human').querySelector('.chat-body').textContent, 'Check **src/core/cli.js**');
  assert.equal(h.item('human').querySelector('.chat-context').textContent, 'to michael');

  const reply = h.item('reply');
  assert.deepEqual(reply.querySelector('.chat-head').children.map((n) => [n.className, n.textContent]).slice(0, 2), [['chat-kind', 'Answer'], ['chat-who', 'Michael']]);
  assert.equal(reply.querySelector('.chat-body').querySelector('code').textContent, 'parseArgs');
  assert.match(reply.querySelector('.chat-outcome').textContent, /^Success · \d+s$/);
  assert.equal(reply.dataset.tone, 'ok');
  assert.equal(reply.querySelector('.chat-context'), null, 'the outcome is said once, under the text');
  assert.equal(h.items().at(-1), reply, 'the reply is the last thing in the conversation');
  // the question was closed by the end of the run, so nothing is waiting
  assert.equal(h.item('question').querySelector('.badge'), null);
});

test('hostile text only ever becomes text nodes', () => {
  const h = viewHarness();
  const evil = '<img src=x onerror=alert(1)> [x](javascript:alert(2)) <script>alert(3)</script>\n\n| a | b |\n|---|---|';
  h.add(['run_started', { request: evil }], msg('dwight', evil, { final: true }), ['hitl_request', { milestoneId: null, reason: evil, options: ['retry'] }],
    ['run_reply', { from: 'michael', kind: 'answer', text: evil }]);
  const tags = new Set(all(h.list).map((n) => n.tagName));
  for (const tag of ['IMG', 'A', 'SCRIPT', 'TABLE', 'IFRAME']) assert.equal(tags.has(tag), false, tag);
  for (const kind of ['request', 'agent', 'question', 'reply']) assert.ok(h.item(kind).textContent.includes('<img src=x onerror=alert(1)>'), `${kind} shows it as text`);
  const src = read('js/chat-view.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|srcdoc|DOMParser/);
});

test('an agent message: the keyword as a quiet chip, an intermediate one lighter, a truncated one says so', () => {
  const h = viewHarness();
  h.add(START,
    msg('dwight', 'Checking the workspace.', { instanceId: 'dwight-m2', milestoneId: 'm2', cycle: 1 }),
    msg('dwight', 'Implemented m2.\n\n[TASK_COMPLETE]', { instanceId: 'dwight-m2', milestoneId: 'm2', cycle: 1, final: true, truncated: true }));
  const [note, final] = [h.item('agent', 0), h.item('agent', 1)];
  assert.equal(note.dataset.final, 'false');
  assert.equal(final.dataset.final, 'true');
  assert.equal(note.querySelector('.badge'), null);
  assert.deepEqual([final.querySelector('.chat-keyword').textContent, final.querySelector('.chat-keyword').dataset.tone], ['TASK_COMPLETE', 'quiet']);
  assert.equal(final.querySelector('.chat-body').textContent, 'Implemented m2.', 'the keyword line is not shown twice');
  assert.deepEqual(final.querySelector('.chat-head').children.map((n) => n.textContent).slice(0, 3), ['Dwight', 'Developer', 'm2 · cycle 1']);
  assert.equal(final.querySelector('.chat-note').textContent, 'This text was shortened.');
  assert.equal(note.querySelector('.chat-note'), null);
});

test('a long message is collapsed behind Show more, and the button keeps the focus when it is used', async () => {
  const h = viewHarness();
  h.add(START, msg('dwight', 'Short.'), msg('dwight', LONG, { final: true }));
  const [short, long] = [h.item('agent', 0), h.item('agent', 1)];
  assert.equal(short.dataset.long, 'false');
  assert.equal(short.querySelector('button'), null);
  assert.equal(long.dataset.long, 'true');
  assert.equal(long.getAttribute('data-open'), null, 'closed');
  let more = long.querySelector('button[data-toggle]');
  assert.deepEqual([more.tagName, more.type, more.textContent, more.getAttribute('aria-expanded')], ['BUTTON', 'button', 'Show more', 'false']);
  assert.ok(long.querySelector('.chat-body').textContent.includes('Line 20'), 'the whole text is in the page; CSS clips it');

  await more.click();
  more = long.querySelector('button[data-toggle]');
  assert.equal(long.getAttribute('data-open'), '');
  assert.deepEqual([more.textContent, more.getAttribute('aria-expanded')], ['Show less', 'true']);
  assert.equal(document.activeElement, more, 'the focus is on the button that replaced the one pressed');
  assert.equal(h.item('agent', 0), short, 'the other entries are not redrawn');

  await more.click();
  assert.equal(long.getAttribute('data-open'), null);
  assert.equal(long.querySelector('button[data-toggle]').textContent, 'Show more');
  const css = read('styles.css');
  assert.match(css, /\.chat-entry\[data-long="true"\]:not\(\[data-open\]\) \.chat-body \{\s*max-height: 18em;\s*overflow: hidden;/);
});

// ------------------------------------------------------------ earlier runs

const RUNS = [
  { runId: 'run-a', goal: 'What does the CLI do?', status: 'success', startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:01:00.000Z', current: false, summary: 'Answered by Michael', reply: { kind: 'answer', text: 'It runs agents.' } },
  { runId: RUN, goal: 'How does the CLI parse flags?', status: 'running', startedAt: '2026-11-11T09:00:00.000Z', endedAt: null, current: true, summary: '', reply: null },
];
const EARLIER = [
  ['run_started', { request: 'What does the CLI do?' }],
  msg('michael', 'Reading bin/scranton.js.'),
  ['agent_tool', { agent: 'michael', instanceId: 'michael', tool: 'read', detail: 'bin/scranton.js' }],
  ['run_reply', { from: 'michael', kind: 'answer', text: 'It runs agents, in full.' }],
  ['run_finished', { status: 'success', summary: 'Answered by Michael' }],
].map(([type, fields], i) => ({ v: 1, seq: i + 1, ts: new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString(), runId: 'run-a', type, ...fields }));

function earlierHarness(answer) {
  const calls = [];
  let settle;
  const h = viewHarness({
    runs: RUNS,
    loadRun: (runId) => {
      calls.push(runId);
      return new Promise((resolve, reject) => { settle = { resolve, reject }; });
    },
  });
  h.calls = calls;
  // what the page does when the events arrive: they are part of the next getEntries()
  h.answer = async (result) => {
    if (result?.ok) {
      h.detail = EARLIER;
      h.entries = teamChatAdapter({ events: [...h.detail, ...h.events], state: reduceAll(h.events), runs: h.runs });
    }
    if (result instanceof Error) settle.reject(result);
    else settle.resolve(result);
    await tick();
  };
  h.add(START, msg('michael', 'Looking.'));
  h.toggle = () => h.list.children[0].querySelector('.chat-run-expand');
  h.note = () => h.list.children[0].querySelector('.chat-run-note');
  h.kinds = (i) => h.list.children[i].children.map((n) => (n.className === 'chat-run-tools' ? 'tools' : n.dataset.kind));
  return h;
}

test('an earlier run shows its request and reply; Show agent messages loads the rest on demand, once', async () => {
  const h = earlierHarness();
  assert.deepEqual(h.list.children.map((s) => s.dataset.runId), ['run-a', RUN], 'the earlier run above the current one');
  assert.deepEqual(h.kinds(0), ['request', 'tools', 'reply'], 'request and reply without a click');
  assert.deepEqual(h.kinds(1), ['request', 'agent'], 'the current run has no such control');
  assert.equal(h.list.children[0].querySelector('.chat-body').textContent, 'What does the CLI do?');
  assert.equal(h.list.children[0].children[2].querySelector('.chat-body').textContent, 'It runs agents.');
  const toggle = h.toggle();
  assert.deepEqual([toggle.tagName, toggle.type, toggle.dataset.runId, toggle.textContent, toggle.getAttribute('aria-expanded')], ['BUTTON', 'button', 'run-a', 'Show agent messages', 'false']);
  assert.deepEqual(h.calls, [], 'nothing is fetched before it is asked for');

  toggle.click();
  assert.deepEqual(h.calls, ['run-a']);
  assert.deepEqual([toggle.textContent, toggle.getAttribute('aria-busy')], ['Loading agent messages...', 'true']);
  toggle.click();
  assert.deepEqual(h.calls, ['run-a'], 'a second press while it loads asks nothing');

  await h.answer({ ok: true });
  assert.deepEqual(h.kinds(0), ['request', 'tools', 'agent', 'activity', 'reply']);
  assert.equal(h.toggle(), toggle, 'the control is the same node, where it was');
  assert.deepEqual([toggle.textContent, toggle.getAttribute('aria-expanded'), toggle.getAttribute('aria-busy')], ['Hide agent messages', 'true', 'false']);
  assert.equal(document.activeElement, toggle, 'and still has the focus');
  assert.equal(h.list.children[0].children.at(-1).querySelector('.chat-body').textContent, 'It runs agents, in full.', 'the reply is now the full one, in the same entry');
  assert.deepEqual(h.said, [], 'nothing of an earlier run is announced');

  await toggle.click();
  assert.deepEqual(h.kinds(0), ['request', 'tools', 'reply']);
  assert.equal(toggle.textContent, 'Show agent messages');
  assert.equal(document.activeElement, toggle);
});

test('an earlier run that is too large, or cannot be loaded, says why beside the control and stays closed', async () => {
  const big = earlierHarness();
  big.toggle().click();
  await big.answer({ error: detailError(413) });
  assert.deepEqual(big.kinds(0), ['request', 'tools', 'reply']);
  assert.equal(big.note().textContent, 'The event log of this run is larger than 20 MiB, so its agent messages cannot be shown here.');
  assert.equal(big.note().getAttribute('role'), 'status');
  assert.deepEqual([big.toggle().textContent, big.toggle().getAttribute('aria-expanded'), big.toggle().getAttribute('aria-busy')], ['Show agent messages', 'false', 'false']);
  assert.equal(document.activeElement, big.toggle(), 'the focus stays on the control');
  // asking again clears the note and tries again
  big.toggle().click();
  assert.equal(big.note().textContent, '');
  assert.deepEqual(big.calls, ['run-a', 'run-a']);
  await big.answer({ ok: true });
  assert.equal(big.toggle().textContent, 'Hide agent messages');

  const gone = earlierHarness();
  gone.toggle().click();
  await gone.answer({ error: detailError(0) });
  assert.equal(gone.note().textContent, 'The server did not answer. Is it still running?');

  const thrown = earlierHarness();
  thrown.toggle().click();
  await thrown.answer(new Error('boom'));
  assert.equal(thrown.note().textContent, 'The agent messages of this run could not be loaded.');
  assert.deepEqual(thrown.kinds(0), ['request', 'tools', 'reply']);

  // an answer for a chat that is not on screen any more changes nothing
  const left = earlierHarness();
  left.toggle().click();
  left.view.reset();
  left.entries = [];
  await left.answer({ ok: true });
  assert.deepEqual(left.list.children, []);
});

// ------------------------------------------------------------ tail-follow

const lines = (n, from = 0) => Array.from({ length: n }, (_, i) => msg('dwight', `Note ${from + i}`));

test('a follower stays on the newest entry; a reader keeps the place and is offered Jump to latest', () => {
  const h = viewHarness();
  h.add(START, ...lines(30));
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'on the newest entry');
  assert.equal(h.$('chat-view-jump').hidden, true);

  h.readBack(120);
  assert.equal(h.$('chat-view-jump').hidden, false, 'scrolling up offers the way back');
  assert.equal(h.$('chat-view-jump').textContent, 'Jump to latest');
  h.add(...lines(2, 30));
  assert.equal(h.scroller.scrollTop, 120, 'the reader is where they were');
  assert.equal(h.$('chat-view-jump').textContent, '2 new · Jump to latest');

  h.$('chat-view-jump').focus();
  h.$('chat-view-jump').fire('click');
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  assert.equal(h.$('chat-view-jump').hidden, true);
  assert.equal(document.activeElement, h.scroller, 'the focus goes to the transcript, not to the page, when the button leaves');
  h.add(...lines(1, 32));
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'following again');

  h.readBack(120);
  h.readBack(h.scroller.bottom());
  assert.equal(h.$('chat-view-jump').hidden, true, 'scrolling back down follows again');
  h.add(...lines(1, 33));
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
});

test('entries that arrive while the view is hidden or has no height do not drop a follower off the newest one', () => {
  const hidden = viewHarness();
  hidden.show(false);
  hidden.add(START, ...lines(30));
  assert.equal(hidden.scroller.scrollTop, 0, 'a hidden box cannot scroll');
  hidden.show(true);
  assert.equal(hidden.scroller.scrollTop, hidden.scroller.bottom(), 'on the newest entry once the view shows');

  // Dashboard and back: a follower gets the newest entry, a reader the place they left
  hidden.show(false);
  hidden.add(...lines(4, 30));
  hidden.show(true);
  assert.equal(hidden.scroller.scrollTop, hidden.scroller.bottom());
  hidden.readBack(120);
  hidden.show(false);
  hidden.add(...lines(4, 34));
  hidden.show(true);
  assert.equal(hidden.scroller.scrollTop, 120, 'back where the reader was');
  assert.equal(hidden.$('chat-view-jump').textContent, '4 new · Jump to latest');

  const flat = viewHarness();
  flat.add(START, ...lines(30));
  flat.resize(0);
  flat.add(...lines(5, 30));
  flat.resize(VIEW_PX);
  assert.equal(flat.scroller.scrollTop, flat.scroller.bottom(), 'a box without height reads as not laid out, never as at the bottom');
});

test('the dock growing under the transcript keeps a follower on the newest entry; a reader keeps the place', () => {
  const h = viewHarness();
  h.add(START, ...lines(30));
  h.resize(30);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'on the newest entry after the box shrank');
  h.add(...lines(1, 30));
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  h.resize(VIEW_PX);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  h.resize(30, false);
  h.add(...lines(1, 31));
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'an entry drawn before the observer runs is shown');
  h.resize(VIEW_PX);

  h.readBack(120);
  h.resize(30);
  h.add(...lines(2, 32));
  assert.equal(h.scroller.scrollTop, 120, 'the reader is where they were');
  h.resize(VIEW_PX);
  assert.equal(h.scroller.scrollTop, 120);
});

// ------------------------------------------------------------ focus and announcements

test('a render that changes nothing about an entry leaves its nodes alone, so the focus stays', () => {
  const h = viewHarness();
  h.add(START, msg('dwight', LONG, { final: true }));
  const entry = h.item('agent');
  const more = entry.querySelector('button[data-toggle]');
  more.focus();
  h.add(...lines(5), ['agent_tool', { agent: 'dwight', instanceId: 'dwight', tool: 'ls', detail: '.' }], ['agent_tool', { agent: 'dwight', instanceId: 'dwight', tool: 'read', detail: 'a.js' }]);
  assert.equal(h.item('agent'), entry, 'the same node');
  assert.equal(entry.querySelector('button[data-toggle]'), more, 'with the same button');
  assert.equal(document.activeElement, more);
  assert.equal(h.item('activity').querySelector('.chat-act').textContent, 'Dwight · 2 tools, last: read a.js', 'the tool line was updated in place');
  // nothing changed at all: not even a look at the nodes
  const before = h.items();
  h.view.render();
  h.draw();
  assert.deepEqual(h.items(), before);
  assert.equal(document.activeElement, more);
});

test('an entry that is redrawn hands the focus to its new button; one that goes hands it to the transcript', () => {
  const h = viewHarness();
  h.add(START, ['hitl_request', { milestoneId: 'm2', reason: LONG, options: ['retry'] }]);
  const question = h.item('question');
  assert.deepEqual([question.querySelector('.badge').textContent, question.querySelector('.badge').dataset.tone], ['waiting for an answer', 'loud']);
  const more = question.querySelector('button[data-toggle]');
  more.focus();
  h.add(['hitl_response', { milestoneId: 'm2', decision: 'retry' }]);
  assert.equal(h.item('question'), question, 'the entry is the same node');
  assert.equal(question.querySelector('.badge'), null, 'answered: nothing is waiting');
  const again = question.querySelector('button[data-toggle]');
  assert.notEqual(again, more, 'its content was drawn again');
  assert.equal(document.activeElement, again, 'and the focus is on the button that took the place of the old one');
  assert.equal(h.item('human').querySelector('.chat-body').textContent, 'You chose Retry');

  // the next run starts: this one becomes an earlier run, and its question leaves the page
  again.focus();
  h.runs = [{ runId: RUN, goal: 'How does the CLI parse flags?', status: 'aborted', current: false, summary: 'Stopped', reply: null }];
  h.current = 'run-c';
  h.events.push({ v: 1, seq: 1, ts: '2026-11-11T10:00:00.000Z', runId: 'run-c', type: 'run_started', request: 'Next' });
  h.draw();
  assert.deepEqual(h.list.children[0].querySelectorAll('.chat-entry').map((x) => x.dataset.kind), ['request'], 'the earlier run shows what was asked');
  assert.equal(document.activeElement, h.scroller, 'never the page');
  assert.notEqual(document.activeElement, document.body);
});

test('only a new reply and a question that waits are announced, once, and never while history loads', () => {
  const h = viewHarness();
  // the chat was just opened: its run replays, and none of it is news
  h.opts = { quiet: true };
  h.add(START, msg('dwight', 'Old note.'), ['hitl_request', { milestoneId: 'm1', reason: 'An old question.', options: ['retry'] }], ['hitl_response', { milestoneId: 'm1', decision: 'retry' }]);
  assert.deepEqual(h.said, []);
  h.opts = { quiet: false };
  h.add(msg('dwight', 'A live note.'), msg('dwight', 'A final one.\n\n[TASK_COMPLETE]', { final: true }),
    ['agent_tool', { agent: 'dwight', instanceId: 'dwight', tool: 'ls', detail: '.' }], ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'x' }],
    ['chat_message', { id: 'c1', from: 'human', to: 'dwight', text: 'Hi', delivery: 'delivered' }]);
  assert.deepEqual(h.said, [], 'messages, tools, verdicts and steering are not announced');

  h.add(['hitl_request', { milestoneId: 'm2', reason: 'Two failed cycles on m2.', options: ['retry'] }]);
  assert.deepEqual(h.said, [['question', 'Michael asks: Two failed cycles on m2.']]);
  h.add(msg('dwight', 'Still here.'));
  h.view.render();
  assert.equal(h.said.length, 1, 'not again on the next render');
  h.add(['hitl_response', { milestoneId: 'm2', decision: 'retry' }]);
  assert.equal(h.said.length, 1, 'the answer is the human\'s own');

  h.add(['run_reply', { from: 'michael', kind: 'report', text: 'All done.\n\nDetails follow.' }]);
  assert.deepEqual(h.said.at(-1), ['reply', 'Report from Michael: All done. Details follow.']);
  h.add(['run_finished', { status: 'success', summary: 'All 1 milestones passed' }]);
  assert.equal(h.said.length, 2, 'the outcome line under the reply is not a second announcement');

  // a reply that was already there when the page got the run is history
  const late = viewHarness();
  late.opts = { quiet: true };
  late.add(START, ['run_reply', { from: 'michael', kind: 'answer', text: 'Old answer.' }], ['run_finished', { status: 'success', summary: 's' }]);
  late.opts = { quiet: false };
  late.draw();
  late.view.render();
  assert.deepEqual(late.said, []);

  // the transcript itself is no live region
  const html = read('index.html');
  const section = html.match(/<section class="chatview" id="chat-view"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(section, 'the Chat view is found');
  assert.doesNotMatch(section, /aria-live|role="(log|status|alert|feed)"/);
  assert.match(section, /<div class="chatview-scroll" id="chat-view-scroll" tabindex="0" role="group" aria-label="Conversation, newest at the bottom">/);
  assert.match(section, /<button type="button" class="jump" id="chat-view-jump" hidden>/);
});

test('another chat on screen: nothing of the previous conversation is left', () => {
  const h = viewHarness();
  h.add(START, ...lines(30), ['run_reply', { from: 'michael', kind: 'answer', text: 'x' }]);
  h.readBack(120);
  h.view.reset();
  h.entries = [];
  h.view.render();
  assert.deepEqual(h.list.children, []);
  assert.equal(h.$('chat-view-jump').hidden, true);
  h.events = [];
  h.said.length = 0;
  h.add(START, ...lines(30), ['run_reply', { from: 'michael', kind: 'answer', text: 'x' }]);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'the new chat is followed from its newest entry');
  assert.equal(h.said.length, 1, 'and its reply is news again');
});

// ------------------------------------------------------------ the switch

function switchHarness(stored) {
  installDom();
  const page = globalThis.document;
  const $ = (id) => page.getElementById(id);
  const storage = fakeStorage(stored === undefined ? {} : { [VIEW_KEY]: stored });
  globalThis.localStorage = storage;
  const changes = [];
  const mode = createViewMode({ onChange: (m) => changes.push(m) });
  const shown = () => ({
    view: page.body.dataset.view, chatView: !$('chat-view').hidden, dash: !$('dash').hidden, toggle: !$('view-mode-toggle').hidden,
    pressed: [$('view-mode-chat').getAttribute('aria-pressed'), $('view-mode-dash').getAttribute('aria-pressed')],
  });
  return { $, storage, mode, changes, shown };
}

test('Chat is the default view; the choice is remembered under scranton.view_mode', () => {
  assert.equal(VIEW_KEY, 'scranton.view_mode');
  assert.deepEqual(['chat', 'dashboard', null, undefined, '', 'Dashboard', 'pipeline'].map(parseViewMode), ['chat', 'dashboard', 'chat', 'chat', 'chat', 'chat', 'chat']);

  const h = switchHarness();
  assert.equal(h.mode.get(), 'chat');
  assert.deepEqual(h.shown(), { view: 'chat', chatView: true, dash: false, toggle: true, pressed: ['true', 'false'] });
  assert.equal(h.storage.map.has(VIEW_KEY), false, 'the default is not written until the human picks');

  h.$('view-mode-dash').fire('click');
  assert.deepEqual(h.shown(), { view: 'dashboard', chatView: false, dash: true, toggle: true, pressed: ['false', 'true'] });
  assert.equal(h.storage.getItem(VIEW_KEY), 'dashboard');
  assert.deepEqual(h.changes, ['dashboard']);
  h.$('view-mode-dash').fire('click');
  assert.deepEqual(h.changes, ['dashboard'], 'pressing the view that is on changes nothing');
  h.$('view-mode-chat').fire('click');
  assert.equal(h.storage.getItem(VIEW_KEY), 'chat');
  assert.deepEqual(h.shown(), { view: 'chat', chatView: true, dash: false, toggle: true, pressed: ['true', 'false'] });

  assert.deepEqual(switchHarness('dashboard').shown(), { view: 'dashboard', chatView: false, dash: true, toggle: true, pressed: ['false', 'true'] }, 'a stored choice is where the page starts');
  assert.equal(switchHarness('nonsense').mode.get(), 'chat');

  // storage that throws: the choice lasts for this page
  const blocked = switchHarness();
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  blocked.$('view-mode-dash').fire('click');
  assert.equal(blocked.mode.get(), 'dashboard');
});

test('a chat without a Chat view (a pipeline chat) keeps its own layout: no switch, no transcript, the choice untouched', () => {
  const h = switchHarness();
  h.mode.offer(false);
  assert.equal(h.mode.get(), 'dashboard');
  assert.deepEqual(h.shown(), { view: 'dashboard', chatView: false, dash: true, toggle: false, pressed: ['true', 'false'] });
  assert.equal(h.storage.map.has(VIEW_KEY), false);
  h.mode.offer(true);
  assert.deepEqual(h.shown(), { view: 'chat', chatView: true, dash: false, toggle: true, pressed: ['true', 'false'] }, 'back on a team chat, the human\'s choice again');
  assert.deepEqual(h.changes, [], 'the engine changing is not the human choosing');
});

test('the switch is two real buttons in the chat header; the Chat view sits before the answer panel and the composers', () => {
  const html = read('index.html');
  const head = html.match(/<div class="thread-head">[\s\S]*?<p class="thread-empty"/)?.[0] ?? '';
  assert.match(head, /<div class="segmented view-mode" id="view-mode-toggle" role="group" aria-label="View">\s*<button type="button" class="seg" id="view-mode-chat" aria-pressed="true">Chat<\/button>\s*<button type="button" class="seg" id="view-mode-dash" aria-pressed="false">Dashboard<\/button>\s*<\/div>/);
  assert.ok(head.indexOf('id="view-mode-toggle"') < head.indexOf('id="run-picker"'), 'beside the run picker it replaces in Chat mode');
  // the page order is the reading and tab order: transcript, then what is docked under it
  const order = ['id="thread"', 'id="runline"', 'id="alert"', 'id="chat-view"', 'id="hitl"', 'id="exit-panel"', 'id="recovery"', 'id="release-note"', 'id="followup"', 'id="chat-view-form"', 'id="empty"', 'id="dash"'];
  const at = order.map((id) => html.indexOf(id));
  assert.ok(at.every((i) => i > 0), 'every part is in the page');
  assert.deepEqual([...at].sort((a, b) => a - b), at, order.join(' < '));
  assert.match(html, /<section class="chatview" id="chat-view" hidden /, 'hidden until the script shows it');
  assert.match(html, /<form class="steer" id="chat-view-form" hidden novalidate /);
  assert.match(html, /<textarea id="followup-text"[^>]*placeholder="Ask a question or describe a task\.\.\."/);
  assert.match(html, /<textarea id="chat-view-input"[^>]*maxlength="16000"/);
  assert.match(html, /<label class="steer-to" for="chat-view-to">/);
  assert.match(html, /<label class="sr-only" for="chat-view-input">/);
  assert.match(html, /id="chat-view-status" role="status" aria-live="polite"/);
  assert.match(html, /<button type="submit" class="btn btn-primary btn-small" id="chat-view-send">/);
});

test('Dashboard mode keeps today\'s page: every Chat rule waits for Chat mode or styles only the new parts', () => {
  const css = read('styles.css');
  const section = css.match(/\/\* -+ chat view \*\/[\s\S]*?(?=\/\* -+ narrow \*\/)/)?.[0] ?? '';
  assert.ok(section.length > 2000, 'the Chat view section is found');
  const rules = section.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  assert.ok(rules.length > 40, `${rules.length} rules`);
  const fresh = /^(\.chatview|\.chat-|\.md\b|\.steer|\.view-mode)/;
  for (const selector of rules.flatMap((r) => r.split(/,\s*\n/))) {
    const s = selector.trim();
    const own = fresh.test(s) || /^body\[data-(run|scope)="none"\] #chat-view$/.test(s);
    assert.ok(own || s.startsWith('body[data-view="chat"]'), `"${s}" would restyle the dashboard`);
  }
  assert.match(css, /body\[data-view="chat"\] \.main \{ position: relative; height: auto; min-height: 0; overflow-y: auto;/, 'the transcript, not the page, takes the rest of the window');
  assert.match(css, /\.md pre \{[^}]*overflow-x: auto;/, 'a code block scrolls inside itself');
  assert.match(css, /--read: 48rem;/);
  // The narrow HUD reflow is deliberately Dashboard-only; the transcript keeps its own docked layout.
  const rest = css.replace(section, '').replace(/body\[data-view="dashboard"\][^{]+\{[^}]*\}/g, '');
  assert.doesNotMatch(rest, /chat-view|chatview|data-view/);
});

// ------------------------------------------------------------ the chat header and the run composer

const PROJECTS = (status = 'done') => parseProjects({ mode: 'registry', projects: [{ id: 'core', name: 'Core', workspace: 'C:\\code\\core', chats: [{ id: 'a', title: 'First', status, runs: 2 }] }] });
const RUN_LIST = { runs: [
  { runId: 'r1', goal: 'First', status: 'success', startedAt: '2026-11-10T10:00:00Z', endedAt: '2026-11-10T10:01:00Z', current: false, summary: 'Answered by Michael', reply: { kind: 'answer', text: 'An answer.' } },
  { runId: 'r2', goal: 'Second', status: 'running', startedAt: '2026-11-11T09:00:00Z', current: true },
] };

// routes: url -> { status, body } (missing: the network fails)
function threadHarness({ view = 'dashboard', alive = false, status = 'done', activate = true, hasRun = true, routes = {} } = {}) {
  installDom();
  const page = globalThis.document;
  const $ = (id) => page.getElementById(id);
  const fetched = [];
  const base = '/api/projects/core/chats/a';
  const table = { [`${base}/runs`]: { status: 200, body: RUN_LIST }, ...routes };
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const r = table[url];
    if (!r) throw new Error('network');
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  const state = { view, alive, status, changed: 0 };
  const scope = createScope({ project: 'core', chat: 'a' });
  const thread = createThread({
    scope,
    nav: { doc: () => PROJECTS(state.status), refresh() {}, newChat() {}, newProject() {}, rename() {} },
    control: { snapshot: () => ({ control: { enabled: true }, mode: 'live', gates: { alive: state.alive, recovery: false } }), openRun() {}, startFollowUp: async () => ({ ok: true }) },
    onReplay() {},
    view: () => state.view,
    hasRun: () => hasRun,
    onRuns: () => { state.changed += 1; },
    keepEvent: (e) => e.type !== 'agent_status',
  });
  if (activate) thread.activate();
  const shown = () => Object.fromEntries(['thread', 'thread-project', 'thread-sep', 'thread-title', 'thread-rename', 'thread-runs', 'replay-banner', 'followup']
    .map((id) => [id, !$(id).hidden]));
  return { $, thread, scope, state, fetched, base, shown };
}

test('Dashboard mode shows and hides what it did before the switch existed; Chat mode drops the run picker', async () => {
  const idle = threadHarness({ view: 'dashboard' });
  const DASH = { thread: true, 'thread-project': true, 'thread-sep': true, 'thread-title': true, 'thread-rename': true, 'thread-runs': true, 'replay-banner': false, followup: true };
  assert.deepEqual(idle.shown(), DASH);
  assert.equal(idle.$('followup').dataset.off, 'false');
  assert.equal(idle.$('followup-send').textContent, 'Follow up');
  assert.equal(idle.$('followup-text').placeholder, 'Ask a question or describe a task...');

  // a live run: the composer stays as one quiet line that points at the Messages tab, exactly as before
  const live = threadHarness({ view: 'dashboard', alive: true, status: 'running' });
  assert.deepEqual(live.shown(), DASH);
  assert.equal(live.$('followup').dataset.off, 'true');
  assert.equal(live.$('followup-hint').textContent, 'A run is in progress. Message its agents under Messages; follow up once it has finished.');
  assert.deepEqual(composerGate({ scoped: true, enabled: true, mode: 'live', replaying: false, chatStatus: 'running', alive: true, runs: 2 }),
    { hidden: false, disabled: true, label: 'Follow up', reason: 'A run is in progress. Message its agents under Messages; follow up once it has finished.' }, 'without a view the gate is the old one');

  const chat = threadHarness({ view: 'chat' });
  assert.deepEqual(chat.shown(), { ...DASH, 'thread-runs': false }, 'the conversation holds every run, so there is none to pick');
  assert.equal(chat.$('followup').dataset.off, 'false');
  assert.equal(chat.$('followup-text').placeholder, 'Ask a question or describe a task...');

  // a live run in Chat mode: the steering composer takes this place
  const steering = threadHarness({ view: 'chat', alive: true, status: 'running' });
  assert.deepEqual(steering.shown(), { ...DASH, 'thread-runs': false, followup: false });
  // the sidebar already says running, the control poll not yet: the composer waits, without naming a tab that is not there
  const waiting = threadHarness({ view: 'chat', alive: false, status: 'running' });
  assert.equal(waiting.shown().followup, true);
  assert.equal(waiting.$('followup').dataset.off, 'true');
  assert.equal(waiting.$('followup-hint').textContent, 'A run is in progress. Follow up once it has finished.');

  // switching is a render away
  chat.state.view = 'dashboard';
  chat.thread.render();
  assert.deepEqual(chat.shown(), DASH);
});

test('a page without projects (the demo recording, an older server) gets the switch alone, once a run is there', () => {
  const none = threadHarness({ activate: false, hasRun: false });
  none.thread.render();
  assert.equal(none.shown().thread, false, 'no run: no head, as before');
  const bare = threadHarness({ activate: false, hasRun: true });
  bare.thread.render();
  assert.deepEqual(bare.shown(), { thread: true, 'thread-project': false, 'thread-sep': false, 'thread-title': false, 'thread-rename': false, 'thread-runs': false, 'replay-banner': true, followup: true },
    'only the head row with the switch; the banner and the composer are not touched');
  assert.deepEqual(bare.fetched, [], 'and no run list is asked for');
});

test('the run list carries each reply; an earlier run\'s events are fetched once, kept per chat and bounded to what is read', async () => {
  const events = [
    { runId: 'r1', seq: 1, type: 'run_started', request: 'First' }, { runId: 'r1', seq: 2, type: 'agent_status', agent: 'michael', status: 'thinking' },
    { runId: 'r1', seq: 3, type: 'agent_message', agent: 'michael', text: 'Hi', final: true }, { runId: 'other', seq: 1, type: 'run_started' }, null,
  ];
  const h = threadHarness({ view: 'chat', routes: {
    '/api/projects/core/chats/a/runs/r1/events': { status: 200, body: { events } },
    '/api/projects/core/chats/a/runs/big/events': { status: 413, body: { error: 'too large' } },
    '/api/projects/core/chats/a/runs/empty/events': { status: 200, body: { events: [] } },
  } });
  h.thread.setScope();
  await tick();
  assert.deepEqual(h.thread.runs().map((r) => [r.runId, r.reply, r.summary]), [['r1', { kind: 'answer', text: 'An answer.' }, 'Answered by Michael'], ['r2', null, '']]);
  assert.equal(h.state.changed, 1, 'the page is told when the list arrives');
  const v0 = h.thread.version();

  assert.deepEqual(await h.thread.loadRun('r1'), { ok: true });
  assert.deepEqual(h.thread.details().map((e) => [e.runId, e.type]), [['r1', 'run_started'], ['r1', 'agent_message']], 'this run only, without the events nobody reads');
  assert.ok(h.thread.version() > v0);
  assert.equal(h.state.changed, 2);
  assert.deepEqual(await h.thread.loadRun('r1'), { ok: true });
  assert.equal(h.fetched.filter((u) => u.endsWith('/runs/r1/events')).length, 1, 'asked once');

  assert.deepEqual(await h.thread.loadRun('big'), { error: 'The event log of this run is larger than 20 MiB, so its agent messages cannot be shown here.' });
  assert.deepEqual(await h.thread.loadRun('missing'), { error: 'The server did not answer. Is it still running?' });
  assert.deepEqual(await h.thread.loadRun('empty'), { error: 'The server sent no events for this run.' });
  assert.deepEqual(await h.thread.loadRun('../x'), { error: 'This run is not in the chat history any more.' }, 'an id that is no run id is never fetched');
  assert.equal(h.fetched.some((u) => u.includes('..')), false);
  assert.equal(h.thread.details().length, 2, 'a failed load keeps nothing');

  // another chat: its runs and opened events are not this chat's
  h.scope.set({ project: 'core', chat: 'b' });
  h.thread.setScope();
  assert.deepEqual([h.thread.runs(), h.thread.details()], [[], []]);
});

// ------------------------------------------------------------ the dock

test('when the run composer and the steering composer swap, the focus goes with them, never to the page', () => {
  const $ = installTree();
  const form = (id) => {
    const f = $(id);
    const field = new TreeEl('textarea');
    f.append(field);
    return { form: f, field };
  };
  const run = form('followup');
  const steer = form('chat-view-form');
  const fallback = $('chat-view-scroll');
  const dock = createDock([run, steer], fallback);
  const swap = (hide, show) => {
    hide.form.hidden = true;
    show.form.hidden = false;
  };
  steer.form.hidden = true;

  // Ctrl+Enter in the run composer starts a run: the composer gives way to the steering one
  run.field.focus();
  let settle = dock.hold();
  swap(run, steer);
  settle();
  assert.equal(document.activeElement, steer.field);
  // the run ends while the human is typing to an agent
  settle = dock.hold();
  swap(steer, run);
  settle();
  assert.equal(document.activeElement, run.field);

  // nothing swapped: the focus is left where it is
  settle = dock.hold();
  settle();
  assert.equal(document.activeElement, run.field);
  // the focus is somewhere else: a swap does not pull it into the dock
  const elsewhere = new TreeEl('button');
  elsewhere.focus();
  settle = dock.hold();
  swap(run, steer);
  settle();
  assert.equal(document.activeElement, elsewhere);
  // no composer left (the page became read only), or the next one cannot take it: the transcript does
  steer.field.focus();
  settle = dock.hold();
  steer.form.hidden = true;
  settle();
  assert.equal(document.activeElement, fallback);
  run.form.hidden = false;
  run.field.focus();
  steer.form.hidden = false;
  steer.field.disabled = true;
  settle = dock.hold();
  run.form.hidden = true;
  settle();
  assert.equal(document.activeElement, fallback);
});

// ------------------------------------------------------------ one steering composer, two mounts

const MOUNTS = {
  messages: { form: 'chat-form', to: 'chat-to', text: 'chat-text', count: 'chat-count', send: 'chat-send', block: 'chat-block', status: 'chat-status' },
  chat: { form: 'chat-view-form', to: 'chat-view-to', text: 'chat-view-input', count: 'chat-view-count', send: 'chat-view-send', block: 'chat-view-block', status: 'chat-view-status' },
};
const other = (name) => (name === 'chat' ? 'messages' : 'chat');

// One page with a running instance dwight-m1 and both composers: the Messages tab's and the Chat view's.
function steerHarness(t) {
  const $ = installDom();
  globalThis.CSS = { escape: (s) => s };
  const runId = 'run-a';
  const stream = [];
  const page = { alive: true, view: 'chat', changes: 0, sent: 0 };
  const state = () => {
    let seq = 0;
    const e = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 11, 12, 0, seq)).toISOString(), runId, type, ...fields });
    return reduceAll([
      e('run_started', { request: 'Todo', workspace: 'C:\\ws', maxFailedCycles: 3 }),
      e('instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
      e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Coding' }),
      ...stream.map(([type, fields]) => e(type, fields)),
    ]);
  };
  const control = parseControl({
    v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'], lastExit: null, pendingHuman: null,
    run: { pid: 7, mode: 'run', request: 'Todo', workspace: 'C:\\ws', startedAt: '2026-11-11T12:00:00.000Z', runId },
  });
  const posts = [];
  let answer;
  let next = 0;
  globalThis.fetch = async (url, opts = {}) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    const data = await new Promise((resolve) => { answer = resolve; });
    return data.status ? { ok: false, status: data.status, json: async () => data } : { ok: true, status: 202, json: async () => data };
  };
  const panel = createChatPanel({
    getState: state,
    getControl: () => ({ control: page.alive ? control : { ...control, run: null }, mode: 'live', gates: { on: true, alive: page.alive }, gone: false }),
    url: (suffix) => `/api/projects/core/chats/a/${suffix}`,
    onChange: () => { page.changes += 1; },
  });
  // exactly what main.js does for the Chat view
  const els = Object.fromEntries(Object.entries(MOUNTS.chat).map(([k, id]) => [k, $(id)]));
  panel.steering.mount(els, { shown: ({ enabled, alive }) => enabled && alive && page.view === 'chat', onSent: () => { page.sent += 1; } });
  // the stale timer of a queued message would keep the process alive
  t.after(() => panel.reset());
  panel.render();
  const el = (name, part) => $(MOUNTS[name][part]);
  const look = (name) => ({
    status: [el(name, 'status').textContent, el(name, 'status').dataset.tone],
    draft: el(name, 'text').value, count: el(name, 'count').textContent,
    send: [el(name, 'send').disabled, el(name, 'send').textContent], to: el(name, 'to').disabled,
    invalid: [el(name, 'to').getAttribute('aria-invalid'), el(name, 'text').getAttribute('aria-invalid')],
    off: el(name, 'form').dataset.off, block: el(name, 'block').textContent, options: el(name, 'to').childNodes.map((o) => [o.value, o.textContent]),
  });
  return { $, panel, page, posts, stream, el, look, answer: (data) => answer(data ?? { id: `msg-${++next}`, delivery: 'queued' }) };
}

// The same steps on one composer; what it and the page showed after each of them.
async function script(t, name) {
  const h = steerHarness(t);
  const trace = [];
  const note = (step) => trace.push([step, h.look(name)]);
  note('start');
  // nothing typed
  await h.el(name, 'form').fire('submit');
  note('empty');
  h.el(name, 'to').value = 'dwight-m1';
  await h.el(name, 'to').fire('change');
  h.el(name, 'text').value = 'x'.repeat(16001);
  await h.el(name, 'text').fire('input');
  await h.el(name, 'form').fire('submit');
  note('too long');
  h.el(name, 'text').value = '  Use todos.json  ';
  await h.el(name, 'text').fire('input');
  note('typed');
  const sent = h.el(name, 'form').fire('submit');
  await tick();
  note('sending');
  const posted = structuredClone(h.posts);
  const second = h.look(other(name));
  h.answer();
  await sent;
  note('queued');
  h.stream.push(['chat_message', { id: 'msg-1', from: 'human', to: 'dwight-m1', text: 'Use todos.json', delivery: 'queued' }]);
  h.stream.push(['chat_delivery', { id: 'msg-1', delivery: 'delivered' }]);
  h.panel.render();
  note('delivered');
  // a refused send keeps the draft
  h.el(name, 'text').value = 'Again';
  const refused = h.el(name, 'form').fire('submit');
  await tick();
  h.answer({ status: 409, error: 'dwight-m1 is not running any more' });
  await refused;
  note('refused');
  // the run ends
  h.page.alive = false;
  h.panel.render();
  note('over');
  return { h, trace, posted, second };
}

test('the Messages composer and the Chat composer are one implementation: the same steps give the same result', async (t) => {
  const messages = await script(t, 'messages');
  const chat = await script(t, 'chat');
  assert.deepEqual(chat.trace, messages.trace, 'every state after every step');
  assert.deepEqual(chat.posted, messages.posted);
  assert.deepEqual(messages.posted, [{ url: '/api/projects/core/chats/a/chat', body: { runId: 'run-a', to: 'dwight-m1', text: 'Use todos.json' } }]);

  const by = Object.fromEntries(chat.trace);
  assert.deepEqual(by.start.options, [['dwight-m1', 'dwight-m1 (working)']]);
  assert.deepEqual([by.start.off, by.start.block], ['false', 'Ctrl+Enter sends']);
  assert.deepEqual(by.empty.status, ['Pick the agent instance that should get the message.', 'error']);
  assert.deepEqual(by.empty.invalid, ['true', null]);
  assert.deepEqual(by['too long'].status, ['The message is 16001 characters; the limit is 16000.', 'error']);
  assert.deepEqual(by['too long'].invalid, [null, 'true']);
  assert.equal(by['too long'].count, '16001 / 16000');
  assert.deepEqual(by.typed.invalid, [null, null], 'typing clears the mark');
  assert.deepEqual([by.sending.status, by.sending.send, by.sending.to], [['Sending to dwight-m1...', 'busy'], [true, 'Sending...'], true]);
  assert.deepEqual([by.queued.draft, by.queued.count, by.queued.send], ['', '0 / 16000', [false, 'Send']]);
  assert.match(by.queued.status[0], /^Queued for dwight-m1\./);
  assert.deepEqual(by.delivered.status, ['Message to dwight-m1 delivered', '']);
  assert.deepEqual([by.refused.status, by.refused.draft], [['dwight-m1 is not running any more', 'error'], 'Again']);
  assert.deepEqual([by.over.off, by.over.block, by.over.send[0]], ['true', 'No run is in progress.', true]);

  // while one composer sends, the other cannot send a second message
  assert.deepEqual(chat.second.send, [true, 'Sending...']);
  assert.deepEqual(messages.second.send, [true, 'Sending...']);
  // delivery news comes from the stream, so both composers have it, whichever is on screen
  for (const run of [messages, chat]) {
    const after = Object.fromEntries(run.trace).delivered;
    assert.deepEqual(after.status, ['Message to dwight-m1 delivered', '']);
  }
  assert.equal(chat.h.page.sent, 1, 'the Chat view is told when its message was taken, to show it');
  assert.equal(messages.h.page.sent, 0);
  assert.ok(chat.h.page.changes >= 3, 'and the page is told to draw again');
});

test('each composer keeps its own draft, and each is shown where it belongs', async (t) => {
  const h = steerHarness(t);
  h.el('messages', 'text').value = 'Draft in Messages';
  h.el('chat', 'to').value = 'dwight-m1';
  h.el('chat', 'text').value = 'Sent from Chat';
  const sent = h.el('chat', 'form').fire('submit');
  await tick();
  h.answer();
  await sent;
  assert.equal(h.el('chat', 'text').value, '');
  assert.equal(h.el('messages', 'text').value, 'Draft in Messages', 'the other draft is left alone');
  assert.equal(h.el('messages', 'status').textContent, '', 'what one composer says about its own send is not said by the other');
  // the message is in the outbox of the one session: the Messages transcript shows it, and the Chat view gets it
  assert.deepEqual(h.$('chat-list').childNodes.map((li) => li.dataset.delivery), ['queued']);
  assert.deepEqual(h.panel.steering.pending().map((o) => [o.id, o.to, o.text, o.delivery, o.stale]), [['msg-1', 'dwight-m1', 'Sent from Chat', 'queued', false]]);
  assert.equal(h.panel.canMessage('dwight-m1'), true);

  assert.deepEqual([h.el('messages', 'form').hidden, h.el('chat', 'form').hidden], [false, false]);
  h.page.view = 'dashboard';
  h.panel.render();
  assert.deepEqual([h.el('messages', 'form').hidden, h.el('chat', 'form').hidden], [false, true], 'in Dashboard mode only the Messages tab has a composer');
  h.page.view = 'chat';
  h.page.alive = false;
  h.panel.render();
  assert.deepEqual([h.el('messages', 'form').hidden, h.el('chat', 'form').hidden], [false, true], 'without a live run the Chat view shows the run composer instead');

  // another chat: neither composer keeps a draft or a status
  h.el('chat', 'text').value = 'left over';
  h.panel.reset();
  assert.deepEqual(['messages', 'chat'].map((n) => [h.el(n, 'text').value, h.el(n, 'status').textContent]), [['', ''], ['', '']]);
  assert.deepEqual(h.panel.steering.pending(), []);
});

test('the rules live in one module: the panel and the page only mount it', () => {
  const panel = read('js/chat-panel.js');
  assert.match(panel, /import \{ createSteering \} from '\.\/chat-steer\.js';/);
  assert.doesNotMatch(panel, /buildChatRequest|postJson|chatRecipients|composerBlock|deliveryNews|pruneOutbox/, 'no copy of the rules is left in the panel');
  const main = read('js/main.js');
  assert.match(main, /chat\.steering\.mount\(\{\s*form: \$\('chat-view-form'\), to: \$\('chat-view-to'\), text: \$\('chat-view-input'\)/);
  assert.equal((main.match(/createSteering|buildChatRequest/g) ?? []).length, 0, 'the page makes no second session');
  // the view is engine neutral: entries in, nodes out
  const view = read('js/chat-view.js');
  assert.deepEqual([...view.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]), ['./chat-entries.js', './chat-markdown.js', './format.js']);
  assert.doesNotMatch(view, /agent_message|run_reply|hive_write|reduce\(/);
  // and the logic it shares with other adapters touches no DOM
  for (const file of ['js/chat-entries.js', 'js/chat-adapter-team.js']) assert.doesNotMatch(read(file), /\bdocument\b|\bwindow\b|getElementById|createElement/, file);
  const markdown = read('js/chat-markdown.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(markdown, /(?<!doc = globalThis\.)\bdocument\b|\bwindow\b/, 'the builder only names the document as its default argument');
});

// Visual corrections shared by Team and Pipeline conversations.
test('consecutive same-speaker/context messages share a name line while tools and articles remain accessible', () => {
  const h = viewHarness();
  const context = { instanceId: 'dwight-m2', milestoneId: 'm2', cycle: 1 };
  h.add(START, msg('dwight', 'Reading.', context),
    ['agent_tool', { agent: 'dwight', ...context, tool: 'read', detail: 'a.js' }],
    msg('dwight', 'Implemented.', { ...context, final: true }),
    msg('dwight', 'Next cycle.', { ...context, cycle: 2 }), msg('angela', 'Reviewing.', context));
  const agents = h.items().filter((x) => x.dataset.kind === 'agent');
  assert.deepEqual(agents.map((x) => x.dataset.cont), ['false', 'true', 'false', 'false']);
  const tool = h.item('activity');
  assert.equal(tool.dataset.cont, 'true');
  assert.match(tool.querySelector('.sr-only').textContent, /^Dwight · /);
  assert.match(agents[1].getAttribute('aria-label'), /^Dwight, Developer, m2 · cycle 1/);
  assert.equal(agents[1].querySelector('.chat-body').textContent, 'Implemented.');
  const css = read('styles.css');
  assert.match(css, /\.chat-entry\[data-cont="true"\] \.chat-head > :not\(\.badge\) \{ display: none; \}/);
  assert.match(css, /\.chat-entry\[data-kind="activity"\]\[data-cont="true"\] \{ margin-left: var\(--s3\); \}/);
});

test('Chat visual rules show project / title, suppress only the outcome the reply states, and leave just status/elapsed/connection', () => {
  const h = threadHarness({ view: 'chat' });
  assert.equal(h.$('thread-project').hidden, false);
  assert.equal(h.$('thread-project').textContent, 'Core');
  assert.equal(h.$('thread-sep').hidden, false);
  assert.equal(h.$('thread-title').textContent, 'First');
  h.scope.set(null);
  h.thread.render();
  assert.equal(h.$('thread-project').hidden, true);
  assert.equal(h.$('thread-sep').hidden, true);
  const css = read('styles.css');
  assert.match(css, /body\[data-view="chat"\] \.runline :is\(\.summary, \.more-toggle, \.run-more\) \{ display: none; \}/);
  assert.match(css, /body\[data-view="chat"\] \.alert:is\(\[data-kind="finished"\], \[data-kind="ended"\]\) \{ display: none; \}/);
  assert.doesNotMatch(css, /body\[data-view="chat"\] \.alert\s*\{[^}]*display: none/);
  assert.doesNotMatch(css, /body\[data-view="chat"\] \.thread-project\s*\{[^}]*display: none/);
  const html = read('index.html');
  const runState = html.match(/<div class="run-state">([\s\S]*?)<\/div>/)[1];
  for (const id of ['run-status', 'elapsed', 'conn']) assert.ok(runState.includes(`id="${id}"`));
});

test('Pipeline pending question opens Details through one button without duplicating approval controls', () => {
  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  const mode = createViewMode();
  mode.name('Details');
  let focused = 0;
  const entry = { id: 'p:gate:plan', runId: 'p', kind: 'question', who: { name: 'Pipeline' }, text: 'Review the plan', tone: 'warn' };
  const view = createChatView({ getEntries: () => [entry], currentRunId: () => 'p', ask: () => ({
    label: 'Review and decide', open() { mode.set('dashboard', { remember: false }); focused += 1; },
  }) });
  view.render();
  assert.equal(mode.get(), 'chat');
  assert.equal($('view-mode-dash').textContent, 'Details');
  const buttons = $('chat-view-list').querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'Review and decide');
  buttons[0].click();
  assert.equal(mode.get(), 'dashboard');
  assert.equal(focused, 1);
  assert.equal(localStorage.getItem(VIEW_KEY), null, 'approval navigation is not a saved preference');
  const main = read('js/main.js');
  assert.match(main, /label: 'Review and decide',[\s\S]*?viewMode\.set\('dashboard', \{ remember: false \}\);\s*pipelineView\.review\(\)/);
  assert.doesNotMatch(main, /viewMode\.offer\(.*pipeline/);
});

test('an outcome the reply states is marked redundant for Chat (success, failed, aborted); a partial result stays visible', () => {
  const $ = installTree();
  for (const cls of ['pill-glyph', 'pill-text']) {
    const span = document.createElement('span');
    span.className = cls;
    $('run-status').append(span);
  }
  const dashboard = createDashboard();
  for (const result of ['success', 'partial', 'failed', 'aborted']) {
    dashboard.render(reduceAll([
      { type: 'run_started', runId: 'r', seq: 1, ts: '2026-11-11T10:00:00Z', request: 'Test' },
      { type: 'run_finished', runId: 'r', seq: 2, ts: '2026-11-11T10:01:00Z', status: result, summary: result },
    ]));
    assert.equal($('alert').hidden, false, 'Dashboard retains its outcome alert');
    assert.equal($('alert').dataset.kind, { success: 'finished', partial: 'attention' }[result] ?? 'ended');
  }
});
