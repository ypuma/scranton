import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createOAuthProviders } from '../../../src/core/credentials/index.js';
import { fixture, server, json, child } from './helpers.js';

const credential = { type: 'oauth', access: 'FAKE_OLD_ACCESS', refresh: 'FAKE_REFRESH', expires: 1 };
const account = (c) => c.listAccounts().find((p) => p.id === 'anthropic');

test('stored credentials beat environment keys, fallback order matches existing auth, malformed storage fails closed', async (t) => {
  const f = fixture(t), c = await f.create({ env: { ...f.env, ANTHROPIC_API_KEY: 'FIRST', ANTHROPIC_OAUTH_TOKEN: 'SECOND', GEMINI_API_KEY: 'GEMINI' } });
  assert.deepEqual(await c.resolveAuth('anthropic'), { type: 'api_key', key: 'FIRST' });
  await c.setApiKey('anthropic', ' STORED '); assert.equal((await c.resolveAuth('anthropic')).key, 'STORED');
  await c.store.transaction((d) => { d.credentials.anthropic = null; });
  await assert.rejects(c.resolveAuth('anthropic'), { code: 'SCRANTON_CREDENTIAL_INVALID' });
  await c.logout('anthropic'); assert.equal((await c.resolveAuth('anthropic')).key, 'FIRST');
  assert.equal(c.listAccounts().find((p) => p.id === 'google').status, 'signed_in'); await c.close();
});

test('concurrent run processes refresh exactly once while preserving fresh tokens and private metadata', async (t) => {
  const f = fixture(t); let requests = 0;
  const fake = await server(t, async (_req, res, body) => {
    requests++; assert.equal(JSON.parse(body).refresh_token, 'FAKE_REFRESH'); await sleep(80);
    json(res, { access_token: 'FAKE_NEW_ACCESS', refresh_token: 'FAKE_ROTATED', expires_in: 3600 });
  });
  const c = await f.create(); await c.store.set('anthropic', credential);
  const file = path.join(f.dir, 'worker.json'); fs.writeFileSync(file, JSON.stringify({ env: f.env, url: fake.url }));
  await Promise.all([child(['refresh', file]), child(['refresh', file])]);
  assert.equal(requests, 1); assert.equal(c.store.get('anthropic').refresh, 'FAKE_ROTATED');
  assert.ok(!JSON.stringify(c.listAccounts()).includes('FAKE_')); await c.close();
});

test('status persists rejection with expiry/failure time only; successful replacement clears it', async (t) => {
  const f = fixture(t); let reject = true;
  const fake = await server(t, (_req, res) => json(res, reject ? { error: 'SECRET invalid_grant' } : { access_token: 'FAKE_NEW_ACCESS', refresh_token: 'FAKE_ROTATED', expires_in: 3600 }, reject ? 401 : 200));
  const oauth = createOAuthProviders({ endpoints: { anthropic: { tokenUrl: fake.url } } });
  const c = await f.create({ oauth }); await c.store.set('anthropic', credential);
  assert.equal(account(c).status, 'signed_in'); assert.equal(account(c).renewsOnUse, true);
  await assert.rejects(c.resolveAuth('anthropic'), { code: 'SCRANTON_OAUTH_REJECTED' });
  const second = await f.create({ oauth });
  assert.equal(account(second).status, 'expired'); assert.ok(account(second).renewFailedAt); assert.equal(account(second).renewsOnUse, false);
  assert.deepEqual(Object.keys(c.store.read().renewals.anthropic).sort(), ['expires', 'failedAt']);
  reject = false; await c.resolveAuth('anthropic'); assert.equal(account(second).status, 'signed_in'); assert.equal(account(second).renewFailedAt, undefined);
  await c.store.transaction((d) => { d.renewals.anthropic = { expires: 1, failedAt: new Date().toISOString() }; });
  assert.equal(account(c).renewFailedAt, undefined);
  await c.logout('anthropic'); assert.equal(account(second).status, 'signed_out'); await c.close(); await second.close();
});

test('network, HTTP 5xx, timeouts and insufficient validity never mark the grant expired', async (t) => {
  const f = fixture(t);
  const fake = await server(t, (_req, res) => json(res, { error: 'invalid_grant SECRET' }, 500));
  const c = await f.create({ oauth: createOAuthProviders({ endpoints: { anthropic: { tokenUrl: fake.url } } }) });
  await c.store.set('anthropic', credential);
  await assert.rejects(c.resolveAuth('anthropic'), { code: 'SCRANTON_OAUTH_TEMPORARY' }); assert.equal(account(c).status, 'signed_in');
  const short = await f.create({ oauth: { anthropic: { refresh: async () => ({ ...credential, access: 'SHORT', expires: Date.now() + 500 }) } } });
  await assert.rejects(short.resolveAuth('anthropic', { minExpiryMs: 3600000 }), { code: 'SCRANTON_OAUTH_TEMPORARY' });
  assert.equal(account(c).status, 'signed_in'); assert.equal(c.store.get('anthropic').access, 'SHORT');
  const timed = await f.create({ renewalTimeoutMs: 20, oauth: { anthropic: { refresh: async (_c, signal) => { await sleep(10000, undefined, { signal }); } } } });
  await assert.rejects(timed.resolveAuth('anthropic'), { code: 'SCRANTON_OAUTH_TEMPORARY' }); assert.equal(account(c).status, 'signed_in');
  await c.close(); await short.close(); await timed.close();
});

test('renewal polling is synchronous, network-free until explicitly triggered and observes cooldown/close', async (t) => {
  const f = fixture(t); let requests = 0, clock = Date.now();
  const c = await f.create({ now: () => clock, oauth: { anthropic: { refresh: async () => { requests++; throw Error('SECRET'); } } } });
  await c.store.set('anthropic', credential);
  const accounts = c.listAccounts(); assert.equal(requests, 0);
  c.checkRenewals(accounts); c.checkRenewals(accounts); await sleep(50); assert.equal(requests, 1);
  c.checkRenewals(); await sleep(20); assert.equal(requests, 1);
  clock += 300001; c.checkRenewals(); await sleep(50); assert.equal(requests, 2);
  await c.close(); c.checkRenewals(); await sleep(20); assert.equal(requests, 2);
});

test('login session facade preserves prompt, notify, one-login, saved-success, terminal cancellation and redaction semantics', async (t) => {
  const f = fixture(t); let open = 0;
  const c = await f.create({ opener: async () => { open++; }, oauth: { anthropic: { login: async (io) => {
    io.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?state=FAKE' });
    assert.equal(await io.prompt({ type: 'manual_code', message: 'Paste code' }), 'PASTED');
    return { ...credential, expires: Date.now() + 3600000 };
  } } } });
  const { id } = c.startLogin('anthropic');
  assert.throws(() => c.startLogin('anthropic'), { status: 409 });
  await sleep(5); assert.equal(c.getLogin().state, 'waiting_code'); assert.equal(open, 1);
  assert.throws(() => c.openLogin(id), { status: 429 });
  c.input(id, 'PASTED'); assert.equal((await c.waitForLogin()).state, 'done');
  await c.cancel(id); assert.equal(c.getLogin().state, 'done'); assert.equal(c.store.get('anthropic').access, credential.access);
  assert.ok(!JSON.stringify(c.getLogin()).includes('FAKE_OLD_ACCESS')); await c.close();
});

test('cancel, timeout, untrusted sign-in URLs and raw provider errors never leak diagnostics', async (t) => {
  const f = fixture(t);
  for (const mode of ['cancel', 'timeout', 'untrusted', 'error']) {
    const c = await f.create({ timeoutMs: 20, opener: async () => {}, oauth: { anthropic: { login: async (io) => {
      if (mode === 'untrusted') io.notify({ type: 'auth_url', url: 'https://evil.test/SECRET' });
      if (mode === 'error') throw Error('SECRET_ACCESS SECRET_REFRESH');
      await io.prompt({ type: 'manual_code', message: 'Paste code' }); return credential;
    } } } });
    const { id } = c.startLogin('anthropic'); if (mode === 'cancel') await c.cancel(id);
    const session = await c.waitForLogin(); assert.equal(session.state, mode === 'cancel' ? 'cancelled' : 'failed');
    assert.ok(!JSON.stringify(session).includes('SECRET')); assert.equal(c.store.get('anthropic'), undefined); await c.close();
  }
});

test('resolver follows the revised LLM contract for Codex mode, direct grants and explicit OAuth environment tokens', async (t) => {
  const f = fixture(t), c = await f.create({ env: { ...f.env, ANTHROPIC_OAUTH_TOKEN: 'ENV_OAUTH' } });
  assert.deepEqual(await c.resolveAuth('anthropic'), { type: 'oauth', access: 'ENV_OAUTH' });
  const future = Date.now() + 3600000;
  await c.store.set('openai', { ...credential, expires: future, accountId: 'legacy-account' });
  assert.equal((await c.resolveAuth('openai')).mode, 'chatgpt');
  await c.store.set('openai', { ...credential, expires: future, clientId: 'issued', scopes: ['chatgpt.tokens.use.direct'] });
  assert.equal((await c.resolveAuth('openai')).mode, undefined);
  await c.close();
});

test('successful disk commit wins a late cancellation', async (t) => {
  const f = fixture(t), c = await f.create({ oauth: { anthropic: { login: async () => ({ ...credential, expires: Date.now() + 3600000 }) } } });
  const set = c.store.set;
  let committed, finish;
  const saved = new Promise((resolve) => { committed = resolve; });
  const delayed = new Promise((resolve) => { finish = resolve; });
  c.store.set = async (...args) => { await set(...args); committed(); await delayed; };
  const { id } = c.startLogin('anthropic'); await saved;
  const cancelled = c.cancel(id); finish(); await cancelled;
  assert.equal(c.getLogin().state, 'done'); assert.equal(c.store.get('anthropic').access, credential.access); await c.close();
});
