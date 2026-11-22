import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createAuthService } from '../../src/core/auth.js';

const KEY = 'FAKE_REVIEW_KEY';
const definition = { id: 'review-custom', label: 'Review', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'test-model' }] };
function fixture(t, options = {}) {
  const root = path.resolve('.scratch/auth-port/review'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-')), file = path.join(dir, 'store.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, credentials: {}, providers: {}, renewals: {}, deviceId: 'fixture', import: { at: 'fixture' } }));
  const auth = createAuthService({ env: { SCRANTON_CREDENTIALS_DIR: dir }, ...options });
  t.after(async () => { await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, auth };
}
test('legacy provider files are not read or rewritten after one-time import', async (t) => {
  const f = fixture(t);
  for (const name of ['models.json', 'scranton-providers.json']) fs.writeFileSync(path.join(f.dir, name), '// foreign broken config');
  await f.auth.addProvider({ ...definition, key: KEY });
  assert.equal((await f.auth.listModels()).providers[0].id, definition.id);
  for (const name of ['models.json', 'scranton-providers.json']) assert.equal(fs.readFileSync(path.join(f.dir, name), 'utf8'), '// foreign broken config');
});
test('damaged own store fails closed without overwriting bytes', async (t) => {
  const f = fixture(t); await f.auth.listModels(); fs.writeFileSync(f.file, '{broken');
  assert.equal(f.auth.listAccounts()[0].status, 'error');
  await assert.rejects(f.auth.setApiKey('google', KEY));
  await assert.rejects(f.auth.logout('google'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});
test('failed provider transaction leaves neither definition nor credential; retry succeeds', async (t) => {
  const f = fixture(t); await f.auth.listModels();
  const original = fs.readFileSync(f.file);
  await assert.rejects(f.auth.addProvider({ ...definition, models: [{ id: 'bad model' }], key: KEY }));
  assert.deepEqual(fs.readFileSync(f.file), original);
  await f.auth.addProvider({ ...definition, key: KEY });
  const data = JSON.parse(fs.readFileSync(f.file));
  assert.equal(data.providers[definition.id].id, definition.id); assert.equal(data.credentials[definition.id].key, KEY);
});
test('duplicate provider add never replaces a managed definition or key', async (t) => {
  const f = fixture(t); await f.auth.addProvider({ ...definition, key: KEY });
  const original = fs.readFileSync(f.file);
  await assert.rejects(f.auth.addProvider({ ...definition, key: 'REPLACEMENT' }), { status: 409 });
  assert.deepEqual(fs.readFileSync(f.file), original);
});
test('dead PID claim is recovered for own-store mutations', async (t) => {
  const f = fixture(t); await f.auth.listModels(); const lock = path.join(f.dir, '.lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, '2147483647-00000000-0000-4000-8000-000000000000'), '');
  await f.auth.addProvider({ ...definition, key: KEY });
  assert.equal(fs.existsSync(lock), false); await f.auth.removeProvider(definition.id);
});
test('supported built-in IDs cannot be shadowed by custom providers', async (t) => {
  const f = fixture(t);
  for (const id of ['anthropic', 'openai', 'google', 'google-antigravity']) await assert.rejects(f.auth.addProvider({ ...definition, id, key: KEY }), { status: 400 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).providers, {});
});
test('custom add refuses unmanaged credentials without changing bytes', async (t) => {
  for (const credential of [{ type: 'api_key', key: 'FOREIGN' }, null]) {
    const f = fixture(t); await f.auth.listModels(); const data = JSON.parse(fs.readFileSync(f.file)); data.credentials[definition.id] = credential;
    fs.writeFileSync(f.file, JSON.stringify(data)); const original = fs.readFileSync(f.file);
    await assert.rejects(f.auth.addProvider({ ...definition, key: KEY }), { status: 409 }); assert.deepEqual(fs.readFileSync(f.file), original);
  }
});
test('auth facade has no container credential projection', async (t) => {
  const f = fixture(t); await f.auth.setApiKey('google', KEY); await f.auth.setApiKey('openai', 'OTHER_KEY');
  assert.equal(f.auth.resolveDockerCredential, undefined);
  assert.ok(!JSON.stringify(await f.auth.listModels()).includes(KEY));
});
test('unsupported key providers require an explicit custom declaration', async (t) => {
  const f = fixture(t);
  assert.equal(f.auth.listProviders().providers.some((p) => p.id === 'deepseek'), false);
  await assert.rejects(f.auth.setApiKey('deepseek', KEY), { status: 400 });
  await f.auth.addProvider({ ...definition, id: 'deepseek', key: KEY });
  assert.equal((await f.auth.listModels()).providers[0].id, 'deepseek');
});
test('unknown removals retain the established HTTP conflict status', async (t) => {
  const f = fixture(t); await assert.rejects(f.auth.removeProvider('unknown'), { status: 409 });
});

test('trimmed key cannot leak through declared provider metadata', async (t) => {
  const f = fixture(t); await f.auth.listModels(); const before = fs.readFileSync(f.file);
  await assert.rejects(f.auth.addProvider({ ...definition, label: KEY, key: ` ${KEY} ` }), { status: 400 });
  assert.deepEqual(fs.readFileSync(f.file), before);
});
