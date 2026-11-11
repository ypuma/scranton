import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AGENT_MESSAGE, buildPiArgs, spawnPi, killTree, piChildEnv } from './pi-command.js';
import { JsonlSplitter, parseJsonLine } from './jsonl.js';
import { extractKeyword, KEYWORDS } from './keywords.js';
import { tailLines } from './util.js';
import { CHAT_TITLE, RPC_ACK_TIMEOUT_MS, CHAT_ACK_TIMEOUT_MS, validChat } from '../../tools/pi-agent-chat.js';

export const RPC_STARTUP_TIMEOUT_MS = 60000;

const extension = fileURLToPath(new URL('../../tools/pi-agent-chat.js', import.meta.url));

export function startPiRpc(options, { describeTool }) {
  const { agentId, instanceId = agentId, hive, agentConfig, pi, onMessage, onSpawn, onTool, onToolEnd } = options;
  let execution = typeof options.execution === 'function' ? {} : options.execution ?? {};
  const sessionId = options.sessionId ?? randomUUID();
  // Overrides may shorten deadlines, never erase the extension's transport headroom.
  const budget = (value, maximum) => Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
  const ackTimeoutMs = budget(options.ackTimeoutMs, RPC_ACK_TIMEOUT_MS);
  const brokerTimeoutMs = budget(options.brokerTimeoutMs, CHAT_ACK_TIMEOUT_MS);
  const startupTimeoutMs = budget(options.startupTimeoutMs, RPC_STARTUP_TIMEOUT_MS);
  let spawnedAt, firstCommand, answered = false;
  const started = Date.now();
  const pending = new Map();
  const dialogs = new Map();
  const replies = new Map();
  const timers = new Set();
  const splitter = new JsonlSplitter();
  let child, failure, last, stderr = '', settled = false, closing = false, finished = false;
  let accepted = false, stopping = false;
  const usage = { input: 0, output: 0, cost: 0 };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const cancelPending = (error, preservePrompt = false) => {
    for (const [id, p] of pending) { if (preservePrompt && p.type === 'prompt') continue; clearTimeout(p.timer); timers.delete(p.timer); p.resolve({ ok: false, error, ...(p.type === 'steer' ? { delivery: 'unknown' } : {}) }); pending.delete(id); }
    for (const [id, timer] of dialogs) { clearTimeout(timer); timers.delete(timer); dialogs.delete(id); }
  };
  const finish = async (code, signal) => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    cancelPending('Pi session ended');
    if (!failure && !settled) failure = { kind: 'exit', message: `Pi process exited before agent_settled (${code ?? signal})` };
    if (!failure && code !== 0) failure = { kind: 'exit', message: `Pi exited with ${code ?? signal}` };
    if (!failure && !last) failure = { kind: 'no_message', message: 'Pi settled without an assistant message' };
    if (!failure && ['error', 'aborted'].includes(last?.stopReason)) failure = { kind: 'stop_reason', message: last.errorMessage ?? last.stopReason };
    let cleanupComplete = false, cleanupFailure = null;
    try { await execution.cleanup?.(); cleanupComplete = true; }
    catch (error) {
      cleanupFailure = { kind: 'cleanup', message: error?.message ?? String(error) };
      failure ??= cleanupFailure;
    }
    const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    resolveDone({ ok: !failure, text, keyword: failure ? null : extractKeyword(text, agentConfig.keywords ?? KEYWORDS[agentId] ?? []), usage: last ? usage : null,
      exitCode: code ?? -1, durationMs: Date.now() - started, failure: failure ?? null, cleanupComplete, cleanupFailure, stderrTail: tailLines(stderr, 8), sessionId });
  };
  const fail = (kind, message) => {
    if (finished) return;
    failure ??= { kind, message };
    closing = true;
    cancelPending(message);
    if (!child) return;
    void killTree(child).catch(() => {}).finally(() => {
      if (!finished) later(() => { child?.stdout?.destroy(); child?.stderr?.destroy(); void finish(null, 'SIGKILL'); }, 1000);
    });
  };
  const write = (record) => {
    if (finished || !child?.stdin?.writable) return false;
    child.stdin.write(`${JSON.stringify(record)}\n`, (error) => { if (error) fail('pipe', error.message); });
    return true;
  };
  const shutdown = () => {
    if (stopping || closing || !settled || !accepted || pending.size || dialogs.size) return;
    closing = true;
    child.stdin.end();
    later(() => fail('shutdown', 'Pi did not exit after stdin closed'), options.shutdownTimeoutMs ?? 3000);
  };
  const armAck = (id, p) => {
    // ACKs can arrive out of order; each request keeps its original deadline.
    const startup = !answered;
    const message = startup ? `pi did not start within ${startupTimeoutMs / 1000} s (no answer to the first ${firstCommand})` : `${p.type} ACK timed out`;
    p.timer = later(() => {
      pending.delete(id);
      p.resolve({ ok: false, error: `${message}${p.type === 'steer' ? '; delivery unknown. Do not resend automatically.' : ''}`, ...(p.type === 'steer' ? { delivery: 'unknown' } : {}) });
      fail('rpc_timeout', message);
    }, startup ? Math.max(0, startupTimeoutMs - (Date.now() - spawnedAt)) : ackTimeoutMs);
  };
  const request = (type, fields = {}) => new Promise((resolve) => {
    if (closing || finished) return resolve({ ok: false, error: 'Pi session ended' });
    const id = randomUUID();
    firstCommand ??= type;
    const p = { resolve, type };
    pending.set(id, p);
    armAck(id, p);
    if (!write({ id, type, ...fields })) fail('pipe', 'Pi stdin is closed');
  });
  const handle = (line) => {
    if (finished || !line.trim()) return;
    const r = parseJsonLine(line);
    if (!r || typeof r.type !== 'string') return fail('protocol', 'Invalid Pi RPC record');
    if (r.type === 'response') {
      const p = pending.get(r.id);
      if (!p) { if (r.command === 'parse') fail('protocol', r.error ?? 'Pi parse error'); return; }
      if (r.command !== p.type || typeof r.success !== 'boolean') return fail('protocol', 'Mismatched Pi RPC ACK');
      clearTimeout(p.timer); timers.delete(p.timer); pending.delete(r.id);
      answered = true;
      p.resolve({ ok: r.success, ...(r.data ?? {}), ...(r.success ? {} : { error: r.error ?? 'Pi rejected command' }) });
      shutdown();
    } else if (r.type === 'extension_ui_request') {
      if (r.method !== 'input' || r.title !== CHAT_TITLE) {
        if (['input', 'editor', 'select', 'confirm'].includes(r.method)) write({ type: 'extension_ui_response', id: r.id, cancelled: true });
        return;
      }
      if (closing || typeof r.id !== 'string' || !r.id || r.id.length > 200) return;
      if (replies.has(r.id)) {
        write({ type: 'extension_ui_response', id: r.id, value: JSON.stringify(replies.get(r.id)) });
        return;
      }
      if (dialogs.has(r.id)) return;
      // Never evict replay protection while this invocation can still receive old IDs.
      if (replies.size + dialogs.size >= 1000) {
        write({ type: 'extension_ui_response', id: r.id, value: JSON.stringify({ ok: false, error: 'Chat request limit reached' }) });
        return;
      }
      const reply = (ack) => {
        if (!dialogs.has(r.id)) return;
        clearTimeout(dialogs.get(r.id)); timers.delete(dialogs.get(r.id)); dialogs.delete(r.id);
        replies.set(r.id, ack);
        write({ type: 'extension_ui_response', id: r.id, value: JSON.stringify(ack) });
        shutdown();
      };
      dialogs.set(r.id, later(() => reply({ ok: false, delivery: 'unknown', error: 'Broker ACK timed out; delivery unknown. Do not resend automatically.' }), brokerTimeoutMs));
      const payload = parseJsonLine(r.placeholder);
      if (!validChat(payload)) return reply({ ok: false, error: 'Invalid chat request; only to/text allowed' });
      Promise.resolve().then(() => {
        if (closing || finished || !dialogs.has(r.id)) return { ok: false, error: 'Session ended' };
        return onMessage ? onMessage({ to: payload.to, text: payload.text }) : { ok: false, error: 'No broker configured' };
      }).then((ack) => reply(typeof ack?.ok === 'boolean' ? ack : { ok: false, delivery: 'unknown', error: 'Invalid broker ACK; delivery unknown. Do not resend automatically.' }), (error) => reply({ ok: false, delivery: 'unknown', error: `${error.message}; delivery unknown. Do not resend automatically.` }));
    } else if (r.type === 'message_end' && r.message?.role === 'assistant') {
      if (typeof r.message.content !== 'string' && (!Array.isArray(r.message.content) || r.message.content.some((b) => !b || typeof b !== 'object'))) return fail('protocol', 'Invalid assistant content');
      options.onAssistantMessage?.(typeof r.message.content === 'string' ? r.message.content : r.message.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'), Array.isArray(r.message.content) && r.message.content.some((b) => b.type === 'toolCall'));
      last = r.message;
      usage.input += last.usage?.input ?? 0; usage.output += last.usage?.output ?? 0; usage.cost += last.usage?.cost?.total ?? 0;
    } else if (r.type === 'tool_execution_start') onTool?.({ tool: r.toolName, ...describeTool(r.toolName, r.args, options.cwd) });
    else if (r.type === 'tool_execution_end') onToolEnd?.({ tool: r.toolName, isError: Boolean(r.isError) });
    else if (r.type === 'agent_start') settled = false;
    else if (r.type === 'agent_settled') {
      settled = true;
      if (r.aborted) failure ??= { kind: 'aborted', message: 'Pi aborted the run' };
      shutdown();
    }
  };
  const ready = (async () => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('sessionId must be a UUID');
    const message = options.message ?? `${AGENT_MESSAGE}\n\n${fs.readFileSync(hive.inboxPath(instanceId), 'utf8')}`;
    if (typeof options.execution === 'function') {
      execution = await options.execution({ systemPromptFile: options.systemPromptFile, extensionFile: extension,
        sessionDir: hive.sessionDir(instanceId), inboxFile: hive.inboxPath(instanceId), cwd: options.cwd,
        env: piChildEnv({ ...process.env, ...options.extraEnv }) });
      if (!execution || typeof execution !== 'object') throw new Error('execution factory must return a launch override');
    }
    if (closing) { await finish(null); return; }
    const args = buildPiArgs({ agent: agentConfig, pi, transport: 'rpc', instanceId, sessionId,
      systemPromptFile: execution.systemPromptFile ?? options.systemPromptFile,
      sessionDir: execution.sessionDir ?? hive.sessionDir(instanceId), extensionFile: execution.extensionFile ?? extension });
    spawnedAt = Date.now();
    child = spawnPi(execution.spec ?? options.spec, [...(execution.argsPrefix ?? []), ...args], {
      cwd: execution.cwd ?? options.cwd, env: { ...process.env, ...options.extraEnv, ...execution.env }, stdin: 'pipe'
    });
    child.stdin.on('error', (error) => fail('pipe', error.message));
    child.stdout.on('data', (chunk) => {
      try { for (const line of splitter.push(chunk)) handle(line); }
      catch (error) { fail('protocol', error.message); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16384); });
    child.on('error', (error) => { failure ??= { kind: 'spawn', message: error.message }; void finish(null); });
    child.on('close', (code, signal) => {
      try { for (const line of splitter.end()) handle(line); }
      catch (error) { failure ??= { kind: 'protocol', message: error.message }; }
      void finish(code, signal);
    });
    onSpawn?.(child);
    request('prompt', { message }).then((ack) => {
      if (stopping) return;
      if (!ack.ok) return fail('rpc', ack.error);
      accepted = true;
      if (ack.disposition === 'handled') return fail('no_message', 'Prompt handled without starting a run');
      shutdown();
    });
    if (options.timeoutMs) later(() => fail('timeout', 'Pi runtime timed out'), options.timeoutMs);
  } catch (error) {
    if (child) fail('spawn', error.message);
    else { failure = { kind: 'spawn', message: error.message }; void finish(null); }
  }
  })();
  const abort = async () => {
    await ready;
    if (finished || closing || stopping) return done;
    stopping = true;
    failure ??= { kind: 'aborted', message: 'Pi run aborted' };
    for (const id of dialogs.keys()) write({ type: 'extension_ui_response', id, cancelled: true });
    cancelPending('Pi run aborted', true);
    // Pi's abort otherwise continues queued steering/follow-ups.
    const cleared = await request('clear_queue');
    if (!cleared.ok || finished || closing) { fail('aborted', 'Pi run aborted'); return done; }
    await request('abort');
    if (!finished && !closing) {
      closing = true;
      child.stdin.end();
      later(() => fail('aborted', 'Pi abort shutdown timed out'), options.shutdownTimeoutMs ?? 3000);
    }
    return done;
  };
  return { done, sessionId, sendMessage: async (text) => { await ready; return stopping ? Promise.resolve({ ok: false, error: 'Pi run aborted' }) : typeof text === 'string' && text.trim() ? request('steer', { message: text }) : Promise.resolve({ ok: false, error: 'Message must be nonempty text' }); },
    abort,
    kill: (reason = 'user') => { fail(reason === 'timeout' ? 'timeout' : 'interrupted', 'Pi run interrupted'); return done; } };
}
