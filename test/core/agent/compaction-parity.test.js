import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARIZATION_PROMPT, SUMMARY_PREFIX, compactLimit, compactHistory, removeOldest, textOf } from '../../../src/core/agent/compaction.js';
import { createScriptedProvider } from '../../../src/core/llm/index.js';
import { fixture } from './helpers.js';

const user = content => ({ role: 'user', content });

test('checkpoint templates and 90-percent threshold retain their compaction contract', () => {
  assert.ok(SUMMARIZATION_PROMPT.startsWith('You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n'));
  assert.ok(SUMMARIZATION_PROMPT.endsWith('helping the next LLM seamlessly continue the work.\n'));
  assert.ok(SUMMARY_PREFIX.startsWith('Another language model started to solve this problem'));
  assert.ok(SUMMARY_PREFIX.endsWith('to assist with your own analysis:'));
  assert.equal(compactLimit(400000), 360000);
  assert.equal(compactLimit(200000, 100000), 100000);
  assert.equal(compactLimit(200000, 500000), 180000);
});

test('recent real user text shares a 20k token budget, excluding old summaries and tools', () => {
  const history = [user('old'), { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'toolResult', toolCallId: 't', content: 'tool output' }, user(SUMMARY_PREFIX + '\nold summary'),
    user('x'.repeat(60000)), user('y'.repeat(40000)), user('newest')];
  const out = compactHistory(history, 'summary');
  assert.ok(out.every(m => m.role === 'user'));
  assert.equal(out.length, 4);
  assert.equal(textOf(out.at(-1)), SUMMARY_PREFIX + '\nsummary');
  assert.equal(textOf(out[2]), 'newest'); assert.equal(textOf(out[1]), 'y'.repeat(40000));
  assert.match(textOf(out[0]), /^x+…5002 tokens truncated…x+$/);
  assert.equal(Buffer.byteLength(textOf(out[0]).replace(/….*…/, '')), 9998 * 4);
  const image = compactHistory([user([{ type: 'text', text: 'see' }, { type: 'image', data: 'b64', mimeType: 'image/png' }])], 'summary');
  assert.equal(image[0].content, 'see');
  assert.equal(textOf(compactHistory([], '')[0]), SUMMARY_PREFIX + '\n(no summary available)');
});

test('middle truncation has one marker and never splits UTF-8 code points', () => {
  const out = compactHistory([user([{ type: 'text', text: 'é'.repeat(30) }, { type: 'text', text: '界'.repeat(30) }])], 'summary', 5);
  assert.equal((out[0].content.match(/tokens truncated/g) ?? []).length, 1);
  assert.doesNotMatch(out[0].content, /\ufffd/);
});

test('overflow trimming removes the other half of a tool call/output pair', () => {
  const call = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] };
  const result = { role: 'toolResult', toolCallId: 'c1', content: [] };
  assert.deepEqual(removeOldest([call, result, user('u')]), [user('u')]);
  assert.deepEqual(removeOldest([result, call, user('u')]), [{ role: 'assistant', content: [] }, user('u')]);
});

test('summarizer retains tool declarations, retries transient errors, and preserves original user task', async t => {
  const llm = createScriptedProvider([
    { toolCalls: [{ name: 'read', arguments: { path: 'absent' }, id: 'c1' }], usage: { input: 100 } },
    { error: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 } },
    { error: { status: 503, transient: true } },
    { text: 'Completed probe; answer next.' }, { text: '[TASK_COMPLETE]' },
  ]);
  const f = await fixture(t, { llm, compactTokenLimit: 50, retrySeconds: 0.001 });
  assert.equal((await f.start().done).ok, true);
  assert.equal(llm.calls.length, 5);
  assert.equal(llm.calls[1].context.systemPrompt, llm.calls[0].context.systemPrompt);
  assert.ok(llm.calls[1].context.tools.some(tool => tool.name === 'read'));
  assert.equal(textOf(llm.calls[1].context.messages.at(-1)), SUMMARIZATION_PROMPT);
  assert.equal(llm.calls[1].context.messages.length - 1, llm.calls[2].context.messages.length);
  assert.deepEqual(llm.calls[2].context, llm.calls[3].context);
  assert.deepEqual(llm.calls[4].context.messages.map(m => m.role), ['user', 'user']);
  assert.match(textOf(llm.calls[4].context.messages[0]), /task/);
  assert.equal(textOf(llm.calls[4].context.messages[1]), SUMMARY_PREFIX + '\nCompleted probe; answer next.');
});
