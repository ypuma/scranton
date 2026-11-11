import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPlatform, assertNativeBuild, launchManifest, validateNodeBinary } from '../../scripts/desktop-platform.mjs';
import { bootstrap, runtimeFiles, validateRuntimeLock, runtimeCacheKey, runtimeFingerprint, runtimeCacheValid, lockedWheels } from '../../scripts/desktop-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrix = [['win32', 'x64', 'x86_64-pc-windows-msvc'], ['darwin', 'x64', 'x86_64-apple-darwin'],
  ['darwin', 'arm64', 'aarch64-apple-darwin'], ['linux', 'x64', 'x86_64-unknown-linux-gnu'], ['linux', 'arm64', 'aarch64-unknown-linux-gnu']];

test('native platform matrix and exact launch manifest; unsupported/cross/universal/musl rejected', () => {
  for (const [platform, arch, target] of matrix) {
    const host = desktopPlatform(platform, arch);
    assert.deepEqual(host, { platform, arch, target, nodeFile: `scranton-node-${target}${platform === 'win32' ? '.exe' : ''}` });
    assert.deepEqual(launchManifest(host), { schema: 1, platform, arch, executable: platform === 'win32' ? 'python/python.exe' : 'python/bin/python3', args: ['-I', '-B', 'bootstrap.py'] });
    assert.deepEqual(assertNativeBuild(host, {}, { header: { glibcVersionRuntime: '2.28' } }), host);
    for (const key of ['CARGO_BUILD_TARGET', 'TAURI_ENV_TARGET_TRIPLE', 'npm_config_arch', 'npm_config_target_arch', 'npm_config_platform']) {
      assert.throws(() => assertNativeBuild(host, { [key]: 'universal-apple-darwin' }, { header: { glibcVersionRuntime: '2.28' } }), /Cross-target/);
    }
  }
  for (const pair of [['win32', 'arm64'], ['darwin', 'universal'], ['linux', 'ia32'], ['freebsd', 'x64']]) assert.throws(() => desktopPlatform(...pair), /Unsupported/);
  assert.throws(() => assertNativeBuild(desktopPlatform('linux', 'x64'), {}, { header: {} }), /musl/);
  assert.throws(() => assertNativeBuild(desktopPlatform('linux', 'x64'), {}, { header: { glibcVersionRuntime: '2.27' } }), /2.28/);
});

test('binary identity rejects universal and wrong-architecture Node inputs', async () => {
  validateNodeBinary(await fs.readFile(process.execPath));
  for (const arch of ['x64', 'arm64']) {
    const host = desktopPlatform('darwin', arch), thin = Buffer.alloc(32);
    thin.writeUInt32LE(0xfeedfacf); thin.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    validateNodeBinary(thin, host);
    assert.throws(() => validateNodeBinary(thin, desktopPlatform('darwin', arch === 'x64' ? 'arm64' : 'x64')), /architecture/);
    thin.writeUInt32BE(0xcafebabe);
    assert.throws(() => validateNodeBinary(thin, host), /universal/);
  }
  assert.throws(() => validateNodeBinary(Buffer.alloc(1)), /Expected/);
});

test('each platform has a complete trusted archive and exact hash-pinned wheel closure', async () => {
  const windowsPins = (await fs.readFile(path.join(root, 'engine/requirements.lock'), 'utf8')).split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => l.split(' ')[0]).sort();
  for (const [platform, arch] of matrix) {
    const host = desktopPlatform(platform, arch), files = runtimeFiles(host);
    const lock = JSON.parse(await fs.readFile(path.join(root, 'engine', files.archive)));
    validateRuntimeLock(lock, host);
    assert.throws(() => validateRuntimeLock({ ...lock, url: 'https://untrusted.invalid/python.tar.gz' }, host), /trusted/);
    const requirements = await fs.readFile(path.join(root, 'engine', files.requirements), 'utf8');
    const pins = requirements.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
    assert.deepEqual(pins.map(l => l.split(' ')[0]).sort(), windowsPins);
    assert.ok(pins.every(l => /^[\w-]+==\S+ --hash=sha256:[a-f0-9]{64}$/.test(l)));
    if (platform !== 'win32') {
      const hashes = new Set([...requirements.matchAll(/--hash=sha256:([a-f0-9]{64})/g)].map(m => m[1]));
      assert.equal(lockedWheels(lock, hashes).length, pins.length);
      assert.throws(() => lockedWheels({ ...lock, wheels: lock.wheels.slice(1) }, hashes), /Incomplete/);
      assert.throws(() => lockedWheels({ ...lock, wheels: lock.wheels.map((w, i) => i ? w : { ...w, url: 'https://evil.invalid/x.whl' }) }, hashes), /Invalid/);
    }
  }
});

test('cache binds host, lock, filter, bootstrap and launch; stale/tampered files fail closed', async (t) => {
  const base = path.join(root, '.scratch/desktop-port/unit'); await fs.mkdir(base, { recursive: true });
  const runtime = await fs.mkdtemp(path.join(base, 'cache-')); t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const host = desktopPlatform();
  const key = runtimeCacheKey(host, { sha256: 'a' }, 'requirements', 'filter');
  assert.notEqual(key, runtimeCacheKey({ ...host, arch: 'different' }, { sha256: 'a' }, 'requirements', 'filter'));
  assert.notEqual(key, runtimeCacheKey(host, { sha256: 'b' }, 'requirements', 'filter'));
  assert.notEqual(key, runtimeCacheKey(host, { sha256: 'a' }, 'changed', 'filter'));
  assert.notEqual(key, runtimeCacheKey(host, { sha256: 'a' }, 'requirements', 'changed'));
  await fs.writeFile(path.join(runtime, 'bootstrap.py'), bootstrap);
  await fs.writeFile(path.join(runtime, 'launch.json'), JSON.stringify(launchManifest(host)));
  const receipt = { key, sha256: (await runtimeFingerprint(runtime)).sha256 };
  assert.equal(await runtimeCacheValid(runtime, receipt, key, host), true);
  assert.equal(await runtimeCacheValid(runtime, receipt, 'stale', host), false);
  await fs.writeFile(path.join(runtime, 'bootstrap.py'), '# tampered');
  assert.equal(await runtimeCacheValid(runtime, receipt, key, host), false);
  await fs.writeFile(path.join(runtime, 'launch.json'), JSON.stringify({ ...launchManifest(host), args: ['-m', 'scranton_pipeline'] }));
  receipt.sha256 = (await runtimeFingerprint(runtime)).sha256;
  assert.equal(await runtimeCacheValid(runtime, receipt, key, host), false, 'matching receipt cannot bless an obsolete launch format');
});

test('private dependencies preserve only certifi public CA data; all other credential filters remain', async (t) => {
  const { prunePipeline } = await import('../../scripts/prepare-desktop.mjs');
  const base = path.join(root, '.scratch/desktop-port/unit');
  await fs.mkdir(base, { recursive: true });
  const packages = await fs.mkdtemp(path.join(base, 'certifi-'));
  t.after(() => fs.rm(packages, { recursive: true, force: true }));
  const keep = 'certifi/cacert.pem';
  const forbidden = ['cacert.pem', 'certifi/private.pem', 'certifi/cacert.key', 'other/cacert.pem',
    'nested/certifi/cacert.pem', 'auth.json', 'credentials.json', '.env', 'other/token.p12', 'other/token.pfx'];
  for (const file of [keep, ...forbidden]) {
    await fs.mkdir(path.dirname(path.join(packages, file)), { recursive: true });
    await fs.writeFile(path.join(packages, file), 'fixture public CA');
  }
  await prunePipeline(packages);
  assert.equal(await fs.readFile(path.join(packages, keep), 'utf8'), 'fixture public CA');
  for (const file of forbidden) await assert.rejects(fs.access(path.join(packages, file)), { code: 'ENOENT' });
});
