import fs from 'node:fs';
import path from 'node:path';
import { spawn as directSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { killTree } from '../process-tree.js';
import { resolveToolPath } from './path.js';
import { limitsFor, truncate } from './truncate.js';

export function childEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !/SCRANTON_(?:RUN_LEASE|PARENT_GUARD)|API_?KEY|TOKEN|SECRET|PASSWORD|_KEY$|DATABASE_URL|^DBOS_/i.test(name)));
}

function onPath(name, env) {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return pathValue.split(path.delimiter).map((dir) => path.join(dir.replace(/^"|"$/g, ''), name)).find((file) => fs.existsSync(file));
}

export function resolveShell(name, env = process.env) {
  if (name === 'bash') {
    if (process.platform !== 'win32') return { file: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c'] };
    const candidates = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((dir) => path.join(dir, 'Git', 'bin', 'bash.exe'));
    const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    candidates.push(...pathValue.split(path.delimiter).map((dir) => path.join(dir.replace(/^"|"$/g, ''), 'bash.exe')));
    const file = candidates.find((candidate) => !/[\\/](?:System32|Sysnative|WindowsApps)[\\/]/i.test(candidate) && fs.existsSync(candidate));
    if (!file) throw new Error('bash is not available, use powershell');
    return { file, args: ['-c'] };
  }
  const file = onPath(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh', env) ?? onPath('powershell.exe', env) ?? (process.platform === 'win32' ? path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null);
  if (!file || !fs.existsSync(file)) throw new Error('powershell is not available');
  return { file, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] };
}

// spawn has Node's (file, argv, options) -> ChildProcess interface.
export async function launch(file, args, ctx, { cwd, timeout = 120, onStdout, onStderr } = {}) {
  if (ctx.signal?.aborted) throw new Error('Command aborted');
  return new Promise((resolve, reject) => {
    const child = (ctx.spawn ?? directSpawn)(file, args, { cwd, env: childEnv(ctx.env), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let reason, killing, fallback, settled = false;
    const cleanup = () => { clearTimeout(timer); clearTimeout(fallback); ctx.signal?.removeEventListener('abort', abort); };
    const finish = (code, error) => {
      if (settled) return;
      settled = true; cleanup();
      if (error && !reason) reject(error);
      else resolve({ code, reason });
    };
    const stop = (message) => {
      if (reason || settled) return;
      reason = message;
      // An exited shell can leave inherited pipes open in descendants we can no longer address.
      fallback = setTimeout(() => {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        child.unref?.();
        finish(child.exitCode ?? null);
      }, 2000);
      killing = killTree(child);
    };
    const abort = () => stop('Command aborted');
    const timer = setTimeout(() => stop(`Command timed out after ${timeout} seconds`), timeout * 1000);
    child.stdout?.on('data', onStdout ?? (() => {}));
    child.stderr?.on('data', onStderr ?? (() => {}));
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => { Promise.resolve(killing).then(() => finish(code)); });
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) abort();
  });
}

export async function shell(name, args, ctx) {
  if (args.cwd && path.isAbsolute(args.cwd)) throw new Error('cwd must be relative to tool root');
  const cwd = resolveToolPath(ctx.root, args.cwd ?? '.');
  const config = ctx.spawn && ctx.shells !== undefined ? ctx.shells[name] : resolveShell(name, ctx.env ?? process.env);
  if (!config) throw new Error(`${name} is not available in this sandbox`);
  const limits = limitsFor(ctx);
  let output = '', dropped = false;
  const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
  const append = (text) => {
    output += text;
    const buffer = Buffer.from(output);
    const capacity = limits.maxBytes * 2 + 8;
    if (buffer.length > capacity) {
      let start = buffer.length - capacity;
      while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
      output = buffer.subarray(start).toString('utf8'); dropped = true;
    }
  };
  const command = name === 'powershell' ? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${args.command}` : args.command;
  const result = await launch(config.file, [...config.args, command], ctx, { cwd, timeout: args.timeout ?? 120, onStdout: (chunk) => append(stdout.write(chunk)), onStderr: (chunk) => append(stderr.write(chunk)) });
  append(stdout.end()); append(stderr.end());
  const cut = truncate(output, limits, true);
  dropped ||= cut.truncated; output = cut.content;
  if (dropped) output += `\n\n[Showing last ${limits.maxLines} lines / ${limits.maxBytes} bytes. Refine command output or raise ctx.limits; full output is not saved.]`;
  if (result.reason) output += `\n\n${result.reason}`;
  else if (result.code !== 0) output += `\n\n${result.code === null ? 'Command terminated without an exit code' : `Command exited with code ${result.code}`}`;
  return { content: output || '(no output)', isError: Boolean(result.reason) || result.code !== 0, details: { exitCode: result.code, truncated: dropped } };
}
