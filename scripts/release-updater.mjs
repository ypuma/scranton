import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateMinisignPublicKey, verifyMinisignFile } from './minisign-verify.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const outputRoot = path.join(root, '.scratch', 'updater-release');
const downloadRoot = 'https://github.com/ypuma/scranton/releases/download';
const versions = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
const hosts = {
  'win32-x64': { platform: 'windows-x86_64', bundle: 'nsis', suffix: '_x64-setup.exe' },
};

export async function readReleaseConfig(directory = root) {
  const [pkg, config, cargo] = await Promise.all([
    fs.readFile(path.join(directory, 'package.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(directory, 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(directory, 'src-tauri', 'Cargo.toml'), 'utf8'),
  ]);
  // Only the direct [package] version counts, never a dependency's version.
  const sections = cargo.split(/^[\t ]*(?=\[)/m);
  const pkgSection = sections.find(section => /^\[package\][\t ]*(?:#.*)?\r?\n/.test(section));
  const cargoVersion = pkgSection?.match(/^[\t ]*version[\t ]*=[\t ]*(["'])([^"'\r\n]+)\1[\t ]*(?:#.*)?\r?$/m)?.[2];
  if (typeof pkg.version !== 'string' || !versions.test(pkg.version) || pkg.version !== config.version || pkg.version !== cargoVersion) {
    throw new Error('Release version mismatch or invalid version: package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml must declare the same version.');
  }
  return { version: pkg.version, publicKey: config.plugins?.updater?.pubkey };
}

export function latestManifest({ version, notes, date = new Date(), artifacts }) {
  const platforms = Object.fromEntries(artifacts.map(({ platform, filename, signature }) => [platform, {
    url: `${downloadRoot}/v${encodeURIComponent(version)}/${encodeURIComponent(filename)}`,
    signature,
  }]));
  return { version, notes, pub_date: date.toISOString(), platforms };
}

export function withoutSigningEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^TAURI_SIGNING_PRIVATE_KEY(?:_.*)?$/i.test(name)));
}

function run(executable, args, env, label) {
  return new Promise((resolve, reject) => {
    // In particular, never relay output from tools that handle a private key.
    const child = spawn(executable, args, { cwd: root, env, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error(`Could not start ${label}.`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

export function tauriCliPath() {
  // Same pinned CLI as app:build; no shell interpolation or npx download.
  return path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
}

export async function generateTestKeypair(tauriCli, directory, env) {
  const keyPath = path.join(directory, 'throwaway.key');
  try {
    await run(process.execPath, [tauriCli, 'signer', 'generate', '--ci', '--write-keys', keyPath], env, 'Tauri test key generation');
    return {
      privateKey: (await fs.readFile(keyPath, 'utf8')).trim(),
      publicKey: (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim(),
    };
  } finally {
    await fs.rm(keyPath, { force: true });
    await fs.rm(`${keyPath}.pub`, { force: true });
  }
}

function loadReleaseKey(env) {
  if (!env.USERPROFILE) throw new Error('USERPROFILE is required to locate the DPAPI updater key.');
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Security
    $keyPath = Join-Path $env:USERPROFILE '.scranton-release\\updater.key.dpapi'
    $encrypted = [IO.File]::ReadAllBytes($keyPath)
    $key = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
    [Console]::OpenStandardOutput().Write($key, 0, $key.Length)
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  try {
    const key = result.stdout?.toString('utf8').trim();
    if (result.status !== 0 || !key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
      throw new Error('Cannot read or decrypt the CurrentUser updater key at %USERPROFILE%\\.scranton-release\\updater.key.dpapi.');
    }
    return key;
  } finally {
    result.stdout?.fill(0);
  }
}

async function fileStamp(file) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    if (stat.isFile()) return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return undefined;
}

async function installerPairs(directory, version, host) {
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const pairs = new Map();
  for (const filename of names.filter(name => name.endsWith(`_${version}${host.suffix}`))) {
    const installer = path.join(directory, filename);
    pairs.set(filename, [await fileStamp(installer), await fileStamp(`${installer}.sig`)]);
  }
  return pairs;
}

export async function verifyReleaseArtifact(file, signature, publicKey, version) {
  const comment = await verifyMinisignFile(file, signature, publicKey);
  // Tauri reads tab-separated key:value fields in the authenticated comment.
  const fields = comment.split('\t');
  const signedVersions = fields.filter(field => field.startsWith('version:'));
  if (signedVersions.length !== 1 || signedVersions[0] !== `version:${version}`) {
    throw new Error('Installer signature must bind the exact release version.');
  }
  const signedFiles = fields.filter(field => field.startsWith('file:'));
  if (signedFiles.length !== 1 || signedFiles[0] !== `file:${path.basename(file)}`) {
    throw new Error('Installer signature must bind the exact installer filename.');
  }
}

async function collectArtifact({ directory, version, host, before, stage, publicKey }) {
  const pairs = await installerPairs(directory, version, host);
  const fresh = [...pairs].filter(([name, [installer, signature]]) => installer && signature &&
    installer !== before.get(name)?.[0] && signature !== before.get(name)?.[1]);
  if (fresh.length !== 1) throw new Error(`Expected one fresh signed ${host.platform} installer in ${directory}; found ${fresh.length}.`);
  const [[filename]] = fresh;
  for (const name of [filename, `${filename}.sig`]) await fs.copyFile(path.join(directory, name), path.join(stage, name));
  const signature = await fs.readFile(path.join(stage, `${filename}.sig`), 'utf8');
  await verifyReleaseArtifact(path.join(stage, filename), signature, publicKey, version);
  return { platform: host.platform, filename, signature };
}

async function fileReceipt(file, outputFile) {
  const hash = createHash('sha256');
  const { size } = await fs.stat(file);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `${outputFile}\t${size}\t${hash.digest('hex')}`;
}

async function release() {
  const { values } = parseArgs({ options: { 'test-key': { type: 'boolean' }, 'notes-file': { type: 'string' } } });
  if (!values['notes-file']) throw new Error('Usage: npm run app:release -- [--test-key] --notes-file <file>');
  const { version, publicKey: committedKey } = await readReleaseConfig();
  const notes = await fs.readFile(values['notes-file'], 'utf8');
  const host = hosts[`${process.platform}-${process.arch}`];
  if (!host) throw new Error('Updater releases currently require a native Windows x64 build.');
  const test = values['test-key'];
  if (!test) validateMinisignPublicKey(committedKey);
  const tauriCli = tauriCliPath();
  const env = withoutSigningEnv();
  // Pin Cargo's output directory so discovery and Tauri agree even with a caller's CARGO_TARGET_DIR.
  const target = path.join(tauri, 'target');
  for (const name of Object.keys(env)) if (/^CARGO_(?:TARGET_DIR|BUILD_TARGET)$/i.test(name)) delete env[name];
  env.CARGO_TARGET_DIR = target;
  const directory = path.join(target, 'release', 'bundle', host.bundle);
  await fs.mkdir(outputRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(outputRoot, `v${version}-`));
  const stage = path.join(work, 'artifacts');
  try {
    const before = await installerPairs(directory, version, host);
    await run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run app:prepare'], env, 'app:prepare');
    const { privateKey, publicKey } = test ? await generateTestKeypair(tauriCli, work, env) :
      { privateKey: loadReleaseKey(env), publicKey: committedKey };
    const override = path.join(work, 'build.json');
    await fs.writeFile(override, JSON.stringify({
      // Preparation already ran without the signing key in its environment.
      build: { beforeBuildCommand: null },
      bundle: { createUpdaterArtifacts: true },
      ...(test && { plugins: { updater: { pubkey: publicKey } } }),
    }));
    await run(process.execPath, [tauriCli, 'build', '--ci', '--bundles', host.bundle, '--config', override], {
      ...env, TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    }, 'Tauri signed build');

    await fs.mkdir(stage);
    const artifact = await collectArtifact({ directory, version, host, before, stage, publicKey });
    const manifest = latestManifest({ version, notes, artifacts: [artifact] });
    await fs.writeFile(path.join(stage, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const outputMode = path.join(outputRoot, test ? 'test' : 'production');
    const output = path.join(outputMode, path.basename(work));
    const receipts = await Promise.all([artifact.filename, `${artifact.filename}.sig`, 'latest.json']
      .map(name => fileReceipt(path.join(stage, name), path.join(output, name))));
    await fs.mkdir(outputMode, { recursive: true });
    await fs.rename(stage, output);
    for (const line of receipts) console.log(line);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await release(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
