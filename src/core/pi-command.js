import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, validateGateTools } from './config.js';
import { isFile } from './util.js';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** The only free text that ever reaches pi's argv; the task itself travels in the attached inbox file. */
export const AGENT_MESSAGE =
  'Your Hive inbox message is attached. Do the work it describes and end your final message with exactly one status keyword on its own line, as your role instructions require.';

export class PiNotFoundError extends Error {
  name = 'PiNotFoundError';
}

const SHELL_SHIMS = /\.(cmd|bat)$/i;

/** Find an executable on PATH. On Windows only PATHEXT matches count (in order): npm also drops an extensionless sh script that cannot be spawned. */
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  if (platform === 'win32' && path.extname(name)) exts.unshift('');
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Locate the locally installed pi package and return `{ dir, script }` of its `bin.pi`. */
export function findLocalPi(roots = [PACKAGE_ROOT]) {
  for (const root of roots) {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      const pkgDir = path.join(dir, 'node_modules', ...PI_PACKAGE.split('/'));
      const manifest = path.join(pkgDir, 'package.json');
      if (isFile(manifest)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
          if (bin && isFile(path.join(pkgDir, bin))) return { dir: pkgDir, script: path.join(pkgDir, bin), version: pkg.version };
        } catch {
          // unreadable manifest: keep looking
        }
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

function resolveArgv0(argv, { env, platform }) {
  const [first, ...rest] = argv;
  let exe = first;
  if (platform === 'win32' && !/[\\/]/.test(first) && !path.extname(first)) {
    exe = findOnPath(first, { env, platform }) ?? first;
  }
  return { argv: [exe, ...rest], shell: platform === 'win32' && SHELL_SHIMS.test(exe) };
}

/**
 * Resolution order: (1) config pi.command / env SCRANTON_PI_COMMAND, (2) the local dependency run via
 * `node <bin.pi>` (no .cmd shim), (3) `pi` on PATH. Returns `{ argv, shell, source, description }`.
 */
export function resolvePiCommand({ config, env = process.env, platform = process.platform, roots } = {}) {
  if (config?.pi?.command?.length) {
    const source = config.pi.commandSource ?? 'config';
    const resolved = resolveArgv0(config.pi.command, { env, platform });
    return { ...resolved, source, description: `${source === 'env' ? 'SCRANTON_PI_COMMAND' : 'config pi.command'}: ${config.pi.command.join(' ')}` };
  }
  const local = findLocalPi(roots);
  if (local) {
    return {
      argv: [process.execPath, local.script],
      shell: false,
      source: 'local',
      description: `local dependency ${PI_PACKAGE}@${local.version ?? '?'} (${local.script})`
    };
  }
  const onPath = findOnPath('pi', { env, platform });
  if (onPath) {
    return { argv: [onPath], shell: platform === 'win32' && SHELL_SHIMS.test(onPath), source: 'path', description: `pi on PATH: ${onPath}` };
  }
  throw new PiNotFoundError(
    `pi not found. Install it (npm install --ignore-scripts ${PI_PACKAGE}), put "pi" on PATH, or set SCRANTON_PI_COMMAND / pi.command.`
  );
}

/** argv for one agent invocation. Task text is never in here: only the attached inbox path and a fixed message. */
export function buildPiArgs({ agent, pi, inboxFile, systemPromptFile, sessionDir, transport = 'json', sessionId, instanceId, extensionFile }) {
  if (agent.kind === 'gate') validateGateTools(agent, pi);
  const args = ['--mode', transport];
  if (agent.model) {
    if (agent.provider) args.push('--provider', agent.provider);
    args.push('--model', agent.model);
  }
  if (agent.thinking) args.push('--thinking', agent.thinking);
  if (agent.kind !== 'gate') args.push('--tools', agent.tools.join(','));
  if (systemPromptFile) args.push('--append-system-prompt', systemPromptFile);
  if (sessionDir) args.push('--session-dir', sessionDir);
  if (pi.minimalContext) args.push('--no-skills', '--no-context-files', '--no-extensions', '--no-mcp', '--no-approve');
  args.push(...pi.extraArgs, ...agent.extraArgs);
  if (agent.kind === 'gate') args.push('--no-extensions', '--no-mcp');
  if (transport === 'rpc') {
    if (sessionId) args.push('--session-id', sessionId);
    if (instanceId) args.push('--name', instanceId);
    if (extensionFile) args.push('--extension', extensionFile);
  }
  if (agent.kind === 'gate') args.push('--tools', agent.tools.join(','));
  if (transport !== 'rpc') args.push(`@${inboxFile}`, AGENT_MESSAGE);
  return args;
}

/** Quote one argument for cmd.exe (only used for .cmd/.bat shims, which Node spawns through a shell). */
export function quoteForCmd(arg) {
  if (/["\r\n%]/.test(arg)) throw new Error(`argument cannot be passed through cmd.exe safely: ${JSON.stringify(arg)}`);
  return `"${arg.replace(/\\+$/, '$&$&')}"`;
}

export function piChildEnv(env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (/^SCRANTON_(RUN_LEASE|PARENT_GUARD)$/i.test(key)) delete childEnv[key];
  }
  return childEnv;
}

/** Spawn pi without a shell where possible. stdin is closed so pi never waits on piped input. */
export function spawnPi(spec, args, { cwd, env, stdin = 'ignore' }) {
  const options = { cwd, env: piChildEnv(env ?? process.env), stdio: [stdin, 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' };
  if (spec.shell) {
    return spawn([...spec.argv, ...args].map(quoteForCmd).join(' '), { ...options, shell: true });
  }
  return spawn(spec.argv[0], [...spec.argv.slice(1), ...args], options);
}

/** Kill a child and everything it started (taskkill /T on Windows, the process group elsewhere). */
export function killTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid || child.exitCode !== null) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {
        child.kill();
        resolve();
      });
      killer.on('close', () => resolve());
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    resolve();
  });
}

/** Run pi once for a non-agent call (version, auth check) and collect its output. */
export function execPi(spec, args, { cwd = process.cwd(), env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnPi(spec, args, { cwd, env });
    } catch (err) {
      return resolve({ code: null, stdout: '', stderr: '', error: err.message });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error: timedOut ? `timed out after ${timeoutMs} ms` : null });
    });
  });
}
