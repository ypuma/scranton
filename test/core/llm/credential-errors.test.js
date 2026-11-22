import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyError, createLLM } from '../../../src/core/llm/index.js';
import { createCredentialStore, createOAuthProviders } from '../../../src/core/credentials/index.js';
import { fixture } from '../credentials/helpers.js';

const expired = { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: 1 };

test('network failure during credential refresh remains transient at the LLM boundary', async (t) => {
  const f = fixture(t), c = await f.create({ oauth: createOAuthProviders({ fetcher: async () => { throw new TypeError('FAKE_SECRET network failure'); } }) });
  t.after(() => c.close()); await c.store.set('anthropic', expired);
  await assert.rejects(c.resolveAuth('anthropic'), (error) => {
    const result = classifyError(error);
    assert.equal(result.code, 'SCRANTON_OAUTH_TEMPORARY'); assert.equal(result.transient, true);
    assert.ok(!result.message.includes('FAKE_SECRET')); return true;
  });
});

test('actual credential lock contention is transient', async (t) => {
  const f = fixture(t), store = createCredentialStore({ dir: f.target, lockTimeoutMs: 25 });
  const c = await f.create({ store }); t.after(() => c.close()); await store.set('anthropic', expired);
  const lock = path.join(f.target, '.lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, `${process.pid}-11111111-1111-1111-1111-111111111111`), '');
  await assert.rejects(c.resolveAuth('anthropic'), (error) => {
    assert.equal(error.code, 'SCRANTON_CREDENTIAL_LOCKED'); assert.equal(classifyError(error).transient, true); return true;
  });
});

test('missing credentials produce an actionable permanent assistant error', async (t) => {
  const c = await fixture(t).create(); t.after(() => c.close());
  const llm = createLLM({ resolveAuth: c.resolveAuth, fetcher: () => { throw Error('must not fetch'); } });
  const result = await llm.complete({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, { messages: [] });
  assert.equal(result.error.code, 'SCRANTON_AUTH_MISSING'); assert.equal(result.error.transient, false);
  assert.match(result.error.message, /credentials.*(sign in|API key)/i);
});

test('all permanent credential codes stay permanent and redact diagnostics', () => {
  for (const code of ['SCRANTON_AUTH_MISSING', 'SCRANTON_OAUTH_REJECTED', 'SCRANTON_CREDENTIAL_INVALID', 'SCRANTON_CREDENTIAL_STORE',
    'SCRANTON_AUTH_ABORTED', 'SCRANTON_AUTH_LOGIN', 'SCRANTON_AUTH_URL', 'SCRANTON_AUTH_BROWSER', 'SCRANTON_OAUTH_DENIED', 'SCRANTON_PROVIDER_INVALID', 'SCRANTON_PROVIDER_CONFLICT']) {
    const result = classifyError(Object.assign(Error('FAKE_SECRET'), { code }));
    assert.equal(result.transient, false, code); assert.ok(!result.message.includes('FAKE_SECRET'));
  }
});
