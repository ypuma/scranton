/**
 * Codex-style context compaction for pi agents.
 *
 * A port of openai/codex `codex-rs/core/src/compact.rs` (local "Responses" compaction):
 *
 * 1. Trigger: the last response's context tokens reach `auto_compact_token_limit`, which is
 *    90% of the model's context window (optionally clamped lower by a configured limit).
 *    Inline (mid-turn) when the turn still needs a follow-up request, post-turn otherwise.
 * 2. Summarize: send the whole current history plus SUMMARIZATION_PROMPT as a user message to
 *    the session's own model. On a context-window error drop the oldest history item and retry;
 *    other errors retry with Codex's exponential backoff, up to stream_max_retries (5).
 * 3. Replace: the new history is the recent real user messages (newest first, 20k token budget,
 *    the oldest one that overflows middle-truncated) followed by one user message holding
 *    SUMMARY_PREFIX + "\n" + the summary. No assistant or tool items are kept.
 *
 * Pi stores this as a retain-none compaction entry whose `details.codex.history` holds the
 * replacement items, and the `context` hook renders them in place of pi's own summary wrapper.
 * Every pi-initiated compaction (threshold, overflow recovery, /compact) runs the same algorithm.
 *
 * Deliberately dependency-free so the harness can import it and Docker can mount it as one file.
 */

// codex-rs/prompts/templates/compact/prompt.md (verbatim, including its trailing newline)
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`;

// codex-rs/prompts/templates/compact/summary_prefix.md (verbatim, no trailing newline)
export const SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const DEFAULT_STREAM_MAX_RETRIES = 5;
const APPROX_BYTES_PER_TOKEN = 4;
const INITIAL_DELAY_MS = 200;
const BACKOFF_FACTOR = 2;
export const DETAILS_KEY = 'codex';

// pi's own wrappers (core/messages.js) for entries this extension did not write.
const PI_COMPACTION_PREFIX = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const PI_COMPACTION_SUFFIX = '\n</summary>';
const PI_BRANCH_PREFIX = 'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n';
const PI_BRANCH_SUFFIX = '</summary>';

const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** codex_utils_string::approx_token_count: ceil(utf8 bytes / 4). */
export function approxTokenCount(text) {
  return Math.ceil(bytes(text) / APPROX_BYTES_PER_TOKEN);
}

// UTF-8 continuation bytes are 0b10xxxxxx; char boundaries are any other byte or the ends.
const isBoundary = (buf, i) => i <= 0 || i >= buf.length || (buf[i] & 0xc0) !== 0x80;
const floorBoundary = (buf, i) => { i = Math.min(i, buf.length); while (!isBoundary(buf, i)) i--; return i; };
const ceilBoundary = (buf, i) => { i = Math.max(i, 0); while (!isBoundary(buf, i)) i++; return i; };

/**
 * codex_utils_string::plan_token_truncation. Keeps max_tokens*4 bytes split evenly between head
 * and tail and replaces the middle with `…N tokens truncated…`. Offsets are UTF-8 byte offsets.
 */
export function planTokenTruncation(text, maxTokens) {
  const buf = Buffer.from(text, 'utf8');
  const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
  if (buf.length <= maxBytes) return null;
  const left = Math.floor(maxBytes / 2);
  const right = maxBytes - left;
  const start = floorBoundary(buf, left);
  const end = ceilBoundary(buf, buf.length - right);
  const removedTokens = Math.ceil((buf.length - maxBytes) / APPROX_BYTES_PER_TOKEN);
  return { start, end, marker: `…${removedTokens} tokens truncated…` };
}

/** codex_context_fragments::truncate_annotated_text over pi text parts. */
export function truncateTextParts(parts, maxTokens) {
  const joined = parts.map((p) => p.text).join('');
  const plan = planTokenTruncation(joined, maxTokens);
  if (!plan) return parts;
  const result = [];
  let notice = { type: 'text', text: plan.marker };
  let offset = 0;
  for (const part of parts) {
    const buf = Buffer.from(part.text, 'utf8');
    const start = offset;
    offset += buf.length;
    if (offset <= plan.start || start >= plan.end) { result.push(part); continue; }
    const prefixEnd = Math.max(0, plan.start - start);
    const suffixStart = Math.min(Math.max(0, plan.end - start), buf.length);
    if (prefixEnd > 0) result.push({ ...part, text: buf.subarray(0, prefixEnd).toString('utf8') });
    if (notice) { result.push(notice); notice = null; }
    if (suffixStart < buf.length) result.push({ ...part, text: buf.subarray(suffixStart).toString('utf8') });
  }
  return result;
}

const contentParts = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
const textOf = (content) => contentParts(content).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');

/** compact.rs is_summary_message. */
export function isSummaryMessage(text) {
  return typeof text === 'string' && text.startsWith(`${SUMMARY_PREFIX}\n`);
}

/** ModelInfo::auto_compact_token_limit: min(configured, 90% of the context window). */
export function autoCompactTokenLimit(contextWindow, configured) {
  const windowLimit = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor((contextWindow * 9) / 10) : null;
  const config = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : null;
  if (windowLimit !== null) return config === null ? windowLimit : Math.min(config, windowLimit);
  return config;
}

/** Tokens in the context window after a response (pi's calculateContextTokens). */
export function contextTokens(usage) {
  if (!usage) return 0;
  return usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * compact.rs build_compacted_history_with_limit. Takes LLM messages, returns the replacement
 * items as plain `{ role: 'user', content }` records (the last one is the summary).
 */
export function buildCompactedHistory(messages, summaryText, maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS) {
  const selected = [];
  if (maxTokens > 0) {
    let remaining = maxTokens;
    const users = messages.filter((m) => m?.role === 'user' && !isSummaryMessage(textOf(m.content)));
    for (let i = users.length - 1; i >= 0; i--) {
      if (remaining === 0) break;
      const parts = contentParts(users[i].content);
      const tokens = approxTokenCount(textOf(parts));
      const preserve = tokens <= remaining && parts.every((p) => p?.type === 'text');
      let content;
      if (preserve) {
        content = parts.map((p) => ({ type: 'text', text: p.text }));
      } else {
        // Text only: images are not carried into truncated messages.
        const text = parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => ({ type: 'text', text: p.text }));
        content = truncateTextParts(text.length ? text : [{ type: 'text', text: '' }], remaining);
      }
      selected.unshift({ role: 'user', content });
      remaining = Math.max(0, remaining - tokens);
    }
  }
  selected.push({ role: 'user', content: [{ type: 'text', text: summaryText || '(no summary available)' }] });
  return selected;
}

/** The latest compaction entry on the branch, if this extension wrote it. */
export function latestCodexCompaction(branch) {
  for (let i = (branch?.length ?? 0) - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== 'compaction') continue;
    return Array.isArray(entry.details?.[DETAILS_KEY]?.history) ? entry : null;
  }
  return null;
}

/** Replace pi's compaction summary message with the stored Codex replacement history. */
export function expandCodexCompaction(messages, entry) {
  if (!entry) return messages;
  const index = messages.findIndex((m) => m?.role === 'compactionSummary' && m.summary === entry.summary);
  if (index < 0) return messages;
  const timestamp = messages[index].timestamp ?? Date.now();
  const history = entry.details[DETAILS_KEY].history.map((item) => ({ role: 'user', content: item.content.map((p) => ({ ...p })), timestamp }));
  return [...messages.slice(0, index), ...history, ...messages.slice(index + 1)];
}

/** pi's convertToLlm, after the Codex expansion. Kept local so this file has no imports. */
export function toLlmMessages(messages) {
  const out = [];
  for (const m of messages) {
    switch (m?.role) {
      case 'user': case 'assistant': case 'toolResult': out.push(m); break;
      case 'custom': out.push({ role: 'user', content: contentParts(m.content), timestamp: m.timestamp }); break;
      case 'compactionSummary': out.push({ role: 'user', content: [{ type: 'text', text: PI_COMPACTION_PREFIX + m.summary + PI_COMPACTION_SUFFIX }], timestamp: m.timestamp }); break;
      case 'branchSummary': out.push({ role: 'user', content: [{ type: 'text', text: PI_BRANCH_PREFIX + m.summary + PI_BRANCH_SUFFIX }], timestamp: m.timestamp }); break;
      case 'bashExecution': {
        if (m.excludeFromContext) break;
        let text = `Ran \`${m.command}\`\n${m.output ? `\`\`\`\n${m.output}\n\`\`\`` : '(no output)'}`;
        if (m.cancelled) text += '\n\n(command cancelled)';
        else if (m.exitCode !== null && m.exitCode !== undefined && m.exitCode !== 0) text += `\n\nCommand exited with code ${m.exitCode}`;
        if (m.truncated && m.fullOutputPath) text += `\n\n[Output truncated. Full output: ${m.fullOutputPath}]`;
        out.push({ role: 'user', content: [{ type: 'text', text }], timestamp: m.timestamp });
        break;
      }
      default: break; // system messages travel as the request's systemPrompt
    }
  }
  return out;
}

/**
 * ContextManager::remove_first_item: drop the oldest item and the other half of its
 * call/output pair so the trimmed history stays valid.
 */
export function removeFirstItem(history) {
  const [first, ...rest] = history;
  if (first?.role === 'assistant') {
    const ids = new Set(contentParts(first.content).filter((p) => p?.type === 'toolCall').map((p) => p.id));
    return ids.size ? rest.filter((m) => !(m.role === 'toolResult' && ids.has(m.toolCallId))) : rest;
  }
  if (first?.role === 'toolResult') {
    return rest.map((m) => m.role === 'assistant' && contentParts(m.content).some((p) => p?.type === 'toolCall' && p.id === first.toolCallId)
      ? { ...m, content: contentParts(m.content).filter((p) => !(p?.type === 'toolCall' && p.id === first.toolCallId)) } : m);
  }
  return rest;
}

const OVERFLOW = /context[ _-]?(length|window)|maximum context|prompt is too long|too many (input )?tokens|exceeds? (the )?(model'?s? )?(max(imum)?|context)|input is too long|token limit|request too large|reduce the length/i;
const NON_RETRYABLE = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|permission/i;

/** Codex ContextWindowExceeded, as surfaced by pi providers. */
export function isContextWindowExceeded(message) {
  return message?.stopReason === 'error' && OVERFLOW.test(message.errorMessage ?? '');
}

/** codex_async_utils::backoff: 200ms doubling per attempt (attempts 0 and 1 share it), ±10% jitter. */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.floor(INITIAL_DELAY_MS * BACKOFF_FACTOR ** Math.max(0, attempt - 1));
  return Math.floor(base * (0.9 + random() * 0.2));
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('Compaction aborted'));
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new Error('Compaction aborted')); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/** get_last_assistant_message_from_turn: the text of the last assistant message. */
const lastAssistantText = (message) => textOf(message?.content);

/**
 * run_compact_task_inner_impl. `complete(context, options)` is pi's modelRegistry.complete bound
 * to the session model. Returns the replacement history, the summary text and summarizer usage.
 */
export async function runCodexCompaction({ messages, complete, systemPrompt, tools, signal, prompt = SUMMARIZATION_PROMPT,
  maxRetries = DEFAULT_STREAM_MAX_RETRIES, delay = sleep, random = Math.random }) {
  let history = [...messages, { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }];
  let retries = 0;
  let response;
  for (;;) {
    if (signal?.aborted) throw new Error('Compaction aborted');
    try {
      response = await complete({ ...(systemPrompt ? { systemPrompt } : {}), messages: history, ...(tools?.length ? { tools } : {}) }, { signal });
    } catch (error) {
      response = { role: 'assistant', content: [], stopReason: signal?.aborted ? 'aborted' : 'error', errorMessage: error?.message ?? String(error) };
    }
    if (response?.stopReason !== 'error' && response?.stopReason !== 'aborted') break;
    if (response.stopReason === 'aborted' || signal?.aborted) throw new Error('Compaction aborted');
    if (isContextWindowExceeded(response)) {
      // Trim from the beginning to preserve the cached prefix and keep recent messages intact.
      if (history.length > 1) { history = removeFirstItem(history); retries = 0; continue; }
      throw new Error(`Compaction exceeded the context window: ${response.errorMessage}`);
    }
    if (retries < maxRetries && !NON_RETRYABLE.test(response.errorMessage ?? '')) {
      retries += 1;
      await delay(backoffMs(retries, random), signal);
      continue;
    }
    throw new Error(`Compaction failed: ${response.errorMessage ?? 'unknown error'}`);
  }
  const summaryText = `${SUMMARY_PREFIX}\n${lastAssistantText(response)}`;
  return { summaryText, history: buildCompactedHistory(messages, summaryText), usage: response.usage };
}

function configuredLimit(env) {
  const value = Number.parseInt(env?.SCRANTON_AUTO_COMPACT_TOKEN_LIMIT ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export default function codexCompaction(pi, { env = process.env } = {}) {
  if (typeof pi?.on !== 'function') return;
  const configured = configuredLimit(env);

  const tools = () => {
    try {
      const active = new Set(pi.getActiveTools?.() ?? []);
      return (pi.getAllTools?.() ?? []).filter((t) => active.has(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
    } catch { return []; }
  };

  // Current model-visible history, with an earlier Codex compaction rendered as Codex renders it.
  const llmHistory = (agentMessages, branch) => toLlmMessages(expandCodexCompaction(agentMessages, latestCodexCompaction(branch)));

  const compact = async (ctx, agentMessages, branch, signal, prompt) => {
    const model = ctx.model;
    const result = await runCodexCompaction({
      messages: llmHistory(agentMessages, branch),
      complete: (context, options) => ctx.modelRegistry.complete(model, context, options),
      systemPrompt: ctx.getSystemPrompt?.(), tools: tools(), signal, prompt
    });
    return { summary: result.summaryText, details: { [DETAILS_KEY]: { version: 1, history: result.history } }, usage: result.usage };
  };

  const overLimit = (ctx, assistant, branch) => {
    const limit = autoCompactTokenLimit(ctx.model?.contextWindow, configured);
    if (!limit || assistant?.role !== 'assistant' || ['error', 'aborted'].includes(assistant.stopReason)) return false;
    // A response from before the latest compaction carries stale usage.
    const latest = [...(branch ?? [])].reverse().find((e) => e?.type === 'compaction');
    if (latest && assistant.timestamp <= new Date(latest.timestamp).getTime()) return false;
    return contextTokens(assistant.usage) >= limit;
  };

  const boundary = (phase) => async (event, ctx) => {
    if (!ctx.model || event.entries?.some((e) => e.type === 'compaction')) return undefined;
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const messages = event.context?.contextMessages ?? [];
    const assistant = phase === 'inline' ? event.message : [...messages].reverse().find((m) => m?.role === 'assistant');
    if (!overLimit(ctx, assistant, branch)) return undefined;
    // Inline compaction only when the turn continues; otherwise compact once the turn is done.
    const followUp = (event.toolResults?.length ?? 0) > 0 || (event.context?.pendingMessages?.length ?? 0) > 0;
    if (phase === 'inline' && !followUp) return undefined;
    try {
      const compaction = await compact(ctx, messages, branch, ctx.signal);
      return { entries: [...(event.entries ?? []), { type: 'compaction', firstKeptEntryId: null, ...compaction }] };
    } catch (error) {
      // Leave the context as is; pi's own threshold and overflow recovery still route here.
      process.stderr.write(`[codex-compaction] ${phase} compaction failed: ${error?.message ?? error}\n`);
      return undefined;
    }
  };

  pi.on('turn_end', boundary('inline'));
  pi.on('agent_before_settle', boundary('post-turn'));

  pi.on('session_before_compact', async (event, ctx) => {
    const { preparation, branchEntries, customInstructions, reason, signal } = event;
    if (!ctx.model) return undefined;
    // pi's threshold is window - reserveTokens; Codex compacts at 90% of the window, not before.
    if (reason === 'threshold') {
      const limit = autoCompactTokenLimit(ctx.model.contextWindow, configured);
      if (limit && (preparation?.tokensBefore ?? 0) < limit) return { cancel: true };
    }
    const agentMessages = ctx.sessionManager?.buildSessionProjection?.().messages ?? [];
    const prompt = customInstructions?.trim() ? `${SUMMARIZATION_PROMPT}\n${customInstructions.trim()}\n` : SUMMARIZATION_PROMPT;
    const compaction = await compact(ctx, agentMessages, branchEntries, signal, prompt);
    return { compaction: { ...compaction, firstKeptEntryId: null, tokensBefore: preparation?.tokensBefore ?? 0 } };
  });

  pi.on('context', (event, ctx) => {
    const entry = latestCodexCompaction(ctx.sessionManager?.getBranch?.());
    const messages = expandCodexCompaction(event.messages, entry);
    return messages === event.messages ? undefined : { messages };
  });
}
