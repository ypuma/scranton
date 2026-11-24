import '../isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, createLLM } from '../../../src/core/llm/index.js';
import { model, context, authFor, sse } from './helpers.js';

export const failure = (api, code, message = 'Try again') => api === 'openai-responses' ? { type: 'error', code, message }
  : api === 'anthropic-messages' ? { type: 'error', error: { type: code, message } }
    : { error: { code, message } };
const apis = ['openai-responses', 'anthropic-messages', 'openai-completions', 'google-generative', 'google-vertex', 'google-antigravity'];
for (const api of apis) test(`${api}: stream error codes, bounded redaction and early EOF`, async () => {
  let events;
  const llm = createLLM({ resolveAuth: () => authFor(api), fetcher: async () => new Response(sse(events)) });
  for (const [code, transient, normalized = code ?? 'unknown'] of [
    ['server_error', true], ['api_error', true], ['overloaded_error', true], ['rate_limit_exceeded', true],
    ['concurrency_limit_exceeded', true], ['unavailable', true], ['timeout', true], [undefined, true], ['new_provider_code', true],
    ['context_length_exceeded', false, 'CONTEXT_WINDOW_EXCEEDED'], ['insufficient_quota', false],
    ['usage_limit_reached', false], ['billing_error', false], ['invalid_request_error', false], ['content_policy_violation', false],
    ['authentication_error', false], ['request_too_large', false], ['permission_error', false], ['not_found_error', false],
    ['FAILED_PRECONDITION', false], ['INVALID_ARGUMENT', false], ['PERMISSION_DENIED', false], ['UNAUTHENTICATED', false], ['NOT_FOUND', false],
    ['UNAVAILABLE', true], ['INTERNAL', true], ['DEADLINE_EXCEEDED', true], ['RESOURCE_EXHAUSTED', true],
  ]) {
    events = [failure(api, code, `Try again ${authFor(api).key ?? authFor(api).access}\nAuthorization: Bearer hidden ${'x'.repeat(300)}`)];
    const result = await llm.complete(model(api, 'https://example.test'), context);
    assert.equal(result.error.transient, transient, String(code));
    assert.equal(result.error.code, normalized);
    assert.equal(classifyError(result.error).transient, transient);
    assert.doesNotMatch(result.errorMessage, /fake-key|fake-access|hidden|\n/);
    assert.ok(result.errorMessage.length < 280);
    if (normalized !== 'CONTEXT_WINDOW_EXCEEDED') assert.match(result.errorMessage, /Provider stream error/);
  }
  if (api === 'google-antigravity') {
    events = [{ response: { error: { status: 'UNAVAILABLE', code: 503, message: 'Busy' } } }];
    assert.equal((await llm.complete(model(api, 'https://example.test'), context)).error.code, 'UNAVAILABLE');
  }
  events = [];
  assert.equal((await llm.complete(model(api, 'https://example.test'), context)).error.transient, true);
});
test('Responses response.failed retains nested reason; malformed data names the check', async () => {
  let events = [{ type: 'response.failed', response: { error: { code: 'server_error', message: 'Temporarily unavailable' } } }];
  const llm = createLLM({ fetcher: async () => new Response(sse(events)), resolveAuth: () => authFor('openai-responses') });
  const m = model('openai-responses', 'https://example.test');
  for (const [code, transient] of [['server_error', true], ['rate_limit_exceeded', true], ['usage_limit_reached', false], ['context_length_exceeded', false]]) {
    events[0].response.error.code = code;
    const result = await llm.complete(m, context);
    assert.equal(result.error.transient, transient);
    if (code !== 'context_length_exceeded') assert.match(result.errorMessage, new RegExp(`${code}.*Temporarily unavailable`));
  }
  events = [{ type: 'response.failed', response: {} }];
  const missing = await llm.complete(m, context);
  assert.equal(missing.error.code, 'unknown'); assert.equal(missing.error.transient, true);
  events = [{ type: 'response.output_item.added', item: { type: 'unknown' } }];
  const result = await llm.complete(m, context);
  assert.equal(result.error.transient, false);
  assert.equal(result.errorMessage, 'Provider stream is invalid: Unsupported Responses item');
});

test('SSE truncation retries, invalid JSON stays permanent and diagnostics mask environment secrets', async t => {
  const secret = 'fixture-stream-env-90210';
  const previous = process.env.STREAM_FIXTURE_SECRET; process.env.STREAM_FIXTURE_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.STREAM_FIXTURE_SECRET; else process.env.STREAM_FIXTURE_SECRET = previous; });
  let body = 'data: {"type":"error"';
  const llm = createLLM({ fetcher: async () => new Response(body), resolveAuth: () => authFor('openai-responses') });
  const m = model('openai-responses', 'https://example.test');
  assert.equal((await llm.complete(m, context)).error.transient, true);
  body = 'data: not-json\n\n';
  const invalid = await llm.complete(m, context);
  assert.equal(invalid.error.transient, false); assert.match(invalid.errorMessage, /Invalid SSE JSON/);
  body = new Uint8Array([0xff]);
  const invalidUtf8 = await llm.complete(m, context);
  assert.equal(invalidUtf8.error.transient, false); assert.match(invalidUtf8.errorMessage, /Invalid SSE UTF-8/);
  body = sse([{ type: 'error', code: 'server_error', message: `remote: ${secret}` }]);
  const result = await llm.complete(m, context);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret)); assert.match(result.errorMessage, /redacted/);
});
