import '../core/isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { PACKAGE_ROOT, loadConfig } from '../../src/core/config.js';
const definition = { id: 'seclint', name: 'Security Lint', title: 'Static Auditor', instruction: 'Inspect trust boundaries.' };
function request(url, route, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1', ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }), ...headers } }, (res) => {
      let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, registry = false, control = {}) {
  const base = path.resolve('.scratch/ca-fix2'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'http-'));
  const settings = path.join(dir, registry ? 'data' : 'hive');
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, ...(registry ? { dataDir: settings } : {}), control: { workspace: path.join(dir, 'workspace'), auth: { close() {}, listModels: async () => ({ providers: [{ id: 'fake', signedIn: true, models: [{ id: 'catalog' }] }] }) }, ...control } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, settings, srv, call: (...args) => request(srv.url, ...args) };
}
test('custom CRUD, deterministic starter, prompt reset, instructions and hardened errors in single and registry mode', async (t) => {
  for (const registry of [false, true]) {
    const { settings, call } = await fixture(t, registry);
    for (const headers of [{ 'X-Scranton-Client': '' }, { Origin: 'https://evil.test' }, { Host: 'evil.test' }]) assert.equal((await call('/api/agents', 'POST', definition, headers)).status, 403);
    assert.equal((await call('/api/agents', 'POST', { ...definition, instruction: 'x'.repeat(262145) })).status, 413);
    for (const id of ['human', 'seclint-x', 'SecLint', 'x'.repeat(21)]) assert.equal((await call('/api/agents', 'POST', { ...definition, id })).status, 400);
    assert.equal((await call('/api/agents', 'POST', definition)).status, 201);
    assert.equal(fs.existsSync(path.join(settings, 'prompts', 'seclint.md')), false);
    assert.equal((await call('/api/agents', 'POST', definition)).status, 409);
    let catalog = (await call('/api/agents')).body;
    assert.deepEqual(catalog.roles.map((r) => r.id), ['michael', 'dwight', 'oscar', 'hank', 'angela', 'seclint']);
    assert.deepEqual(catalog.roles.at(-1).prompt.missingKeywords, []);
    assert.equal(catalog.roles.at(-1).prompt.source, 'builtin');
    assert.equal((await call('/api/agents/seclint', 'PATCH', { name: 'Updated', model: { provider: 'fake', model: 'saved' }, thinking: 'minimal' })).status, 200);
    assert.equal((await call('/api/agents/seclint/prompt', 'PUT', { text: 'Custom prompt' })).status, 200);
    assert.equal((await call('/api/agents')).body.roles.at(-1).prompt.text, 'Custom prompt');
    assert.equal((await call('/api/agents/seclint/prompt', 'DELETE', { text: 'x'.repeat(262145) })).status, 413);
    assert.equal((await call('/api/agents/seclint', 'DELETE', { text: 'x'.repeat(262145) })).status, 413);
    assert.equal((await call('/api/agents/seclint/prompt', 'DELETE')).status, 200);
    assert.match((await call('/api/agents')).body.roles.at(-1).prompt.text, /Updated/);
    assert.equal((await call('/api/agents/seclint', 'PATCH', { tools: ['write'] })).status, 400);
    const before = (await call('/api/agents')).body.roles.find((r) => r.id === 'angela').instruction;
    assert.equal((await call('/api/agents/angela', 'PATCH', { instruction: 'Verify performance.' })).status, 200);
    assert.equal((await call('/api/agents/angela', 'PATCH', { instruction: null })).body.agent.instruction, before);
    assert.equal((await call('/api/agents/michael', 'PATCH', { name: 'Other' })).status, 400);
    assert.equal((await call('/api/agents/angela', 'DELETE')).status, 400);
    assert.equal((await call('/api/agents/unknown', 'PATCH', { name: 'Other' })).status, 404);
    assert.equal((await call('/api/agents/unknown/prompt', 'PUT', { text: 'No' })).status, 404);
    const defaults = (await call('/api/control')).body.defaults;
    assert.deepEqual(defaults.models.seclint, { provider: 'fake', model: 'saved' });
    assert.equal(defaults.agents.at(-1).id, 'seclint');
    assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 200);
    assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 404);
    const file = path.join(settings, 'agents.json'); const store = JSON.parse(fs.readFileSync(file));
    store.agents.broken = { ...definition, id: 'broken', tools: ['write'] }; fs.writeFileSync(file, JSON.stringify(store));
    catalog = (await call('/api/agents')).body;
    assert.equal(catalog.warnings.length, 1); assert.ok(!catalog.roles.some((r) => r.id === 'broken'));
  }
});
test('env/config pinning rejects model and thinking edits independently', async (t) => {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(PACKAGE_ROOT, 'scranton.config.json')) return JSON.stringify({ agents: { dwight: { provider: 'fake', model: 'pinned' }, hank: { thinking: 'high' } } });
    return original.call(this, file, ...args);
  });
  const { call } = await fixture(t);
  assert.equal((await call('/api/agents/dwight', 'PATCH', { model: null })).status, 409);
  assert.equal((await call('/api/agents/hank', 'PATCH', { thinking: null })).status, 409);
  assert.equal((await call('/api/agents/dwight', 'PATCH', { thinking: 'low' })).status, 200);
});
test('registry custom run and follow-up resolve shared settings and request > env > config > settings', async (t) => {
  let launch, child;
  const { dir, settings, call } = await fixture(t, true, { runner: (_exe, args, options) => {
    launch = { args, options }; child = new EventEmitter(); child.pid = 123; child.stdin = { on() {}, write() {} }; return child;
  } });
  await call('/api/agents', 'POST', { ...definition, model: { provider: 'fake', model: 'saved' } });
  await call('/api/agents/dwight', 'PATCH', { model: { provider: 'fake', model: 'saved' } });
  const ws = path.join(dir, 'workspace'); fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'agents.json'), JSON.stringify({ v: 1, agents: { fakegate: definition } }));
  const project = (await call('/api/projects', 'POST', { name: 'Custom', workspace: ws })).body.project;
  const chat = (await call(`/api/projects/${project.id}/chats`, 'POST', {})).body.chat;
  const route = `/api/projects/${project.id}/chats/${chat.id}/runs`;
  assert.equal((await call(route, 'POST', { request: 'bad', noPlan: true, workflow: { gates: [['fakegate']] } })).status, 400);
  assert.equal(launch, undefined);
  for (const models of [undefined, { seclint: { provider: 'fake', model: 'catalog', thinking: 'max' } }]) {
    const response = await call(route, 'POST', { request: 'Check', trustedHost: true, noPlan: true, workflow: { gates: [['seclint']] }, ...(models ? { models } : {}) });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(launch.options.env.SCRANTON_SETTINGS_DIR, settings);
    const effective = loadConfig({ cwd: PACKAGE_ROOT, env: launch.options.env, flags: { singleHive: true, hive: chat.hiveDir, workspace: ws, gates: 'seclint' } });
    assert.equal(effective.agents.seclint.model, models ? 'catalog' : 'saved');
    assert.equal(effective.agents.seclint.thinking, models ? 'max' : null);
    child.emit('message', { type: 'scranton-startup-refused', token: launch.options.env.SCRANTON_RUN_LEASE }); child.emit('close', 2);
  }
  await call('/api/agents/seclint', 'PATCH', { model: null });
  assert.equal((await call(route, 'POST', { request: 'Automatic Docker model', sandbox: 'docker', noPlan: true, workflow: { gates: [['seclint']] } })).status, 202);
  child.emit('message', { type: 'scranton-startup-refused', token: launch.options.env.SCRANTON_RUN_LEASE }); child.emit('close', 2);
});

import { Orchestrator } from '../../src/core/orchestrator.js';
import { startAgent } from '../../src/core/agent/index.js';

test('review: broken configured workflows leave CRUD/control usable and refuse starts with the id', async (t) => {
  for (const registry of [false, true]) {
    const { settings, call } = await fixture(t, registry, { gates: 'seclint' });
    assert.equal((await call('/api/agents')).status, 200, 'missing configured gate cannot lock agents API');
    assert.match((await call('/api/agents')).body.warnings.join('\n'), /seclint/);
    assert.equal((await call('/api/control')).status, 200);
    assert.equal((await call('/api/agents', 'POST', definition)).status, 201);
    assert.equal((await call('/api/agents/seclint', 'PATCH', { name: 'Lint' })).status, 200);
    assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 409, 'configured workflow prevents deleting gate');
    const file = path.join(settings, 'agents.json');
    const data = JSON.parse(fs.readFileSync(file)); data.agents.seclint.tools = ['write']; fs.writeFileSync(file, JSON.stringify(data));
    const catalog = await call('/api/agents');
    assert.equal(catalog.status, 200); assert.match(catalog.body.warnings.join('\n'), /skipped.*seclint/);
    assert.match(catalog.body.warnings.join('\n'), /gate role: seclint/);
    assert.equal((await call('/api/agents/dwight', 'PATCH', { thinking: 'low' })).status, 200);
    if (!registry) {
      const refused = await call('/api/runs', 'POST', { request: 'refuse', noPlan: true, trustedHost: true });
      assert.equal(refused.status, 400); assert.match(refused.body.error, /seclint/);
    }
    assert.equal((await call('/api/agents', 'POST', definition)).status, 201, 'invalid skipped gate can be recreated');
  }
});

test('review: config-file workflow is recoverable independently of server --gates', async (t) => {
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(PACKAGE_ROOT, 'scranton.config.json')) return JSON.stringify({ workflow: { gates: [['seclint']] } });
    return original.call(this, file, ...args);
  });
  const { call } = await fixture(t);
  assert.equal((await call('/api/agents')).status, 200);
  assert.match((await call('/api/agents')).body.warnings.join('\n'), /seclint/);
  assert.equal((await call('/api/agents', 'POST', definition)).status, 201);
  assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 409);
});

test('review: mid-run HTTP DELETE leaves running custom gate snapshot intact', async (t) => {
  let release, entered, completion, current, gatePrompt;
  const savedPrompt = 'Frozen HTTP prompt\n[SECLINT_PASSED]\n[SECLINT_FAILED]\n[BLOCKED]';
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { call } = await fixture(t, false, { acquire: () => ({ token: 'fake-lease' }), runner: (_exe, args, options) => {
    const hive = args[args.indexOf('--hive') + 1], workspace = args[args.indexOf('--workspace') + 1];
    const config = loadConfig({ cwd: PACKAGE_ROOT, env: { SCRANTON_SETTINGS_DIR: options.env.SCRANTON_SETTINGS_DIR }, flags: { trustedHost: true, hive, workspace, gates: 'seclint' } });
    current = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy', SCRANTON_FAKE_DELAY_MS: '0' }, startRunner: (opts) => {
      if (opts.agentId !== 'dwight') { gatePrompt = fs.readFileSync(opts.systemPromptFile, 'utf8').trim(); return startAgent(opts); }
      entered();
      return { done: held.then(() => startAgent(opts).done), kill: async () => { release(); } };
    } });
    const child = new EventEmitter(); child.pid = 123; child.stdin = { on() {}, write() {} };
    completion = new Promise((resolve, reject) => setImmediate(() => current.run('snapshot survives deletion').then((r) => { child.emit('close', 0); resolve(r); }, reject)));
    return child;
  } });
  t.after(() => { release(); current?.abort(); });
  assert.equal((await call('/api/agents', 'POST', definition)).status, 201);
  assert.equal((await call('/api/agents/seclint/prompt', 'PUT', { text: savedPrompt })).status, 200);
  assert.equal((await call('/api/runs', 'POST', { request: 'snapshot', workflow: { gates: [['seclint']] }, noPlan: true, trustedHost: true })).status, 202);
  await started;
  try {
    assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 200);
    assert.equal((await call('/api/agents')).body.roles.some((r) => r.id === 'seclint'), false);
  } finally { release(); }
  assert.equal((await completion).status, 'success', 'deleting settings must not change running snapshot');
  const es = fs.readFileSync(path.join(current.config.hiveDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(es.find((e) => e.type === 'gate_result').keyword, 'SECLINT_PASSED');
  assert.equal(es[0].roles.find((r) => r.id === 'seclint').name, 'Security Lint');
  assert.equal(gatePrompt.split('\n\n## Who decides')[0], savedPrompt, 'running gate must retain deleted prompt snapshot');
  const next = await call('/api/runs', 'POST', { request: 'next run', workflow: { gates: [['seclint']] }, noPlan: true, trustedHost: true });
  assert.equal(next.status, 400); assert.match(next.body.error, /seclint/);
});

test('final review: malformed workflow shapes never break agents CRUD or control', async (t) => {
  const original = fs.readFileSync;
  let workflow;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(PACKAGE_ROOT, 'scranton.config.json')) return JSON.stringify({ workflow });
    return original.call(this, file, ...args);
  });
  for (const registry of [false, true]) {
    const { call } = await fixture(t, registry);
    for (const gates of ['seclint', { seclint: true }, ['seclint'], [null], [['seclint'], 'angela'], [['seclint'], {}]]) {
      workflow = { gates };
      assert.equal((await call('/api/agents')).status, 200, 'malformed workflow GET');
      assert.ok((await call('/api/agents')).body.warnings.length > 0);
      assert.equal((await call('/api/control')).status, 200, 'malformed workflow control');
      assert.equal((await call('/api/agents', 'POST', definition)).status, 201, 'malformed workflow POST');
      assert.equal((await call('/api/agents/seclint', 'PATCH', { name: 'Lint' })).status, 200, 'malformed workflow PATCH');
      assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 200, `malformed workflow DELETE ${JSON.stringify(gates)}`);
    }
    workflow = { gates: [['seclint']] };
    assert.equal((await call('/api/agents', 'POST', definition)).status, 201);
    assert.equal((await call('/api/agents/seclint', 'DELETE')).status, 409, 'well-formed configured workflow blocks deletion');
  }
});
