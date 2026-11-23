import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn as hostSpawn, spawnSync } from 'node:child_process';
import { hasCredentialName } from './protected.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const marker = '.scranton-sandbox-owned';
const bashUnavailable = 'bash is unavailable in Windows low mode: MSYS2 shares a Medium-integrity object namespace with host Git Bash (NtCreateDirectoryObject STATUS_ACCESS_DENIED). Use powershell; no Medium-integrity fallback is permitted.';
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

export function createOwnedDirectory(dir) {
  if (!path.isAbsolute(dir)) throw new Error('Owned directory must be absolute');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, marker), 'scranton-sandbox-v1\n', { flag: 'wx', mode: 0o600 });
  return dir;
}

function checkedDirectory(dir, owned = false) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('Sandbox directories must be absolute');
  const resolved = path.resolve(dir);
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Sandbox directories must not contain links/reparse points');
    if (path.dirname(current) === current) break;
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Sandbox path must be a directory');
  if (owned) {
    const file = path.join(resolved, marker);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, 'utf8') !== 'scranton-sandbox-v1\n') throw new Error('Directory is not Scranton-owned');
    // Markers are only issued for newly created directories, never adopted checkouts.
    if (resolved === path.parse(resolved).root || resolved === os.homedir() || resolved === root) throw new Error('Refusing to relabel a user workspace/home');
  }
  return resolved;
}

export function resolveSandboxHelper({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const target = platform === 'win32' ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc` : platform === 'darwin' ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;
  const suffix = platform === 'win32' ? '.exe' : '';
  if (env.SCRANTON_SANDBOX_HELPER) {
    const file = env.SCRANTON_SANDBOX_HELPER;
    if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('SCRANTON_SANDBOX_HELPER must name an existing absolute executable');
    return file;
  }
  return [path.join(root, 'src-tauri/binaries', `scranton-sandbox-helper-${target}${suffix}`), path.join(root, '.scratch/sandbox-helper-target/release', `scranton-sandbox-helper${suffix}`)].find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
}

export function credentialLocations({ platform = process.platform, home = os.homedir(), env = process.env, credentialsDir } = {}) {
  let own = credentialsDir ?? env.SCRANTON_CREDENTIALS_DIR;
  if (own?.startsWith('~' + path.sep) || own?.startsWith('~/')) own = path.join(home, own.slice(2));
  own ??= platform === 'win32' ? path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'dev.scranton.desktop/credentials') : platform === 'darwin' ? path.join(home, 'Library/Application Support/dev.scranton.desktop/credentials') : path.join(env.XDG_DATA_HOME ?? path.join(home, '.local/share'), 'dev.scranton.desktop/credentials');
  return [...new Set([path.resolve(own), ...['.ssh', '.aws', '.config/gcloud', '.pi'].map((p) => path.join(home, p)), ...(platform === 'darwin' ? [path.join(home, 'Library/Keychains')] : [])])];
}

function protection({ credentials, protectedRoots, extraRoots }) {
  const configured = [...new Set([...credentials, ...protectedRoots.filter(r => r.category === 'credentials').map(r => r.path)])];
  const state = [...new Set(protectedRoots.filter(r => r.category === 'scranton-state' && extraRoots.some(g => within(g.path, r.path) || within(r.path, g.path))).map(r => r.path))];
  const approved = extraRoots.filter(g => g.protected === 'credentials' && (configured.some(dir => within(dir, g.path)) || hasCredentialName(g.path)));
  const discovered = extraRoots.flatMap(g => g.shellMasks ?? []).map(mask => mask.path);
  return { state, approved, credentials: [...new Set([...configured, ...discovered])] };
}

const scheme = (value) => JSON.stringify(value);
const subpath = dir => `(subpath ${scheme(dir)})`;
function deniedSubpaths(roots, exceptions) {
  return roots.flatMap(dir => {
    if (exceptions.some(root => within(root, dir))) return [];
    const children = exceptions.filter(root => within(dir, root));
    return children.length ? [`(require-all ${subpath(dir)} ${children.map(root => `(require-not ${subpath(root)})`).join(' ')})`] : [subpath(dir)];
  });
}

export function seatbeltProfile({ worktree, tempDir, network = true, credentials = credentialLocations({ platform: 'darwin' }), extraRoots = [], protectedRoots = [] }) {
  extraRoots = extraRoots.filter(g => g.shellMasks !== null);
  const protectedPaths = protection({ credentials, protectedRoots, extraRoots });
  const credentialReads = deniedSubpaths(protectedPaths.credentials, protectedPaths.approved.map(g => g.path));
  const credentialWrites = deniedSubpaths(protectedPaths.credentials, protectedPaths.approved.filter(g => g.mode === 'write').map(g => g.path));
  // The private worktree and temp may live below the Hive's isolation directory.
  const stateExceptions = grants => protectedPaths.state.flatMap(dir => deniedSubpaths([dir], [...[worktree, tempDir].filter(p => p !== dir), ...grants.filter(g => within(dir, g.path)).map(g => g.path)]));
  const deniedReads = [...credentialReads, ...stateExceptions(extraRoots.filter(g => g.protected))];
  const deniedWrites = [...credentialWrites, ...stateExceptions(protectedPaths.approved.filter(g => g.mode === 'write'))];
  return [
    '(version 1)', '(deny default)', '(allow process-exec)', '(allow process-fork)',
    '(allow signal (target same-sandbox))', '(allow process-info* (target same-sandbox))', '(allow sysctl-read)',
    `(allow file-read* ${['/System', '/usr', '/bin', '/sbin', '/Library', '/opt', '/private/etc', '/dev'].map((dir) => `(subpath ${scheme(dir)})`).join(' ')} (literal "/"))`,
    `(allow file-read* file-write* (subpath ${scheme(worktree)}) (subpath ${scheme(tempDir)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.SystemConfiguration.configd") (global-name "com.apple.system.mDNSResponder"))',
    network ? '(allow network*)' : '(deny network*)',
    '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd.") (global-name-prefix "com.apple.ae") (global-name "com.apple.launchservicesd") (global-name "com.apple.launchd") (global-name "com.apple.xpc.launchd"))',
    '(deny appleevent-send)',
    ...extraRoots.map(root => `(allow file-read*${root.mode === 'write' ? ' file-write*' : ''} (subpath ${scheme(root.path)}))`),
    ...(deniedReads.length ? [`(deny file-read* ${deniedReads.join(' ')})`] : []),
    ...(deniedWrites.length ? [`(deny file-write* ${deniedWrites.join(' ')})`] : []),
  ].join('\n');
}

function safeStat(dir) {
  try { return fs.lstatSync(dir, { throwIfNoEntry: false }); } catch { return undefined; }
}

export function bubblewrapArgs({ worktree, tempDir, cwd = worktree, network = true, credentials = credentialLocations({ platform: 'linux' }), env = process.env, extraRoots = [], protectedRoots = [] }, file, argv = []) {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && (!path.posix.isAbsolute(runtime) || path.posix.normalize(runtime) === '/')) throw new Error('XDG_RUNTIME_DIR must be an absolute non-root path');
  const hidden = [...new Set(['/run', '/run/user', ...(runtime ? [runtime] : [])])];
  const bind = roots => roots.flatMap(root => [root.mode === 'write' ? '--bind' : '--ro-bind', root.path, root.path]);
  extraRoots = extraRoots.filter(g => g.shellMasks !== null);
  const protectedPaths = protection({ credentials, protectedRoots, extraRoots });
  const { approved } = protectedPaths;
  const stateGrants = extraRoots.filter(g => g.protected === 'scranton-state').map(g => ({ ...g, mode: 'read' }));
  const ordinary = extraRoots.filter(g => !g.protected);
  const byDepth = (a, b) => a.length - b.length;
  const minimal = dirs => dirs.sort(byDepth).filter((dir, i, all) => !all.slice(0, i).some(parent => within(parent, dir)));
  const state = minimal(protectedPaths.state.filter(dir => safeStat(dir)?.isDirectory() && !stateGrants.some(g => within(g.path, dir))));
  const credentialDirs = [], credentialFiles = [];
  // Shells only mask cached names to avoid rescanning per spawn; file tools still check newly created names.
  for (const dir of minimal(protectedPaths.credentials.filter(dir => !approved.some(g => within(g.path, dir))))) {
    const stat = safeStat(dir);
    if (stat?.isDirectory()) credentialDirs.push(dir);
    else if (stat?.isFile()) credentialFiles.push(dir);
  }
  const mountDirs = dirs => dirs.flatMap(dir => ['--tmpfs', dir]);
  const remountDirs = dirs => dirs.flatMap(dir => ['--remount-ro', dir]);
  const masks = [...mountDirs(credentialDirs), ...credentialFiles.flatMap(dir => ['--ro-bind', '/dev/null', dir])];
  const unset = [...new Set(['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XAUTHORITY', 'SESSION_MANAGER', 'AT_SPI_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'PULSE_SERVER', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', ...Object.keys(env).filter((key) => key.startsWith('DBUS_'))])];
  return ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/', '/', ...bind(ordinary.filter(g => !within('/tmp', g.path))), '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', ...bind(ordinary.filter(g => within('/tmp', g.path) && g.path !== '/tmp')), ...mountDirs(state), ...bind(stateGrants), '--bind', worktree, worktree, '--bind', tempDir, tempDir, ...masks, ...bind(approved), ...remountDirs(credentialDirs), ...remountDirs(state), ...hidden.flatMap((dir) => ['--tmpfs', dir]), ...unset.flatMap((key) => ['--unsetenv', key]), ...(!network ? ['--unshare-net'] : []), '--chdir', cwd, '--', file, ...argv];
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`Sandbox setup failed (${path.basename(file)}): ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout.trim();
}
function helperRequired(options) {
  const helper = resolveSandboxHelper(options);
  if (!helper) throw new Error('Native sandbox helper is missing. Build native/sandbox-helper or select Docker/trusted host explicitly.');
  return helper;
}

export async function available({ platform = process.platform, ...options } = {}) {
  try {
    if (platform !== process.platform) throw new Error('Execution diagnostics require the native host OS');
    if (platform === 'win32') { const helper = helperRequired(options); run(helper, ['exec', '--cwd', root, '--mode', 'low', '--', path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'), '/d', '/c', 'exit 0']); return { available: true, backend: 'restricted-token', helper, networkIsolation: 'strict-only', tools: { bash: { available: false, reason: bashUnavailable } }, recommendedShell: 'powershell' }; }
    if (platform === 'darwin') { run('/usr/bin/sandbox-exec', ['-p', seatbeltProfile({ worktree: root, tempDir: os.tmpdir() }), '/usr/bin/true']); return { available: true, backend: 'seatbelt' }; }
    if (platform === 'linux') { run('bwrap', bubblewrapArgs({ worktree: root, tempDir: os.tmpdir() }, '/bin/true')); return { available: true, backend: 'bubblewrap' }; }
    throw new Error(`Unsupported sandbox platform: ${platform}`);
  } catch (error) { return { available: false, reason: `${error.message} Use Docker or explicit trusted host; no automatic fallback.` }; }
}

export function hardenCredentials(dir, { backup, ...options } = {}) {
  if (process.platform !== 'win32') throw new Error('Mandatory credential labels are Windows-only');
  checkedDirectory(dir);
  if (!backup || !path.isAbsolute(backup) || within(dir, backup)) throw new Error('An absolute label backup path outside the protected directory is required');
  run(helperRequired(options), ['harden', '--path', dir, '--backup', backup]);
  return { restore: () => run(helperRequired(options), ['unharden', '--backup', backup]), backup };
}

export function createSandbox({ mode = 'scranton', worktree, tempDir, network = true, limits = {}, platform = process.platform, windowsMode = 'low', credentialsDir, env = process.env, extraRoots = () => [], protectedRoots = [] } = {}) {
  if (mode !== 'scranton') throw new Error('Native sandbox mode must be scranton');
  if (typeof network !== 'boolean') throw new Error('network must be boolean');
  if (!['low', 'strict'].includes(windowsMode)) throw new Error('windowsMode must be low or strict');
  if (platform === 'win32' && windowsMode === 'low' && !network) throw new Error('Low mode cannot block network; use strict mode or Docker');
  const limitNames = { timeoutMs: '--timeout-ms', memoryMb: '--memory-mb', processes: '--processes', cpuMs: '--cpu-ms' };
  for (const [key, value] of Object.entries(limits)) if (!limitNames[key] || !Number.isSafeInteger(value) || value <= 0 || value > 0xfffffffe) throw new Error(`Invalid sandbox limit: ${key}`);
  if (platform !== 'win32' && Object.keys(limits).some((key) => key !== 'timeoutMs')) throw new Error('Resource limits other than timeoutMs require the Windows helper');
  let prepared = false, disposed = false, helper, profile, profileSid;
  const children = new Set();
  const credentials = credentialLocations({ platform, env, credentialsDir });
  function prepare() {
    if (disposed) throw new Error('Sandbox disposed');
    if (prepared) return;
    if (platform !== process.platform) throw new Error('Cannot prepare a sandbox for another OS');
    worktree = checkedDirectory(worktree, true); tempDir = checkedDirectory(tempDir, true);
    if (within(worktree, tempDir) || within(tempDir, worktree)) throw new Error('Worktree and private temp must be disjoint');
    if (credentials.some((dir) => within(worktree, dir) || within(tempDir, dir) || within(dir, worktree) || within(dir, tempDir))) throw new Error('Writable roots must not overlap credentials');
    if (platform === 'win32') {
      helper = helperRequired({ env });
      run(helper, ['label-low', '--path', worktree]); run(helper, ['label-low', '--path', tempDir]);
      if (windowsMode === 'strict') {
        profile = `scranton_${randomUUID().replaceAll('-', '')}`;
        try {
          profileSid = run(helper, ['profile-create', '--name', profile]);
          for (const dir of [worktree, tempDir]) run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/icacls.exe'), [dir, '/grant', `*${profileSid}:(OI)(CI)(M)`, '/T', '/Q']);
        }
        catch (error) { disposed = true; cleanupProfile(); throw error; }
      }
    } else if (platform === 'linux') run('bwrap', bubblewrapArgs({ worktree, tempDir, network, credentials, env }, '/bin/true'));
    else if (platform === 'darwin') run('/usr/bin/sandbox-exec', ['-p', seatbeltProfile({ worktree, tempDir, network, credentials }), '/usr/bin/true']);
    else throw new Error(`Unsupported sandbox platform: ${platform}`);
    prepared = true;
  }
  function spawn(file, argv = [], options = {}) {
    if (!prepared || disposed) throw new Error('Sandbox must be prepared and not disposed');
    if (options.shell || options.windowsVerbatimArguments || options.uid !== undefined || options.gid !== undefined) throw new Error('Unsafe spawn option for native sandbox');
    const cwd = checkedDirectory(options.cwd ?? worktree);
    const allGrants = typeof extraRoots === 'function' ? extraRoots() : extraRoots;
    const grants = platform === 'win32' ? allGrants : allGrants.filter(g => {
      if (g.shellMasks === null) return false;
      const stat = safeStat(g.path);
      return stat?.isDirectory() || stat?.isFile();
    });
    if (!within(worktree, cwd) && !grants.some(root => within(root.path, cwd))) throw new Error('Sandbox cwd must stay inside worktree');
    if (!path.isAbsolute(file)) throw new Error('Sandbox executable must be absolute');
    if (platform === 'win32' && windowsMode === 'low' && /^(bash|sh)(\.exe)?$/i.test(path.basename(file))) throw new Error(bashUnavailable);
    const childEnv = Object.fromEntries(Object.entries(options.env ?? env).filter(([key]) => !/^(TEMP|TMP|TMPDIR)$/i.test(key)));
    Object.assign(childEnv, { TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir });
    let executable, args;
    if (platform === 'win32') {
      executable = helper;
      args = ['exec', '--mode', windowsMode, '--cwd', cwd, '--network', network ? 'allow' : 'none', ...(profile ? ['--profile', profile] : []), ...Object.entries(limits).flatMap(([key, value]) => [limitNames[key], String(value)]), '--', file, ...argv];
    } else if (platform === 'darwin') {
      executable = '/usr/bin/sandbox-exec'; args = ['-p', seatbeltProfile({ worktree, tempDir, network, credentials, protectedRoots, extraRoots: grants }), file, ...argv];
    } else { executable = 'bwrap'; args = bubblewrapArgs({ worktree, tempDir, cwd, network, credentials, env: childEnv, protectedRoots, extraRoots: grants }, file, argv); }
    const child = hostSpawn(executable, args, { ...options, shell: false, cwd, env: childEnv, detached: platform !== 'win32', windowsHide: true });
    const kill = child.kill.bind(child);
    child.kill = (signal = 'SIGTERM') => { if (platform !== 'win32') { try { process.kill(-child.pid, signal); return true; } catch {} } return kill(signal); };
    child.killOwnsTree = true;
    children.add(child);
    const timer = limits.timeoutMs && platform !== 'win32' ? setTimeout(() => child.kill('SIGKILL'), limits.timeoutMs) : null;
    child.once('close', () => { clearTimeout(timer); children.delete(child); });
    return child;
  }
  async function dispose() {
    disposed = true; prepared = false;
    await Promise.all([...children].map((child) => new Promise((resolve) => {
      child.once('close', resolve); child.kill('SIGKILL');
    })));
    cleanupProfile();
  }
  function cleanupProfile() {
    const errors = [];
    if (profile) {
      if (profileSid) for (const dir of [worktree, tempDir]) { try { run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/icacls.exe'), [dir, '/remove:g', `*${profileSid}`, '/T', '/Q']); } catch (error) { errors.push(error); } }
      try { run(helper, ['profile-delete', '--name', profile]); profile = undefined; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Sandbox cleanup failed');
  }
  return { prepare, spawn, dispose, available: () => available({ platform, env }), get profileName() { return profile; }, get profileSid() { return profileSid; } };
}
