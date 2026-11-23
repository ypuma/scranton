// Build: npm run app:release -- [--test-key] --notes-file <file>
// Assemble on the local Windows signing host (one --lane per extracted CI directory):
// npm run app:release -- --assemble --commit <40 hex> --windows <staged NSIS exe>
//   --lane <dir> [--lane <dir> ...] --stage <new directory> --notes-file <file>
// All four updater platforms are required unless explicitly excluded with --omit <platform-key>.
// --provenance <json file> records Actions metadata keyed by included POSIX updater platform.
// Test assembly: --test-key without --windows builds NSIS with the same throwaway key.
// With --windows, test assembly verifies the existing test build's public-key marker
// and uses another throwaway key for POSIX. Both modes mark output as not for release.
// The stage parent must exist. No mode publishes or fetches release artifacts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { artifactPlan, cleanBuildCommit, writeDesktopReceipt } from './desktop-artifact-receipt.mjs';
import { validateMinisignPublicKey, verifyMinisignFile } from './minisign-verify.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const outputRoot = path.join(root, '.scratch', 'updater-release');
const downloadRoot = 'https://github.com/ypuma/scranton/releases/download';
const versions = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
const windows = { target: 'x86_64-pc-windows-msvc', platform: 'windows-x86_64', bundle: 'nsis', suffix: '_x64-setup.exe' };
const posixTargets = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'];
const updaterPlatform = platform => platform.startsWith('linux-') ? `${platform}-appimage` : platform;
const platformSet = new Set([windows.platform, ...posixTargets.map(target => updaterPlatform(artifactPlan(target, '0.0.0').platform))]);
const maxUpdaterBytes = 512 * 1024 * 1024; // src-tauri/src/updater.rs: MAX_CACHED_BYTES
const testMarker = 'TEST-KEY.json';

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
  if (new Set(artifacts.map(({ platform }) => platform)).size !== artifacts.length) throw new Error('Duplicate updater platform key.');
  const platforms = Object.fromEntries(artifacts.map(({ platform, filename, signature }) => [platform, {
    url: `${downloadRoot}/v${encodeURIComponent(version)}/${encodeURIComponent(filename)}`,
    signature,
  }]));
  return { version, notes, pub_date: date.toISOString(), platforms };
}

export function withoutSigningEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^TAURI_(?:SIGNING_)?PRIVATE_KEY/i.test(name)));
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
  const packagePath = require.resolve('@tauri-apps/cli/package.json');
  const lock = require(path.join(root, 'package-lock.json'));
  if (require(packagePath).version !== lock.packages['node_modules/@tauri-apps/cli'].version) {
    throw new Error('Installed Tauri CLI does not match package-lock.json; run npm ci.');
  }
  return path.join(path.dirname(packagePath), 'tauri.js');
}

export async function generateTestKeypair(tauriCli, directory, env) {
  // Capture Tauri's stdout privately rather than writing a plaintext key file.
  const result = spawnSync(process.execPath, [tauriCli, 'signer', 'generate', '--ci'], {
    cwd: directory, env: withoutSigningEnv(env), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  try {
    const match = result.stdout?.toString('utf8').match(/^Private: \(Keep it secret!\)\r?\n([A-Za-z0-9+/=]+)\r?\n\r?\nPublic:\r?\n([A-Za-z0-9+/=]+)\r?$/m);
    if (result.status !== 0 || !match) throw new Error('Tauri test key generation failed.');
    const [, privateKey, publicKey] = match;
    validateMinisignPublicKey(publicKey);
    return { privateKey, publicKey };
  } finally {
    result.stdout?.fill(0);
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

async function installerStamps(directory, version, host) {
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const pairs = new Map();
  for (const filename of names.filter(name => name.endsWith(`_${version}${host.suffix}`))) {
    const installer = path.join(directory, filename);
    pairs.set(filename, await fileStamp(installer));
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

async function collectArtifact({ directory, version, host, before, stage, publicKey, privateKey, cli, env }) {
  const stamps = await installerStamps(directory, version, host);
  const fresh = [...stamps].filter(([name, stamp]) => stamp && stamp !== before.get(name));
  if (fresh.length !== 1) throw new Error(`Expected one fresh ${host.platform} installer in ${directory}; found ${fresh.length}.`);
  const [[filename]] = fresh;
  const file = path.join(stage, filename);
  await copyPayload(path.join(directory, filename), file, 'updater');
  await signArtifact(file, version, cli, privateKey, env);
  return verifiedArtifact(file, host.platform, publicKey, version);
}

async function fingerprint(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

async function buildWindows({ version, commit, committedKey, notes, test, cli, env: cleanEnv, testKeys }) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The NSIS release build requires native Windows x64.');
  const host = windows;
  const buildCommit = cleanBuildCommit(root, commit);
  const env = { ...cleanEnv };
  // Pin Cargo's output directory so discovery and Tauri agree even with a caller's CARGO_TARGET_DIR.
  const target = path.join(tauri, 'target');
  for (const name of Object.keys(env)) if (/^CARGO_(?:TARGET_DIR|BUILD_TARGET)$/i.test(name)) delete env[name];
  env.CARGO_TARGET_DIR = target;
  const directory = path.join(target, 'release', 'bundle', host.bundle);
  await fs.mkdir(outputRoot, { recursive: true });
  const work = await fs.mkdtemp(path.join(outputRoot, `v${version}-`));
  const stage = path.join(work, 'artifacts');
  try {
    const before = await installerStamps(directory, version, host);
    await run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run app:prepare'], env, 'app:prepare');
    const keys = test ? testKeys ?? await generateTestKeypair(cli, work, env) : null;
    const publicKey = keys?.publicKey ?? committedKey;
    const override = path.join(work, 'build.json');
    await writeJson(override, {
      // Preparation already ran without the signing key in its environment.
      build: { beforeBuildCommand: null },
      bundle: { createUpdaterArtifacts: false },
      ...(test && { plugins: { updater: { pubkey: publicKey } } }),
    });
    // Tauri v2 signs the ordinary NSIS bundle as-is. Detach signing so Cargo and build hooks never inherit the key.
    await run(process.execPath, [cli, 'build', '--ci', '--bundles', host.bundle, '--config', override], env, 'Tauri NSIS build');

    cleanBuildCommit(root, buildCommit);
    await fs.mkdir(stage);
    const artifact = await collectArtifact({ directory, version, host, before, stage, publicKey, cli, env,
      privateKey: keys?.privateKey ?? loadReleaseKey(env) });
    if (test) await writeJson(path.join(stage, testMarker), { publishable: false, publicKey });
    const manifest = latestManifest({ version, notes, artifacts: [artifact] });
    await fs.writeFile(path.join(stage, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const outputMode = path.join(outputRoot, test ? 'test' : 'production');
    const output = path.join(outputMode, path.basename(work));
    await writeDesktopReceipt({ output: stage, commit: buildCommit, version, target: host.target });
    const receipts = await Promise.all([artifact.filename, `${artifact.filename}.sig`, 'latest.json', `desktop-receipt-${host.target}.json`]
      .map(async name => {
        const { size, sha256 } = await fingerprint(path.join(stage, name));
        return `${path.join(output, name)}\t${size}\t${sha256}`;
      }));
    await fs.mkdir(outputMode, { recursive: true });
    await fs.rename(stage, output);
    for (const line of receipts) console.log(line);
    return path.join(output, artifact.filename);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const statIfPresent = (file) => fs.lstat(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});

async function directoryWithoutLinks(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (!(await fs.lstat(current)).isDirectory()) throw new Error(`Expected a real directory (no symlinks): ${current}`);
    if (current === path.dirname(current)) break;
  }
}

async function regularFile(file, maxBytes = Infinity) {
  const stat = await statIfPresent(file);
  if (!stat?.isFile() || !stat.size) throw new Error(`Expected a nonempty regular file (no symlinks): ${file}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${file}`);
  return stat;
}

async function copyPayload(source, destination, role, expected) {
  const cap = role === 'updater' ? maxUpdaterBytes : Infinity;
  const stat = await regularFile(source, cap);
  if (expected && stat.size !== expected.size) throw new Error(`Receipt size mismatch for ${expected.name}.`);
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  await regularFile(destination, cap);
  if (expected) {
    const { size, sha256 } = await fingerprint(destination);
    if (size !== expected.size || sha256 !== expected.sha256) throw new Error(`Receipt SHA-256 or size mismatch for ${expected.name}.`);
  }
}

async function signArtifact(file, version, cli, privateKey, env) {
  await run(process.execPath, [cli, 'signer', 'sign', '--app-version', version, file], {
    ...withoutSigningEnv(env), TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  }, 'Tauri detached signing');
}

async function verifiedArtifact(file, platform, publicKey, version) {
  await regularFile(`${file}.sig`, 16 * 1024);
  const signature = await fs.readFile(`${file}.sig`, 'utf8');
  await verifyReleaseArtifact(file, signature, publicKey, version);
  return { platform, filename: path.basename(file), signature };
}

const exactFields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const commitPattern = /^[0-9a-f]{40}$/i;

async function readLane(directory, version, commit, allowedTargets = posixTargets, companions = []) {
  await directoryWithoutLinks(directory);
  const names = await fs.readdir(directory);
  const receipts = names.filter(name => name.startsWith('desktop-receipt-') && name.endsWith('.json'));
  if (receipts.length !== 1) throw new Error(`Expected one desktop receipt in ${directory}.`);
  const receiptFile = path.join(directory, receipts[0]);
  await regularFile(receiptFile, 64 * 1024);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  if (!exactFields(receipt, ['schema', 'commit', 'version', 'target', 'platform', 'files']) || receipt.schema !== 1) {
    throw new Error(`Invalid desktop receipt schema in ${directory}.`);
  }
  if (receipt.version !== version) throw new Error(`Receipt version mismatch in ${directory}.`);
  if (typeof receipt.commit !== 'string' || receipt.commit.toLowerCase() !== commit) throw new Error(`Receipt commit mismatch in ${directory}.`);
  if (!allowedTargets.includes(receipt.target) || receipts[0] !== `desktop-receipt-${receipt.target}.json`) {
    throw new Error(`Unknown or mismatched receipt target in ${directory}.`);
  }
  const plan = artifactPlan(receipt.target, version);
  if (receipt.platform !== plan.platform) throw new Error(`Receipt platform/target mismatch in ${directory}.`);
  if (!Array.isArray(receipt.files) || receipt.files.length !== plan.files.length) throw new Error(`Missing or extra receipt payloads in ${directory}.`);
  const remaining = new Map(plan.files.map(spec => [spec.name, spec]));
  for (const file of receipt.files) {
    if (!exactFields(file, ['name', 'bundle', 'role', 'size', 'sha256'])) throw new Error(`Invalid receipt file schema in ${directory}.`);
    // Only the exact packager-generated basenames can be used as paths.
    const spec = remaining.get(file.name);
    if (!spec) throw new Error(`Unsafe, unknown or duplicate receipt filename in ${directory}.`);
    remaining.delete(file.name);
    if (file.bundle !== spec.bundle || file.role !== spec.role || !Number.isSafeInteger(file.size) || file.size <= 0 ||
      typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid receipt metadata for ${file.name}.`);
    }
  }
  const expectedNames = new Set([receipts[0], ...receipt.files.map(file => file.name)]);
  if ([...expectedNames].some(name => !names.includes(name)) || names.some(name => !expectedNames.has(name) && !companions.includes(name))) {
    throw new Error(`Unexpected or missing files in ${directory}.`);
  }
  return { directory, target: receipt.target, platform: updaterPlatform(plan.platform), files: receipt.files };
}

async function importWindows(file, stage, options) {
  const directory = path.dirname(file);
  await directoryWithoutLinks(directory);
  const name = path.basename(file);
  if (name !== artifactPlan(windows.target, options.version).files[0].name) {
    throw new Error('Expected a versioned Windows NSIS installer filename.');
  }
  const marker = path.join(directory, testMarker);
  let publicKey = options.committedKey;
  if (options.test) {
    await regularFile(marker, 16 * 1024);
    const test = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (test.publishable !== false || typeof test.publicKey !== 'string' || test.publicKey === publicKey) throw new Error('Invalid Windows test-key marker.');
    publicKey = test.publicKey;
  } else if (await statIfPresent(marker)) {
    throw new Error('Cannot import Windows test-key output for a production release.');
  }
  const lane = await readLane(directory, options.version, options.commit, [windows.target], [`${name}.sig`, 'latest.json', testMarker]);
  const destination = path.join(stage, name);
  await regularFile(`${file}.sig`, 16 * 1024);
  await copyPayload(file, destination, 'updater', lane.files[0]);
  await fs.copyFile(`${file}.sig`, `${destination}.sig`, constants.COPYFILE_EXCL);
  return { artifact: await verifiedArtifact(destination, windows.platform, publicKey, options.version), publicKey };
}

async function assertFreshStage(output) {
  if (await statIfPresent(output)) throw new Error(`Stage already exists: ${output}`);
}

async function readProvenance(file, lanes, commit) {
  if (!file) return undefined;
  await regularFile(file, 64 * 1024);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!exactFields(doc, lanes.map(lane => lane.platform))) throw new Error('Provenance must identify each included Actions lane and no others.');
  for (const { platform, target } of lanes) {
    const entry = doc[platform];
    if (entry?.head_sha !== commit) throw new Error(`Provenance head_sha mismatch for ${platform}.`);
    const positiveId = value => Number.isSafeInteger(value) && value > 0;
    if (!exactFields(entry, ['run_id', 'head_sha', 'workflow_path', 'event', 'conclusion', 'artifact']) ||
        !positiveId(entry.run_id) || entry.workflow_path !== '.github/workflows/desktop-native.yml' ||
        entry.event !== 'workflow_dispatch' || entry.conclusion !== 'success' ||
        !exactFields(entry.artifact, ['name', 'id', 'digest']) || entry.artifact.name !== `scranton-${target}` ||
        !positiveId(entry.artifact.id) || typeof entry.artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.artifact.digest)) {
      throw new Error(`Invalid Actions provenance for ${platform}.`);
    }
  }
  return doc;
}

async function assemble(options) {
  const { version, commit, notes, committedKey, test, cli, env, output } = options;
  await directoryWithoutLinks(path.dirname(output));
  await assertFreshStage(output);
  const lanes = [];
  const omitted = new Set(options.omitted);
  if (omitted.size !== options.omitted.length || [...omitted].some(key => !platformSet.has(key))) throw new Error('Unknown or duplicate --omit platform key.');
  const platformKeys = new Set(omitted.has(windows.platform) ? [] : [windows.platform]);
  for (const directory of options.lanes) {
    const lane = await readLane(directory, version, commit);
    if (platformKeys.has(lane.platform)) throw new Error(`Duplicate updater platform key: ${lane.platform}`);
    platformKeys.add(lane.platform);
    lanes.push(lane);
  }

  for (const key of omitted) if (platformKeys.has(key)) throw new Error(`Cannot import omitted platform: ${key}`);
  const missing = [...platformSet].filter(key => !platformKeys.has(key) && !omitted.has(key));
  if (missing.length) throw new Error(`Missing required updater platform(s): ${missing.join(', ')}. Use --omit to exclude deliberately.`);
  if (!platformKeys.size) throw new Error('Assembly requires at least one platform.');
  const provenance = await readProvenance(options.provenance, lanes, commit);

  // A fixed sibling lock excludes concurrent assembler invocations; the final rename only exposes complete stages.
  const lock = `${output}.assemble-lock`;
  await fs.mkdir(lock);
  try {
    await assertFreshStage(output);
    const stage = path.join(lock, 'artifacts');
    await fs.mkdir(stage);
    for (const lane of lanes) {
      for (const file of lane.files) await copyPayload(path.join(lane.directory, file.name), path.join(stage, file.name), file.role, file);
    }
    const testKeys = test ? await generateTestKeypair(cli, lock, env) : null;
    const artifacts = [];
    let imported;
    if (platformKeys.has(windows.platform)) {
      const windowsFile = options.windowsFile ?? await buildWindows({ ...options, testKeys });
      imported = await importWindows(windowsFile, stage, options);
      artifacts.push(imported.artifact);
    }
    if (!test && process.platform !== 'win32') throw new Error('Production assembly requires the local Windows DPAPI key store.');
    const publicKey = testKeys?.publicKey ?? committedKey;
    const privateKey = lanes.length ? testKeys?.privateKey ?? loadReleaseKey(env) : undefined;
    for (const lane of lanes) {
      const file = path.join(stage, lane.files.find(file => file.role === 'updater').name);
      await signArtifact(file, version, cli, privateKey, env);
      artifacts.push(await verifiedArtifact(file, lane.platform, publicKey, version));
    }
    await writeJson(path.join(stage, 'latest.json'), latestManifest({ version, notes, artifacts }));
    if (test) await writeJson(path.join(stage, testMarker), { publishable: false, publicKey: imported?.publicKey ?? publicKey, posixPublicKey: publicKey });
    const files = [];
    for (const name of (await fs.readdir(stage)).sort()) files.push({ name, ...await fingerprint(path.join(stage, name)) });
    await writeJson(path.join(stage, 'stage-receipt.json'), { schema: 1, version, commit, publishable: !test, platformKeys: [...platformKeys].sort(), omitted: [...omitted].sort(), ...(provenance && { provenance }), files });
    // The receipt lists the assets it describes. SHA256SUMS additionally covers the receipt itself.
    files.push({ name: 'stage-receipt.json', ...await fingerprint(path.join(stage, 'stage-receipt.json')) });
    files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    await fs.writeFile(path.join(stage, 'SHA256SUMS'), files.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''), { flag: 'wx' });
    await assertFreshStage(output);
    await fs.rename(stage, output);
    console.log(`${test ? 'TEST KEY - DO NOT PUBLISH: ' : 'Assembled: '}${output}`);
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function release() {
  const { values } = parseArgs({ options: {
    'test-key': { type: 'boolean', default: false }, 'notes-file': { type: 'string' },
    assemble: { type: 'boolean' }, commit: { type: 'string' }, windows: { type: 'string' },
    lane: { type: 'string', multiple: true }, stage: { type: 'string' },
    omit: { type: 'string', multiple: true }, provenance: { type: 'string' },
  } });
  if (!values['notes-file']) throw new Error('--notes-file is required. See scripts/release-updater.mjs for usage.');
  if (values.assemble) {
    if (!values.commit || !commitPattern.test(values.commit) || !values.stage) throw new Error('--assemble requires --commit <40 hex> and --stage <new dir>.');
    if (values.omit?.includes(windows.platform)) {
      if (values.windows) throw new Error('Cannot pass --windows and omit windows-x86_64.');
    } else if (!values.windows && !values['test-key']) {
      throw new Error('--windows <exe> is required unless Windows is omitted or --test-key is set.');
    }
  } else if (['commit', 'lane', 'stage', 'windows', 'omit', 'provenance'].some(option => Object.hasOwn(values, option))) {
    throw new Error('--commit, --lane, --stage, --windows, --omit and --provenance require --assemble.');
  }
  const { version, publicKey: committedKey } = await readReleaseConfig();
  validateMinisignPublicKey(committedKey);
  const options = { version, committedKey, notes: await fs.readFile(values['notes-file'], 'utf8'),
    env: withoutSigningEnv(), cli: tauriCliPath(), test: values['test-key'] };
  if (!values.assemble) return buildWindows(options);
  return assemble({ ...options, commit: values.commit.toLowerCase(), lanes: (values.lane ?? []).map(dir => path.resolve(dir)),
    omitted: values.omit ?? [], provenance: values.provenance ? path.resolve(values.provenance) : undefined,
    output: path.resolve(values.stage), windowsFile: values.windows ? path.resolve(values.windows) : undefined });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await release(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
