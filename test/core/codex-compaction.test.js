import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import codexCompaction, {
  SUMMARIZATION_PROMPT, SUMMARY_PREFIX, COMPACT_USER_MESSAGE_MAX_TOKENS, approxTokenCount, planTokenTruncation,
  truncateTextParts, buildCompactedHistory, autoCompactTokenLimit, isSummaryMessage, runCodexCompaction,
  removeFirstItem, backoffMs, expandCodexCompaction, toLlmMessages
} from '../../tools/pi-codex-compaction.js';
import agentChat from '../../tools/pi-agent-chat.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 2, ...extra });
const textOf = (m) => m.content.map((p) => p.text ?? '').join('');

test('Codex prompt templates are verbatim', () => {
  assert.ok(SUMMARIZATION_PROMPT.startsWith('You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n'));
  assert.ok(SUMMARIZATION_PROMPT.endsWith('helping the next LLM seamlessly continue the work.\n'));
  assert.ok(SUMMARY_PREFIX.startsWith('Another language model started to solve this problem'));
  assert.ok(SUMMARY_PREFIX.endsWith('to assist with your own analysis:'));
  assert.equal(COMPACT_USER_MESSAGE_MAX_TOKENS, 20000);
});

test('token approximation and middle truncation match codex_utils_string', () => {
  assert.equal(approxTokenCount(''), 0);
  assert.equal(approxTokenCount('abcd'), 1);
  assert.equal(approxTokenCount('abcde'), 2);
  assert.equal(approxTokenCount('ü'), 1); // 2 bytes
  assert.equal(planTokenTruncation('a'.repeat(40), 10), null);
  const plan = planTokenTruncation('a'.repeat(100), 10); // keep 40 bytes: 20 head, 20 tail
  assert.deepEqual(plan, { start: 20, end: 80, marker: '…15 tokens truncated…' });
  const parts = truncateTextParts([{ type: 'text', text: 'a'.repeat(100) }], 10);
  assert.equal(parts.map((p) => p.text).join(''), `${'a'.repeat(20)}…15 tokens truncated…${'a'.repeat(20)}`);
  // Never splits a multi-byte character.
  const wide = truncateTextParts([{ type: 'text', text: 'é'.repeat(50) }], 5);
  assert.doesNotMatch(wide.map((p) => p.text).join(''), /�/);
  // Removal spanning two parts keeps one marker.
  const split = truncateTextParts([{ type: 'text', text: 'x'.repeat(30) }, { type: 'text', text: 'y'.repeat(30) }], 5);
  assert.deepEqual(split.map((p) => p.text), ['x'.repeat(10), '…10 tokens truncated…', 'y'.repeat(10)]);
});

test('auto compact limit is 90% of the window, clamped by a configured limit', () => {
  assert.equal(autoCompactTokenLimit(400000), 360000);
  assert.equal(autoCompactTokenLimit(200000, 100000), 100000);
  assert.equal(autoCompactTokenLimit(200000, 500000), 180000);
  assert.equal(autoCompactTokenLimit(undefined, 1234), 1234);
  assert.equal(autoCompactTokenLimit(0), null);
});

test('compacted history keeps recent user messages within 20k tokens, then the summary', () => {
  const summary = `${SUMMARY_PREFIX}\nthe summary`;
  const history = [
    user('old'), assistant('a1'),
    { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'tool output' }] },
    user(`${SUMMARY_PREFIX}\nan older summary`),
    user('x'.repeat(4 * 15000)), user('y'.repeat(4 * 10000)), user('newest')
  ];
  const out = buildCompactedHistory(history, summary);
  assert.ok(out.every((m) => m.role === 'user'));
  assert.equal(textOf(out.at(-1)), summary);
  const kept = out.slice(0, -1).map(textOf);
  // newest (2 tokens) + y (10000) fit; x overflows the remaining 9998 and is middle-truncated; 'old' is past the budget.
  assert.equal(kept.length, 3);
  assert.equal(kept[2], 'newest');
  assert.equal(kept[1], 'y'.repeat(40000));
  assert.match(kept[0], /^x+…5002 tokens truncated…x+$/);
  assert.equal(Buffer.byteLength(kept[0].replace(/….*…/, '')), 9998 * 4);
  assert.ok(!kept.some(isSummaryMessage));
  // Images survive only when the message is all text; otherwise text only.
  const withImage = buildCompactedHistory([{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'b64', mimeType: 'image/png' }] }], summary);
  assert.deepEqual(withImage[0].content, [{ type: 'text', text: 'see' }]);
  assert.equal(textOf(buildCompactedHistory([], '')[0]), '(no summary available)');
});

test('summarizer drops the oldest item on context overflow and backs off on transient errors', async () => {
  const seen = [];
  const replies = [
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'prompt is too long: 300000 tokens > 200000 maximum' },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: '503 overloaded' },
    { ...assistant('progress: done A; next: B'), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } }
  ];
  const delays = [];
  const messages = [user('task'), { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }], stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'file' }] }, user('more')];
  const result = await runCodexCompaction({
    messages, systemPrompt: 'sys', delay: async (ms) => { delays.push(ms); }, random: () => 0.5,
    complete: async (context) => { seen.push(context); return replies.shift(); }
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].systemPrompt, 'sys');
  assert.equal(textOf(seen[0].messages.at(-1)), SUMMARIZATION_PROMPT);
  assert.equal(seen[0].messages.length, 5);
  assert.deepEqual(seen[1].messages.map((m) => m.role), ['assistant', 'toolResult', 'user', 'user']); // oldest user removed
  assert.deepEqual(delays, [200]);
  assert.equal(result.summaryText, `${SUMMARY_PREFIX}\nprogress: done A; next: B`);
  assert.deepEqual(result.history.map(textOf), ['task', 'more', result.summaryText]);
  assert.equal(result.usage.totalTokens, 15);
  await assert.rejects(runCodexCompaction({ messages, complete: async () => ({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 Unauthorized' }) }), /Compaction failed/);
});

test('removing the first item keeps call/output pairs together; backoff doubles', () => {
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'x', arguments: {} }] };
  const out = { role: 'toolResult', toolCallId: 'c1', content: [] };
  assert.deepEqual(removeFirstItem([call, out, user('u')]), [user('u')]);
  assert.deepEqual(removeFirstItem([out, call, user('u')]).map((m) => m.content.length), [0, 1]);
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => backoffMs(n, () => 0.5)), [200, 200, 400, 800, 1600]);
});

test('context rendering replaces only a Codex compaction summary', () => {
  const entry = { type: 'compaction', summary: `${SUMMARY_PREFIX}\ns`, details: { codex: { version: 1, history: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }, { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}\ns` }] }] } } };
  const messages = [{ role: 'compactionSummary', summary: entry.summary, timestamp: 5 }, user('next')];
  const out = expandCodexCompaction(messages, entry);
  assert.deepEqual(out.map((m) => [m.role, textOf(m)]), [['user', 'task'], ['user', entry.summary], ['user', 'next']]);
  assert.equal(expandCodexCompaction(messages, null), messages);
  assert.match(textOf(toLlmMessages([{ role: 'compactionSummary', summary: 'pi', timestamp: 1 }])[0]), /<summary>\npi\n<\/summary>/);
});

test('extension hooks: inline only with a follow-up, threshold cancelled below 90%', async () => {
  const handlers = {};
  const fake = { on: (name, fn) => { handlers[name] = fn; }, getActiveTools: () => ['read'], getAllTools: () => [{ name: 'read', description: 'd', parameters: {} }] };
  codexCompaction(fake, { env: {} });
  assert.deepEqual(Object.keys(handlers).sort(), ['agent_before_settle', 'context', 'session_before_compact', 'turn_end']);
  const calls = [];
  const ctx = {
    model: { contextWindow: 1000 }, getSystemPrompt: () => 'sys', sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ messages: [user('p')] }) },
    modelRegistry: { complete: async (_m, context) => { calls.push(context); return assistant('S'); } }
  };
  const over = { ...assistant('x', { stopReason: 'toolUse' }), usage: { totalTokens: 900 } };
  const base = { entries: [], context: { contextMessages: [user('p'), over], pendingMessages: [] } };
  assert.equal(await handlers.turn_end({ ...base, message: { ...over, usage: { totalTokens: 899 } }, toolResults: [{}] }, ctx), undefined);
  assert.equal(await handlers.turn_end({ ...base, message: over, toolResults: [] }, ctx), undefined);
  const inline = await handlers.turn_end({ ...base, message: over, toolResults: [{}] }, ctx);
  assert.equal(inline.entries.length, 1);
  assert.equal(inline.entries[0].firstKeptEntryId, null);
  assert.equal(inline.entries[0].summary, `${SUMMARY_PREFIX}\nS`);
  assert.deepEqual(calls[0].tools, [{ name: 'read', description: 'd', parameters: {} }]);
  const settled = await handlers.agent_before_settle(base, ctx);
  assert.equal(settled.entries[0].type, 'compaction');
  assert.deepEqual(await handlers.session_before_compact({ reason: 'threshold', preparation: { tokensBefore: 850 } }, ctx), { cancel: true });
  const overflow = await handlers.session_before_compact({ reason: 'overflow', preparation: { tokensBefore: 850 }, branchEntries: [] }, ctx);
  assert.equal(overflow.compaction.firstKeptEntryId, null);
  assert.equal(overflow.compaction.tokensBefore, 850);
  // The managed chat extension loads compaction, and still works with hosts that only register tools.
  const seen = [];
  agentChat({ registerTool: () => {}, on: (name) => seen.push(name) });
  assert.ok(seen.includes('turn_end'));
  assert.doesNotThrow(() => agentChat({ registerTool: () => {} }));
});

test('real pi session: inline compaction installs the Codex history before the next request', async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compaction-'));
  // Faux estimates usage from the prompt, so a large tool output pushes request 2 past 90% of 600.
  const faux = fauxProvider({ models: [{ id: 'faux-small', contextWindow: 600, maxTokens: 200 }] });
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: path.join(dir, 'models.json') });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const contexts = [];
  const record = (reply) => (context) => { contexts.push({ messages: context.messages.filter((m) => m.role !== 'system'), declared: JSON.stringify([context.tools, context.messages.filter((m) => m.role === 'system')]) }); return reply(); };
  faux.setResponses([
    record(() => fauxAssistantMessage(fauxToolCall('probe', {}, { id: 'call-1' }), { stopReason: 'toolUse' })),
    record(() => fauxAssistantMessage(fauxToolCall('probe', {}, { id: 'call-2' }), { stopReason: 'toolUse' })),
    record(() => fauxAssistantMessage('Done: probed twice. Next: answer.')),
    record(() => fauxAssistantMessage('final answer')),
    record(() => fauxAssistantMessage('second answer'))
  ]);
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'test system', extensionFactories: [(pi) => codexCompaction(pi, { env: {} })] });
  await resourceLoader.reload();
  const sessionManager = sdk.SessionManager.inMemory(dir);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, model, thinkingLevel: 'off', modelRuntime: runtime, resourceLoader, sessionManager,
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }), noTools: 'builtin',
    customTools: [{ name: 'probe', label: 'probe', description: 'probe', parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'probe output '.repeat(200) }], details: {} }) }] });
  try {
    await session.prompt('investigate the bug');
    const roles = (i) => contexts[i].messages.map((m) => m.role);
    assert.equal(contexts.length, 4, 'two main requests, the summarizer, the continued request');
    assert.deepEqual(roles(1), ['user', 'assistant', 'toolResult']);
    // Summarizer: the full history (including the in-flight tool call) plus the Codex prompt.
    assert.deepEqual(roles(2), ['user', 'assistant', 'toolResult', 'assistant', 'toolResult', 'user']);
    assert.equal(textOf(contexts[2].messages.at(-1)), SUMMARIZATION_PROMPT);
    assert.match(contexts[2].declared, /"probe"/, 'tool declarations travel with the tool history');
    const summary = `${SUMMARY_PREFIX}
Done: probed twice. Next: answer.`;
    assert.deepEqual(contexts[3].messages.map((m) => [m.role, textOf(m)]), [['user', 'investigate the bug'], ['user', summary]]);
    const entry = sessionManager.getBranch().find((e) => e.type === 'compaction');
    assert.equal(entry.summary, summary);
    assert.equal(entry.firstKeptEntryId, entry.id, 'retain-none compaction');
    assert.equal(sessionManager.getBranch().filter((e) => e.type === 'compaction').length, 1);
    await session.prompt('and now?');
    assert.equal(contexts.length, 5);
    assert.deepEqual(roles(4), ['user', 'user', 'assistant', 'user']);
    assert.equal(textOf(contexts[4].messages[1]), summary);
  } finally {
    session.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
