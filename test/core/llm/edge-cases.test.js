import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLM, createScriptedProvider, getModel } from '../../../src/core/llm/index.js';
import { cases, model, context, server, sse, authFor } from './helpers.js';

function terminal(api, reason) {
  if (api === 'anthropic-messages') return [{ type: 'message_start', message: { usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: reason === 'length' ? 'max_tokens' : 'end_turn' } }, { type: 'message_stop' }];
  if (api === 'openai-responses') return [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }, { type: 'response.output_text.delta', output_index: 0, delta: 'Answer' }, { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } }, { type: reason === 'length' ? 'response.incomplete' : 'response.completed', response: { status: reason === 'length' ? 'incomplete' : 'completed', incomplete_details: { reason: 'max_output_tokens' } } }];
  if (api === 'openai-completions') return [{ choices: [{ delta: { content: 'Answer' }, finish_reason: reason }] }, '[DONE]'];
  const chunk = { candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: reason === 'length' ? 'MAX_TOKENS' : 'STOP' }] };
  return [api === 'google-antigravity' ? { response: chunk } : chunk];
}

for (const [api] of cases) {
  test(`${api}: stop and output-token limit reasons`, async t => {
    let reason = 'stop';
    const local = await server(t, (_req, res) => res.end(sse(terminal(api, reason))));
    for (reason of ['stop', 'length']) {
      const result = await createLLM().complete(model(api, local.url), { ...context, tools: [] }, { auth: authFor(api) });
      assert.equal(result.stopReason, reason); assert.equal(result.content[0].text, 'Answer');
      const request = local.requests.at(-1).body;
      assert.equal((api === 'google-antigravity' ? request.request : request).tools, undefined);
    }
  });
  test(`${api}: errors inside SSE classify retryable status`, async t => {
    const failure = api === 'anthropic-messages' ? { type: 'error', error: { type: 'overloaded_error' } }
      : api === 'openai-responses' ? { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } }
        : api === 'openai-completions' ? { error: { code: 'rate_limit_exceeded' } } : { error: { code: 503 } };
    const local = await server(t, (_req, res) => res.end(sse([failure])));
    const stream = createLLM().stream(model(api, local.url), context, { auth: authFor(api) });
    const events = await Array.fromAsync(stream);
    assert.equal(events.at(-1).type, 'error'); assert.equal((await stream.result()).error.transient, true);
  });
  test(`${api}: abort after first content delta preserves partial text`, async t => {
    const local = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(terminal(api, 'stop').slice(0, api.startsWith('google') ? 1 : api === 'anthropic-messages' ? 3 : api === 'openai-responses' ? 2 : 1))); });
    const controller = new AbortController();
    const stream = createLLM().stream(model(api, local.url), context, { auth: authFor(api), signal: controller.signal });
    for await (const event of stream) if (event.type === 'text_delta') controller.abort();
    const message = await stream.result();
    assert.equal(message.stopReason, 'aborted'); assert.equal(message.content[0].text, 'Answer');
  });
}

test('completions replays tool calls and errors, including reasoning', async t => {
  const local = await server(t, (_req, res) => res.end(sse(terminal('openai-completions', 'stop'))));
  await createLLM().complete(model('openai-completions', local.url), { ...context, messages: [...context.messages,
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Think' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } }] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'not found' }], isError: true }] }, { auth: authFor('openai-completions') });
  const messages = local.requests[0].body.messages;
  assert.equal(messages[2].reasoning_content, 'Think'); assert.equal(messages[2].tool_calls[0].function.arguments, '{"path":"a"}');
  assert.equal(messages[3].role, 'tool'); assert.equal(messages[3].tool_call_id, 'c1'); assert.equal(messages[3].content, 'not found');
});

test('reasoning unsupported levels clamp; adaptive Claude never sends off as effort', async t => {
  const local = await server(t, (_req, res) => res.end(sse(terminal('anthropic-messages', 'stop'))));
  const m = { ...getModel('anthropic', 'claude-opus-5-5'), baseUrl: local.url };
  await createLLM().complete(m, context, { auth: authFor('anthropic-messages'), reasoning: 'off', temperature: 0.3 });
  assert.equal(local.requests[0].body.thinking.type, 'adaptive'); assert.equal(local.requests[0].body.output_config.effort, 'low'); assert.equal(local.requests[0].body.temperature, undefined);
});

test('Responses default endpoint selection uses direct and subscription paths', async () => {
  const urls = [];
  const llm = createLLM({ fetcher: async (url, options) => { urls.push(url); assert.equal(options.redirect, 'error'); return new Response(sse(terminal('openai-responses', 'stop'))); } });
  const m = getModel('openai', 'gpt-6.2-sol');
  await llm.complete(m, context, { auth: { type: 'oauth', access: 'fake' } });
  await llm.complete(m, context, { auth: { type: 'oauth', access: 'fake', mode: 'chatgpt', accountId: 'account' } });
  await llm.complete(m, context, { auth: { type: 'api_key', key: 'fake' } });
  assert.deepEqual(urls, ['https://api.openai.com/v1/responses', 'https://chatgpt.com/backend-api/codex/responses', 'https://api.openai.com/v1/responses']);
});

test('abort while auth resolver waits does not hang completion', async t => {
  const llm = createLLM({ resolveAuth: () => new Promise(() => {}) });
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 20); t.after(() => clearTimeout(timer));
  const result = await llm.complete(model('openai-responses', 'http://127.0.0.1'), context, { signal: c.signal });
  assert.equal(result.stopReason, 'aborted');
});

test('consumer break and return-before-start settle result as aborted', async () => {
  const p = createScriptedProvider([{ text: 'hello world', chunkSize: 1 }, { text: 'unused' }]);
  const stream = p.stream(model('scripted', 'unused'), context);
  for await (const event of stream) { if (event.type === 'text_delta') break; }
  assert.equal((await stream.result()).stopReason, 'aborted');
  const second = p.stream(model('scripted', 'unused'), context); await second.return();
  assert.equal((await second.result()).stopReason, 'aborted');
});

test('provider-specific reasoning is never replayed to another provider/model', async t => {
  const local = await server(t, (_req, res) => res.end(sse(terminal('anthropic-messages', 'stop'))));
  const foreign = { role: 'assistant', provider: 'other', model: 'other', content: [{ type: 'thinking', thinking: 'private', thinkingSignature: 'foreign', providerItem: { type: 'reasoning', encrypted_content: 'foreign' } }, { type: 'text', text: 'visible' }] };
  await createLLM().complete(model('anthropic-messages', local.url), { ...context, messages: [...context.messages, foreign] }, { auth: authFor('anthropic-messages') });
  assert.equal(local.requests[0].body.messages[1].content.some(b => b.type === 'thinking'), false);
  const responsesServer = await server(t, (_req, res) => res.end(sse(terminal('openai-responses', 'stop'))));
  await createLLM().complete(model('openai-responses', responsesServer.url), { ...context, messages: [...context.messages, foreign] }, { auth: authFor('openai-responses') });
  assert.equal(responsesServer.requests[0].body.input.some(b => b.type === 'reasoning'), false);
});

test('scripted turn IDs are stable when streams are consumed out of order', async () => {
  const p = createScriptedProvider([{ toolCalls: [{ name: 'read', arguments: {} }] }, { toolCalls: [{ name: 'read', arguments: {} }] }]);
  const first = p.stream(model('scripted', 'unused'), context), second = p.stream(model('scripted', 'unused'), context);
  assert.equal((await second.result()).content[0].id, 'script-2-0');
  assert.equal((await first.result()).content[0].id, 'script-1-0');
});
