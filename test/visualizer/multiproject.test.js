// Projects and chat threads in the web dashboard (.enma/multiproject-contract.md): hash routing, scoped URLs,
// the sidebar model, replay of archived runs, the follow-up gate, request bodies and the fetch-based SSE feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseHash, hashFor, scopedUrl, runEventsUrl, createScope, parseProjects, pickScope, scopeGone, sidebarModel, capacityText,
  parseRuns, runChoices, replayRun, replayError, composerGate, buildFollowUp, buildProject, buildRename, buildRemove,
  titleFromGoal, projectError, projectErrorField, runStartError,
} from '../../visualizer/public/js/scope.js';
import { sseMessages, startFeed, retryDelay } from '../../visualizer/public/js/feed.js';
import { parseControl, CLIENT_HEADERS } from '../../visualizer/public/js/control.js';
import { parseJsonl, reduceAll } from '../../visualizer/public/js/state.js';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const SAMPLE = parseJsonl(readFileSync(path.join(PUBLIC, 'demo', 'sample-events.jsonl'), 'utf8'));

function doc(fields = {}) {
  return parseProjects({
    mode: 'registry', maxConcurrentRuns: 4, running: 2,
    projects: [
      { id: 'core', name: 'Core', workspace: 'C:\\work\\core', chats: [
        { id: 'a', title: 'Alpha', status: 'running', updatedAt: '2026-11-08T10:00:00Z', runs: 1 },
        { id: 'b', title: 'Beta', status: 'needs_human', updatedAt: '2026-11-08T11:00:00Z', runs: 2 },
        { id: 'c', title: 'Gamma', status: 'done', updatedAt: '2026-11-08T09:00:00Z', runs: 3 },
      ] },
      { id: 'web', name: 'Web', workspace: 'C:\\work\\web', chats: [
        { id: 'x', title: 'Ex', status: 'failed', updatedAt: '2026-11-08T12:00:00Z', runs: 1 },
      ] },
      { id: 'blank', name: 'Blank', workspace: 'C:\\work\\blank', chats: [] },
    ],
    ...fields,
  });
}

test('parseHash reads #/p/<project>/c/<chat> and #/p/<project>, nothing else', () => {
  assert.deepEqual(parseHash('#/p/core/c/a'), { project: 'core', chat: 'a' });
  assert.deepEqual(parseHash('#/p/core/c/a/'), { project: 'core', chat: 'a' });
  assert.deepEqual(parseHash('#/p/core'), { project: 'core', chat: null });
  assert.deepEqual(parseHash('/p/my-app/c/c-mw86zind'), { project: 'my-app', chat: 'c-mw86zind' });
  assert.deepEqual(parseHash('#/p/core/c/run%2E1'), { project: 'core', chat: 'run.1' });
  for (const bad of ['', '#', '#/', '#/p/', '#/p/Core/c/a', '#/p/-x/c/a', '#/p/core/c/..', '#/p/core/c/%2E%2E', '#/p/core/c/a%2Fb',
    '#/p/core/c/a/extra', '#/p/core/x/a', '#/p/core/c/%E0%A4%A', '#/p/core/c/', null, 42]) {
    assert.equal(parseHash(bad), null, String(bad));
  }
  assert.equal(parseHash(`#/p/${'a'.repeat(41)}`), null, 'project ids have at most 40 characters');
});

test('hashFor round-trips through parseHash', () => {
  for (const s of [{ project: 'core', chat: 'a' }, { project: 'web', chat: null }, { project: 'core', chat: 'c_1.v2' }]) {
    assert.deepEqual(parseHash(hashFor(s)), s);
  }
  assert.equal(hashFor(null), '');
});

test('every chat route goes to /api/projects/:p/chats/:c/<suffix>; no scope = the routes of today', () => {
  const s = { project: 'core', chat: 'a' };
  for (const suffix of ['events', 'state', 'runs', 'chat', 'hitl', 'stop', 'control']) {
    assert.equal(scopedUrl(s, suffix), `/api/projects/core/chats/a/${suffix}`);
  }
  assert.equal(scopedUrl({ project: 'core', chat: 'a b' }, 'runs'), '/api/projects/core/chats/a%20b/runs');
  assert.deepEqual(['events', 'state', 'runs', 'chat', 'hitl', 'stop', 'control'].map((x) => scopedUrl(null, x)),
    ['/events', '/api/state', '/api/runs', '/api/chat', '/api/hitl', '/api/runs/stop', '/api/control']);
  assert.equal(scopedUrl({ project: 'core', chat: null }, 'control'), null, 'a project without a chat has no chat routes');
  assert.equal(runEventsUrl(s, 'run-1'), '/api/projects/core/chats/a/runs/run-1/events');
  assert.equal(runEventsUrl(s, 'run-1#2'), '/api/projects/core/chats/a/runs/run-1%232/events');
  assert.equal(runEventsUrl(s, '../x'), null);
  assert.equal(runEventsUrl(null, 'run-1'), null, 'a single hive without projects has no run history route');
});

test('createScope bumps gen on every change, so answers for an earlier chat are dropped', () => {
  const scope = createScope(null);
  assert.equal(scope.url('events'), '/events');
  assert.equal(scope.set({ project: 'core', chat: 'a' }), true);
  const gen = scope.gen();
  assert.equal(scope.url('stop'), '/api/projects/core/chats/a/stop');
  assert.equal(scope.set({ project: 'core', chat: 'a' }), false, 'the same chat is no change');
  assert.equal(scope.gen(), gen);
  assert.equal(scope.set({ project: 'core', chat: 'b' }), true);
  assert.equal(scope.gen(), gen + 1);
  assert.deepEqual(scope.get(), { project: 'core', chat: 'b' });
});

test('parseProjects keeps valid projects and chats only; unknown statuses read as idle', () => {
  assert.equal(parseProjects(null), null);
  assert.equal(parseProjects({ projects: [] }), null, 'mode is required');
  const d = parseProjects({
    mode: 'single', running: -1, maxConcurrentRuns: 0,
    projects: [
      { id: 'ok', name: '\u202Eevil', chats: [{ id: 'c1', title: '', status: 'exploded' }, { id: '../x' }, { id: 'c1', title: 'dupe' }] },
      { id: 'BAD' }, { id: 'ok', name: 'dupe' }, null,
    ],
  });
  assert.equal(d.mode, 'single');
  assert.equal(d.running, 0);
  assert.equal(d.maxConcurrentRuns, null);
  assert.equal(d.projects.length, 1);
  assert.equal(d.projects[0].name, 'evil', 'bidi controls are stripped');
  assert.deepEqual(d.projects[0].chats, [{ id: 'c1', title: 'Untitled chat', status: 'idle', updatedAt: null, runs: 0 }]);
});

test('pickScope: the asked chat, else the project\'s latest chat, else the latest chat anywhere', () => {
  const d = doc();
  assert.deepEqual(pickScope(d, { project: 'core', chat: 'c' }), { project: 'core', chat: 'c' });
  assert.deepEqual(pickScope(d, { project: 'core', chat: 'gone' }), { project: 'core', chat: 'b' });
  assert.deepEqual(pickScope(d, { project: 'core', chat: null }), { project: 'core', chat: 'b' });
  assert.deepEqual(pickScope(d, { project: 'blank', chat: null }), { project: 'blank', chat: null });
  assert.deepEqual(pickScope(d, { project: 'nope', chat: 'a' }), { project: 'web', chat: 'x' });
  assert.deepEqual(pickScope(d, null), { project: 'web', chat: 'x' });
  assert.equal(pickScope(parseProjects({ mode: 'registry', projects: [] }), null), null);
  assert.deepEqual(pickScope(parseProjects({ mode: 'registry', projects: [{ id: 'p', chats: [] }] }), null), { project: 'p', chat: null });
});

test('scopeGone: only a removed chat or project moves the page, not a chat appearing in the project on screen', () => {
  const d = doc();
  assert.equal(scopeGone(d, { project: 'core', chat: 'a' }), false);
  // regression: "+ New chat" creates the chat before its run starts; the next poll must not jump into it
  assert.equal(scopeGone(d, { project: 'core', chat: null }), false);
  assert.equal(scopeGone(d, { project: 'core', chat: 'removed' }), true);
  assert.equal(scopeGone(d, { project: 'removed', chat: null }), true);
  assert.equal(scopeGone(d, null), true, 'nothing on screen while projects exist');
  assert.equal(scopeGone(parseProjects({ mode: 'registry', projects: [] }), null), false);
});

test('sidebarModel: badges for background chats needing a human, remove blocked while a run lives', () => {
  const m = sidebarModel(doc(), { project: 'core', chat: 'a' }, { collapsed: new Set(['web']) });
  const core = m.projects[0];
  const byId = Object.fromEntries(core.chats.map((c) => [c.id, c]));
  assert.equal(byId.a.current, true);
  assert.equal(byId.b.attention, true, 'b waits for a human in the background');
  assert.equal(byId.b.label, 'needs you');
  assert.equal(byId.b.glyph, '■');
  assert.equal(core.waiting, 1);
  assert.equal(core.running, 2, 'a waiting chat still has a live run');
  assert.equal(m.attention, 1);
  assert.equal(byId.a.removeBlock, 'Stop the run first.');
  assert.equal(byId.b.removeBlock, 'Stop the run first.');
  assert.equal(byId.c.removeBlock, '');
  assert.equal(core.removeBlock, 'Stop the run first.');
  assert.equal(m.projects[1].removeBlock, '');
  assert.equal(m.projects[1].expanded, false);
  assert.equal(core.expanded, true);
  assert.equal(m.canCreate, true);

  const onB = sidebarModel(doc(), { project: 'core', chat: 'b' });
  assert.equal(onB.attention, 0, 'the chat on screen shows its own answer panel');
  assert.equal(onB.projects[0].chats.find((c) => c.id === 'b').attention, false);

  const single = sidebarModel(doc({ mode: 'single' }), null);
  assert.equal(single.single, true);
  assert.equal(single.canCreate, false);
  assert.equal(single.projects[0].chats.find((c) => c.id === 'c').removeBlock, 'This server serves a single project.');
  assert.equal(capacityText(doc()), '2 running · up to 4 in parallel');
});

test('runChoices: the live run first, earlier runs newest first', () => {
  const runs = parseRuns({ runs: [
    { runId: 'r1', goal: 'First', status: 'failed', startedAt: '2026-11-07T10:00:00Z', current: false },
    { runId: 'r2', goal: 'Second', status: 'aborted', startedAt: '2026-11-07T14:00:00Z' },
    { runId: 'r3', goal: 'Third', status: 'success', current: true },
    { runId: 'r3', goal: 'dupe' }, { runId: '../x' }, null,
  ] });
  assert.deepEqual(runs.map((r) => [r.runId, r.current]), [['r1', false], ['r2', false], ['r3', true]]);
  const c = runChoices(runs);
  assert.deepEqual(c.map((x) => x.value), ['live', 'r2', 'r1']);
  assert.match(c[0].text, /^Current · run 3 · Third$/);
  assert.match(c[1].text, /^Run 2 · Second · aborted · 2026-11-07 \d\d:\d\d$/);
  assert.match(c[2].text, /^Run 1 · First · failed/);
  assert.deepEqual(runChoices([]).map((x) => x.value), ['live']);
  assert.equal(parseRuns({}), null);
});

test('replayRun replays an archived run through the reducer, read only and apart from the live state', () => {
  const runId = SAMPLE[0].runId;
  const live = reduceAll(SAMPLE.slice(0, 20));
  const other = { ...SAMPLE[5], runId: 'someone-else', seq: 999 };
  const r = replayRun({ events: [...SAMPLE, other, null, 'x'] }, runId);
  assert.equal(r.events, SAMPLE.length, 'events of another run are dropped');
  assert.equal(r.state.runId, runId);
  assert.equal(r.state.result, 'success');
  assert.equal(r.state.milestones.length, 3);
  assert.equal(live.result, null, 'the live state is untouched');
  assert.equal(replayRun({ runs: [] }, runId), null);
  assert.match(replayError(413), /larger than 20 MiB/);
  assert.match(replayError(0), /did not answer/);
});

test('composerGate: Follow up is hidden in replay, disabled while the chat runs, Start run for an empty chat', () => {
  const base = { scoped: true, enabled: true, mode: 'live', replaying: false, chatStatus: 'done', runs: 2 };
  assert.deepEqual(composerGate(base), { hidden: false, disabled: false, reason: '', label: 'Follow up' });
  assert.equal(composerGate({ ...base, replaying: true }).hidden, true);
  assert.equal(composerGate({ ...base, mode: 'demo' }).hidden, true);
  assert.equal(composerGate({ ...base, enabled: false }).hidden, true);
  assert.equal(composerGate({ ...base, scoped: false }).hidden, true, 'a single hive without threads has no follow-up');
  for (const running of [{ chatStatus: 'running' }, { chatStatus: 'needs_human' }, { alive: true }]) {
    const g = composerGate({ ...base, ...running });
    assert.equal(g.hidden, false);
    assert.equal(g.disabled, true);
    assert.match(g.reason, /Messages/);
  }
  assert.equal(composerGate({ ...base, recovery: true }).disabled, true);
  assert.equal(composerGate({ ...base, submitting: true }).disabled, true);
  assert.equal(composerGate({ ...base, runs: 0, chatStatus: 'idle' }).label, 'Start run');
});

test('buildFollowUp: the goal with the drawer\'s execution and models, never a workspace', () => {
  const control = parseControl({ v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'] });
  const models = { michael: { provider: 'anthropic', model: 'claude-sonnet-4-5' } };
  assert.deepEqual(buildFollowUp({ goal: '  Fix the typos  ', models, execution: { maxParallel: '2', sandbox: 'host', trustedHost: true } }, control).body,
    { request: 'Fix the typos', maxParallel: 2, sandbox: 'host', trustedHost: true, models, conversation: true });
  assert.deepEqual(buildFollowUp({ goal: 'Go', execution: { sandbox: 'docker', sandboxNetwork: 'none' } }, control).body,
    { request: 'Go', sandbox: 'docker', sandboxNetwork: 'none', conversation: true });
  assert.deepEqual(buildFollowUp({ goal: 'Go', execution: { sandbox: 'host', trustedHost: false } }, control).field, 'trustedHost');
  assert.equal(buildFollowUp({ goal: '   ' }, control).field, 'request');
  assert.equal(buildFollowUp({ goal: 'x'.repeat(4001) }, control).field, 'request');
});

test('project and chat request bodies', () => {
  assert.deepEqual(buildProject({ name: ' Api ', workspace: '' }).body, { name: 'Api' });
  assert.deepEqual(buildProject({ name: 'Api', workspace: ' C:\\code\\api ', create: true }).body, { name: 'Api', workspace: 'C:\\code\\api', create: true });
  assert.deepEqual(buildProject({ name: 'Api', workspace: 'C:\\code\\api', create: false }).body, { name: 'Api', workspace: 'C:\\code\\api' });
  assert.deepEqual(buildProject({ name: 'Api', workspace: '', create: true }).body, { name: 'Api' }, 'create only goes with a folder');
  assert.equal(buildProject({ name: 'Api', workspace: 'code\\api' }).field, 'workspace');
  assert.equal(buildProject({ name: '  ' }).field, 'name');
  assert.equal(buildProject({ name: 'x'.repeat(81) }).field, 'name');
  assert.deepEqual(buildRename('project', { id: 'core', value: ' Core 2 ' }).body, { id: 'core', name: 'Core 2' });
  assert.deepEqual(buildRename('chat', { id: 'a', value: 'New title' }).body, { id: 'a', title: 'New title' });
  assert.match(buildRename('chat', { id: 'a', value: ' ' }).error, /title/);
  assert.deepEqual(buildRemove('project', { id: 'core', deleteHistory: true }).body, { id: 'core', deleteHistory: true });
  assert.deepEqual(buildRemove('project', { id: 'core' }).body, { id: 'core' });
  assert.deepEqual(buildRemove('chat', { id: 'a', deleteHistory: true }).body, { id: 'a' }, 'a chat has no history option');
  assert.equal(titleFromGoal('  Build   a\ntodo app  '), 'Build a todo app');
  assert.equal(titleFromGoal('x'.repeat(80)).length, 60);
});

test('error texts: 429 names the parallel limit, 409 the busy chat, bare codes are never shown', () => {
  assert.equal(runStartError(429, { error: 'too_many_runs' }, { running: 4, maxConcurrentRuns: 4 }),
    'Too many runs in parallel (4 of 4 running). Wait until one finishes or stop one, then start this one again.');
  assert.match(runStartError(429, null, null), /^Too many runs in parallel\. /);
  assert.equal(runStartError(409, { error: 'This chat already has a run in progress' }), 'This chat already has a run in progress');
  assert.equal(runStartError(409, { error: 'conflict' }), 'This chat already has a run in progress.');
  assert.equal(runStartError(400, { error: 'request is required' }), 'request is required');
  assert.match(projectError(409, { error: 'single_mode' }), /single project/);
  assert.equal(projectError(400, { error: 'workspace must not be a drive root' }), 'workspace must not be a drive root');
  assert.equal(projectError(500, null), 'Request failed (HTTP 500).');
  assert.equal(projectErrorField('workspace is already used by another project'), 'workspace');
  assert.equal(projectErrorField('The folder does not exist'), 'workspace');
  assert.equal(projectErrorField('name is required'), 'name');
  assert.equal(projectErrorField('boom'), null);
});

test('sseMessages splits complete messages and keeps the unfinished rest', () => {
  assert.deepEqual(sseMessages('retry: 2000\n\nid: 1\ndata: {"a":1}\n\n: ping\n\ndata: {"b"'), { messages: ['{"a":1}'], rest: 'data: {"b"' });
  assert.deepEqual(sseMessages('data: one\r\ndata: two\r\n\r\n'), { messages: ['one\ntwo'], rest: '' });
  assert.deepEqual(sseMessages('data:x\n\n'), { messages: ['x'], rest: '' });
  assert.deepEqual(sseMessages(''), { messages: [], rest: '' });
});

test('startFeed with headers reads a scoped stream with fetch, sends the client header and goes quiet on stop', async () => {
  const seen = [];
  let res = null;
  const server = http.createServer((req, r) => {
    seen.push([req.url, req.headers['x-scranton-client']]);
    r.writeHead(200, { 'Content-Type': 'text/event-stream' });
    r.write('retry: 2000\n\n');
    r.write(`data: ${JSON.stringify(SAMPLE[0])}\n\ndata: ${JSON.stringify(SAMPLE[1]).slice(0, 20)}`);
    r.write(`${JSON.stringify(SAMPLE[1]).slice(20)}\n\n`);
    res = r;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/projects/core/chats/a/events`;
  const events = [];
  const modes = [];
  const feed = startFeed({ mode: 'live', url, headers: CLIENT_HEADERS, onEvent: (e) => events.push(e.seq), onMode: (m) => modes.push(m) });
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 20));
  };
  await until(() => events.length >= 2);
  assert.deepEqual(events, [1, 2], 'a message split across chunks arrives once, whole');
  assert.deepEqual(seen, [['/api/projects/core/chats/a/events', '1']]);
  assert.deepEqual(modes, ['connecting', 'live']);
  feed.stop();
  res.write(`data: ${JSON.stringify(SAMPLE[2])}\n\n`);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(events, [1, 2], 'nothing reaches the page after stop');
  assert.deepEqual(modes, ['connecting', 'live'], 'a stopped feed does not report reconnecting');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('a scoped stream backs off exponentially up to a cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(retryDelay), [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
});

test('a scoped stream that answers 403 or 404 stops retrying and says why', async () => {
  for (const code of [404, 403]) {
    let hits = 0;
    const server = http.createServer((req, r) => {
      hits += 1;
      r.writeHead(code, { 'Content-Type': 'application/json' });
      r.end('{"error":"nope"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const modes = [];
    const feed = startFeed({ mode: 'live', url: `http://127.0.0.1:${server.address().port}/api/projects/core/chats/gone/events`, headers: CLIENT_HEADERS,
      onEvent() {}, onMode: (m, info) => modes.push([m, info?.status ?? null]) });
    await new Promise((r) => setTimeout(r, 200));
    feed.stop();
    assert.deepEqual(modes, [['connecting', null], ['unavailable', code]]);
    assert.equal(hits, 1, 'no retry');
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a scoped stream whose server never answers is aborted after the connect timeout and retried later', async () => {
  const held = [];
  const server = http.createServer((req, r) => held.push(r));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const modes = [];
  const feed = startFeed({ mode: 'live', url: `http://127.0.0.1:${server.address().port}/x`, headers: CLIENT_HEADERS, connectTimeoutMs: 80,
    onEvent() {}, onMode: (m, info) => modes.push([m, info?.reason ?? null]) });
  await new Promise((r) => setTimeout(r, 300));
  feed.stop();
  assert.deepEqual(modes, [['connecting', null], ['reconnecting', 'No answer - retrying in 3 s']]);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('the sidebar, chat header and dialogs keep their labels and bounds', () => {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<nav class="sidebar" id="sidebar" aria-labelledby="nav-title" hidden>/, 'the sidebar waits for /api/projects');
  assert.match(html, /<button type="button" class="icon-btn nav-toggle" id="nav-toggle" aria-controls="sidebar" aria-expanded="false" hidden>/);
  assert.match(html, /<textarea id="followup-text"[^>]*maxlength="4000"/);
  assert.match(html, /<label class="field-label" for="run-picker">Run<\/label>/);
  assert.match(html, /id="replay-banner" role="status" hidden/);
  assert.match(html, /<input id="p-folder"[^>]*maxlength="1024"/);
  assert.match(html, /id="rm-history-row" hidden/, 'the history option only appears for a project');
  for (const id of ['project-dialog', 'rename-dialog', 'remove-dialog']) assert.match(html, new RegExp(`<dialog class="confirm" id="${id}" aria-labelledby=`));
});

test('chat-specific requests go through the scope, never a hard-coded unscoped route', () => {
  for (const f of ['control-panel.js', 'chat-panel.js', 'thread.js', 'main.js', 'nav.js']) {
    const js = readFileSync(path.join(PUBLIC, 'js', f), 'utf8');
    assert.doesNotMatch(js, /['"`]\/(events|api\/(state|runs|chat|hitl|runs\/stop))['"`]/, f);
  }
  const panel = readFileSync(path.join(PUBLIC, 'js', 'control-panel.js'), 'utf8');
  assert.match(panel, /fetch\(where, \{ cache: 'no-store', headers: CLIENT_HEADERS \}\)/, 'the scoped control GET sends the client header');
});
