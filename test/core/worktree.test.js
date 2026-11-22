import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { WorktreeManager } from '../../src/core/worktree.js';

const scratch = path.resolve('.scratch/isolation');
fs.mkdirSync(scratch, { recursive: true });
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true });
const write = (dir, name, data) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
async function fixture(t, { repository = false, hiveInside = false } = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'git-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  write(workspace, 'base.txt', 'baseline\n');
  if (repository) git(workspace, 'init', '--quiet');
  const hiveDir = hiveInside ? path.join(workspace, 'hive') : path.join(root, 'hive');
  const manager = new WorktreeManager({ workspace, hiveDir, runId: 'run' });
  await manager.init();
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, manager, hiveDir };
}
const dev = (manager, milestoneId = 'm1') => manager.createWorktree({ agent: 'dwight', milestoneId });
const snapshot = async (manager, milestoneId = 'm1') => {
  const ref = await manager.snapshotWorktree({ agent: 'dwight', milestoneId });
  await manager.createQaWorktree({ milestoneId });
  return ref;
};

test('non-Git/unborn input has separate real worktrees for every role; no user Git writes', async (t) => {
  for (const repository of [false, true]) {
    const { workspace, manager } = await fixture(t, { repository });
    const before = repository ? git(workspace, 'status', '--porcelain=v1').toString() : null;
    const trees = await Promise.all(['michael', 'dwight', 'angela'].map((agent) => manager.createWorktree({ agent, milestoneId: 'plan' })));
    assert.equal(new Set(trees.map((tree) => tree.dir)).size, 3);
    for (const tree of trees) { assert.equal(read(tree.dir, 'base.txt'), 'baseline\n'); assert.equal(git(tree.dir, 'rev-parse', '--is-inside-work-tree').toString().trim(), 'true'); }
    assert.match(read(trees[0].dir, '.git'), /shadow/);
    if (repository) { assert.equal(git(workspace, 'status', '--porcelain=v1').toString(), before); assert.throws(() => git(workspace, 'rev-parse', '--verify', 'HEAD')); }
    else assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
  }
});

test('developer immutable snapshot, exact fresh QA retry, binary/deletion/odd filenames integrate; QA never does', async (t) => {
  const { workspace, manager } = await fixture(t);
  const d = await dev(manager);
  write(d.dir, 'base.txt', 'developer\n');
  write(d.dir, 'space ü [x] #file.bin', Buffer.from([0, 255, 13, 10]));
  const first = await snapshot(manager);
  const q = await manager.createQaWorktree({ milestoneId: 'm1' });
  assert.equal(git(q.dir, 'rev-parse', 'HEAD').toString().trim(), first);
  write(q.dir, 'base.txt', 'QA vandalism');
  write(q.dir, 'qa-only.txt', 'must never ship');
  write(d.dir, 'base.txt', 'retry\n');
  fs.unlinkSync(path.join(d.dir, 'space ü [x] #file.bin'));
  write(d.dir, 'new ü file.bin', Buffer.from([0, 255, 13, 10]));
  const second = await snapshot(manager);
  const q2 = await manager.createQaWorktree({ milestoneId: 'm1' });
  assert.equal(git(q2.dir, 'rev-parse', 'HEAD').toString().trim(), second);
  assert.equal(read(q2.dir, 'base.txt'), 'retry\n');
  assert.equal(fs.existsSync(path.join(q2.dir, 'qa-only.txt')), false);
  write(q2.dir, 'base.txt', 'unverified final QA mutation');
  write(q2.dir, 'qa-only.txt', 'must never ship');
  fs.unlinkSync(path.join(d.dir, 'base.txt')); // Post-snapshot changes must not ship either.
  await manager.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(read(workspace, 'base.txt'), 'retry\n');
  assert.deepEqual(fs.readFileSync(path.join(workspace, 'new ü file.bin')), Buffer.from([0, 255, 13, 10]));
  assert.equal(fs.existsSync(path.join(workspace, 'qa-only.txt')), false);
  const next = await dev(manager, 'm2');
  assert.equal(read(next.dir, 'base.txt'), 'retry\n');
  fs.unlinkSync(path.join(next.dir, 'base.txt'));
  await snapshot(manager, 'm2');
  await manager.integrateToTarget({ milestoneId: 'm2' });
  assert.equal(fs.existsSync(path.join(workspace, 'base.txt')), false);
});

test('dirty index/HEAD untouched; untracked baseline preserved; overlapping user edits conflict before any writes', async (t) => {
  const { workspace, manager } = await fixture(t, { repository: true });
  git(workspace, 'add', 'base.txt');
  git(workspace, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base');
  write(workspace, 'base.txt', 'dirty user version');
  git(workspace, 'add', 'base.txt');
  write(workspace, 'user.txt', 'untracked');
  const index = fs.readFileSync(path.join(workspace, '.git', 'index'));
  const head = git(workspace, 'rev-parse', 'HEAD');
  // A fresh manager snapshots the actual dirty content, not HEAD.
  const fresh = new WorktreeManager({ workspace, hiveDir: path.join(path.dirname(workspace), 'separate-hive'), runId: 'dirty' });
  await fresh.init(); t.after(() => fresh.close());
  const d = await dev(fresh);
  assert.equal(read(d.dir, 'base.txt'), 'dirty user version');
  write(d.dir, 'base.txt', 'agent'); write(d.dir, 'a-first.txt', 'agent');
  await snapshot(fresh);
  write(workspace, 'base.txt', 'concurrent user edit');
  await assert.rejects(fresh.integrateToTarget({ milestoneId: 'm1' }), /conflict/);
  assert.equal(fs.existsSync(path.join(workspace, 'a-first.txt')), false);
  assert.equal(read(workspace, 'base.txt'), 'concurrent user edit');
  assert.deepEqual(fs.readFileSync(path.join(workspace, '.git', 'index')), index);
  assert.deepEqual(git(workspace, 'rev-parse', 'HEAD'), head);
  assert.equal(read(workspace, 'user.txt'), 'untracked');
});

test('parallel integrations preserve non-overlapping snapshots and detect competing additions', async (t) => {
  const { workspace, manager } = await fixture(t);
  const [a, b] = await Promise.all([dev(manager, 'm1'), dev(manager, 'm2')]);
  write(a.dir, 'one', '1'); write(b.dir, 'two', '2');
  await snapshot(manager, 'm1'); await snapshot(manager, 'm2');
  await Promise.all(['m1', 'm2'].map((milestoneId) => manager.integrateToTarget({ milestoneId })));
  assert.equal(read(workspace, 'one'), '1'); assert.equal(read(workspace, 'two'), '2');
  const c = await dev(manager, 'm3'); write(c.dir, 'new', 'dev'); await snapshot(manager, 'm3');
  write(workspace, 'new', 'user');
  await assert.rejects(manager.integrateToTarget({ milestoneId: 'm3' }), /conflict/);
  assert.equal(read(workspace, 'new'), 'user');
});

test('nested Hive/runtime/credentials/ignored builds excluded without recursive snapshots', async (t) => {
  const root = fs.mkdtempSync(path.join(scratch, 'exclude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitignore', 'custom-cache/\n'); write(root, 'custom-cache/large', 'ignored');
  for (const name of ['hive/events.jsonl', 'node_modules/package/file', '.scratch/x', '.env', 'secret.pem', '.aws/credentials']) write(root, name, 'secret');
  write(root, 'source.js', 'source');
  const manager = new WorktreeManager({ workspace: root, hiveDir: path.join(root, 'hive'), runId: 'nested' });
  await manager.init(); t.after(() => manager.close());
  const d = await dev(manager);
  assert.deepEqual(fs.readdirSync(d.dir).sort(), ['.git', '.gitignore', '.scranton-sandbox-owned', 'source.js']);
  await snapshot(manager); assert.equal(manager.snapshots.get('m1').entries.size, 2);
});

test('links and target junction escapes are blocked; hardlinks rejected', async (t) => {
  const { root, workspace, manager } = await fixture(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); write(outside, 'secret', 'safe');
  const d = await dev(manager); write(d.dir, 'new/file', 'agent'); await snapshot(manager);
  fs.symlinkSync(outside, path.join(workspace, 'new'), 'junction');
  await assert.rejects(manager.integrateToTarget({ milestoneId: 'm1' }), /Link\/reparse/);
  assert.equal(read(outside, 'secret'), 'safe'); assert.equal(fs.existsSync(path.join(outside, 'file')), false);
  fs.symlinkSync(outside, path.join(d.dir, 'linked'), 'junction');
  await assert.rejects(snapshot(manager), /Link\/reparse/);
  fs.unlinkSync(path.join(d.dir, 'linked'));
  fs.linkSync(path.join(outside, 'secret'), path.join(d.dir, 'hardlink'));
  await assert.rejects(snapshot(manager), /independent regular/);
});

test('partial I/O failure rolls back earlier writes and removes new directories', async (t) => {
  const { workspace, manager } = await fixture(t);
  const d = await dev(manager); write(d.dir, 'aaa/new', 'new'); write(d.dir, 'base.txt', 'changed');
  await snapshot(manager);
  const rename = fs.renameSync;
  let failed = false;
  const replacement = t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && to === path.join(workspace, 'base.txt')) { failed = true; throw new Error('Injected disk failure'); }
    return rename(from, to);
  });
  await assert.rejects(manager.integrateToTarget({ milestoneId: 'm1' }), /Injected disk failure/);
  replacement.mock.restore();
  assert.equal(read(workspace, 'base.txt'), 'baseline\n');
  assert.equal(fs.existsSync(path.join(workspace, 'aaa')), false);
  await manager.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(read(workspace, 'base.txt'), 'changed');
});

test('close preserves failed worktree diagnostics and rejects further operations', async (t) => {
  const { manager } = await fixture(t); const d = await dev(manager);
  write(d.dir, 'failed-artifact', 'diagnostic'); await manager.close();
  assert.equal(read(d.dir, 'failed-artifact'), 'diagnostic');
  await assert.rejects(dev(manager, 'm2'), /not open/);
});

test('attribute filters cannot change QA bytes; edited worktree git pointers cannot redirect snapshots', async (t) => {
  const { workspace, manager } = await fixture(t, { repository: true });
  const d = await dev(manager);
  write(d.dir, '.gitattributes', '*.txt text eol=crlf\n');
  write(d.dir, 'base.txt', 'exact LF bytes\n');
  fs.unlinkSync(path.join(d.dir, '.git'));
  write(d.dir, '.git', `gitdir: ${path.join(workspace, '.git')}\n`);
  const ref = await snapshot(manager);
  const q = await manager.createQaWorktree({ milestoneId: 'm1' });
  assert.deepEqual(fs.readFileSync(path.join(q.dir, 'base.txt')), Buffer.from('exact LF bytes\n'));
  assert.equal(git(q.dir, 'rev-parse', 'HEAD').toString().trim(), ref);
  await manager.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(read(workspace, 'base.txt'), 'exact LF bytes\n');
  assert.equal(fs.existsSync(path.join(workspace, '.git', 'index')), false);
});

test('integration rejects a developer snapshot changed after the QA checkout', async (t) => {
  const { manager } = await fixture(t); const d = await dev(manager);
  write(d.dir, 'base.txt', 'reviewed'); await snapshot(manager);
  write(d.dir, 'base.txt', 'not reviewed'); await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  await assert.rejects(manager.integrateToTarget({ milestoneId: 'm1' }), /matching QA checkout/);
});

test('new ignore rules do not silently delete previously tracked snapshot content', async (t) => {
  const { workspace, manager } = await fixture(t); const d = await dev(manager);
  write(d.dir, '.gitignore', 'base.txt\n');
  await snapshot(manager); await manager.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(read(workspace, 'base.txt'), 'baseline\n');
});

test('rollback refuses to overwrite a concurrent user edit to an already-applied path', async (t) => {
  const { workspace, manager } = await fixture(t); const d = await dev(manager);
  write(d.dir, 'base.txt', 'agent'); write(d.dir, 'zzz', 'agent'); await snapshot(manager);
  const rename = fs.renameSync;
  const replacement = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(workspace, 'zzz')) {
      write(workspace, 'base.txt', 'concurrent human edit');
      throw new Error('Injected second-write failure');
    }
    return rename(from, to);
  });
  await assert.rejects(manager.integrateToTarget({ milestoneId: 'm1' }), /rollback incomplete/);
  replacement.mock.restore();
  assert.equal(read(workspace, 'base.txt'), 'concurrent human edit');
  assert.equal(fs.existsSync(path.join(workspace, 'zzz')), false);
});

test('even identical developer submissions receive pristine QA worktrees', async (t) => {
  const { manager } = await fixture(t); await dev(manager);
  await snapshot(manager);
  const first = await manager.createQaWorktree({ milestoneId: 'm1' });
  write(first.dir, 'qa-artifact', 'unverified');
  const next = await manager.createQaWorktree({ milestoneId: 'm1' });
  assert.notEqual(first.dir, next.dir);
  assert.equal(fs.existsSync(path.join(next.dir, 'qa-artifact')), false);
  assert.equal(fs.existsSync(first.dir), false, 'superseded QA checkout is removed');
  write(next.dir, 'qa-artifact', 'latest diagnostics');
  await manager.close();
  assert.equal(read(next.dir, 'qa-artifact'), 'latest diagnostics');
});

test('Git snapshot phases yield to timers and batch file objects and ignore queries', async (t) => {
  const root = fs.mkdtempSync(path.join(scratch, 'responsive-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (let i = 0; i < 32; i++) write(workspace, `file-${i}.bin`, Buffer.from([i, 0, 10, 255]));
  const manager = new WorktreeManager({ workspace, hiveDir: path.join(root, 'hive'), runId: 'responsive' });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [];
  const original = manager.git.bind(manager);
  manager.git = (...args) => { calls.push(args[0]); return original(...args); };
  const responsive = async (operation) => {
    let fired = false;
    const timer = setTimeout(() => { fired = true; }, 0);
    try { const result = await operation(); assert.equal(fired, true, 'Git work must not starve event-loop timers'); return result; }
    finally { clearTimeout(timer); }
  };
  await responsive(() => manager.init());
  const d = await responsive(() => dev(manager));
  write(d.dir, 'file-0.bin', Buffer.from([255, 10, 0, 42]));
  await responsive(() => manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' }));
  const q = await responsive(() => manager.createQaWorktree({ milestoneId: 'm1' }));
  assert.deepEqual(fs.readFileSync(path.join(q.dir, 'file-0.bin')), Buffer.from([255, 10, 0, 42]));
  assert.equal(calls.filter((args) => args.includes('hash-object')).length, 2);
  assert.ok(calls.filter((args) => args.includes('hash-object')).every((args) => args.includes('--stdin-paths') && args.includes('--no-filters')));
  assert.equal(calls.filter((args) => args.includes('cat-file')).length, 2);
  assert.ok(calls.filter((args) => args.includes('cat-file')).every((args) => args.includes('--batch')));
  assert.equal(calls.filter((args) => args.includes('check-ignore')).length, 2);
});

test('agent Git config/hooks/path pointers never control integration or change user index/HEAD', async (t) => {
  const { root, workspace, manager } = await fixture(t, { repository: true });
  git(workspace, 'add', 'base.txt');
  git(workspace, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base');
  write(workspace, 'staged.txt', 'user index bytes'); git(workspace, 'add', 'staged.txt');
  const index = fs.readFileSync(path.join(workspace, '.git', 'index'));
  const head = git(workspace, 'rev-parse', 'HEAD');
  const config = fs.readFileSync(path.join(workspace, '.git', 'config'));
  const d = await dev(manager);
  fs.unlinkSync(path.join(d.dir, '.git'));
  const marker = path.join(root, 'hook-ran').replaceAll('\\', '/');
  write(d.dir, '.git/config', `[core]\nworktree = ${workspace.replaceAll('\\', '/')}\nhooksPath = ${d.dir.replaceAll('\\', '/')}/.git/hooks\n[include]\npath = ${workspace.replaceAll('\\', '/')}/.git/config\n`);
  write(d.dir, '.git/hooks/post-checkout', `#!/bin/sh\necho unsafe > '${marker}'\n`);
  write(d.dir, '.git/commondir', path.join(workspace, '.git'));
  write(d.dir, '.git/objects/info/alternates', path.join(workspace, '.git', 'objects'));
  write(d.dir, 'base.txt', 'safe snapshot');
  await snapshot(manager);
  await manager.integrateToTarget({ milestoneId: 'm1' });
  assert.equal(read(workspace, 'base.txt'), 'safe snapshot');
  assert.equal(read(workspace, 'staged.txt'), 'user index bytes');
  assert.deepEqual(fs.readFileSync(path.join(workspace, '.git', 'index')), index);
  assert.deepEqual(git(workspace, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readFileSync(path.join(workspace, '.git', 'config')), config);
  assert.equal(fs.existsSync(marker), false);
  assert.ok([...manager.snapshots.get('m1').entries.keys()].every((name) => !name.startsWith('.git/')));
});

test('concurrent ignore collection has private rules and nested negations preserve tracked files', async (t) => {
  const { workspace, manager } = await fixture(t);
  const [a, b] = await Promise.all([dev(manager, 'm1'), dev(manager, 'm2')]);
  write(a.dir, '.gitignore', 'cache/\n*.log\n!keep.log\n');
  write(a.dir, 'cache/hidden', 'excluded'); write(a.dir, 'drop.log', 'excluded'); write(a.dir, 'keep.log', 'included');
  write(a.dir, 'nested/.gitignore', '*.txt\n!keep.txt\n');
  write(a.dir, 'nested/drop.txt', 'excluded'); write(a.dir, 'nested/keep.txt', 'included');
  write(b.dir, 'cache/visible', 'included'); write(b.dir, 'drop.log', 'included');
  await Promise.all(['m1', 'm2'].map((milestoneId) => manager.snapshotWorktree({ agent: 'dwight', milestoneId })));
  const first = manager.snapshots.get('m1').entries;
  const second = manager.snapshots.get('m2').entries;
  assert.equal(first.has('cache/hidden'), false); assert.equal(first.has('drop.log'), false);
  assert.equal(first.has('keep.log'), true); assert.equal(first.has('nested/keep.txt'), true); assert.equal(first.has('nested/drop.txt'), false);
  assert.equal(second.has('cache/visible'), true); assert.equal(second.has('drop.log'), true);
  assert.equal(read(workspace, 'base.txt'), 'baseline\n');
});
