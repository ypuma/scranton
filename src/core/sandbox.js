import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';

export const DEFAULT_DOCKER_IMAGE = 'scranton-tools:24-r2';
const hostEnvNames = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];
export function dockerEnv(source = process.env) {
  return Object.fromEntries(hostEnvNames.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}
export function dockerExecutable(env = process.env) {
  const dirs = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of dirs.split(path.delimiter).filter(Boolean)) for (const suffix of process.platform === 'win32' ? ['.exe'] : ['']) {
    const file = path.resolve(dir.replace(/^"|"$/g, ''), 'docker' + suffix);
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}
export function dockerSettings(value = {}) {
  for (const key of Object.keys(value)) if (!['mode', 'image', 'network'].includes(key)) throw new Error('Unsupported sandbox setting: ' + key);
  const result = { mode: 'docker', image: DEFAULT_DOCKER_IMAGE, network: 'allow', ...value };
  if (result.mode !== 'docker') throw new Error('Sandbox mode must be docker');
  if (![true, false, 'allow', 'bridge', 'none'].includes(result.network)) throw new Error('Sandbox network must be allow or none');
  if (typeof result.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(result.image)) throw new Error('Invalid sandbox image');
  result.network = result.network === false || result.network === 'none' ? 'none' : 'bridge';
  return result;
}
export function checkedPath(value, directory, { platform = process.platform, fs: hostFs = fs, path: hostPath = path } = {}) {
  const fs = hostFs, path = hostPath;
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[,\r\n\x00]/.test(value)) throw new Error('Sandbox mount paths must be absolute and cannot contain commas or control characters');
  let full = path.resolve(value);
  if (platform === 'darwin') {
    // macOS owns these root aliases; no user-selected link is canonicalized.
    for (const alias of ['/var', '/tmp']) {
      if (full !== alias && !full.startsWith(`${alias}/`)) continue;
      if (fs.lstatSync(alias).isSymbolicLink()) {
        const target = `/private${alias}`;
        if (path.resolve(path.dirname(alias), fs.readlinkSync(alias)) !== target || fs.realpathSync.native(alias) !== target) throw new Error('Sandbox link/reparse mount rejected');
        full = target + full.slice(alias.length);
      }
      break;
    }
  }
  let current = path.parse(full).root;
  for (const part of path.relative(current, full).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw new Error('Sandbox link/reparse mount rejected');
  }
  const st = fs.lstatSync(full);
  if (directory ? !st.isDirectory() : !st.isFile() || st.nlink > 1) throw new Error('Invalid sandbox mount type');
  return full;
}

export async function runDocker(executable, args, env) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { const failure = new Error('Docker command failed or timed out'); failure.code = error.code; reject(failure); }
      else resolve(stdout.trim());
    });
  });
}

export function runDockerSync(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Docker command failed or timed out');
  return result.stdout.trim();
}
export async function checkSandbox(sandbox = {}, { run = runDocker, executable = dockerExecutable() } = {}) {
  const settings = dockerSettings(sandbox);
  if (!executable) return { available: false, mode: 'docker', reason: 'Docker CLI not found; install/configure a Linux Docker engine explicitly, or explicitly select host mode with --trusted-host' };
  try {
    const engine = await run(executable, ['info', '--format', '{{.OSType}}'], dockerEnv());
    if (engine !== 'linux') return { available: false, mode: 'docker', reason: 'A Linux Docker engine is required' };
  } catch { return { available: false, mode: 'docker', reason: 'Docker is installed but its engine is not responding; start Docker Desktop and try again' }; }
  try {
    const image = await run(executable, ['image', 'inspect', '--format', '{{.Os}}', settings.image], dockerEnv());
    if (image !== 'linux') return { available: false, mode: 'docker', reason: 'A locally available Linux sandbox image is required (no automatic pull)' };
    return { available: true, mode: 'docker', image: settings.image, network: settings.network };
  } catch {
    const recipe = fileURLToPath(new URL('../../sandbox/', import.meta.url)).replace(/[\\/]$/, '');
    return { available: false, mode: 'docker', reason: `Docker tool image ${settings.image} is not available locally; build it once: docker build --pull=false -t ${settings.image} "${recipe}"` };
  }
}

export async function removeContainer(executable, name, run) {
  let removalFailed = false;
  try { await run(executable, ['rm', '-f', name], dockerEnv()); } catch { removalFailed = true; }
  const remaining = await run(executable, ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], dockerEnv());
  if (remaining) throw new Error(`Container cleanup could not be verified${removalFailed ? ' after removal failure' : ''}`);
}

export async function cleanupRunContainers(runId, workspaces = [], { run = runDocker, executable = dockerExecutable() } = {}) {
  const warning = 'Docker is not reachable; containers of this run could not be checked';
  let names;
  try {
    if (!executable) throw Error();
    names = await run(executable, ['container', 'ls', '--all', '--format', '{{.Names}}'], dockerEnv());
  } catch { return [warning]; }
  for (const name of names.split(/\r?\n/).filter((name) => /^scranton-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name))) {
    let container;
    try { [container] = JSON.parse(await run(executable, ['container', 'inspect', name], dockerEnv())); }
    catch { throw Error('Container ownership could not be checked'); }
    const label = container?.Config?.Labels?.['scranton.run'];
    const legacyMatch = !label && container?.Mounts?.some((m) => m.Destination === '/workspace' && workspaces.includes(m.Source));
    if (label === runId || legacyMatch) await removeContainer(executable, name, run);
  }
  return [];
}
