// A request made for one chat must never land in the chat that replaced it on screen while the request waited
// (review finding: a follow-up awaited /api/models and then posted to the next chat's /runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { createModelPicker } from '../../visualizer/public/js/accounts-panel.js';
import { createState } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';

const CONTROL = (chat, alive) => ({
  v: 1, enabled: true, workspace: 'C:\\work\\core', scenarios: ['happy'],
  run: alive ? { pid: 7, mode: 'run', request: `goal of ${chat}`, workspace: 'C:\\work\\core', startedAt: '2026-11-08T10:00:00Z', runId: `run-${chat}` } : null,
  lastExit: null, pendingHuman: null, instances: {}, recoveryRequired: false,
});

// Two chats, a and b, of one project; posts lists every POST the panel sent.
// realModels: the drawer's real model picker, whose GET /api/models waits until releaseModels().
function harness({ alive = false, realModels = false } = {}) {
  const $ = installDom();
  const posts = [];
  const scope = { chat: 'a' };
  let release;
  const held = () => new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') posts.push(url);
    if (url === '/api/models') {
      await held();
      return { ok: false, status: 404, json: async () => null };
    }
    const chat = /\/chats\/([^/]+)\//.exec(url)?.[1];
    const body = opts.method === 'POST' ? { pid: 9, runId: 'run-new' } : CONTROL(chat, alive);
    return { ok: true, status: opts.method === 'POST' ? 202 : 200, json: async () => body };
  };
  const models = realModels
    ? createModelPicker({ openAccounts() {}, canOpenAccounts: () => false })
    : { open: held, selection: () => ({ models: {} }), sync() {} };
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({
    dashboard: stub, pipeline: stub, lanes: stub, models, getState: () => createState(),
    url: (suffix) => `/api/projects/core/chats/${scope.chat}/${suffix}`,
  });
  // what main.js bind() does on a chat switch
  const switchTo = (chat) => {
    scope.chat = chat;
    panel.reset();
  };
  return { $, panel, posts, switchTo, releaseModels: () => release(), tick: () => new Promise((r) => setTimeout(r, 10)) };
}

test('a follow-up that waited for the model list is not started in the chat switched to meanwhile', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  assert.equal(h.panel.snapshot().gates.canStart, true);
  const pending = h.panel.startFollowUp('Next step for chat a');
  h.switchTo('b');
  await h.tick();
  assert.equal(h.panel.snapshot().gates.canStart, true, 'chat b could take a run too');
  h.releaseModels();
  const r = await pending;
  assert.deepEqual(h.posts, [], 'nothing was posted, least of all to chat b');
  assert.notEqual(r.ok, true);
});

test('without a switch the follow-up goes to the chat on screen', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const pending = h.panel.startFollowUp('Next step');
  await h.tick();
  h.releaseModels();
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(h.posts, ['/api/projects/core/chats/a/runs']);
});

test('a Stop confirmed after a chat switch never stops the run of the new chat', async (t) => {
  const h = harness({ alive: true });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  await h.$('stop-run').fire('click');
  assert.equal(h.$('confirm-dialog').open, true);
  h.switchTo('b');
  await h.tick();
  await h.$('confirm-ok').fire('click');
  assert.deepEqual(h.posts, []);
});

test('with the real model picker: a switch while GET /api/models is pending posts nothing', async (t) => {
  const h = harness({ realModels: true });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const pending = h.panel.startFollowUp('Next step for chat a');
  await h.tick();
  h.switchTo('b');
  await h.tick();
  h.releaseModels();
  const r = await pending;
  assert.deepEqual(h.posts, []);
  assert.match(r.error, /Another chat is on screen/);
});

test('with the real model picker and no switch the follow-up still starts in chat a', async (t) => {
  const h = harness({ realModels: true });
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  const pending = h.panel.startFollowUp('Next step');
  await h.tick();
  h.releaseModels();
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(h.posts, ['/api/projects/core/chats/a/runs']);
});

test('a New run drawer opened for chat a closes on a switch, and its submit posts nothing', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  h.panel.openRun();
  assert.equal(h.$('run-dialog').open, true);
  h.$('f-request').value = 'Build it';
  h.switchTo('b');
  await h.tick();
  assert.equal(h.$('run-dialog').open, false);
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, []);
});

test('without a switch the New run drawer starts the run in chat a', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  h.panel.setMode('live');
  await h.tick();
  h.panel.openRun();
  h.$('f-request').value = 'Build it';
  await h.$('run-form').fire('submit');
  assert.deepEqual(h.posts, ['/api/projects/core/chats/a/runs']);
  assert.equal(h.$('run-dialog').open, false);
});
