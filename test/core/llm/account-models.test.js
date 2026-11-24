import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createCredentials } from '../../../src/core/credentials/index.js';
import { createAuthService } from '../../../src/core/auth.js';
import assert from 'node:assert/strict';
import { createLLM, getModel } from '../../../src/core/llm/index.js';
import { selectModel } from '../../../src/core/agent/model.js';
import { context, sse, google, responses } from './helpers.js';

const credentials = (id, kind, mode) => ({ listAccounts: () => [{ id, kind, mode, status: 'signed_in' }] });
test('Automatic uses account-specific newest models, including Vertex last', () => {
  for (const [id, kind, expected] of [['openai', 'oauth', 'gpt-6.2-sol'], ['openai', 'api_key', 'gpt-6.2-sol'], ['anthropic', 'oauth', 'claude-opus-5-5'], ['google', 'api_key', 'gemini-4-argon'], ['google-antigravity', 'oauth', 'gemini-3.8-flash'], ['google-vertex', 'api_key', 'gemini-4-argon']]) {
    assert.equal(selectModel({}, credentials(id, kind)).id, expected);
  }
  assert.throws(() => selectModel({ provider: 'openai', model: 'gpt-5.3-codex' }, credentials('openai', 'oauth', 'chatgpt')), /ChatGPT.*model/i);
  assert.equal(selectModel({ provider: 'openai', model: 'gpt-5.3-codex' }, credentials('openai', 'api_key')).id, 'gpt-5.3-codex');
});

test('ChatGPT rejects unavailable model without network; newest never sends none reasoning', async () => {
  let calls = 0;
  const llm = createLLM({ resolveAuth: () => ({ type: 'oauth', access: 'fake', mode: 'chatgpt', accountId: 'fake' }), fetcher: async (_url, init) => {
    calls++;
    assert.notEqual(JSON.parse(init.body).reasoning?.effort, 'none');
    return new Response(sse(responses));
  } });
  assert.equal((await llm.complete({ provider: 'openai', model: 'gpt-5.3-codex' }, context)).error.code, 'MODEL_NOT_AVAILABLE');
  assert.equal(calls, 0);
  assert.equal((await llm.complete({ provider: 'openai', model: 'gpt-6.2-sol' }, context)).stopReason, 'toolUse');
  assert.equal(calls, 1);
});

test('model_not_found produces safe actionable permanent error', async () => {
  const llm = createLLM({ fetcher: async () => new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'SECRET account/token' } }), { status: 400 }) });
  const result = await llm.complete({ provider: 'openai', model: 'gpt-5.3-codex' }, context, { auth: { type: 'api_key', key: 'fake' } });
  assert.equal(result.error.code, 'MODEL_NOT_AVAILABLE'); assert.equal(result.error.transient, false);
  assert.match(result.error.message, /select.*model.*account/i); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('Vertex API keys use express-mode resource path and Gemini stream mapping', async () => {
  const m = getModel('google-vertex', 'gemini-4-argon'); assert.ok(m);
  const llm = createLLM({ fetcher: async (url, init) => {
    assert.equal(url, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse');
    assert.equal(init.headers['x-goog-api-key'], 'fake-vertex'); assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body); assert.ok(body.tools[0].functionDeclarations); assert.equal(body.project, undefined);
    return new Response(sse(google));
  } });
  const result = await llm.complete(m, context, { auth: { type: 'api_key', key: 'fake-vertex' } });
  assert.equal(result.stopReason, 'toolUse'); assert.equal(result.content[2].name, 'read'); assert.equal(result.usage.input, 10);
  assert.equal((await llm.complete(m, context, { auth: { type: 'oauth', access: 'fake' } })).error.code, 'AUTH_REQUIRED');
});

test('Antigravity retains fail-closed behavior for observed nonterminal text-only response', async () => {
  const result = await createLLM({ fetcher: async () => new Response(sse([{ response: { candidates: [{ content: { parts: [{ text: 'fixture' }] } }] } }])) }).complete(
    { provider: 'google-antigravity', model: 'gemini-3.8-flash' }, context, { auth: { type: 'oauth', access: 'fake', projectId: 'fake' } });
  assert.equal(result.stopReason, 'error'); assert.equal(result.error.code, 'INCOMPLETE_STREAM'); assert.equal(result.error.transient, true);
});

test('Antigravity newest model routes to the exact advertised thinking variant', async () => {
  for (const [reasoning, wire] of [['off', 'gemini-3.8-flash-low'], ['medium', 'gemini-3.8-flash-medium'], ['high', 'gemini-3.8-flash-high']]) {
    const result = await createLLM({ fetcher: async (_url, init) => {
      const b = JSON.parse(init.body); assert.equal(b.model, wire);
      assert.equal(b.request.generationConfig.thinkingConfig.thinkingLevel, wire.split('-').at(-1).toUpperCase());
      return new Response(sse(google.map(response => ({ response }))));
    } }).complete({ provider: 'google-antigravity', model: 'gemini-3.8-flash' }, context, { reasoning, auth: { type: 'oauth', access: 'fake', projectId: 'fake' } });
    assert.equal(result.stopReason, 'toolUse');
  }
});

for (const [grantKind, mode] of [['direct', undefined], ['codex', 'chatgpt']]) {
  test(`OpenAI ${grantKind} login keeps selection, listing and request routing aligned`, async t => {
    const root = path.resolve('.scratch/llm-review'); fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'account-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { SCRANTON_CREDENTIALS_DIR: dir, PI_CODING_AGENT_DIR: path.join(dir, 'empty-import') };
    const c = await createCredentials({ env, oauth: { openai: { login: async () => ({ type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000, grantKind, ...(mode ? { accountId: 'fake-account' } : {}) }) } } });
    t.after(() => c.close());
    c.startLogin('openai'); assert.equal((await c.waitForLogin()).state, 'done');
    const auth = createAuthService({ env }); t.after(() => auth.close());
    // The synchronous facade must expose the same mode before initialization finishes.
    assert.equal(auth.listAccounts().find(a => a.id === 'openai').mode, mode);
    const listed = (await auth.listModels()).providers.find(p => p.id === 'openai').models;
    assert.equal(listed.some(m => m.id === 'gpt-5.3-codex'), !mode);
    assert.equal(listed.some(m => m.id === 'gpt-6.2-sol'), true);
    assert.equal(auth.listAccounts().find(a => a.id === 'openai').mode, mode);
    assert.equal(c.listAccounts().find(a => a.id === 'openai').mode, mode);
    assert.equal((await c.resolveAuth('openai')).mode, mode);
    assert.equal(selectModel({}, c).id, 'gpt-6.2-sol');
    let selected;
    if (mode) {
      assert.throws(() => selectModel({ provider: 'openai', model: 'gpt-5.3-codex' }, c), /ChatGPT.*model/i);
      selected = selectModel({ provider: 'openai', model: 'gpt-6.2-sol' }, c);
    } else selected = selectModel({ provider: 'openai', model: 'gpt-5.3-codex' }, c);
    let calls = 0;
    const llm = createLLM({ resolveAuth: c.resolveAuth, fetcher: async (url, init) => {
      calls++;
      assert.equal(url, mode ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://api.openai.com/v1/responses');
      assert.equal(init.headers['chatgpt-account-id'], mode ? 'fake-account' : undefined);
      assert.equal(JSON.parse(init.body).model, selected.id);
      return new Response(sse(responses));
    } });
    assert.equal((await llm.complete(selected, context)).stopReason, 'toolUse');
    assert.equal(calls, 1);
    if (mode) {
      assert.equal((await llm.complete({ provider: 'openai', model: 'gpt-5.3-codex' }, context)).error.code, 'MODEL_NOT_AVAILABLE');
      assert.equal(calls, 1);
    }
  });
}
