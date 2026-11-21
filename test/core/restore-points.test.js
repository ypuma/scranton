import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { WorktreeManager } from '../../src/core/worktree.js';
import { listRestorePoints, undoRun, workspaceState, prepareRestorePoint, MAX_PREIMAGE_BYTES } from '../../src/core/restore-points.js';

const scratch = path.resolve('.scratch/usability/fix4/restore');
fs.mkdirSync(scratch, { recursive: true });
const write = (dir, name, data) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const git = (dir, ...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], { windowsHide: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'point-'));
  const workspace = path.join(root, 'workspace'), hiveDir = path.join(root, 'hive');
  fs.mkdirSync(workspace); fs.mkdirSync(hiveDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, hiveDir };
}
async function manager(t, f, runId = 'run') {
  const m = new WorktreeManager({ ...f, runId }); await m.init(); t.after(() => m.close()); return m;
}
async function integrate(m, milestoneId, edit) {
  const d = await m.createWorktree({ agent: 'dwight', milestoneId }); edit(d.dir);
  await m.snapshotWorktree({ agent: 'dwight', milestoneId }); await m.createQaWorktree({ milestoneId });
  return m.integrateToTarget({ milestoneId });
}
const manifestPath = (f, runId = 'run') => path.join(f.hiveDir, 'restore-points', runId, 'manifest.json');
const manifest = (f, runId) => JSON.parse(fs.readFileSync(manifestPath(f, runId), 'utf8'));
const entry = (text) => ({ data: Buffer.from(text), mode: '100644', permissions: 0o644 });
function record(f, runId, name = 'file', before = entry('before'), after = entry('after')) {
  const tx = prepareRestorePoint({ ...f, runId, changes: [name], before: new Map([[name, before]]), initial: new Map(before ? [[name, before]] : []), after: new Map(after ? [[name, after]] : []) });
  tx.commit(); return tx;
}

test('dirty Git and plain folders: multi-milestone undo restores first bytes, deletions, creations and nested directories', async (t) => {
  for (const repository of [false, true]) {
    const f = fixture(t);
    write(f.workspace, 'space ü file.txt', 'committed'); write(f.workspace, 'deleted', 'deleted WIP');
    if (repository) { git(f.workspace, 'init', '-q'); git(f.workspace, 'add', '.'); git(f.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base'); }
    write(f.workspace, 'space ü file.txt', 'staged WIP');
    if (repository) git(f.workspace, 'add', 'space ü file.txt');
    write(f.workspace, 'space ü file.txt', 'unstaged WIP'); write(f.workspace, 'untracked', 'untracked WIP');
    const index = repository ? fs.readFileSync(path.join(f.workspace, '.git/index')) : null;
    const head = repository ? git(f.workspace, 'rev-parse', 'HEAD') : null;
    const branch = repository ? git(f.workspace, 'symbolic-ref', 'HEAD') : null;
    const m = await manager(t, f);
    await integrate(m, 'm1', (dir) => { write(dir, 'space ü file.txt', 'first'); fs.unlinkSync(path.join(dir, 'deleted')); write(dir, 'new ü/deep/file', 'created'); write(dir, 'untracked', 'agent'); });
    await integrate(m, 'm2', (dir) => { write(dir, 'space ü file.txt', 'second'); write(dir, 'new ü/deep/file', 'second creation'); });
    const points = listRestorePoints(f.hiveDir);
    assert.equal(points.length, 1); assert.equal(points[0].files, 4); assert.equal(points[0].workspace, f.workspace); assert.equal(points[0].undoneAt, null);
    const stored = manifest(f); assert.equal(stored.files.find((e) => e.path === 'space ü file.txt').lastWritten.size, 6);
    const result = await undoRun({ hiveDir: f.hiveDir });
    assert.deepEqual(result, { runId: 'run', restored: ['deleted', 'space ü file.txt', 'untracked'], removed: ['new ü/deep/file'], conflicts: [], warnings: [] });
    assert.equal(read(f.workspace, 'space ü file.txt'), 'unstaged WIP'); assert.equal(read(f.workspace, 'untracked'), 'untracked WIP'); assert.equal(read(f.workspace, 'deleted'), 'deleted WIP');
    assert.equal(fs.existsSync(path.join(f.workspace, 'new ü')), false);
    assert.ok(listRestorePoints(f.hiveDir)[0].undoneAt);
    assert.deepEqual(await undoRun({ hiveDir: f.hiveDir, runId: 'run' }), { runId: 'run', restored: [], removed: [], conflicts: [], warnings: [] });
    if (repository) { assert.deepEqual(fs.readFileSync(path.join(f.workspace, '.git/index')), index); assert.deepEqual(git(f.workspace, 'rev-parse', 'HEAD'), head); assert.deepEqual(git(f.workspace, 'symbolic-ref', 'HEAD'), branch); }
    else assert.equal(fs.existsSync(path.join(f.workspace, '.git')), false);
  }
});

test('undo preserves user edits, retries only conflicts, and force is explicit', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'WIP'); const m = await manager(t, f);
  await integrate(m, 'm1', (dir) => { write(dir, 'file', 'run'); write(dir, 'new/deep/file', 'new'); });
  write(f.workspace, 'file', 'human'); write(f.workspace, 'new/keep', 'human');
  const result = await undoRun({ hiveDir: f.hiveDir });
  assert.deepEqual(result.conflicts, [{ path: 'file', reason: 'File no longer matches what the run wrote', code: 'changed' }]);
  assert.equal(read(f.workspace, 'file'), 'human'); assert.equal(read(f.workspace, 'new/keep'), 'human');
  assert.equal(listRestorePoints(f.hiveDir)[0].undoneAt, null);
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, runId: 'run', force: true })).restored, ['file']);
  assert.equal(read(f.workspace, 'file'), 'WIP');
});

test('user recreation of a deleted file and deletion of a written file conflict', async (t) => {
  const f = fixture(t); write(f.workspace, 'a', 'A'); write(f.workspace, 'b', 'B'); const m = await manager(t, f);
  await integrate(m, 'm1', (dir) => { fs.unlinkSync(path.join(dir, 'a')); write(dir, 'b', 'changed'); });
  write(f.workspace, 'a', 'human'); fs.unlinkSync(path.join(f.workspace, 'b'));
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).conflicts.map((c) => c.path), ['a', 'b']);
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, force: true })).restored, ['a', 'b']);
});

test('pre-image above the cap is explicitly not restorable, even with force', async (t) => {
  const f = fixture(t); write(f.workspace, 'large', Buffer.alloc(MAX_PREIMAGE_BYTES + 1, 65)); const m = await manager(t, f);
  const integrated = await integrate(m, 'm1', (dir) => write(dir, 'large', 'small'));
  assert.deepEqual(integrated.notRestorable, [{ path: 'large', reason: 'Pre-image exceeds 16777216 bytes' }]);
  const e = manifest(f).files[0]; assert.equal(e.restorable, false); assert.equal(e.reason, 'Pre-image exceeds 16777216 bytes'); assert.equal(e.preimage, null);
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, force: true })).conflicts, [{ path: 'large', reason: e.reason, code: 'unrestorable' }]);
  assert.equal(read(f.workspace, 'large'), 'small');
});

test('newest ten points retained; list is newest first; default undo skips undone points', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) record(f, 'run-' + String(i).padStart(2, '0'));
  const points = listRestorePoints(f.hiveDir); assert.equal(points.length, 10); assert.equal(points[0].runId, 'run-11');
  assert.equal(fs.existsSync(path.dirname(manifestPath(f, 'run-00'))), false);
  write(f.workspace, 'file', 'after'); await undoRun({ hiveDir: f.hiveDir });
  write(f.workspace, 'file', 'after'); assert.equal((await undoRun({ hiveDir: f.hiveDir })).runId, 'run-10');
});

test('no integration changes means no restore point; user integration conflict still writes nothing', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'base'); const m = await manager(t, f);
  await integrate(m, 'm1', () => {}); assert.deepEqual(listRestorePoints(f.hiveDir), []);
  await assert.rejects(integrate(m, 'm2', (dir) => { write(dir, 'file', 'agent'); write(f.workspace, 'file', 'human'); }), /Integration conflict/);
  assert.deepEqual(listRestorePoints(f.hiveDir), []); assert.equal(read(f.workspace, 'file'), 'human');
});

test('restore point disk failure stops integration before workspace writes', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'base'); const m = await manager(t, f);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === manifestPath(f)) throw Error('Restore disk failure'); return rename(from, to); });
  await assert.rejects(integrate(m, 'm1', (dir) => write(dir, 'file', 'agent')), /Restore disk failure/);
  mock.mock.restore(); assert.equal(read(f.workspace, 'file'), 'base');
});

test('rolled back integration keeps last successful output, not the failed candidate', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'base'); const m = await manager(t, f);
  await integrate(m, 'm1', (dir) => write(dir, 'file', 'first'));
  const rename = fs.renameSync; let fail = true;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (fail && to === path.join(f.workspace, 'zzz')) { fail = false; throw Error('Disk failure'); } return rename(from, to); });
  await assert.rejects(integrate(m, 'm2', (dir) => { write(dir, 'file', 'second'); write(dir, 'zzz', 'new'); }), /Disk failure/);
  mock.mock.restore(); assert.equal(manifest(f).files.find((e) => e.path === 'file').lastWritten.size, 5);
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).conflicts, []); assert.equal(read(f.workspace, 'file'), 'base');
});

test('pending journal can undo an interrupted integration from either side of a write', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'before');
  prepareRestorePoint({ ...f, runId: 'run', changes: ['file'], before: new Map([['file', entry('before')]]), initial: new Map([['file', entry('before')]]), after: new Map([['file', entry('after')]]) });
  write(f.workspace, 'file', 'after');
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).restored, ['file']); assert.equal(read(f.workspace, 'file'), 'before');
});

test('unsafe run IDs and manifest traversal never escape workspace or hive', async (t) => {
  const f = fixture(t); record(f, 'run'); write(f.workspace, 'file', 'after');
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: '../escape' }), /Invalid restore/);
  const data = manifest(f); data.files[0].path = '../outside'; fs.writeFileSync(manifestPath(f), JSON.stringify(data));
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, force: true }), /No restore point available/);
  assert.equal(read(f.workspace, 'file'), 'after');
});

test('workspace junction, hive junction, hardlinks and corrupt pre-images are never followed, even with force', async (t) => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); write(outside, 'file', 'outside');
  record(f, 'run', 'nested/file'); fs.symlinkSync(outside, path.join(f.workspace, 'nested'), 'junction');
  assert.equal((await undoRun({ hiveDir: f.hiveDir, force: true })).conflicts.length, 1); assert.equal(read(outside, 'file'), 'outside');
  fs.unlinkSync(path.join(f.workspace, 'nested'));
  const corrupt = fixture(t); record(corrupt, 'run', 'nested/file');
  const e = manifest(corrupt).files[0], blob = path.join(path.dirname(manifestPath(corrupt)), e.preimage);
  fs.writeFileSync(blob, 'corrupt'); write(corrupt.workspace, 'nested/file', 'after');
  assert.match((await undoRun({ hiveDir: corrupt.hiveDir, force: true })).conflicts[0].reason, /pre-image/i);
  const other = fixture(t); fs.symlinkSync(outside, path.join(other.hiveDir, 'restore-points'), 'junction');
  assert.throws(() => record(other, 'run'), /Link\/reparse/);
  assert.equal(fs.existsSync(path.join(outside, 'run')), false);
  const third = fixture(t); record(third, 'run'); fs.linkSync(path.join(outside, 'file'), path.join(third.workspace, 'file'));
  assert.equal((await undoRun({ hiveDir: third.hiveDir, force: true })).conflicts.length, 1); assert.equal(read(outside, 'file'), 'outside');
});

test('undo refuses an owned hive, including force', async (t) => {
  const f = fixture(t); record(f, 'run'); write(f.hiveDir, 'control/owner.json', JSON.stringify({ runId: 'run', token: 'token' }));
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, force: true }), /in use|recovery/);
});

test('workspaceState detects Git without counting dirty or untracked paths', async (t) => {
  const f = fixture(t); git(f.workspace, 'init', '-q'); write(f.workspace, 'space ü', 'base'); git(f.workspace, 'add', '.');
  git(f.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base');
  write(f.workspace, 'space ü', 'dirty'); write(f.workspace, 'new ü', 'untracked');
  assert.deepEqual(await workspaceState(f.workspace), { git: true, dirty: null, untracked: null });
});

test('workspaceState never executes git or throws on invalid input', async (t) => {
  const f = fixture(t); assert.deepEqual(await workspaceState(f.workspace), { git: true, dirty: null, untracked: null });
  const mock = t.mock.method(childProcess, 'execFile', (command, args, options, cb) => { cb(Object.assign(Error('unavailable'), { code: 'ENOENT' })); return { stdin: { end() {}, on() {} } }; });
  assert.deepEqual(await workspaceState(f.workspace), { git: true, dirty: null, untracked: null });
  mock.mock.restore();
  const timeout = t.mock.method(childProcess, 'execFile', (command, args, options, cb) => { assert.ok(options.timeout > 0); cb(Object.assign(Error('timeout'), { killed: true })); return { stdin: { end() {}, on() {} } }; });
  assert.deepEqual(await workspaceState(f.workspace), { git: true, dirty: null, untracked: null }); timeout.mock.restore();
  assert.deepEqual(await workspaceState(null), { git: false, dirty: null, untracked: null });
});

test('pre-image write failure also fails closed before changing the workspace', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'base'); const m = await manager(t, f);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to.includes(path.join('restore-points', 'run', 'preimages'))) throw Error('Pre-image disk failure'); return rename(from, to); });
  await assert.rejects(integrate(m, 'm1', (dir) => write(dir, 'file', 'agent')), /Pre-image disk failure/);
  mock.mock.restore(); assert.equal(read(f.workspace, 'file'), 'base');
});

test('pre-image hardlinks and absolute blob paths fail closed', async (t) => {
  const f = fixture(t); record(f, 'run'); write(f.workspace, 'file', 'after');
  const data = manifest(f), e = data.files[0], blob = path.join(path.dirname(manifestPath(f)), e.preimage);
  const outside = path.join(f.root, 'outside'); write(f.root, 'outside', 'before');
  fs.unlinkSync(blob); fs.linkSync(outside, blob);
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, force: true })).conflicts, [{ path: 'file', reason: 'Invalid pre-image', code: 'unrestorable' }]);
  assert.equal(read(f.workspace, 'file'), 'after');
  data.files[0].preimage = outside; fs.writeFileSync(manifestPath(f), JSON.stringify(data));
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, force: true }), /No restore point available/);
  assert.equal(read(f.workspace, 'file'), 'after');
});

test('missing point, all-undone default, and unchanged permission bits have explicit behavior', async (t) => {
  const f = fixture(t);
  await assert.rejects(undoRun({ hiveDir: f.hiveDir }), /No restore point available/);
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: 'missing' }), /No restore point available/);
  record(f, 'run'); write(f.workspace, 'file', 'after');
  await undoRun({ hiveDir: f.hiveDir });
  await assert.rejects(undoRun({ hiveDir: f.hiveDir }), /No restore point available/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.workspace, 'file')).mode & 0o777, 0o644);
});

test('failure finalizing the first restore manifest rolls integration back and leaves undo usable', async (t) => {
  const f = fixture(t); write(f.workspace, 'file', 'base'); const m = await manager(t, f);
  const rename = fs.renameSync; let manifests = 0;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === manifestPath(f) && ++manifests === 2) throw Error('Final manifest disk failure'); return rename(from, to); });
  await assert.rejects(integrate(m, 'm1', (dir) => write(dir, 'file', 'agent')), /Final manifest disk failure/);
  mock.mock.restore(); assert.equal(read(f.workspace, 'file'), 'base');
  assert.equal((await m.git(['rev-parse', 'refs/heads/integrated'])).toString().trim(), m.integratedRef);
  assert.deepEqual(listRestorePoints(f.hiveDir), []);
  await assert.rejects(undoRun({ hiveDir: f.hiveDir }), /No restore point available/);
});

test('only boolean true is an explicit force override', async (t) => {
  const f = fixture(t); record(f, 'run'); write(f.workspace, 'file', 'human');
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, force: 'false' }), /Invalid force/);
  assert.equal(read(f.workspace, 'file'), 'human');
});

test('incomplete rollback records successful reversions and keeps concurrent user edits conflicting', async (t) => {
  const f = fixture(t); write(f.workspace, 'a', 'A'); write(f.workspace, 'b', 'B'); const m = await manager(t, f);
  await integrate(m, 'm1', (dir) => { write(dir, 'a', 'first'); write(dir, 'b', 'first'); });
  const originalGit = m.git.bind(m);
  m.git = (...args) => { if (args[0][0] === 'update-ref' && args[0][1] === 'refs/heads/integrated') { write(f.workspace, 'b', 'human'); return Promise.reject(Error('Ref write failed')); } return originalGit(...args); };
  await assert.rejects(integrate(m, 'm2', (dir) => { write(dir, 'a', 'second'); write(dir, 'b', 'second'); write(dir, 'zzz', 'new'); }), /rollback incomplete/);
  m.git = originalGit; assert.equal(read(f.workspace, 'a'), 'first');
  assert.equal(manifest(f).files.find((e) => e.path === 'a').lastWritten.size, 5);
  const undone = await undoRun({ hiveDir: f.hiveDir }); assert.deepEqual(undone.conflicts.map((c) => c.path), ['b']);
  assert.equal(read(f.workspace, 'a'), 'A'); assert.equal(read(f.workspace, 'b'), 'human');
});

// Fix round 2 regressions.
test('fix2: unreadable entries are visible, ignored by selection and left by pruning', async (t) => {
  const f = fixture(t);
  write(f.hiveDir, 'restore-points/corrupt/manifest.json', '{bad');
  write(f.hiveDir, 'restore-points/new-version/manifest.json', '{"v":2}');
  write(f.hiveDir, 'restore-points/stray', 'file');
  fs.mkdirSync(path.join(f.hiveDir, 'restore-points/empty'));
  for (let i = 0; i < 12; i++) record(f, 'valid-' + String(i).padStart(2, '0'));
  const points = listRestorePoints(f.hiveDir);
  for (const runId of ['corrupt', 'new-version', 'stray', 'empty']) {
    assert.deepEqual(points.find((p) => p.runId === runId), { runId, unreadable: true, createdAt: null, workspace: null, files: null, undoneAt: null, remaining: null });
    assert.ok(fs.existsSync(path.join(f.hiveDir, 'restore-points', runId)));
  }
  assert.equal(points.filter((p) => !p.unreadable).length, 10);
  write(f.workspace, 'file', 'after');
  assert.equal((await undoRun({ hiveDir: f.hiveDir })).runId, 'valid-11');
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: 'corrupt' }), /unreadable/i);
});

test('fix2: rollback removes an empty point and undo reports only changed paths', async (t) => {
  const f = fixture(t); record(f, 'previous'); write(f.workspace, 'file', 'after');
  const tx = prepareRestorePoint({ ...f, runId: 'rolled-back', changes: ['file'], before: new Map([['file', entry('after')]]), initial: new Map([['file', entry('after')]]), after: new Map([['file', entry('candidate')]]) });
  tx.rollback();
  assert.deepEqual(listRestorePoints(f.hiveDir).map((p) => p.runId), ['previous']);
  assert.equal((await undoRun({ hiveDir: f.hiveDir })).runId, 'previous');
  record(f, 'same', 'file', entry('before'), entry('before'));
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, runId: 'same' })).restored, []);
});

test('fix2: newest first even with force; partial point stays current and conflicts have codes', async (t) => {
  const f = fixture(t); record(f, 'old'); record(f, 'new');
  for (const [runId, createdAt] of [['old', '2026-01-01T00:00:00Z'], ['new', '2026-01-02T00:00:00Z']]) {
    const p = manifest(f, runId); p.createdAt = createdAt; fs.writeFileSync(manifestPath(f, runId), JSON.stringify(p));
  }
  for (const force of [false, true]) await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: 'old', force }), /Newer runs must be undone first: new/);
  write(f.workspace, 'file', 'different');
  const partial = await undoRun({ hiveDir: f.hiveDir });
  assert.deepEqual(partial.conflicts, [{ path: 'file', reason: 'File no longer matches what the run wrote', code: 'changed' }]);
  assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 1);
  assert.equal(listRestorePoints(f.hiveDir)[0].undoneAt, null);
  const p = manifest(f, 'new'); fs.unlinkSync(path.join(path.dirname(manifestPath(f, 'new')), p.files[0].preimage));
  assert.equal((await undoRun({ hiveDir: f.hiveDir, force: true })).conflicts[0].code, 'unrestorable');
  assert.ok(manifest(f, 'new').undoneAt);
});

test('fix2: undo owns its lease throughout the workspace lock and always releases it', async (t) => {
  const { acquireRunLease, readRunLease } = await import('../../src/core/run-lease.js');
  const { withWorkspaceLock } = await import('../../src/core/worktree.js');
  const f = fixture(t); record(f, 'run'); write(f.workspace, 'file', 'after');
  let unlock, entered;
  const ready = new Promise((r) => { entered = r; });
  const blocker = withWorkspaceLock(f.workspace, async () => { entered(); await new Promise((r) => { unlock = r; }); });
  await ready;
  const undo = undoRun({ hiveDir: f.hiveDir });
  try {
    assert.ok(readRunLease(f.hiveDir), 'undo must hold the run lease while waiting');
    assert.throws(() => acquireRunLease(f.hiveDir, { runId: 'race' }), { code: 'EEXIST' });
  } finally { unlock(); await blocker; await undo; }
  assert.equal(readRunLease(f.hiveDir), null);
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: 'missing' }), /No restore point/);
  assert.equal(readRunLease(f.hiveDir), null);
});

test('fix2: a sibling live or unprovable run blocks undo, but a gone sibling does not', async (t) => {
  const { acquireRunLease, releaseRunLease } = await import('../../src/core/run-lease.js');
  const f = fixture(t), sibling = path.join(f.root, 'sibling'); record(f, 'run'); write(f.workspace, 'file', 'after');
  const lease = acquireRunLease(sibling, { runId: 'other' });
  for (const pid of [null, process.pid]) {
    if (pid) write(sibling, 'control/heartbeat.json', JSON.stringify({ v: 1, runId: 'other', pid, at: new Date().toISOString() }));
    await assert.rejects(undoRun({ hiveDir: f.hiveDir, siblings: [sibling], force: true }), /A run is active in another chat of this project/);
  }
  releaseRunLease(sibling, lease.token);
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, siblings: [sibling] })).conflicts, []);
});

test('fix2: workspace inspection never executes git and detects ancestor repositories and gitfiles', async (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.workspace, '.git'));
  t.mock.method(childProcess, 'execFile', () => { throw Error('Workspace git must never execute'); });
  assert.deepEqual(await workspaceState(f.workspace), { git: true, dirty: null, untracked: null });
  const nested = path.join(f.workspace, 'nested'); fs.mkdirSync(nested);
  assert.deepEqual(await workspaceState(nested), { git: true, dirty: null, untracked: null });
  fs.rmdirSync(path.join(f.workspace, '.git')); write(f.workspace, '.git', 'gitdir: not-followed');
  assert.deepEqual(await workspaceState(f.workspace), { git: true, dirty: null, untracked: null });
});

test('fix2: foreign-host sibling with a locally absent PID is still unprovable', async (t) => {
  const { acquireRunLease, releaseRunLease } = await import('../../src/core/run-lease.js');
  const f = fixture(t), sibling = path.join(f.root, 'foreign'); record(f, 'run'); write(f.workspace, 'file', 'after');
  const lease = acquireRunLease(sibling, { runId: 'other' });
  write(sibling, 'control/owner.json', JSON.stringify({ ...lease, host: 'another-host' }));
  write(sibling, 'control/heartbeat.json', JSON.stringify({ v: 1, runId: 'other', pid: 2147483647, at: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, siblings: [sibling] }), /A run is active in another chat of this project/);
  write(sibling, 'control/owner.json', JSON.stringify(lease));
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, siblings: [sibling] })).conflicts, []);
  releaseRunLease(sibling, lease.token);
});

test('fix2: a damaged backup is unrestorable even when current content also changed', async (t) => {
  const f = fixture(t); record(f, 'run'); write(f.workspace, 'file', 'different');
  const p = manifest(f); fs.unlinkSync(path.join(path.dirname(manifestPath(f)), p.files[0].preimage));
  for (const force of [false, true]) assert.equal((await undoRun({ hiveDir: f.hiveDir, runId: 'run', force })).conflicts[0].code, 'unrestorable');
});

// Final review regressions.
test('fix3 item2: unrestorable files settle a point, remain reported, and do not block older points', async (t) => {
  for (const large of [false, true]) {
    const f = fixture(t); record(f, 'older', 'older');
    record(f, 'newer', 'file', large ? { ...entry(''), data: Buffer.alloc(MAX_PREIMAGE_BYTES + 1) } : entry('before'));
    for (const [id, date] of [['older', '2026-01-01'], ['newer', '2026-01-02']]) { const p = manifest(f, id); p.createdAt = date; fs.writeFileSync(manifestPath(f, id), JSON.stringify(p)); }
    if (!large) { const p = manifest(f, 'newer'); fs.unlinkSync(path.join(path.dirname(manifestPath(f, 'newer')), p.files[0].preimage)); }
    write(f.workspace, 'file', 'after'); write(f.workspace, 'older', 'after');
    const result = await undoRun({ hiveDir: f.hiveDir });
    assert.equal(result.conflicts[0].code, 'unrestorable');
    const p = listRestorePoints(f.hiveDir).find((p) => p.runId === 'newer');
    assert.ok(p.undoneAt); assert.equal(p.remaining, 0);
    assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, runId: 'newer' })).conflicts, result.conflicts);
    assert.equal((await undoRun({ hiveDir: f.hiveDir })).runId, 'older');
  }
});

test('fix3 item2: directory removal failures warn without keeping a point open', async (t) => {
  for (const code of ['EPERM', 'EBUSY']) {
    const f = fixture(t); record(f, 'run', 'nested/file', null); write(f.workspace, 'nested/file', 'after');
    const remove = fs.rmdirSync;
    const mock = t.mock.method(fs, 'rmdirSync', (file, ...args) => { if (file === path.join(f.workspace, 'nested')) throw Object.assign(Error(code), { code }); return remove(file, ...args); });
    const result = await undoRun({ hiveDir: f.hiveDir }); mock.mock.restore();
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.warnings, [`Cannot safely remove directory: nested (${code}).`]);
    assert.ok(listRestorePoints(f.hiveDir)[0].undoneAt); assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 0);
  }
});

test('fix3 item2: older refusal explains kept changed files and the force escape', async (t) => {
  const f = fixture(t); record(f, 'old'); record(f, 'new');
  const p = manifest(f, 'old'); p.createdAt = '2000-01-01'; fs.writeFileSync(manifestPath(f, 'old'), JSON.stringify(p));
  write(f.workspace, 'file', 'human'); await undoRun({ hiveDir: f.hiveDir });
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: 'old' }), { message: 'Newer runs must be undone first: new. A run stays open while files changed after it are kept; undo it with --force or leave both.' });
});

test('fix3 item3: newer unreadable directory blocks force only and names the entry', async (t) => {
  const f = fixture(t); record(f, 'good'); write(f.workspace, 'file', 'human');
  const bad = path.join(f.hiveDir, 'restore-points/unreadable'); fs.mkdirSync(bad); write(bad, 'manifest.json', '{bad');
  fs.utimesSync(bad, new Date('2099-01-01'), new Date('2099-01-01'));
  await assert.rejects(undoRun({ hiveDir: f.hiveDir, runId: 'good', force: true }), { message: 'Cannot force undo while newer restore point unreadable is unreadable.' });
  assert.equal(read(f.workspace, 'file'), 'human');
  assert.equal((await undoRun({ hiveDir: f.hiveDir, runId: 'good' })).conflicts[0].code, 'changed');
  fs.utimesSync(bad, new Date(0), new Date(0));
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir, runId: 'good', force: true })).restored, ['file']);
});

test('fix3 item4: first integration rollback cannot prune a committed older point', async (t) => {
  const f = fixture(t); for (let i = 0; i < 10; i++) record(f, 'old-' + i);
  const before = listRestorePoints(f.hiveDir).map((p) => p.runId);
  write(f.workspace, 'file', 'base'); const m = await manager(t, f, 'new');
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === path.join(f.workspace, 'file')) throw Error('Workspace write failed'); return rename(from, to); });
  await assert.rejects(integrate(m, 'm1', (dir) => write(dir, 'file', 'candidate')), /Workspace write failed/);
  mock.mock.restore();
  assert.deepEqual(listRestorePoints(f.hiveDir).map((p) => p.runId), before);
  await integrate(m, 'm1', (dir) => write(dir, 'file', 'candidate'));
  assert.equal(listRestorePoints(f.hiveDir).length, 10);
});

test('fix3 item2: explicit settled retry reports conflicts without touching recreated directories', async (t) => {
  const f = fixture(t); record(f, 'run', 'nested/file', null); write(f.workspace, 'nested/file', 'after');
  await undoRun({ hiveDir: f.hiveDir }); fs.mkdirSync(path.join(f.workspace, 'nested'));
  const before = fs.readFileSync(manifestPath(f));
  await undoRun({ hiveDir: f.hiveDir, runId: 'run' });
  assert.ok(fs.existsSync(path.join(f.workspace, 'nested')));
  assert.deepEqual(fs.readFileSync(manifestPath(f)), before);
});

// Retryable undo failures.
test('fix4: blocked writes stay open, ignore force and retry exact original bytes', async (t) => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const f = fixture(t), original = Buffer.from([0, 255, 13, 10, 128, 65]);
    record(f, 'run', 'file', { ...entry(''), data: original }); write(f.workspace, 'file', 'after');
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === path.join(f.workspace, 'file')) throw Object.assign(Error('private contents must not appear'), { code }); return rename(from, to); });
    for (const force of [false, true]) {
      const result = await undoRun({ hiveDir: f.hiveDir, runId: 'run', force });
      assert.deepEqual(result, { runId: 'run', restored: [], removed: [], conflicts: [{ path: 'file', reason: `Could not restore the file (${code}); check the path and permissions, close programs using it and undo again`, code: 'blocked' }], warnings: [] });
      const p = manifest(f); assert.equal(p.undoneAt, null); assert.equal(p.files[0].undoneAt, null); assert.equal(p.files[0].undoUnrestorable, undefined); assert.equal(p.files[0].undoPending, true);
      assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 1);
      assert.equal(read(f.workspace, 'file'), 'after'); assert.deepEqual(fs.readdirSync(f.workspace), ['file']);
    }
    mock.mock.restore();
    assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).restored, ['file']);
    assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'file')), original);
    assert.ok(manifest(f).undoneAt); assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 0);
  }
});

test('fix4: blocked unlink stays open with force and retries removal of a created file', async (t) => {
  const f = fixture(t); record(f, 'run', 'file', null); write(f.workspace, 'file', 'after');
  const unlink = fs.unlinkSync;
  const mock = t.mock.method(fs, 'unlinkSync', (file, ...args) => { if (file === path.join(f.workspace, 'file')) throw Object.assign(Error('locked'), { code: 'EBUSY' }); return unlink(file, ...args); });
  for (const force of [false, true]) {
    const result = await undoRun({ hiveDir: f.hiveDir, runId: 'run', force });
    assert.deepEqual(result, { runId: 'run', restored: [], removed: [], conflicts: [{ path: 'file', reason: 'Could not restore the file (EBUSY); check the path and permissions, close programs using it and undo again', code: 'blocked' }], warnings: [] });
    const p = manifest(f); assert.equal(p.undoneAt, null); assert.equal(p.files[0].undoneAt, null); assert.equal(p.files[0].undoUnrestorable, undefined); assert.equal(p.files[0].undoPending, true);
    assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 1); assert.equal(read(f.workspace, 'file'), 'after'); assert.deepEqual(fs.readdirSync(f.workspace), ['file']);
  }
  mock.mock.restore();
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).removed, ['file']);
  assert.deepEqual(fs.readdirSync(f.workspace), []); assert.ok(manifest(f).undoneAt); assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 0);
});

test('fix4: a failed completion save cannot mark a file undone and retries from original bytes', async (t) => {
  const f = fixture(t); record(f, 'run'); write(f.workspace, 'file', 'after');
  const rename = fs.renameSync; let saves = 0;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === manifestPath(f) && ++saves === 2) throw Object.assign(Error('locked'), { code: 'EBUSY' }); return rename(from, to); });
  const result = await undoRun({ hiveDir: f.hiveDir }); mock.mock.restore();
  assert.equal(result.conflicts[0].code, 'blocked'); assert.equal(read(f.workspace, 'file'), 'before');
  const p = manifest(f); assert.equal(p.undoneAt, null); assert.equal(p.files[0].undoneAt, null); assert.equal(p.files[0].undoPending, true); assert.equal(p.files[0].undoUnrestorable, undefined);
  assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 1);
  assert.deepEqual(await undoRun({ hiveDir: f.hiveDir }), { runId: 'run', restored: [], removed: [], conflicts: [], warnings: [] });
  assert.ok(manifest(f).undoneAt); assert.equal(manifest(f).files[0].undoPending, undefined);
});

test('fix4: a repaired unsafe path is retried without force or leaking exception contents', async (t) => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); write(outside, 'file', 'outside');
  record(f, 'run', 'nested/file'); fs.symlinkSync(outside, path.join(f.workspace, 'nested'), 'junction');
  const result = await undoRun({ hiveDir: f.hiveDir });
  assert.deepEqual(result.conflicts, [{ path: 'nested/file', reason: 'Could not restore the file; check the path and permissions, close programs using it and undo again', code: 'blocked' }]);
  assert.equal(read(outside, 'file'), 'outside'); assert.equal(listRestorePoints(f.hiveDir)[0].undoneAt, null); assert.equal(listRestorePoints(f.hiveDir)[0].remaining, 1);
  fs.unlinkSync(path.join(f.workspace, 'nested')); write(f.workspace, 'nested/file', 'after');
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).restored, ['nested/file']); assert.equal(read(f.workspace, 'nested/file'), 'before');
});

test('fix4: a blocked pending integration accepts its recorded pending state on retry', async (t) => {
  const f = fixture(t);
  prepareRestorePoint({ ...f, runId: 'run', changes: ['file'], before: new Map([['file', entry('before')]]), initial: new Map([['file', entry('before')]]), after: new Map([['file', entry('after')]]) });
  write(f.workspace, 'file', 'after');
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => { if (to === path.join(f.workspace, 'file')) throw Object.assign(Error('locked'), { code: 'EBUSY' }); return rename(from, to); });
  assert.equal((await undoRun({ hiveDir: f.hiveDir })).conflicts[0].code, 'blocked'); mock.mock.restore();
  assert.deepEqual((await undoRun({ hiveDir: f.hiveDir })).restored, ['file']); assert.equal(read(f.workspace, 'file'), 'before');
});
