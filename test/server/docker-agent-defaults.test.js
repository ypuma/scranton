import '../core/isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { loadConfig, PACKAGE_ROOT } from '../../src/core/config.js';
import { activeRoles } from '../../src/core/workflow.js';
import { validateDockerModels } from '../../src/core/sandbox.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const custom = { id: 'lintgate', name: 'Lint', title: 'Lint Gate', instruction: 'Check the changes.' };
const saved = { provider: 'saved-provider', model: 'saved-model' };
const stale = { provider: 'old-provider', model: 'old-model', thinking: 'max' };
async function fixture(t, registry, fileConfig = {}) {
  const root = path.resolve('.scratch/docker-agent-defaults'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'server-'));
  const previous = {};
  for (const role of ['MICHAEL', 'DWIGHT', 'OSCAR', 'HANK', 'ANGELA', 'LINTGATE']) for (const field of ['PROVIDER', 'MODEL', 'THINKING']) {
    const key = `SCRANTON_${role}_${field}`; previous[key] = process.env[key]; delete process.env[key];
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(PACKAGE_ROOT, 'scranton.config.json')) return JSON.stringify(fileConfig);
    return read.call(this, file, ...args);
  });
  const calls = [], children = []; let catalogCalls = 0;
  const auth = { close() {}, async listModels() { catalogCalls++; return { providers: [{ id: stale.provider, signedIn: true, models: [{ id: stale.model }] }] }; } };
  const server = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), ...(registry ? { dataDir: path.join(dir, 'data') } : {}), publicDir: dir, port: 0,
    control: { workspace: path.join(dir, 'workspace'), auth, runner: (...args) => { calls.push(args); const child = Object.assign(new EventEmitter(), { pid: 123 }); children.push(child); return child; } } });
  t.after(async () => { for (const child of children) child.emit('close', 0); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(server.url + route, { method, headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  let route = '/api';
  if (registry) {
    const project = (await request('/api/projects', { name: 'Test' })).body.project;
    const chat = (await request(`/api/projects/${project.id}/chats`, {})).body.chat;
    route = `/api/projects/${project.id}/chats/${chat.id}`;
  }
  return { calls, request, route, catalogCalls: () => catalogCalls, finish() {
    const child = children.at(-1), env = calls.at(-1)[2].env;
    child.emit('message', { type: 'scranton-startup-refused', token: env.SCRANTON_RUN_LEASE }); child.emit('close', 2);
  } };
}
function childConfig(call) {
  const [, args, options] = call;
  return loadConfig({ cwd: options.cwd, env: options.env, flags: { singleHive: true, hive: args[args.indexOf('--hive') + 1], workspace: args[args.indexOf('--workspace') + 1], gates: args[args.indexOf('--gates') + 1], ...(args.includes('--trusted-host') ? { trustedHost: true } : args.includes('--sandbox') ? { sandbox: args[args.indexOf('--sandbox') + 1] } : {}) } });
}

for (const registry of [false, true]) for (const explicit of [false, true]) test(`Docker uses resolved defaults, not stale selections (${registry ? 'registry' : 'single'}, ${explicit ? 'explicit' : 'configured'})`, async (t) => {
  const f = await fixture(t, registry, { agents: { dwight: { provider: 'config-provider', model: 'config-model' } }, ...(explicit ? { execution: { sandbox: { mode: 'host' } } } : {}) });
  process.env.SCRANTON_DWIGHT_PROVIDER = 'env-provider'; process.env.SCRANTON_DWIGHT_MODEL = 'env-model';
  assert.equal((await f.request('/api/agents', { ...custom, model: saved, thinking: 'low' })).status, 201);
  assert.equal((await f.request('/api/agents/angela', { model: saved }, 'PATCH')).status, 200);
  const before = (await f.request(f.route + '/control')).body.defaults.models;
  const response = await f.request(f.route + '/runs', { request: 'fake goal', noPlan: true, workflow: { gates: [['lintgate', 'angela']] }, ...(explicit ? { sandbox: 'docker' } : {}), models: { dwight: stale, lintgate: stale, angela: stale } });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(f.catalogCalls(), 0, 'ignored stale choices cannot require an available catalog');
  const config = childConfig(f.calls[0]);
  assert.equal(config.execution.sandbox.mode, 'docker');
  assert.deepEqual(activeRoles(config, true), ['dwight', 'lintgate', 'angela']);
  assert.doesNotThrow(() => validateDockerModels(config, activeRoles(config, true)));
  for (const id of activeRoles(config, true)) assert.deepEqual({ provider: config.agents[id].provider, model: config.agents[id].model }, before[id]);
  assert.equal(config.agents.lintgate.thinking, 'low', 'per-run thinking travels with the ignored model selection');
  assert.equal(config.agents.michael.model, null, 'inactive planner needs no default');
  assert.deepEqual((await f.request(f.route + '/control')).body.defaults.models, before);
  f.finish();
});

for (const registry of [false, true]) test(`Docker direct POST cannot fill missing active defaults (${registry ? 'registry' : 'single'})`, async (t) => {
  const f = await fixture(t, registry);
  assert.equal((await f.request('/api/agents/dwight', { model: saved }, 'PATCH')).status, 200);
  assert.equal((await f.request('/api/agents', custom)).status, 201);
  for (const [noPlan, gates, missing] of [[true, [['lintgate']], 'lintgate'], [true, [['oscar', 'hank']], 'oscar, hank'], [false, [['lintgate']], 'michael, lintgate']]) {
    const models = Object.fromEntries(['michael', 'dwight', 'lintgate', 'oscar', 'hank'].map((id) => [id, stale]));
    const response = await f.request(f.route + '/runs', { request: 'fake goal', noPlan, workflow: { gates }, models });
    assert.equal(response.status, 400);
    assert.ok(response.body.error.includes(`for ${missing};`), response.body.error);
    assert.match(response.body.error, /set the agent default.*Agents/);
    assert.equal(f.calls.length, 0);
  }
  assert.equal((await f.request(f.route + '/control')).body.recoveryRequired, false, 'rejection acquires no lease');
});

test('configured defaults keep config over saved settings, and trusted host keeps per-run overrides', async (t) => {
  const f = await fixture(t, false, { agents: { dwight: { provider: 'config-provider', model: 'config-model' } } });
  assert.equal((await f.request('/api/agents/angela', { model: saved }, 'PATCH')).status, 200);
  const defaults = (await f.request('/api/control')).body.defaults.models;
  assert.deepEqual(defaults.dwight, { provider: 'config-provider', model: 'config-model' });
  for (const trustedHost of [false, true]) {
    const response = await f.request('/api/runs', { request: 'fake goal', noPlan: true, ...(trustedHost ? { trustedHost: true } : {}), models: { dwight: stale, angela: stale } });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const config = childConfig(f.calls.at(-1));
    assert.equal(config.agents.dwight.model, trustedHost ? stale.model : defaults.dwight.model);
    assert.equal(config.agents.dwight.thinking, trustedHost ? 'max' : null);
    f.finish();
  }
  assert.equal(f.catalogCalls(), 1);
});

for (const registry of [false, true]) for (const trustedHost of [false, true]) test(`model selection structure is validated before catalog or launch (${registry ? 'registry' : 'single'}, ${trustedHost ? 'host' : 'docker'})`, async (t) => {
  const f = await fixture(t, registry, { agents: { dwight: saved, angela: saved } });
  const invalid = [5, null, [], {}, { provider: 5, model: 'model' }, { provider: 'provider', model: 5 }, { ...stale, thinking: 'invalid' }, { ...stale, extra: true }];
  for (const choice of invalid) {
    const response = await f.request(f.route + '/runs', { request: 'fake goal', noPlan: true, ...(trustedHost ? { trustedHost: true } : {}), models: { dwight: choice } });
    assert.equal(response.status, 400, JSON.stringify({ choice, response }));
    assert.equal(response.body.error, 'Invalid model selection');
  }
  assert.equal(f.catalogCalls(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(f.route + '/control')).body.recoveryRequired, false);
  if (!trustedHost) {
    const response = await f.request(f.route + '/runs', { request: 'fake goal', noPlan: true, models: { dwight: { provider: 'unavailable-provider', model: 'removed-model', thinking: 'high' } } });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(f.catalogCalls(), 0);
    assert.equal(childConfig(f.calls[0]).agents.dwight.model, saved.model);
    f.finish();
  }
});
