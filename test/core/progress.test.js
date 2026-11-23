import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import { sharedFingerprint } from '../../src/core/progress.js';

const testTimeout = 30000;
const exec = promisify(execFile);
const git = (workspace, ...args) => exec('git', ['-C', workspace, ...args], { windowsHide: true, timeout: testTimeout });
// These tests exercise scan results, not the production deadline under suite load.
const fingerprint = (workspace, hive, options) => sharedFingerprint(workspace, hive, { timeoutMs: testTimeout, ...options });

async function fixture(t) {
  const root = path.resolve('.scratch/suite/progress');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'scan-'));
  const workspace = path.join(dir, 'workspace'), hive = path.join(workspace, 'hive');
  await fs.mkdir(hive, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await git(workspace, 'init', '--quiet');
  return { workspace, hive };
}

test('shared fingerprints use snapshot exclusions and nested Git ignore rules without workspace config', async t => {
  const { workspace, hive } = await fixture(t);
  const write = async (name, text) => { const file = path.join(workspace, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  await write('source.txt', 'first');
  await git(workspace, 'add', 'source.txt');
  await write('.git/config', '[core]\nfsmonitor = forbidden-command\n');
  await write('.gitignore', 'ignored/\n*.tmp\n!keep.tmp\n');
  await write('nested/.gitignore', '/local.txt\n');
  const before = await fingerprint(workspace, hive);
  assert.equal(typeof before, 'string');
  for (const name of ['ignored/file.txt', 'nested/local.txt', 'nested/drop.tmp', '.env', 'node_modules/pkg/index.js', '.scratch/noise.txt', 'hive/noise.txt']) await write(name, 'excluded');
  assert.equal(await fingerprint(workspace, hive), before);
  await write('keep.tmp', 'included by negation');
  const changed = await fingerprint(workspace, hive);
  assert.notEqual(changed, before); assert.equal(typeof changed, 'string');
  await write('source.txt', 'second');
  assert.notEqual(await fingerprint(workspace, hive), changed);
});

test('tracked files and parent directories survive matching Git ignore rules', async t => {
  const { workspace, hive } = await fixture(t);
  await fs.mkdir(path.join(workspace, 'ignored'));
  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored/\n*.txt\n');
  for (const name of ['tracked.txt', 'ignored/tracked.txt']) {
    await fs.writeFile(path.join(workspace, name), 'before');
    await git(workspace, 'add', '--force', name);
  }
  let before = await fingerprint(workspace, hive);
  assert.equal(typeof before, 'string');
  for (const name of ['tracked.txt', 'ignored/tracked.txt']) {
    await fs.writeFile(path.join(workspace, name), 'after');
    const after = await fingerprint(workspace, hive);
    assert.equal(typeof after, 'string');
    assert.notEqual(after, before, name);
    before = after;
  }
  await fs.writeFile(path.join(workspace, '.git', 'index'), 'invalid index');
  assert.equal(await fingerprint(workspace, hive), null, 'failed tracked lookup is unknown');
});

for (const code of ['EBUSY', 'EACCES', 'ENOENT']) test(`injected ${code} during an async file read returns unknown`, async t => {
  const { workspace, hive } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'file.txt'), 'content');
  let attempted = false;
  assert.equal(await fingerprint(workspace, hive, { fs: { ...fs, async open() { attempted = true; throw Object.assign(new Error(code), { code }); } } }), null);
  assert.equal(attempted, true);
});

test('large shared trees stop within entry and byte budgets and yield to the event loop', async t => {
  const { workspace, hive } = await fixture(t);
  for (let n = 0; n < 100; n++) await fs.writeFile(path.join(workspace, `file-${n}.txt`), 'x'.repeat(1024));
  let ticks = 0, opens = 0;
  const timer = setInterval(() => ticks++, 1);
  const io = { ...fs, async open(...args) { opens++; return fs.open(...args); } };
  try {
    assert.equal(await fingerprint(workspace, hive, { fs: io, maxEntries: 20 }), null);
    assert.equal(opens, 0, 'entry limit stops before reading file bytes');
    assert.equal(await fingerprint(workspace, hive, { fs: io, maxBytes: 1024 }), null);
    assert.ok(opens <= 2, `read ${opens} files before byte limit`);
    assert.ok(ticks > 0, 'timer runs during scan');
  } finally { clearInterval(timer); }
});

test('deadline returns unknown even when a filesystem operation has not completed', { timeout: testTimeout }, async t => {
  const { workspace, hive } = await fixture(t);
  const entered = Promise.withResolvers();
  const blocked = Promise.withResolvers();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fingerprint(workspace, hive, { fs: { ...fs, async opendir(...args) { entered.resolve(); await blocked.promise; return fs.opendir(...args); } } });
  try {
    // If Git or the scan fails before opendir, fail here rather than waiting forever.
    await Promise.race([entered.promise, pending.then(() => assert.fail('scan ended before opendir'))]);
    t.mock.timers.tick(testTimeout);
    assert.equal(await Promise.race([pending, setImmediate('still pending')]), null);
  } finally {
    blocked.resolve();
    t.mock.timers.reset();
  }
  // Let the abandoned walker observe cancellation and clean its private scratch.
  for (let n = 0; n < 100 && (await fs.readdir(hive)).length; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await fs.readdir(hive), []);
});
