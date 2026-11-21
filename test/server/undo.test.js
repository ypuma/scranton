import './docker-model-env.js';
import { modelWindows } from './model-windows-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { prepareRestorePoint } from '../../src/core/restore-points.js';
import { acquireRunLease, releaseRunLease } from '../../src/core/run-lease.js';

async function fixture(t, { single = false, runner } = {}) {
  const root = path.resolve('.scratch/usability/fix6/server'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-')), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'ws'), projectsRoot = path.join(dir, 'default-projects'); fs.mkdirSync(workspace);
  const registry = createProjectRegistry({ dataDir, projectsRoot }), project = registry.addProject({ name: 'Undo', workspace });
  const team = registry.createChat(project.id), sibling = registry.createChat(project.id), pipeline = registry.createChat(project.id, { engine: 'pipeline' });
  const srv = await startVisualizerServer({ ...(single ? { hiveDir: path.join(dir, 'single') } : { dataDir }), publicDir: dir, port: 0, projectsRoot, control: { auth: { close() {} }, modelWindows, ...(runner ? { runner } : {}) } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = (chat = team) => `/api/projects/${project.id}/chats/${chat.id}`;
  const req = async (route, body, headers = {}, raw = false) => {
    const res = await fetch(srv.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  const point = (runId, chat = team, date = '2026-01-01T00:00:00.000Z') => {
    const initial = new Map([['old.txt', { data: Buffer.from('before'), mode: '100644' }]]), after = new Map([['new.txt', { data: Buffer.from('new'), mode: '100644' }]]);
    prepareRestorePoint({ hiveDir: chat.hiveDir, workspace, runId, changes: ['old.txt', 'new.txt'], before: initial, initial, after }).commit();
    fs.rmSync(path.join(workspace, 'old.txt'), { force: true }); fs.writeFileSync(path.join(workspace, 'new.txt'), 'new');
    const file = path.join(chat.hiveDir, 'restore-points', runId, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file)); manifest.createdAt = date; fs.writeFileSync(file, JSON.stringify(manifest));
  };
  return { dir, registry, project, team, sibling, pipeline, workspace, projectsRoot, srv, req, scope, point };
}

test('restore points list exact public shape newest first, isolate chats and include empty Pipeline', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.req(f.scope() + '/restore-points'), { status: 200, value: { points: [] } });
  f.point('old'); f.point('new', f.team, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(await f.req(f.scope() + '/restore-points'), { status: 200, value: { points: [
    { runId: 'new', createdAt: '2026-01-02T00:00:00.000Z', files: 2, undoneAt: null, remaining: 2, undone: 0, unrestorable: 0 },
    { runId: 'old', createdAt: '2026-01-01T00:00:00.000Z', files: 2, undoneAt: null, remaining: 2, undone: 0, unrestorable: 0 }
  ] } });
  for (const chat of [f.sibling, f.pipeline]) {
    assert.deepEqual(await f.req(f.scope(chat) + '/restore-points'), { status: 200, value: { points: [] } });
    assert.deepEqual(await f.req(f.scope(chat) + '/undo', {}), { status: 404, value: { error: 'No restore point available' } });
  }
});

test('undo route restores and removes real files, returns conflicts, defaults to newest and forwards force', async (t) => {
  const f = await fixture(t); f.point('run1');
  fs.writeFileSync(path.join(f.workspace, 'new.txt'), 'user edit');
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 200, value: { runId: 'run1', restored: ['old.txt'], removed: [], conflicts: [{ path: 'new.txt', reason: 'File no longer matches what the run wrote', code: 'changed' }], warnings: [] } });
  assert.equal(fs.readFileSync(path.join(f.workspace, 'old.txt'), 'utf8'), 'before');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'new.txt'), 'utf8'), 'user edit');
  assert.deepEqual(await f.req(f.scope() + '/undo', { runId: 'run1', force: true }), { status: 200, value: { runId: 'run1', restored: [], removed: ['new.txt'], conflicts: [], warnings: [] } });
  assert.equal(fs.existsSync(path.join(f.workspace, 'new.txt')), false);
  const points = (await f.req(f.scope() + '/restore-points')).value.points; assert.ok(points[0].undoneAt);
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 404, value: { error: 'No restore point available' } });
});

test('undo guards, strict bodies and unknown scopes match context routes', async (t) => {
  const f = await fixture(t); f.point('run1');
  for (const [route, body] of [[f.scope() + '/restore-points'], [f.scope() + '/undo', {}]]) {
    assert.equal((await f.req(route, body, { 'X-Scranton-Client': '' })).status, 403);
    assert.equal((await f.req(route, body, { Origin: 'https://foreign.test' })).status, 403);
    assert.equal((await f.req(route.replace(f.team.id, 'missing'), body)).status, 404);
    assert.equal((await f.req(route.replace(f.project.id, 'missing'), body)).status, 404);
  }
  for (const body of [null, [], { other: 1 }, { runId: null }, { runId: '' }, { runId: '../escape' }, { runId: 1 }, { force: 'true' }, { force: null }]) assert.equal((await f.req(f.scope() + '/undo', body)).status, 400, JSON.stringify(body));
  assert.equal((await f.req(f.scope() + '/undo', '{broken', {}, true)).status, 400);
  assert.equal((await f.req(f.scope() + '/undo', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.req(f.scope() + '/undo', ' '.repeat(262145), {}, true)).status, 413);
  assert.equal((await f.req(f.scope() + '/undo')).status, 404);
  assert.equal((await f.req(f.scope() + '/restore-points', {})).status, 404);
  assert.equal((await f.req(f.scope() + '/undo', { runId: 'absent', force: false })).status, 404);
});

test('undo refuses unknown and live owners even with force', async (t) => {
  const f = await fixture(t); f.point('run1');
  const lease = acquireRunLease(f.team.hiveDir, { runId: 'owned' });
  for (const alive of [false, true]) {
    if (alive) fs.writeFileSync(path.join(f.team.hiveDir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: 'owned', pid: process.pid, at: new Date().toISOString() }));
    assert.deepEqual(await f.req(f.scope() + '/undo', { force: true }), { status: 409, value: { error: alive ? 'A run is active in this chat; stop it before undo.' : 'This chat needs recovery before undo.' } });
    assert.equal(fs.existsSync(path.join(f.workspace, 'new.txt')), true);
  }
  releaseRunLease(f.team.hiveDir, lease.token);
});

test('undo refuses an active controller even if its lease is absent', async (t) => {
  let child, options;
  const f = await fixture(t, { runner(_exe, _args, opts) { options = opts; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; } });
  assert.equal((await f.req(f.scope() + '/runs', { request: 'build', trustedHost: true })).status, 202);
  releaseRunLease(f.team.hiveDir, options.env.SCRANTON_RUN_LEASE);
  try { assert.equal((await f.req(f.scope() + '/undo', { force: true })).status, 409); }
  finally { child.emit('close', 0); }
});

test('projectsRoot comes from the registry default or override and is read only', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.req('/api/projects')).value.projectsRoot, f.projectsRoot);
  assert.equal(f.registry.projectsRoot, f.projectsRoot);
  assert.throws(() => { f.registry.projectsRoot = 'elsewhere'; }, TypeError);
  const registry = createProjectRegistry({ dataDir: path.join(f.dir, 'other') });
  assert.equal(registry.projectsRoot, path.join(os.homedir(), 'Documents', 'Scranton', 'projects'));
});

test('restore routes are registry only', async (t) => {
  const f = await fixture(t, { single: true });
  for (const [suffix, body] of [['/restore-points'], ['/undo', {}]]) assert.equal((await f.req('/api/projects/default/chats/default' + suffix, body)).status, 404);
});

test('fix2: unreadable points have null public fields and cannot block a usable point', async (t) => {
  const f = await fixture(t); f.point('good');
  const dir = path.join(f.team.hiveDir, 'restore-points/bad'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'manifest.json'), '{bad');
  const listing = await f.req(f.scope() + '/restore-points');
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.value.points.find((p) => p.runId === 'bad'), { runId: 'bad', unreadable: true, createdAt: null, files: null, undoneAt: null, remaining: null });
  assert.equal(listing.value.points.find((p) => p.runId === 'good').remaining, 2);
  assert.equal((await f.req(f.scope() + '/undo', {})).status, 200);
});

test('fix2: undo 409 sentences distinguish own live/recovery, sibling and newer points', async (t) => {
  const f = await fixture(t); f.point('older'); f.point('newer', f.team, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(await f.req(f.scope() + '/undo', { runId: 'older', force: true }), { status: 409, value: { error: 'Newer runs must be undone first: newer. A run stays open while files changed after it are kept; force its undo or leave both.' } });
  const other = acquireRunLease(f.sibling.hiveDir, { runId: 'other' });
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 409, value: { error: 'A run is active in another chat of this project; stop or recover it before undo.' } });
  releaseRunLease(f.sibling.hiveDir, other.token);
  const own = acquireRunLease(f.team.hiveDir, { runId: 'own' });
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 409, value: { error: 'This chat needs recovery before undo.' } });
  fs.writeFileSync(path.join(f.team.hiveDir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: 'own', pid: process.pid, at: new Date().toISOString() }));
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 409, value: { error: 'A run is active in this chat; stop it before undo.' } });
  releaseRunLease(f.team.hiveDir, own.token);
});

test('fix2: unreadable sibling metadata does not hide its owned hive', async (t) => {
  const f = await fixture(t); f.point('good');
  fs.writeFileSync(path.join(f.dir, 'data/projects', f.project.id, 'chats', f.sibling.id, 'chat.json'), '{broken');
  const lease = acquireRunLease(f.sibling.hiveDir, { runId: 'other' });
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 409, value: { error: 'A run is active in another chat of this project; stop or recover it before undo.' } });
  releaseRunLease(f.sibling.hiveDir, lease.token);
});

test('fix3 item1: route names a live undo for both undo and run', async (t) => {
  const f = await fixture(t); f.point('run');
  const lease = acquireRunLease(f.team.hiveDir, { runId: 'undo-live', mode: 'undo' });
  fs.writeFileSync(path.join(f.team.hiveDir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: new Date().toISOString() }));
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 409, value: { error: 'An undo is already running in this chat.' } });
  assert.deepEqual(await f.req(f.scope() + '/runs', { request: 'next', trustedHost: true }), { status: 409, value: { error: 'An undo is running in this chat; wait for it to finish or recover it before starting a run.' } });
  releaseRunLease(f.team.hiveDir, lease.token);
});

test('fix3 item2: route returns directory warnings and a settled point', async (t) => {
  const f = await fixture(t), name = 'nested/file', after = new Map([[name, { data: Buffer.from('new'), mode: '100644' }]]);
  prepareRestorePoint({ hiveDir: f.team.hiveDir, workspace: f.workspace, runId: 'run', changes: [name], before: new Map(), initial: new Map(), after }).commit();
  fs.mkdirSync(path.join(f.workspace, 'nested')); fs.writeFileSync(path.join(f.workspace, name), 'new');
  const remove = fs.rmdirSync;
  const mock = t.mock.method(fs, 'rmdirSync', (file, ...args) => { if (file === path.join(f.workspace, 'nested')) throw Object.assign(Error('busy'), { code: 'EBUSY' }); return remove(file, ...args); });
  const result = await f.req(f.scope() + '/undo', {}); mock.mock.restore();
  assert.deepEqual(result, { status: 200, value: { runId: 'run', restored: [], removed: [name], conflicts: [], warnings: ['Cannot safely remove directory: nested (EBUSY).'] } });
  const p = (await f.req(f.scope() + '/restore-points')).value.points[0]; assert.ok(p.undoneAt); assert.equal(p.remaining, 0);
});

test('fix3 item3: route refuses force beside a newer unreadable entry', async (t) => {
  const f = await fixture(t); f.point('good');
  const dir = path.join(f.team.hiveDir, 'restore-points/bad'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'manifest.json'), '{bad');
  fs.utimesSync(dir, new Date('2099-01-01'), new Date('2099-01-01'));
  assert.deepEqual(await f.req(f.scope() + '/undo', { runId: 'good', force: true }), { status: 409, value: { error: 'Cannot force undo while newer restore point bad is unreadable.' } });
  assert.equal((await f.req(f.scope() + '/undo', { runId: 'good' })).status, 200);
});

test('fix4: undo route carries blocked code in a 200 body and keeps the point retryable', async (t) => {
  const f = await fixture(t); f.point('run');
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', (file, ...args) => { if (file === path.join(f.workspace, 'new.txt')) throw Object.assign(Error('locked'), { code: 'EBUSY' }); return unlink(file, ...args); });
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 200, value: { runId: 'run', restored: ['old.txt'], removed: [], conflicts: [{ path: 'new.txt', reason: 'Could not restore the file (EBUSY); check the path and permissions, close programs using it and undo again', code: 'blocked' }], warnings: [] } });
  const p = (await f.req(f.scope() + '/restore-points')).value.points[0]; assert.equal(p.undoneAt, null); assert.equal(p.remaining, 1);
  mock.mock.restore();
  assert.deepEqual(await f.req(f.scope() + '/undo', {}), { status: 200, value: { runId: 'run', restored: [], removed: ['new.txt'], conflicts: [], warnings: [] } });
});

test('fix6 B: GET counts undone and permanently damaged backups separately', async (t) => {
  const f = await fixture(t); f.point('run');
  const dir = path.join(f.team.hiveDir, 'restore-points/run'), p = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  fs.unlinkSync(path.join(dir, p.files.find((e) => e.path === 'old.txt').preimage));
  const result = await f.req(f.scope() + '/undo', {});
  assert.deepEqual(result.value.conflicts, [{ path: 'old.txt', reason: 'Invalid pre-image', code: 'unrestorable' }]);
  const listed = (await f.req(f.scope() + '/restore-points')).value.points[0];
  assert.deepEqual(listed, { runId: 'run', createdAt: '2026-01-01T00:00:00.000Z', files: 2, undoneAt: listed.undoneAt, remaining: 0, undone: 1, unrestorable: 1 });
  assert.ok(listed.undoneAt);
});
