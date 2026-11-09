import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { createAuthService } from '../../src/core/auth.js';
import { runCli } from '../../src/core/cli.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';

const KEY = 'FAKE_EXTENDED_KEY_NEVER_DISCLOSE';
function fixture(t, options = {}) {
  const root = path.resolve('.scratch/auth-ext-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'auth-'));
  const notices = [];
  const auth = createAuthService({ env: { PI_CODING_AGENT_DIR: dir }, onChange: (s) => notices.push(s), ...options });
  t.after(async () => { await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, auth, notices, file: path.join(dir, 'auth.json') };
}
const definition = { id: 'abliteration-test', label: 'Abliteration test', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'test-model', contextWindow: 4096 }] };
const noKey = (v) => assert.ok(!JSON.stringify(v).includes(KEY));

test('installed pi 1.5 API-key login stores key, accounts never disclose it, logout removes only selected provider', async (t) => {
  const { auth, file, notices } = fixture(t);
  assert.deepEqual((await auth.listAccounts()).map((a) => a.id), ['anthropic', 'openai', 'google']);
  await auth.setApiKey('google', ` ${KEY} `);
  await auth.setApiKey('deepseek', KEY);
  const stored = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(stored.google, { type: 'api_key', key: KEY });
  const accounts = await auth.listAccounts(); noKey(accounts); noKey(notices);
  assert.equal(accounts.find((a) => a.id === 'google').kind, 'api_key');
  assert.equal(accounts.find((a) => a.id === 'deepseek').status, 'signed_in');
  const providers = await auth.listProviders(); noKey(providers);
  assert.deepEqual(providers.providers.find((p) => p.id === 'google').methods, ['api_key']);
  await auth.logout('google');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file))), ['deepseek']);
  assert.equal((await auth.listAccounts()).find((a) => a.id === 'google').status, 'signed_out');
  for (const invalid of ['', 'a b', 'x'.repeat(4097), '!do-not-execute', '$ENV']) await assert.rejects(auth.setApiKey('google', invalid), { status: 400 });
  await assert.rejects(auth.setApiKey('unknown', KEY), { status: 400 });
});

test('installed custom-provider schema, auth storage, refresh and Docker env reference are verified offline', async (t) => {
  const { dir, auth, file } = fixture(t);
  await auth.addProvider({ ...definition, key: KEY });
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'))); noKey(metadata);
  assert.equal(metadata.providers[definition.id].apiKey, undefined);
  assert.equal(JSON.parse(fs.readFileSync(file))[definition.id].key, KEY);
  const accounts = await auth.listAccounts(); noKey(accounts);
  assert.equal(accounts.find((a) => a.id === definition.id).custom, true);
  const models = await auth.listModels(); noKey(models);
  assert.equal(models.providers.find((p) => p.id === definition.id).models[0].id, 'test-model');
  const resolved = await auth.resolveDockerCredential(definition.id);
  assert.equal(resolved.value, KEY); noKey(resolved.models);
  assert.equal(resolved.models.providers[definition.id].apiKey, '$SCRANTON_PROVIDER_ABLITERATION_TEST_KEY');
  const storage = AuthStorage.create(file);
  assert.equal((await storage.read(definition.id)).key, KEY);
  const runtime = await ModelRuntime.create({ authPath: file, modelsPath: path.join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(resolved.models));
  await runtime.refresh({ allowNetwork: false, providers: [definition.id] });
  assert.equal(runtime.getModels(definition.id)[0].id, 'test-model');
  const containerRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: path.join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false });
  const containerAuth = await containerRuntime.getAuth(definition.id, { env: { [resolved.name]: KEY } });
  assert.equal(containerAuth.auth.apiKey, KEY);
  assert.equal(containerAuth.auth.headers.Authorization, `Bearer ${KEY}`);
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(metadata));
  await auth.removeProvider(definition.id);
  assert.equal(JSON.parse(fs.readFileSync(file))[definition.id], undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'))).providers, {});
});

test('api-key failures are sanitized and missing Docker credentials fail closed', async (t) => {
  const { auth, notices } = fixture(t, { runtimeFactory: async () => ({ login: async () => { throw Error(KEY); } }) });
  await assert.rejects(auth.setApiKey('google', KEY), (e) => e.status === 500 && !e.message.includes(KEY));
  await assert.rejects(auth.resolveDockerCredential('google'), (e) => /sign in again/.test(e.message) && !e.message.includes(KEY));
  noKey(await auth.listAccounts()); noKey(notices);
});

test('CLI gemini/any-provider keys and custom add/remove read stdin only, never echo keys', async (t) => {
  const { dir, auth } = fixture(t);
  let output = ''; const stream = { write: (s) => { output += s; } };
  const call = async (args, key = KEY) => { const stdin = new PassThrough(); stdin.end(key + '\n'); return runCli(args, { cwd: dir, env: { PI_CODING_AGENT_DIR: dir }, stdin, stdout: stream, stderr: stream, auth }); };
  assert.equal(await call(['login', 'gemini']), 0);
  assert.equal(await call(['login', 'deepseek', '--api-key']), 0);
  assert.equal(await call(['provider', 'add', 'custom-cli', '--base-url', 'https://example.test/v1', '--api', 'openai-completions', '--models', 'test-a,test-b']), 0);
  assert.equal((await auth.listAccounts()).find((a) => a.id === 'custom-cli').custom, true);
  assert.equal(await call(['provider', 'remove', 'custom-cli']), 0);
  assert.equal(await call(['logout', 'deepseek']), 0);
  assert.equal(await call(['login', 'google', '--api-key', KEY]), 2);
  assert.equal(await call(['login', 'google', '--api-key=' + KEY]), 2);
  // A positional key is refused before use and is never echoed in the diagnostic.
  noKey(output);
});

test('Docker stored credentials own provider: malformed entries never fall back to ambient keys', async (t) => {
  const { dir, file } = fixture(t);
  const auth = createAuthService({ authPath: file, env: { PI_CODING_AGENT_DIR: dir, GEMINI_API_KEY: KEY } });
  t.after(() => auth.close());
  for (const credential of [null, {}, { type: 'unsupported' }, { type: 'api_key', key: '' }, { type: 'api_key', key: '$GEMINI_API_KEY' }]) {
    fs.writeFileSync(file, JSON.stringify({ google: credential }));
    await assert.rejects(auth.resolveDockerCredential('google'), /sign in again/);
  }
  fs.writeFileSync(file, '{}');
  assert.equal((await auth.resolveDockerCredential('google')).value, KEY);
});

test('every installed built-in API-key login accepts a literal key offline, including metadata providers', async (t) => {
  const { dir, file } = fixture(t);
  const auth = createAuthService({ authPath: file, env: { PI_CODING_AGENT_DIR: dir, CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_GATEWAY_ID: 'fake-gateway' } });
  t.after(() => auth.close());
  const providers = (await auth.listProviders()).providers.filter((p) => p.methods.includes('api_key'));
  assert.ok(providers.length > 30);
  for (const { id } of providers) {
    await auth.setApiKey(id, KEY);
    const credential = JSON.parse(fs.readFileSync(file))[id];
    assert.equal(credential.type, 'api_key', id);
    assert.ok(credential.key === KEY, 'literal key persisted for ' + id);
    const resolved = await auth.resolveDockerCredential(id);
    assert.ok(resolved.value === KEY, 'Docker resolves selected literal for ' + id);
  }
  noKey(await auth.listAccounts()); noKey(await auth.listModels());
});
