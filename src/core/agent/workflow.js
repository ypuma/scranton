import { spawn } from 'node:child_process';
import { errorTail } from '../redact.js';
import { errorMessage, errorRecord } from './redaction.js';
import path from 'node:path';
import { runTool, toolDefinitions } from '../tools/index.js';
import { messageUsage } from '../usage.js';
import { clip, oneLine } from '../util.js';
import { extractKeyword, KEYWORDS } from '../keywords.js';
import { textOf, compactLimit, compactHistory, removeOldest, SUMMARIZATION_PROMPT } from './compaction.js';

export function describeTool(tool, args, root) {
  const raw = String(args?.path ?? args?.file_path ?? args?.filePath ?? args?.file ?? '');
  const relative = root && path.isAbsolute(raw) ? path.relative(root, raw) : raw;
  const file = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : raw;
  const command = oneLine(String(args?.command ?? args?.cmd ?? args?.script ?? ''));
  const pattern = oneLine(String(args?.pattern ?? args?.query ?? args?.glob ?? args?.regex ?? ''));
  const verbs = { read: 'Reading', write: 'Writing', edit: 'Editing', ls: 'Listing' };
  if (verbs[tool]) return { tool, activity: `${verbs[tool]} ${file || (tool === 'ls' ? '.' : 'a file')}`, detail: file || (tool === 'ls' ? '.' : ''), targetFile: file || null, command: null };
  if (['bash', 'powershell'].includes(tool)) return { tool, activity: `Running ${clip(command, 60) || 'a command'}`, detail: command, command: command || null, targetFile: null };
  return { tool, activity: tool === 'grep' ? (pattern ? `Searching for ${clip(pattern, 40)}` : 'Searching...') : tool === 'find' ? (pattern ? `Finding ${clip(pattern, 40)}` : 'Finding files...') : `Using ${tool}`, detail: pattern || file || command, targetFile: null, command: null };
}

export async function runAgentWorkflow(wf, input, deps) {
  const signal = deps.controller.signal;
  const errorEnv = deps.errorEnv ?? deps.env ?? process.env;
  const started = await wf.now();
  const sessionId = input.sessionId ?? await wf.randomUUID();
  const messages = [...input.messages];
  let history = messages, last = null, failure = null;
  const usage = { input: 0, output: 0, cost: 0 };
  const state = async (phase, detail) => wf.setEvent('agent_state', { phase, detail, ts: new Date(await wf.now()).toISOString() });
  const append = async (message) => {
    messages.push(message);
    if (history !== messages) history.push(message);
    await wf.writeStream('history', { v: 1, type: 'append', message });
  };
  const account = (message) => {
    const u = messageUsage(message);
    if (u) for (const key of ['input', 'output', 'cost']) usage[key] += u[key];
    deps.onAccountUsage?.({ ...usage });
  };
  const request = async (name, context) => {
    await state('thinking', { step: name });
    const response = await wf.runStep(async attempt => {
      signal.throwIfAborted();
      await wf.writeStream('output', { type: 'attempt_start', step: name, attempt });
      let seq = 0, pending = [], flushed = Date.now();
      const flush = async () => {
        for (const part of pending) await wf.writeStream('output', { v: 1, step: name, attempt, seq: seq++, ...part });
        pending = []; flushed = Date.now();
      };
      const stream = deps.llm.stream(input.model, context, { signal, reasoning: input.thinking });
      for await (const event of stream) {
        if (event.type === 'start') deps.onLive?.({ type: 'message_start', message: event.partial });
        else if (event.type === 'done' || event.type === 'error') deps.onLive?.({ type: 'message_end', message: errorMessage(event.message ?? event.error, errorEnv) });
        else deps.onLive?.({ type: 'message_update', message: event.partial, assistantMessageEvent: event });
        if (event.type === 'error') await wf.writeStream('output', { type: 'error', step: name, attempt,
          message: errorTail((event.message ?? event.error)?.errorMessage ?? (event.message ?? event.error)?.error?.message ?? 'LLM request failed', errorEnv) });
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          const kind = event.type === 'text_delta' ? 'text' : 'thinking';
          if (pending.at(-1)?.kind === kind) pending.at(-1).delta += event.delta;
          else pending.push({ kind, delta: event.delta });
          if (Date.now() - flushed >= 100) await flush();
        }
      }
      await flush();
      const result = await stream.result();
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw Object.assign(new Error(result.errorMessage ?? 'LLM request failed'), { transient: result.error?.transient === true,
          name: result.error?.code === 'CONTEXT_WINDOW_EXCEEDED' || result.error?.status === 413 ? 'AgentContextWindowExceeded' : 'Error' });
      }
      return result;
    }, { name, retries: { maxAttempts: 5, intervalSeconds: input.retrySeconds, backoffRate: 2, shouldRetry: e => e.transient === true && !signal.aborted } });
    account(response);
    await wf.runStep(async () => {
      if (!name.startsWith('compact:')) await deps.onAssistantMessage?.(textOf(response), response.content.some(b => b.type === 'toolCall'));
      const u = messageUsage(response);
      if (u) await deps.onUsage?.({ model: response.model ?? input.model.id, usage: u });
    }, { name: `${name}:callbacks` });
    return response;
  };
  const compact = async turn => {
    let context = [...history, { role: 'user', content: SUMMARIZATION_PROMPT }];
    for (let trim = 0; ; trim++) {
      try {
        const response = await request(`compact:${turn}:${trim}`, { systemPrompt: input.systemPrompt, messages: context, tools: input.definitions });
        history = compactHistory(history, textOf(response));
        await wf.writeStream('history', { v: 1, type: 'replace', messages: history });
        return;
      } catch (error) {
        if (!(error.name === 'AgentContextWindowExceeded' || /context[ _-]?(length|window)|prompt is too long|too many.*tokens|maximum context/i.test(error.message)) || context.length <= 1) throw error;
        context = removeOldest(context);
      }
    }
  };
  try {
    await wf.writeStream('history', { v: 1, type: 'replace', messages: input.messages });
    for (let turn = 0; ; turn++) {
      if (turn >= input.maxTurns) throw new Error('Agent max-turns limit reached');
      if (input.timeoutMs && await wf.now() - started >= input.timeoutMs) throw new Error('Agent timeout exceeded');
      // Check cancellation inside a step, never branch on an ephemeral signal during replay.
      await wf.runStep(() => signal.throwIfAborted(), { name: `check:${turn}` });
      for (;;) {
        const steer = await wf.recv('steer', { timeoutSeconds: 0 });
        if (!steer) break;
        if (typeof steer.text === 'string' && steer.text.trim()) await append({ role: 'user', content: steer.text });
      }
      last = await request(`llm:${turn}`, { systemPrompt: input.systemPrompt, messages: history, tools: input.definitions });
      await append(last);
      const calls = last.content.filter(b => b.type === 'toolCall');
      for (const [index, call] of calls.entries()) {
        const name = `tool:${turn}:${index}`;
        let approved = true;
        if (input.approvals?.tools.includes(call.name)) {
          const timeoutSeconds = input.approvals.timeoutSeconds;
          const deadline = await wf.now() + timeoutSeconds * 1000;
          await state('waiting_approval', { workflowId: wf.workflowId, step: name, tool: call.name, args: call.arguments, callId: call.id,
            timeoutSeconds, deadline: new Date(deadline).toISOString() });
          approved = false;
          for (;;) {
            const remaining = (deadline - await wf.now()) / 1000;
            if (remaining <= 0) break;
            const reply = await wf.recv('tool_approval', { timeoutSeconds: remaining });
            if (!reply) break;
            if (reply.workflowId === wf.workflowId && reply.step === name && reply.callId === call.id && typeof reply.approved === 'boolean') { approved = reply.approved; break; }
          }
        }
        await state('tool_call', { tool: call.name, callId: call.id });
        let result = await wf.runStep(async () => {
          signal.throwIfAborted();
          deps.onLive?.({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
          await deps.onTool?.(describeTool(call.name, call.arguments, input.cwd));
          const output = approved ? await runTool(call.name, call.arguments, {
            root: input.cwd, allow: input.allow, signal, env: deps.env,
            spawn: deps.spawn ?? spawn, shells: deps.shells ?? deps.sandbox?.shells, chat: deps.chat,
          }) : { content: 'Tool approval denied or timed out', isError: true };
          return output;
        }, { name, atMostOnce: ['bash', 'powershell', 'agent_chat'].includes(call.name) });
        if (result?.status === 'interrupted') result = { content: 'Command interrupted; its outcome is unknown. Do not automatically repeat it.', isError: true };
        await wf.runStep(async () => {
          deps.onLive?.({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, isError: !!result.isError, result: result.isError ? errorRecord(result, errorEnv) : result });
          await deps.onToolEnd?.({ tool: call.name, isError: !!result.isError });
        }, { name: `${name}:end` });
        await append({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: result.content, isError: !!result.isError });
      }
      const tokens = last.usage?.totalTokens || ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, key) => n + (last.usage?.[key] ?? 0), 0);
      if (tokens >= compactLimit(input.model.contextWindow, input.compactTokenLimit)) {
        try { await compact(turn); }
        catch (error) {
          await state('compaction_failed', { step: `compact:${turn}`, message: 'Compaction failed; continuing with original history' });
          await wf.runStep(async () => {
            try { await deps.onLog?.({ level: 'warn', message: 'Compaction failed; continuing with original history' }); } catch { /* Diagnostics cannot fail the run. */ }
          }, { name: `compact:${turn}:warning` });
        }
      }
      if (!calls.length) break;
    }
  } catch (error) {
    failure = { kind: error.agentFailure ?? (/^ScriptedAgentFailure:(exit|stop_reason|no_message|agent)$/.exec(error.name)?.[1]) ?? 'agent', message: error.message };
    deps.onLive?.({ type: 'agent_settled', failure: errorRecord(failure, errorEnv) });
    await wf.writeStream('output', { type: 'error', message: errorTail(failure.message, errorEnv) });
  } finally {
    // A cancelled runtime currently refuses checkpoints; terminal status still ends readers.
    try { await state('done', errorRecord(failure, errorEnv)); await wf.closeStream('output'); await wf.closeStream('history'); } catch (error) { if (!failure) throw error; }
  }
  const text = textOf(last);
  return { ok: !failure, text, keyword: failure ? null : extractKeyword(text, input.keywords ?? KEYWORDS[input.agentId] ?? []), usage,
    exitCode: failure ? 1 : 0, durationMs: await wf.now() - started, failure, sessionId, cleanupComplete: true };
}

export const definitionsFor = toolDefinitions;
