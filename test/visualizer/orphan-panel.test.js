// The recovery panel for an orphaned run (.enma/orphan-recovery-contract.md section 7): what it offers by owner
// status, and Release chat end to end against a fake server. Imports only what the panel had before the release
// path, so these tests also run (and fail) against the code without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { CONTROL_HEADERS } from '../../visualizer/public/js/control.js';
import { formatClock } from '../../visualizer/public/js/format.js';
import { createState } from '../../visualizer/public/js/state.js';
import { installDom } from './fixtures/fake-dom.js';

// local times of today, so they read as a plain clock
const at = (h, m, s) => {
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.toISOString();
};
const STOP_AT = at(9, 15, 0);
const BEAT_AT = at(9, 14, 40);

const BASE = { v: 1, enabled: true, workspace: 'C:\\work\\core', scenarios: ['happy'], run: null, lastExit: null, pendingHuman: null, instances: {} };
const RUN = { pid: 7, mode: 'run', request: 'goal', workspace: 'C:\\work\\core', startedAt: '2026-11-08T10:00:00Z', runId: 'live-run' };
const orphanDoc = (fields) => ({
  ...BASE, recoveryRequired: true,
  orphan: fields === undefined ? undefined : { runId: '2dda5818', startedAt: at(8, 0, 0), ...fields },
});
const ALIVE = orphanDoc({ owner: 'alive', heartbeatAt: BEAT_AT, stopRequestedAt: STOP_AT, recoveryError: null });
const UNKNOWN = orphanDoc({ owner: 'unknown', heartbeatAt: null, stopRequestedAt: STOP_AT, recoveryError: null });
const GONE = orphanDoc({ owner: 'gone', heartbeatAt: BEAT_AT, stopRequestedAt: null, recoveryError: 'EBUSY: owner.json is locked' });
// a server from before the owner fields
const OLD = orphanDoc({});
const FREE = { ...BASE, recoveryRequired: false };

// requests: every request the panel sent; server.control is what GET .../control answers next.
// server.release(body) -> { status, body } or a promise of it. url: omitted = a server without projects.
function harness({ control, scoped = false, release } = {}) {
  const $ = installDom();
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const requests = [];
  const server = {
    control,
    release: release ?? (() => {
      server.control = FREE;
      return { status: 200, body: { ok: true, warnings: [] } };
    }),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    requests.push({ url, method: opts.method ?? 'GET', headers: opts.headers, body });
    if (/\/release$/.test(url)) {
      const r = await server.release(body);
      return { ok: r.status < 300, status: r.status, json: async () => r.body };
    }
    if (opts.method === 'POST') return { ok: true, status: 202, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => structuredClone(server.control) };
  };
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const scope = { chat: 'a' };
  const panel = createControlPanel({
    dashboard: stub, pipeline: stub, lanes: stub, models: { open: async () => {}, selection: () => ({ models: {} }), sync() {} },
    getState: () => createState(),
    ...(scoped ? { url: (suffix) => `/api/projects/core/chats/${scope.chat}/${suffix}` } : {}),
  });
  const switchTo = (chat) => {
    scope.chat = chat;
    panel.reset();
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const posts = () => requests.filter((r) => r.method === 'POST');
  const start = async () => {
    panel.setMode('live');
    await tick();
  };
  return { $, panel, server, requests, posts, switchTo, tick, start };
}

const shown = (el) => !el.hidden;

test('alive owner: Request stop only, with the stop request and last heartbeat times', async (t) => {
  const h = harness({ control: ALIVE });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  assert.equal(shown(h.$('recovery')), true);
  assert.equal(shown(h.$('recovery-stop')), true);
  assert.equal(h.$('recovery-stop').disabled, false);
  assert.equal(shown(h.$('recovery-release')), false, 'a live run is stopped, never released');
  assert.equal(h.$('recovery-times').textContent, `stop requested ${formatClock(STOP_AT)} · last seen running ${formatClock(BEAT_AT)}`);
  assert.equal(shown(h.$('recovery-times')), true);
  assert.equal(shown(h.$('recovery-error')), false);
  assert.match(h.$('recovery-detail').textContent, /still running in another Scranton process/);
});

test('unknown owner: Request stop and Release chat', async (t) => {
  const h = harness({ control: UNKNOWN });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  assert.equal(shown(h.$('recovery-stop')), true);
  assert.equal(shown(h.$('recovery-release')), true);
  assert.equal(h.$('recovery-release').disabled, false);
  assert.equal(h.$('recovery-release').textContent, 'Release chat');
  assert.equal(h.$('recovery-times').textContent, `stop requested ${formatClock(STOP_AT)}`, 'no heartbeat, no heartbeat time');
  assert.match(h.$('recovery-detail').textContent, /cannot tell whether its process is still running/);
  assert.match(h.$('recovery-detail').textContent, /app was closed or the computer restarted/);
});

test('gone owner with a recovery error: the error and Release chat, no stop request', async (t) => {
  const h = harness({ control: GONE });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  assert.equal(shown(h.$('recovery-stop')), false, 'a process that is gone reads no stop request');
  assert.equal(shown(h.$('recovery-release')), true);
  assert.equal(shown(h.$('recovery-error')), true);
  assert.equal(h.$('recovery-error').textContent, 'EBUSY: owner.json is locked');
  assert.equal(h.$('recovery-title').textContent, 'Chat could not be released');
  assert.equal(h.$('recovery-times').textContent, `last seen running ${formatClock(BEAT_AT)}`);
});

test('a server without the owner fields has no release route: Request stop only, with the earlier wording', async (t) => {
  const h = harness({ control: OLD });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  assert.equal(shown(h.$('recovery-stop')), true);
  assert.equal(h.$('recovery-stop').disabled, false);
  assert.equal(shown(h.$('recovery-release')), false, 'an old server cannot release');
  assert.equal(shown(h.$('recovery-times')), false, 'no times to show');
  assert.equal(shown(h.$('recovery-error')), false);
  assert.equal(h.$('recovery-title').textContent, 'Recovery required');
  assert.doesNotMatch(h.$('recovery-detail').textContent, /release/i);
  await h.$('recovery-release').fire('click');
  assert.equal(h.$('confirm-dialog').open, false, 'no release dialog');
  assert.deepEqual(h.posts(), []);
  await h.$('recovery-stop').fire('click');
  assert.doesNotMatch(h.$('confirm-detail').textContent, /release/i, 'the stop dialog does not point at a release');
});

test('unknown owner with unverified cleanup: the recovery error is shown, with stop and release', async (t) => {
  const error = 'Cleanup of this run could not be verified: Docker is not reachable; containers of this run could not be checked';
  const h = harness({ control: orphanDoc({ owner: 'unknown', heartbeatAt: BEAT_AT, stopRequestedAt: null, recoveryError: error }) });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  assert.equal(shown(h.$('recovery-error')), true);
  assert.equal(h.$('recovery-error').textContent, error);
  assert.equal(shown(h.$('recovery-stop')), true);
  assert.equal(shown(h.$('recovery-release')), true);
  assert.equal(h.$('recovery-release').disabled, false);
  h.server.control = UNKNOWN;
  await h.panel.refresh();
  assert.equal(shown(h.$('recovery-error')), false, 'cleared with the error');
  assert.equal(h.$('recovery-error').textContent, '');
});

test('the recovery text talks about the chat, not the hive, and names CONTROL.md only for an unidentified owner', async (t) => {
  for (const doc of [ALIVE, UNKNOWN, GONE, OLD]) {
    const h = harness({ control: doc });
    t.after(() => h.panel.setMode('demo'));
    await h.start();
    assert.doesNotMatch(h.$('recovery-detail').textContent, /hive|CONTROL\.md/i, doc.orphan.owner ?? 'old server');
  }
  const h = harness({ control: orphanDoc(undefined) });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  assert.equal(shown(h.$('recovery-stop')), false, 'no run id: nothing to stop');
  assert.equal(shown(h.$('recovery-release')), false, 'no run id: nothing to release');
  assert.match(h.$('recovery-detail').textContent, /CONTROL\.md/);
});

test('Release chat (no projects): confirm wording, then POST {runId} to /api/runs/release with the control headers', async (t) => {
  const h = harness({ control: UNKNOWN });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  assert.equal(h.$('confirm-dialog').open, true);
  assert.equal(h.$('confirm-ok').textContent, 'Release chat');
  const detail = h.$('confirm-detail').textContent;
  assert.match(detail, /cannot tell whether run 2dda5818 is still running/);
  assert.match(detail, /only when you are sure it has stopped, for example after the app was closed or the computer restarted/);
  assert.match(detail, /Releasing a run that is still running lets two runs share this chat/);
  assert.match(detail, /The run will be recorded as aborted/);
  assert.deepEqual(h.posts(), [], 'nothing is sent before the human confirms');

  const before = h.requests.length;
  await h.$('confirm-ok').fire('click');
  const [post] = h.posts();
  assert.equal(post.url, '/api/runs/release');
  assert.deepEqual(post.body, { runId: '2dda5818' });
  assert.deepEqual(post.headers, CONTROL_HEADERS);
  assert.equal(post.headers['X-Scranton-Client'], '1');
  assert.ok(h.requests.slice(before).some((r) => r.method === 'GET' && r.url === '/api/control'), 'refreshed after the release');
  assert.equal(h.$('confirm-dialog').open, false);
  assert.equal(shown(h.$('recovery')), false, 'the chat is free');
  assert.equal(h.$('control-announcer').textContent, 'Chat released');
  assert.equal(globalThis.document.activeElement, h.$('new-run'), 'focus moves to the next thing to do');
  assert.equal(shown(h.$('release-note')), false, 'no warnings, no note');
});

test('Release chat (registry): the chat-scoped release route', async (t) => {
  const h = harness({ control: GONE, scoped: true });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  assert.match(h.$('confirm-detail').textContent, /The process of run 2dda5818 has ended/);
  await h.$('confirm-ok').fire('click');
  assert.deepEqual(h.posts().map((p) => [p.url, p.body]), [['/api/projects/core/chats/a/release', { runId: '2dda5818' }]]);
  assert.deepEqual(h.posts()[0].headers, CONTROL_HEADERS);
  assert.equal(shown(h.$('recovery')), false);
});

test('release warnings are shown once, quietly, and go with the next run', async (t) => {
  const h = harness({
    control: UNKNOWN,
    release: () => {
      h.server.control = FREE;
      return { status: 200, body: { ok: true, warnings: ['Docker is not reachable; containers of this run could not be checked'] } };
    },
  });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  await h.$('confirm-ok').fire('click');
  const note = 'Chat released. Docker is not reachable; containers of this run could not be checked';
  assert.equal(shown(h.$('release-note')), true);
  assert.equal(h.$('release-note').textContent, note);
  assert.equal(h.$('control-announcer').textContent, note, 'said once, together with the release');
  assert.equal(h.$('release-note').attrs.get('role'), undefined, 'the note is not a second live region');
  h.server.control = { ...BASE, run: RUN };
  await h.panel.refresh();
  assert.equal(shown(h.$('release-note')), false);
});

test('a 409 shows the server error in the dialog and refreshes; the panel follows the new owner status', async (t) => {
  const h = harness({
    control: UNKNOWN,
    release: () => {
      h.server.control = ALIVE;
      return { status: 409, body: { error: 'The run is still running. Request a stop instead.' } };
    },
  });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  const before = h.requests.length;
  await h.$('confirm-ok').fire('click');
  await h.tick();
  assert.equal(h.$('confirm-dialog').open, true, 'the dialog stays with the error');
  assert.equal(h.$('confirm-error').hidden, false);
  assert.equal(h.$('confirm-error').textContent, 'The run is still running. Request a stop instead.');
  assert.ok(h.requests.slice(before).some((r) => r.method === 'GET' && r.url === '/api/control'), 'refreshed after the 409');
  assert.equal(shown(h.$('recovery-release')), false, 'now alive: stop only');
  assert.equal(shown(h.$('recovery-stop')), true);
  assert.notEqual(h.$('control-announcer').textContent, 'Chat released');
});

test('a 409 while a recovery is in progress is shown inline, never as the recovery error', async (t) => {
  const busy = 'Recovery is already in progress. Try again in a moment.';
  const h = harness({ control: GONE, release: () => ({ status: 409, body: { error: busy } }) });
  t.after(() => h.panel.setMode('demo'));
  h.server.control = { ...GONE, orphan: { ...GONE.orphan, recoveryError: null } };
  await h.start();
  await h.$('recovery-release').fire('click');
  await h.$('confirm-ok').fire('click');
  await h.tick();
  assert.equal(h.$('confirm-dialog').open, true);
  assert.equal(h.$('confirm-error').textContent, busy);
  assert.equal(shown(h.$('recovery-error')), false);
  assert.equal(h.$('recovery-release').disabled, false);
  assert.equal(h.$('recovery-release').textContent, 'Release chat');
});

test('a network error is shown inline and the button is usable again', async (t) => {
  const h = harness({ control: UNKNOWN });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (/\/release$/.test(url)) throw new TypeError('Failed to fetch');
    return real(url, opts);
  };
  await h.$('recovery-release').fire('click');
  await h.$('confirm-ok').fire('click');
  assert.equal(h.$('confirm-error').textContent, 'The server did not answer. Is it still running?');
  assert.equal(h.$('recovery-release').disabled, false);
  assert.equal(h.$('recovery-release').textContent, 'Release chat');
});

test('while the release is in flight both recovery buttons are disabled and a second click sends nothing', async (t) => {
  let answer;
  const h = harness({
    control: UNKNOWN,
    release: () => new Promise((resolve) => { answer = resolve; }),
  });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  const done = h.$('confirm-ok').fire('click');
  await h.tick();
  assert.equal(h.$('recovery-release').disabled, true);
  assert.equal(h.$('recovery-release').textContent, 'Releasing...');
  assert.equal(h.$('recovery-stop').disabled, true, 'no stop request while the chat is being released');
  h.$('confirm-dialog').close();
  await h.$('recovery-release').fire('click');
  assert.equal(h.$('confirm-dialog').open, false, 'no second dialog');
  assert.equal(h.posts().length, 1);
  h.server.control = FREE;
  answer({ status: 200, body: { ok: true, warnings: [] } });
  await done;
  assert.equal(shown(h.$('recovery')), false);
});

test('stale scope: a release confirmed after a chat switch posts nothing', async (t) => {
  const h = harness({ control: UNKNOWN, scoped: true });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  assert.equal(h.$('confirm-dialog').open, true);
  h.switchTo('b');
  await h.tick();
  assert.equal(h.$('confirm-dialog').open, false, 'the switch closes the question about chat a');
  await h.$('confirm-ok').fire('click');
  assert.deepEqual(h.posts(), []);
});

test('stale scope: an answer for chat a that lands after a switch does not touch chat b', async (t) => {
  let answer;
  const h = harness({ control: UNKNOWN, scoped: true, release: () => new Promise((resolve) => { answer = resolve; }) });
  t.after(() => h.panel.setMode('demo'));
  await h.start();
  await h.$('recovery-release').fire('click');
  const done = h.$('confirm-ok').fire('click');
  await h.tick();
  assert.equal(h.posts()[0].url, '/api/projects/core/chats/a/release');
  h.switchTo('b');
  await h.tick();
  // chat b is held by the same kind of orphan: its button is its own, not busy with chat a's request
  assert.equal(h.$('recovery-release').disabled, false);
  globalThis.document.activeElement = h.$('recovery-check');
  answer({ status: 200, body: { ok: true, warnings: ['late warning for chat a'] } });
  await done;
  await h.tick();
  assert.notEqual(h.$('control-announcer').textContent, 'Chat released');
  assert.equal(shown(h.$('release-note')), false);
  assert.equal(globalThis.document.activeElement, h.$('recovery-check'), 'focus stays where the human is');
  assert.equal(h.posts().length, 1);
});

test('read-only and no-control views offer no release; an active run keeps its Stop run', async (t) => {
  const ro = harness({ control: UNKNOWN });
  t.after(() => ro.panel.setMode('demo'));
  await ro.start();
  ro.panel.setReadOnly(true);
  assert.equal(shown(ro.$('recovery')), false);
  await ro.$('recovery-release').fire('click');
  assert.equal(ro.$('confirm-dialog').open, false);

  const off = harness({ control: { ...UNKNOWN, enabled: false } });
  t.after(() => off.panel.setMode('demo'));
  await off.start();
  assert.equal(shown(off.$('recovery')), false);
  await off.$('recovery-release').fire('click');
  assert.equal(off.$('confirm-dialog').open, false);
  assert.deepEqual(off.posts(), []);

  const live = harness({ control: { ...BASE, run: RUN, recoveryRequired: true, orphan: UNKNOWN.orphan } });
  t.after(() => live.panel.setMode('demo'));
  await live.start();
  assert.equal(shown(live.$('recovery')), false, 'a live run of this server is never an orphan');
  assert.equal(live.$('stop-run').hidden, false);
  assert.equal(live.$('stop-run').textContent, 'Stop run');
});
