import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { artifactPlan, readDesktopVersion } from './desktop-artifact-receipt.mjs';

export function readyUrl(line, pid) {
  const value = JSON.parse(line);
  if (value?.ready !== true || value.pid !== pid || typeof value.url !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/.test(value.url)) throw Error('Invalid app-server ready line');
  const url = new URL(value.url);
  if (!url.port || Number(url.port) === 0) throw Error('Ready line must specify a loopback port');
  return url.href;
}

export function validateAppArchiveListing(list) {
  const entries = list.trimEnd().split('\n');
  assert.ok(entries.includes('Scranton.app/') && entries.includes('Scranton.app/Contents/MacOS/scranton-desktop'), 'Missing app archive root or GUI');
  for (const entry of entries) {
    assert.ok(entry.startsWith('Scranton.app/') && !entry.split('/').some(part => part === '..' || part.startsWith('._')), `Unexpected app archive entry: ${entry}`);
  }
}

// Inspect magic bytes, not extensions or chmod bits: this also covers bundled .so/.dylib files.
export function nativeHeader(bytes) {
  if (bytes.length < 4) return null;
  const magic = bytes.readUInt32BE();
  const elfArch = cpu => ({ 62: 'x64', 183: 'arm64' })[cpu] ?? `cpu-${cpu}`;
  const macArch = cpu => ({ 0x01000007: 'x64', 0x0100000c: 'arm64' })[cpu] ?? `cpu-${cpu}`;
  if (magic === 0x7f454c46) {
    if (bytes.length < 64 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) return { format: 'elf', arches: [] };
    return { format: 'elf', arches: [elfArch(bytes.readUInt16LE(18))] };
  }
  if ([0xcffaedfe, 0xcefaedfe, 0xfeedface, 0xfeedfacf].includes(magic)) {
    return { format: 'mach-o', arches: magic === 0xcffaedfe && bytes.length >= 32 ? [macArch(bytes.readUInt32LE(4))] : [] };
  }
  if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
    const u32 = magic === 0xbebafeca || magic === 0xbfbafeca ? pos => bytes.readUInt32LE(pos) : pos => bytes.readUInt32BE(pos);
    const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
    const count = bytes.length >= 8 ? u32(4) : 0;
    // Java class files share CAFEBABE; their version fields aren't plausible slice counts.
    if (!count || count > 32 || bytes.length < 8 + stride * count) return null;
    return { format: 'mach-o', arches: Array.from({ length: count }, (_, i) => macArch(u32(8 + stride * i))) };
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 64) {
    const pe = bytes.readUInt32LE(60);
    if (pe + 6 <= bytes.length && bytes.readUInt32LE(pe) === 0x4550) return { format: 'pe', arches: [] };
  }
  return null;
}

function requireArchitecture(header, { format, arch }, file) {
  assert.ok(header?.format === format && header.arches.includes(arch),
    `${file}: expected ${format}/${arch}; found ${header ? `${header.format}/${header.arches.join(',') || 'unsupported'}` : 'no native binary'}`);
}

function inspect(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(4096);
    return nativeHeader(header.subarray(0, fs.readSync(fd, header)));
  } finally { fs.closeSync(fd); }
}

function scanNative(root, host) {
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    // Walk regular files once and do not follow symlinks out of the package.
    if (entry.isDirectory()) count += scanNative(file, host);
    else if (entry.isFile()) {
      const header = inspect(file);
      if (header) { requireArchitecture(header, host, file); count++; }
    }
  }
  return count;
}

function confinedFile(root, file, mode = fs.constants.R_OK) {
  const real = fs.realpathSync(file);
  const relative = path.relative(fs.realpathSync(root), real);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && fs.statSync(real).isFile(), `File missing or outside package: ${file}`);
  fs.accessSync(real, mode);
  return file;
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, ...options });
}

export function verifyDmg(artifact, mount, execute = run) {
  execute('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifact]);
  try {
    const app = path.join(mount, 'Scranton.app');
    assert.ok(fs.lstatSync(app).isDirectory(), 'DMG must contain Scranton.app');
    execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  } finally {
    execute('hdiutil', ['detach', mount]);
  }
}

function unpack(bundle, artifact, work, host) {
  if (bundle === 'app') {
    validateAppArchiveListing(run('tar', ['-tzf', artifact]));
    run('tar', ['-xzpf', artifact], { cwd: work });
    const root = path.join(work, 'Scranton.app');
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', root]);
    return { root, bin: path.join(root, 'Contents/MacOS'), app: path.join(root, 'Contents/Resources/app') };
  }
  let root = work;
  if (bundle === 'deb') {
    assert.equal(run('dpkg-deb', ['-f', artifact, 'Architecture']).trim(), host.arch === 'arm64' ? 'arm64' : 'amd64');
    run('dpkg-deb', ['-x', artifact, root]);
  } else if (bundle === 'appimage') {
    requireArchitecture(inspect(artifact), host, artifact);
    const runnable = path.join(work, path.basename(artifact));
    fs.copyFileSync(artifact, runnable);
    fs.chmodSync(runnable, 0o700);
    run(runnable, ['--appimage-extract'], { cwd: work });
    root = path.join(work, 'squashfs-root');
  } else throw Error(`Unsupported smoke bundle: ${bundle}`);
  return { root, bin: path.join(root, 'usr/bin'), app: path.join(root, 'usr/lib/Scranton/app') };
}

function isolatedEnv(work, gui) {
  const dirs = Object.fromEntries(['home', 'data', 'config', 'cache', 'runtime', 'tmp', 'credentials', 'pi'].map(name => [name, path.join(work, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { mode: 0o700 });
  const desktop = {};
  if (gui) for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key]) desktop[key] = process.env[key];
  }
  return { dirs, env: {
    ...desktop, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: dirs.home,
    XDG_DATA_HOME: dirs.data, XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.runtime,
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp, SCRANTON_CREDENTIALS_DIR: dirs.credentials, PI_CODING_AGENT_DIR: dirs.pi,
    SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy',
  } };
}

function launch(exe, args, options) {
  const child = spawn(exe, args, { detached: true, ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let ended = false;
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const done = new Promise(resolve => {
    child.on('error', error => { stderr += error.message; });
    child.on('close', (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  return { child, done, stderr: () => stderr, ended: () => ended };
}

async function stop(proc, message) {
  proc.child.stdin.end(message);
  const graceful = await Promise.race([proc.done, delay(2000, null, { ref: false })]);
  if (graceful) return graceful;
  try { process.kill(-proc.child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const stopped = await Promise.race([proc.done, delay(5000, null, { ref: false })]);
  if (!stopped) throw Error('Packaged process failed to stop');
  return stopped;
}

async function probeDashboard(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200, 'Dashboard must return HTTP 200');
  assert.match(await response.text(), /<title>Scranton\b/i, 'Expected the packaged Scranton dashboard');
}

async function runSidecar(app, node, helper, work, env, dirs) {
  const envFile = path.join(dirs.data, '.env');
  const proc = launch(node, [`--env-file-if-exists=${envFile}`, path.join(app, 'bin/scranton.js'),
    'app-server', '--data', dirs.data, '--legacy-workspace', path.join(dirs.home, 'legacy-workspace')], {
    cwd: app, env: { ...env, SCRANTON_SANDBOX_HELPER: helper, SCRANTON_ENV_FILE: envFile },
  });
  let line = '', timer, ready = false;
  try {
    const url = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('App server did not report ready within 20 seconds')), 20_000);
      void proc.done.then(({ code, signal }) => reject(Error(`App server exited before ready (${code ?? signal})`)));
      proc.child.stdout.on('data', chunk => {
        if (line === null) return;
        line += chunk;
        const newline = line.indexOf('\n');
        if (newline < 0 && line.length <= 65536) return;
        try {
          assert.ok(newline >= 0 && newline <= 65536, 'Oversized ready line');
          resolve(readyUrl(line.slice(0, newline), proc.child.pid));
        } catch (error) { reject(error); }
        line = null;
      });
    });
    await probeDashboard(url);
    ready = true;
  } catch (error) {
    throw Error(`${error.message}\n${proc.stderr()}`, { cause: error });
  } finally {
    clearTimeout(timer);
    const result = await stop(proc, 'quit\n');
    if (ready) assert.equal(result.code, 0, `Packaged server did not exit cleanly: ${proc.stderr()}`);
  }
}

function smokePipeline({ app, root }, host, work, env) {
  const runtime = path.join(app, 'engine-runtime');
  const manifest = JSON.parse(fs.readFileSync(confinedFile(root, path.join(runtime, 'launch.json')), 'utf8'));
  assert.deepEqual(manifest, { schema: 1, platform: process.platform, arch: host.arch, executable: 'python/bin/python3', args: ['-I', '-B', 'bootstrap.py'] });
  const python = confinedFile(root, path.join(runtime, manifest.executable), fs.constants.X_OK);
  requireArchitecture(inspect(python), host, python);
  const args = ['-I', '-B', confinedFile(root, path.join(runtime, 'bootstrap.py'))];
  const opts = { cwd: work, env: { ...env, PATH: '' }, timeout: 30_000 };
  assert.match(JSON.parse(run(python, [...args, 'version'], opts)).version, /^\d+\.\d+\.\d+/);
  assert.match(run(python, [...args, 'graph', '--format', 'mermaid'], opts), /^(?:graph|flowchart)\s+(?:TD|TB|LR|RL|BT)\b/m);
  run(python, ['-I', '-B', '-c', [
    'import sys, _ssl, _sqlite3',
    'sys.path.insert(0, sys.argv[1])',
    'import pydantic_core._pydantic_core',
  ].join('; '), path.join(runtime, 'site-packages')], opts);
}

function sidecarPid(guiPid) {
  for (const line of run('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 3000 }).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (match && Number(match[2]) === guiPid && path.basename(match[3]) === 'scranton-node') return Number(match[1]);
  }
}

async function smokeGui(exe, work, env) {
  const proc = launch(exe, [], { cwd: work, env });
  proc.child.stdout.resume();
  let pid;
  try {
    const deadline = Date.now() + 20_000;
    while (!proc.ended() && Date.now() < deadline) {
      pid = sidecarPid(proc.child.pid) ?? pid;
      if (pid) {
        // Tauri consumes the ready line itself. Observe the child it launched, not an arbitrary listener.
        let sockets = '';
        try { sockets = run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP@127.0.0.1', '-sTCP:LISTEN', '-Fn'], { timeout: 2000 }); }
        catch (error) { if (error.status !== 1) throw error; }
        const listener = sockets.match(/^n(127\.0\.0\.1:\d+)$/m);
        if (listener) { await probeDashboard(`http://${listener[1]}/`); return; }
      }
      await delay(250);
    }
    throw Error(`GUI did not start a reachable packaged app server: ${proc.stderr()}`);
  } finally {
    try { pid = sidecarPid(proc.child.pid) ?? pid; } catch { /* Still stop the GUI. */ }
    try { await stop(proc); }
    finally {
      if (pid) {
        // The Rust launcher creates a separate sidecar process group; EOF normally stops it.
        try { process.kill(-pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await delay(500);
        try { process.kill(-pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
}

async function main([target, dir, mode, ...extra]) {
  if (!target || !dir || (mode !== undefined && mode !== '--gui') || extra.length) throw Error('Usage: node scripts/desktop-package-smoke.mjs <target> <artifact-directory> [--gui]');
  const version = await readDesktopVersion();
  const { platform, files } = artifactPlan(target, version);
  const mac = platform === 'darwin-aarch64', arch = platform.endsWith('aarch64') ? 'arm64' : 'x64';
  assert.equal(process.platform, mac ? 'darwin' : 'linux');
  assert.equal(process.arch, arch);
  assert.ok(platform.startsWith('linux-') || mac, 'Package smoke is POSIX only');
  const host = { format: mac ? 'mach-o' : 'elf', arch };
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP), 'An absolute RUNNER_TEMP is required');
  const gui = mode === '--gui';
  for (const { bundle, name } of files.filter(file => ['app', 'deb', ...(gui ? [] : ['appimage', 'dmg'])].includes(file.bundle))) {
    const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, `scranton-${bundle}-`));
    try {
      const extracted = path.join(work, 'package');
      fs.mkdirSync(extracted);
      const artifact = confinedFile(dir, path.resolve(dir, name));
      if (bundle === 'dmg') {
        verifyDmg(artifact, extracted);
        console.log(`${name}: read-only DMG mount, app signature, and detach passed`);
        continue;
      }
      const layout = unpack(bundle, artifact, extracted, host);
      const { root, bin, app } = layout;
      const executable = file => {
        const exe = confinedFile(root, path.join(bin, file), fs.constants.X_OK);
        requireArchitecture(inspect(exe), host, exe);
        return exe;
      };
      const exe = executable('scranton-desktop');
      const { dirs, env } = isolatedEnv(work, gui);
      if (gui) await smokeGui(exe, work, env);
      else {
        const count = scanNative(root, host);
        console.log(`${name}: checked ${count} native files for ${host.format}/${host.arch}`);
        const node = executable('scranton-node'), helper = executable('scranton-sandbox-helper');
        confinedFile(root, path.join(app, 'bin/scranton.js'));
        smokePipeline(layout, host, work, env);
        await runSidecar(app, node, helper, work, env, dirs);
      }
      console.log(`${name}: ${gui ? 'GUI-launched server HTTP 200' : 'Pipeline version/graph/native extensions and packaged dashboard ready (HTTP 200)'}`);
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
