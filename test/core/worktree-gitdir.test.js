import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WorktreeManager } from '../../src/core/worktree.js';

const scratch = path.resolve('.scratch/gitdir-fix');
fs.mkdirSync(scratch, { recursive: true });

test('deep registry hive supports planner, developer, QA, snapshot and integration', async (t) => {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'));
  const workspace = path.join(root, 'workspace');
  const data = path.join(root, 'd'.repeat('C:\\Users\\user1\\AppData\\Roaming\\dev.scranton.desktop'.length));
  const hiveDir = path.join(data, 'projects', 'p'.repeat(49), 'chats', randomUUID(), 'hive');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'base.txt'), 'baseline');
  const previous = process.env.SCRANTON_ISOLATION_ROOT;
  const manager = new WorktreeManager({ workspace, hiveDir, runId: randomUUID() });
  t.after(async () => {
    await manager.close();
    if (manager.storage) fs.rmSync(manager.storage, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.SCRANTON_ISOLATION_ROOT;
    else process.env.SCRANTON_ISOLATION_ROOT = previous;
  });
  await manager.init();
  const plan = await manager.createWorktree({ agent: 'michael', milestoneId: 'plan' });
  const milestoneId = 'm'.repeat(200);
  const dev = await manager.createWorktree({ agent: 'dwight', milestoneId });
  fs.writeFileSync(path.join(dev.dir, 'base.txt'), 'reviewed');
  const ref = await manager.snapshotWorktree({ agent: 'dwight', milestoneId });
  const qa = await manager.createQaWorktree({ milestoneId });
  assert.equal(fs.readFileSync(path.join(qa.dir, 'base.txt'), 'utf8'), 'reviewed');
  assert.equal((await manager.git(['rev-parse', qa.ref])).toString().trim(), ref);
  await manager.integrateToTarget({ milestoneId });
  assert.equal(fs.readFileSync(path.join(workspace, 'base.txt'), 'utf8'), 'reviewed');
  for (const tree of [plan, dev, qa]) {
    const gitDir = fs.readFileSync(path.join(tree.dir, '.git'), 'utf8').trim().slice(8);
    assert.ok(Buffer.byteLength(gitDir) <= 200, gitDir);
    assert.ok(tree.dir.length <= 200);
  }
  const pointer = JSON.parse(fs.readFileSync(manager.pointerFile, 'utf8'));
  assert.equal(pointer.runId, manager.runId);
  assert.equal(pointer.storage, manager.storage);
  await manager.close();
  assert.ok(fs.existsSync(pointer.storage), 'close preserves diagnostics on success and abort');
  assert.ok(fs.existsSync(manager.pointerFile), 'history/recovery retains the external location');
});

test('overlong isolation root fails preflight with override guidance before Git runs', async (t) => {
  const root = fs.mkdtempSync(path.join(scratch, 'guard-'));
  const previous = process.env.SCRANTON_ISOLATION_ROOT;
  process.env.SCRANTON_ISOLATION_ROOT = path.join(root, 'x'.repeat(210));
  t.after(() => {
    if (previous === undefined) delete process.env.SCRANTON_ISOLATION_ROOT;
    else process.env.SCRANTON_ISOLATION_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'ws'); fs.mkdirSync(workspace);
  const manager = new WorktreeManager({ workspace, hiveDir: path.join(root, 'hive'), runId: 'r'.repeat(200) });
  let called = false;
  manager.git = async () => { called = true; throw new Error('Git must not run'); };
  await assert.rejects(manager.init(), /SCRANTON_ISOLATION_ROOT/);
  assert.equal(called, false);
  assert.equal(fs.existsSync(process.env.SCRANTON_ISOLATION_ROOT), false);
});

function reviewFixture(t) {
  const root = fs.mkdtempSync(path.join(path.resolve('.scratch/gitdir-fix2'), 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'ws'); fs.mkdirSync(workspace);
  return { root, workspace, hiveDir: path.join(root, 'hive') };
}

test('review 1: non-Windows keeps a short hive-local default, not shared tmp', async () => {
  const { resolveIsolationRoot } = await import('../../src/core/worktree.js');
  const hiveDir = path.resolve('h');
  for (const platform of ['linux', 'darwin']) {
    assert.equal(resolveIsolationRoot({ hiveDir, platform, env: {}, homedir: path.resolve('fake-home') }), path.join(hiveDir, 'isolation'));
  }
});

test('review 2: override cannot overlap workspace, including ancestors and other chat storage', async (t) => {
  const f = reviewFixture(t);
  const previous = process.env.SCRANTON_ISOLATION_ROOT;
  t.after(() => { process.env.SCRANTON_ISOLATION_ROOT = previous; });
  for (const root of [f.workspace, path.join(f.workspace, 'old-runs'), f.root]) {
    process.env.SCRANTON_ISOLATION_ROOT = root;
    const manager = new WorktreeManager({ ...f, runId: 'overlap' });
    manager.git = async () => { throw Error('Git reached before overlap validation'); };
    await assert.rejects(manager.init(), /Isolation root must not overlap the workspace/);
  }
});

test('review 3: deleting project history or removing a chat cleans its external storage', async (t) => {
  const { createProjectRegistry } = await import('../../src/core/projects.js');
  const f = reviewFixture(t);
  const registry = createProjectRegistry({ dataDir: path.join(f.root, 'data') });
  const project = registry.addProject({ name: 'Cleanup', workspace: f.workspace });
  for (const remove of ['chat', 'project']) {
    const chat = registry.createChat(project.id);
    const manager = new WorktreeManager({ workspace: f.workspace, hiveDir: chat.hiveDir, runId: remove });
    await manager.init(); await manager.close();
    if (remove === 'chat') registry.removeChat(project.id, chat.id);
    else registry.removeProject(project.id, { deleteHistory: true });
    assert.equal(fs.existsSync(manager.storage), false, `${remove} storage must not be orphaned`);
    assert.equal(fs.existsSync(manager.pointerFile), false);
  }
});

test('review 7: Windows default resolves LOCALAPPDATA and homedir fallback without profile I/O', async () => {
  const { resolveIsolationRoot } = await import('../../src/core/worktree.js');
  const args = { platform: 'win32', homedir: 'C:\\fake-user', hiveDir: 'C:\\fake-hive' };
  assert.equal(resolveIsolationRoot({ ...args, env: { LOCALAPPDATA: 'D:\\fake-local' } }), 'D:\\fake-local\\Scranton\\iso');
  for (const env of [{}, { LOCALAPPDATA: '', SCRANTON_ISOLATION_ROOT: '' }]) {
    assert.equal(resolveIsolationRoot({ ...args, env }), 'C:\\fake-user\\AppData\\Local\\Scranton\\iso');
  }
});

test('review 1: long non-Windows hives use a user-specific short root', async () => {
  const { resolveIsolationRoot } = await import('../../src/core/worktree.js');
  const root = resolveIsolationRoot({ hiveDir: path.resolve('x'.repeat(220)), platform: 'darwin', env: {}, tmpdir: path.resolve('fake-tmp'), homedir: path.resolve('fake-home') });
  assert.equal(path.dirname(root), path.resolve('fake-tmp'));
  assert.match(path.basename(root), /^scranton-iso-[a-z0-9]+$/);
  assert.notEqual(path.basename(root), 'scranton-iso');
});

test('review 6: atomic pointer precedes storage creation and rename failure leaves no storage', async (t) => {
  const f = reviewFixture(t), root = process.env.SCRANTON_ISOLATION_ROOT;
  const before = fs.readdirSync(root);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.endsWith('.json') && to.includes(path.sep + 'isolation' + path.sep)) {
      const pointer = JSON.parse(fs.readFileSync(from, 'utf8'));
      assert.equal(fs.existsSync(pointer.storage), false);
      throw Error('Injected pointer rename failure');
    }
    return rename(from, to);
  });
  const manager = new WorktreeManager({ ...f, runId: 'atomic' });
  await assert.rejects(manager.init(), /Injected pointer rename failure/);
  mock.mock.restore();
  assert.deepEqual(fs.readdirSync(root), before);
  assert.deepEqual(fs.readdirSync(path.join(f.hiveDir, 'isolation')), []);
});

test('review 3: cleanup refuses active managers, leases, forged run IDs and outside pointers', async (t) => {
  const { cleanupIsolationStorage } = await import('../../src/core/worktree.js');
  const { acquireRunLease, releaseRunLease } = await import('../../src/core/run-lease.js');
  const f = reviewFixture(t);
  const manager = new WorktreeManager({ ...f, runId: 'guarded' });
  t.after(() => manager.close());
  await manager.init();
  assert.throws(() => cleanupIsolationStorage(f.hiveDir), /in use/);
  await manager.close();
  const lease = acquireRunLease(f.hiveDir, { runId: 'different-run' });
  assert.throws(() => cleanupIsolationStorage(f.hiveDir), /in use/);
  releaseRunLease(f.hiveDir, lease.token);
  const raw = fs.readFileSync(manager.pointerFile, 'utf8'), pointer = JSON.parse(raw);
  fs.writeFileSync(manager.pointerFile, JSON.stringify({ ...pointer, runId: 'forged' }));
  assert.throws(() => cleanupIsolationStorage(f.hiveDir), /does not match/);
  fs.writeFileSync(manager.pointerFile, JSON.stringify({ ...pointer, storage: f.workspace }));
  assert.throws(() => cleanupIsolationStorage(f.hiveDir), /outside/);
  assert.equal(fs.existsSync(manager.storage), true);
  fs.writeFileSync(manager.pointerFile, raw);
  assert.equal(cleanupIsolationStorage(f.hiveDir), 1);
});

test('review 1: short roots resolve symlinked temp parents before link checks', async (t) => {
  const f = reviewFixture(t), previous = process.env.SCRANTON_ISOLATION_ROOT;
  const target = path.join(f.root, 'real'); fs.mkdirSync(target);
  const link = path.join(f.root, 'alias'); fs.symlinkSync(target, link, 'junction');
  process.env.SCRANTON_ISOLATION_ROOT = path.join(link, 'iso');
  t.after(() => { process.env.SCRANTON_ISOLATION_ROOT = previous; });
  const manager = new WorktreeManager({ ...f, runId: 'realpath' });
  await manager.init(); t.after(() => manager.close());
  assert.equal(path.dirname(manager.storage), path.join(fs.realpathSync.native(target), 'iso'));
});

test('review 1: POSIX roots are private and foreign-owned roots are rejected', async (t) => {
  const f = reviewFixture(t), previous = process.env.SCRANTON_ISOLATION_ROOT;
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  t.after(() => { Object.defineProperty(process, 'platform', { value: platform }); process.env.SCRANTON_ISOLATION_ROOT = previous; });
  const getuid = process.getuid;
  process.getuid = () => 1000;
  t.after(() => { if (getuid) process.getuid = getuid; else delete process.getuid; });
  const stat = fs.statSync, chmod = [];
  t.mock.method(fs, 'statSync', (...args) => { const s = stat(...args); return Object.assign(s, { uid: 1000 }); });
  t.mock.method(fs, 'chmodSync', (p, mode) => chmod.push([p, mode]));
  const manager = new WorktreeManager({ ...f, runId: 'private' });
  manager.git = async () => { throw Error('Stop after root setup'); };
  await assert.rejects(manager.init(), /Stop after root setup/);
  await manager.close();
  assert.ok(chmod.some(([p, mode]) => p === previous && mode === 0o700));
  t.mock.method(fs, 'statSync', (...args) => { const s = stat(...args); return Object.assign(s, { uid: 2000 }); });
  const denied = new WorktreeManager({ ...f, runId: 'foreign' });
  await assert.rejects(denied.init(), /owned by the current user/);
});

test('review 1: actual non-Windows initialization keeps Hive storage even with a symlinked TMPDIR', async (t) => {
  const { default: os } = await import('node:os');
  const f = reviewFixture(t), previous = process.env.SCRANTON_ISOLATION_ROOT, platform = process.platform;
  const target = path.join(f.root, 'tmp-real'); fs.mkdirSync(target);
  const link = path.join(f.root, 'tmp-alias'); fs.symlinkSync(target, link, 'junction');
  t.mock.method(os, 'tmpdir', () => link);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.env.SCRANTON_ISOLATION_ROOT = '';
  t.after(() => { Object.defineProperty(process, 'platform', { value: platform }); process.env.SCRANTON_ISOLATION_ROOT = previous; });
  const manager = new WorktreeManager({ ...f, runId: 'local' });
  manager.git = async () => { throw Error('Stopped before Git'); };
  await assert.rejects(manager.init(), /Stopped before Git/);
  await manager.close();
  assert.equal(path.dirname(manager.storage), path.join(f.hiveDir, 'isolation'));
});

test('review 3: legacy pointers require matching durable run records; changed root preserves history', async (t) => {
  const { cleanupIsolationStorage } = await import('../../src/core/worktree.js');
  const { createProjectRegistry } = await import('../../src/core/projects.js');
  const f = reviewFixture(t), previous = process.env.SCRANTON_ISOLATION_ROOT;
  t.after(() => { process.env.SCRANTON_ISOLATION_ROOT = previous; });
  const registry = createProjectRegistry({ dataDir: path.join(f.root, 'data') });
  const project = registry.addProject({ name: 'Legacy', workspace: f.workspace });
  const chat = registry.createChat(project.id);
  const manager = new WorktreeManager({ workspace: f.workspace, hiveDir: chat.hiveDir, runId: 'old' });
  await manager.init(); await manager.close();
  process.env.SCRANTON_ISOLATION_ROOT = path.join(f.root, 'different');
  assert.throws(() => registry.removeProject(project.id, { deleteHistory: true }), /configured root/);
  assert.equal(registry.getChat(project.id, chat.id).id, chat.id);
  process.env.SCRANTON_ISOLATION_ROOT = previous;
  fs.unlinkSync(path.join(manager.storage, '.scranton-isolation.json'));
  assert.throws(() => cleanupIsolationStorage(chat.hiveDir), /does not match/);
  fs.writeFileSync(path.join(chat.hiveDir, 'state.json'), JSON.stringify({ runId: 'old', workspace: f.workspace, status: 'finished' }));
  assert.equal(cleanupIsolationStorage(chat.hiveDir), 1);
  assert.equal(fs.existsSync(manager.storage), false);
});
