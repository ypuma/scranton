#!/usr/bin/env node
// Tool-less protocol-v1 completion adapter. Never forward pi output to the caller.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCommandSpec } from '../src/core/config.js';
import { resolvePiCommand, spawnPi, killTree, providerExtensionArgs } from '../src/core/pi-command.js';
import { JsonlSplitter, parseJsonLine } from '../src/core/jsonl.js';

const transient = (text) => /\b(408|429|5\d\d)\b|rate.?limit|timeout|timed? out|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|overloaded|connection/i.test(text);

async function main() {
  const argv = process.argv.slice(2), options = {};
  while (argv[0]?.startsWith('--')) {
    const key = argv.shift().slice(2);
    if (!['provider', 'model', 'thinking'].includes(key) || options[key] || !argv[0] || /^[-@]|[\x00-\x20\x7f]/.test(argv[0]) || argv[0].length > 1024) return 1;
    options[key] = argv.shift();
  }
  if (options.thinking && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.thinking)) return 1;
  if (argv.length !== 2 || !options.provider || !options.model) return 1;
  const [requestPath, responsePath] = argv.map((p) => path.resolve(p));
  let privateDir;
  try {
    fs.rmSync(responsePath, { force: true });
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    if (request.v !== 1 || typeof request.system !== 'string' || typeof request.user !== 'string') return 1;
    privateDir = fs.mkdtempSync(path.join(path.dirname(requestPath), 'pi-'));
    const system = path.join(privateDir, 'system.txt'), user = path.join(privateDir, 'user.txt');
    fs.chmodSync(privateDir, 0o700);
    fs.writeFileSync(system, request.system, { mode: 0o600 }); fs.writeFileSync(user, request.user, { mode: 0o600 });
    const cwd = path.join(privateDir, 'cwd'); fs.mkdirSync(cwd);
    const command = parseCommandSpec(process.env.SCRANTON_PI_COMMAND, 'SCRANTON_PI_COMMAND');
    const spec = resolvePiCommand({ config: command ? { pi: { command, commandSource: 'env' } } : undefined });
    const args = ['--mode', 'json', '-p', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-session', '--no-approve', '--provider', options.provider, '--model', options.model];
    args.push(...providerExtensionArgs(options.provider));
    if (options.thinking) args.push('--thinking', options.thinking);
    args.push('--system-prompt', 'Return only the requested completion. Do not use tools.', '--append-system-prompt', system, `@${user}`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SCRANTON_PIPELINE_KEY_/i.test(k)));
    // Only the adapter holds the lease writer; even SIGKILL closes it in the kernel.
    const child = process.platform === 'win32' ? spawnPi(spec, args, { cwd, env }) : spawn(process.execPath, [fileURLToPath(new URL('./pipeline-pi-complete.js', import.meta.url)), '--lifecycle-owner'], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let ownedCode = null;
    if (process.platform !== 'win32') {
      let status = '';
      child.stdio[3].on('data', (data) => { status = (status + data).slice(0, 128); });
      child.stdio[3].on('end', () => { try { ownedCode = JSON.parse(status).code; } catch {} });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ argv: [...spec.argv, ...args] }) + '\n');
    }
    const splitter = new JsonlSplitter();
    let last = null, usage = null, errors = '', aborted = false, tool = false;
    const handle = (line) => {
      const event = parseJsonLine(line);
      if (event?.type === 'message_end' && event.message?.role === 'assistant') {
        last = event.message;
        const u = last.usage;
        if (Number.isSafeInteger(u?.input) && u.input >= 0 && Number.isSafeInteger(u?.output) && u.output >= 0) {
          usage ??= { input_tokens: 0, output_tokens: 0 };
          const cache = ['cacheRead', 'cacheWrite'].reduce((n, key) => n + (Number.isSafeInteger(u[key]) && u[key] >= 0 ? u[key] : 0), 0);
          usage.input_tokens += u.input + cache; usage.output_tokens += u.output;
        }
      }
      if (event?.type === 'agent_settled' && event.aborted) aborted = true;
      if (event?.type === 'tool_execution_start') tool = true;
      if (event?.type === 'auto_retry_end' && event.success === false) errors = (errors + String(event.finalError ?? '')).slice(-8192);
    };
    child.stdout.on('data', (data) => { for (const line of splitter.push(data)) handle(line); });
    child.stderr.on('data', (data) => { errors = (errors + data).slice(-8192); });
    let timedOut = false;
    const timeoutMs = Math.min(600000, Math.max(1, Number(process.env.SCRANTON_PIPELINE_PI_TIMEOUT_MS) || 600000));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') void killTree(child);
      else child.stdin.end();
    }, timeoutMs);
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (exit) => resolve(process.platform === 'win32' ? exit : ownedCode));
    });
    clearTimeout(timer);
    if (timedOut) return 75;
    for (const line of splitter.end()) handle(line);
    const failed = code !== 0 || aborted || tool || !last || ['error', 'aborted'].includes(last.stopReason);
    if (tool) return 1;
    if (failed) return code === 75 || transient(errors + String(last?.errorMessage ?? '')) ? 75 : 1;
    const text = typeof last.content === 'string' ? last.content : (last.content ?? []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    if (!text) return 1;
    if (usage?.input_tokens === 0 && usage.output_tokens === 0) usage = null;
    fs.writeFileSync(responsePath, JSON.stringify({ text, usage }), { encoding: 'utf8', mode: 0o600 });
    return 0;
  } catch {
    return 1;
  } finally {
    if (privateDir) { try { fs.rmSync(privateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { return 1; } }
  }
}

// POSIX group owner: stdin is a lease held only by the completion adapter.
function runGroupOwner() {
  function terminate() {
    // Stay alive until the kill: our PID cannot be reused as a foreign PGID.
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
  }
  let started = false, input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('end', terminate);
  process.stdin.on('error', terminate);
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  process.stdin.on('data', (chunk) => {
    if (started) return terminate();
    input += chunk;
    if (input.length > 1048576) return terminate();
    if (!input.endsWith('\n')) return;
    started = true;
    try {
      const { argv } = JSON.parse(input);
      if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) return terminate();
      const child = spawn(argv[0], argv.slice(1), { detached: false, stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', terminate);
      child.once('exit', (code) => {
        // Status is separate because cleanup deliberately kills the owner too.
        try { fs.writeSync(3, JSON.stringify({ code }) + '\n'); } finally { terminate(); }
      });
    } catch { terminate(); }
  });
}

if (process.platform !== 'win32' && process.argv.length === 3 && process.argv[2] === '--lifecycle-owner') runGroupOwner();
else process.exitCode = await main();
