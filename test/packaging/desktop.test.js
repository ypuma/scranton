import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { desktopPlatform } from '../../scripts/desktop-platform.mjs';
import { verifyToolArchive } from '../../scripts/desktop-tools.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const app = path.join(root, 'src-tauri/staged/app');
const host = desktopPlatform();
const options = { skip: !existsSync(path.join(app, 'packaging-manifest.json')) && 'Run npm.cmd run app:prepare first' };
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('staged desktop contains own runtime, completion helpers and locked production dependencies; zero Pi files', options, async () => {
  const lock = await json(path.join(root, 'package-lock.json'));
  const manifest = await json(path.join(app, 'packaging-manifest.json'));
  assert.equal(manifest.runtime.engine, 'scranton');
  assert.equal(manifest.pi, undefined);
  for (const key of ['platform', 'arch', 'target']) assert.equal(manifest[key], host[key]);
  for (const [relative, pkg] of Object.entries(lock.packages)) {
    assert.doesNotMatch(relative, /@earendil-works/);
    if (!relative || pkg.dev || pkg.optional) continue;
    assert.equal((await json(path.join(app, relative, 'package.json'))).version, pkg.version, relative);
  }
  await assert.rejects(fs.access(path.join(app, 'node_modules/@tauri-apps/cli')));
  for (const file of ['tools/pipeline-complete.js', 'tools/dreaming-complete.js', 'tools/completion-client.js', 'scripts/runtime-smoke.mjs', 'THIRD_PARTY_NOTICES.md', 'tools-lock.json']) {
    assert.deepEqual(await fs.readFile(path.join(app, file)), await fs.readFile(path.join(root, file)), file);
  }
  for (const file of ['hive', '.env', '.pi', '.git', 'sessions', '.scratch']) await assert.rejects(fs.access(path.join(app, file)));
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      assert.doesNotMatch(entry.name, /^(?:pi-.*|fake-pi.*|.*-pi-complete\.js|@earendil-works)$/i, path.join(dir, entry.name));
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
    }
  }
  await visit(app);
});

test('bundled Node runs own runtime offline with empty PATH and isolated credentials', options, async () => {
  const profile = path.join(root, '.scratch/packaging/test-profile');
  await fs.mkdir(profile, { recursive: true });
  const node = path.join(root, 'src-tauri/binaries', host.nodeFile);
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, SCRANTON_CREDENTIALS_DIR: profile };
  const run = (entry) => spawnSync(node, [entry], { cwd: profile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const result = run(path.join(app, 'scripts/runtime-smoke.mjs'));
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Scranton offline runtime smoke passed/);
  assert.notEqual(run(path.join(profile, 'missing-runtime.mjs')).status, 0);
});

test('native sandbox sidecar is staged, registered and explicitly wired into Node startup', options, async () => {
  const manifest = await json(path.join(app, 'packaging-manifest.json'));
  assert.equal(manifest.sandboxHelper.file, `scranton-sandbox-helper-${host.target}${host.platform === 'win32' ? '.exe' : ''}`);
  const helper = path.join(root, 'src-tauri/binaries', manifest.sandboxHelper.file);
  assert.equal(hash(await fs.readFile(helper)), manifest.sandboxHelper.sha256);
  assert.ok((await json(path.join(root, 'src-tauri/tauri.conf.json'))).bundle.externalBin.includes('binaries/scranton-sandbox-helper'));
  const source = await fs.readFile(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  assert.match(source, /command\.env\("SCRANTON_SANDBOX_HELPER", &helper\)/);
  assert.match(source, /if !helper\.is_file\(\)/);
  const { resolveSandboxHelper } = await import(pathToFileURL(path.join(app, 'src/core/sandbox-native/index.js')));
  assert.equal(resolveSandboxHelper({ env: { SCRANTON_SANDBOX_HELPER: helper } }), helper);
  if (host.platform === 'win32') {
    const run = spawnSync(helper, ['exec', '--cwd', root, '--mode', 'low', '--', path.join(process.env.SystemRoot, 'System32/cmd.exe'), '/d', '/c', 'exit 0'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  }
});

test('all shipping targets have exact tool pins; native staged rg/fd match verified archives and resolve before PATH', options, async () => {
  const lock = await json(path.join(root, 'tools-lock.json'));
  const manifest = await json(path.join(app, 'packaging-manifest.json'));
  const { resolveBinaries } = await import(pathToFileURL(path.join(app, 'src/core/tools/binaries.js')));
  const resolved = resolveBinaries({ PATH: path.join(root, '.scratch/packaging/nonexistent') });
  for (const name of ['rg', 'fd']) {
    assert.deepEqual(Object.keys(lock.tools[name].targets).sort(), ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'].sort());
    for (const pin of Object.values(lock.tools[name].targets)) {
      assert.match(pin.sha256, /^[a-f0-9]{64}$/);
      assert.match(pin.url, /^https:\/\/github\.com\/(?:BurntSushi\/ripgrep|sharkdp\/fd)\/releases\/download\//);
    }
    const pin = lock.tools[name].targets[host.target], receipt = manifest.tools[name];
    const archive = await fs.readFile(path.join(root, '.scratch/packaging/tools-cache', path.basename(new URL(pin.url).pathname)));
    verifyToolArchive(archive, pin);
    const corrupted = Buffer.from(archive); corrupted[0] ^= 1;
    assert.throws(() => verifyToolArchive(corrupted, pin), /SHA-256 mismatch/);
    assert.equal(receipt.sha256, pin.sha256);
    assert.equal(receipt.version, lock.tools[name].version);
    const binary = path.join(app, receipt.file);
    assert.equal(hash(await fs.readFile(binary)), receipt.binarySha256);
    assert.equal(resolved[name], binary);
    const run = spawnSync(binary, ['--version'], { env: { SystemRoot: process.env.SystemRoot, PATH: '' }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(receipt.version));
  }
});

test('staged tools use bundled rg/fd offline and retain explicit native JS fallbacks', options, async (t) => {
  const scratch = path.join(root, '.scratch/packaging/search');
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, 'case-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture, 'sample.txt'), 'bundled search needle\n');
  const { runTool } = await import(pathToFileURL(path.join(app, 'src/core/tools/index.js')));
  const { resolveBinaries } = await import(pathToFileURL(path.join(app, 'src/core/tools/binaries.js')));
  for (const name of ['rg', 'fd']) {
    await fs.writeFile(path.join(fixture, name + (host.platform === 'win32' ? '.exe' : '')), 'must not execute');
    assert.equal(resolveBinaries({ PATH: fixture })[name], path.join(app, 'tools/bin', name + (host.platform === 'win32' ? '.exe' : '')));
  }
  for (const binaries of [undefined, {}]) {
    const launched = [];
    const ctx = { root: fixture, allow: ['grep', 'find'], env: { SystemRoot: process.env.SystemRoot, PATH: '' }, binaries,
      spawn: (file, args, options) => { launched.push(file); return spawn(file, args, options); } };
    const grep = await runTool('grep', { pattern: 'needle', glob: '*.txt' }, ctx);
    assert.equal(grep.isError, false, grep.content);
    assert.match(grep.content, /sample\.txt:1: bundled search needle/);
    const find = await runTool('find', { pattern: '*.txt' }, ctx);
    assert.equal(find.isError, false, find.content);
    assert.match(find.content, /sample\.txt/);
    assert.deepEqual(launched, binaries ? [] : ['rg', 'fd'].map((name) => path.join(app, 'tools/bin', name + (host.platform === 'win32' ? '.exe' : ''))));
  }
});

test('desktop sidecar uses registry data, legacy import and authenticated aggregate control', async () => {
  const source = await fs.readFile(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  assert.match(source, /\["app-server", "--data"\]/);
  assert.match(source, /arg\("--legacy-workspace"\)/);
  assert.doesNotMatch(source, /\["app-server", "--hive"\]/);
  assert.match(source, /X-Scranton-Client: 1/);
  assert.match(source, /pendingHuman.*as_u64/);
});
