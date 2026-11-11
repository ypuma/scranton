import fs from 'node:fs';
import { startPiRpc } from './pi-rpc-session.js';
import path from 'node:path';
import { ConfigError } from './config.js';
import { JsonlSplitter, parseJsonLine } from './jsonl.js';
import { KEYWORDS, extractKeyword } from './keywords.js';
import { buildPiArgs, killTree, spawnPi } from './pi-command.js';
import { clip, oneLine, tailLines, writeFileAtomicSync } from './util.js';

const STDERR_CAP = 16 * 1024;

/** Write the role prompt (SKILL.md without its frontmatter) where `--append-system-prompt` can read it. */
export function writeSystemPrompt(hive, agentId, skillFile) {
  let raw;
  try {
    raw = fs.readFileSync(skillFile, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read the ${agentId} skill file ${skillFile}: ${err.message}`);
  }
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const file = path.join(hive.dir, agentId, 'system.md');
  writeFileAtomicSync(file, `${body}\n`);
  return file;
}

const firstString = (args, keys) => keys.map((k) => args?.[k]).find((v) => typeof v === 'string' && v) ?? '';

/** Human-readable `{ activity, detail }` for a pi tool call. */
export function describeTool(tool, args, workspace) {
  const rel = (p) => {
    if (workspace && path.isAbsolute(p)) {
      const r = path.relative(workspace, p);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
    }
    return p;
  };
  const file = rel(firstString(args, ['path', 'file_path', 'filePath', 'file']));
  const command = oneLine(firstString(args, ['command', 'cmd', 'script']));
  const pattern = oneLine(firstString(args, ['pattern', 'query', 'glob', 'regex']));
  switch (tool) {
    case 'write':
      return { activity: `Writing ${file || 'a file'}`, detail: file };
    case 'edit':
      return { activity: `Editing ${file || 'a file'}`, detail: file };
    case 'read':
      return { activity: `Reading ${file || 'a file'}`, detail: file };
    case 'bash':
    case 'powershell':
      return { activity: `Running ${clip(command, 60) || 'a command'}`, detail: command };
    case 'grep':
      return { activity: pattern ? `Searching for ${clip(pattern, 40)}` : 'Searching...', detail: pattern || file };
    case 'find':
      return { activity: pattern ? `Finding ${clip(pattern, 40)}` : 'Finding files...', detail: pattern || file };
    case 'ls':
      return { activity: `Listing ${file || '.'}`, detail: file || '.' };
    default:
      return { activity: `Using ${tool}`, detail: file || command || pattern };
  }
}

function assistantText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Start one pi process for an agent and consume its JSON event stream.
 * Returns `{ done, kill }`; `done` always resolves (never rejects) with the outcome:
 * `{ ok, text, keyword, usage, exitCode, durationMs, failure, stderrTail, sessionId }`.
 * `failure` is null on success, else `{ kind, message }` - an infrastructure failure, not a QA verdict.
 * RPC also returns `cleanupComplete` and `cleanupFailure`, independently of the primary failure.
 */
export function startPi(options) {
  if (options.transport === 'rpc') return startPiRpc(options, { describeTool });
  return startPiJson(options);
}

function startPiJson({ spec, agentId, agentConfig, pi, cwd, hive, runId, milestone = null, cycle = null, systemPromptFile, extraEnv = {}, timeoutMs, onTool, onToolEnd, onSpawn, onAssistantMessage }) {
  fs.mkdirSync(hive.sessionDir(agentId), { recursive: true });
  const args = buildPiArgs({
    agent: agentConfig,
    pi,
    inboxFile: hive.inboxPath(agentId),
    systemPromptFile,
    sessionDir: hive.sessionDir(agentId)
  });
  const env = {
    ...process.env,
    ...extraEnv,
    SCRANTON_AGENT: agentId,
    SCRANTON_RUN_ID: runId,
    SCRANTON_MILESTONE: milestone ?? '',
    SCRANTON_CYCLE: cycle == null ? '' : String(cycle),
    SCRANTON_HIVE: hive.dir
  };
  const started = Date.now();
  let child = null;
  let killedBy = null;
  let kill = async () => {};

  const done = new Promise((resolve) => {
    const rec = { sessionId: null, last: null, usage: { input: 0, output: 0, cost: 0 }, settledAborted: false, retryError: null };
    const splitter = new JsonlSplitter();
    let stderr = '';
    let spawnError = null;
    let finished = false;
    let timer = null;
    let fallback = null;

    const handle = (line) => {
      const r = parseJsonLine(line);
      if (!r) return;
      switch (r.type) {
        case 'session':
          rec.sessionId = r.id ?? null;
          break;
        case 'message_end':
          if (r.message?.role === 'assistant') {
            onAssistantMessage?.(assistantText(r.message), Boolean((r.message.content ?? []).some?.((b) => b?.type === 'toolCall')));
            rec.last = r.message;
            const u = r.message.usage;
            if (u) {
              rec.usage.input += u.input ?? 0;
              rec.usage.output += u.output ?? 0;
              rec.usage.cost += u.cost?.total ?? 0;
            }
          }
          break;
        case 'tool_execution_start':
          onTool?.({ tool: r.toolName, ...describeTool(r.toolName, r.args, cwd) });
          break;
        case 'tool_execution_end':
          onToolEnd?.({ tool: r.toolName, isError: Boolean(r.isError) });
          break;
        case 'agent_settled':
          rec.settledAborted = Boolean(r.aborted);
          break;
        case 'auto_retry_end':
          if (r.success === false) rec.retryError = r.finalError ?? 'automatic retry failed';
          break;
        default:
          break;
      }
    };

    const finish = (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      for (const line of splitter.end()) handle(line);
      const stderrTail = tailLines(stderr, 8);
      const text = assistantText(rec.last);
      let failure = null;
      const fail = (kind, message) => {
        failure = { kind, message: stderrTail ? `${message}\npi stderr:\n${stderrTail}` : message };
      };
      if (spawnError) fail('spawn', `could not start pi: ${spawnError.message}`);
      else if (killedBy === 'timeout') fail('timeout', `${agentId} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`);
      else if (killedBy === 'user') fail('interrupted', `${agentId} was interrupted`);
      else if (exitCode !== 0) fail('exit', `pi exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}`);
      else if (rec.settledAborted) fail('aborted', 'pi aborted the run');
      else if (!rec.last) fail('no_message', 'pi finished without producing an assistant message');
      else if (rec.last.stopReason === 'error' || rec.last.stopReason === 'aborted') {
        fail('stop_reason', `pi ended with stopReason "${rec.last.stopReason}": ${rec.last.errorMessage ?? rec.retryError ?? 'no error message'}`);
      }
      resolve({
        ok: failure === null,
        text,
        keyword: failure ? null : extractKeyword(text, agentConfig.keywords ?? KEYWORDS[agentId] ?? []),
        usage: rec.last || rec.usage.input || rec.usage.output ? rec.usage : null,
        exitCode: exitCode ?? -1,
        durationMs: Date.now() - started,
        failure,
        stderrTail,
        sessionId: rec.sessionId
      });
    };

    try {
      child = spawnPi(spec, args, { cwd, env });
    } catch (err) {
      spawnError = err;
      return finish(null, null);
    }
    onSpawn?.(child);
    child.stdout.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) handle(line);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP);
    });
    child.on('error', (err) => {
      spawnError = err;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    kill = async (reason = 'user') => {
      if (finished) return;
      killedBy ??= reason;
      await killTree(child);
      if (finished) return;
      // a surviving grandchild could keep the pipes open: do not wait for 'close' forever
      fallback = setTimeout(() => finish(null, 'SIGKILL'), 5000);
      fallback.unref();
    };
    if (timeoutMs) timer = setTimeout(() => kill('timeout'), timeoutMs);
  });

  return { done, kill: (reason) => kill(reason) };
}
