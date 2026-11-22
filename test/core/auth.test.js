import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAuthService, openAuthBrowser, validateAuthUrl } from '../../src/core/auth.js';
import { runCli } from '../../src/core/cli.js';

const ACCESS = 'FAKE_ACCESS_NEVER_DISCLOSE';
const REFRESH = 'FAKE_REFRESH_NEVER_DISCLOSE';
const KEY = 'FAKE_KEY_NEVER_DISCLOSE';
function fixture(t, extra = {}) {
  const root = path.resolve('.scratch/auth-port/core'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authPath = path.join(dir, 'store.json');
  fs.writeFileSync(authPath, JSON.stringify({version:1, credentials:{}, providers:{}, renewals:{}, deviceId:'00000000-0000-4000-8000-000000000000', import:{at:'fixture'}}));
  const notices = [], opened = [];
  const service = createAuthService({ env: { SCRANTON_CREDENTIALS_DIR: dir }, onChange: (s) => notices.push(s), opener: async (...args) => opened.push(args), ...extra });
  t.after(() => service.close());
  return { dir, authPath, service, notices, opened };
}
const credential = () => ({ type: 'oauth', access: ACCESS, refresh: REFRESH, expires: Date.now() + 3600000 });
const noSecrets = (value) => { for (const secret of [ACCESS, REFRESH, KEY]) assert.ok(!JSON.stringify(value).includes(secret), 'secret omitted'); };
async function until(fn, predicate) {
  for (let i = 0; i < 200; i++) { const value = fn(); if (predicate(value)) return value; await sleep(5); }
  throw Error('Timed out waiting for fake login');
}
function fakeFactory(_file, { url = 'https://claude.ai/oauth/authorize?state=test', callback = false, fail = false } = {}) {
  const adapter = { async login(io, options) {
    assert.equal(options.agentName, 'Scranton'); assert.match(options.getDeviceId(), /^[0-9a-f-]{36}$/);
    io.notify({ type: 'auth_url', url });
    const controller = new AbortController();
    const entered = io.prompt({ type: 'manual_code', signal: AbortSignal.any([io.signal, controller.signal]) });
    if (callback) { controller.abort(); await entered.catch(() => {}); }
    else assert.equal(await entered, 'manual-code');
    if (fail) throw Error(ACCESS + REFRESH);
    io.notify({ type: 'progress', message: ACCESS + REFRESH });
    return credential();
  } };
  return { anthropic: adapter, openai: adapter };
}
function read(file) { return JSON.parse(fs.readFileSync(file)); }
function write(file, credentials) { const data = read(file); data.credentials = credentials; fs.writeFileSync(file, JSON.stringify(data)); }

test('status is read-only for signed-out, OAuth, expired, API-key, env and malformed store; no secrets', async (t) => {
  const f = fixture(t);
  assert.deepEqual((await f.service.listAccounts()).map((a) => a.status), ['signed_out', 'signed_out', 'signed_out', 'signed_out']);
  assert.equal(Object.keys(read(f.authPath).credentials).length, 0);
  const data = { anthropic: credential(), openai: { type: 'api_key', key: KEY } };
  write(f.authPath, data);
  const before = fs.readFileSync(f.authPath);
  const accounts = await f.service.listAccounts(); noSecrets(accounts);
  assert.deepEqual(accounts.map((a) => [a.status, a.kind]), [['signed_in', 'oauth'], ['signed_in', 'api_key'], ['signed_out', null], ['signed_out', null]]);
  assert.deepEqual(fs.readFileSync(f.authPath), before);
  data.anthropic.expires = 1; write(f.authPath, data);
  assert.equal((await f.service.listAccounts())[0].status, 'signed_in');
  assert.equal((await f.service.listAccounts())[0].renewsOnUse, true);
  fs.writeFileSync(f.authPath, '{bad'); assert.equal((await f.service.listAccounts())[0].status, 'error');
  const ambient = fixture(t); await ambient.service.close();
  ambient.service = createAuthService({env:{SCRANTON_CREDENTIALS_DIR:ambient.dir,OPENAI_API_KEY:KEY}}); t.after(() => ambient.service.close());
  assert.equal((await ambient.service.listAccounts())[1].kind, 'api_key');
});

test('login relay happy path, single login 409, manual input and metadata-only catalog', async (t) => {
  const f = fixture(t); const auth = createAuthService({ dir: f.dir, env: {}, oauth: fakeFactory(f.authPath), opener: async (...args) => f.opened.push(args), onChange: (s) => f.notices.push(s) });
  t.after(() => auth.close());
  const { id } = auth.startLogin('anthropic');
  assert.throws(() => auth.startLogin('openai'), { status: 409 });
  await until(() => auth.getLogin(), (s) => s.state === 'waiting_code');
  assert.throws(() => auth.input('wrong', 'manual-code'), { status: 409 });
  assert.throws(() => auth.input(id, 'x'.repeat(4097)), { status: 400 });
  auth.input(id, 'manual-code');
  assert.equal((await auth.waitForLogin()).state, 'done');
  assert.deepEqual(f.opened, [['anthropic', 'https://claude.ai/oauth/authorize?state=test']]);
  assert.ok((await auth.listModels()).providers[0].models.some((m) => m.id === 'claude-sonnet-4-5'));
  assert.equal(await auth.mintAccessToken('anthropic', { minExpiryMs: 1800000 }), ACCESS);
  noSecrets(f.notices); noSecrets(await auth.listAccounts()); noSecrets(await auth.listModels());
});

test('callback aborts manual prompt without cancelling successful login', async (t) => {
  const f = fixture(t); const auth = createAuthService({ dir: f.dir, oauth: fakeFactory(f.authPath, { callback: true }), opener: async () => {} });
  auth.startLogin('anthropic'); assert.equal((await auth.waitForLogin()).state, 'done');
});

test('cancel and timeout abort runtime and redact provider errors', async (t) => {
  for (const timeout of [false, true]) {
    const f = fixture(t); let aborted = false;
    const auth = createAuthService({ dir: f.dir, timeoutMs: timeout ? 20 : 600000, oauth: { openai: { login: async (io) => {
      try { await io.prompt({ type: 'manual_code' }); } finally { aborted = io.signal.aborted; }
    } } } });
    const { id } = auth.startLogin('openai');
    await until(() => auth.getLogin(), (s) => s.state === 'waiting_code');
    if (!timeout) await auth.cancel(id);
    const result = await auth.waitForLogin();
    assert.equal(result.state, timeout ? 'failed' : 'cancelled'); assert.equal(aborted, true); noSecrets(result);
    assert.equal(Object.keys(read(f.authPath).credentials).length, 0);
  }
});

test('untrusted URL is rejected before any browser open (regression)', async (t) => {
  const f = fixture(t); const auth = createAuthService({ dir: f.dir, oauth: fakeFactory(f.authPath, { url: 'https://evil.test/oauth', callback: true }), opener: async (...args) => f.opened.push(args) });
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

test('logout removes only chosen provider from own atomic store', async (t) => {
  const f = fixture(t);
  write(f.authPath, { anthropic: credential(), openai: { type: 'api_key', key: KEY } });
  await f.service.logout('anthropic');
  assert.deepEqual(Object.keys(read(f.authPath).credentials), ['openai']);
  assert.equal(read(f.authPath).credentials.openai.key, KEY);
});

test('login failures never return provider error strings or entered codes', async (t) => {
  const f = fixture(t); const auth = createAuthService({ dir: f.dir, oauth: fakeFactory(f.authPath, { fail: true }), opener: async () => {}, onChange: (s) => f.notices.push(s) });
  const { id } = auth.startLogin('anthropic'); await until(() => auth.getLogin(), (s) => s.state === 'waiting_code'); auth.input(id, 'manual-code');
  assert.equal((await auth.waitForLogin()).state, 'failed'); noSecrets(f.notices); assert.ok(!JSON.stringify(f.notices).includes('manual-code'));
});

test('CLI accounts/logout aliases and injected login use same auth service without leaking secrets', async (t) => {
  const f = fixture(t); let text = ''; const stdout = { write: (s) => { text += s; } };
  const auth = createAuthService({ dir: f.dir, env: {}, oauth: fakeFactory(f.authPath), opener: async () => {} });
  const stdin = new PassThrough(); stdin.end('manual-code\n');
  const options = { cwd: f.dir, env: {}, stdout, stderr: stdout, stdin, auth };
  assert.equal(await runCli(['accounts'], options), 0); assert.match(text, /signed_out/);
  assert.equal(await runCli(['login', 'claude'], options), 0); assert.match(text, /Sign in: https:\/\/claude.ai/);
  const logout = createAuthService({env:{SCRANTON_CREDENTIALS_DIR:f.dir}}); t.after(() => logout.close());
  assert.equal(await runCli(['logout', 'anthropic'], {...options,auth:logout}), 0);
  assert.equal(await runCli(['login', 'unknown'], options), 2); noSecrets(text);
});

test('OAuth expiry stays renewable until real rejection; metadata persists and clears on refresh/logout', async (t) => {
  let fail = true;
  const f = fixture(t, { now: () => 2000, oauth: { openai: { refresh: async (c) => {
    if (fail) throw Object.assign(Error('rejected'), {code:'SCRANTON_OAUTH_REJECTED', provider:'openai'});
    return {...c, expires: 4000000};
  } } } });
  write(f.authPath, {openai:{...credential(), expires:1}});
  assert.equal(f.service.listAccounts()[1].renewsOnUse, true);
  await assert.rejects(f.service.mintAccessToken('openai', {minExpiryMs:1800000}), /sign in again/);
  assert.equal(f.service.listAccounts()[1].status, 'expired');
  assert.equal(f.service.listAccounts()[1].renewFailedAt, '1970-01-01T00:00:02.000Z');
  const other = createAuthService({env:{SCRANTON_CREDENTIALS_DIR:f.dir}}); t.after(() => other.close());
  assert.equal(other.listAccounts()[1].status, 'expired');
  fail = false;
  assert.equal(await f.service.mintAccessToken('openai', {minExpiryMs:1800000}), ACCESS);
  assert.equal(other.listAccounts()[1].status, 'signed_in');
  await f.service.logout('openai');
  assert.deepEqual(read(f.authPath).renewals, {}); noSecrets(f.service.listAccounts());
});
