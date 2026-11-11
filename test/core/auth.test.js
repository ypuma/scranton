import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ModelsError } from '@earendil-works/pi-ai';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAuthService, openAuthBrowser, validateAuthUrl } from '../../src/core/auth.js';
import { runCli } from '../../src/core/cli.js';

const ACCESS = 'FAKE_ACCESS_NEVER_DISCLOSE';
const REFRESH = 'FAKE_REFRESH_NEVER_DISCLOSE';
const KEY = 'FAKE_KEY_NEVER_DISCLOSE';
function fixture(t, extra = {}) {
  const root = path.resolve('.scratch/auth-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 'auth.json');
  const notices = [], opened = [];
  const service = createAuthService({ authPath, env: {}, onChange: (s) => notices.push(s), opener: async (...args) => opened.push(args), ...extra });
  t.after(() => service.close());
  return { dir, authPath, service, notices, opened };
}
const credential = () => ({ type: 'oauth', access: ACCESS, refresh: REFRESH, expires: Date.now() + 3600000 });
const noSecrets = (value) => { for (const secret of [ACCESS, REFRESH, KEY]) assert.ok(!JSON.stringify(value).includes(secret), 'secret omitted'); };
async function until(fn, predicate) {
  for (let i = 0; i < 200; i++) { const value = fn(); if (predicate(value)) return value; await sleep(5); }
  throw Error('Timed out waiting for fake login');
}
function fakeFactory(authPath, { url = 'https://claude.ai/oauth/authorize?state=test', callback = false, fail = false } = {}) {
  return async () => ({
    async login(provider, type, io, options) {
      assert.equal(type, 'oauth'); assert.equal(options.agentName, 'Scranton'); assert.match(options.getDeviceId(), /^[0-9a-f-]{36}$/);
      assert.equal(await io.prompt({ type: 'select', options: [{ id: 'browser' }] }), 'browser');
      io.notify({ type: 'auth_url', url });
      const controller = new AbortController();
      const entered = io.prompt({ type: 'manual_code', signal: AbortSignal.any([io.signal, controller.signal]) });
      if (callback) { controller.abort(); await entered.catch(() => {}); }
      else assert.equal(await entered, 'manual-code');
      if (fail) throw Error(`${ACCESS} ${REFRESH}`);
      io.notify({ type: 'progress', message: `${ACCESS} ${REFRESH}` });
      fs.writeFileSync(authPath, JSON.stringify({ [provider]: credential() }));
    },
    async logout(provider) { const data = JSON.parse(fs.readFileSync(authPath)); delete data[provider]; fs.writeFileSync(authPath, JSON.stringify(data)); },
    async getAuth(_provider, options) { assert.equal(options.minOAuthValidityMs, 1800000); return { source: 'OAuth', auth: { apiKey: ACCESS } }; },
    async getAvailable() { return [{ provider: 'anthropic', id: 'catalog-model', name: 'Catalog model', reasoning: true, contextWindow: 200000 }]; }
  });
}

test('status is read-only for signed-out, OAuth, expired, API-key, env and malformed store; no secrets', async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.service.listAccounts()).map((a) => a.status), ['signed_out', 'signed_out', 'signed_out', 'signed_out']);
  assert.equal(fs.existsSync(f.authPath), false);
  const data = { anthropic: credential(), openai: { type: 'api_key', key: KEY } };
  fs.writeFileSync(f.authPath, JSON.stringify(data));
  const before = fs.readFileSync(f.authPath);
  const accounts = await f.service.listAccounts(); noSecrets(accounts);
  assert.deepEqual(accounts.map((a) => [a.status, a.kind]), [['signed_in', 'oauth'], ['signed_in', 'api_key'], ['signed_out', null], ['signed_out', null]]);
  assert.deepEqual(fs.readFileSync(f.authPath), before);
  data.anthropic.expires = 1; fs.writeFileSync(f.authPath, JSON.stringify(data));
  assert.equal((await f.service.listAccounts())[0].status, 'signed_in');
  assert.equal((await f.service.listAccounts())[0].renewsOnUse, true);
  fs.writeFileSync(f.authPath, '{bad'); assert.equal((await f.service.listAccounts())[0].status, 'error');
  const ambient = fixture(t, { env: { OPENAI_API_KEY: KEY } });
  assert.equal((await ambient.service.listAccounts())[1].kind, 'api_key');
});

test('login relay happy path, single login 409, manual input and metadata-only catalog', async (t) => {
  const f = fixture(t); const auth = createAuthService({ authPath: f.authPath, env: {}, runtimeFactory: fakeFactory(f.authPath), opener: async (...args) => f.opened.push(args), onChange: (s) => f.notices.push(s) });
  t.after(() => auth.close());
  const { id } = auth.startLogin('anthropic');
  assert.throws(() => auth.startLogin('openai'), { status: 409 });
  await until(() => auth.getLogin(), (s) => s.state === 'waiting_code');
  assert.throws(() => auth.input('wrong', 'manual-code'), { status: 409 });
  assert.throws(() => auth.input(id, 'x'.repeat(4097)), { status: 400 });
  auth.input(id, 'manual-code');
  assert.equal((await auth.waitForLogin()).state, 'done');
  assert.deepEqual(f.opened, [['anthropic', 'https://claude.ai/oauth/authorize?state=test']]);
  assert.equal((await auth.listModels()).providers[0].models[0].id, 'catalog-model');
  assert.equal(await auth.mintAccessToken('anthropic', { minExpiryMs: 1800000 }), ACCESS);
  noSecrets(f.notices); noSecrets(await auth.listAccounts()); noSecrets(await auth.listModels());
});

test('callback aborts manual prompt without cancelling successful login', async (t) => {
  const f = fixture(t); const auth = createAuthService({ authPath: f.authPath, runtimeFactory: fakeFactory(f.authPath, { callback: true }), opener: async () => {} });
  auth.startLogin('anthropic'); assert.equal((await auth.waitForLogin()).state, 'done');
});

test('cancel and timeout abort runtime and redact provider errors', async (t) => {
  for (const timeout of [false, true]) {
    const f = fixture(t); let aborted = false;
    const auth = createAuthService({ authPath: f.authPath, timeoutMs: timeout ? 20 : 600000, runtimeFactory: async () => ({ login: async (_p, _t, io) => {
      try { await io.prompt({ type: 'manual_code' }); } finally { aborted = io.signal.aborted; }
    } }) });
    const { id } = auth.startLogin('openai');
    await until(() => auth.getLogin(), (s) => s.state === 'waiting_code');
    if (!timeout) await auth.cancel(id);
    const result = await auth.waitForLogin();
    assert.equal(result.state, timeout ? 'failed' : 'cancelled'); assert.equal(aborted, true); noSecrets(result);
    assert.equal(fs.existsSync(f.authPath), false);
  }
});

test('untrusted URL is rejected before any browser open (regression)', async (t) => {
  const f = fixture(t); const auth = createAuthService({ authPath: f.authPath, runtimeFactory: fakeFactory(f.authPath, { url: 'https://evil.test/oauth', callback: true }), opener: async (...args) => f.opened.push(args) });
  auth.startLogin('anthropic'); assert.equal((await auth.waitForLogin()).state, 'failed'); assert.deepEqual(f.opened, []);
  for (const url of ['http://claude.ai/', 'https://claude.ai.evil.test/', 'https://evil@claude.ai/', 'https://claude.ai:444/', 'https://claude.ai/?access_token=secret']) assert.throws(() => validateAuthUrl('anthropic', url));
});

test('opener uses executable argv without a shell; validates independently', async () => {
  let call;
  const runner = (...args) => { call = args; const child = Object.assign(new EventEmitter(), { unref() {} }); queueMicrotask(() => child.emit('spawn')); return child; };
  await openAuthBrowser('openai', 'https://auth.openai.com/api/accounts/authorize?state=a&x=b', { platform: 'win32', runner });
  assert.equal(call[0], 'rundll32.exe'); assert.equal(call[2].shell, false); assert.equal(call[1].length, 2); assert.ok(call[1][1].includes('&x=b'));
  await assert.rejects(openAuthBrowser('openai', 'https://evil.test', { runner }));
});

test('logout through installed runtime removes only chosen provider; runtime exports/catalog verified offline', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.authPath, JSON.stringify({ anthropic: credential(), openai: { type: 'api_key', key: KEY } }));
  const { ModelRuntime, getAgentDir } = await import('@earendil-works/pi-coding-agent');
  assert.equal(typeof getAgentDir, 'function');
  const r = await ModelRuntime.create({ authPath: f.authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  assert.ok(r.getModels('anthropic').length > 0);
  await r.logout('anthropic');
  const remaining = JSON.parse(fs.readFileSync(f.authPath));
  assert.deepEqual(Object.keys(remaining), ['openai']); assert.equal(remaining.openai.key, KEY);
});

test('login failures never return provider error strings or entered codes', async (t) => {
  const f = fixture(t); const auth = createAuthService({ authPath: f.authPath, runtimeFactory: fakeFactory(f.authPath, { fail: true }), opener: async () => {}, onChange: (s) => f.notices.push(s) });
  const { id } = auth.startLogin('anthropic'); await until(() => auth.getLogin(), (s) => s.state === 'waiting_code'); auth.input(id, 'manual-code');
  assert.equal((await auth.waitForLogin()).state, 'failed'); noSecrets(f.notices); assert.ok(!JSON.stringify(f.notices).includes('manual-code'));
});

test('CLI accounts/logout aliases and injected login use same auth service without leaking secrets', async (t) => {
  const f = fixture(t); let text = ''; const stdout = { write: (s) => { text += s; } };
  const auth = createAuthService({ authPath: f.authPath, env: {}, runtimeFactory: fakeFactory(f.authPath), opener: async () => {} });
  const stdin = new PassThrough(); stdin.end('manual-code\n');
  const options = { cwd: f.dir, env: {}, stdout, stderr: stdout, stdin, auth };
  assert.equal(await runCli(['accounts'], options), 0); assert.match(text, /signed_out/);
  assert.equal(await runCli(['login', 'claude'], options), 0); assert.match(text, /Sign in: https:\/\/claude.ai/);
  assert.equal(await runCli(['logout', 'anthropic'], options), 0);
  assert.equal(await runCli(['login', 'unknown'], options), 2); noSecrets(text);
});

test('OAuth expiry stays renewable until a real mint failure, persists metadata and clears on success/logout', async (t) => {
  let fail = true;
  const f = fixture(t, { now: () => 2000, runtimeFactory: async () => ({
    getAuth: async () => { if (fail) throw new ModelsError('oauth', 'OAuth refresh failed for openai', { cause: new Error(`OpenAI OAuth token request failed (400): invalid_grant ${ACCESS} ${REFRESH}`) }); return { source: 'OAuth', auth: { apiKey: ACCESS } }; },
    logout: async () => fs.writeFileSync(f.authPath, '{}')
  }) });
  fs.writeFileSync(f.authPath, JSON.stringify({ openai: { ...credential(), expires: 1 } }));
  const before = fs.readFileSync(f.authPath);
  let account = (await f.service.listAccounts()).find((a) => a.id === 'openai');
  assert.equal(account.status, 'signed_in'); assert.equal(account.renewsOnUse, true);
  assert.equal(account.renewFailedAt, undefined);
  assert.deepEqual(fs.readFileSync(f.authPath), before);
  await assert.rejects(f.service.mintAccessToken('openai', { minExpiryMs: 1800000 }), /sign in again/);
  account = (await f.service.listAccounts()).find((a) => a.id === 'openai');
  assert.equal(account.status, 'expired'); assert.equal(account.renewFailedAt, '1970-01-01T00:00:02.000Z');
  const other = createAuthService({ authPath: f.authPath, env: {} }); t.after(() => other.close());
  assert.equal((await other.listAccounts()).find((a) => a.id === 'openai').renewFailedAt, account.renewFailedAt);
  noSecrets(account);
  fail = false;
  assert.equal(await f.service.mintAccessToken('openai', { minExpiryMs: 1800000 }), ACCESS);
  assert.equal((await other.listAccounts()).find((a) => a.id === 'openai').status, 'signed_in');
  fail = true;
  await assert.rejects(f.service.mintAccessToken('openai', { minExpiryMs: 1800000 }));
  await f.service.logout('openai');
  assert.equal(fs.readdirSync(f.dir).some((name) => name.startsWith('scranton-renewal-')), false);
});
