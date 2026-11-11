import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startAntigravityBroker } from '../../src/core/antigravity/broker.js';
import { antigravityProvider } from '../../src/core/antigravity/provider.js';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { prepareSandbox } from '../../src/core/sandbox.js';

const authKey = (n = 1) => JSON.stringify({ token: `HOST_ACCESS_${n}`, projectId: 'synthetic-project' });
const sse = (...parts) => new Response(parts.map((response) => `data: ${JSON.stringify({ response })}\n\n`).join(''));
const done = (parts) => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }] });
const context = () => normalizeContext({ systemPrompt: 'system', tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }], messages: [{ role: 'user', content: 'hello', timestamp: 123 }] });
const post = (broker, value, capability = broker.capability, route = '/inference') => fetch(`http://127.0.0.1:${broker.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` }, body: JSON.stringify(value) });
const body = () => ({ model: 'gemini-3-pro', context: context(), options: {} });

test('host broker checks capability, model, route, bounds and per-request auth; preserves tool/signature replay', async (t) => {
  let renewals = 0, requests = [];
  const provider = antigravityProvider({ fetcher: async (url, init) => {
    requests.push(JSON.parse(init.body)); assert.match(url, /^https:\/\/daily-cloudcode-pa.googleapis.com\/v1internal:streamGenerateContent\?alt=sse$/);
    assert.equal(init.headers.Authorization, `Bearer HOST_ACCESS_${renewals}`);
    return renewals === 1 ? sse(done([{ functionCall: { name: 'read', args: { path: '/workspace/fixture.txt' } }, thoughtSignature: 'dG9vbC1zaWduYXR1cmU=' }])) : sse(done([{ text: 'DEV_' }, { text: 'DONE' }]));
  } });
  const broker = await startAntigravityBroker({ host: '127.0.0.1', provider, auth: { mintAccessToken: async (id, options) => { assert.equal(id, 'google-antigravity'); assert.equal(options.minExpiryMs, 60000); return authKey(++renewals); } } });
  t.after(() => broker.close());
  assert.equal((await post(broker, body(), 'wrong')).status, 403);
  assert.equal((await post(broker, body(), broker.capability, '/wrong')).status, 400);
  for (const value of [{ ...body(), model: 'unknown' }, { ...body(), url: 'http://evil' }, { ...body(), options: { apiKey: 'evil' } }, { ...body(), options: { maxTokens: 999999 } }, { ...body(), context: { messages: [], systemPrompt: 'x' } }]) assert.equal((await post(broker, value)).status, 400);
  assert.equal((await post(broker, { ...body(), context: { messages: [{ role: 'user', content: 'a'.repeat(16 * 1024 * 1024) }] } })).status, 400);
  assert.equal(renewals, 0);
  const first = await (await post(broker, body())).text();
  const message = first.trim().split('\n').map(JSON.parse).at(-1).message;
  assert.equal(message.stopReason, 'toolUse'); assert.equal(message.content[0].thoughtSignature, 'dG9vbC1zaWduYXR1cmU=');
  const next = body(); next.context.messages.push(message, { role: 'toolResult', toolCallId: message.content[0].id, toolName: 'read', content: [{ type: 'text', text: 'fixture' }], isError: false, timestamp: 124 });
  const second = await (await post(broker, next)).text(); assert.equal(renewals, 2);
  assert.equal(JSON.parse(second.trim().split('\n').at(-1)).message.content[0].text, 'DEV_DONE');
  assert.equal(requests[0].model, 'gemini-3-pro-low');
  assert.equal(requests[0].request.tools[0].functionDeclarations[0].name, 'read');
  assert.ok(requests[1].request.contents.some((c) => c.parts.some((p) => p.functionCall && p.thoughtSignature === 'dG9vbC1zaWduYXR1cmU=')));
  assert.ok(requests[1].request.contents.some((c) => c.parts.some((p) => p.functionResponse)));
  assert.doesNotMatch(first + second, /HOST_ACCESS|REFRESH|client_secret/);
  await broker.close(); await assert.rejects(post(broker, body()));
});

test('brokers have isolated capabilities, refuse missing auth, expire and abort live streams on cleanup', async (t) => {
  const provider = antigravityProvider({ fetcher: async () => { throw Error('secret diagnostics'); } });
  const a = await startAntigravityBroker({ host: '127.0.0.1', provider, auth: { mintAccessToken: async () => { throw Error('REFRESH_SECRET'); } } });
  const b = await startAntigravityBroker({ host: '127.0.0.1', provider, auth: { mintAccessToken: async () => authKey() } });
  t.after(async () => { await a.close(); await b.close(); });
  assert.equal((await post(b, body(), a.capability)).status, 403);
  const denied = await post(a, body()); assert.equal(denied.status, 401); assert.doesNotMatch(await denied.text(), /REFRESH_SECRET/);
  const expired = await startAntigravityBroker({ host: '127.0.0.1', provider, auth: {}, lifetimeMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 40)); await assert.rejects(post(expired, body())); await expired.close();
  let started, aborted; const ready = new Promise((resolve) => { started = resolve; }); const stopped = new Promise((resolve) => { aborted = resolve; });
  const live = await startAntigravityBroker({ host: '127.0.0.1', auth: { mintAccessToken: async () => authKey() }, provider: antigravityProvider({ fetcher: async (_url, init) => { started(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted(); reject(Error()); }, { once: true })); } }) });
  const pending = post(live, body()).catch(() => {}); await ready; await live.close(); await stopped; await pending;
});

test('host stream chunks coalesce with signature retention, tier mapping and nonzero session identity', async () => {
  let tier;
  const p = antigravityProvider({ fetcher: async (_url, init) => { tier = JSON.parse(init.body); return sse({ candidates: [{ content: { parts: [{ text: '{"x":"DEV_' }] } }] }, done([{ text: 'DONE"}', thoughtSignature: 'last-signature' }])); } });
  const model = p.getModels()[0]; model.thinkingLevelMap.medium = 'low';
  const stream = p.streamSimple(model, context(), { apiKey: authKey(), reasoning: 'medium' });
  const events = []; for await (const event of stream) events.push(event.type);
  const result = await stream.result(); assert.equal(result.content.length, 1); assert.deepEqual(JSON.parse(result.content[0].text), { x: 'DEV_DONE' }); assert.equal(result.content[0].textSignature, 'last-signature');
  assert.equal(events.filter((e) => e === 'text_start').length, 1); assert.equal(events.filter((e) => e === 'text_end').length, 1);
  assert.equal(tier.model, 'gemini-3-pro-low'); assert.equal(tier.request.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.notEqual(tier.request.sessionId, 'scranton-0');
});

test('sandbox mounts only credential-free extension, scopes env and revokes broker idempotently', async (t) => {
  const root = path.resolve('.scratch/antigravity-backend/tests'); fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'docker-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'work'), sessionDir = path.join(dir, 'session'); fs.mkdirSync(workspace); fs.mkdirSync(sessionDir); fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: private'); const prompt = path.join(dir, 'prompt'); fs.writeFileSync(prompt, 'system');
  let closed = 0;
  const execution = await prepareSandbox({ provider: 'google-antigravity', sandbox: { mode: 'docker' }, workspace, sessionDir, systemPromptFile: prompt, runId: 'run', env: { OPENAI_API_KEY: 'OTHER_SECRET', GOOGLE_API_KEY: 'GOOGLE_SECRET' } }, {
    executable: 'docker', run: async (_exe, args) => args[0] === 'info' || args[0] === 'image' ? 'linux' : args[0] === 'network' ? '172.17.0.1' : '',
    auth: { mintAccessToken: async () => authKey(), listAccounts: () => assert.fail('must not export credentials'), resolveDockerCredential: () => assert.fail('must not export credentials') },
    startBroker: async ({ lifetimeMs }) => { assert.equal(lifetimeMs, 30 * 60000); return { port: 12345, capability: 'RUN_ONLY', close: async () => { closed++; } }; }
  });
  const serialized = JSON.stringify(execution); assert.doesNotMatch(serialized, /OTHER_SECRET|GOOGLE_SECRET|auth.json|oauth.js|provider.js/);
  assert.equal(execution.env.SCRANTON_ANTIGRAVITY_CAPABILITY, 'RUN_ONLY'); assert.match(execution.env.SCRANTON_ANTIGRAVITY_BROKER, /host.docker.internal:12345/);
  assert.ok(execution.argsPrefix.includes('host.docker.internal:host-gateway')); assert.equal(execution.spec.providerExtension, '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/scranton-antigravity.mjs');
  assert.match(serialized, /docker-extension.js/); await execution.cleanup(); await execution.cleanup(); assert.equal(closed, 1);
});

test('state-validated OAuth denial fails promptly while wrong-state denial is not trusted', async () => {
  const { parseRedirect } = await import('../../src/core/antigravity/oauth.js');
  assert.throws(() => parseRedirect('http://localhost:0/oauth-callback?state=ok&error=access_denied', 'http://localhost:0/oauth-callback', 'ok'), { code: 'SCRANTON_OAUTH_DENIED' });
  assert.throws(() => parseRedirect('http://localhost:0/oauth-callback?state=bad&error=access_denied', 'http://localhost:0/oauth-callback', 'ok'), /Invalid/);
});

test('container extension uses capability-only Pi auth and streams a normalized tool transcript', async (t) => {
  const { default: extension, brokerStream } = await import('../../src/core/antigravity/docker-extension.js');
  let provider; extension({ registerProvider: (value) => { provider = value; } });
  const auth = await provider.auth.apiKey.resolve({ ctx: { env: async (key) => { assert.equal(key, 'SCRANTON_ANTIGRAVITY_CAPABILITY'); return 'run-capability'; } } });
  assert.deepEqual(auth, { auth: { apiKey: 'run-capability' }, source: 'Run capability' });
  assert.equal(await provider.auth.apiKey.resolve({ ctx: { env: async () => undefined } }), undefined);
  let sawTools = false;
  const host = antigravityProvider({ fetcher: async (_url, init) => { sawTools = JSON.stringify(JSON.parse(init.body).request.tools).includes('read'); return sse(done([{ text: 'stream' }, { text: 'ed' }])); } });
  const broker = await startAntigravityBroker({ auth: { mintAccessToken: async () => authKey() }, provider: host }); t.after(() => broker.close());
  const names = ['SCRANTON_ANTIGRAVITY_BROKER', 'SCRANTON_ANTIGRAVITY_CAPABILITY']; const previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  process.env.SCRANTON_ANTIGRAVITY_BROKER = `http://127.0.0.1:${broker.port}/inference`; process.env.SCRANTON_ANTIGRAVITY_CAPABILITY = broker.capability;
  const stream = brokerStream(provider.getModels()[0], { systemPrompt: 'system', tools: [{ name: 'read', parameters: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'hello', timestamp: 1 }] });
  const events = []; for await (const event of stream) events.push(event.type);
  assert.equal((await stream.result()).content[0].text, 'streamed'); assert.ok(events.includes('text_delta')); assert.ok(sawTools);
  process.env.SCRANTON_ANTIGRAVITY_CAPABILITY = 'wrong'; assert.equal((await brokerStream(provider.getModels()[0], context()).result()).stopReason, 'error');
});

test('client cancellation aborts host upstream and cleanup revokes capability before failed Docker removal', async (t) => {
  let started, stopped;
  const ready = new Promise((resolve) => { started = resolve; }), aborted = new Promise((resolve) => { stopped = resolve; });
  const broker = await startAntigravityBroker({ auth: { mintAccessToken: async () => authKey() }, provider: antigravityProvider({ fetcher: async (_url, init) => { started(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => { stopped(); reject(Error()); }, { once: true })); } }) });
  t.after(() => broker.close());
  const controller = new AbortController(); const pending = fetch(`http://127.0.0.1:${broker.port}/inference`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker.capability}` }, body: JSON.stringify(body()), signal: controller.signal }).catch(() => {});
  await ready; controller.abort(); await aborted; await pending;
  const root = path.resolve('.scratch/antigravity-backend/tests'); fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'cleanup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'work'), sessionDir = path.join(dir, 'session'); fs.mkdirSync(workspace); fs.mkdirSync(sessionDir); fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: private'); const prompt = path.join(dir, 'prompt'); fs.writeFileSync(prompt, 'system');
  let closed = false;
  const execution = await prepareSandbox({ provider: 'google-antigravity', workspace, sessionDir, systemPromptFile: prompt, runId: 'run', env: {} }, {
    executable: 'docker', run: async (_exe, args) => { if (args[0] === 'info' || args[0] === 'image') return 'linux'; if (args[0] === 'network') return '172.17.0.1'; assert.ok(closed); throw Error('cleanup unavailable'); },
    auth: { mintAccessToken: async () => authKey() },
    startBroker: async () => ({ port: 12345, capability: 'run-capability', close: async () => { closed = true; } })
  });
  await assert.rejects(execution.cleanup(), /cleanup unavailable/); assert.ok(closed);
});

test('long 100-character chunks use linear bounded wire bytes and reconstruct exact Pi partials/final', async (t) => {
  const { brokerStream } = await import('../../src/core/antigravity/docker-extension.js');
  let count = 2400;
  const chunk = 'x'.repeat(99) + 'é';
  const host = antigravityProvider({ fetcher: async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < count; i++) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: done([{ text: chunk }]) })}\n\n`));
      controller.close();
    }
  })) });
  const broker = await startAntigravityBroker({ auth: { mintAccessToken: async () => authKey() }, provider: host }); t.after(() => broker.close());
  const measure = async () => {
    const wire = await (await post(broker, body())).text();
    const events = wire.trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).message.content[0].text, chunk.repeat(count));
    assert.ok(events.filter((event) => event.type === 'text_delta').every((event) => !event.partial));
    return Buffer.byteLength(wire);
  };
  count = 1200; const small = await measure(); count = 2400; const large = await measure();
  assert.ok(large < small * 2.1, `${small} -> ${large} wire bytes must scale linearly`);
  assert.ok(large < 2 * 1024 * 1024, `${large} wire bytes for 240K characters`);
  const names = ['SCRANTON_ANTIGRAVITY_BROKER', 'SCRANTON_ANTIGRAVITY_CAPABILITY'], previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  process.env[names[0]] = `http://127.0.0.1:${broker.port}/inference`; process.env[names[1]] = broker.capability;
  const stream = brokerStream(host.getModels()[0], context()); let deltas = 0;
  for await (const event of stream) {
    if (event.type === 'text_delta') { deltas++; assert.ok(event.partial.content[0].text.startsWith(chunk.repeat(deltas))); assert.ok(event.partial.content[0].text.length <= count * chunk.length); }
    if (event.type === 'text_end') assert.equal(event.content, chunk.repeat(count));
  }
  assert.equal(deltas, count); assert.equal((await stream.result()).content[0].text, chunk.repeat(count));
  assert.equal((await stream.result()).stopReason, 'stop');
  console.log(`Antigravity wire: ${small} bytes/120K chars; ${large} bytes/240K chars`);
});

test('Docker auth preflight fails before broker/container and later auth failure gives safe re-login guidance', async (t) => {
  const root = path.resolve('.scratch/antigravity-backend/tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'preflight-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'work'), sessionDir = path.join(dir, 'session'); fs.mkdirSync(workspace); fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: private'); const prompt = path.join(dir, 'prompt'); fs.writeFileSync(prompt, 'system');
  for (const reason of ['signed out SECRET', 'revoked REFRESH_SECRET']) {
    await assert.rejects(prepareSandbox({ provider: 'google-antigravity', workspace, sessionDir, systemPromptFile: prompt, env: {} }, {
      executable: 'docker', run: async (_exe, args) => { assert.ok(['info', 'image', 'network'].includes(args[0])); return args[0] === 'network' ? '172.17.0.1' : 'linux'; },
      auth: { mintAccessToken: async () => { throw Error(reason); } }, startBroker: () => assert.fail('preflight must reject before broker')
    }), /^Error: Google Antigravity sign-in unavailable; sign in again in Accounts before launching Docker$/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['prompt', 'session', 'work']);
  }
  const { brokerStream } = await import('../../src/core/antigravity/docker-extension.js');
  let turns = 0;
  const host = antigravityProvider({ fetcher: async () => sse(done([{ text: 'ok' }])) });
  const broker = await startAntigravityBroker({ provider: host, auth: { mintAccessToken: async () => { if (++turns > 1) throw Error('SECRET'); return authKey(); } } });
  t.after(() => broker.close());
  const names = ['SCRANTON_ANTIGRAVITY_BROKER', 'SCRANTON_ANTIGRAVITY_CAPABILITY'], previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  process.env[names[0]] = `http://127.0.0.1:${broker.port}/inference`; process.env[names[1]] = broker.capability;
  assert.equal((await brokerStream(host.getModels()[0], context()).result()).stopReason, 'stop');
  const failed = await brokerStream(host.getModels()[0], context()).result();
  assert.equal(failed.stopReason, 'error'); assert.match(failed.errorMessage, /sign in again in Accounts/); assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});
