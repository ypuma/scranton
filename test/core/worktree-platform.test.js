import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safePath, WorktreeManager } from '../../src/core/worktree.js';

function host(platform = 'darwin') {
  const links = new Map([['/var', 'private/var'], ['/tmp', '/private/tmp']]);
  const dirs = new Set(['/', '/private', '/private/var', '/private/var/run', '/private/var/run/work', '/private/var/run/hive', '/private/tmp', '/private/tmp/work']);
  const realpath = (value) => {
    for (const [link, target] of links) if (value === link || value.startsWith(link + '/')) {
      return realpath(path.posix.resolve(path.posix.dirname(link), target) + value.slice(link.length));
    }
    return value;
  };
  const hostFs = {
    lstatSync(value) {
      const canonical = realpath(value);
      if (!links.has(value) && !dirs.has(canonical)) throw Object.assign(Error(`Missing fixture: ${value}`), { code: 'ENOENT' });
      return { isSymbolicLink: () => links.has(value), isDirectory: () => dirs.has(canonical) };
    },
    readlinkSync: (value) => links.get(value),
    realpathSync: { native: realpath }
  };
  return { platform, fs: hostFs, path: path.posix, links, dirs };
}

for (const root of ['/var/run/work', '/var/run/hive', '/tmp/work']) {
  test(`Darwin verified OS alias permits worktree root ${root} and missing children`, () => {
    const h = host();
    assert.equal(safePath(root, '', h), root, 'preserve caller path identity');
    assert.equal(safePath(root, 'new/file.txt', h), root + '/new/file.txt');
  });
}

test('worktree alias permission is Darwin-only and requires exact readlink AND realpath', () => {
  for (const platform of ['linux', 'win32']) assert.throws(() => safePath('/var/run/work', '', host(platform)), /Link\/reparse/);
  for (const alias of ['/var', '/tmp']) {
    for (const target of ['/outside', '/private/var-other', '/PRIVATE' + alias, '/private' + alias + '/nested']) {
      const h = host(); h.links.set(alias, target);
      assert.throws(() => safePath(alias + '/work', '', h), /Link\/reparse/);
    }
    const h = host();
    const realpath = h.fs.realpathSync.native;
    h.fs.realpathSync.native = (value) => value === alias ? '/unexpected' : realpath(value);
    assert.throws(() => safePath(alias + '/work', '', h), /Link\/reparse/);
    h.fs.readlinkSync = () => { throw Error('Unreadable alias'); };
    assert.throws(() => safePath(alias + '/work', '', h), /Unreadable alias/);
  }
});

test('canonical ancestors, descendants, non-OS aliases and reparse mismatches remain rejected', () => {
  for (const [link, input] of [
    ['/private', '/var/run/work'], ['/private/var', '/var/run/work'],
    ['/private/var/run', '/var/run/work'], ['/private/var/run/work', '/var/run/work'],
    ['/private/var/run/work/child', '/var/run/work/child/file'],
    ['/private/tmp', '/tmp/work'], ['/private/tmp/work', '/tmp/work'],
    ['/workspace', '/workspace'], ['/various', '/various/work']
  ]) {
    const h = host(); h.links.set(link, '/outside');
    assert.throws(() => safePath(input, '', h), /Link\/reparse/, input);
  }
  const h = host(); const realpath = h.fs.realpathSync.native;
  h.fs.realpathSync.native = (p) => p === '/private/var/run/work' ? '/outside' : realpath(p);
  assert.throws(() => safePath('/var/run/work', '', h), /Link\/reparse/);
});

test('canonical roots, ordinary root directories and unsafe relative paths keep existing behavior', () => {
  const h = host();
  assert.equal(safePath('/private/var/run/work', '', h), '/private/var/run/work');
  h.links.delete('/tmp'); h.dirs.add('/tmp'); h.dirs.add('/tmp/work');
  assert.equal(safePath('/tmp/work', '', h), '/tmp/work');
  for (const relative of ['../escape', '/escape', 'a//b', 'a/./b', 'a\\b', 'x:y', 'x\0', 'con', 'trailing.']) {
    assert.throws(() => safePath('/var/run/work', relative, h), /Unsafe path/);
  }
});

test('real filesystem collection still rejects linked roots, ancestor links and hardlinked entries', async (t) => {
  const base = path.resolve('.scratch/worktree-platform'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), outside = path.join(root, 'outside'), storage = path.join(root, 'storage');
  for (const dir of [work, outside, storage]) fs.mkdirSync(dir);
  const manager = new WorktreeManager({ workspace: work, hiveDir: path.join(root, 'hive'), runId: 'platform' });
  manager.storage = storage;
  manager.git = async () => Buffer.alloc(0);
  fs.writeFileSync(path.join(work, 'file'), 'baseline');
  assert.equal((await manager.collect(work)).get('file').data.toString(), 'baseline');
  const link = path.join(root, 'alias'); fs.symlinkSync(work, link, 'junction');
  assert.throws(() => safePath(link), /Link\/reparse/);
  assert.throws(() => safePath(link, 'file'), /Link\/reparse/);
  const linkedManager = new WorktreeManager({ workspace: link, hiveDir: path.join(root, 'hive'), runId: 'linked' });
  await assert.rejects(linkedManager.init(), /Link\/reparse/, 'init validates original workspace before creating storage');
  fs.symlinkSync(outside, path.join(work, 'escape'), 'junction');
  await assert.rejects(manager.collect(work), /Link\/reparse/);
  fs.unlinkSync(path.join(work, 'escape'));
  fs.linkSync(path.join(work, 'file'), path.join(outside, 'hardlink'));
  await assert.rejects(manager.collect(work), /independent regular/);
  assert.equal(fs.readdirSync(storage).length, 0, 'temporary ignore storage is cleaned on rejection');
});
