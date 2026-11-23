import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Names are from the locked Tauri CLI 2.12.4 bundler (NSIS, DMG, Debian, linuxdeploy).
// The app tarball is named here by Scranton, not emitted by a keyless Tauri build.
const lanes = new Map([
  ['x86_64-pc-windows-msvc', ['windows-x86_64', [['nsis', 'nsis', 'updater', 'x64-setup.exe']]]],
  ['aarch64-apple-darwin', ['darwin-aarch64', [
    ['dmg', 'dmg', 'installer', 'aarch64.dmg'], ['macos', 'app', 'updater', 'aarch64.app.tar.gz'],
  ]]],
  ['x86_64-unknown-linux-gnu', ['linux-x86_64', [
    ['deb', 'deb', 'installer', 'amd64.deb'], ['appimage', 'appimage', 'updater', 'amd64.AppImage'],
  ]]],
  ['aarch64-unknown-linux-gnu', ['linux-aarch64', [
    ['deb', 'deb', 'installer', 'arm64.deb'], ['appimage', 'appimage', 'updater', 'aarch64.AppImage'],
  ]]],
]);

export function artifactPlan(target, version) {
  const lane = lanes.get(target);
  if (!lane) throw Error(`Unsupported desktop receipt target: ${target}`);
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw Error(`Invalid desktop release version: ${version}`);
  }
  const [platform, specs] = lane;
  const files = specs.map(([dir, bundle, role, suffix]) => ({
    dir, bundle, role, name: `Scranton_${version}_${suffix}`, extension: suffix.slice(suffix.indexOf('.')),
  }));
  return { platform, files };
}

export function verifyBuildCommit(commit, head, githubSha) {
  if (![commit, head].every(value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)) ||
      commit !== head || (githubSha !== undefined && commit !== githubSha)) {
    throw Error('Desktop receipt commit must match git rev-parse HEAD and GITHUB_SHA (when set)');
  }
  return commit;
}

export async function readDesktopVersion(repo = root) {
  const [pkg, tauri] = await Promise.all(['package.json', 'src-tauri/tauri.conf.json'].map(async file =>
    JSON.parse(await readFile(path.join(repo, file), 'utf8'))));
  if (pkg.version !== tauri.version || tauri.productName !== 'Scranton') throw Error('Desktop version or product name mismatch');
  artifactPlan('aarch64-apple-darwin', pkg.version);
  return pkg.version;
}

async function fingerprint(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || !stat.size) throw Error(`Expected a nonempty regular artifact: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: stat.size, sha256: hash.digest('hex') };
}

export function cleanBuildCommit(repo = root, expected, githubSha) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const head = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none'])) {
    throw Error('Desktop receipt requires a clean tracked working tree and index');
  }
  return verifyBuildCommit(expected ?? head, head, githubSha);
}

export async function writeDesktopReceipt({ output, commit, version, target, repo = root, githubSha }) {
  const { platform, files } = artifactPlan(target, version);
  const receipt = { schema: 1, commit, version, target, platform, files: [] };
  for (const { name, bundle, role } of files) {
    receipt.files.push({ name, bundle, role, ...await fingerprint(path.join(output, name)) });
  }
  cleanBuildCommit(repo, commit, githubSha);
  await writeFile(path.join(output, `desktop-receipt-${target}.json`), `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
  return receipt;
}

export async function stageDesktopArtifacts({ bundleRoot, output, commit, head, githubSha, version, target, repo = root }) {
  verifyBuildCommit(commit, head, githubSha);
  const { files } = artifactPlan(target, version);
  const sources = [];
  for (const { dir, name, extension } of files) {
    const folder = path.join(bundleRoot, dir);
    const candidates = (await readdir(folder)).filter(entry => entry.toLowerCase().endsWith(extension.toLowerCase()));
    if (candidates.length !== 1 || candidates[0] !== name) {
      throw Error(`Expected exactly one ${name} in ${folder}; found ${candidates.join(', ') || '(none)'}`);
    }
    const file = path.join(folder, name);
    const stat = await lstat(file);
    if (!stat.isFile() || !stat.size) throw Error(`Expected a nonempty regular artifact: ${file}`);
    sources.push(file);
  }

  // Refuse to overlay a previous lane's output, even if it has the same version.
  await mkdir(output);
  try {
    for (const [index, { name }] of files.entries()) {
      await copyFile(sources[index], path.join(output, name), constants.COPYFILE_EXCL);
    }
    return await writeDesktopReceipt({ output, commit, version, target, repo, githubSha });
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [target, output, ...extra] = process.argv.slice(2);
    if (!target || !output || extra.length) throw Error('Usage: node scripts/desktop-artifact-receipt.mjs <target> <new-output-directory>');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const githubSha = process.env.GITHUB_SHA;
    if (process.env.GITHUB_ACTIONS === 'true' && !githubSha) throw Error('GITHUB_SHA is required in CI');
    const receipt = await stageDesktopArtifacts({
      bundleRoot: path.join(root, 'src-tauri/target/release/bundle'), output: path.resolve(output),
      target, version: await readDesktopVersion(), commit: githubSha ?? head, head, githubSha,
    });
    console.log(`Staged ${receipt.files.length} payload(s) and desktop-receipt-${target}.json for ${head}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
