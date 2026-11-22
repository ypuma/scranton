import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WorktreeManager } from '../../src/core/worktree.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { loadConfig } from '../../src/core/config.js';

function fixture(t) {
  const scratch = path.resolve('.scratch/agents-md-review'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'review-'));
  const workspace = path.join(dir, 'workspace'), hiveDir = path.join(dir, 'hive');
  fs.mkdirSync(workspace); fs.mkdirSync(hiveDir);
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'User instructions');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, workspace, hiveDir };
}
async function manager(t, f) {
  const m = new WorktreeManager({ ...f, runId: 'review' });
  t.after(async () => { await m.close(); if (m.storage) fs.rmSync(m.storage, { recursive: true, force: true }); });
  await m.init(); return m;
}
for (const fault of ['read_error', 'escape', 'hardlink']) test(`review: strict worktree AGENTS.md ${fault} fails without deleting user instructions`, async t => {
  const f = fixture(t), m = await manager(t, f), d = await m.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const file = path.join(d.dir, 'AGENTS.md');
  if (fault === 'read_error') {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (p, ...args) => { if (p === file) throw Object.assign(Error('denied'), { code: 'EACCES' }); return read(p, ...args); });
  } else {
    fs.unlinkSync(file);
    if (fault === 'not_regular') fs.mkdirSync(file);
    if (fault === 'escape') fs.symlinkSync(f.workspace, file, process.platform === 'win32' ? 'junction' : 'dir');
    if (fault === 'hardlink') { fs.writeFileSync(path.join(f.dir, 'linked'), 'Linked bytes'); fs.linkSync(path.join(f.dir, 'linked'), file); }
  }
  await assert.rejects(m.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' }));
  await assert.rejects(m.integrateToTarget({ milestoneId: 'm1' }), /No developer snapshot/);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), 'User instructions');
});
for (const fault of ['read_error', 'escape', 'not_regular', 'hardlink']) test(`review: initial AGENTS.md ${fault} is skipped and untouched by integration`, async t => {
  const f = fixture(t), file = path.join(f.workspace, 'AGENTS.md');
  let mock;
  if (fault === 'read_error') {
    const read = fs.readFileSync;
    mock = t.mock.method(fs, 'readFileSync', (p, ...args) => { if (p === file) throw Object.assign(Error('denied'), { code: 'EACCES' }); return read(p, ...args); });
  } else {
    fs.unlinkSync(file);
    if (fault === 'not_regular') fs.mkdirSync(file);
    if (fault === 'escape') fs.symlinkSync(f.hiveDir, file, process.platform === 'win32' ? 'junction' : 'dir');
    if (fault === 'hardlink') { fs.writeFileSync(path.join(f.dir, 'linked'), 'User instructions'); fs.linkSync(path.join(f.dir, 'linked'), file); }
  }
  const before = fs.lstatSync(file), m = await manager(t, f); mock?.mock.restore();
  assert.equal(m.initial.has('AGENTS.md'), false);
  assert.ok(m.instructionWarnings.some(w => w.reason === (fault === 'hardlink' ? 'not_regular' : fault)));
  const d = await m.createWorktree({ agent: 'dwight', milestoneId: 'm1' }); fs.writeFileSync(path.join(d.dir, 'new.txt'), 'new');
  await m.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' }); await m.createQaWorktree({ milestoneId: 'm1' });
  await m.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(fs.lstatSync(file).ino, before.ino);
  if (fault === 'hardlink' || fault === 'read_error') assert.equal(fs.readFileSync(file, 'utf8'), 'User instructions');
});
function orchestrator(t, f) {
  const config = loadConfig({ cwd: f.dir, env: {}, fileConfig: { workspace: f.workspace, hiveDir: f.hiveDir, execution: { isolation: 'worktree', sandbox: { mode: 'host' } } } });
  const events = [], o = new Orchestrator({ config, listener: e => events.push(e) });
  return { o, events };
}
test('review: initialization failure without a stop fails and clears roles', async t => {
  const f = fixture(t), { o, events } = orchestrator(t, f);
  t.mock.method(WorktreeManager.prototype, 'init', async () => { throw Error('snapshot failure'); });
  assert.equal((await o.run('Task')).status, 'failed');
  assert.deepEqual(events.find(e => e.type === 'run_started').roles, []);
});
test('review: stop polling aborts a snapshot before it finishes', { timeout: 5000 }, async t => {
  const f = fixture(t), { o, events } = orchestrator(t, f); let observed = false;
  t.mock.method(WorktreeManager.prototype, 'init', async function(options) {
    fs.mkdirSync(path.join(f.hiveDir, 'control'), { recursive: true });
    fs.writeFileSync(path.join(f.hiveDir, 'control/stop.json'), JSON.stringify({ v: 1, runId: o.runId, ts: new Date().toISOString() }));
    await new Promise(resolve => setTimeout(resolve, 600));
    observed = o.abortController.signal.aborted;
    options?.signal?.throwIfAborted();
    throw Error('snapshot ended');
  });
  const result = await o.run('Task');
  assert.equal(observed, true); assert.equal(result.status, 'aborted');
  assert.deepEqual(events.find(e => e.type === 'run_started').roles, []);
});

test('review: initialization cancellation does not disable later integration rollback Git', async t => {
  const f = fixture(t), controller = new AbortController(), m = new WorktreeManager({ ...f, runId: 'init-signal' });
  t.after(async () => { await m.close(); if (m.storage) fs.rmSync(m.storage, { recursive: true, force: true }); });
  await m.init({ signal: controller.signal }); controller.abort();
  const d = await m.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  assert.equal(fs.readFileSync(path.join(d.dir, 'AGENTS.md'), 'utf8'), 'User instructions');
});

for (const rel of ['AGENTS.md', 'src/AGENTS.md']) test(`review: directory ${rel} is walked in initial and developer snapshots`, async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.workspace, 'AGENTS.md'));
  const file = `${rel}/child.txt`;
  fs.mkdirSync(path.dirname(path.join(f.workspace, file)), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, file), 'initial');
  const m = await manager(t, f);
  assert.equal(m.initial.get(file).data.toString(), 'initial');
  const d = await m.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  fs.writeFileSync(path.join(d.dir, file), 'changed');
  await m.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  await m.createQaWorktree({ milestoneId: 'm1' });
  await m.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(fs.readFileSync(path.join(f.workspace, file), 'utf8'), 'changed');
});

for (const operation of ['commit', 'readSnapshot']) test(`review: ${operation} retains workspace link checks for AGENTS.md`, async t => {
  const f = fixture(t), m = await manager(t, f);
  fs.unlinkSync(path.join(f.workspace, 'AGENTS.md'));
  fs.symlinkSync(f.dir, path.join(f.workspace, 'AGENTS.md'), process.platform === 'win32' ? 'junction' : 'dir');
  if (operation === 'commit') await assert.rejects(m.commit(m.initial, null), /link/i);
  else await assert.rejects(m.readSnapshot(m.integratedRef), /link/i);
});

for (const rel of ['AGENTS.md', 'src/AGENTS.md']) test(`review: initial internal junction ${rel} warns not_regular`, async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.workspace, 'AGENTS.md'));
  fs.mkdirSync(path.join(f.workspace, 'target'));
  fs.mkdirSync(path.dirname(path.join(f.workspace, rel)), { recursive: true });
  fs.symlinkSync(path.join(f.workspace, 'target'), path.join(f.workspace, rel), process.platform === 'win32' ? 'junction' : 'dir');
  const m = await manager(t, f);
  assert.equal(m.initial.has(rel), false);
  assert.deepEqual(m.instructionWarnings.map(w => [w.file, w.reason]), [[rel, 'not_regular']]);
});

test('review: initial internal file symlinks report not_regular without platform privileges', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.workspace, 'src')); fs.writeFileSync(path.join(f.workspace, 'src/AGENTS.md'), 'nested');
  const lstat = fs.lstatSync;
  const mock = t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const stat = lstat(file, ...args);
    return path.basename(file) === 'AGENTS.md' ? Object.assign(Object.create(stat), { isSymbolicLink: () => true }) : stat;
  });
  const m = await manager(t, f); mock.mock.restore();
  assert.equal(m.initial.has('AGENTS.md'), false); assert.equal(m.initial.has('src/AGENTS.md'), false);
  assert.deepEqual(m.instructionWarnings.map(w => [w.file, w.reason]).sort(), [['AGENTS.md', 'not_regular'], ['src/AGENTS.md', 'not_regular']]);
});
