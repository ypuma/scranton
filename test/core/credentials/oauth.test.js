import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createOAuthProviders, openAuthBrowser, validateAuthUrl, isRefreshRejection } from '../../../src/core/credentials/index.js';
import { server, json, jwt, callbackPort } from './helpers.js';

for (const provider of ['anthropic', 'openai']) for (const mode of ['callback', 'manual']) {
  test(`${provider} S256 ${mode} sign-in exchanges a bound verifier and state`, async (t) => {
    let authUrl, posted;
    const fake = await server(t, (req, res, body) => {
      posted = provider === 'anthropic' ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      assert.equal(createHash('sha256').update(posted.code_verifier).digest('base64url'), authUrl.searchParams.get('code_challenge'));
      assert.equal(posted.code, 'FAKE_CODE'); assert.equal(posted.redirect_uri, authUrl.searchParams.get('redirect_uri'));
      json(res, { access_token: provider === 'openai' ? jwt() : 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: 'FAKE_ID' });
    });
    const port = await callbackPort(), redirectUri = `http://127.0.0.1:${port}/callback`;
    const oauth = createOAuthProviders({ endpoints: { [provider]: { tokenUrl: fake.url, directTokenUrl: fake.url, authorizeUrl: `${fake.url}/authorize`, redirectUri } } });
    const controller = new AbortController(); t.after(() => controller.abort());
    let callbackTask;
    const credential = await oauth[provider].login({ signal: controller.signal,
      notify(event) {
        if (event.type !== 'auth_url') return;
        authUrl = new URL(event.url); assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
        if (mode === 'callback') callbackTask = (async () => {
          const wrong = await fetch(`${redirectUri}?code=WRONG&state=WRONG`); assert.equal(wrong.status, 400);
          const right = await fetch(`${redirectUri}?code=FAKE_CODE&client_id=issued-client&state=${authUrl.searchParams.get('state')}`); assert.equal(right.status, 200);
        })();
      },
      prompt: ({ signal }) => mode === 'manual' ? Promise.resolve(provider === 'anthropic' ? `FAKE_CODE#${authUrl.searchParams.get('state')}` : `${redirectUri}?code=FAKE_CODE&client_id=issued-client&state=${authUrl.searchParams.get('state')}`)
        : new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))
    });
    await callbackTask;
    assert.equal(credential.type, 'oauth'); assert.equal(credential.refresh, 'FAKE_REFRESH');
    if (provider === 'openai') { assert.equal(credential.clientId, 'issued-client'); assert.equal(credential.grantKind, 'direct'); }
    assert.ok(posted.code_verifier.length >= 43);
  });
}

test('occupied callback listener still permits a manual redirect; invalid state is retried', async (t) => {
  const fake = await server(t, (_req, res) => json(res, { access_token: jwt(), refresh_token: 'REFRESH', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: 'FAKE_ID' }));
  let authUrl, prompts = 0;
  const oauth = createOAuthProviders({ endpoints: { openai: { tokenUrl: fake.url, directTokenUrl: fake.url, authorizeUrl: fake.url, redirectUri: `${fake.url}/callback` } } });
  const c = await oauth.openai.login({ signal: new AbortController().signal, notify: (e) => { if (e.type === 'auth_url') authUrl = new URL(e.url); }, prompt: async () => {
    prompts++; return `${fake.url}/callback?code=CODE&client_id=issued-client&state=${prompts === 1 ? 'WRONG' : authUrl.searchParams.get('state')}`;
  } });
  assert.equal(prompts, 2); assert.equal(c.clientId, 'issued-client');
});

test('OpenAI device grant handles pending and slow_down then exchanges its verifier', async (t) => {
  let polls = 0, deviceEvent, exchanged;
  const fake = await server(t, (req, res, body) => {
    if (req.url === '/device') return json(res, { device_auth_id: 'DEVICE_ID', user_code: 'USER_CODE', interval: 0 });
    if (req.url === '/poll') {
      polls++;
      if (polls === 1) return json(res, {}, 403);
      if (polls === 2) return json(res, { error: 'slow_down' }, 400);
      return json(res, { authorization_code: 'DEVICE_CODE', code_verifier: 'DEVICE_VERIFIER' });
    }
    exchanged = Object.fromEntries(new URLSearchParams(body)); json(res, { access_token: jwt(), refresh_token: 'REFRESH', expires_in: 3600 });
  });
  const oauth = createOAuthProviders({ endpoints: { openai: { deviceUrl: `${fake.url}/device`, pollUrl: `${fake.url}/poll`, tokenUrl: `${fake.url}/token`, verificationUri: `${fake.url}/verify` } } });
  const c = await oauth.openai.login({ signal: new AbortController().signal, notify: (e) => { deviceEvent = e; } }, { method: 'device_code' });
  assert.equal(polls, 3); assert.equal(deviceEvent.userCode, 'USER_CODE'); assert.equal(exchanged.code_verifier, 'DEVICE_VERIFIER'); assert.equal(c.accountId, 'fake-account');
});

test('abort closes callback and cancels manual input without sending token request', async (t) => {
  let calls = 0;
  const port = await callbackPort(), controller = new AbortController();
  const oauth = createOAuthProviders({ fetcher: async () => { calls++; throw Error('must not fetch'); }, endpoints: { anthropic: { redirectUri: `http://127.0.0.1:${port}/callback` } } });
  await assert.rejects(oauth.anthropic.login({ signal: controller.signal,
    notify: () => controller.abort(), prompt: () => new Promise(() => {}) }), { code: 'SCRANTON_AUTH_ABORTED' });
  assert.equal(calls, 0);
  const replacement = await server(t, (_req, res) => res.end());
  assert.ok(replacement.url);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`));
});

test('token failures are redacted and permanent rejection requires refresh-specific status or grant evidence', async (t) => {
  let status = 400;
  const fake = await server(t, (_req, res) => json(res, { error: 'FAKE_ACCESS FAKE_REFRESH invalid_grant' }, status));
  const oauth = createOAuthProviders({ endpoints: { anthropic: { tokenUrl: fake.url }, openai: { directTokenUrl: fake.url } } });
  const c = { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: 0 };
  for (const code of [400, 401, 500, 403]) {
    status = code;
    await assert.rejects(oauth.anthropic.refresh(c), (error) => {
      assert.equal(isRefreshRejection('anthropic', error), [400, 401].includes(code));
      assert.ok(!String(error.stack).includes('FAKE_')); return true;
    });
  }
  await assert.rejects(oauth.openai.refresh(c), (e) => isRefreshRejection('openai', e));
  assert.equal(isRefreshRejection('openai', Error('invalid_grant FAKE_SECRET')), false);
  const network = createOAuthProviders({ fetcher: async () => { throw Error('invalid_grant FAKE_SECRET'); } });
  await assert.rejects(network.anthropic.refresh(c), (e) => !isRefreshRejection('anthropic', e) && !e.message.includes('FAKE_SECRET'));
});

test('direct ChatGPT imports require issued client ID and direct scope, unlike Codex grants', async (t) => {
  let scope = 'openid';
  const fake = await server(t, (_req, res) => json(res, { access_token: 'DIRECT_ACCESS', refresh_token: 'DIRECT_REFRESH', expires_in: 3600, scope }));
  const oauth = createOAuthProviders({ endpoints: { openai: { directTokenUrl: fake.url } } });
  const c = { type: 'oauth', clientId: 'issued-client', access: 'OLD', refresh: 'REFRESH', expires: 0 };
  await assert.rejects(oauth.openai.refresh(c), (e) => isRefreshRejection('openai', e));
  scope += ' chatgpt.tokens.use.direct';
  assert.equal((await oauth.openai.refresh(c)).clientId, 'issued-client');
});

test('Antigravity reuses existing OAuth and provisions a genuine fake-server project', async (t) => {
  let authUrl, projectCalls = 0;
  const fake = await server(t, (req, res) => {
    if (req.url === '/token') return json(res, { access_token: 'GOOGLE_ACCESS', refresh_token: 'GOOGLE_REFRESH', expires_in: 3600 });
    projectCalls++; json(res, { cloudaicompanionProject: { id: 'fake-project' } });
  });
  const redirectUri = `http://127.0.0.1:${await callbackPort()}/oauth-callback`;
  const oauth = createOAuthProviders({ antigravity: { redirectUri }, fetcher: (url, init) => fetch(url.includes('/token') ? `${fake.url}/token` : `${fake.url}/project`, init) });
  const c = await oauth['google-antigravity'].login({ signal: new AbortController().signal, notify: (e) => { authUrl = new URL(e.url); },
    prompt: async () => `${redirectUri}?code=FAKE_CODE&client_id=issued-client&state=${authUrl.searchParams.get('state')}` });
  assert.equal(c.projectId, 'fake-project'); assert.equal(projectCalls, 1);
  const refreshed = await oauth['google-antigravity'].refresh(c); assert.equal(refreshed.projectId, 'fake-project');
});

test('browser opener validates host, uses argv only and returns on spawn, sanitizing errors', async () => {
  for (const url of ['http://claude.ai/', 'https://evil.test/', 'https://claude.ai:444/', 'https://user:secret@claude.ai/', 'https://claude.ai/?token=SECRET']) assert.throws(() => validateAuthUrl('anthropic', url));
  let command, args, options;
  await openAuthBrowser('anthropic', 'https://claude.ai/oauth/authorize?state=STATE', { platform: 'win32', runner: (c, a, o) => {
    command = c; args = a; options = o; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  assert.equal(command, 'rundll32.exe'); assert.equal(args.length, 2); assert.equal(options.shell, false);
  await assert.rejects(openAuthBrowser('openai', 'https://auth.openai.com/', { runner: () => { throw Error('SECRET'); } }), (e) => !e.stack.includes('SECRET'));
});
