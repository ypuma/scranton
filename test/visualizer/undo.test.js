// "Undo these changes" under the outcome of a finished Team run: when the rail offers it, the confirmation in the
// shared confirm dialog, the POST body, the result with and without conflicts, the explicit force path, the errors,
// and the reads after an undo. The server is a stub that follows the restore-points contract; nothing here starts a
// run. Also the New project dialog's default folder from GET /api/projects projectsRoot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installTree } from './fixtures/tree-dom.js';
import { installDom } from './fixtures/fake-dom.js';
import { fakeStorage } from './fixtures/run-drawer.js';
import { createControlPanel } from '../../visualizer/public/js/control-panel.js';
import { createRunRail } from '../../visualizer/public/js/run-rail.js';
import { createUndo } from '../../visualizer/public/js/undo-panel.js';
import { createSidePanel } from '../../visualizer/public/js/side-panel.js';
import { createNav, folderHint } from '../../visualizer/public/js/nav.js';
import { teamRunView } from '../../visualizer/public/js/activity-model.js';
import { reduceAll, createState } from '../../visualizer/public/js/state.js';
import { parseProjects } from '../../visualizer/public/js/scope.js';
import { CLIENT_HEADERS, CONTROL_HEADERS } from '../../visualizer/public/js/control.js';
import { formatWhen } from '../../visualizer/public/js/format.js';
import {
  undoUrl, parseRestorePoints, parseUndo, buildUndo, undoState, undoResult, undoError, changesNote, ACTIVE_TEXT,
} from '../../visualizer/public/js/undo.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const FOLDER = 'C:\\ws\\todo';
const POINT = { runId: 'r1', createdAt: '2026-11-21T10:00:00.000Z', files: 3, undoneAt: null, remaining: 3 };
const UNDONE_AT = new Date().toISOString();
const DONE = { runId: 'r1', restored: ['README.md', 'src/a b.js'], removed: ['todo.js'], conflicts: [] };
const CONFLICTED = { runId: 'r1', restored: ['README.md'], removed: [], conflicts: [{ path: 'todo.js', reason: 'changed after the run', code: 'changed' }, { path: 'notes.md', reason: 'deleted after the run', code: 'changed' }] };
const OLDER = 'Undo works backwards: undo the later runs of this chat first.';
const tick = () => new Promise((r) => setTimeout(r, 10));

// a finished team run that wrote `writes` (and then read `reads`) in FOLDER
function railRun({ live = false, runId = 'r1', writes = ['todo.js', 'README.md'], reads = [] } = {}) {
  let seq = 0;
  const ev = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 21, 10, 0, seq)).toISOString(), runId, type, ...fields });
  const tool = (name, file) => ev('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: name, detail: file, targetFile: file });
  const events = [
    ev('run_started', { request: 'Build it', workspace: FOLDER }),
    ev('plan_ready', { milestones: [{ id: 'm1', title: 'Storage' }] }),
    ev('milestone_started', { milestoneId: 'm1', title: 'Storage', index: 0, total: 1 }),
    ev('instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    ...writes.map((f, i) => tool(i % 2 ? 'edit' : 'write', f)),
    ...reads.map((f) => tool('read', f)),
    ev('milestone_finished', { milestoneId: 'm1', status: 'passed' }),
    ...(live ? [] : [ev('run_finished', { status: 'success', summary: 'All 1 milestones passed' })]),
  ];
  return teamRunView({ state: reduceAll(events) });
}

// server.points: what GET restore-points lists; server.get() / server.undo(body) -> { status, body } | { network: true }.
// engine: the chat's engine in the projects document; state.active: the control document says a run is going
// ('recovery': the chat needs recovery).
async function harness({ points = [POINT], engine = null, undo, get, view = railRun() } = {}) {
  const $ = installTree();
  globalThis.localStorage = fakeStorage();
  const requests = [];
  const server = {
    points,
    get: get ?? (() => ({ status: 200, body: { points: server.points } })),
    undo: undo ?? (() => {
      server.points = server.points.map((p) => ({ ...p, undoneAt: UNDONE_AT, remaining: 0 }));
      return { status: 200, body: DONE };
    }),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    requests.push({ url, method: opts.method ?? 'GET', headers: opts.headers, body });
    const r = url.endsWith('/restore-points') ? await server.get(url) : url.endsWith('/undo') ? await server.undo(body, url) : { status: 404, body: null };
    if (r.network) throw new TypeError('fetch failed');
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  const chats = [{ id: 'a', title: 'A', status: 'done', runs: 1, ...(engine ? { engine } : {}) }, { id: 'b', title: 'B', status: 'done', runs: 1 }];
  const nav = parseProjects({ mode: 'registry', projects: [{ id: 'core', name: 'Core', workspace: FOLDER, chats }] });
  const stub = { setHumanWhere() {}, setRunMode() {} };
  const panel = createControlPanel({ dashboard: stub, pipeline: stub, lanes: stub, models: null, getState: () => createState(), url: (s) => `/api/projects/core/chats/a/${s}` });
  const state = { active: false, undone: 0, view };
  let rail = null;
  const undoPanel = createUndo({
    getProjects: () => nav, confirm: panel.confirm, active: () => state.active,
    announce: (text) => { $('control-announcer').textContent = text; },
    onChange: () => rail?.render(state.view),
    onUndone: () => { state.undone += 1; },
  });
  rail = createRunRail({
    viewMode: () => 'chat', openBoard() {}, media: { matches: true, addEventListener() {} }, openChanges() {}, undo: undoPanel,
    folder: () => (engine === 'pipeline' ? null : FOLDER),
  });
  await undoPanel.setScope({ project: 'core', chat: 'a' });
  rail.render(state.view);
  const draw = (patch = {}) => {
    Object.assign(state, patch);
    rail.render(state.view);
  };
  const gets = () => requests.filter((r) => r.method === 'GET' && r.url.endsWith('/restore-points'));
  const posts = () => requests.filter((r) => r.method === 'POST');
  return { $, server, requests, gets, posts, state, draw, undo: undoPanel, rail, nav, panel };
}

const shown = (node) => !node.hidden;
// what the outcome's undo block says, in reading order
const undoTexts = ($) => ['rail-undo-done', 'rail-undo-run', 'rail-undo-result', 'rail-undo-stuck-text', 'rail-undo-blocked-text', 'rail-undo-force']
  .filter((id) => shown($(id)) && shown($('rail-undo'))).map((id) => $(id).textContent);

test('routes and parsers: the two chat routes, a tolerant list, a tolerant result, the request body', () => {
  assert.equal(undoUrl('core', 'a.1', 'restore-points'), '/api/projects/core/chats/a.1/restore-points');
  assert.equal(undoUrl('core', 'a', 'undo'), '/api/projects/core/chats/a/undo');
  for (const bad of [undoUrl('../x', 'a', 'undo'), undoUrl('core', '../a', 'undo'), undoUrl('core', 'a', 'context'), undoUrl('core', null, 'undo')]) assert.equal(bad, null);
  const doc = parseRestorePoints({ points: [POINT, { runId: 'r1', files: 9 }, { runId: '../x' }, null, { runId: 'r0', createdAt: 'later', files: -2, undoneAt: 'never' }] });
  assert.deepEqual(doc, { valid: true, points: [{ ...POINT, unreadable: false }, { runId: 'r0', createdAt: null, files: null, undoneAt: null, remaining: null, unreadable: false }] }, 'one per run, junk dropped');
  for (const junk of [null, 7, [], { points: 'x' }]) assert.deepEqual(parseRestorePoints(junk), { valid: false, points: [] });
  // an older server without remaining: all of them while the point is open, none once it is undone
  const old = parseRestorePoints({ points: [{ runId: 'r2', createdAt: POINT.createdAt, files: 4, undoneAt: null }, { runId: 'r1', createdAt: POINT.createdAt, files: 4, undoneAt: UNDONE_AT }] }).points;
  assert.deepEqual(old.map((p) => p.remaining), [4, 0]);
  assert.equal(parseRestorePoints({ points: [{ ...POINT, remaining: 9 }] }).points[0].remaining, 3, 'never more than the point holds');
  assert.deepEqual(parseRestorePoints({ points: [{ runId: 'r1', unreadable: true, createdAt: null, files: null, undoneAt: null }] }).points,
    [{ runId: 'r1', createdAt: null, files: null, undoneAt: null, remaining: null, unreadable: true }]);
  assert.deepEqual(parseUndo(CONFLICTED).conflicts, CONFLICTED.conflicts);
  assert.deepEqual(parseUndo({ restored: [' spaced name.txt', 7, ''], removed: [], conflicts: [{ path: 'x' }, { reason: 'no path' }, { path: 'y', code: 'unrestorable' }] }),
    { valid: true, runId: null, restored: [' spaced name.txt'], removed: [], conflicts: [{ path: 'x', reason: 'changed after the run', code: 'changed' }, { path: 'y', reason: 'no usable backup', code: 'unrestorable' }] },
    'a missing code counts as changed');
  assert.equal(parseUndo({ restored: [] }).valid, false);
  assert.deepEqual(buildUndo('r1'), { body: { runId: 'r1' } });
  assert.deepEqual(buildUndo('r1', true), { body: { runId: 'r1', force: true } });
  assert.ok(buildUndo('').error);
});

test('availability: only the newest point that is not fully undone, for the run on screen', () => {
  const run = { runId: 'r1', over: true, team: true };
  const r2 = { ...POINT, runId: 'r2', unreadable: false };
  const r1 = { ...POINT, unreadable: false };
  assert.equal(undoState(run, [r1]), 'offer');
  assert.equal(undoState({ ...run, over: false }, [r1]), 'none', 'not while the run is live');
  assert.equal(undoState({ ...run, team: false }, [r1]), 'none', 'not for a pipeline run');
  assert.equal(undoState(run, []), 'none', 'not without a restore point');
  assert.equal(undoState(run, [r2]), 'none', 'the point of another run is not this run\'s');
  assert.equal(undoState(run, [{ ...r1, undoneAt: UNDONE_AT, remaining: 0 }]), 'undone');
  assert.equal(undoState(run, [r2, r1]), 'older', 'a later run comes first');
  assert.equal(undoState({ ...run, runId: 'r2' }, [r2, r1]), 'offer');
  assert.equal(undoState(run, [{ ...r2, undoneAt: UNDONE_AT, remaining: 0 }, r1]), 'offer', 'the later run is undone');
  assert.equal(undoState(run, [{ ...r2, remaining: 1 }, r1]), 'older', 'a partly undone later run still comes first');
  assert.equal(undoState(run, [{ ...r1, remaining: 1 }]), 'partial');
  assert.equal(undoState(run, [{ runId: 'r1', unreadable: true, createdAt: null, files: null, undoneAt: null, remaining: null }]), 'unreadable');
});

test('the rail offers Undo these changes under the files line, and takes it away while a run is active', async () => {
  const h = await harness();
  assert.equal(h.gets().length, 1);
  assert.deepEqual(h.gets()[0].headers, CLIENT_HEADERS, 'the context drawer\'s request helper and headers');
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER}`, 'what the restore point holds');
  assert.equal(shown(h.$('rail-undo')), true);
  assert.equal(shown(h.$('rail-undo-run')), true);
  assert.equal(h.$('rail-undo-run').textContent, 'Undo these changes');
  assert.equal(shown(h.$('rail-undo-done')), false);
  h.draw({ active: true });
  assert.equal(shown(h.$('rail-undo-run')), false, 'a run of the chat is going');
  h.draw({ active: false, view: railRun({ live: true }) });
  assert.equal(shown(h.$('rail-undo')), false, 'the run on screen is live');
  h.draw({ view: railRun() });
  assert.equal(shown(h.$('rail-undo-run')), true);
  const html = read('index.html');
  const outcome = html.slice(html.indexOf('id="rail-outcome"'), html.indexOf('id="rail-agents-title"'));
  assert.match(outcome, /id="rail-outcome-files"[\s\S]*<div class="outcome-undo" id="rail-undo" hidden>/, 'under the outcome, after the files line');
  assert.match(outcome, /<button type="button" class="btn btn-small" id="rail-undo-run" aria-haspopup="dialog" hidden>Undo these changes<\/button>/);
  assert.match(outcome, /<ul class="outcome-conflicts" id="rail-undo-conflicts" aria-labelledby="rail-undo-result" hidden><\/ul>\s*<p class="outcome-undo-stuck" id="rail-undo-stuck-text" hidden><\/p>\s*<ul class="outcome-conflicts" id="rail-undo-stuck" aria-labelledby="rail-undo-stuck-text" hidden><\/ul>/);
  assert.match(outcome, /<button type="button" class="btn btn-small" id="rail-undo-force" aria-haspopup="dialog" hidden>Overwrite the later changes<\/button>/);
  assert.match(outcome, /<p class="outcome-undo-result" id="rail-undo-result" tabindex="-1" hidden><\/p>/, 'not a live region: the announcer says it once');
});

test('an earlier run with a later open point: a sentence instead of the control, and the later run offers it', async () => {
  const r2 = { ...POINT, runId: 'r2', createdAt: '2026-11-21T11:00:00.000Z', files: 2, remaining: 2 };
  const h = await harness({ points: [r2, POINT], view: railRun({ runId: 'r1' }) });
  assert.deepEqual(undoTexts(h.$), [OLDER]);
  assert.equal(shown(h.$('rail-undo-run')), false);
  h.draw({ view: railRun({ runId: 'r2' }) });
  assert.deepEqual(undoTexts(h.$), ['Undo these changes']);
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.deepEqual(h.posts().map((r) => r.body), [{ runId: 'r2' }], 'never the earlier run');
  // the later run is undone now: the earlier one is next
  h.server.points = [{ ...r2, undoneAt: UNDONE_AT, remaining: 0 }, POINT];
  await h.undo.refresh();
  h.draw({ view: railRun({ runId: 'r1' }) });
  assert.deepEqual(undoTexts(h.$), ['Undo these changes']);
});

test('no offer for a pipeline chat, a run without a restore point, or a server that answers 404', async () => {
  const pipe = await harness({ engine: 'pipeline' });
  assert.equal(pipe.gets().length, 0, 'a pipeline chat has none to read');
  assert.equal(shown(pipe.$('rail-undo')), false);
  const none = await harness({ points: [{ ...POINT, runId: 'r0' }] });
  assert.equal(shown(none.$('rail-undo')), false);
  const old = await harness({ get: () => ({ status: 404, body: { error: 'Not found' } }) });
  assert.equal(old.gets().length, 1);
  assert.equal(shown(old.$('rail-undo')), false, 'an older server: no restore points, silently');
  assert.equal(old.$('confirm-dialog').open, false);
  assert.equal(old.$('control-announcer').textContent, '');
  // the server was replaced by an older one meanwhile: what it listed before is gone, and nothing says so
  const was = await harness();
  assert.equal(shown(was.$('rail-undo-run')), true);
  was.server.get = () => ({ status: 404, body: { error: 'Not found' } });
  await was.undo.refresh();
  assert.equal(shown(was.$('rail-undo')), false);
  // a failure of another kind keeps what was read
  const kept = await harness();
  kept.server.get = () => ({ status: 500, body: { error: 'boom' } });
  await kept.undo.refresh();
  assert.equal(shown(kept.$('rail-undo-run')), true);
  assert.equal(kept.$('control-announcer').textContent, '');
});

test('an entry the server cannot read is never offered, and says why', async () => {
  const h = await harness({ points: [{ runId: 'r1', unreadable: true, createdAt: null, files: null, undoneAt: null }] });
  assert.deepEqual(undoTexts(h.$), ['The restore point of this run cannot be read, so its changes cannot be undone here.']);
  assert.equal(shown(h.$('rail-undo-run')), false);
  assert.equal(h.$('rail-outcome-files-text').textContent, `2 files written by the agents for ${FOLDER}`, 'no count from the point');
});

test('a run that was undone says so with the time, next to its count, instead of offering it again', async () => {
  const h = await harness({ points: [{ ...POINT, undoneAt: UNDONE_AT, remaining: 0 }] });
  assert.equal(shown(h.$('rail-undo-run')), false);
  assert.equal(shown(h.$('rail-undo-done')), true);
  assert.equal(h.$('rail-undo-done').textContent, `These changes were undone at ${formatWhen(UNDONE_AT)}.`);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`);
});

test('a partly undone run after a reload: how many files were kept, and the undo can go on', async () => {
  const h = await harness({ points: [{ ...POINT, remaining: 1 }] });
  assert.deepEqual(undoTexts(h.$), ['Partly undone: 1 of 3 files kept as it is.', 'Continue the undo']);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · partly undone`);
  await h.$('rail-undo-run').click();
  assert.equal(h.$('confirm-title').textContent, 'Continue the undo of this run?');
  assert.equal(h.$('confirm-detail').textContent, `The 1 file of this run that was kept in ${FOLDER} is tried again: what the run replaced or deleted is put back, and what it created is removed. A file that is no longer as the run left it is kept as it is and listed afterwards. Git history and the chat stay as they are.`);
  await h.$('confirm-ok').click();
  assert.deepEqual(h.posts().map((r) => r.body), [{ runId: 'r1' }]);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`, 'as the server says after the undo');
  const many = await harness({ points: [{ ...POINT, remaining: 2 }] });
  assert.equal(many.$('rail-undo-done').textContent, 'Partly undone: 2 of 3 files kept as they are.');
});

test('the Changes panel of an undone run says so above the diff; the folder text is never claimed', async () => {
  const h = await harness({ points: [{ ...POINT, undoneAt: UNDONE_AT, remaining: 0 }] });
  const side = createSidePanel({});
  const rv = h.state.view;
  side.render(rv, { key: 'k', content: 'diff --git a/todo.js b/todo.js\n+x\n', known: true }, h.undo.note(rv.runId));
  assert.equal(shown(h.$('changes-undone')), true);
  assert.equal(h.$('changes-undone').textContent, `These changes were undone at ${formatWhen(UNDONE_AT)}. The list and the diff below show what the run did, not the folder as it is now.`);
  h.server.points = [{ ...POINT, remaining: 2 }];
  await h.undo.refresh();
  side.render(rv, { key: 'k', content: 'diff --git a/todo.js b/todo.js\n+x\n', known: true }, h.undo.note(rv.runId));
  assert.equal(h.$('changes-undone').textContent, 'These changes were partly undone: 2 of 3 files kept as they are. The list and the diff below show what the run did, not the folder as it is now.');
  h.server.points = [POINT];
  await h.undo.refresh();
  side.render(rv, null, h.undo.note(rv.runId));
  assert.equal(shown(h.$('changes-undone')), false, 'a run that is not undone');
  assert.equal(h.undo.note('r9'), '', 'another run');
});

test('the confirmation says what happens, names the folder, keeps later edits; Cancel sends nothing', async () => {
  const h = await harness();
  await h.$('rail-undo-run').click();
  assert.equal(h.$('confirm-dialog').open, true);
  assert.equal(h.$('confirm-title').textContent, 'Undo the changes of this run?');
  assert.equal(h.$('confirm-detail').textContent, `The files this run replaced or deleted in ${FOLDER} are put back, and the files it created are removed. The restore point holds 3 files. A file that was changed after the run is kept as it is and listed afterwards. Git history and the chat stay as they are.`);
  assert.equal(h.$('confirm-ok').textContent, 'Undo changes');
  assert.equal(globalThis.document.activeElement, h.$('confirm-cancel'), 'focus on Cancel, as for Stop and Skip');
  await h.$('confirm-cancel').click();
  assert.equal(h.$('confirm-dialog').open, false);
  assert.equal(h.posts().length, 0);
});

test('undo: POST { runId } with the control headers, the result stated once and announced, then read again', async () => {
  const h = await harness();
  await h.$('rail-undo-run').click();
  const before = h.gets().length;
  await h.$('confirm-ok').click();
  assert.deepEqual(h.posts().map((r) => [r.url, r.body, r.headers]), [['/api/projects/core/chats/a/undo', { runId: 'r1' }, CONTROL_HEADERS]]);
  assert.equal(h.$('confirm-dialog').open, false);
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 2 files put back, 1 removed.');
  assert.equal(h.$('control-announcer').textContent, 'Undone: 2 files put back, 1 removed.');
  assert.equal(shown(h.$('rail-undo-conflicts')), false);
  assert.equal(shown(h.$('rail-undo-force')), false);
  // what shows the run's files reads again from the server; the offer follows the point it reread
  assert.equal(h.gets().length, before + 1);
  assert.equal(h.state.undone, 1, 'told once: what shows the folder reads it again');
  assert.equal(shown(h.$('rail-undo-run')), false);
  assert.equal(shown(h.$('rail-undo-done')), false, 'the result already says it');
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`);
  assert.equal(globalThis.document.activeElement, h.$('rail-undo-result'));
  // back on the chat later: the time of the undo, from the point
  await h.undo.setScope({ project: 'core', chat: 'a' });
  h.draw();
  assert.equal(h.$('rail-undo-done').textContent, `These changes were undone at ${formatWhen(UNDONE_AT)}.`);
  assert.equal(shown(h.$('rail-undo-result')), false);
});

test('an answer that cannot be read claims nothing about the folder and the outcome follows the server', async () => {
  const h = await harness({ undo: () => ({ status: 200, body: { odd: true } }) });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.equal(h.$('rail-undo-result').textContent, 'The undo was sent, but its answer could not be read. Check the folder to see which files changed.');
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER}`, 'the server still lists the point as open: nothing is assumed');
});

test('a double click on the confirmation sends one POST', async () => {
  const answers = [];
  const h = await harness({ undo: () => new Promise((r) => { answers.push(r); }) });
  await h.$('rail-undo-run').click();
  const first = h.$('confirm-ok').click();
  const second = h.$('confirm-ok').click();
  await tick();
  for (const answer of answers) answer({ status: 200, body: DONE });
  await Promise.all([first, second]);
  assert.equal(h.posts().length, 1);
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 2 files put back, 1 removed.');
});

test('a chat switch while the POST is in flight: the late answer paints nothing into the other chat', async () => {
  let answer;
  const h = await harness({
    undo: () => new Promise((r) => { answer = r; }),
    get: (url) => ({ status: 200, body: { points: url.includes('/chats/b/') ? [{ ...POINT, runId: 'r9' }] : [POINT] } }),
  });
  assert.deepEqual(undoTexts(h.$), ['Undo these changes']);
  await h.$('rail-undo-run').click();
  const sent = h.$('confirm-ok').click();
  await tick();
  await h.undo.setScope({ project: 'core', chat: 'b' });
  h.draw({ view: railRun({ runId: 'r9' }) });
  assert.deepEqual(undoTexts(h.$), ['Undo these changes']);
  answer({ status: 200, body: { ...CONFLICTED, runId: 'r1' } });
  await sent;
  await tick();
  assert.deepEqual(undoTexts(h.$), ['Undo these changes'], 'chat b as it was');
  assert.equal(h.$('rail-undo-run').disabled, false);
  assert.equal(shown(h.$('rail-undo-conflicts')), false);
  assert.equal(h.$('control-announcer').textContent, 'Undoing...', 'nothing said since chat a sent it');
  assert.equal(h.state.undone, 0);
});

test('conflicts: each by path with its reason, and a separate confirmed control that sends force: true', async () => {
  let n = 0;
  const h = await harness({
    undo: (body) => {
      n += 1;
      return n === 1 ? { status: 200, body: CONFLICTED } : { status: 200, body: { runId: 'r1', restored: ['todo.js', 'notes.md'], removed: [], conflicts: [] } };
    },
  });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  const text = 'Undone: 1 file put back, 0 removed. 2 files were changed after the run and kept as they are:';
  assert.equal(h.$('rail-undo-result').textContent, text);
  assert.deepEqual(h.$('rail-undo-conflicts').children.map((li) => li.textContent), ['todo.js changed after the run', 'notes.md deleted after the run']);
  assert.equal(h.$('control-announcer').textContent, `${text} todo.js - changed after the run; notes.md - deleted after the run.`);
  assert.equal(shown(h.$('rail-undo-force')), true);
  assert.equal(h.$('rail-undo-force').textContent, 'Overwrite the later changes');
  assert.equal(shown(h.$('rail-undo-run')), false, 'one way on: the explicit control');
  assert.equal(globalThis.document.activeElement, h.$('rail-undo-force'));
  h.draw({ active: true });
  assert.equal(shown(h.$('rail-undo-force')), false, 'never while a run is going');
  h.draw({ active: false });

  await h.$('rail-undo-force').click();
  assert.equal(h.$('confirm-title').textContent, 'Overwrite the later changes?');
  assert.equal(h.$('confirm-detail').textContent, `The 2 files listed as changed were changed after the run in ${FOLDER}. Those changes may be your own edits or the work of a later run in another chat of this project. Undoing the files anyway puts them back or removes them as the run found them, and those changes are lost. Git history and the chat stay as they are.`);
  assert.equal(h.$('confirm-ok').textContent, 'Overwrite changes');
  assert.equal(h.posts().length, 1, 'nothing is sent before the second confirmation');
  await h.$('confirm-ok').click();
  assert.deepEqual(h.posts().map((r) => r.body), [{ runId: 'r1' }, { runId: 'r1', force: true }]);
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 2 files put back, 0 removed.');
  assert.equal(shown(h.$('rail-undo-force')), false);
  assert.equal(shown(h.$('rail-undo-conflicts')), false);
});

test('conflict codes: force only for changed files; files without a usable backup are listed apart', async () => {
  const mixed = { runId: 'r1', restored: [], removed: ['a.js'], conflicts: [{ path: 'todo.js', reason: 'changed after the run', code: 'changed' }, { path: 'big.bin', reason: 'Pre-image exceeds 1048576 bytes', code: 'unrestorable' }] };
  const h = await harness({ undo: () => ({ status: 200, body: mixed }) });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 0 files put back, 1 removed. 1 file was changed after the run and kept as it is:');
  assert.deepEqual(h.$('rail-undo-conflicts').children.map((li) => li.textContent), ['todo.js changed after the run']);
  assert.equal(h.$('rail-undo-stuck-text').textContent, '1 file could not be undone and was kept as it is:');
  assert.deepEqual(h.$('rail-undo-stuck').children.map((li) => li.textContent), ['big.bin Pre-image exceeds 1048576 bytes']);
  assert.equal(h.$('control-announcer').textContent, 'Undone: 0 files put back, 1 removed. 1 file was changed after the run and kept as it is: todo.js - changed after the run. 1 file could not be undone and was kept as it is: big.bin - Pre-image exceeds 1048576 bytes.');
  assert.equal(shown(h.$('rail-undo-force')), true);
  await h.$('rail-undo-force').click();
  assert.match(h.$('confirm-detail').textContent, /^The file listed as changed was changed after the run in C:\\ws\\todo\. Those changes may be your own edits or the work of a later run/);

  const stuck = { runId: 'r1', restored: ['README.md'], removed: [], conflicts: [{ path: 'big.bin', reason: 'no backup', code: 'unrestorable' }, { path: 'huge.bin', reason: 'no backup', code: 'unrestorable' }] };
  const s = await harness({ undo: () => ({ status: 200, body: stuck }) });
  await s.$('rail-undo-run').click();
  await s.$('confirm-ok').click();
  assert.equal(s.$('rail-undo-result').textContent, 'Undone: 1 file put back, 0 removed.');
  assert.equal(shown(s.$('rail-undo-conflicts')), false);
  assert.equal(s.$('rail-undo-stuck-text').textContent, '2 files could not be undone and were kept as they are:');
  assert.equal(shown(s.$('rail-undo-force')), false, 'force cannot help');
  assert.equal(globalThis.document.activeElement, s.$('rail-undo-result'));
});

const EBUSY = 'Could not write the file (EBUSY); close programs using it and undo again';
const items = (list) => list.children.map((li) => li.textContent);

test('blocked files only: listed apart with the server\'s reason, no force, and the undo can be tried again', async () => {
  const blocked = { runId: 'r1', restored: ['README.md', 'todo.js'], removed: [], conflicts: [{ path: 'notes.md', reason: EBUSY, code: 'blocked' }] };
  let n = 0;
  const h = await harness({
    undo: () => {
      n += 1;
      if (n > 1) return { status: 200, body: { runId: 'r1', restored: ['notes.md'], removed: [], conflicts: [] } };
      h.server.points = [{ ...POINT, remaining: 1 }];
      return { status: 200, body: blocked };
    },
  });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 2 files put back, 0 removed.');
  assert.equal(shown(h.$('rail-undo-conflicts')), false, 'not listed as changed');
  assert.equal(h.$('rail-undo-blocked-text').textContent, '1 file could not be restored right now. Undo again later to retry it:');
  assert.deepEqual(items(h.$('rail-undo-blocked')), [`notes.md ${EBUSY}`]);
  assert.equal(shown(h.$('rail-undo-force')), false, 'force cannot help');
  assert.deepEqual(undoTexts(h.$), ['Continue the undo', 'Undone: 2 files put back, 0 removed.', '1 file could not be restored right now. Undo again later to retry it:'], 'the result keeps the way to retry');
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.deepEqual(h.posts().map((r) => r.body), [{ runId: 'r1' }, { runId: 'r1' }], 'tried again without force');
  assert.equal(shown(h.$('rail-undo-blocked')), false);

  // nothing undone yet: the state stays offer, and the control with it
  const all = await harness({ undo: () => ({ status: 200, body: { runId: 'r1', restored: [], removed: [], conflicts: [{ path: 'a.js', reason: EBUSY, code: 'blocked' }, { path: 'b.js', reason: EBUSY, code: 'blocked' }] } }) });
  await all.$('rail-undo-run').click();
  await all.$('confirm-ok').click();
  assert.equal(all.$('rail-undo-blocked-text').textContent, '2 files could not be restored right now. Undo again later to retry them:');
  assert.equal(shown(all.$('rail-undo-force')), false);
  assert.equal(shown(all.$('rail-undo-run')), true);
  assert.equal(all.$('rail-undo-run').textContent, 'Undo these changes');
  const html = read('index.html');
  assert.match(html, /id="rail-undo-stuck" aria-labelledby="rail-undo-stuck-text" hidden><\/ul>\s*<p class="outcome-undo-stuck" id="rail-undo-blocked-text" hidden><\/p>\s*<ul class="outcome-conflicts" id="rail-undo-blocked" aria-labelledby="rail-undo-blocked-text" hidden><\/ul>/);
});

test('changed and blocked files: force for the changed ones only, both groups listed', async () => {
  const mixed = { runId: 'r1', restored: ['README.md'], removed: [], conflicts: [{ path: 'todo.js', reason: 'changed after the run', code: 'changed' }, { path: 'notes.md', reason: EBUSY, code: 'blocked' }] };
  const h = await harness({ undo: () => { h.server.points = [{ ...POINT, remaining: 2 }]; return { status: 200, body: mixed }; } });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 1 file put back, 0 removed. 1 file was changed after the run and kept as it is:');
  assert.deepEqual(items(h.$('rail-undo-conflicts')), ['todo.js changed after the run']);
  assert.deepEqual(items(h.$('rail-undo-blocked')), [`notes.md ${EBUSY}`]);
  assert.equal(shown(h.$('rail-undo-force')), true);
  assert.equal(shown(h.$('rail-undo-run')), true, 'retrying the blocked file needs no force');
  await h.$('rail-undo-force').click();
  assert.match(h.$('confirm-detail').textContent, /^The file listed as changed was changed after the run/);
});

test('an unknown conflict code is listed with its reason and offers no force; a missing code is still changed', async () => {
  const odd = { runId: 'r1', restored: [], removed: ['a.js'], conflicts: [{ path: 'x.db', reason: 'Locked by the <b>server</b>', code: 'locked' }, { path: 'y.db', code: 7 }] };
  assert.deepEqual(parseUndo(odd).conflicts, [{ path: 'x.db', reason: 'Locked by the <b>server</b>', code: 'blocked' }, { path: 'y.db', reason: 'could not be written right now', code: 'blocked' }]);
  assert.equal(parseUndo({ restored: [], removed: [], conflicts: [{ path: 'z', code: null }] }).conflicts[0].code, 'changed');
  const h = await harness({ undo: () => ({ status: 200, body: odd }) });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.equal(h.$('rail-undo-result').textContent, 'Undone: 0 files put back, 1 removed.');
  assert.deepEqual(h.$('rail-undo-blocked').children.map((li) => [li.textContent, li.children.map((c) => c.children.length)]),
    [['x.db Locked by the <b>server</b>', [0, 0]], ['y.db could not be written right now', [0, 0]]], 'text, never markup');
  assert.equal(shown(h.$('rail-undo-force')), false);
  assert.equal(shown(h.$('rail-undo-run')), true);
});

test('the announcement says how many files could not be restored right now', async () => {
  const all = { runId: 'r1', restored: ['README.md'], removed: [], conflicts: [
    { path: 'todo.js', reason: 'changed after the run', code: 'changed' }, { path: 'big.bin', reason: 'no backup', code: 'unrestorable' },
    { path: 'notes.md', reason: EBUSY, code: 'blocked' }, { path: 'lib.dll', reason: EBUSY, code: 'blocked' },
  ] };
  const h = await harness({ undo: () => ({ status: 200, body: all }) });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  assert.equal(h.$('control-announcer').textContent, 'Undone: 1 file put back, 0 removed. 1 file was changed after the run and kept as it is: todo.js - changed after the run.'
    + ' 1 file could not be undone and was kept as it is: big.bin - no backup.'
    + ` 2 files could not be restored right now. Undo again later to retry them: notes.md - ${EBUSY}; lib.dll - ${EBUSY}.`);
});

test('errors: every 409 in the server\'s own sentence, 404 and no answer as the server says, in the dialog', async () => {
  const sentences = [
    'A run is active in this chat. Stop it or wait, then undo.',
    'A run is active in another chat of this project (Second chat). Wait for it to finish, then undo.',
    'This chat needs recovery before its changes can be undone.',
    'Newer runs of this chat must be undone first.',
  ];
  const answers = [...sentences.map((error) => ({ status: 409, body: { error } })), { status: 409, body: null }, { status: 404, body: { error: 'No restore point for run r1' } }, { network: true }];
  const h = await harness({ undo: () => answers.shift() });
  await h.$('rail-undo-run').click();
  for (const sentence of sentences) {
    await h.$('confirm-ok').click();
    assert.equal(h.$('confirm-dialog').open, true, 'the existing error path: the dialog stays and says why');
    assert.equal(h.$('confirm-error').textContent, sentence);
    assert.equal(shown(h.$('confirm-error')), true);
  }
  await h.$('confirm-ok').click();
  assert.equal(h.$('confirm-error').textContent, ACTIVE_TEXT, 'a 409 without a sentence');
  await h.$('confirm-ok').click();
  assert.equal(h.$('confirm-error').textContent, 'No restore point for run r1');
  await h.$('confirm-ok').click();
  assert.equal(h.$('confirm-error').textContent, 'The server did not answer. Is it still running?');
  assert.equal(shown(h.$('rail-undo-result')), false, 'nothing claims an undo happened');
  assert.equal(h.state.undone, 0);
  assert.equal(undoError(409, null), ACTIVE_TEXT);
  assert.equal(undoError(409, { error: 'Chat is running or requires recovery' }), 'Chat is running or requires recovery');
  assert.equal(undoError(404, { error: 'Not found' }), 'This run has no restore point any more.');
});

test('the page knows the chat needs recovery: the dialog says that, not that a run is active', async () => {
  const h = await harness();
  await h.$('rail-undo-run').click();
  h.state.active = 'recovery';
  await h.$('confirm-ok').click();
  assert.equal(h.$('confirm-error').textContent, 'This chat needs recovery first: an earlier run still holds it. Recover it, then undo.');
  h.state.active = true;
  await h.$('confirm-ok').click();
  assert.equal(h.$('confirm-error').textContent, ACTIVE_TEXT);
  assert.equal(h.posts().length, 0);
});

test('result texts: one file, nothing to do', () => {
  assert.equal(undoResult({ restored: ['a'], removed: ['b', 'c'], conflicts: [] }), 'Undone: 1 file put back, 2 removed.');
  assert.equal(undoResult({ restored: [], removed: [], conflicts: [] }), 'Undone: no file had to be put back or removed.');
  assert.equal(undoResult({ restored: [], removed: [], conflicts: [{ path: 'x', reason: 'r', code: 'changed' }] }), 'Undone: no file had to be put back or removed. 1 file was changed after the run and kept as it is:');
  assert.equal(undoResult({ restored: [], removed: [], conflicts: [{ path: 'x', reason: 'r', code: 'unrestorable' }] }), 'Undone: no file had to be put back or removed.');
});

async function newProjectDialog(projects) {
  const $ = installDom();
  Object.assign(globalThis.document, { querySelector: () => null, addEventListener() {} });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.localStorage = fakeStorage();
  delete globalThis.__TAURI__;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => structuredClone(projects) });
  const nav = createNav({ getScope: () => null, navigate() {}, openRun() {}, announce() {} });
  await nav.refresh();
  nav.newProject();
  return $;
}

test('New project: the hint names the server\'s projectsRoot, and keeps today\'s words without it', async () => {
  const base = { mode: 'registry', maxConcurrentRuns: 4, running: 0, projects: [] };
  const root = 'C:\\Users\\me\\Documents\\Scranton\\projects';
  const withRoot = await newProjectDialog({ ...base, projectsRoot: root });
  assert.equal(withRoot('p-folder-hint').textContent, `Absolute path of the folder the agents work in. Leave it empty to create a new folder for the project in ${root}.`);
  const without = await newProjectDialog(base);
  const today = 'Absolute path of the folder the agents work in. Leave it empty to create a new folder for the project under Documents/Scranton/projects in your user folder.';
  assert.equal(without('p-folder-hint').textContent, today);
  assert.equal(folderHint(null), today);
  assert.ok(read('index.html').includes(`<span class="hint" id="p-folder-hint">${today}</span>`), 'the page says the same before the first answer');
  // a relative or odd value is no folder to name
  for (const odd of ['projects', 7, '']) assert.equal(parseProjects({ ...base, projectsRoot: odd }).projectsRoot, null);
  assert.equal(parseProjects({ ...base, projectsRoot: root }).projectsRoot, root);
});

// the sidebar's document with the chat's run count and status
const chatDoc = (runs, status = 'done') => parseProjects({ mode: 'registry', projects: [{ id: 'core', name: 'Core', workspace: FOLDER, chats: [{ id: 'a', title: 'A', status, runs }] }] });

test('a result belongs to its run and to the points read after it: another run, a later run or a newer list never offers force again', async () => {
  const kept = { ...POINT, remaining: 2 };
  const conflicted = async () => {
    const h = await harness({ undo: () => { h.server.points = [kept]; return { status: 200, body: CONFLICTED }; } });
    await h.$('rail-undo-run').click();
    await h.$('confirm-ok').click();
    assert.equal(shown(h.$('rail-undo-force')), true, 'the conflicts of the answer just read');
    return h;
  };
  const partly = ['Partly undone: 2 of 3 files kept as they are.', 'Continue the undo'];
  // another run in the picker, then this one again: the state's own text
  const picked = await conflicted();
  picked.draw({ view: railRun({ runId: 'r0' }) });
  picked.draw({ view: railRun({ runId: 'r1' }) });
  assert.deepEqual(undoTexts(picked.$), partly);
  await picked.$('rail-undo-force').click();
  assert.equal(picked.$('confirm-dialog').open, false, 'a hidden control asks nothing');
  assert.equal(picked.posts().length, 1);
  // run 2 changed the same files in this chat; run 1 is replayed in the picker
  const later = await conflicted();
  later.server.points = [{ ...POINT, runId: 'r2', createdAt: '2026-11-21T11:00:00.000Z' }, kept];
  later.draw({ view: railRun({ runId: 'r2', live: true }) });
  later.undo.projects(chatDoc(1, 'running'));
  later.undo.projects(chatDoc(2));
  await tick();
  later.draw({ view: railRun({ runId: 'r2' }) });
  later.draw({ view: railRun({ runId: 'r1' }) });
  assert.deepEqual(undoTexts(later.$), [OLDER]);
  assert.equal(shown(later.$('rail-undo-force')), false);
  assert.equal(shown(later.$('rail-undo-conflicts')), false);
  // the same run on screen, the points read again: what they say now
  const reread = await conflicted();
  await reread.undo.refresh();
  assert.deepEqual(undoTexts(reread.$), partly);
  reread.server.points = [{ ...POINT, runId: 'r2', createdAt: '2026-11-21T11:00:00.000Z' }, kept];
  await reread.undo.refresh();
  assert.deepEqual(undoTexts(reread.$), [OLDER]);
});

test('a point with nothing left counts as undone, also without undoneAt: no time, never "0 of 3 kept"', async () => {
  const h = await harness({ points: [{ ...POINT, remaining: 0 }] });
  assert.deepEqual(undoTexts(h.$), ['These changes were undone.']);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`);
  assert.equal(h.undo.note('r1'), 'These changes were undone. The list and the diff below show what the run did, not the folder as it is now.');
  const run = { runId: 'r1', over: true, team: true };
  const r1 = { ...POINT, unreadable: false };
  assert.equal(undoState(run, [{ ...r1, remaining: 0 }]), 'undone');
  assert.equal(undoState(run, [{ ...r1, runId: 'r2', remaining: 0 }, r1]), 'offer', 'a later run with nothing left holds nothing back');
  assert.equal(changesNote({ ...r1, remaining: 0, undoneAt: UNDONE_AT }), `These changes were undone at ${formatWhen(UNDONE_AT)}. The list and the diff below show what the run did, not the folder as it is now.`);
});

test('the undo in flight says so; two minutes without an answer abandon it once, and the result is unknown', async (t) => {
  const h = await harness({ undo: () => new Promise(() => {}) });
  let signal = null;
  const served = globalThis.fetch;
  // as a browser does: an aborted request rejects
  globalThis.fetch = (url, opts = {}) => {
    const answer = served(url, opts);
    if (opts.method !== 'POST') return answer;
    signal = opts.signal;
    return new Promise((resolve, reject) => {
      answer.then(resolve, reject);
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((r) => setImmediate(r));
  await h.$('rail-undo-run').click();
  const sent = h.$('confirm-ok').click();
  await flush();
  assert.equal(h.$('rail-undo-result').textContent, 'Undoing...');
  assert.equal(shown(h.$('rail-undo-result')), true);
  assert.equal(h.$('control-announcer').textContent, 'Undoing...');
  assert.equal(h.$('rail-undo-run').disabled, true);
  t.mock.timers.tick(119_999);
  await flush();
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await sent;
  const unknown = 'The undo did not answer within 2 minutes, so its result is unknown. Check the folder and reload the page before you try again.';
  assert.equal(signal.aborted, true, 'the request is abandoned');
  assert.equal(h.$('confirm-error').textContent, unknown);
  assert.equal(h.$('rail-undo-result').textContent, unknown);
  assert.equal(h.$('control-announcer').textContent, unknown);
  assert.equal(shown(h.$('rail-undo-run')), false, 'not offered again before a reload');
  h.$('confirm-ok').click();
  await flush();
  assert.equal(h.$('confirm-error').textContent, unknown, 'not from the dialog either, before the points are read again');
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(h.posts().length, 1, 'never a second POST');
});

test('the unknown result of an abandoned undo stays with its run when another run is picked, until the points are read again', async (t) => {
  const h = await harness({ undo: () => new Promise(() => {}) });
  const served = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    const answer = served(url, opts);
    if (opts.method !== 'POST') return answer;
    return new Promise((resolve, reject) => {
      answer.then(resolve, reject);
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((r) => setImmediate(r));
  await h.$('rail-undo-run').click();
  const sent = h.$('confirm-ok').click();
  await flush();
  t.mock.timers.tick(120_000);
  await sent;
  await h.$('confirm-cancel').click();
  const unknown = 'The undo did not answer within 2 minutes, so its result is unknown. Check the folder and reload the page before you try again.';
  h.draw({ view: railRun({ runId: 'r0' }) });
  h.draw({ view: railRun({ runId: 'r1' }) });
  assert.deepEqual(undoTexts(h.$), [unknown], 'the run on screen again: still unknown, no control');
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  await flush();
  assert.equal(h.posts().length, 1, 'never a second POST');
  t.mock.timers.reset();
  await h.undo.refresh();
  assert.deepEqual(undoTexts(h.$), ['Undo these changes'], 'a newer list: what it says now');
});

test('the force dialog checks again on OK: a reading while it was open that takes force away sends nothing', async () => {
  const kept = { ...POINT, remaining: 2 };
  const r2 = { ...POINT, runId: 'r2', createdAt: '2026-11-21T11:00:00.000Z' };
  const asked = async () => {
    const h = await harness({ undo: () => { h.server.points = [kept]; return { status: 200, body: CONFLICTED }; } });
    await h.$('rail-undo-run').click();
    await h.$('confirm-ok').click();
    await h.$('rail-undo-force').click();
    assert.equal(h.$('confirm-title').textContent, 'Overwrite the later changes?');
    return h;
  };
  // a later run finished meanwhile: undo works backwards
  const later = await asked();
  later.server.points = [r2, kept];
  await later.undo.refresh();
  await later.$('confirm-ok').click();
  assert.deepEqual(later.posts().map((r) => r.body), [{ runId: 'r1' }], 'no force: true');
  assert.equal(later.$('confirm-dialog').open, false);
  assert.deepEqual(undoTexts(later.$), [OLDER]);
  // undone meanwhile
  const undone = await asked();
  undone.server.points = [{ ...kept, undoneAt: UNDONE_AT, remaining: 0 }];
  await undone.undo.refresh();
  await undone.$('confirm-ok').click();
  assert.equal(undone.posts().length, 1);
  assert.equal(undone.$('confirm-dialog').open, false);
  assert.deepEqual(undoTexts(undone.$), [`These changes were undone at ${formatWhen(UNDONE_AT)}.`]);
  // the same points read again: the result with the changed files is gone
  const reread = await asked();
  await reread.undo.refresh();
  await reread.$('confirm-ok').click();
  assert.equal(reread.posts().length, 1);
  assert.equal(reread.$('confirm-dialog').open, false);
  assert.deepEqual(undoTexts(reread.$), ['Partly undone: 2 of 3 files kept as they are.', 'Continue the undo']);
});

test('the confirmation checks again on OK: another run on screen, or a point that can no longer be undone, sends nothing', async () => {
  const moved = await harness();
  await moved.$('rail-undo-run').click();
  moved.draw({ view: railRun({ runId: 'r0' }) });
  await moved.$('confirm-ok').click();
  assert.equal(moved.posts().length, 0, 'not the run the dialog was opened for');
  assert.equal(moved.$('confirm-dialog').open, false);
  const older = await harness();
  await older.$('rail-undo-run').click();
  older.server.points = [{ ...POINT, runId: 'r2', createdAt: '2026-11-21T11:00:00.000Z' }, POINT];
  await older.undo.refresh();
  await older.$('confirm-ok').click();
  assert.equal(older.posts().length, 0);
  assert.equal(older.$('confirm-dialog').open, false);
  assert.deepEqual(undoTexts(older.$), [OLDER]);
});

test('warnings of an undo are listed after its result as text; the newer 409 sentences are shown as the server wrote them', async () => {
  const warned = { ...DONE, warnings: ['Could not remove the directory src/<b>old</b>: it is not empty.', 7, '', 'Could not remove the directory lib: in use.'] };
  const h = await harness({ undo: () => ({ status: 200, body: warned }) });
  await h.$('rail-undo-run').click();
  await h.$('confirm-ok').click();
  const list = h.$('rail-undo-warnings');
  assert.equal(shown(list), true);
  assert.deepEqual(list.children.map((li) => [li.textContent, li.children.length]), [
    ['Could not remove the directory src/<b>old</b>: it is not empty.', 0], ['Could not remove the directory lib: in use.', 0],
  ]);
  assert.equal(h.$('control-announcer').textContent, 'Undone: 2 files put back, 1 removed. Could not remove the directory src/<b>old</b>: it is not empty. Could not remove the directory lib: in use.');
  const plain = await harness();
  await plain.$('rail-undo-run').click();
  await plain.$('confirm-ok').click();
  assert.equal(shown(plain.$('rail-undo-warnings')), false, 'no warnings, no list');

  const ids = Array.from({ length: 10 }, (_, i) => `run-20261121-1${i}0000-a${i}b2`);
  const sentences = [
    'An undo is already running in this chat.',
    `Newer runs of this chat must be undone first, newest first: ${ids.join(', ')}. Undo each of them in that order from its own outcome, then undo this run.`,
  ];
  const answers = sentences.map((error) => ({ status: 409, body: { error } }));
  const e = await harness({ undo: () => answers.shift() });
  await e.$('rail-undo-run').click();
  for (const sentence of sentences) {
    await e.$('confirm-ok').click();
    assert.equal(e.$('confirm-error').textContent, sentence);
  }
});

// a server that also counts the files undone and the files without a usable backup (larger than 16 MiB, say)
const COUNTED = { ...POINT, undone: 0, unrestorable: 0 };
const AS_DONE = 'The list and the diff below show what the run did, not the folder as it is now.';
const changesText = (h) => {
  const side = createSidePanel({});
  side.render(h.state.view, null, h.undo.note('r1'));
  return shown(h.$('changes-undone')) ? h.$('changes-undone').textContent : '';
};

test('a counting server: files without a backup before any undo are no partial undo; the confirmation says how many stay', async () => {
  const h = await harness({ points: [{ ...COUNTED, remaining: 2, unrestorable: 1 }] });
  assert.deepEqual(undoTexts(h.$), ['Undo these changes']);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER}`);
  assert.equal(changesText(h), '');
  await h.$('rail-undo-run').click();
  assert.equal(h.$('confirm-title').textContent, 'Undo the changes of this run?');
  assert.equal(h.$('confirm-detail').textContent, `The files this run replaced or deleted in ${FOLDER} are put back, and the files it created are removed. The restore point holds 3 files. 1 file cannot be put back because no backup exists for it; it stays as the run left it. A file that was changed after the run is kept as it is and listed afterwards. Git history and the chat stay as they are.`);
  await h.$('confirm-ok').click();
  assert.deepEqual(h.posts().map((r) => r.body), [{ runId: 'r1' }]);
  const two = await harness({ points: [{ ...COUNTED, remaining: 1, unrestorable: 2 }] });
  await two.$('rail-undo-run').click();
  assert.match(two.$('confirm-detail').textContent, / 2 files cannot be put back because no backup exists for them; they stay as the run left them\. /);
});

test('a counting server: a run whose files all have no backup cannot be undone, and nothing calls it undone', async () => {
  const h = await harness({ points: [{ ...COUNTED, remaining: 0, unrestorable: 3 }] });
  const text = 'These changes cannot be undone: no backup exists for the 3 files.';
  assert.deepEqual(undoTexts(h.$), [text]);
  assert.equal(shown(h.$('rail-undo-run')), false);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · cannot be undone`);
  assert.equal(changesText(h), text);
  assert.equal(undoState({ runId: 'r1', over: true, team: true }, [{ ...COUNTED, remaining: 0, unrestorable: 3, unreadable: false }]), 'unrestorable');
  // undo works backwards: a later point with nothing left holds nothing back
  const later = await harness({ points: [{ ...COUNTED, runId: 'r2', remaining: 0, unrestorable: 2 }, POINT] });
  assert.deepEqual(undoTexts(later.$), ['Undo these changes']);
  const one = await harness({ points: [{ ...COUNTED, files: 1, remaining: 0, unrestorable: 1 }] });
  assert.deepEqual(undoTexts(one.$), ['These changes cannot be undone: no backup exists for the file.']);
});

test('a counting server: partly undone with the true numbers, and the undo can go on', async () => {
  const h = await harness({ points: [{ ...COUNTED, files: 4, remaining: 1, undone: 2, unrestorable: 1 }] });
  const part = '2 of 4 files undone, 1 still to undo. 1 file had no backup and stayed as the run left it.';
  assert.deepEqual(undoTexts(h.$), [`Partly undone: ${part}`, 'Continue the undo']);
  assert.equal(h.$('rail-outcome-files-text').textContent, `4 files changed in ${FOLDER} · partly undone`);
  assert.equal(changesText(h), `These changes were partly undone: ${part} ${AS_DONE}`);
  const plain = await harness({ points: [{ ...COUNTED, remaining: 2, undone: 1 }] });
  assert.deepEqual(undoTexts(plain.$), ['Partly undone: 1 of 3 files undone, 2 still to undo.', 'Continue the undo']);
});

test('a counting server: undone with the time, and how many files had no backup', async () => {
  const h = await harness({ points: [{ ...COUNTED, undoneAt: UNDONE_AT, remaining: 0, undone: 1, unrestorable: 2 }] });
  const text = `These changes were undone at ${formatWhen(UNDONE_AT)}. 2 files had no backup and stayed as the run left them.`;
  assert.deepEqual(undoTexts(h.$), [text]);
  assert.equal(h.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`);
  assert.equal(changesText(h), `${text} ${AS_DONE}`);
  const timeless = await harness({ points: [{ ...COUNTED, remaining: 0, undone: 3 }] });
  assert.deepEqual(undoTexts(timeless.$), ['These changes were undone.']);
});

test('a counting server: undoneAt on a point nothing could be undone from is no undo; it only dates a real one', async () => {
  const run = { runId: 'r1', over: true, team: true };
  const settled = { ...COUNTED, files: 1, undoneAt: UNDONE_AT, remaining: 0, undone: 0, unrestorable: 1 };
  const h = await harness({ points: [settled] });
  const text = 'These changes cannot be undone: no backup exists for the file.';
  assert.deepEqual(undoTexts(h.$), [text]);
  assert.equal(shown(h.$('rail-undo-run')), false);
  assert.equal(h.$('rail-outcome-files-text').textContent, `1 file changed in ${FOLDER} · cannot be undone`);
  assert.equal(changesText(h), text);
  assert.equal(undoState(run, [{ ...settled, unreadable: false }]), 'unrestorable');
  const real = await harness({ points: [{ ...settled, files: 3, undone: 2 }] });
  const done = `These changes were undone at ${formatWhen(UNDONE_AT)}. 1 file had no backup and stayed as the run left it.`;
  assert.deepEqual(undoTexts(real.$), [done]);
  assert.equal(real.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`);
  assert.equal(changesText(real), `${done} ${AS_DONE}`);
  const old = await harness({ points: [{ ...POINT, undoneAt: UNDONE_AT, remaining: 0 }] });
  assert.deepEqual(undoTexts(old.$), [`These changes were undone at ${formatWhen(UNDONE_AT)}.`], 'an older server: undoneAt still decides');
});

test('an older server without the two counts, or with only one of them: remaining alone decides, as before', async () => {
  const doc = parseRestorePoints({ points: [{ ...POINT, remaining: 1 }, { ...POINT, runId: 'r0', remaining: 2, undone: 0 }] });
  assert.deepEqual(doc.points.map(Object.keys), [Object.keys({ ...POINT, unreadable: false }), Object.keys({ ...POINT, unreadable: false })]);
  const h = await harness({ points: [{ ...POINT, remaining: 2, unrestorable: 1 }] });
  assert.deepEqual(undoTexts(h.$), ['Partly undone: 2 of 3 files kept as they are.', 'Continue the undo']);
  const none = await harness({ points: [{ ...POINT, remaining: 0 }] });
  assert.deepEqual(undoTexts(none.$), ['These changes were undone.']);
  assert.equal(none.$('rail-outcome-files-text').textContent, `3 files changed in ${FOLDER} · undone`);
});
