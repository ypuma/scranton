// New run where no chat is on screen. A run belongs to a chat, so the drawer of "the chat on screen" has no route
// to post to there: asked for anyway it used to open, and Start run then sent POST /null (HTTP 405). The drawer
// now hands over to the page, which starts a chat for the run, and nothing is ever posted to a missing route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, CONTROL } from './fixtures/run-drawer.js';
import { installPage } from './fixtures/page-dom.js';

// taken before the page is installed, whose own timers do not hold the process
const wait = setTimeout;
const tick = (ms = 20) => new Promise((r) => wait(r, ms));

// a panel as the page builds it for a project without a chat: only the control document has a route
async function chatless(onNewRun) {
  const h = harness();
  h.panel.setMode('demo');
  const { createControlPanel } = await import('../../visualizer/public/js/control-panel.js');
  const { createState } = await import('../../visualizer/public/js/state.js');
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({
    dashboard: stub, pipeline: stub, lanes: stub, models: h.models, getState: () => createState(),
    url: (suffix) => (suffix === 'control' ? '/api/control' : null), onNewRun,
  });
  panel.setMode('live');
  await h.tick();
  return { ...h, panel };
}

test('the drawer of the chat on screen never opens without a chat: the page is asked to start one', async (t) => {
  let asked = 0;
  const h = await chatless(() => { asked += 1; return true; });
  t.after(() => h.panel.setMode('demo'));
  h.panel.openRun({ request: 'Build it' });
  await h.tick();
  assert.equal(h.$('run-dialog').open, false, 'no drawer that has nowhere to post');
  assert.equal(asked, 1);
  // even a form submitted without its drawer posts nothing
  h.$('f-request').value = 'Build it';
  await h.$('run-form').fire('submit');
  await h.tick();
  assert.deepEqual(h.posts, []);
  assert.deepEqual(await h.panel.startFollowUp('And the tests'), { error: 'A run cannot be started here right now.' });
  assert.deepEqual(h.posts, [], 'a follow-up has no route either');
});

test('a page that cannot start a chat says why instead of opening the drawer', async (t) => {
  const h = await chatless(() => false);
  t.after(() => h.panel.setMode('demo'));
  h.panel.openRun();
  assert.equal(h.$('run-dialog').open, false);
  assert.equal(h.$('control-announcer').textContent, 'Open a chat or start a new one first: a run belongs to a chat.');
  assert.deepEqual(h.posts, []);
});

test('with a chat on screen the drawer opens and posts to that chat as before', async (t) => {
  const h = harness();
  t.after(() => h.panel.setMode('demo'));
  await h.open();
  assert.equal(h.$('run-dialog').open, true);
  await h.$('run-form').fire('submit');
  await h.tick();
  assert.deepEqual(h.posts.map((p) => p.url), ['/api/projects/core/chats/a/runs']);
});

// The page itself, loaded on an empty registry: the project is made elsewhere and reaches the page through its
// projects poll. New run in the top bar then starts a chat in it. One page per process: main.js runs on import.
test('the page: a project that appears on the poll gets its first chat from New run in the top bar', async () => {
  const requests = [];
  let projects = [];
  const control = { ...CONTROL, workspace: undefined, defaults: {}, running: 0, chats: [] };
  const { $ } = installPage({
    search: '',
    fetch: async (url, opts = {}) => {
      requests.push(`${opts.method ?? 'GET'} ${url}`);
      if (opts.method === 'POST') {
        if (url === '/api/projects/core/chats') return { ok: true, status: 201, json: async () => ({ chat: { id: 'c1' } }) };
        if (url === '/api/projects/core/chats/c1/runs') return { ok: true, status: 202, json: async () => ({ pid: 9 }) };
        return { ok: false, status: 405, json: async () => null };
      }
      if (url === '/api/projects') return { ok: true, status: 200, json: async () => ({ mode: 'registry', maxConcurrentRuns: 4, running: 0, projects: structuredClone(projects) }) };
      if (String(url).endsWith('/control')) return { ok: true, status: 200, json: async () => structuredClone(control) };
      return { ok: false, status: 404, json: async () => null };
    },
  });
  // the projects poll, when the test says so; every other timer runs as it is
  const polls = [];
  const pageTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => (ms === 3000 ? polls.push(fn) : pageTimeout(fn, ms, ...rest));
  try {
    await import('../../visualizer/public/js/main.js');
    await tick(100);
    assert.equal(globalThis.scranton.scope, null);
    assert.equal($('thread-empty-title').textContent, 'No project yet.');

    projects = [{ id: 'core', name: 'Core', workspace: 'C:\\work\\core', chats: [] }];
    for (const poll of polls.splice(0)) poll();
    await tick(100);
    assert.deepEqual(globalThis.scranton.scope, { project: 'core', chat: null });
    assert.equal(location.hash, '#/p/core');
    assert.equal($('thread-empty-title').textContent, 'No chat in Core yet.');
    assert.equal($('run-actions').hidden, false, 'the top bar offers New run');

    await $('new-run').dispatch('click');
    await tick();
    assert.equal($('run-dialog').open, true);
    assert.equal($('run-dialog-title').textContent, 'New chat in Core', 'the drawer starts a chat, it is not the drawer of a chat that does not exist');
    $('f-request').value = 'Build it';
    await $('run-form').dispatch('submit');
    await tick(100);
    const posts = requests.filter((r) => r.startsWith('POST'));
    assert.deepEqual(posts, ['POST /api/projects/core/chats', 'POST /api/projects/core/chats/c1/runs']);
    assert.equal($('run-error').textContent, '');
    assert.equal($('run-dialog').open, false);
    assert.equal(requests.some((r) => /null|undefined/.test(r)), false, 'no request without a route');
  } finally {
    globalThis.setTimeout = pageTimeout;
  }
});
