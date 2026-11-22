import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLM, classifyError } from '../../../src/core/llm/index.js';
import { cases, context, model, authFor, sse } from './helpers.js';

for (const [api] of cases) test(`${api}: HTTP 400 overflow bodies are permanent and redacted`, async () => {
  const bodies = [
    { error: { type: 'invalid_request_error', message: 'prompt is too long: SECRET' } },
    { error: { code: 'context_length_exceeded', message: 'SECRET' } },
    { error: { message: 'The input token count exceeds the maximum number of tokens allowed. SECRET' } },
    { error: { message: "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens. SECRET" } },
    { error: { message: 'Context window exceeded SECRET' } },
    { error: { message: 'Requested tokens exceed context window SECRET' } },
    { error: { message: 'Invalid temperature SECRET' } },
  ];
  for (const [index, body] of bodies.entries()) {
    let calls = 0;
    const llm = createLLM({ fetcher: async () => { calls++; return new Response(JSON.stringify(body), { status: 400 }); } });
    const result = await llm.complete(model(api, 'https://provider.invalid'), context, { auth: authFor(api) });
    assert.equal(result.error.code, index === bodies.length - 1 ? 'PROVIDER_ERROR' : 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(result.error.transient, false);
    assert.equal(result.error.status, 400);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|temperature|4096/);
  }
});

test('HTTP 413 and explicit overflow codes classify permanently', async () => {
  assert.equal(classifyError({ code: 'CONTEXT_WINDOW_EXCEEDED', status: 503 }).transient, false);
  const result = await createLLM({ fetcher: async () => new Response('SECRET', { status: 413 }) })
    .complete(model('openai-completions', 'https://provider.invalid'), context, { auth: authFor('openai-completions') });
  assert.equal(result.error.code, 'CONTEXT_WINDOW_EXCEEDED');
});

for (const api of ['google-generative', 'google-antigravity']) test(`${api}: missing tool IDs are unique across conversation turns`, async () => {
  const chunk = { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: {} } }, { functionCall: { name: 'read', args: {} } }] }, finishReason: 'STOP' }] };
  const llm = createLLM({ fetcher: async () => new Response(sse([api === 'google-antigravity' ? { response: chunk } : chunk])) });
  const first = await llm.complete(model(api, 'https://provider.invalid'), context, { auth: authFor(api) });
  const second = await llm.complete(model(api, 'https://provider.invalid'), { ...context, messages: [...context.messages, first] }, { auth: authFor(api) });
  const ids = [...first.content, ...second.content].map(block => block.id);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^google-call-[0-9a-f-]{36}$/);
});

test('HTTP error inspection is bounded and cancels the unread remainder', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65536))); },
    cancel() { cancelled = true; },
  });
  const llm = createLLM({ fetcher: async () => new Response(body, { status: 400 }) });
  const result = await llm.complete(model('openai-completions', 'https://provider.invalid'), context, { auth: authFor('openai-completions') });
  assert.equal(result.error.code, 'PROVIDER_ERROR');
  assert.equal(result.error.transient, false);
  assert.equal(cancelled, true);
});
