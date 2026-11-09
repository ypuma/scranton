import { isolationTestEnv, isolationEntries, newTestIsolationEntries } from './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { cleanupIsolationStorage } from '../../src/core/worktree.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('.scratch/gitdir-fix3/check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('missing storage from an earlier root does not prevent Hive cleanup', (t) => {
  const root = fixture(t);
  const hive = path.join(root, 'hive');
  const pointers = path.join(hive, 'isolation');
  fs.mkdirSync(pointers, { recursive: true });
  const token = 'a'.repeat(32);
  const storage = path.join(root, 'earlier-root', token);
  const file = path.join(pointers, token + '.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, runId: 'old', storage, workspace: path.join(root, 'ws') }));
  fs.mkdirSync(storage, { recursive: true });
  assert.throws(() => cleanupIsolationStorage(hive), (err) => err.message.includes(storage) && /configured root/.test(err.message));
  assert.ok(fs.existsSync(file));
  fs.rmSync(storage, { recursive: true });
  assert.equal(cleanupIsolationStorage(hive), 0);
  assert.equal(fs.existsSync(file), false);
});

test('profile guard flags only newly added test-owned marker workspaces', (t) => {
  const root = fixture(t);
  const add = (name, workspace) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.scranton-isolation.json'), JSON.stringify({ workspace }));
  };
  add('existing', path.join(os.tmpdir(), 'old-test'));
  const before = isolationEntries(root);
  add('temp-test', path.join(os.tmpdir(), 'new-test'));
  add('scratch-test', path.resolve('.scratch/gitdir-fix3/workspace'));
  add('user', path.resolve('user-workspace'));
  add('sibling', os.tmpdir() + '-unrelated');
  assert.deepEqual(newTestIsolationEntries(before, root).sort(), ['scratch-test', 'temp-test']);
  assert.deepEqual(newTestIsolationEntries(isolationEntries(root), root), []);
  assert.ok(isolationTestEnv({ SCRANTON_ISOLATION_ROOT: 'unsafe' }).SCRANTON_ISOLATION_ROOT.startsWith(path.resolve('.scratch')));
});
