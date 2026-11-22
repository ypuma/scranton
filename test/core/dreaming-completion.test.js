import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { completeDreaming, validateDreamingRequest, validateDreamingResult } from '../../src/core/dreaming-completion.js';
import { runDreamingCompletion, validateDreamingPayload } from '../../tools/dreaming-complete.js';
import { createCompletionClient } from '../../tools/completion-client.js';
import { createCredentials } from '../../src/core/credentials/index.js';
import { createScriptedProvider } from '../../src/core/llm/index.js';
import { bridgeFixture, invokeBridge } from './bridges-fixture.js';
const root = path.resolve('.scratch/bridges/dreaming');
const request = { model: 'offline/model/with-slash', system: 'System only', user: 'User only' };
test('request has hard bounds and exact identity, never a default model', () => {
  assert.deepEqual(validateDreamingRequest(request).model, { provider: 'offline', model: 'model/with-slash' });
  assert.equal(validateDreamingRequest(request).maxOutputTokens, 2048);
  for (const patch of [{ model: '' }, { model: 'model' }, { model: 'bad name/id' }, { user: '' }, { system: 'x'.repeat(12000) },
    { maxOutputTokens: 255 }, { maxOutputTokens: 4097 }, { maxOutputTokens: 256.1 }, { timeoutMs: 60001 }, { timeoutMs: 0 }]) {
    assert.throws(() => validateDreamingRequest({ ...request, ...patch }), /Invalid dreaming completion request/);
  }
  assert.equal(validateDreamingRequest({ ...request, system: 'x'.repeat(11991) }).system.length, 11991);
});


test('one fresh own LLM request has no tools and includes cache usage without estimated billing', async () => {
  const llm = createScriptedProvider([{ text: 'completion', usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1 } }]);
  let closed = false;
  const result = await runDreamingCompletion(request, { clientFactory: async () => ({ model: {}, llm, close() { closed = true; } }) });
  assert.deepEqual(result, { text: 'completion', usage: { inputTokens: 13, outputTokens: 3 } });
  assert.deepEqual(llm.calls[0].context, { systemPrompt: request.system, messages: [{ role: 'user', content: request.user }], tools: [] });
  assert.equal(closed, true);
});
for (const turn of [{ toolCalls: [{ name: 'bash', arguments: {} }] }, { text: 'partial', stopReason: 'length' }, { text: 'x'.repeat(4097) }, { text: 'error', error: { status: 503 } }, { text: 'tokens', usage: { input: 1, output: 2049 } }]) test('Dreaming fails closed on ' + JSON.stringify(turn).slice(0, 100), async () => {
  await assert.rejects(runDreamingCompletion(request, { clientFactory: async () => ({ model: {}, llm: createScriptedProvider([turn]), close() {} }) }));
});
test('payload validation refuses tools and missing or overridden caps', () => {
  for (const [api, payload] of [['openai-responses', {}], ['openai-completions', { max_tokens: 9999 }], ['anthropic-messages', { max_tokens: 256, tools: [{}] }], ['google-generative', { generationConfig: { maxOutputTokens: 256 }, tools: [{}] }]]) assert.throws(() => validateDreamingPayload(api, payload, 256));
  for (const [api, payload] of [['openai-responses', { max_output_tokens: 256 }], ['anthropic-messages', { max_tokens: 256 }], ['google-generative', { generationConfig: { maxOutputTokens: 256 } }], ['google-antigravity', { request: { generationConfig: { maxOutputTokens: 256 } } }]]) validateDreamingPayload(api, payload, 256);
});
test('own credentials and LLM send the bounded tool-less payload to loopback', async (t) => {
  const f = await bridgeFixture(t);
  const result = await runDreamingCompletion({ ...request, model: 'offline/test', maxOutputTokens: 256 }, { clientFactory: (ref, cap) => createCompletionClient(ref, cap, { credentialsFactory: () => createCredentials({ env: f.env }) }) });
  assert.deepEqual(result, { text: 'completion', usage: { inputTokens: 11, outputTokens: 4 } });
  assert.equal(f.calls[0].tools, undefined); assert.equal(f.calls[0].max_tokens, 256);
});
for (const helper of ['tools/dreaming-complete.js']) test(helper + ' stdin/stdout protocol and byte limit', async (t) => {
  const f = await bridgeFixture(t);
  const result = await invokeBridge(helper, [], f.env, JSON.stringify({ ...request, model: 'offline/test' }));
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { text: 'completion', usage: { inputTokens: 11, outputTokens: 4 } });
  const large = await invokeBridge(helper, [], f.env, ' '.repeat(65537));
  assert.deepEqual(large, { code: 1, stdout: '', stderr: '' });
});
test('wire result rejects additional/tool keys, invalid usage and overlong text', () => {
  for (const result of [{ text: '', usage: null }, { text: 'x'.repeat(4097), usage: null }, { text: 'x', usage: null, tools: [] },
    { text: 'x' }, { text: 'x', usage: { inputTokens: 1, outputTokens: 2049 } },
    { text: 'x', usage: { inputTokens: 1, outputTokens: 1, costUsd: -1 } }]) assert.throws(() => validateDreamingResult(result, 2048));
});

test('bounded subprocess transport and cleanup (offline scripted helper)', async (t) => {
  await fs.mkdir(root, { recursive: true });
  const fixtures = await fs.mkdtemp(path.join(root, 'fixtures-'));
  const dataDir = path.join(fixtures, 'data');
  const fake = path.join(fixtures, 'helper.cjs');
  await fs.writeFile(fake, `const fs = require('node:fs');
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
const r = JSON.parse(input); const out = JSON.stringify({text:'scripted',usage:{inputTokens:5,outputTokens:2}})+'\\n';
if(r.user === 'hang') { require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'}); setInterval(()=>{},1000); return; }
if(r.user === 'stderr') { process.stderr.write('SECRET'.repeat(2000)); return; }
if(r.user === 'frame') { process.stdout.write('x'.repeat(32769)); return; }
if(r.user === 'many') { process.stdout.write(out.repeat(2000)); return; }
if(r.user === 'bad') { process.stdout.write('SECRET\\n'); return; }
if(r.user === 'truncated') { process.stdout.write(out.trim()); return; }
if(r.user === 'exit') { process.stderr.write('SECRET'); process.exitCode=1; return; }
if(r.user === 'utf8') { process.stdout.write(Buffer.from([255,10])); return; }
process.stdout.write(out);
});`);
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=untrusted-workspace-hook';
  t.after(() => { if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions; });
  const original = childProcess.spawn;
  let launches = 0, lastCwd;
  t.mock.method(childProcess, 'spawn', (exe, args, options) => {
    if (!args?.[0]?.endsWith('dreaming-complete.js')) return original(exe, args, options);
    launches++; lastCwd = options.cwd;
    assert.equal(exe, process.execPath);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.shell, undefined);
    assert.equal(path.dirname(options.cwd), dataDir);
    return original(exe, [fake], options);
  });
  try {
    const call = (patch) => completeDreaming({ ...request, dataDir, ...patch });
    assert.deepEqual(await call({}), { text: 'scripted', usage: { inputTokens: 5, outputTokens: 2 } });
    assert.deepEqual(await fs.readdir(dataDir), []);
    for (const user of ['stderr', 'frame', 'many', 'bad', 'truncated', 'exit', 'utf8']) {
      await assert.rejects(call({ user }), { message: 'Dreaming completion failed' });
      assert.deepEqual(await fs.readdir(dataDir), []);
    }
    await assert.rejects(call({ user: 'hang', timeoutMs: 1000 }), { message: 'Dreaming completion timed out' });
    assert.deepEqual(await fs.readdir(dataDir), []);
    const controller = new AbortController();
    const pending = call({ user: 'hang', signal: controller.signal });
    setTimeout(() => controller.abort('SECRET'), 100);
    await assert.rejects(pending, { message: 'Dreaming completion cancelled' });
    assert.deepEqual(await fs.readdir(dataDir), []);
    const before = launches;
    await assert.rejects(call({ signal: AbortSignal.abort('SECRET') }), { message: 'Dreaming completion cancelled' });
    await assert.rejects(call({ maxOutputTokens: 4097 }));
    assert.equal(launches, before);
    assert.equal(await fs.stat(lastCwd).then(() => true, () => false), false);
  } finally { await fs.rm(fixtures, { recursive: true, force: true }); }
});

