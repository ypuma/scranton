import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { WorktreeManager } from '../../src/core/worktree.js';

function fixture(t) {
  const scratch = path.resolve('.scratch/multiproject-thread'); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'process-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'shared.txt'), 'baseline');
  const real = fs.realpathSync.native(workspace);
  const hash = createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 16);
  const lock = path.join(os.tmpdir(), 'scranton-locks', `${hash}.lock`);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(lock, { recursive: true, force: true }); });
  return { root, workspace, lock };
}

async function processes(t, overlap) {
  const { root, workspace, lock } = fixture(t);
  const worker = path.join(root, 'worker.mjs');
  fs.writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { WorktreeManager } from ${JSON.stringify(pathToFileURL(path.resolve('src/core/worktree.js')).href)};
const [root, workspace, name, overlap] = process.argv.slice(2);
const manager = new WorktreeManager({ workspace, hiveDir: path.join(root, 'hive-' + name), runId: name });
await manager.init();
const d = await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
fs.writeFileSync(path.join(d.dir, name + '.txt'), name);
if (overlap === 'true') fs.writeFileSync(path.join(d.dir, 'shared.txt'), name);
await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
await manager.createQaWorktree({ milestoneId: 'm1' });
const commit = manager.commit.bind(manager);
manager.commit = async (...args) => { await delay(500); return commit(...args); };
const go = once(process, 'message');
process.send({ ready: true });
await go;
try { await manager.integrateToTarget({ milestoneId: 'm1' }); process.send({ status: 'success' }); }
catch (err) { process.send({ status: 'error', message: err.message }); }
await manager.close();
process.disconnect();
`);
  const children = ['a', 'b'].map((name) => fork(worker, [root, workspace, name, String(overlap)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }));
  t.after(() => { for (const child of children) child.kill(); });
  const ready = children.map((child) => once(child, 'message'));
  const exits = children.map((child) => once(child, 'exit'));
  const outputs = children.map((child) => {
    let output = ''; child.stderr.on('data', (data) => { output += data; });
    return () => output;
  });
  await Promise.all(ready);
  const results = children.map((child) => once(child, 'message'));
  for (const child of children) child.send('go');
  const messages = (await Promise.all(results)).map(([message]) => message);
  const codes = await Promise.all(exits);
  for (let i = 0; i < codes.length; i++) assert.equal(codes[i][0], 0, outputs[i]());
  assert.equal(fs.existsSync(lock), false, 'integration releases its cross-process lock');
  return { messages, workspace };
}

test('two separate Node processes integrate non-overlapping changes into the same workspace', { timeout: 60000 }, async (t) => {
  const { messages, workspace } = await processes(t, false);
  assert.deepEqual(messages.map((m) => m.status), ['success', 'success']);
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8'), 'b');
});

test('two separate Node processes with overlap produce one Integration conflict and no partial writes', { timeout: 60000 }, async (t) => {
  const { messages, workspace } = await processes(t, true);
  assert.equal(messages.filter((m) => m.status === 'success').length, 1);
  assert.match(messages.find((m) => m.status === 'error')?.message ?? '', /^Integration conflict:/);
  const winner = fs.readFileSync(path.join(workspace, 'shared.txt'), 'utf8');
  assert.equal(fs.existsSync(path.join(workspace, winner + '.txt')), true);
  assert.equal(fs.existsSync(path.join(workspace, (winner === 'a' ? 'b' : 'a') + '.txt')), false);
});

async function prepared(t) {
  const f = fixture(t);
  const manager = new WorktreeManager({ workspace: f.workspace, hiveDir: path.join(f.root, 'hive'), runId: 'stale' });
  await manager.init(); t.after(() => manager.close());
  const d = await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  fs.writeFileSync(path.join(d.dir, 'new.txt'), 'new');
  await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  await manager.createQaWorktree({ milestoneId: 'm1' });
  fs.mkdirSync(f.lock, { recursive: true });
  return { ...f, manager };
}

test('dead PID and old empty integration locks are recovered', { timeout: 60000 }, async (t) => {
  for (const kind of ['dead', 'empty']) {
    const { root, lock, manager, workspace } = await prepared(t);
    if (kind === 'dead') {
      const childFile = path.join(root, 'dead.mjs'); fs.writeFileSync(childFile, '');
      const child = fork(childFile, [], { stdio: 'ignore', windowsHide: true });
      const pid = child.pid; await once(child, 'exit');
      fs.writeFileSync(path.join(lock, `${pid}-00000000-0000-4000-8000-000000000000.json`), JSON.stringify({ pid }));
    } else {
      const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
    }
    await manager.integrateToTarget({ milestoneId: 'm1' });
    assert.equal(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(lock), false);
  }
});

test('live PID lock is never stolen even when old, and waiting times out clearly', async (t) => {
  const { lock, manager, workspace } = await prepared(t);
  const owner = path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000000.json`);
  fs.writeFileSync(owner, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  const now = Date.now(); let clock = now;
  const mock = t.mock.method(Date, 'now', () => (clock += 31000));
  try { await assert.rejects(manager.integrateToTarget({ milestoneId: 'm1' }), /Timed out waiting for workspace integration lock/); }
  finally { mock.mock.restore(); }
  assert.equal(fs.existsSync(owner), true);
  assert.equal(fs.existsSync(path.join(workspace, 'new.txt')), false);
});
