import '../core/isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ModelsError } from '@earendil-works/pi-ai';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createAuthService } from '../../src/core/auth.js';
import { createProjectRegistry } from '../../src/core/projects.js';

function fixture(t) {
  const root = path.resolve('.scratch/fix-round2'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
async function request(server, route, body) {
  const res = await fetch(server.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, value: await res.json() };
}
function modelEnv(t) {
  const saved = {};
  for (const role of ['MICHAEL', 'DWIGHT', 'OSCAR', 'HANK', 'ANGELA']) for (const suffix of ['PROVIDER', 'MODEL']) {
    const name = `SCRANTON_${role}_${suffix}`; saved[name] = process.env[name]; delete process.env[name];
  }
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
for (const registryMode of [false, true]) test(`configured models are exposed and accepted by Docker POST in ${registryMode ? 'registry' : 'single'} mode`, async (t) => {
  modelEnv(t);
  const dir = fixture(t), workspace = path.join(dir, 'ws'), dataDir = path.join(dir, 'data'); fs.mkdirSync(workspace);
  let scoped = '/api/projects/default/chats/default';
  if (registryMode) {
    const registry = createProjectRegistry({ dataDir });
    const project = registry.addProject({ name: 'Test', workspace }), chat = registry.createChat(project.id);
    scoped = `/api/projects/${project.id}/chats/${chat.id}`;
  }
  const children = [], calls = [];
  const auth = { close() {}, listModels: async () => ({ providers: [{ id: 'openai', signedIn: true, models: [{ id: 'request-model' }] }] }) };
  const server = await startVisualizerServer({ ...(registryMode ? { dataDir } : { hiveDir: path.join(dir, 'hive') }), publicDir: dir, port: 0,
    control: { workspace, auth, runner: (...args) => { calls.push(args); const child = Object.assign(new EventEmitter(), { pid: 123 }); children.push(child); return child; } } });
  t.after(async () => { for (const child of children) child.emit('close', 0); await server.close(); });
  for (const route of ['/api/control', scoped + '/control']) {
    const response = await request(server, route); assert.equal(response.status, 200);
    assert.deepEqual(response.value.defaults.models, { michael: null, dwight: null, oscar: null, hank: null, angela: null });
  }
  for (const role of ['MICHAEL', 'DWIGHT', 'ANGELA']) {
    process.env[`SCRANTON_${role}_PROVIDER`] = 'anthropic'; process.env[`SCRANTON_${role}_MODEL`] = 'configured-model';
  }
  const expected = { ...Object.fromEntries(['michael', 'dwight', 'angela'].map((id) => [id, { provider: 'anthropic', model: 'configured-model' }])), oscar: null, hank: null };
  for (const route of ['/api/control', scoped + '/control']) assert.deepEqual((await request(server, route)).value.defaults.models, expected);
  const choice = { provider: 'openai', model: 'request-model' };
  assert.equal((await request(server, scoped + '/runs', { request: 'fake', sandbox: 'docker', models: { dwight: choice } })).status, 202);
  assert.equal(calls.length, 1); assert.equal(calls[0][2].env.SCRANTON_DWIGHT_MODEL, 'configured-model');
  assert.equal(calls[0][2].env.SCRANTON_MICHAEL_MODEL, 'configured-model');
  assert.deepEqual((await request(server, scoped + '/control')).value.defaults.models, expected, 'request overrides are not defaults');
});

for (const rejected of [false, true]) test(`GET auth returns before proactive renewal; later poll shows ${rejected ? 'rejection' : 'success'}`, async (t) => {
  const dir = fixture(t), authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: 1 } }));
  let complete, calls = 0; const logs = [], notices = [], responses = [];
  t.mock.method(console, 'error', (...args) => logs.push(args)); t.mock.method(console, 'warn', (...args) => logs.push(args));
  const auth = createAuthService({ authPath, env: {}, onChange: (v) => notices.push(v), runtimeFactory: async () => ({ getAuth: async () => {
    calls++;
    await new Promise((resolve) => { complete = resolve; });
    if (rejected) throw new ModelsError('oauth', 'OAuth refresh failed for openai', { cause: new Error('OpenAI OAuth token request failed (400): invalid_grant FAKE_ACCESS FAKE_REFRESH') });
    fs.writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', expires: Date.now() + 3600000 } }));
    return { source: 'OAuth', auth: { apiKey: 'FAKE_ACCESS' } };
  } }) });
  const server = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, control: { workspace: path.join(dir, 'ws'), auth } });
  t.after(async () => { complete?.(); await server.close(); });
  const poll = async () => { const response = await request(server, '/api/auth'); responses.push(response); assert.equal(response.status, 200); return response.value.accounts.find((a) => a.id === 'openai'); };
  assert.equal((await poll()).renewsOnUse, true); assert.equal(calls, 1);
  assert.equal((await poll()).renewsOnUse, true); assert.equal(calls, 1);
  complete();
  let account;
  for (let i = 0; i < 50; i++) { account = await poll(); if (!account.renewsOnUse) break; await sleep(5); }
  assert.equal(account.status, rejected ? 'expired' : 'signed_in'); assert.equal(account.renewsOnUse, false);
  assert.equal(Boolean(account.renewFailedAt), rejected); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify({ responses, logs, notices }), /FAKE_ACCESS|FAKE_REFRESH|invalid_grant/);
  assert.equal(fs.existsSync(path.join(dir, 'hive', 'events.jsonl')), false);
});
