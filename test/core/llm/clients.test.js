import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLM } from '../../../src/core/llm/index.js';
import { cases, context, model, server, sse, authFor, anthropic, responses, google } from './helpers.js';

for (const [api, fixture] of cases) {
  test(`${api}: request shape, mapping, usage and tool JSON`, async t => {
    const local = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(fixture)); });
    let resolved = 0;
    const llm = createLLM({ resolveAuth: id => { assert.equal(id, api === 'google-antigravity' ? api : 'test'); resolved++; return authFor(api); } });
    const stream = llm.stream(model(api, local.url), context, { maxTokens: 3000, temperature: 0.2, reasoning: 'low' });
    const events = await Array.fromAsync(stream), result = await stream.result();
    assert.equal(resolved, 1);
    assert.equal(result.stopReason, 'toolUse', JSON.stringify(result));
    assert.equal(result.content[0].thinking, 'Think'); assert.equal(result.content[1].text, 'Hello');
    assert.deepEqual(result.content[2].arguments, { path: 'file' });
    assert.equal(result.content[2].name, 'read');
    assert.equal(result.usage.input, 10); assert.equal(result.usage.output, 5); assert.equal(result.usage.cacheRead, 3);
    assert.equal(result.usage.cacheWrite, api === 'anthropic-messages' ? 2 : 0);
    assert.ok(result.usage.cost.total > 0);
    for (const type of ['start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done']) assert.ok(events.some(e => e.type === type), type);
    assert.deepEqual(events.find(e => e.type === 'toolcall_delta').partial.content[2].arguments, {});
    const r = local.requests[0];
    assert.equal(r.headers['content-type'], 'application/json'); assert.equal(r.headers.accept, 'text/event-stream');
    if (api === 'anthropic-messages') {
      assert.equal(r.url, '/v1/messages'); assert.equal(r.headers['x-api-key'], 'fake-key'); assert.equal(r.headers['anthropic-version'], '2023-06-01');
      assert.deepEqual(r.body.tools[0].input_schema, context.tools[0].parameters); assert.equal(r.body.thinking.type, 'enabled'); assert.equal(r.body.temperature, undefined);
      assert.equal(r.body.system[0].text, context.systemPrompt);
    } else if (api === 'openai-responses') {
      assert.equal(r.url, '/responses'); assert.equal(r.headers.authorization, 'Bearer fake-key'); assert.equal(r.body.max_output_tokens, 3000);
      assert.equal(r.body.input[0].role, 'developer'); assert.equal(r.body.reasoning.effort, 'low'); assert.equal(r.body.store, false);
      assert.deepEqual(r.body.tools[0].parameters, context.tools[0].parameters);
    } else if (api === 'openai-completions') {
      assert.equal(r.url, '/chat/completions'); assert.equal(r.body.max_tokens, 3000); assert.equal(r.body.messages[0].role, 'system'); assert.equal(r.body.reasoning_effort, 'low');
      assert.deepEqual(r.body.tools[0].function.parameters, context.tools[0].parameters);
    } else {
      const body = api === 'google-antigravity' ? r.body.request : r.body;
      assert.equal(body.generationConfig.maxOutputTokens, 3000); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
      assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema, context.tools[0].parameters);
      assert.equal(body.systemInstruction.parts[0].text, context.systemPrompt);
      if (api === 'google-antigravity') { assert.equal(r.url, '/v1internal:streamGenerateContent?alt=sse'); assert.equal(r.headers.authorization, 'Bearer fake-access'); assert.equal(r.body.project, 'fake-project'); assert.equal(r.body.model, 'gemini-3-pro-low'); assert.match(r.body.request.sessionId, /^scranton-/); }
      else { assert.equal(r.url, '/models/gemini-3-pro:streamGenerateContent?alt=sse'); assert.equal(r.headers['x-goog-api-key'], 'fake-key'); }
    }
  });
  test(`${api}: HTTP classification and no credential/error body leakage`, async t => {
    let status = 401;
    const local = await server(t, (_req, res) => { res.writeHead(status); res.end('fake-key SECRET RESPONSE'); });
    const llm = createLLM({ resolveAuth: () => authFor(api) });
    for (status of [400, 401, 403, 429, 503]) {
      const result = await llm.complete(model(api, local.url), context);
      assert.equal(result.stopReason, 'error'); assert.equal(result.error.status, status); assert.equal(result.error.transient, status >= 429);
      assert.doesNotMatch(JSON.stringify(result), /fake-key|SECRET RESPONSE/);
    }
  });
  test(`${api}: caller abort and timeout cancel a pending response`, async t => {
    const local = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); });
    const llm = createLLM({ resolveAuth: () => authFor(api) });
    const controller = new AbortController();
    const stream = llm.stream(model(api, local.url), context, { signal: controller.signal });
    const result = stream.result();
    const timer = setTimeout(() => controller.abort(), 30); t.after(() => clearTimeout(timer));
    assert.equal((await result).stopReason, 'aborted');
    const timed = await llm.complete(model(api, local.url), context, { timeoutMs: 30 });
    assert.equal(timed.stopReason, 'error'); assert.equal(timed.error.transient, true);
  });
  test(`${api}: truncated streams fail closed`, async t => {
    const local = await server(t, (_req, res) => { res.end(sse(fixture.slice(0, 1))); });
    const result = await createLLM().complete(model(api, local.url), context, { auth: authFor(api) });
    assert.equal(result.stopReason, 'error'); assert.equal(result.error.transient, false);
  });
}

test('Anthropic subscription identity, tool casing, history and signatures', async t => {
  const local = await server(t, (_req, res) => res.end(sse(anthropic)));
  const llm = createLLM({ resolveAuth: () => ({ type: 'oauth', access: 'fake-oauth' }) });
  const m = model('anthropic-messages', local.url);
  const first = await llm.complete(m, context, { reasoning: 'high' });
  assert.equal(first.content[0].thinkingSignature, 'sig');
  await llm.complete(m, { ...context, messages: [...context.messages, first, { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: 'missing', isError: true }] });
  const r = local.requests[1];
  assert.equal(r.headers.authorization, 'Bearer fake-oauth'); assert.equal(r.headers['x-api-key'], undefined);
  assert.equal(r.headers['user-agent'], 'claude-cli/2.1.322'); assert.equal(r.headers['x-app'], 'cli');
  assert.match(r.headers['anthropic-beta'], /oauth-2025-04-20/);
  assert.equal(r.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(r.body.system[1].text, context.systemPrompt); assert.equal(r.body.tools[0].name, 'Read');
  assert.equal(r.body.messages[1].content[0].signature, 'sig'); assert.equal(r.body.messages[1].content[2].name, 'Read');
  assert.equal(r.body.messages[2].content[0].is_error, true);
});

for (const mode of ['direct', 'chatgpt']) test(`OpenAI subscription ${mode} shape and reasoning replay`, async t => {
  const local = await server(t, (_req, res) => res.end(sse(responses)));
  const llm = createLLM({ resolveAuth: () => ({ type: 'oauth', access: 'fake-oauth', mode, accountId: 'account-1' }) });
  const m = model('openai-responses', local.url);
  const first = await llm.complete(m, context);
  await llm.complete(m, { ...context, messages: [...context.messages, first, { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: 'result' }] }, { temperature: 0.7, maxTokens: 4000 });
  const r = local.requests[1];
  assert.equal(r.url, mode === 'direct' ? '/responses' : '/codex/responses'); assert.equal(r.headers.authorization, 'Bearer fake-oauth');
  assert.equal(r.body.max_output_tokens, undefined); assert.equal(r.body.temperature, undefined);
  assert.ok(r.body.input.some(item => item.encrypted_content === 'sig'));
  assert.ok(r.body.input.some(item => item.type === 'function_call_output' && item.call_id === 'call-1'));
  if (mode === 'chatgpt') { assert.equal(r.headers['chatgpt-account-id'], 'account-1'); assert.equal(r.headers['openai-beta'], 'responses=experimental'); assert.equal(r.headers.originator, 'scranton'); assert.equal(r.body.instructions, context.systemPrompt); }
  else assert.equal(r.headers['chatgpt-account-id'], undefined);
});

test('Google preserves thinking/text/tool signatures in history and tool results', async t => {
  const fixture = structuredClone(google); fixture[0].candidates[0].content.parts[1].thoughtSignature = 'text-sig';
  const local = await server(t, (_req, res) => res.end(sse(fixture)));
  const llm = createLLM({ resolveAuth: () => ({ type: 'api_key', key: 'fake' }) }); const m = model('google-generative', local.url);
  const first = await llm.complete(m, context);
  await llm.complete(m, { ...context, messages: [...context.messages, first, { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: 'no', isError: true }] });
  const contents = local.requests[1].body.contents;
  assert.deepEqual(contents[1].parts.map(p => p.thoughtSignature), ['sig', 'text-sig', 'call-sig']);
  assert.equal(contents[2].parts[0].functionResponse.response.error, 'no');
});

test('malformed tool arguments are never returned as executable toolUse', async t => {
  const fixture = structuredClone(responses); fixture[7].delta = 'not-json'; fixture[8].delta = '';
  const local = await server(t, (_req, res) => res.end(sse(fixture)));
  const result = await createLLM().complete(model('openai-responses', local.url), context, { auth: { type: 'api_key', key: 'fake' } });
  assert.equal(result.stopReason, 'error'); assert.deepEqual(result.content[2].arguments, {});
});

test('missing auth and unsupported APIs fail without network; explicit auth bypasses resolver', async () => {
  let fetched = false;
  const llm = createLLM({ fetcher: () => { fetched = true; throw new TypeError('network'); } });
  const m = model('openai-completions', 'http://127.0.0.1');
  assert.equal((await llm.complete(m, context)).error.code, 'AUTH_REQUIRED'); assert.equal(fetched, false);
  assert.equal((await llm.complete({ ...m, api: 'invalid' }, context)).stopReason, 'error'); assert.equal(fetched, false);
  assert.equal((await llm.complete(m, context, { auth: { type: 'api_key', key: 'fake' } })).error.transient, true); assert.equal(fetched, true);
});
