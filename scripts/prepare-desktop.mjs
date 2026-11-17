import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { desktopPlatform, assertNativeBuild, launchManifest, validateNodeDistribution } from './desktop-platform.mjs';
import { bootstrap, runtimeFiles, validateRuntimeLock, runtimeCacheKey, runtimeFingerprint, runtimeCacheValid, lockedWheels } from './desktop-runtime.mjs';
import { extractionScript } from './desktop-extract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const app = path.join(tauri, 'staged', 'app');
const piPath = path.join('node_modules', '@earendil-works', 'pi-coding-agent');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

export async function fingerprint(directory) {
  const hash = createHash('sha256');
  let bytes = 0, files = 0;
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Package link not allowed: ${relative}`);
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), `${relative}/`);
      else if (entry.isFile()) {
        const content = await fs.readFile(path.join(dir, entry.name));
        hash.update(relative).update('\0').update(String(content.length)).update('\0').update(content);
        bytes += content.length; files++;
      } else throw new Error(`Unsupported package entry: ${relative}`);
    }
  }
  await visit(directory);
  return { sha256: hash.digest('hex'), bytes, files };
}

function run(exe, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, ...options });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} exited ${code}`)));
  });
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const pipelineForbidden = /^(?:node_modules|hive|sessions|\.git|\.pi|\.scratch|\.env(?:\..*)?|auth\.json|credentials\.json|.*\.(?:pem|key|p12|pfx|pyc|pyo)|__pycache__|\.(?:pytest|ruff|mypy)_cache|tests?|(?:_?pytest|ruff|mypy|pip|setuptools|wheel)(?:[-_.].*)?|bin|Scripts)$/i;

export async function prunePipeline(directory, packageRoot = directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Pipeline package link not allowed: ${file}`);
    // certifi's pinned public CA bundle is data, not a credential.
    if (path.relative(packageRoot, file).split(path.sep).join('/') === 'certifi/cacert.pem' && entry.isFile()) continue;
    if (pipelineForbidden.test(entry.name)) await fs.rm(file, { recursive: true, force: true });
    else if (entry.isDirectory()) await prunePipeline(file, packageRoot);
  }
}

export async function prunePython(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.name === 'bin' || entry.name === 'Scripts') {
      if (entry.isDirectory()) await prunePython(file);
    } else if (entry.name === 'site-packages' || pipelineForbidden.test(entry.name) || /^pip[0-9.]*$/.test(entry.name)) await fs.rm(file, { recursive: true, force: true });
    else if (entry.isDirectory()) await prunePython(file);
  }
}

async function preparePipeline(host) {
  const runtime = path.join(app, 'engine-runtime');
  if (process.env.SCRANTON_SKIP_PIPELINE === '1') {
    await fs.rm(runtime, { recursive: true, force: true });
    await fs.rm(path.join(tauri, 'staged', 'pipeline-cache.json'), { force: true });
    console.log('Pipeline explicitly skipped (SCRANTON_SKIP_PIPELINE=1).');
    return null;
  }
  try {
    const scratch = path.join(root, '.scratch', 'pipeline');
    const work = path.join(scratch, `desktop-${host.platform}-${host.arch}`);
    const cache = path.join(scratch, 'cache');
    const tmp = path.join(scratch, 'tmp');
    const pipCache = path.join(scratch, 'pip-cache');
    for (const dir of [work, cache, tmp, pipCache]) await fs.mkdir(dir, { recursive: true });
    const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
      PIP_CACHE_DIR: pipCache, PYTHONDONTWRITEBYTECODE: '1' };
    let python;
    for (const [exe, args] of [[path.join(scratch, 'venv', ...(host.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3'])), []], [host.platform === 'win32' ? 'python' : 'python3', []], ...(host.platform === 'win32' ? [['py', ['-3.14']]] : [])]) {
      const probe = spawnSync(exe, [...args, '-c', 'import sys, platform, sysconfig; assert sys.implementation.name == "cpython" and sys.version_info[:2] == (3,14); assert not sysconfig.get_config_var("Py_GIL_DISABLED"); assert sys.platform == "' + host.platform + '"; assert platform.machine().lower() in ' + JSON.stringify(host.arch === 'x64' ? ['amd64', 'x86_64'] : ['arm64', 'aarch64']) + '; print(sys.executable)'],
        { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (probe.status === 0) { python = probe.stdout.trim(); break; }
    }
    if (!python) throw new Error('Python 3.14 with pip is required (development venv, python or py -3.14).');
    const locks = runtimeFiles(host);
    const lockPath = path.join(root, 'engine', locks.requirements);
    const requirements = await fs.readFile(lockPath, 'utf8');
    const requirementsSha256 = sha256(requirements);
    const archiveLock = validateRuntimeLock(await json(path.join(root, 'engine', locks.archive)), host);
    const archive = path.join(cache, `${host.platform}-${host.arch}-${archiveLock.sha256}-${path.basename(new URL(archiveLock.url).pathname)}`);
    try { await fs.access(archive); }
    catch {
      const response = await fetch(archiveLock.url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`CPython download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== archiveLock.sha256) throw new Error('Downloaded CPython archive SHA-256 mismatch.');
      await fs.writeFile(archive, bytes);
    }
    if (!(await fs.lstat(archive)).isFile()) throw new Error('Runtime archive must be a regular file.');
    if (sha256(await fs.readFile(archive)) !== archiveLock.sha256) throw new Error('Cached CPython archive SHA-256 mismatch; remove the damaged archive.');
    const wheels = path.join(cache, `wheels-${host.platform}-${host.arch}-${requirementsSha256}`);
    const wheelHashes = new Set([...requirements.matchAll(/--hash=sha256:([a-f0-9]{64})/g)].map((m) => m[1]));
    if (!wheelHashes.size) throw new Error('Runtime requirements must pin wheel hashes.');
    const downloads = host.platform === 'win32' ? null : lockedWheels(archiveLock, wheelHashes);
    const pip = ['-m', 'pip', '--isolated', '--disable-pip-version-check', '--cache-dir', pipCache];
    try { await fs.access(wheels); }
    catch {
      const downloading = path.join(work, 'wheels-downloading');
      await fs.rm(downloading, { recursive: true, force: true });
      await fs.mkdir(downloading, { recursive: true });
      if (downloads) {
        for (const wheel of downloads) {
          const response = await fetch(wheel.url, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`Wheel download failed (${wheel.file}): HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (sha256(bytes) !== wheel.sha256) throw new Error(`Downloaded wheel SHA-256 mismatch: ${wheel.file}`);
          await fs.writeFile(path.join(downloading, wheel.file), bytes);
        }
      } else await run(python, [...pip, 'download', '--dest', downloading, '--only-binary=:all:', '--require-hashes', '-r', lockPath],
        { cwd: work, env, stdio: 'inherit' });
      await fs.rename(downloading, wheels);
    }
    const wheelFiles = await fs.readdir(wheels);
    const seen = new Set();
    for (const name of wheelFiles) {
      if (!(await fs.lstat(path.join(wheels, name))).isFile()) throw new Error(`Runtime wheel must be a regular file: ${name}`);
      const hash = sha256(await fs.readFile(path.join(wheels, name)));
      if (!name.endsWith('.whl') || !wheelHashes.has(hash) || seen.has(hash)) throw new Error(`Invalid cached runtime wheel: ${name}`);
      seen.add(hash);
    }
    if (seen.size !== wheelHashes.size) throw new Error('Incomplete wheel cache; remove it and prepare again.');
    const key = runtimeCacheKey(host, archiveLock, requirements, `${pipelineForbidden.source}\n${prunePipeline}\n${prunePython}\n${extractionScript}`);
    const receiptPath = path.join(tauri, 'staged', 'pipeline-cache.json');
    let receipt;
    try { receipt = await json(receiptPath); } catch {}
    const cached = await runtimeCacheValid(runtime, receipt, key, host);
    if (!cached) {
      await fs.rm(runtime, { recursive: true, force: true });
      await fs.mkdir(runtime, { recursive: true });
      await run(python, ['-I', '-B', '-c', extractionScript, archive, path.join(runtime, 'python'), host.platform === 'win32' ? 'zip' : 'tar.gz'],
        { cwd: work, env, stdio: 'inherit' });
      if (host.platform === 'win32') await fs.writeFile(path.join(runtime, 'python', 'python314._pth'), 'python314.zip\n.\n');
      await run(python, [...pip, 'install', '--target', path.join(runtime, 'site-packages'), '--no-index', '--find-links', wheels,
        '--only-binary=:all:', '--require-hashes', '--no-compile', '-r', lockPath], { cwd: work, env, stdio: 'inherit' });
      await prunePipeline(path.join(runtime, 'site-packages'));
      await prunePython(path.join(runtime, 'python'));
    }
    const source = path.join(runtime, 'site-packages', 'scranton_pipeline');
    await fs.rm(source, { recursive: true, force: true });
    await fs.cp(path.join(root, 'engine', 'src', 'scranton_pipeline'), source, { recursive: true, filter: async (file) => {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Pipeline source link not allowed: ${file}`);
      return !pipelineForbidden.test(path.basename(file));
    } });
    const launch = launchManifest(host);
    await fs.writeFile(path.join(runtime, 'bootstrap.py'), bootstrap);
    await fs.writeFile(path.join(runtime, 'launch.json'), JSON.stringify(launch, null, 2) + '\n');
    const profile = path.join(work, 'empty-profile');
    await fs.mkdir(profile, { recursive: true });
    const clean = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
    const stagedPython = path.join(runtime, launch.executable);
    const verify = (args) => {
      const result = spawnSync(stagedPython, ['-I', '-B', path.join(runtime, 'bootstrap.py'), ...args], {
        cwd: profile, env: clean, encoding: 'utf8', timeout: 30000, windowsHide: true
      });
      if (result.status !== 0) throw new Error(`Staged Pipeline ${args[0]} failed: ${result.stderr || result.stdout || result.error?.message}`);
      console.log(`Pipeline verification (${args.join(' ')}):\n${result.stdout.trim()}`);
      return result.stdout;
    };
    const version = JSON.parse(verify(['version']));
    if (version.python !== archiveLock.version) throw new Error('Staged Python version differs from runtime lock.');
    verify(['graph', '--format', 'mermaid']);
    const sqlite = spawnSync(stagedPython, ['-I', '-B', '-c', 'import sqlite3, sys, ssl; sys.path.insert(0, sys.argv[1]); import certifi; db=sqlite3.connect(":memory:"); assert db.execute("select 42").fetchone() == (42,); assert ssl.create_default_context(cafile=certifi.where()).cert_store_stats()["x509_ca"] > 0; print(sqlite3.sqlite_version)', path.join(runtime, 'site-packages')], {
      cwd: profile, env: clean, encoding: 'utf8', timeout: 30000, windowsHide: true
    });
    if (sqlite.status !== 0) throw new Error(`Bundled SQLite/CA smoke failed: ${sqlite.stderr || sqlite.error?.message}`);
    console.log(`Bundled SQLite: ${sqlite.stdout.trim()}`);
    await prunePipeline(path.join(runtime, 'site-packages'));
    const bundled = await runtimeFingerprint(runtime);
    await fs.writeFile(receiptPath, JSON.stringify({ key, sha256: bundled.sha256 }) + '\n');
    console.log(`Pipeline ${version.version}, Python ${version.python}: ${bundled.files} files, ${bundled.bytes} bytes; ${cached ? 'verified staged cache; installation skipped' : 'fresh wheel installation'}.`);
    return { platform: host.platform, arch: host.arch, target: host.target, launch, runtimeLock: locks.archive, requirementsLock: locks.requirements, engineVersion: version.version, pythonVersion: version.python, ...bundled, requirementsSha256 };
  } catch (error) {
    await fs.rm(runtime, { recursive: true, force: true });
    await fs.rm(path.join(tauri, 'staged', 'pipeline-cache.json'), { force: true });
    throw new Error(`Pipeline preparation failed: ${error.message} Set SCRANTON_SKIP_PIPELINE=1 only to deliberately omit the engine.`, { cause: error });
  }
}

export async function prepareDesktop() {
  await fs.rm(path.join(app, 'packaging-manifest.json'), { force: true });
  try {
  const host = assertNativeBuild(desktopPlatform());
  if (process.env.SCRANTON_DESKTOP_STUB) throw new Error('Desktop stub builds are not distributable; unset SCRANTON_DESKTOP_STUB.');
  const installed = await json(path.join(root, piPath, 'package.json'));
  const lock = await json(path.join(root, 'package-lock.json'));
  const entrypoint = typeof installed.bin === 'string' ? installed.bin : installed.bin?.pi;
  if (installed.name !== '@earendil-works/pi-coding-agent' || installed.version !== '1.5.2' ||
      lock.packages[piPath.replaceAll('\\', '/')]?.version !== installed.version || !entrypoint ||
      path.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes('..')) throw new Error('Installed Pi identity/entrypoint does not match the supported lockfile.');
  await fs.access(path.join(root, piPath, entrypoint));
  const inputs = ['bin', 'src', 'agents', 'visualizer/public', 'docs', 'sandbox/Dockerfile', 'sandbox/.dockerignore',
    'tools/fake-pi.js', 'tools/fake-pi-rpc.js', 'tools/pi-agent-chat.js', 'tools/pi-codex-compaction.js', 'tools/pipeline-pi-complete.js', 'tools/dreaming-pi-complete.js', 'scranton.config.json', 'package.json', 'package-lock.json'];
  for (const input of inputs) {
    try { await fs.access(path.join(root, input)); }
    catch { throw new Error(`Required desktop input is missing: ${input}`); }
  }
  await fs.mkdir(path.join(tauri, 'binaries'), { recursive: true });
  for (const file of await fs.readdir(path.join(tauri, 'binaries'))) {
    if (/^(?:scranton-)?node-(?:x86_64|aarch64)-(?:pc-windows-msvc\.exe|apple-darwin|unknown-linux-gnu)$/.test(file)) await fs.rm(path.join(tauri, 'binaries', file), { force: true });
  }
  const node = path.join(tauri, 'binaries', host.nodeFile);
  const nodeBytes = await fs.readFile(process.execPath);
  const nodeDistribution = { ...validateNodeDistribution(nodeBytes, host), sha256: sha256(nodeBytes) };
  await fs.writeFile(node, nodeBytes);
  if (host.platform !== 'win32') await fs.chmod(node, 0o755);
  // Recreate sources so removed files and previous development stubs cannot survive a build.
  await fs.mkdir(app, { recursive: true });
  for (const entry of await fs.readdir(app)) {
    if (entry !== 'node_modules' && entry !== 'engine-runtime') await fs.rm(path.join(app, entry), { recursive: true, force: true });
  }
  const forbidden = /^(?:node_modules|hive|sessions|\.git|\.pi|\.env(?:\..*)?|auth\.json|credentials\.json|.*\.(?:pem|key|p12|pfx))$/i;
  for (const input of inputs) {
    const target = path.join(app, input);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(root, input), target, { recursive: true, filter: async (source) => {
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`Source link not allowed: ${source}`);
      return !forbidden.test(path.basename(source));
    } });
  }
  // npm ci recreates node_modules: never distribute files left by a previous staged run.
  if (host.platform === 'win32') await run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'], { cwd: app, stdio: 'inherit' });
  else await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, stdio: 'inherit' });
  await fs.rm(path.join(tauri, 'staged', 'production-deps.sha256'), { force: true });
  const actual = await fingerprint(path.join(root, piPath));
  const bundled = await fingerprint(path.join(app, piPath));
  if (actual.sha256 !== bundled.sha256) throw new Error('Bundled Pi differs from the actual installed Pi package; reinstall from the lockfile before building.');
  const profile = path.join(root, '.scratch', 'packaging', 'empty-profile');
  await fs.mkdir(profile, { recursive: true });
  await run(node, [path.join(app, piPath, entrypoint), '--help'], {
    cwd: profile, stdio: ['ignore', 'ignore', 'inherit'],
    env: { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile }
  });
  const pipeline = await preparePipeline(host);
  await fs.writeFile(path.join(app, 'packaging-manifest.json'), JSON.stringify({
    platform: host.platform, arch: host.arch, target: host.target, pipeline,
    node: process.version, nodeDistribution, pi: { name: installed.name, version: installed.version, entrypoint, ...bundled },
    lockSha256: createHash('sha256').update(await fs.readFile(path.join(app, 'package-lock.json'))).digest('hex'),
    verification: 'Pi --help with bundled Node, empty PATH and isolated empty profile; no model request'
  }, null, 2) + '\n');
  console.log(`Desktop inputs prepared: ${app}\nPi ${installed.version}: ${entrypoint} (${bundled.files} files, ${bundled.bytes} bytes)\nBundled runtime: ${process.version}; empty-PATH Pi --help passed.`);
  } catch (error) {
    await fs.rm(path.join(app, 'engine-runtime', 'launch.json'), { force: true });
    await fs.rm(path.join(tauri, 'staged', 'pipeline-cache.json'), { force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareDesktop();
