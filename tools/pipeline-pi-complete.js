#!/usr/bin/env node
// Tool-less protocol-v1 completion adapter. Never forward pi output to the caller.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCommandSpec } from '../src/core/config.js';
import { resolvePiCommand, spawnPi, killTree } from '../src/core/pi-command.js';
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
    if (options.thinking) args.push('--thinking', options.thinking);
    args.push('--system-prompt', 'Return only the requested completion. Do not use tools.', '--append-system-prompt', system, `@${user}`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SCRANTON_PIPELINE_KEY_/i.test(k)));
    // Stay in the engine's process group on POSIX so its deadline owns pi too.
    const child = process.platform === 'win32' ? spawnPi(spec, args, { cwd, env }) : spawn(spec.argv[0], [...spec.argv.slice(1), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const timer = setTimeout(() => { timedOut = true; void killTree(child); }, timeoutMs);
    const code = await new Promise((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (exit) => resolve(exit));
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

// The engine also owns the per-call deadline and whole-tree termination.
process.exitCode = await main();
