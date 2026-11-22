import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createCredentialStore, credentialsDirectory } from '../../../src/core/credentials/index.js';
import { fixture, child } from './helpers.js';

const oauth = { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: 1700000000000 };
const definition = { id: 'custom-local', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'model', name: 'Ignored' }] };

test('node:test refuses every implicit user directory even with a stripped env', () => {
  for (const platform of ['win32', 'darwin', 'linux']) assert.throws(() => credentialsDirectory({ platform, home: '/home/test', env: { APPDATA: '/roaming', XDG_DATA_HOME: '/xdg' } }), { code: 'SCRANTON_CREDENTIAL_STORE', message: 'Credential directory required under node:test; set dir or SCRANTON_CREDENTIALS_DIR in the supplied env' });
  assert.throws(() => createCredentialStore({ env: {} }), { code: 'SCRANTON_CREDENTIAL_STORE' });
  assert.equal(credentialsDirectory({ env: { SCRANTON_CREDENTIALS_DIR: '.scratch/credentials-tests/override' } }), path.resolve('.scratch/credentials-tests/override'));
});

test('one-time import of JSONC credentials, custom providers, literal and env keys; source remains byte-identical', async (t) => {
  const f = fixture(t);
  const records = { anthropic: oauth, openai: { ...oauth, clientId: 'issued', scopes: ['chatgpt.tokens.use.direct'] }, 'google-antigravity': { ...oauth, projectId: 'project' }, google: { type: 'api_key', key: 'FAKE_GOOGLE' } };
  const auth = '\uFEFF// note\n' + JSON.stringify(records).replace(/}$/, ',}');
  const models = '// models\n' + JSON.stringify({ providers: {
    'custom-local': { ...definition, name: 'Custom', apiKey: 'FAKE_CUSTOM' },
    'custom-env': { ...definition, apiKey: '$IMPORT_KEY' }
  } }).replace(/}$/, ',}');
  fs.writeFileSync(path.join(f.source, 'auth.json'), auth); fs.writeFileSync(path.join(f.source, 'models.json'), models);
  fs.writeFileSync(path.join(f.source, 'settings.json'), '{ invalid settings never read');
  const c = await f.create({ env: { ...f.env, IMPORT_KEY: 'FAKE_ENV' } });
  const data = c.store.read();
  assert.deepEqual(data.credentials.anthropic, oauth);
  assert.equal(data.credentials.openai.clientId, 'issued');
  assert.equal(data.credentials['google-antigravity'].projectId, 'project');
  assert.equal(data.credentials.google.key, 'FAKE_GOOGLE');
  assert.equal(data.credentials['custom-local'].key, 'FAKE_CUSTOM'); assert.equal(data.credentials['custom-env'].key, 'FAKE_ENV');
  assert.equal(data.providers['custom-local'].label, 'Custom');
  const marker = JSON.stringify(data.import); for (const secret of ['FAKE_ACCESS', 'FAKE_REFRESH', 'FAKE_CUSTOM', 'FAKE_ENV']) assert.ok(!marker.includes(secret));
  assert.equal(fs.readFileSync(path.join(f.source, 'auth.json'), 'utf8'), auth); assert.equal(fs.readFileSync(path.join(f.source, 'models.json'), 'utf8'), models);
  fs.writeFileSync(path.join(f.source, 'auth.json'), '{broken'); fs.writeFileSync(path.join(f.source, 'models.json'), '{broken');
  const next = await f.create(); assert.deepEqual(next.store.read(), data);
  await c.close(); await next.close();
});

test('import corruption fails closed without marker; malformed credential blocks env fallback', async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'auth.json'), '{broken');
  await assert.rejects(f.create(), { code: 'SCRANTON_CREDENTIAL_STORE' });
  assert.equal(fs.existsSync(path.join(f.target, 'store.json')), false);
  fs.writeFileSync(path.join(f.source, 'auth.json'), JSON.stringify({ google: null }));
  const c = await f.create({ env: { ...f.env, GEMINI_API_KEY: 'FAKE_AMBIENT' } });
  assert.equal(c.listAccounts().find((p) => p.id === 'google').status, 'error');
  await assert.rejects(c.resolveAuth('google'), { code: 'SCRANTON_CREDENTIAL_INVALID' }); await c.close();
});

test('atomic transaction rollback, corrupt-store refusal, and private POSIX modes', async (t) => {
  const f = fixture(t), c = await f.create();
  await c.setApiKey('google', 'FAKE_KEY'); const original = fs.readFileSync(c.store.file, 'utf8');
  await assert.rejects(c.store.transaction((data) => { data.credentials.google.key = 'NOT_COMMITTED'; throw Error('FAKE_SECRET'); }), (error) => !String(error.stack).includes('FAKE_SECRET'));
  assert.equal(fs.readFileSync(c.store.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(f.target).sort(), ['store.json']);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(f.target).mode & 0o777, 0o700); assert.equal(fs.statSync(c.store.file).mode & 0o777, 0o600); }
  fs.writeFileSync(c.store.file, '{broken FAKE_SECRET');
  await assert.rejects(async () => c.setApiKey('google', 'NEW_KEY'), (error) => error.code === 'SCRANTON_CREDENTIAL_STORE' && !error.message.includes('FAKE_SECRET'));
  assert.equal(fs.readFileSync(c.store.file, 'utf8'), '{broken FAKE_SECRET'); await c.close();
});

test('two process writers serialize read-modify-write and readers never see a partial JSON file', async (t) => {
  const f = fixture(t), c = await f.create(), config = path.join(f.dir, 'worker.json');
  fs.writeFileSync(config, JSON.stringify({ dir: f.target }));
  let reads = 0;
  const timer = setInterval(() => { c.store.read(); reads++; }, 1);
  try { await Promise.all([child(['write', config]), child(['write', config])]); } finally { clearInterval(timer); }
  assert.equal(c.store.read().count, 30); assert.ok(reads > 0); await c.close();
});

test('dead PID claims recover; live claims time out and uninitialized abandoned locks fail safely', async (t) => {
  const f = fixture(t), c = await f.create();
  const lock = path.join(f.target, '.lock'); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, '2147483647-11111111-1111-1111-1111-111111111111'), '');
  await c.setApiKey('google', 'RECOVERED');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, `${process.pid}-11111111-1111-1111-1111-111111111111`), '');
  const store = createCredentialStore({ dir: f.target, lockTimeoutMs: 30 });
  await assert.rejects(store.set('google', { type: 'api_key', key: 'BLOCKED' }), { code: 'SCRANTON_CREDENTIAL_LOCKED' });
  fs.rmSync(lock, { recursive: true }); fs.mkdirSync(lock);
  await assert.rejects(store.set('google', { type: 'api_key', key: 'BLOCKED' }), { code: 'SCRANTON_CREDENTIAL_LOCKED' });
  assert.equal(c.store.get('google').key, 'RECOVERED'); await c.close();
});

test('custom definition and its key commit together and removal leaves built-ins alone', async (t) => {
  const f = fixture(t), c = await f.create();
  await c.setApiKey('google', 'FAKE_GOOGLE');
  await c.addProvider({ ...definition, key: 'FAKE_CUSTOM' });
  assert.equal((await c.resolveAuth(definition.id)).key, 'FAKE_CUSTOM');
  assert.ok(!JSON.stringify(c.listAccounts()).includes('FAKE_CUSTOM'));
  await assert.rejects(async () => c.addProvider({ ...definition, id: 'anthropic', key: 'FAKE_KEY' }));
  await assert.rejects(async () => c.addProvider({ ...definition, id: 'other-provider', models: [{ id: 'FAKE_KEY' }], key: 'FAKE_KEY' }));
  await c.removeProvider(definition.id); assert.equal(c.store.get(definition.id), undefined);
  assert.equal((await c.resolveAuth('google')).key, 'FAKE_GOOGLE'); await c.close();
});

test('explicit directory permits writes but import requires an explicit source before any mutation', async t => {
  const f = fixture(t), store = createCredentialStore({ dir: f.target });
  await assert.rejects(store.initialize({ env: {}, home: f.dir }), { code: 'SCRANTON_CREDENTIAL_STORE', message: 'Pi import source required under node:test; set source in store.initialize() or PI_CODING_AGENT_DIR in the supplied env' });
  assert.equal(fs.existsSync(f.target), false);
  await store.initialize({ env: {}, source: f.source });
  await store.set('google', { type: 'api_key', key: 'EXPLICIT_FAKE' });
  assert.equal(store.get('google').key, 'EXPLICIT_FAKE');
  await store.initialize({ env: {} }); // A committed import never accesses a source again.
  assert.equal(store.read().import.source, f.source);
});

test('source override alone never permits a default credential directory', async t => {
  const f = fixture(t);
  await assert.rejects(f.create({ env: { PI_CODING_AGENT_DIR: f.source } }), { code: 'SCRANTON_CREDENTIAL_STORE' });
  const store = createCredentialStore({ env: f.env });
  await store.initialize({ env: f.env });
  assert.equal(store.dir, f.target);
});
