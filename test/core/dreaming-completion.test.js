import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { completeDreaming, validateDreamingRequest, validateDreamingResult } from '../../src/core/dreaming-completion.js';
import { runDreamingCompletion, validateDreamingPayload } from '../../tools/dreaming-pi-complete.js';

const root = path.resolve('.scratch/claude-dream-completion');
const request = { model: 'offline/model/with-slash', system: 'System only', user: 'User only' };
const message = (overrides = {}) => ({ role: 'assistant', content: [{ type: 'text', text: 'completion' }], stopReason: 'stop',
  usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.12 } }, ...overrides });
function runtime(events, observe = () => {}) {
  return { getError: () => undefined, getModel: () => ({ api: 'openai-completions', id: 'model/with-slash', provider: 'offline', samplingParams: { tools: ['bad'] } }),
    streamSimple(model, context, options) {
      observe(model, context, options);
      options.onPayload({ max_tokens: options.maxTokens });
      return (async function* () { for (const event of events) yield event; })();
    } };
}
const events = (m) => [{ type: 'start', partial: message({ content: [], stopReason: 'pending' }) }, { type: 'done', reason: 'stop', message: m }];

test('request has hard bounds and exact identity, never a default model', () => {
  assert.deepEqual(validateDreamingRequest(request).model, { provider: 'offline', model: 'model/with-slash' });
  assert.equal(validateDreamingRequest(request).maxOutputTokens, 2048);
  for (const patch of [{ model: '' }, { model: 'model' }, { model: 'bad name/id' }, { user: '' }, { system: 'x'.repeat(12000) },
    { maxOutputTokens: 255 }, { maxOutputTokens: 4097 }, { maxOutputTokens: 256.1 }, { timeoutMs: 60001 }, { timeoutMs: 0 }]) {
    assert.throws(() => validateDreamingRequest({ ...request, ...patch }), /Invalid dreaming completion request/);
  }
  assert.equal(validateDreamingRequest({ ...request, system: 'x'.repeat(11991) }).system.length, 11991);
});

test('one fresh SDK request, no tool declarations, no sampling payload overrides, actual usage only', async () => {
  let calls = 0, signal;
  const result = await runDreamingCompletion(request, { runtimeFactory: async () => runtime(events(message()), (model, context, options) => {
    calls++;
    assert.equal(model.samplingParams, undefined);
    assert.equal(model.samplingParamsByThinkingLevel, undefined);
    assert.deepEqual(context.tools, []);
    assert.equal(context.systemPrompt, request.system);
    assert.deepEqual(context.messages.map(({ role, content }) => ({ role, content })), [{ role: 'user', content: request.user }]);
    assert.equal(options.maxTokens, 2048);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.toolChoice, 'none');
    assert.equal(options.sessionId, undefined);
    signal = options.signal;
  }) });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(result, { text: 'completion', usage: { inputTokens: 13, outputTokens: 3 } });
  const billed = message(); billed.usage.cost.totalFromProvider = true;
  assert.equal((await runDreamingCompletion(request, { runtimeFactory: async () => runtime(events(billed)) })).usage.costUsd, 0.12);
  for (const usage of [undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: -1, output: 2 }]) {
    assert.equal((await runDreamingCompletion(request, { runtimeFactory: async () => runtime(events(message({ usage }))) })).usage, null);
  }
});

test('SDK rejects tool events, hidden tool blocks, malformed, incomplete, oversized and excess-token responses', async () => {
  for (const sequence of [[], [{ type: 'done', reason: 'stop', message: message() }],
    [events(message())[0], ...events(message())], [{ type: 'toolcall_start', partial: message() }],
    events(message({ content: [{ type: 'toolCall', name: 'bash', arguments: {} }] })),
    events(message({ content: [{ type: 'image' }] })), events(message({ content: [{ type: 'text', text: 'x'.repeat(4097) }] })),
    events(message({ stopReason: 'length' })), events(message({ usage: { input: 1, output: 2049, cacheRead: 0, cacheWrite: 0 } })),
    [...events(message()), ...events(message())], [{ type: 'error', error: { errorMessage: 'SECRET' } }]]) {
    await assert.rejects(runDreamingCompletion(request, { runtimeFactory: async () => runtime(sequence) }));
  }
});

test('payload caps fail closed for unsupported ChatGPT subscription mode and overrides', () => {
  for (const [api, payload] of [['openai-responses', {}], ['openai-completions', { max_tokens: 9999 }],
    ['openai-completions', { max_tokens: 256, max_completion_tokens: 9999 }], ['unknown', { max_tokens: 256 }],
    ['anthropic-messages', { max_tokens: 256, tools: [{ name: 'bash' }] }]]) {
    assert.throws(() => validateDreamingPayload(api, payload, 256));
  }
  for (const [api, payload] of [['openai-responses', { max_output_tokens: 256 }], ['anthropic-messages', { max_tokens: 256 }],
    ['google-generative-ai', { config: { maxOutputTokens: 256 } }], ['bedrock-converse-stream', { inferenceConfig: { maxTokens: 256 } }]]) {
    validateDreamingPayload(api, payload, 256);
  }
});

test('Google Antigravity without onPayload is rejected before runtime or inference begins', async () => {
  let runtimes = 0, calls = 0;
  const fixture = {
    registerNativeProvider() {},
    getError: () => undefined,
    getModel: () => ({ api: 'google-generative-ai', id: 'gemini-3-flash', provider: 'google-antigravity' }),
    streamSimple() {
      calls++;
      return (async function* () { for (const event of events(message())) yield event; })();
    }
  };
  const result = await runDreamingCompletion({ ...request, model: 'google-antigravity/gemini-3-flash' }, {
    runtimeFactory: async () => { runtimes++; return fixture; }
  }).then(() => 'completed', () => 'rejected');
  assert.equal(calls, 0, 'no inference call may begin without pre-send payload validation');
  assert.equal(runtimes, 0, 'unsupported transport is rejected before runtime creation');
  assert.equal(result, 'rejected');
});

test('supported API transports require and accept bounded tool-less payload callbacks', async () => {
  for (const [api, payload] of [
    ['anthropic-messages', { max_tokens: 256 }],
    ['openai-completions', { max_completion_tokens: 256 }],
    ['openai-responses', { max_output_tokens: 256 }],
    ['azure-openai-responses', { max_output_tokens: 256 }],
    ['google-generative-ai', { config: { maxOutputTokens: 256 } }],
    ['google-vertex', { config: { maxOutputTokens: 256 } }],
    ['bedrock-converse-stream', { inferenceConfig: { maxTokens: 256 } }]
  ]) {
    for (const callback of [true, false]) {
      const fixture = runtime(events(message()));
      fixture.getModel = () => ({ api, id: 'model/with-slash', provider: 'offline' });
      fixture.streamSimple = (model, context, options) => {
        if (callback) options.onPayload(payload);
        return (async function* () { for (const event of events(message())) yield event; })();
      };
      const completion = runDreamingCompletion({ ...request, maxOutputTokens: 256 }, { runtimeFactory: async () => fixture });
      if (callback) assert.equal((await completion).text, 'completion', api);
      else await assert.rejects(completion, undefined, api);
    }
  }
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
    if (!args?.[0]?.endsWith('dreaming-pi-complete.js')) return original(exe, args, options);
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

test('installed Pi SDK resolves stored custom provider/auth and sends the real bounded tool-less payload (fake fetch)', async () => {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'sdk-'));
  try {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ offline: { type: 'api_key', key: 'offline-not-a-secret' } }));
    await fs.writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: { offline: { baseUrl: 'https://offline.invalid/v1',
      api: 'openai-completions', models: [{ id: 'model/with-slash', contextWindow: 16000, maxTokens: 4096 }] } } }));
    const r = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: path.join(dir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    let requests = 0;
    const streamSimple = r.streamSimple.bind(r);
    r.streamSimple = (model, context, options) => streamSimple(model, context, { ...options, fetch: async (url, init) => {
      requests++;
      assert.equal(String(url), 'https://offline.invalid/v1/chat/completions');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer offline-not-a-secret');
      const payload = JSON.parse(init.body);
      assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 256);
      assert.equal(payload.tool_choice, 'none');
      assert.equal(payload.tools, undefined);
      assert.deepEqual(payload.messages.map(({ role, content }) => ({ role, content })), [
        { role: 'system', content: request.system }, { role: 'user', content: request.user }
      ]);
      const chunk = { id: 'offline', object: 'chat.completion.chunk', model: model.id,
        choices: [{ index: 0, delta: { content: 'Offline SDK answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } };
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } });
    const result = await runDreamingCompletion({ ...request, maxOutputTokens: 256 }, { runtimeFactory: async () => r });
    assert.equal(requests, 1);
    assert.deepEqual(result, { text: 'Offline SDK answer', usage: { inputTokens: 11, outputTokens: 4 } });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
