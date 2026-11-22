import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createOAuthProviders } from '../../../src/core/credentials/index.js';
import { fixture, callbackPort } from './helpers.js';

const credential = { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: 1 };

test('resolved auth projects only client fields for keys, fresh tokens and refreshed tokens', async (t) => {
  const c = await fixture(t).create({ oauth: { anthropic: { refresh: async () => ({ ...credential, expires: Date.now() + 3600000, privateMetadata: { refresh: 'FAKE_REFRESH' } }) } } });
  t.after(() => c.close());
  await c.store.set('anthropic', credential);
  assert.deepEqual(await c.resolveAuth('anthropic'), { type: 'oauth', access: 'FAKE_ACCESS' });
  assert.deepEqual(await c.resolveAuth('anthropic'), { type: 'oauth', access: 'FAKE_ACCESS' });
  assert.equal(c.store.get('anthropic').refresh, 'FAKE_REFRESH');
  await c.store.set('openai', { ...credential, expires: Date.now() + 3600000, accountId: 'account', clientId: 'private-client', scopes: ['private-scope'] });
  assert.deepEqual(await c.resolveAuth('openai'), { type: 'oauth', access: 'FAKE_ACCESS', accountId: 'account', mode: 'chatgpt' });
  await c.store.set('google-antigravity', { ...credential, expires: Date.now() + 3600000, projectId: 'project' });
  assert.deepEqual(await c.resolveAuth('google-antigravity'), { type: 'oauth', access: 'FAKE_ACCESS', projectId: 'project' });
  await c.store.set('google', { type: 'api_key', key: 'FAKE_KEY', refresh: 'UNEXPECTED_SECRET' });
  assert.deepEqual(await c.resolveAuth('google'), { type: 'api_key', key: 'FAKE_KEY' });
});

test('valid OAuth resolve takes no transaction and leaves store mtime unchanged', async (t) => {
  const c = await fixture(t).create(); t.after(() => c.close());
  await c.store.set('anthropic', { ...credential, expires: Date.now() + 3600000 });
  fs.utimesSync(c.store.file, new Date(1000000000000), new Date(1000000000000));
  const before = fs.statSync(c.store.file).mtimeMs, transaction = c.store.transaction; let locks = 0;
  c.store.transaction = (...args) => { locks++; return transaction(...args); };
  await c.resolveAuth('anthropic');
  assert.equal(locks, 0); assert.equal(fs.statSync(c.store.file).mtimeMs, before);
});

test('Anthropic manual paste rejects absent, wrong and extra state before exchanging', async (t) => {
  let authUrl, prompts = 0, requests = 0;
  const oauth = createOAuthProviders({ fetcher: async () => { requests++; return Response.json({ access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH', expires_in: 3600 }); },
    endpoints: { anthropic: { redirectUri: `http://127.0.0.1:${await callbackPort()}/callback` } } });
  const c = await oauth.anthropic.login({ signal: new AbortController().signal,
    notify: (e) => { if (e.type === 'auth_url') authUrl = new URL(e.url); },
    prompt: async ({ message }) => {
      prompts++;
      if (prompts > 1) { assert.equal(requests, 0); assert.match(message, /state/i); }
      const state = authUrl.searchParams.get('state');
      return ['CODE', 'CODE#WRONG', `CODE#${state}#EXTRA`, `CODE#${state}`][prompts - 1];
    }
  });
  assert.equal(prompts, 4); assert.equal(requests, 1); assert.equal(c.access, 'FAKE_ACCESS');
});

test('under-lock re-read observes a concurrent refresh without rewriting its fresh credential', async (t) => {
  const c = await fixture(t).create({ oauth: { anthropic: { refresh: async () => { throw Error('must not refresh'); } } } }); t.after(() => c.close());
  await c.store.set('anthropic', { ...credential, expires: Date.now() + 3600000 });
  fs.utimesSync(c.store.file, new Date(1000000000000), new Date(1000000000000));
  const before = fs.statSync(c.store.file).mtimeMs, read = c.store.read; let reads = 0;
  c.store.read = () => {
    const data = read();
    if (reads++ === 0) data.credentials.anthropic = credential;
    return data;
  };
  assert.deepEqual(await c.resolveAuth('anthropic'), { type: 'oauth', access: 'FAKE_ACCESS' });
  assert.equal(fs.statSync(c.store.file).mtimeMs, before);
});
