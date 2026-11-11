// The event log and the Messages transcript in a tab that is hidden, or in a dashboard that is not shown yet.
// A box that is not rendered measures 0 everywhere, so it read as "at the bottom": a reader lost their place and
// the count of new rows, the first rows of a run left the log at its oldest row, and news about a sent message
// happened in a panel nobody could see or hear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLog } from '../../visualizer/public/js/log.js';
import { createChatPanel } from '../../visualizer/public/js/chat-panel.js';
import { parseControl } from '../../visualizer/public/js/control.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { FakeEl, installDom } from './fixtures/fake-dom.js';
import { VIEW_PX, Scroller, installObservers } from './fixtures/fake-scroll.js';

// rows of the log body; a fragment's children are moved in, as in the DOM
class Rows extends FakeEl {
  get children() { return this.childNodes; }
  get firstElementChild() { return this.childNodes[0]; }
  append(...nodes) {
    for (const n of nodes) this.childNodes.push(...(n.fragment ? n.childNodes : [n]));
  }
}

function installBrowser() {
  const $ = installDom();
  const { show, resize } = installObservers();
  document.createElement = () => Object.assign(new FakeEl(), { classList: new Set() });
  document.createDocumentFragment = () => Object.assign(new FakeEl(), { fragment: true });
  return { $, show, resize };
}

function logHarness() {
  const { show, resize } = installBrowser();
  const body = new Rows();
  const scroller = new Scroller(() => body.children.length);
  const jump = new FakeEl();
  jump.hidden = true;
  const log = createLog({ table: new FakeEl(), body, scroller, empty: new FakeEl(), jump, filters: new FakeEl() });
  const entries = [];
  const add = (n) => {
    for (let i = 0; i < n; i++) {
      const seq = entries.length + 1;
      entries.push({ seq, ts: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString(), source: 'dwight', type: 'tool_call', category: 'tools', tone: '', text: `row ${seq}` });
    }
    log.render({ runId: 'r1', log: [...entries] });
  };
  const readBack = (top) => {
    scroller.scrollTop = top;
    scroller.fire('scroll');
  };
  return { log, scroller, jump, add, readBack, show: (on) => show(scroller, on), resize: (px) => resize(scroller, px) };
}

test('the first rows of a run that arrive while the dashboard is hidden end on the newest row once it shows', () => {
  const h = logHarness();
  h.show(false);
  h.add(60);
  assert.equal(h.scroller.scrollTop, 0, 'a hidden box cannot scroll');
  h.show(true);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'on the newest row');
  assert.equal(h.jump.hidden, true);
});

test('a reader in the event log keeps the place and the count of new rows across another tab', () => {
  const h = logHarness();
  h.add(60);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  h.readBack(200);
  h.show(false);
  h.add(5);
  assert.equal(h.jump.hidden, false, 'Jump to latest is offered');
  assert.equal(h.jump.textContent, '5 new · Jump to latest');
  h.show(true);
  h.log.reveal();
  assert.equal(h.scroller.scrollTop, 200, 'back where the reader was');
  assert.equal(h.jump.textContent, '5 new · Jump to latest');
  assert.equal(h.jump.hidden, false);
});

test('a follower of the event log is on the newest row after another tab', () => {
  const h = logHarness();
  h.add(60);
  h.show(false);
  h.add(5);
  h.show(true);
  h.log.reveal();
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  assert.equal(h.jump.hidden, true);
});

test('a follower of the event log stays on the newest row when the box changes height; a reader keeps the place', () => {
  const h = logHarness();
  h.add(60);
  h.resize(30);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'on the newest row after the box shrank');
  h.add(2);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'rows that arrive after the shrink are shown');
  h.resize(VIEW_PX);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());

  h.readBack(200);
  h.resize(30);
  h.add(2);
  assert.equal(h.scroller.scrollTop, 200, 'the reader is where they were');
  assert.equal(h.jump.textContent, '2 new · Jump to latest');
});

// the Messages panel with one running instance dwight-m1; later: [type, fields] that the stream adds
function chatHarness(t) {
  const { $, show, resize } = installBrowser();
  const runId = 'run-a';
  const stream = [];
  const state = () => {
    let seq = 0;
    const e = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString(), runId, type, ...fields });
    return reduceAll([
      e('run_started', { request: 'Todo', workspace: 'C:\\ws', maxFailedCycles: 3 }),
      e('instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
      e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Coding' }),
      ...stream.map(([type, fields]) => e(type, fields)),
    ]);
  };
  const control = parseControl({
    v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'], lastExit: null, pendingHuman: null,
    run: { pid: 7, mode: 'run', request: 'Todo', workspace: 'C:\\ws', startedAt: '2026-11-08T12:00:00.000Z', runId },
  });
  let next = 0;
  globalThis.fetch = async () => ({ ok: true, status: 202, json: async () => ({ id: `msg-${++next}`, delivery: 'queued' }) });
  const scroller = new Scroller(() => $('chat-list').childNodes.length * 2);
  const byId = document.getElementById;
  document.getElementById = (id) => (id === 'chat-scroll' ? scroller : byId(id));
  const panel = createChatPanel({
    getState: state,
    getControl: () => ({ control, mode: 'live', gates: { on: true, alive: true }, gone: false }),
    url: (suffix) => `/api/projects/core/chats/a/${suffix}`,
  });
  // the stale timer of a queued message would keep the process alive
  t.after(() => panel.reset());
  panel.render();
  const say = (n) => {
    for (let i = 0; i < n; i++) stream.push(['chat_message', { id: `m-${stream.length}`, from: 'dwight-m1', to: 'angela-m1', text: 'note', delivery: 'delivered' }]);
    panel.render();
  };
  // what the tabs do: the panel is hidden or shown, and a shown Messages tab is revealed
  const tab = (on) => {
    $('chat-panel').hidden = !on;
    show(scroller, on);
    if (on) panel.reveal();
  };
  return { $, panel, stream, scroller, say, tab, resize: (px, notify) => resize(scroller, px, notify) };
}

// Focusing the composer makes it taller, so the transcript above it shrinks by more than the follow slack.
test('a follower of the Messages transcript stays on the newest message while typing; a reader keeps the place', (t) => {
  const h = chatHarness(t);
  h.say(30);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  h.$('chat-text').focus();
  h.resize(30);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'on the newest message after the box shrank');
  h.say(1);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'a reply that arrives while typing is shown');
  h.resize(VIEW_PX);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'and after the composer is left');
  h.resize(30, false);
  h.say(1);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'a reply rendered before the observer runs is shown');
  h.resize(VIEW_PX);

  h.scroller.scrollTop = 120;
  h.scroller.fire('scroll');
  h.resize(30);
  h.say(2);
  assert.equal(h.scroller.scrollTop, 120, 'the reader is where they were');
  h.resize(VIEW_PX);
  assert.equal(h.scroller.scrollTop, 120);
});

test('a reader in the Messages transcript keeps the place across another tab; a follower gets the newest', (t) => {
  const h = chatHarness(t);
  h.say(30);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom());
  h.scroller.scrollTop = 120;
  h.scroller.fire('scroll');
  h.tab(false);
  h.say(4);
  h.tab(true);
  assert.equal(h.scroller.scrollTop, 120, 'back where the reader was');

  h.scroller.scrollTop = h.scroller.bottom();
  h.scroller.fire('scroll');
  h.tab(false);
  h.say(4);
  h.tab(true);
  assert.equal(h.scroller.scrollTop, h.scroller.bottom(), 'the follower is on the newest message');
});

test('news about a sent message that comes in on another tab is marked unseen until Messages is opened', async (t) => {
  const h = chatHarness(t);
  h.$('chat-to').value = 'dwight-m1';
  h.$('chat-text').value = 'Use todos.json';
  await h.$('chat-form').fire('submit');
  assert.match(h.$('chat-status').textContent, /^Queued for dwight-m1\./);
  assert.equal(h.$('chat-status').dataset.unseen, 'false', 'said while the tab is open');
  h.tab(false);
  h.stream.push(['chat_message', { id: 'msg-1', from: 'human', to: 'dwight-m1', text: 'Use todos.json', delivery: 'queued' }]);
  h.stream.push(['chat_delivery', { id: 'msg-1', delivery: 'delivered' }]);
  h.panel.render();
  assert.equal(h.$('chat-status').textContent, 'Message to dwight-m1 delivered');
  assert.equal(h.$('chat-status').dataset.unseen, 'true', 'shown on the tab that is open');
  h.tab(true);
  assert.equal(h.$('chat-status').dataset.unseen, 'false');
});

test('the message news line is a live region outside the tab panels', () => {
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  const panel = html.match(/<div class="tabpanel chat-panel"[\s\S]*?<\/form>\s*<\/div>/)?.[0] ?? '';
  assert.ok(panel, 'the Messages panel is found');
  assert.doesNotMatch(panel, /id="chat-status"/, 'not inside the Messages panel, which is hidden on the other tabs');
  const section = html.match(/<section class="activity-panel"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(section, /id="chat-status" role="status" aria-live="polite"/, 'still part of the activity panel');
  const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.activity-status:empty \{ display: block;/, 'an empty live region stays rendered');
});
