// The Messages composer driven end to end with a fake fetch (review finding: a local `mine` shadowed the Set of
// the human's own message ids, so every send that got an id threw before the draft was cleared).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatPanel } from '../../visualizer/public/js/chat-panel.js';
import { parseControl } from '../../visualizer/public/js/control.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';

// later: [type, fields] the stream adds after the run is up
function liveState(runId, later = []) {
  let seq = 0;
  const e = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString(), runId, type, ...fields });
  return reduceAll([
    e('run_started', { request: 'Todo', workspace: 'C:\\ws', maxFailedCycles: 3 }),
    e('instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Coding' }),
    ...later.map(([type, fields]) => e(type, fields)),
  ]);
}

const controlFor = (runId) => parseControl({
  v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'], lastExit: null, pendingHuman: null,
  run: { pid: 7, mode: 'run', request: 'Todo', workspace: 'C:\\ws', startedAt: '2026-11-08T12:00:00.000Z', runId },
});

// Chats a and b each run an instance dwight-m1 (instance ids repeat across chats). POST /api/chat waits for answer().
function harness() {
  const $ = installDom();
  globalThis.CSS = { escape: (s) => s };
  const scope = { chat: 'a' };
  const stream = [];
  const posts = [];
  let answer;
  globalThis.fetch = async (url, opts = {}) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    const data = await new Promise((resolve) => { answer = resolve; });
    return { ok: true, status: 202, json: async () => data };
  };
  const panel = createChatPanel({
    getState: () => liveState(`run-${scope.chat}`, stream),
    getControl: () => ({ control: controlFor(`run-${scope.chat}`), mode: 'live', gates: { on: true, alive: true }, gone: false }),
    url: (suffix) => `/api/projects/core/chats/${scope.chat}/${suffix}`,
  });
  panel.render();
  const draft = (text) => {
    $('chat-to').value = 'dwight-m1';
    $('chat-text').value = text;
  };
  const switchTo = (chat) => {
    scope.chat = chat;
    panel.reset();
  };
  return { $, panel, posts, stream, draft, switchTo, answer: (data) => answer(data), tick: () => new Promise((r) => setTimeout(r, 10)) };
}

// reset() also clears the outbox stale timer, which would keep the test process alive for 20 s
const start = (t) => {
  const h = harness();
  t.after(() => h.panel.reset());
  return h;
};

const ids = (h) => h.$('chat-list').childNodes.map((li) => li.dataset.delivery);

test('a send that gets an id clears the draft, says it is queued and tracks the id', async (t) => {
  const h = start(t);
  assert.equal(h.panel.canMessage('dwight-m1'), true);
  h.draft('Use todos.json');
  const sent = h.$('chat-form').fire('submit');
  await h.tick();
  assert.deepEqual(h.posts, [{ url: '/api/projects/core/chats/a/chat', body: { runId: 'run-a', to: 'dwight-m1', text: 'Use todos.json' } }]);
  assert.equal(h.$('chat-status').textContent, 'Sending to dwight-m1...');
  assert.equal(h.$('chat-send').disabled, true);
  h.answer({ id: 'msg-1', delivery: 'queued' });
  await sent;
  assert.equal(h.$('chat-text').value, '', 'draft cleared');
  assert.equal(h.$('chat-count').textContent, '0 / 16000');
  assert.match(h.$('chat-status').textContent, /^Queued for dwight-m1\./);
  assert.equal(h.$('chat-send').disabled, false, 'the composer is free again');
  assert.deepEqual(ids(h), ['queued']);
  assert.equal(h.$('chat-list').childNodes[0].dataset.human, 'true');
  // delivery news is only told for the human's own ids, so this line proves msg-1 was tracked
  h.stream.push(['chat_message', { id: 'msg-1', from: 'human', to: 'dwight-m1', text: 'Use todos.json', delivery: 'queued' }]);
  h.stream.push(['chat_delivery', { id: 'msg-1', delivery: 'delivered' }]);
  h.panel.render();
  assert.deepEqual(ids(h), ['delivered'], 'the echo replaced the outbox entry');
  assert.equal(h.$('chat-status').textContent, 'Message to dwight-m1 delivered');
});

test('a message the human did not send from this panel brings no delivery news', async (t) => {
  const h = start(t);
  h.stream.push(['chat_message', { id: 'msg-x', from: 'human', to: 'dwight-m1', text: 'From another window', delivery: 'queued' }]);
  h.stream.push(['chat_delivery', { id: 'msg-x', delivery: 'delivered' }]);
  h.panel.render();
  assert.deepEqual(ids(h), ['delivered']);
  assert.equal(h.$('chat-status').textContent, '');
});

test('a delivered answer is reported as delivered', async (t) => {
  const h = start(t);
  h.draft('Ship it');
  const sent = h.$('chat-form').fire('submit');
  await h.tick();
  h.answer({ id: 'msg-2', delivery: 'delivered' });
  await sent;
  assert.equal(h.$('chat-status').textContent, 'Message to dwight-m1 delivered');
  assert.deepEqual(ids(h), ['delivered']);
});

test('an answer that arrives after a chat switch is ignored', async (t) => {
  const h = start(t);
  h.draft('For chat a only');
  const sent = h.$('chat-form').fire('submit');
  await h.tick();
  h.switchTo('b');
  h.draft('Draft in chat b');
  h.answer({ id: 'msg-3', delivery: 'queued' });
  await sent;
  assert.equal(h.$('chat-text').value, 'Draft in chat b', 'the new chat keeps its own draft');
  assert.equal(h.$('chat-status').textContent, '');
  assert.deepEqual(ids(h), [], 'chat a\'s message never shows in chat b');
  assert.equal(h.$('chat-send').disabled, false);
  // chat b sends normally afterwards
  const next = h.$('chat-form').fire('submit');
  await h.tick();
  assert.equal(h.posts.at(-1).url, '/api/projects/core/chats/b/chat');
  h.answer({ id: 'msg-4', delivery: 'queued' });
  await next;
  assert.deepEqual(ids(h), ['queued']);
});
