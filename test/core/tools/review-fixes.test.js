import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTool } from '../../../src/core/tools/index.js';
import { DEFAULT_LIMITS } from '../../../src/core/tools/truncate.js';

const scratch = path.resolve('.scratch/tools-tests');
fs.mkdirSync(scratch, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, call: (name, args, extra = {}) => runTool(name, args, { root, allow: [name], binaries: {}, ...extra }) };
}

test('ReDoS fallback times out while the main thread keeps ticking', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'evil'), 'a'.repeat(100000) + '!');
  assert.equal(DEFAULT_LIMITS.grepTimeoutMs, 5000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const start = performance.now();
  try {
    const result = await f.call('grep', { pattern: '(a+)+$' }, { limits: { grepTimeoutMs: 300 } });
    assert.equal(result.isError, true);
    assert.match(result.content, /Native grep timed out after 300 ms/);
    assert.ok(performance.now() - start < 3000);
    assert.ok(ticks >= 5, `Only ${ticks} timer ticks`);
  } finally { clearInterval(timer); }
});

test('ReDoS fallback can be aborted independently of its timeout', async (t) => {
  const f = fixture(t), controller = new AbortController();
  fs.writeFileSync(path.join(f.root, 'evil'), 'a'.repeat(100000) + '!');
  const timer = setTimeout(() => controller.abort(), 200);
  const start = performance.now();
  try {
    const result = await f.call('grep', { pattern: '(a+)+$' }, { signal: controller.signal });
    assert.equal(result.isError, true);
    assert.match(result.content, /aborted/);
    assert.ok(performance.now() - start < 3000);
  } finally { clearTimeout(timer); }
});

test('POSIX names list and search without Windows name restrictions', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const names = ['aux.c', 'a:b', 'trail.', 'trail '];
  for (const name of names) fs.writeFileSync(path.join(f.root, name), 'hit');
  for (const tool of ['ls', 'find', 'grep']) {
    const result = await f.call(tool, tool === 'grep' ? { pattern: 'hit' } : tool === 'find' ? { pattern: '*' } : {});
    assert.equal(result.isError, false, result.content);
    for (const name of names) assert.ok(result.content.includes(name), result.content);
  }
  for (const name of names) assert.equal((await f.call('read', { path: name })).isError, false);
});

test('write refuses a parent swapped after temp creation', async (t) => {
  const f = fixture(t);
  const parent = path.join(f.root, 'parent'), saved = path.join(f.root, 'saved');
  const outside = fs.mkdtempSync(path.join(scratch, 'outside-review-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(outside, 'victim'), 'outside');
  const writeFile = fs.writeFileSync, rename = fs.renameSync;
  let swapped = false, commits = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('.tmp')) commits++;
    return rename(from, to);
  });
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    const result = writeFile(file, ...args);
    if (String(file).startsWith(parent + path.sep) && String(file).endsWith('.tmp')) {
      fs.renameSync(parent, saved);
      fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      swapped = true;
    }
    return result;
  });
  const result = await f.call('write', { path: 'parent/victim', content: 'bad' });
  assert.equal(swapped, true);
  assert.equal(result.isError, true);
  assert.equal(commits, 0, 'The changed parent must be refused before attempting rename');
  assert.match(result.content, /Link\/reparse|parent directory changed/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim'), 'utf8'), 'outside');
  assert.deepEqual(fs.readdirSync(outside), ['victim']);
});

test('POSIX new files use default permissions and replacements preserve mode', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t), file = path.join(f.root, 'file');
  assert.equal((await f.call('write', { path: 'file', content: 'one' })).isError, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o666 & ~process.umask());
  fs.chmodSync(file, 0o751);
  assert.equal((await f.call('write', { path: 'file', content: 'two' })).isError, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o751);
  assert.equal((await f.call('edit', { path: 'file', oldText: 'two', newText: 'three' })).isError, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o751);
});
