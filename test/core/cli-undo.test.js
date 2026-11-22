import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, HELP } from '../../src/core/cli.js';
import { acquireRunLease, releaseRunLease } from '../../src/core/run-lease.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { prepareRestorePoint } from '../../src/core/restore-points.js';
import { formatRunSummary, quotePathArgument } from '../../src/core/run-summary.js';

const root = path.resolve('.scratch/usability/fix7/cli-undo');
fs.mkdirSync(root, { recursive: true });
const previous = process.env.SCRANTON_ISOLATION_ROOT;
process.env.SCRANTON_ISOLATION_ROOT = path.join(root, 'isolation');
after(() => { if (previous === undefined) delete process.env.SCRANTON_ISOLATION_ROOT; else process.env.SCRANTON_ISOLATION_ROOT = previous; });
const entry = (text) => ({ data: Buffer.from(text), mode: '100644' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, 'test-')), hive = path.join(dir, 'hive'), ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const io = { cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PI_CODING_AGENT_DIR: path.join(dir, 'pi'), SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), SCRANTON_FAKE_MODE: '1', SCRANTON_ISOLATION_ROOT: path.join(dir, 'iso'), SCRANTON_FAKE_DELAY_MS: '0', SCRANTON_FAKE_DETERMINISTIC: '1', SCRANTON_FAKE_SCENARIO: 'happy' }, out: '', err: '', stdout: { write(s) { io.out += s; } }, stderr: { write(s) { io.err += s; } } };
  const run = () => runCli(['run', 'build', '--no-plan', '--trusted-host', '--workspace', ws, '--hive', hive], io);
  const undo = (...args) => { io.out = ''; io.err = ''; return runCli(['undo', '--hive', hive, ...args], io); };
  return { dir, hive, ws, io, run, undo };
}
function point(f, runId = 'fixture-run') {
  const initial = new Map([['old.txt', entry('before')], ['deleted.txt', entry('keep')]]), integrated = new Map([['old.txt', entry('after')], ['new.txt', entry('new')]]);
  const restore = prepareRestorePoint({ hiveDir: f.hive, runId, workspace: f.ws, changes: ['old.txt', 'deleted.txt', 'new.txt'], before: initial, initial, after: integrated });
  for (const [name, value] of integrated) fs.writeFileSync(path.join(f.ws, name), value.data);
  restore.commit();
  return { initial, integrated };
}

test('undo help and usage validate options before any mutation', async (t) => {
  const f = fixture(t);
  assert.ok(HELP.includes('scranton undo [--hive DIR | --data DIR --project ID --chat ID] [--run ID] [--force] [--list]'));
  for (const args of [['positional'], ['--list', '--force'], ['--run', '../bad'], ['--data', f.dir]]) assert.equal(await f.undo(...args), 2);
  assert.equal(await runCli(['doctor', '--force'], f.io), 2);
});

test('fake run summary names exact undo command; list and default undo remove its new file', async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 0, f.io.err);
  const state = JSON.parse(fs.readFileSync(path.join(f.hive, 'state.json')));
  assert.ok(f.io.err.includes(`Undo: scranton undo --hive ${quotePathArgument(f.hive)} --run ${state.runId}`));
  assert.equal(await f.undo('--list'), 0);
  assert.match(f.io.out, new RegExp(`${state.runId} \\| .* \\| 1 files \\| 1 remaining \\| files still to undo`));
  assert.equal(await f.undo(), 0, f.io.err);
  assert.match(f.io.out, /Removed: todo.js/);
  assert.equal(fs.existsSync(path.join(f.ws, 'todo.js')), false);
  await f.undo('--list'); assert.match(f.io.out, /\| undone/);
});

test('undo prints restored and removed paths, preserves later edits and force is explicit', async (t) => {
  const f = fixture(t); point(f);
  fs.writeFileSync(path.join(f.ws, 'old.txt'), 'user edit');
  assert.equal(await f.undo('--run', 'fixture-run'), 1);
  assert.match(f.io.out, /Restored: deleted.txt/); assert.match(f.io.out, /Removed: new.txt/);
  assert.match(f.io.err, /Conflict: old.txt: File no longer matches what the run wrote; to overwrite later edits/);
  assert.ok(f.io.err.includes(`scranton undo --hive ${quotePathArgument(f.hive)} --run fixture-run --force`));
  assert.equal(fs.readFileSync(path.join(f.ws, 'old.txt'), 'utf8'), 'user edit');
  assert.equal(await f.undo('--run', 'fixture-run', '--force'), 0);
  assert.equal(fs.readFileSync(path.join(f.ws, 'old.txt'), 'utf8'), 'before');
});

test('undo failures are one readable line with next command; busy and recovery leases are retained', async (t) => {
  const f = fixture(t);
  assert.equal(await f.undo(), 1);
  assert.ok(f.io.err.includes(`No restore point available; inspect with scranton undo --hive ${quotePathArgument(f.hive)} --list.`));
  assert.equal(f.io.err.trim().split('\n').length, 1);
  point(f);
  const lease = acquireRunLease(f.hive, { runId: 'busy' });
  for (const alive of [false, true]) {
    if (alive) fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: 'busy', pid: process.pid, at: new Date().toISOString() }));
    assert.equal(await f.undo('--force'), 1);
    assert.ok(f.io.err.includes(`scranton recover --hive ${quotePathArgument(f.hive)}`));
    assert.equal(f.io.err.trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(path.join(f.ws, 'old.txt'), 'utf8'), 'after');
  }
  releaseRunLease(f.hive, lease.token);
});

test('registry undo resolves the same existing chat and default data folder as recover', async (t) => {
  const f = fixture(t); f.io.env.APPDATA = path.join(f.dir, 'appdata');
  const data = path.join(f.io.env.APPDATA, 'dev.scranton.desktop'), registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Undo', workspace: f.ws }), chat = registry.createChat(project.id);
  point({ ...f, hive: chat.hiveDir });
  assert.equal(await runCli(['undo', '--project', project.id, '--chat', chat.id], f.io), 0, f.io.err);
  assert.match(f.io.out, /Restored: old.txt/);
  assert.equal(registry.listChats(project.id).length, 1);
});

function git(ws, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], { cwd: ws, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
test('run preflight reports repository presence without inspecting Git status', async (t) => {
  const plain = fixture(t); assert.equal(await plain.run(), 0, plain.io.err);
  assert.match(plain.io.err, /Workspace is inside a Git repository/);
  assert.match(plain.io.err, /A restore point is kept for integrated changes; scranton undo/);
  for (const dirty of [false, true]) {
    const f = fixture(t); git(f.ws, 'init');
    fs.writeFileSync(path.join(f.ws, 'tracked.txt'), 'initial'); git(f.ws, 'add', '.');
    git(f.ws, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'fixture');
    if (dirty) { fs.writeFileSync(path.join(f.ws, 'tracked.txt'), 'edited'); fs.writeFileSync(path.join(f.ws, 'untracked.txt'), 'user'); }
    assert.equal(await f.run(), 0, f.io.err);
    assert.match(f.io.err, /Workspace is inside a Git repository; existing files are the starting point \(Git status is not inspected\)/);
    assert.doesNotMatch(f.io.err, /\d+ uncommitted|\d+ untracked/);
  }
});

test('shared runs warn about direct writes; private standalone never promises undo', async (t) => {
  const f = fixture(t), config = path.join(f.dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ execution: { isolation: 'shared', maxParallel: 1, sandbox: { mode: 'host' } } }));
  assert.equal(await runCli(['run', 'build', '--no-plan', '--trusted-host', '--config', config, '--workspace', f.ws, '--hive', f.hive], f.io), 0, f.io.err);
  assert.match(f.io.err, /This mode writes directly into the workspace; no restore point is kept/);
  assert.doesNotMatch(f.io.err, /Undo: scranton|A restore point is kept/);
  const a = fixture(t);
  assert.equal(await runCli(['agent', 'dwight', 'build', '--trusted-host', '--workspace', a.ws, '--hive', a.hive], a.io), 0, a.io.err);
  assert.doesNotMatch(a.io.err, /Undo: scranton|A restore point is kept/);
});

test('summary never promises undo for missing, foreign, undone or unchanged restore points', (t) => {
  const f = fixture(t), worktrees = point(f);
  const run = { runId: 'different', config: { hiveDir: f.hive }, rec: { state: {} }, worktrees };
  assert.doesNotMatch(formatRunSummary(run, { status: 'success' }, 0), /Undo:/);
  run.runId = 'fixture-run'; assert.match(formatRunSummary(run, { status: 'success' }, 0), /Undo: scranton undo/);
  const file = path.join(f.hive, 'restore-points/fixture-run/manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.undoneAt = new Date().toISOString(); for (const e of manifest.files) e.undoneAt = manifest.undoneAt; fs.writeFileSync(file, JSON.stringify(manifest));
  assert.doesNotMatch(formatRunSummary(run, { status: 'success' }, 0), /Undo:/);
  fs.rmSync(file);
  assert.doesNotMatch(formatRunSummary(run, { status: 'success' }, 0), /Undo:/);
  run.worktrees = { initial: worktrees.initial, integrated: worktrees.initial };
  assert.doesNotMatch(formatRunSummary(run, { status: 'success' }, 0), /Undo:/);
});

test('fix2: printed paths preserve spaces and UNC backslashes with one quoting helper', async () => {
  const { quotePathArgument } = await import('../../src/core/run-summary.js');
  for (const value of ['C:\\project folder\\hive', '\\\\server\\share\\hive', 'plain']) assert.equal(quotePathArgument(value, 'win32'), '"' + value + '"');
});

test('fix2: registry undo refuses other chat ownership; list shows remaining and unreadable', async (t) => {
  const f = fixture(t), data = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir: data });
  const p = registry.addProject({ name: 'Siblings', workspace: f.ws }), chat = registry.createChat(p.id), sibling = registry.createChat(p.id);
  point({ ...f, hive: chat.hiveDir });
  acquireRunLease(sibling.hiveDir, { runId: 'other' });
  assert.equal(await runCli(['undo', '--data', data, '--project', p.id, '--chat', chat.id], f.io), 1);
  assert.match(f.io.err, /A run is active in another chat of this project/);
  fs.mkdirSync(path.join(chat.hiveDir, 'restore-points/broken')); fs.writeFileSync(path.join(chat.hiveDir, 'restore-points/broken/manifest.json'), '{broken');
  f.io.out = ''; f.io.err = '';
  assert.equal(await runCli(['undo', '--data', data, '--project', p.id, '--chat', chat.id, '--list'], f.io), 0);
  assert.match(f.io.out, /broken \| unreadable/); assert.match(f.io.out, /3 remaining/);
});

test('fix3 item1: live undo is named by both undo and run refusals', async (t) => {
  const f = fixture(t); point(f);
  const lease = acquireRunLease(f.hive, { runId: 'undo-live', mode: 'undo' });
  fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: new Date().toISOString() }));
  assert.equal(await f.undo(), 1); assert.match(f.io.err, /An undo is already running in this chat\./);
  f.io.err = ''; assert.equal(await f.run(), 1); assert.match(f.io.err, /An undo is running in this chat; wait for it to finish or recover it before starting a run\./);
  releaseRunLease(f.hive, lease.token);
});

test('fix3 item1: a second undo continues per-file bookkeeping after undo recovery', async (t) => {
  const f = fixture(t); point(f);
  const file = path.join(f.hive, 'restore-points/fixture-run/manifest.json'), p = JSON.parse(fs.readFileSync(file));
  p.files.find((e) => e.path === 'old.txt').undoPending = true;
  fs.writeFileSync(file, JSON.stringify(p)); fs.writeFileSync(path.join(f.ws, 'old.txt'), 'before');
  const saved = fs.readFileSync(file), lease = acquireRunLease(f.hive, { runId: 'undo-crash', mode: 'undo' });
  fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: 2147483647, at: '2000-01-01T00:00:00Z' }));
  assert.equal(await runCli(['recover', '--hive', f.hive], f.io), 0, f.io.err);
  assert.deepEqual(fs.readFileSync(file), saved);
  assert.equal(await f.undo(), 0, f.io.err);
  assert.equal(JSON.parse(fs.readFileSync(file)).files.some((e) => e.undoPending), false);
  assert.equal(fs.readFileSync(path.join(f.ws, 'deleted.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(f.ws, 'new.txt')), false);
});

test('fix4: undo prints blocked files separately without suggesting force and retries', async (t) => {
  const f = fixture(t); point(f);
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', (file, ...args) => { if (file === path.join(f.ws, 'new.txt')) throw Object.assign(Error('locked'), { code: 'EBUSY' }); return unlink(file, ...args); });
  assert.equal(await f.undo(), 1);
  assert.equal(f.io.err, 'Blocked: new.txt: Could not restore the file (EBUSY); check the path and permissions, close programs using it and undo again.\n');
  assert.doesNotMatch(f.io.err, /--force|changed after|Conflict:/);
  assert.equal(fs.readFileSync(path.join(f.ws, 'new.txt'), 'utf8'), 'new');
  mock.mock.restore();
  assert.equal(await f.undo(), 0, f.io.err); assert.match(f.io.out, /Removed: new.txt/);
});

test('fix5: a live undo hint waits and makes recovery conditional on the process being gone', async (t) => {
  const f = fixture(t); point(f);
  const lease = acquireRunLease(f.hive, { runId: 'undo-live', mode: 'undo' });
  fs.writeFileSync(path.join(f.hive, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: lease.runId, pid: process.pid, at: new Date().toISOString() }));
  try {
    assert.equal(await f.undo(), 1);
    assert.ok(f.io.err.includes(`wait for the undo to finish; only if its process is gone: scranton recover --hive ${quotePathArgument(f.hive)}`), f.io.err);
    assert.doesNotMatch(f.io.err, /inspect with/);
  } finally { releaseRunLease(f.hive, lease.token); }
});

test('fix5: a sibling run hint names the other run rather than this chat list', async (t) => {
  const f = fixture(t), data = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir: data });
  const p = registry.addProject({ name: 'Siblings', workspace: f.ws }), chat = registry.createChat(p.id), sibling = registry.createChat(p.id);
  point({ ...f, hive: chat.hiveDir }); const lease = acquireRunLease(sibling.hiveDir, { runId: 'other' });
  try {
    assert.equal(await runCli(['undo', '--data', data, '--project', p.id, '--chat', chat.id], f.io), 1);
    assert.match(f.io.err, /wait for or stop the run in the other chat; recover that chat only if its process is gone/);
    assert.doesNotMatch(f.io.err, /--list|inspect with/);
  } finally { releaseRunLease(sibling.hiveDir, lease.token); }
});

function backupLimitedPoint(f, count = 0) {
  const initial = new Map([['large', { ...entry(''), data: Buffer.alloc(16 * 1024 * 1024 + 1) }]]);
  for (let i = 0; i < count; i++) initial.set(`small-${i}`, entry('before'));
  const integrated = new Map([...initial.keys()].map((name) => [name, entry('after')]));
  prepareRestorePoint({ hiveDir: f.hive, runId: 'limited', workspace: f.ws, changes: [...initial.keys()], before: initial, initial, after: integrated }).commit();
  for (const [name, e] of integrated) fs.writeFileSync(path.join(f.ws, name), e.data);
  return { initial, integrated };
}

test('fix6 B: list never calls files without backups undone and describes partial undo honestly', async (t) => {
  const f = fixture(t); backupLimitedPoint(f, 2);
  await f.undo('--list'); assert.match(f.io.out, /2 remaining \| files still to undo; no backup for 1 file/); assert.doesNotMatch(f.io.out, /partly undone/);
  fs.writeFileSync(path.join(f.ws, 'small-1'), 'human'); await f.undo();
  await f.undo('--list'); assert.match(f.io.out, /1 remaining \| partly undone \(1 of 3\); no backup for 1 file/);
  await f.undo('--force'); await f.undo('--list'); assert.match(f.io.out, /0 remaining \| undone; no backup for 1 file/);
  const only = fixture(t); backupLimitedPoint(only);
  await only.undo('--list'); assert.match(only.io.out, /0 remaining \| nothing can be undone \(no backup for 1 file\)/); assert.doesNotMatch(only.io.out, /\| undone/);
  assert.equal(await only.undo(), 1); assert.match(only.io.out, /Nothing could be undone: no backup for 1 file\./); assert.match(only.io.err, /Pre-image exceeds 16777216 bytes/);
});

test('fix6 B: summary offers undo only for open files and warns about absent backups', async (t) => {
  for (const count of [0, 2]) {
    const f = fixture(t), worktrees = backupLimitedPoint(f, count);
    const summary = formatRunSummary({ runId: 'limited', config: { hiveDir: f.hive }, rec: { state: {} }, worktrees }, { status: 'success' }, 0);
    assert.match(summary, /Not restorable: 1 file has no backup\./);
    if (count) assert.match(summary, /Undo: scranton undo/); else assert.doesNotMatch(summary, /Undo:/);
  }
});

for (const [remaining, undone, unrestorable, state] of [
  [3, 0, 0, 'files still to undo'],
  [2, 0, 1, 'files still to undo; no backup for 1 file'],
  [2, 1, 0, 'partly undone (1 of 3)'],
  [1, 1, 1, 'partly undone (1 of 3); no backup for 1 file'],
  [0, 3, 0, 'undone'],
  [0, 2, 1, 'undone; no backup for 1 file'],
  [0, 0, 3, 'nothing can be undone (no backup for 3 files)']
]) test(`fix7: list describes ${state} independently of the point timestamp`, async (t) => {
  const f = fixture(t); point(f);
  const file = path.join(f.hive, 'restore-points/fixture-run/manifest.json'), p = JSON.parse(fs.readFileSync(file));
  const timestamp = '2026-01-01T00:00:00Z';
  for (let i = 0; i < p.files.length; i++) {
    if (i < undone) p.files[i].undoneAt = timestamp;
    else if (i < undone + unrestorable) p.files[i].undoUnrestorable = 'Invalid pre-image';
  }
  for (const undoneAt of [null, timestamp]) {
    p.undoneAt = undoneAt; fs.writeFileSync(file, JSON.stringify(p));
    assert.equal(await f.undo('--list'), 0, f.io.err);
    assert.equal(f.io.out.trim(), `fixture-run | ${p.createdAt} | 3 files | ${remaining} remaining | ${state}`);
  }
});
