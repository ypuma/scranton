import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkedPath } from '../../src/core/sandbox.js';
import { createSandbox } from '../../src/core/sandbox-docker/index.js';

function host(platform = 'darwin') {
  const links = new Map([['/var', 'private/var'], ['/tmp', '/private/tmp']]);
  const files = new Set(['/private/var/run/prompt.md']);
  const dirs = new Set(['/', '/private', '/private/var', '/private/var/run', '/private/var/run/session', '/private/tmp', '/private/tmp/work']);
  const realpath = (value) => {
    for (const [link, target] of links) if (value === link || value.startsWith(link + '/')) {
      return realpath(path.posix.resolve(path.posix.dirname(link), target) + value.slice(link.length));
    }
    return value;
  };
  const hostFs = {
    lstatSync(value) {
      if (!links.has(value) && !files.has(value) && !dirs.has(value)) throw Error(`Missing fixture: ${value}`);
      return { isSymbolicLink: () => links.has(value), isDirectory: () => dirs.has(value), isFile: () => files.has(value), nlink: 1 };
    },
    readlinkSync: (value) => links.get(value),
    realpathSync: { native: realpath }
  };
  return { platform, fs: hostFs, path: path.posix, links, files, dirs };
}

for (const [input, expected, directory] of [
  ['/var/run/session', '/private/var/run/session', true],
  ['/tmp/work', '/private/tmp/work', true],
  ['/var/run/prompt.md', '/private/var/run/prompt.md', false]
]) test(`verified macOS OS alias canonicalizes ${input}`, () => {
  assert.equal(checkedPath(input, directory, host()), expected);
});

test('alias exceptions are macOS-only and require exact observed targets', () => {
  for (const platform of ['linux', 'win32']) assert.throws(() => checkedPath('/var/run/session', true, host(platform)), /link\/reparse/);
  for (const target of ['/elsewhere', '/private/tmp', '/private/var-other', '/PRIVATE/var']) {
    const h = host(); h.links.set('/var', target);
    assert.throws(() => checkedPath('/var/run/session', true, h), /link\/reparse/);
  }
  const h = host(); h.fs.realpathSync.native = () => '/unexpected';
  assert.throws(() => checkedPath('/var/run/session', true, h), /link\/reparse/);
});

test('OS aliases never authorize arbitrary workspace, ancestor or canonical-target links', () => {
  for (const [link, target, input] of [
    ['/private/var/run/session', '/outside', '/var/run/session'],
    ['/private/var/run', '/outside', '/var/run/session'],
    ['/private', '/outside', '/var/run/session'],
    ['/private/var', '/outside', '/var/run/session'],
    ['/workspace', '/private/tmp/work', '/workspace'],
    ['/various', '/private/var', '/various/run/session']
  ]) {
    const h = host(); h.links.set(link, target);
    assert.throws(() => checkedPath(input, true, h), /link\/reparse/);
  }
});

test('canonical paths, mount syntax, types and file hardlinks retain their guards', () => {
  const h = host();
  assert.equal(checkedPath('/private/var/run/session', true, h), '/private/var/run/session');
  for (const value of ['relative', '/var/run/a,b', '/var/run/a\n', '/var/run/a\0']) assert.throws(() => checkedPath(value, true, h), /absolute/);
  assert.throws(() => checkedPath('/var/run/prompt.md', true, h), /mount type/);
  assert.throws(() => checkedPath('/var/run/session', false, h), /mount type/);
  const stat = h.fs.lstatSync;
  h.fs.lstatSync = (p) => ({ ...stat(p), nlink: 2 });
  assert.throws(() => checkedPath('/var/run/prompt.md', false, h), /mount type/);
});

test('real POSIX fixtures: links rejected, private worktree guards and readonly masks retained', { skip: process.platform === 'win32' }, async (t) => {
  const base = path.resolve('.scratch/posix-port/sandbox'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), session = path.join(root, 'session'), prompt = path.join(root, 'prompt.md');
  fs.mkdirSync(work); fs.mkdirSync(session); fs.writeFileSync(prompt, 'prompt');
  fs.writeFileSync(path.join(work, '.git'), 'gitdir: /host-only/private.git\n');
  let args;
  const deps = { executable: '/mock/docker', runSync: (_exe, argv) => { if (argv[0] === 'run') args = argv; return ['info', 'image'].includes(argv[0]) ? 'linux' : ''; }, run: async () => '' };
  const options = { worktree: work, tempDir: session };
  const launch = createSandbox(options, deps); launch.prepare();
  const mounts = args.filter((_, i, a) => a[i - 1] === '--mount');
  assert.equal(mounts.length, 2);
  assert.equal(mounts.some(m => m.includes(prompt)), false, 'prompts stay on the host');
  const mask = mounts.find((m) => m.endsWith('target=/workspace/.git,readonly')).slice('type=bind,source='.length).split(',target=')[0];
  assert.equal(fs.statSync(mask).mode & 0o222, 0);
  await launch.dispose(); assert.equal(fs.existsSync(mask), false);
  assert.throws(() => createSandbox({ ...options, tempDir: work }, deps).prepare(), /must be disjoint/);
  const link = path.join(root, 'escape'); fs.symlinkSync(session, link);
  assert.throws(() => checkedPath(link, true), /link\/reparse/);
  assert.throws(() => createSandbox({ ...options, worktree: link }, deps).prepare(), /link\/reparse/);
  const ancestor = path.join(root, 'ancestor'); fs.symlinkSync(root, ancestor);
  assert.throws(() => checkedPath(path.join(ancestor, 'session'), true), /link\/reparse/);
  fs.unlinkSync(path.join(work, '.git')); fs.mkdirSync(path.join(work, '.git'));
  assert.throws(() => createSandbox(options, deps).prepare(), /mount type/);
});
