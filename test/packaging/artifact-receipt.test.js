import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactPlan, readDesktopVersion, stageDesktopArtifacts, verifyBuildCommit, writeDesktopReceipt } from '../../scripts/desktop-artifact-receipt.mjs';

const version = '9.8.7';
const commit = 'abc123'.repeat(6) + 'abcd';
const target = 'aarch64-apple-darwin';
const parent = path.resolve('.scratch/desktop-lane-a1');

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  await fs.writeFile(path.join(root, 'source.txt'), 'committed source');
  git('add', 'source.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--no-gpg-sign', '-m', 'Fixture');
  const head = git('rev-parse', 'HEAD');
  const output = path.join(root, 'output'), bundleRoot = path.join(root, 'bundle');
  const { files } = artifactPlan(target, version);
  for (const file of files) {
    const folder = path.join(bundleRoot, file.dir);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, file.name), file.name);
  }
  return { root, repo: root, git, output, bundleRoot, commit: head, head, githubSha: head, target, version };
}

test('desktop payload plan uses the exact Tauri suffixes and release roles', () => {
  for (const [lane, platform, expected] of [
    ['x86_64-pc-windows-msvc', 'windows-x86_64', [['x64-setup.exe', 'nsis', 'updater']]],
    [target, 'darwin-aarch64', [['aarch64.dmg', 'dmg', 'installer'], ['aarch64.app.tar.gz', 'app', 'updater']]],
    ['x86_64-unknown-linux-gnu', 'linux-x86_64', [['amd64.deb', 'deb', 'installer'], ['amd64.AppImage', 'appimage', 'updater']]],
    ['aarch64-unknown-linux-gnu', 'linux-aarch64', [['arm64.deb', 'deb', 'installer'], ['aarch64.AppImage', 'appimage', 'updater']]],
  ]) {
    const actual = artifactPlan(lane, version);
    assert.equal(actual.platform, platform);
    assert.deepEqual(actual.files.map(({ name, bundle, role }) => [name, bundle, role]),
      expected.map(([suffix, bundle, role]) => [`Scranton_${version}_${suffix}`, bundle, role]));
  }
  assert.throws(() => artifactPlan('x86_64-apple-darwin', version), /Unsupported/);
  assert.throws(() => artifactPlan(target, '../bad'), /Invalid desktop release version/);
});

test('receipt contains exactly the expected keys and fingerprints the uploaded bytes', async t => {
  const f = await fixture(t);
  const documents = await stageDesktopArtifacts(f);
  const receiptName = `desktop-receipt-${target}.json`;
  assert.deepEqual((await fs.readdir(f.output)).sort(), [receiptName, `Scranton_${version}_aarch64.dmg`, `Scranton_${version}_aarch64.app.tar.gz`].sort());
  const info = artifactPlan(target, version);
  assert.deepEqual(documents, {
    schema: 1, commit: f.commit, version, target, platform: 'darwin-aarch64',
    files: info.files.map(({ name, bundle, role }) => ({ name, bundle, role, size: Buffer.byteLength(name), sha256: createHash('sha256').update(name).digest('hex') })),
  });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.output, receiptName), 'utf8')), documents);
  for (const { name } of documents.files) assert.equal(await fs.readFile(path.join(f.output, name), 'utf8'), name);
  await assert.rejects(stageDesktopArtifacts(f), { code: 'EEXIST' });
});

for (const state of ['missing', 'mis-versioned', 'duplicate', 'empty']) {
  test(`receipt refuses ${state} payloads`, async t => {
    const f = await fixture(t);
    const dir = path.join(f.bundleRoot, 'dmg');
    const good = path.join(dir, `Scranton_${version}_aarch64.dmg`), wrong = path.join(dir, 'Scranton_1.2.3_aarch64.dmg');
    if (state === 'missing') await fs.unlink(good);
    if (state === 'mis-versioned') await fs.rename(good, wrong);
    if (state === 'duplicate') await fs.copyFile(good, wrong);
    if (state === 'empty') await fs.truncate(good, 0);
    await assert.rejects(stageDesktopArtifacts(f), /Expected (?:exactly one|a nonempty regular artifact)/);
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
  });
}

test('receipt refuses a malformed or mismatched checkout or Actions commit', async t => {
  const f = await fixture(t);
  assert.equal(verifyBuildCommit(commit, commit, undefined), commit);
  for (const overrides of [{ head: 'b'.repeat(40) }, { githubSha: 'b'.repeat(40) }, { commit: 'abc123' }, { githubSha: '' }]) {
    await assert.rejects(stageDesktopArtifacts({ ...f, ...overrides }), /must match git rev-parse HEAD and GITHUB_SHA/);
  }
  await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
});

test('readDesktopVersion follows repository files and refuses a mismatch', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'src-tauri'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  const tauri = path.join(root, 'src-tauri/tauri.conf.json');
  await fs.writeFile(tauri, JSON.stringify({ version, productName: 'Scranton' }));
  assert.equal(await readDesktopVersion(root), version);
  await fs.writeFile(tauri, JSON.stringify({ version: '6.5.4', productName: 'Scranton' }));
  await assert.rejects(readDesktopVersion(root), /version or product name mismatch/);
});

test('Windows receipt allows untracked files but refuses unstaged and staged tracked edits', async t => {
  const f = await fixture(t);
  const output = path.join(f.root, 'windows');
  const target = 'x86_64-pc-windows-msvc';
  const [{ name }] = artifactPlan(target, version).files;
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, name), 'Built NSIS');
  const opts = { output, target, version, commit: f.commit, repo: f.repo };
  const receiptFile = path.join(output, `desktop-receipt-${target}.json`);
  await fs.writeFile(path.join(f.root, 'source.txt'), 'modified');
  await assert.rejects(writeDesktopReceipt(opts), /clean tracked working tree and index/);
  f.git('add', 'source.txt');
  await assert.rejects(writeDesktopReceipt(opts), /clean tracked working tree and index/);
  await assert.rejects(fs.access(receiptFile), { code: 'ENOENT' });
  f.git('restore', '--source=HEAD', '--staged', '--worktree', 'source.txt');
  await assert.rejects(writeDesktopReceipt({ ...opts, commit }), /must match git rev-parse HEAD/);
  const receipt = await writeDesktopReceipt(opts);
  assert.equal(receipt.commit, f.commit);
  assert.equal(receipt.files[0].sha256, createHash('sha256').update('Built NSIS').digest('hex'));
});
