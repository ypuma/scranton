import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateTestKeypair, readReleaseConfig, tauriCliPath, verifyReleaseArtifact, withoutSigningEnv } from '../../scripts/release-updater.mjs';

const script = fileURLToPath(new URL('../../scripts/release-updater.mjs', import.meta.url));
const scratch = fileURLToPath(new URL('../../.scratch/multi-platform-a2/', import.meta.url));
const { version } = await readReleaseConfig();
const commit = '0123456789abcdef0123456789abcdef01234567';
const plans = [
  ['aarch64-apple-darwin', 'darwin-aarch64', 'aarch64.dmg', 'dmg', 'aarch64.app.tar.gz', 'app'],
  ['x86_64-unknown-linux-gnu', 'linux-x86_64', 'amd64.deb', 'deb', 'amd64.AppImage', 'appimage'],
  ['aarch64-unknown-linux-gnu', 'linux-aarch64', 'arm64.deb', 'deb', 'aarch64.AppImage', 'appimage'],
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t, { lanes = plans.slice(0, 1), signed = false, signVersion = version } = {}) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'assemble-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const notes = path.join(root, 'notes.md');
  await fs.writeFile(notes, 'Mock release notes\n');
  const winDir = path.join(root, 'windows');
  await fs.mkdir(winDir);
  const windows = path.join(winDir, `Scranton_${version}_x64-setup.exe`);
  const bytes = Buffer.from('Fixture NSIS');
  await fs.writeFile(windows, bytes);
  const target = 'x86_64-pc-windows-msvc';
  const winReceipt = path.join(winDir, `desktop-receipt-${target}.json`);
  const winDoc = { schema: 1, commit, version, target, platform: 'windows-x86_64',
    files: [{ name: path.basename(windows), bundle: 'nsis', role: 'updater', size: bytes.length, sha256: digest(bytes) }] };
  const saveWindows = () => fs.writeFile(winReceipt, JSON.stringify(winDoc));
  await saveWindows();
  const env = { ...withoutSigningEnv(), USERPROFILE: path.join(root, 'profile'),
    SCRANTON_CREDENTIALS_DIR: path.join(root, 'credentials'), PI_CODING_AGENT_DIR: path.join(root, 'pi') };
  if (signed) {
    const cli = tauriCliPath();
    const { privateKey, publicKey } = await generateTestKeypair(cli, root, env);
    const result = spawnSync(process.execPath, [cli, 'signer', 'sign', '--app-version', signVersion, windows], {
      cwd: root, env: { ...env, TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
      stdio: 'ignore', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.status, 0, 'fixture Tauri signing');
    await fs.writeFile(path.join(winDir, 'TEST-KEY.json'), JSON.stringify({ publishable: false, publicKey }));
  }
  const imports = [];
  for (const [target, platform, installerFile, installerBundle, updaterFile, updaterBundle] of lanes) {
    const dir = path.join(root, target);
    await fs.mkdir(dir);
    const doc = { schema: 1, commit, version, target, platform, files: [] };
    for (const [suffix, bundle, role] of [[installerFile, installerBundle, 'installer'], [updaterFile, updaterBundle, 'updater']]) {
      const name = `Scranton_${version}_${suffix}`;
      const bytes = Buffer.from(`Mock bytes for ${bundle} in ${platform}`);
      await fs.writeFile(path.join(dir, name), bytes);
      doc.files.push({ name, bundle, role, size: bytes.length, sha256: digest(bytes) });
    }
    const receipt = path.join(dir, `desktop-receipt-${target}.json`);
    const save = () => fs.writeFile(receipt, JSON.stringify(doc));
    await save();
    imports.push({ dir, receipt, doc, save, updater: path.join(dir, doc.files[1].name) });
  }
  const omitted = plans.filter(plan => !lanes.includes(plan)).map(([, platform]) => platform.startsWith('linux-') ? `${platform}-appimage` : platform);
  function run({ testKey = true, laneDirs = imports.map(lane => lane.dir), exe = windows, expected = commit, omit = omitted, provenance } = {}) {
    const result = spawnSync(process.execPath, [script, '--assemble', '--commit', expected, '--stage', stage,
      '--notes-file', notes, '--windows', exe, ...(testKey ? ['--test-key'] : []), ...laneDirs.flatMap(dir => ['--lane', dir]),
      ...omit.flatMap(key => ['--omit', key]), ...(provenance ? ['--provenance', provenance] : [])], {
      cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.ifError(result.error);
    return result;
  }
  async function refuse(message, options) {
    const result = run(options);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
    await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(`${stage}.assemble-lock`), { code: 'ENOENT' });
  }
  return { root, stage, windows, winDir, winReceipt, winDoc, saveWindows, imports, run, refuse };
}

test('assemble signs all POSIX updaters, preserves Windows signature, and stages one verified feed', async t => {
  const f = await fixture(t, { lanes: plans, signed: true });
  const provenance = Object.fromEntries(f.imports.map(({ doc }, i) => [doc.platform.startsWith('linux-') ? `${doc.platform}-appimage` : doc.platform, {
    run_id: 123, head_sha: commit, workflow_path: '.github/workflows/desktop-native.yml', event: 'workflow_dispatch', conclusion: 'success',
    artifact: { name: `scranton-${doc.target}`, id: i + 1, digest: `sha256:${'a'.repeat(64)}` },
  }]));
  const provenanceFile = path.join(f.root, 'provenance.json');
  const save = () => fs.writeFile(provenanceFile, JSON.stringify(provenance));
  provenance['darwin-aarch64'].head_sha = 'a'.repeat(40);
  await save();
  await f.refuse(/Provenance head_sha mismatch/, { provenance: provenanceFile });
  provenance['darwin-aarch64'].head_sha = commit;
  await save();
  const run = f.run({ provenance: provenanceFile });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /TEST KEY - DO NOT PUBLISH/);
  const stageFile = name => path.join(f.stage, name);
  const feed = await readJson(stageFile('latest.json'));
  const signatureKeys = await readJson(stageFile('TEST-KEY.json'));
  const report = await readJson(stageFile('stage-receipt.json'));
  const windowsName = path.basename(f.windows);
  const expected = {
    'windows-x86_64': windowsName,
    'darwin-aarch64': `Scranton_${version}_aarch64.app.tar.gz`,
    'linux-x86_64-appimage': `Scranton_${version}_amd64.AppImage`,
    'linux-aarch64-appimage': `Scranton_${version}_aarch64.AppImage`,
  };
  assert.equal(feed.version, version);
  assert.equal(feed.notes, 'Mock release notes\n');
  assert.equal(new Date(feed.pub_date).toISOString(), feed.pub_date);
  assert.deepEqual(Object.keys(feed.platforms).sort(), Object.keys(expected).sort());
  assert.deepEqual({ ...report, files: undefined }, { schema: 1, commit, version, publishable: false,
    platformKeys: Object.keys(expected).sort(), omitted: [], provenance, files: undefined });
  assert.equal(signatureKeys.publishable, false);
  for (const [key, name] of Object.entries(expected)) {
    const sig = await fs.readFile(stageFile(`${name}.sig`), 'utf8');
    assert.deepEqual(feed.platforms[key], { signature: sig,
      url: `https://github.com/ypuma/scranton/releases/download/v${version}/${encodeURIComponent(name)}` });
    if (key === 'windows-x86_64') assert.equal(sig, await fs.readFile(`${f.windows}.sig`, 'utf8'));
    await verifyReleaseArtifact(stageFile(name), sig, key === 'windows-x86_64' ? signatureKeys.publicKey : signatureKeys.posixPublicKey, version);
  }
  for (const lane of f.imports) for (const file of lane.doc.files) {
    assert.deepEqual(await fs.readFile(stageFile(file.name)), await fs.readFile(path.join(lane.dir, file.name)));
  }
  const assetNames = [windowsName, ...f.imports.flatMap(lane => lane.doc.files.map(file => file.name)),
    ...Object.values(expected).map(name => `${name}.sig`), 'TEST-KEY.json', 'latest.json'].sort();
  const sumNames = [...assetNames, 'stage-receipt.json'].sort();
  assert.deepEqual((await fs.readdir(f.stage)).sort(), [...sumNames, 'SHA256SUMS'].sort());
  const files = [];
  for (const name of sumNames) {
    const bytes = await fs.readFile(stageFile(name));
    files.push({ name, size: bytes.length, sha256: digest(bytes) });
  }
  assert.deepEqual(report.files, files.filter(file => file.name !== 'stage-receipt.json'));
  assert.equal(await fs.readFile(stageFile('SHA256SUMS'), 'utf8'), files.map(file => `${file.sha256}  ${file.name}\n`).join(''));
  await assert.rejects(fs.lstat(`${f.stage}.assemble-lock`), { code: 'ENOENT' });
});

for (const [label, mutate, error] of [
  ['wrong schema', lane => { lane.doc.schema = 2; }, /receipt schema/],
  ['wrong version', lane => { lane.doc.version = '9.9.9'; }, /Receipt version mismatch/],
  ['wrong commit', lane => { lane.doc.commit = 'a'.repeat(40); }, /Receipt commit mismatch/],
  ['wrong platform', lane => { lane.doc.platform = 'linux-x86_64'; }, /platform\/target mismatch/],
  ['unknown target', lane => { lane.doc.target = 'x86_64-apple-darwin'; }, /mismatched receipt target/],
  ['outside path', lane => { lane.doc.files[1].name = `../${lane.doc.files[1].name}`; }, /Unsafe, unknown or duplicate receipt filename/],
  ['duplicate file', lane => { lane.doc.files[1] = lane.doc.files[0]; }, /Unsafe, unknown or duplicate receipt filename/],
  ['missing pair in receipt', lane => { lane.doc.files.pop(); }, /Missing or extra receipt payloads/],
  ['wrong role', lane => { lane.doc.files[1].role = 'installer'; }, /Invalid receipt metadata/],
  ['wrong bundle', lane => { lane.doc.files[1].bundle = 'dmg'; }, /Invalid receipt metadata/],
  ['wrong size', lane => { lane.doc.files[1].size++; }, /Receipt size mismatch/],
]) {
  test(`assemble rejects ${label}`, async t => {
    const f = await fixture(t, { signed: ['wrong version', 'wrong commit'].includes(label) });
    mutate(f.imports[0]);
    await f.imports[0].save();
    await f.refuse(error);
  });
}

test('assemble rejects an invalid expected commit and an otherwise valid lane from another commit', async t => {
  const f = await fixture(t, { lanes: plans });
  await f.refuse(/requires --commit/, { expected: 'deadbee' });
  f.imports[2].doc.commit = 'e'.repeat(40);
  await f.imports[2].save();
  await f.refuse(/Receipt commit mismatch/);
});

test('assemble rejects duplicate platform keys', async t => {
  const f = await fixture(t);
  const duplicate = path.join(f.root, 'duplicate');
  await fs.cp(f.imports[0].dir, duplicate, { recursive: true });
  await f.refuse(/Duplicate updater platform key/, { laneDirs: [f.imports[0].dir, duplicate] });
});

test('assemble rejects modified payload bytes of the same size', async t => {
  const f = await fixture(t, { signed: true });
  const file = f.imports[0].updater;
  const bytes = await fs.readFile(file);
  bytes[0] ^= 1;
  await fs.writeFile(file, bytes);
  await f.refuse(/Receipt SHA-256 or size mismatch/);
});

test('assemble rejects missing and unknown lane files, including imported signatures', async t => {
  const f = await fixture(t);
  const { updater } = f.imports[0];
  await fs.writeFile(`${updater}.sig`, 'Unexpected');
  await f.refuse(/Unexpected or missing files/);
  await fs.unlink(`${updater}.sig`);
  await fs.rename(updater, `${updater}.renamed`);
  await f.refuse(/Unexpected or missing files/);
  await fs.unlink(`${updater}.renamed`);
  await f.refuse(/Unexpected or missing files/);
});

test('assemble rejects a symlinked lane or a linked ancestor', async t => {
  const f = await fixture(t);
  for (const [name, target, child] of [['linked-lane', f.imports[0].dir, ''], ['linked-parent', f.root, path.basename(f.imports[0].dir)]]) {
    const link = path.join(f.root, name);
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await f.refuse(/real directory \(no symlinks\)/, { laneDirs: [path.join(link, child)] });
  }
});

test('assemble rejects linked receipts or payload files even when the linked bytes match', async t => {
  const f = await fixture(t);
  for (const file of [f.imports[0].receipt, f.imports[0].updater]) {
    const backing = path.join(f.root, path.basename(file));
    await fs.rename(file, backing);
    try { await fs.symlink(backing, file, 'file'); }
    catch (error) { if (error.code === 'EPERM' && process.platform === 'win32') return t.skip('File symlink privilege unavailable'); throw error; }
    await f.refuse(/regular file \(no symlinks\)/);
    await fs.unlink(file);
    await fs.rename(backing, file);
  }
});

test('assemble refuses to overwrite an existing stage, even if empty', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.stage);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stage already exists/);
  assert.deepEqual(await fs.readdir(f.stage), []);
});

test('assemble rejects an updater one byte over the cache limit', async t => {
  const f = await fixture(t);
  const lane = f.imports[0];
  lane.doc.files[1].size = 512 * 1024 * 1024 + 1;
  await lane.save();
  await fs.truncate(lane.updater, lane.doc.files[1].size);
  await f.refuse(/File exceeds 536870912 byte limit/);
});

test('assemble rejects a missing Windows signature', async t => {
  const f = await fixture(t, { signed: true });
  await fs.unlink(`${f.windows}.sig`);
  await f.refuse(/regular file .*\.exe\.sig/);
});

test('assemble refuses a renamed Windows installer with valid signed bytes', async t => {
  const f = await fixture(t, { signed: true });
  const renamed = path.join(f.winDir, `Different_${version}_x64-setup.exe`);
  await fs.rename(f.windows, renamed);
  await fs.rename(`${f.windows}.sig`, `${renamed}.sig`);
  await f.refuse(/Expected a versioned Windows NSIS installer filename/, { exe: renamed });
});

test('assemble refuses a Windows signature bound to the wrong version', async t => {
  const f = await fixture(t, { signed: true, signVersion: '9.9.9' });
  await f.refuse(/signature must bind the exact release version/);
});

test('production assemble rejects test-key output even if its marker is stripped', async t => {
  const f = await fixture(t, { signed: true });
  await f.refuse(/Cannot import Windows test-key output/, { testKey: false });
  await fs.unlink(path.join(f.winDir, 'TEST-KEY.json'));
  await f.refuse(/Minisign key ID mismatch/, { testKey: false });
});

test('assemble requires every platform unless the missing keys are explicitly omitted and recorded', async t => {
  const f = await fixture(t, { signed: true });
  await f.refuse(/Missing required updater platform.*linux-x86_64-appimage.*linux-aarch64-appimage/, { omit: [] });
  await f.refuse(/Unknown or duplicate --omit/, { omit: ['linux-x86_64'] });
  await f.refuse(/Cannot import omitted platform: darwin-aarch64/, { omit: ['darwin-aarch64'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = await readJson(path.join(f.stage, 'stage-receipt.json'));
  assert.deepEqual(receipt.omitted, ['linux-aarch64-appimage', 'linux-x86_64-appimage']);
  assert.deepEqual(receipt.platformKeys, ['darwin-aarch64', 'windows-x86_64']);
});

test('a valid signed Windows installer must have a receipt bound to its commit and bytes', async t => {
  const f = await fixture(t, { signed: true });
  await fs.unlink(f.winReceipt);
  await f.refuse(/Expected one desktop receipt/);
  f.winDoc.commit = 'a'.repeat(40);
  await f.saveWindows();
  await f.refuse(/Receipt commit mismatch/);
  f.winDoc.commit = commit;
  f.winDoc.files[0].sha256 = 'a'.repeat(64);
  await f.saveWindows();
  await f.refuse(/Receipt SHA-256 or size mismatch/);
});
