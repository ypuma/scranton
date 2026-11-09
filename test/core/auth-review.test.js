import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createAuthService } from '../../src/core/auth.js';
import { createProviderStore, builtinCatalog } from '../../src/core/providers.js';
import { prepareSandbox } from '../../src/core/sandbox.js';
import { runCli } from '../../src/core/cli.js';

const KEY = 'FAKE_REVIEW_KEY';
const definition = { id: 'review-custom', label: 'Review', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'test-model' }] };
function fixture(t, options = {}) {
  const root = path.resolve('.scratch/keys-fix'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'review-'));
  const file = path.join(dir, 'auth.json'), models = path.join(dir, 'models.json'), registry = path.join(dir, 'scranton-providers.json');
  const auth = createAuthService({ authPath: file, env: {}, ...options });
  t.after(async () => { await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, models, registry, auth, store: createProviderStore(dir) };
}

test('review 1: Pi comment/trailing-comma parsing on reads; comments never rewritten', async (t) => {
  const f = fixture(t);
  await f.auth.addProvider({ ...definition, key: KEY });
  const original = '// user comment\n' + fs.readFileSync(f.models, 'utf8').replace(/\n}$/, ',\n}');
  fs.writeFileSync(f.models, original);
  assert.equal(f.store.list()[0].id, definition.id);
  assert.equal((await f.auth.listAccounts()).find((p) => p.id === definition.id).status, 'signed_in');
  assert.equal((await f.auth.resolveDockerCredential(definition.id)).value, KEY);
  await assert.rejects(f.store.add({ ...definition, id: 'another' }), /comments/i);
  await assert.rejects(f.store.remove(definition.id), /comments/i);
  assert.equal(fs.readFileSync(f.models, 'utf8'), original);
});

test('review 1: damaged/unreadable models or registry do not block built-in accounts, keys, logout, Docker or CLI', async (t) => {
  for (const target of ['models', 'registry']) for (const unreadable of [false, true]) {
    const f = fixture(t);
    if (unreadable) fs.mkdirSync(f[target]); else fs.writeFileSync(f[target], '{broken');
    assert.deepEqual(f.store.list(), []);
    const accounts = await f.auth.listAccounts();
    assert.equal(accounts[0].id, 'anthropic');
    assert.match(accounts[0].detail, /custom provider configuration/i);
    await f.auth.setApiKey('google', KEY);
    assert.equal((await f.auth.resolveDockerCredential('google')).value, KEY);
    fs.writeFileSync(f.file, JSON.stringify({ anthropic: { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 } }));
    const oauth = createAuthService({ authPath: f.file, env: {}, runtimeFactory: async () => ({ getAuth: async () => ({ source: 'OAuth', auth: { apiKey: 'FAKE_TOKEN' } }) }) });
    assert.equal((await oauth.resolveDockerCredential('anthropic', { minExpiryMs: 0 })).value, 'FAKE_TOKEN');
    await f.auth.logout('anthropic');
    let text = ''; const output = { write: (s) => { text += s; } };
    assert.equal(await runCli(['accounts'], { cwd: f.dir, env: {}, auth: f.auth, stdout: output, stderr: output }), 0);
    assert.match(text, /custom provider configuration/i);
    await assert.rejects(f.store.add(definition), { status: 409 });
    await assert.rejects(f.store.remove(definition.id), { status: 409 });
    assert.ok(!text.includes(KEY));
  }
});

test('review 2: failed key save/reload leaves no stranded definition and retry succeeds', async (t) => {
  for (const stage of ['login', 'refresh']) {
    let fail = true, f;
    f = fixture(t, { runtimeFactory: async () => ({
      login: async (id, type, io) => {
        if (fail && stage === 'login') throw Error('fake failure');
        fs.writeFileSync(f.file, JSON.stringify({ [id]: { type, key: await io.prompt({ type: 'secret' }) } }));
      },
      refresh: async () => { if (fail && stage === 'refresh') throw Error('fake failure'); },
      logout: async (id) => { const data = JSON.parse(fs.readFileSync(f.file)); delete data[id]; fs.writeFileSync(f.file, JSON.stringify(data)); }
    }) });
    await assert.rejects(f.auth.addProvider({ ...definition, key: KEY }));
    assert.deepEqual(f.store.list(), [], stage);
    assert.equal(fs.existsSync(f.models), false);
    assert.equal(fs.existsSync(f.registry), false);
    fail = false;
    await f.auth.addProvider({ ...definition, key: KEY });
    assert.equal(f.store.list()[0].id, definition.id);
  }
});

test('review 2: re-adding a managed provider without a key repairs it but never replaces foreign/edited entries', async (t) => {
  const f = fixture(t);
  await f.store.add(definition);
  await f.auth.addProvider({ ...definition, key: KEY });
  assert.equal((await f.auth.listAccounts()).find((p) => p.id === definition.id).status, 'signed_in');
  await assert.rejects(f.auth.addProvider({ ...definition, key: KEY }), { status: 409 });
});

test('review 3: crash-stale directory locks are recovered for add and remove', async (t) => {
  const f = fixture(t), lock = path.join(f.dir, 'models.json.scranton-lock');
  const stale = () => {
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  };
  stale();
  await f.store.add(definition);
  stale();
  await f.store.remove(definition.id);
  assert.deepEqual(f.store.list(), []);
  assert.equal(fs.existsSync(lock), false);
});

test('review 4: a new built-in ID collision is reported as conflicting without breaking reads', async (t) => {
  const f = fixture(t);
  await f.auth.addProvider({ ...definition, key: KEY });
  builtinCatalog.push({ id: definition.id, name: 'New built-in', auth: {} });
  t.after(() => { builtinCatalog.splice(builtinCatalog.findIndex((p) => p.id === definition.id), 1); });
  const custom = f.store.list().find((p) => p.id === definition.id);
  assert.ok(custom, 'conflicting managed provider remains visible');
  assert.match(custom.detail, /conflict.*built-in/i);
  const accounts = await f.auth.listAccounts();
  assert.equal(accounts[0].id, 'anthropic');
  assert.equal(accounts.find((p) => p.id === definition.id).status, 'error');
  assert.match(accounts.find((p) => p.id === definition.id).detail, /conflict.*built-in/i);
  await assert.rejects(f.auth.resolveDockerCredential(definition.id), /sign in again/);
});

test('review 5: custom add refuses an unmanaged stored credential without modifying any file', async (t) => {
  for (const credential of [{ type: 'api_key', key: 'FAKE_FOREIGN_KEY' }, { type: 'oauth', access: 'FAKE_FOREIGN_ACCESS' }, null]) {
    const f = fixture(t);
    const original = JSON.stringify({ [definition.id]: credential });
    fs.writeFileSync(f.file, original);
    await assert.rejects(f.auth.addProvider({ ...definition, key: KEY }), { status: 409 });
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(fs.existsSync(f.models), false);
    assert.equal(fs.existsSync(f.registry), false);
  }
});

test('review 1 Docker preparation: corrupted custom config does not block explicit built-in OAuth/key launches', async (t) => {
  const f = fixture(t, { runtimeFactory: async () => ({ getAuth: async () => ({ source: 'OAuth', auth: { apiKey: 'FAKE_DOCKER_TOKEN' } }) }) });
  fs.writeFileSync(f.file, JSON.stringify({ anthropic: { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 }, google: { type: 'api_key', key: KEY } }));
  fs.writeFileSync(f.models, '{broken');
  const workspace = path.join(f.dir, 'work'), sessionDir = path.join(f.dir, 'session'), systemPromptFile = path.join(f.dir, 'prompt.md');
  fs.mkdirSync(workspace); fs.mkdirSync(sessionDir); fs.writeFileSync(systemPromptFile, 'test'); fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: unused');
  for (const provider of ['anthropic', 'google']) {
    const launch = await prepareSandbox({ workspace, sessionDir, systemPromptFile, provider, env: {} }, { auth: f.auth, executable: 'fake-docker', run: async (_exe, args) => ['info', 'image'].includes(args[0]) ? 'linux' : '' });
    assert.equal(launch.env[provider === 'anthropic' ? 'ANTHROPIC_OAUTH_TOKEN' : 'GEMINI_API_KEY'], provider === 'anthropic' ? 'FAKE_DOCKER_TOKEN' : KEY);
    assert.ok(!launch.argsPrefix.join(' ').includes(KEY));
    await launch.cleanup();
  }
});

test('review 3: PID-bearing abandoned locks give explicit recovery instructions without deleting contents', async (t) => {
  const f = fixture(t), lock = path.join(f.dir, 'models.json.scranton-lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), '2147483647');
  await assert.rejects(f.store.add(definition), /remove models\.json\.scranton-lock/);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), '2147483647');
});
