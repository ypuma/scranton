import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { PassThrough } from 'node:stream';

import { parseRedirect } from '../../src/core/antigravity/oauth.js';

import { createAuthService, validateAuthUrl } from '../../src/core/auth.js';
import { createOAuthProviders } from '../../src/core/credentials/index.js';
import { models } from '../../src/core/llm/catalogue.js';
import { runCli } from '../../src/core/cli.js';

const ACCESS = 'FAKE_ANTIGRAVITY_ACCESS', REFRESH = 'FAKE_ANTIGRAVITY_REFRESH';
const credential = () => ({ type: 'oauth', access: ACCESS, refresh: REFRESH, projectId: 'test-project', expires: Date.now() + 3600000 });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function dir(t) {
  const root = path.resolve('.scratch/auth-port/antigravity'); fs.mkdirSync(root, { recursive: true });
  const value = fs.mkdtempSync(path.join(root, 'case-')); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value;
}
function io(options = {}) {
  let url;
  return { signal: new AbortController().signal, notify: (e) => { if (e.type === 'auth_url') url = new URL(e.url); },
    prompt: async () => `http://localhost:0/oauth-callback?code=FAKE_CODE&state=${url.searchParams.get('state')}`, ...options };
}

test('Antigravity OAuth validates PKCE, stores separate project and preserves refresh rotation', async () => {
  let authUrl, calls = [];
  const p = createOAuthProviders({ antigravity: { redirectUri: 'http://localhost:0/oauth-callback' }, now: () => 1000, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/token')) return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer' });
    return json({ cloudaicompanionProject: { id: 'test-project' } });
  } });
  const interaction = io({ notify: (e) => { authUrl = new URL(e.url); }, prompt: async () => `http://localhost:0/oauth-callback?code=FAKE_CODE&state=${authUrl.searchParams.get('state')}` });
  const c = await p['google-antigravity'].login(interaction);
  assert.equal(c.projectId, 'test-project'); assert.equal(c.refresh, REFRESH); assert.equal(c.expires, 3541000);
  assert.equal(authUrl.origin, 'https://accounts.google.com'); assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const body = calls[0].init.body;
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
  assert.notEqual(body.get('code_verifier'), authUrl.searchParams.get('state'));
  assert.equal(calls[1].init.redirect, 'error'); assert.equal(calls[1].init.headers.Authorization, `Bearer ${ACCESS}`);
  const refresh = createOAuthProviders({ now: () => 1000, fetcher: async (_url, init) => { assert.equal(init.body.get('refresh_token'), REFRESH); return json({ access_token: 'NEW_ACCESS', expires_in: 3600 }); } });
  const updated = await refresh['google-antigravity'].refresh(c, new AbortController().signal);
  assert.equal(updated.refresh, REFRESH); assert.equal(updated.projectId, c.projectId); assert.equal(updated.access, 'NEW_ACCESS');
  assert.equal(updated.type, 'oauth');
});

test('rejects wrong state, redirect, duplicate code and unsafe authorization origins', () => {
  const base = 'http://localhost:51121/oauth-callback';
  assert.equal(parseRedirect(`${base}?state=correct&code=ok`, base, 'correct'), 'ok');
  for (const value of [`${base}?state=wrong&code=ok`, `${base}?state=correct&code=a&code=b`, `${base}?state=correct&code=a#hash`, `${base}?state=correct&code=a&state=correct`, 'ok', 'https://evil.test/?state=correct&code=a', `${base}/other?state=correct&code=a`]) assert.throws(() => parseRedirect(value, base, 'correct'));
  assert.equal(validateAuthUrl('google-antigravity', 'https://accounts.google.com/o/oauth2/v2/auth?state=abc'), 'https://accounts.google.com/o/oauth2/v2/auth?state=abc');
  for (const url of ['http://accounts.google.com', 'https://accounts.google.com.evil.test', 'https://evil@accounts.google.com', 'https://accounts.google.com:444', 'https://accounts.google.com/#x', 'https://accounts.google.com/?access_token=secret']) assert.throws(() => validateAuthUrl('google-antigravity', url));
});

test('OAuth cancel closes callback even if prompt ignores signal; missing account project fails closed', async () => {
  const controller = new AbortController(); let requests = 0;
  const p = createOAuthProviders({ antigravity: { redirectUri: 'http://localhost:0/oauth-callback' }, fetcher: async () => { requests++; throw Error(); } });
  await assert.rejects(p['google-antigravity'].login(io({ signal: controller.signal, prompt: () => { controller.abort(); return new Promise(() => {}); } })), /cancelled/i);
  assert.equal(requests, 0);
  const noProject = createOAuthProviders({ antigravity: { redirectUri: 'http://localhost:0/oauth-callback' }, fetcher: async (url) => url.includes('/token') ? json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }) : json({}) });
  await assert.rejects(noProject['google-antigravity'].login(io()), /Sign-in failed/);
});

function storeFile(root, credentials) {
  const file = path.join(root, 'store.json');
  fs.writeFileSync(file, JSON.stringify({version:1,credentials,providers:{},renewals:{},deviceId:'fixture',import:{at:'fixture'}}));
  return file;
}
test('own store refreshes Antigravity once under lock and returns a raw OAuth access token', async (t) => {
  const root = dir(t); let count = 0;
  const file = storeFile(root, {google:{type:'api_key',key:'FAKE_GEMINI_KEY'}, 'google-antigravity':{...credential(), expires:1}});
  const oauth = createOAuthProviders({fetcher: async () => {count++; return json({access_token:ACCESS, expires_in:3600});}});
  const service = createAuthService({env:{SCRANTON_CREDENTIALS_DIR:root}, oauth}); t.after(() => service.close());
  assert.deepEqual(service.listProviders().providers.find((p) => p.id === 'google-antigravity').methods, ['oauth']);
  assert.equal((await service.listModels()).providers.find((p) => p.id === 'google-antigravity').models.length, 2);
  assert.equal(count, 0);
  const keys = await Promise.all([service.mintAccessToken('google-antigravity', {minExpiryMs:0}), service.mintAccessToken('google-antigravity', {minExpiryMs:0})]);
  assert.equal(count, 1); assert.deepEqual(keys, [ACCESS, ACCESS]);
  assert.ok(!JSON.stringify(service.listAccounts()).includes(ACCESS));
  await assert.rejects(service.setApiKey('google-antigravity', 'FAKE_KEY'), /does not support API keys/);
  await service.logout('google-antigravity'); assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file)).credentials), ['google']);
});

test('Antigravity credentials remain host-only with no Docker export API', async (t) => {
  const root = dir(t); storeFile(root, {}); const service = createAuthService({ env: { SCRANTON_CREDENTIALS_DIR: root } }); t.after(() => service.close());
  assert.equal(service.resolveDockerCredential, undefined);
});

test('CLI Antigravity OAuth alias and Google/Gemini key login/logout remain separate', async (t) => {
  const root = dir(t), calls = []; let session;
  const auth = { startLogin: (p) => { calls.push(['oauth', p]); session = { id: 'test', state: 'done' }; return session; }, getLogin: () => session, waitForLogin: async () => session, close: async () => {},
    setApiKey: async (p) => calls.push(['key', p]), logout: async (p) => calls.push(['logout', p]) };
  for (const args of [['login', 'antigravity'], ['login', 'google-antigravity'], ['login', 'google'], ['login', 'gemini'], ['login', 'google', '--api-key'], ['logout', 'google'], ['logout', 'antigravity']]) {
    const stdin = new PassThrough(); stdin.end('FAKE_KEY\n');
    assert.equal(await runCli(args, { cwd: root, env: {}, stdin, stdout: { write() {} }, stderr: { write() {} }, auth }), 0);
  }
  assert.deepEqual(calls, [['oauth', 'google-antigravity'], ['oauth', 'google-antigravity'], ['key', 'google'], ['key', 'google'], ['key', 'google'], ['logout', 'google'], ['logout', 'google-antigravity']]);
});

test('Antigravity catalogue is offline', async () => {
  assert.equal(models.filter((m) => m.provider === 'google-antigravity').length, 2);


});

test('auth-service Antigravity lifecycle uses own store, saves only after valid state, and sanitizes setup errors', async (t) => {
  for (const mode of ['success', 'wrong-state', 'cancel', 'timeout', 'no-project']) {
    const root = dir(t); let requests = 0;
    const authPath = storeFile(root, {google:{type:'api_key', key:'FAKE_GEMINI_KEY'}});
    const oauth = createOAuthProviders({antigravity:{redirectUri:'http://localhost:0/oauth-callback'}, fetcher:async (url) => {
      requests++; return url.includes('/token') ? json({access_token:ACCESS,refresh_token:REFRESH,expires_in:3600}) : json(mode === 'no-project' ? {} : {cloudaicompanionProject:'test-project'});
    }});
    const service = createAuthService({env:{SCRANTON_CREDENTIALS_DIR:root}, opener:async () => {}, oauth, timeoutMs:mode === 'timeout' ? 40 : 30000});
    const { id } = service.startLogin('google-antigravity');
    assert.throws(() => service.startLogin('anthropic'), { status: 409 });
    for (let n = 0; n < 100 && service.getLogin().state !== 'waiting_code'; n++) await new Promise((r) => setTimeout(r, 2));
    if (mode === 'cancel') await service.cancel(id);
    else if (mode !== 'timeout') {
      const url = new URL(service.getLogin().authUrl);
      service.input(id, `http://localhost:0/oauth-callback?code=FAKE_CODE&state=${mode === 'wrong-state' ? 'wrong' : url.searchParams.get('state')}`);
    }
    if (mode === 'wrong-state') {
      for (let n = 0; n < 100 && service.getLogin().state !== 'waiting_code'; n++) await new Promise((r) => setTimeout(r, 2));
      assert.equal(service.getLogin().state, 'waiting_code');
      assert.match(service.getLogin().message, /complete redirect URL.*state.*not a bare code/);
      await service.cancel(id);
    }
    const result = await service.waitForLogin();
    assert.equal(result.state, mode === 'success' ? 'done' : ['cancel', 'wrong-state'].includes(mode) ? 'cancelled' : 'failed');
    const data = JSON.parse(fs.readFileSync(authPath)).credentials; assert.equal(data.google.key, 'FAKE_GEMINI_KEY');
    assert.equal(Boolean(data['google-antigravity']), mode === 'success');
    if (['cancel', 'timeout', 'wrong-state'].includes(mode)) assert.equal(requests, 0);
    if (mode === 'no-project') assert.match(result.error, /Sign-in failed/);
    assert.ok(!JSON.stringify(service.listAccounts()).includes(ACCESS)); assert.ok(!JSON.stringify(result).includes(REFRESH));
    await service.close();
  }
});

test('refresh HTTP rejection is classified as expired but transient failure stays renewable; no error body leaks', async (t) => {
  for (const status of [400, 401, 500]) {
    const root = dir(t), authPath = storeFile(root, {'google-antigravity':{...credential(),expires:1}});
    const oauth = createOAuthProviders({fetcher:async () => new Response(ACCESS + REFRESH, {status})});
    const service = createAuthService({env:{SCRANTON_CREDENTIALS_DIR:root}, oauth});
    await assert.rejects(service.mintAccessToken('google-antigravity', { minExpiryMs: 0 }), { code: status < 500 ? 'SCRANTON_OAUTH_REJECTED' : 'SCRANTON_OAUTH_TEMPORARY' });
    const account = service.listAccounts().find((a) => a.id === 'google-antigravity'); assert.equal(account.status, status < 500 ? 'expired' : 'signed_in');
    assert.ok(!JSON.stringify(account).includes(ACCESS)); assert.equal(JSON.parse(fs.readFileSync(authPath)).credentials['google-antigravity'].refresh, REFRESH);
    await service.close();
  }
});

test('invalid manual redirects retry with the same authorization URL, state and PKCE until valid', async () => {
  let url, prompts = 0, notifications = 0, tokenCalls = 0;
  const p = createOAuthProviders({ antigravity: { redirectUri: 'http://localhost:0/oauth-callback' }, fetcher: async (target, init) => {
    if (target.includes('/token')) {
      tokenCalls++;
      assert.equal(createHash('sha256').update(init.body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
      return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
    }
    return json({ cloudaicompanionProject: 'test-project' });
  } });
  const result = await p['google-antigravity'].login(io({ notify: (event) => { notifications++; url = new URL(event.url); }, prompt: async (request) => {
    assert.match(request.message, /complete redirect URL.*code and state.*not a bare code/);
    const values = ['BARE_CODE', `http://localhost:0/oauth-callback?code=FAKE_CODE&state=wrong`, `http://localhost:0/oauth-callback?code=FAKE_CODE&state=${url.searchParams.get('state')}`];
    assert.ok(prompts < values.length); return values[prompts++];
  } }));
  assert.equal(result.projectId, 'test-project'); assert.equal(prompts, 3); assert.equal(notifications, 1); assert.equal(tokenCalls, 1);
});

test('actual local callback ignores wrong-state denial, rejects consent denial and closes listener without exchanging tokens', { timeout: 5000 }, async (t) => {
  const controller = new AbortController(); t.after(() => controller.abort());
  const http = await import('node:http');
  const reservation = http.createServer(); await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
  let ready; const notified = new Promise((resolve) => { ready = resolve; }); let requests = 0, settled = false;
  const p = createOAuthProviders({ antigravity: { redirectUri }, fetcher: async () => { requests++; throw Error('must not exchange'); } });
  const pending = p['google-antigravity'].login(io({ signal: controller.signal, notify: (event) => ready(new URL(event.url)), prompt: () => new Promise(() => {}) }));
  const rejected = assert.rejects(pending.finally(() => { settled = true; }), { code: 'SCRANTON_AUTH_LOGIN' });
  const url = await notified;
  const wrong = await fetch(`${redirectUri}?state=wrong&error=access_denied`); assert.equal(wrong.status, 400); await wrong.text(); assert.equal(settled, false);
  const denied = await fetch(`${redirectUri}?state=${url.searchParams.get('state')}&error=access_denied`); assert.equal(denied.status, 400); await denied.text();
  await rejected; assert.equal(requests, 0);
  await assert.rejects(fetch(redirectUri));
});
