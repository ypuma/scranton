import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { createCredentials } from '../../src/core/credentials/index.js';
import { createAuthService } from '../../src/core/auth.js';
import { runCli } from '../../src/core/cli.js';

const KEY = 'FAKE_EXTENDED_KEY_NEVER_DISCLOSE';
function fixture(t, options = {}) {
  const root = path.resolve('.scratch/auth-port/extended'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'auth-'));
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({version:1,credentials:{},providers:{},renewals:{},deviceId:'fixture',import:{at:'fixture'}}));
  const notices = [];
  const auth = createAuthService({ env: { SCRANTON_CREDENTIALS_DIR: dir }, onChange: (s) => notices.push(s), ...options });
  t.after(async () => { await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, auth, notices, file: path.join(dir, 'store.json') };
}
const definition = { id: 'abliteration-test', label: 'Abliteration test', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'test-model', contextWindow: 4096 }] };
const noKey = (v) => assert.ok(!JSON.stringify(v).includes(KEY));

test('Own store API-key login stores key, accounts never disclose it, logout removes only selected provider', async (t) => {
  const { auth, file, notices } = fixture(t);
  assert.deepEqual((await auth.listAccounts()).map((a) => a.id), ['anthropic', 'openai', 'google', 'google-antigravity']);
  await auth.setApiKey('google', ` ${KEY} `);
  await auth.setApiKey('anthropic', KEY);
  const stored = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(stored.credentials.google, { type: 'api_key', key: KEY });
  const accounts = await auth.listAccounts(); noKey(accounts); noKey(notices);
  assert.equal(accounts.find((a) => a.id === 'google').kind, 'api_key');
  assert.equal(accounts.find((a) => a.id === 'anthropic').status, 'signed_in');
  const providers = await auth.listProviders(); noKey(providers);
  assert.deepEqual(providers.providers.find((p) => p.id === 'google').methods, ['api_key']);
  await auth.logout('google');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file)).credentials), ['anthropic']);
  assert.equal((await auth.listAccounts()).find((a) => a.id === 'google').status, 'signed_out');
  for (const invalid of ['', 'a b', 'x'.repeat(4097), '!do-not-execute', '$ENV']) await assert.rejects(auth.setApiKey('google', invalid), { status: 400 });
  await assert.rejects(auth.setApiKey('unknown', KEY), { status: 400 });
});

test('custom providers and key commit together; model listing omits secrets and exposes no Docker projection', async (t) => {
  const {dir, auth, file} = fixture(t);
  await auth.addProvider({...definition, key:KEY});
  const data = JSON.parse(fs.readFileSync(file)); noKey(data.providers);
  assert.equal(data.credentials[definition.id].key, KEY);
  assert.equal((await auth.listAccounts()).find((a) => a.id === definition.id).custom, true);
  assert.equal((await auth.listModels()).providers.find((p) => p.id === definition.id).models[0].id, 'test-model');
  assert.equal(auth.resolveDockerCredential, undefined); noKey(await auth.listModels());
  assert.equal(fs.existsSync(path.join(dir, 'models.json')), false);
  await auth.removeProvider(definition.id);
  const remaining = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(remaining.providers, {}); assert.deepEqual(remaining.credentials, {});
});

test('store failures are sanitized without a container credential export', async (t) => {
  const {auth, file, notices} = fixture(t);
  await auth.listModels(); fs.writeFileSync(file, '{broken');
  await assert.rejects(auth.setApiKey('google', KEY));
  assert.equal(auth.resolveDockerCredential, undefined);
  noKey(auth.listAccounts()); noKey(notices);
});

test('CLI gemini/any-provider keys and custom add/remove read stdin only, never echo keys', async (t) => {
  const { dir, auth } = fixture(t);
  let output = ''; const stream = { write: (s) => { output += s; } };
  const call = async (args, key = KEY) => { const stdin = new PassThrough(); stdin.end(key + '\n'); return runCli(args, { cwd: dir, env: { SCRANTON_CREDENTIALS_DIR: dir }, stdin, stdout: stream, stderr: stream, auth }); };
  assert.equal(await call(['login', 'gemini']), 0);
  assert.equal(await call(['login', 'anthropic', '--api-key']), 0);
  assert.equal(await call(['provider', 'add', 'custom-cli', '--base-url', 'https://example.test/v1', '--api', 'openai-completions', '--models', 'test-a,test-b']), 0);
  assert.equal((await auth.listAccounts()).find((a) => a.id === 'custom-cli').custom, true);
  assert.equal(await call(['provider', 'remove', 'custom-cli']), 0);
  assert.equal(await call(['logout', 'anthropic']), 0);
  assert.equal(await call(['login', 'google', '--api-key', KEY]), 2);
  assert.equal(await call(['login', 'google', '--api-key=' + KEY]), 2);
  // A positional key is refused before use and is never echoed in the diagnostic.
  noKey(output);
});

test('host LLM stored credentials own provider: malformed entries never fall back to ambient keys', async (t) => {
  const { dir, file } = fixture(t);
  const auth = await createCredentials({ dir, env: { SCRANTON_CREDENTIALS_DIR: dir, GEMINI_API_KEY: KEY } });
  t.after(() => auth.close());
  for (const credential of [null, {}, { type: 'unsupported' }, { type: 'api_key', key: '' }, { type: 'api_key', key: '$GEMINI_API_KEY' }]) {
    const data = JSON.parse(fs.readFileSync(file)); data.credentials = {google:credential}; fs.writeFileSync(file, JSON.stringify(data));
    await assert.rejects(auth.resolveAuth('google'));
  }
  const data = JSON.parse(fs.readFileSync(file)); data.credentials = {}; fs.writeFileSync(file, JSON.stringify(data));
  assert.equal((await auth.resolveAuth('google')).key, KEY);
});

test('every supported built-in key provider accepts a literal key offline', async (t) => {
  const { dir, file } = fixture(t);
  const auth = createAuthService({ dir, env: { SCRANTON_CREDENTIALS_DIR: dir, CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_GATEWAY_ID: 'fake-gateway' } });
  t.after(() => auth.close());
  const providers = (await auth.listProviders()).providers.filter((p) => p.methods.includes('api_key'));
  assert.deepEqual(providers.map((p) => p.id).sort(), ['anthropic', 'google', 'openai']);
  for (const { id } of providers) {
    await auth.setApiKey(id, KEY);
    const credential = JSON.parse(fs.readFileSync(file)).credentials[id];
    assert.equal(credential.type, 'api_key', id);
    assert.ok(credential.key === KEY, 'literal key persisted for ' + id);
    assert.equal((await auth.listAccounts()).find(a => a.id === id).status, 'signed_in');
  }
  noKey(await auth.listAccounts()); noKey(await auth.listModels());
});
