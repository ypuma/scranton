import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { commandSource, stopSource } from './command.js';
import { spawn as hostSpawn } from 'node:child_process';
import { checkedPath, checkSandbox, dockerSettings, dockerExecutable, dockerEnv, runDocker, runDockerSync, removeContainer } from '../sandbox.js';

const within = (root, file) => { const rel = path.relative(root, file); return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

export async function available(options = {}, dependencies = {}) {
  return checkSandbox({ mode: 'docker', ...(options.image ? { image: options.image } : {}), ...(options.network !== undefined ? { network: options.network } : {}) }, dependencies);
}

export function containerArgs({ name, runId, worktree, mask, image, network }) {
  return ['run', '--detach', '--rm', '--pull=never', '--name', name, '--label', `scranton.run=${runId}`, '--init', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--network', network,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777', '--workdir', '/workspace',
    '--mount', `type=bind,source=${worktree},target=/workspace`, '--mount', `type=bind,source=${mask},target=/workspace/.git,readonly`,
    '--env', 'HOME=/tmp', '--entrypoint', '/bin/sleep', image, 'infinity'];
}

function executableInContainer(file, worktree) {
  if (typeof file !== 'string' || !file || /[\x00\r\n]/.test(file)) throw new Error('Invalid Docker tool executable');
  if (path.isAbsolute(file) && within(worktree, file)) return '/workspace/' + path.relative(worktree, file).split(path.sep).join('/');
  const base = path.win32.basename(file).replace(/\.exe$/i, '');
  const known = { bash: '/bin/bash', sh: '/bin/sh', git: '/usr/bin/git', rg: '/usr/local/bin/rg', fd: '/usr/local/bin/fd', fdfind: '/usr/local/bin/fd', node: '/usr/local/bin/node' };
  if (known[base]) return known[base];
  if (/^[a-zA-Z0-9_-]+$/.test(file) || file.startsWith('/') && !file.includes('\\')) return file;
  throw new Error('Tool executable is not available in the Linux tool image');
}

export function createSandbox({ mode = 'docker', worktree, tempDir, image, network = 'allow', runId = 'standalone', env = process.env, limits = {} } = {}, dependencies = {}) {
  if (mode !== 'docker') throw new Error('Docker sandbox mode must be docker');
  const settings = dockerSettings({ mode, ...(image ? { image } : {}), network });
  if (Object.keys(limits).some(key => key !== 'timeoutMs') || limits.timeoutMs !== undefined && (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0)) throw new Error('Unsupported Docker sandbox limits');
  if (typeof runId !== 'string' || !runId || /[\x00\r\n]/.test(runId)) throw new Error('Invalid Docker run label');
  const executable = dependencies.executable === undefined ? dockerExecutable(env) : dependencies.executable;
  const run = dependencies.run ?? runDocker, sync = dependencies.runSync ?? runDockerSync, launch = dependencies.spawn ?? hostSpawn;
  const launchEnv = dockerEnv(env), name = `scranton-${randomUUID()}`;
  let prepared = false, disposed = false, created = false, mask, cleanup, disposal;
  const children = new Set();
  function prepare() {
    if (disposed) throw new Error('Sandbox disposed');
    if (prepared) return;
    if (!executable) throw new Error('Docker CLI not found; no host fallback');
    if (sync(executable, ['info', '--format', '{{.OSType}}'], launchEnv) !== 'linux') throw new Error('A reachable Linux Docker engine is required');
    if (sync(executable, ['image', 'inspect', '--format', '{{.Os}}', settings.image], launchEnv) !== 'linux') throw new Error(`Local Docker tool image ${settings.image} is required; no automatic pull`);
    worktree = checkedPath(worktree, true); tempDir = checkedPath(tempDir, true);
    if (within(worktree, tempDir) || within(tempDir, worktree)) throw new Error('Worktree and private temp must be disjoint');
    const git = checkedPath(path.join(worktree, '.git'), false);
    if (!/^gitdir: /.test(fs.readFileSync(git, 'utf8'))) throw new Error('Docker requires a private Git worktree');
    mask = path.join(tempDir, `git-mask-${randomUUID()}`);
    fs.writeFileSync(mask, 'Git metadata is managed outside the container.\n', { flag: 'wx', mode: 0o444 });
    try {
      created = true;
      sync(executable, containerArgs({ name, runId, worktree, mask, ...settings }), launchEnv);
      prepared = true;
    } catch (error) {
      // Even a failed CLI launch may have created the container.
      try {
        sync(executable, ['rm', '-f', name], launchEnv);
        if (sync(executable, ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], launchEnv)) throw Error();
        created = false; fs.rmSync(mask, { force: true });
      } catch { throw new Error('Docker setup failed and container cleanup could not be verified'); }
      throw error;
    }
  }
  function spawn(file, argv = [], options = {}) {
    if (!prepared || disposed) throw new Error('Sandbox must be prepared and not disposed');
    if (options.shell || options.windowsVerbatimArguments || options.uid !== undefined || options.gid !== undefined) throw new Error('Unsafe Docker spawn option');
    const cwd = checkedPath(options.cwd ?? worktree, true);
    if (!within(worktree, cwd)) throw new Error('Sandbox cwd must stay inside worktree');
    let running;
    try { running = sync(executable, ['inspect', '--format', '{{.State.Running}}', name], launchEnv); } catch { /* Report the lost container at the adapter boundary. */ }
    if (running !== 'true') throw new Error('Docker tool container is no longer running or reachable; dispose this sandbox and prepare a new one');
    const target = executableInContainer(file, worktree);
    const token = `/tmp/scranton-exec-${randomUUID()}`;
    const args = ['exec', '--interactive', '--workdir', '/workspace' + (path.relative(worktree, cwd) ? '/' + path.relative(worktree, cwd).split(path.sep).join('/') : ''), name, '/usr/local/bin/node', '-e', commandSource, token, target, ...argv];
    const raw = launch(executable, args, { cwd: worktree, env: launchEnv, stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const child = new EventEmitter();
    let stopping, finished = false;
    const stop = () => {
      if (finished || stopping || disposed) return true;
      stopping = run(executable, ['exec', name, '/usr/local/bin/node', '-e', stopSource, token], launchEnv);
      stopping.catch(() => raw.kill('SIGKILL'));
      return true;
    };
    Object.assign(child, { pid: raw.pid, stdin: raw.stdin, stdout: raw.stdout, stderr: raw.stderr, kill: stop, killOwnsTree: true });
    const closed = new Promise(resolve => raw.once('close', (code, signal) => {
      finished = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      Promise.all([cleanup, disposed ? undefined : stopping]).then(() => { child.emit('exit', code, signal); child.emit('close', code, signal); resolve(); }, error => { child.emit('error', error); child.emit('close', code, signal); resolve(); }).finally(() => children.delete(record));
    }));
    const record = { raw, closed }; children.add(record);
    raw.once('error', error => child.emit('error', error));
    raw.once('spawn', () => child.emit('spawn'));
    const abort = () => child.kill('SIGKILL');
    const timeout = options.timeout ?? limits.timeoutMs;
    const timer = timeout ? setTimeout(abort, timeout) : null;
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(abort);
    return child;
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true; prepared = false;
    // Remove the container, not just the local exec CLI: all tool descendants die.
    cleanup = (async () => {
      if (created) { await removeContainer(executable, name, (exe, args) => run(exe, args, launchEnv)); created = false; }
      for (const { raw } of children) raw.kill('SIGKILL');
      if (mask) fs.rmSync(mask, { force: true });
    })();
    disposal = cleanup.then(() => Promise.all([...children].map(record => record.closed)));
    return disposal;
  }
  return { prepare, spawn, dispose, shells: { bash: { file: '/bin/bash', args: ['-c'] } }, available: () => available(settings, { executable, run }), get containerName() { return name; } };
}
