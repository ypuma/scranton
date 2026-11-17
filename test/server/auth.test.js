import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { ModelsError } from '@earendil-works/pi-ai';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createControl } from '../../src/server/control.js';
import { createAuthService } from '../../src/core/auth.js';
import { loadConfig } from '../../src/core/config.js';

async function setup(t, enabled = true) {
  const root = path.resolve('.scratch/docker-e2e/server-auth-tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'server-'));
  const notices = []; const opened = []; const calls = [];
  const authPath = path.join(dir, 'profile', 'auth.json');
  const auth = createAuthService({ authPath, env: {}, opener: async (...args) => opened.push(args), onChange: (s) => notices.push(s), runtimeFactory: async () => ({
    refresh: async () => {},
    login: async (provider, type, io) => {
      if (type === 'api_key') {
        const key = await io.prompt({ type: 'secret' });
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        let data = {}; try { data = JSON.parse(fs.readFileSync(authPath)); } catch {}
        fs.writeFileSync(authPath, JSON.stringify({ ...data, [provider]: { type, key } }));
        return;
      }
      io.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?state=test' });
      assert.equal(await io.prompt({ type: 'manual_code' }), 'FAKE_CODE');
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify({ [provider]: { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 } }));
      io.notify({ type: 'progress', message: 'FAKE_ACCESS FAKE_REFRESH' });
    },
    logout: async (provider) => { const data = JSON.parse(fs.readFileSync(authPath)); delete data[provider]; fs.writeFileSync(authPath, JSON.stringify(data)); },
    getAuth: async () => { throw new ModelsError('oauth', 'OAuth refresh failed for openai', { cause: new Error('OpenAI OAuth token request failed (401): invalid_grant FAKE_ACCESS FAKE_REFRESH') }); },
    getAvailable: async () => [{ provider: 'openai', id: 'fake-catalog', name: 'Fake catalog', reasoning: true, contextWindow: 12345 }]
  }) });
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = (...args) => { calls.push(args); return child; };
  const hive = path.join(dir, 'hive'), workspace = path.join(dir, 'workspace');
  const srv = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0, control: enabled ? { workspace, runner, auth } : undefined });
  t.after(async () => { child.emit('close', 0); await srv.close(); await auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { srv, auth, authPath, notices, opened, calls, hive, workspace, child };
}
function request(srv, route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${srv.url}${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1', ...headers } }, (res) => {
      let text = ''; res.on('data', (d) => text += d); res.on('end', () => { let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode, value, text }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
async function until(fn, predicate) { for (let i = 0; i < 200; i++) { const result = await fn(); if (predicate(result)) return result; await sleep(5); } throw Error('Fake login did not settle'); }
const noSecrets = (data) => assert.doesNotMatch(JSON.stringify(data), /FAKE_ACCESS|FAKE_REFRESH|FAKE_CODE/);

test('auth routes disabled without control, wrong methods are 404', async (t) => {
  const { srv } = await setup(t, false);
  for (const route of ['/api/auth', '/api/models', '/api/auth/login', '/api/auth/login/input', '/api/auth/login/open', '/api/auth/login/cancel', '/api/auth/logout', '/api/auth/key', '/api/auth/providers', '/api/providers', '/api/providers/discover', '/api/providers/remove']) {
    assert.equal((await request(srv, route)).status, 404); assert.equal((await request(srv, route, {})).status, 404);
  }
  const enabled = await setup(t);
  assert.equal((await request(enabled.srv, '/api/auth', {})).status, 404);
  assert.equal((await request(enabled.srv, '/api/auth/login')).status, 404);
});

test('all auth routes enforce client marker, origin, host, JSON and body limits', async (t) => {
  const { srv } = await setup(t);
  for (const route of ['/api/auth', '/api/models', '/api/auth/login', '/api/auth/login/input', '/api/auth/login/open', '/api/auth/login/cancel', '/api/auth/logout', '/api/auth/key', '/api/auth/providers', '/api/providers', '/api/providers/discover', '/api/providers/remove']) {
    const body = ['/api/auth', '/api/models', '/api/auth/providers'].includes(route) ? undefined : {};
    for (const headers of [{ 'X-Scranton-Client': '' }, { Origin: 'https://evil.test' }, { Host: 'evil.test' }]) assert.equal((await request(srv, route, body, headers)).status, 403, route);
    if (body) {
      assert.equal((await request(srv, route, {}, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await request(srv, route, '{bad')).status, 400);
      assert.equal((await request(srv, route, 'x'.repeat(262145))).status, 413);
    }
  }
});

test('non-loopback peer refused before auth service access', async () => {
  let accessed = false;
  const controller = createControl({ hive: path.resolve('.scratch/auth-backend/unused'), auth: { listAccounts: () => { accessed = true; } } });
  let status; let text;
  await controller.handle({ socket: { remoteAddress: '192.0.2.1', localPort: 1725 }, headers: { host: 'localhost:1725', 'x-scranton-client': '1' }, method: 'GET' }, { writeHead: (code) => status = code, end: (value) => text = value }, '/api/auth');
  assert.equal(status, 403); assert.equal(accessed, false); assert.match(text, /Forbidden/);
});

test('route login/input/cancel/logout lifecycle returns only public metadata and no auth events/files', async (t) => {
  const f = await setup(t); const responses = [];
  const call = async (...args) => { const result = await request(f.srv, ...args); responses.push(result); return result; };
  assert.equal((await call('/api/auth')).value.login, null);
  assert.equal((await call('/api/auth/login', { provider: 'openai-codex' })).status, 400);
  const started = await call('/api/auth/login', { provider: 'openai' }); assert.equal(started.status, 202); const { id } = started.value;
  assert.equal((await call('/api/auth/login', { provider: 'openai' })).status, 409);
  await until(() => call('/api/auth'), (r) => r.value.login.state === 'waiting_code');
  assert.equal(f.opened.length, 1);
  assert.equal((await call('/api/auth/login/input', { id: 'wrong', value: 'FAKE_CODE' })).status, 409);
  assert.equal((await call('/api/auth/login/input', { id, value: 'x'.repeat(4097) })).status, 400);
  assert.equal((await call('/api/auth/login/input', { id, value: 'FAKE_CODE' })).status, 202);
  await f.auth.waitForLogin();
  assert.equal((await call('/api/auth')).value.accounts[1].kind, 'oauth');
  const stored = JSON.parse(fs.readFileSync(f.authPath)); stored.openai.expires = 1;
  fs.writeFileSync(f.authPath, JSON.stringify(stored));
  const renewable = (await call('/api/auth')).value.accounts[1];
  assert.equal(renewable.status, 'signed_in'); assert.equal(renewable.renewsOnUse, true);
  await assert.rejects(f.auth.mintAccessToken('openai', { minExpiryMs: 1800000 }), /sign in again/);
  const failed = (await call('/api/auth')).value.accounts[1];
  assert.equal(failed.status, 'expired'); assert.ok(Number.isFinite(Date.parse(failed.renewFailedAt)));
  assert.equal((await call('/api/models')).value.providers[0].models[0].id, 'fake-catalog');
  assert.equal((await call('/api/runs', { request: 'fake controlled run', trustedHost: true })).status, 202);
  assert.equal((await call('/api/auth/logout', { provider: 'openai' })).status, 202, 'logout while run active');
  assert.equal((await call('/api/auth')).value.accounts[1].status, 'signed_out');
  const again = await call('/api/auth/login', { provider: 'openai' });
  await until(() => call('/api/auth'), (r) => r.value.login.state === 'waiting_code');
  assert.equal((await call('/api/auth/login/cancel', again.value)).status, 202);
  assert.equal((await call('/api/auth')).value.login.state, 'cancelled');
  noSecrets(responses); noSecrets(f.notices);
  assert.equal(fs.existsSync(path.join(f.hive, 'events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.hive, 'state.json')), false);
  noSecrets((await call('/api/control')).value);
  f.child.emit('close', 0);
});

test('model overrides validate catalog and thinking then reach config via child env (regression)', async (t) => {
  const f = await setup(t);
  for (const models of [null, [], { dev: {} }, { michael: null }, { michael: { provider: 'evil', model: 'fake-catalog' } }, { michael: { provider: 'openai', model: 'absent' } }, { michael: { provider: 'openai', model: 'fake-catalog', thinking: 'unlimited' } }, { michael: { provider: 'openai', model: 'fake-catalog', extra: true } }]) assert.equal((await request(f.srv, '/api/runs', { request: 'test', trustedHost: true, models })).status, 400);
  assert.equal(f.calls.length, 0);
  const models = Object.fromEntries(['michael', 'dwight', 'angela'].map((role) => [role, { provider: 'openai', model: 'fake-catalog', thinking: 'high' }]));
  assert.equal((await request(f.srv, '/api/runs', { request: 'test', trustedHost: true, models })).status, 202);
  const [exe, args, options] = f.calls[0];
  assert.equal(exe, process.execPath); assert.ok(!args.includes('fake-catalog'));
  const config = loadConfig({ cwd: f.workspace, env: options.env });
  for (const role of Object.keys(models)) {
    assert.equal(options.env[`SCRANTON_${role.toUpperCase()}_MODEL`], 'fake-catalog');
    assert.equal(config.agents[role].provider, 'openai'); assert.equal(config.agents[role].model, 'fake-catalog'); assert.equal(config.agents[role].thinking, 'high');
  }
  assert.equal(fs.existsSync(path.join(f.workspace, 'scranton.config.json')), false);
  f.child.emit('close', 0);
});


test('review 6: open again uses only the active stored URL and rate limits launches', async (t) => {
  const f = await setup(t);
  assert.equal((await request(f.srv, '/api/auth/login/open', { id: 'missing' })).status, 409);
  const { id } = (await request(f.srv, '/api/auth/login', { provider: 'openai' })).value;
  await until(() => f.auth.getLogin(), (s) => s.state === 'waiting_code');
  assert.equal((await request(f.srv, '/api/auth/login/open', { id: 'stale' })).status, 409);
  assert.equal((await request(f.srv, '/api/auth/login/open', { id, url: 'https://evil.test' })).status, 400);
  await sleep(2000);
  const opened = await request(f.srv, '/api/auth/login/open', { id });
  assert.equal(opened.status, 202); assert.deepEqual(opened.value, { ok: true });
  assert.equal(f.opened.length, 2); assert.deepEqual(f.opened[1], f.opened[0]);
  assert.equal((await request(f.srv, '/api/auth/login/open', { id })).status, 429);
  await f.auth.cancel(id);
  assert.equal((await request(f.srv, '/api/auth/login/open', { id })).status, 409);
});

test('extended key/provider routes return only metadata and keep secrets out of control/events', async (t) => {
  const f = await setup(t), replies = [], key = 'FAKE_ROUTE_KEY_NEVER_DISCLOSE';
  const call = async (...args) => { const r = await request(f.srv, ...args); replies.push(r); return r; };
  assert.ok((await call('/api/auth/providers')).value.providers.some((p) => p.id === 'google'));
  assert.equal((await call('/api/auth/key', { provider: 'google', key })).status, 202);
  assert.equal((await call('/api/auth/key', { provider: 'deepseek', key })).status, 202);
  assert.equal((await call('/api/auth')).value.accounts.find((a) => a.id === 'google').kind, 'api_key');
  assert.equal((await call('/api/auth/logout', { provider: 'google' })).status, 202);
  assert.equal((await call('/api/auth')).value.accounts.find((a) => a.id === 'deepseek').status, 'signed_in');
  const definition = { id: 'custom-route', label: 'Custom', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'model-test' }], key };
  assert.equal((await call('/api/providers', definition)).status, 202);
  assert.equal((await call('/api/auth')).value.accounts.find((a) => a.id === definition.id).custom, true);
  assert.equal((await call('/api/providers/remove', { id: 'foreign' })).status, 409);
  assert.equal((await call('/api/providers/remove', { id: definition.id })).status, 202);
  assert.equal((await call('/api/providers/discover', { baseUrl: 'http://remote.test/v1', api: definition.api, key })).status, 400);
  assert.equal((await call('/api/auth/key', { provider: 'google', key, extra: true })).status, 400);
  await call('/api/models'); await call('/api/control');
  assert.ok(!JSON.stringify({ replies, notices: f.notices }).includes(key));
  assert.equal(fs.existsSync(path.join(f.hive, 'events.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.hive, 'state.json')), false);
});

test('Docker pi-default refusal is actionable for initial and follow-up routes before spawn or lease', async (t) => {
  const saved = {};
  for (const role of ['MICHAEL', 'DWIGHT', 'ANGELA']) {
    for (const suffix of ['PROVIDER', 'MODEL']) {
      const key = `SCRANTON_${role}_${suffix}`;
      saved[key] = process.env[key]; delete process.env[key];
    }
  }
  t.after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const f = await setup(t);
  const expected = 'Docker requires an explicit provider and model for michael, dwight, angela; set the agent default for each role in Agents (pi default cannot be used in the Docker sandbox), or set SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL';
  for (const route of ['/api/runs', '/api/projects/default/chats/default/runs']) {
    const refused = await request(f.srv, route, { request: 'fake goal', sandbox: 'docker' });
    assert.equal(refused.status, 400); assert.deepEqual(refused.value, { error: expected });
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.hive, 'control', 'owner.json')), false);
    assert.equal(fs.existsSync(path.join(f.hive, 'events.jsonl')), false);
  }
  const choice = { provider: 'openai', model: 'fake-catalog' };
  const partial = await request(f.srv, '/api/runs', { request: 'fake goal', sandbox: 'docker', models: { dwight: choice, angela: choice } });
  assert.equal(partial.status, 400); assert.match(partial.value.error, /for michael, dwight, angela;/);
  for (const role of ['dwight', 'angela']) assert.equal((await request(f.srv, `/api/agents/${role}`, { model: choice }, {}, 'PATCH')).status, 200);
  const accepted = await request(f.srv, '/api/projects/default/chats/default/runs', { request: 'fake follow-up', sandbox: 'docker', noPlan: true, models: { dwight: choice, angela: choice } });
  assert.equal(accepted.status, 202); assert.deepEqual(accepted.value, { ok: true, pid: 123 });
  f.child.emit('close', 0);
});
