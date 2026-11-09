import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
function request(url, route, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1', ...headers } }, (res) => {
      let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test('agent routes enforce client, origin, host, bounds, reset and registry-global prompts', async (t) => {
  for (const registry of [false, true]) {
    const root = path.resolve('.scratch/roles-backend'); fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'server-'));
    const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, ...(registry ? { dataDir: path.join(dir, 'data') } : {}), control: { workspace: path.join(dir, 'workspace'), auth: { close() {} } } });
    t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    for (const headers of [{ 'X-Scranton-Client': '' }, { Origin: 'https://evil.test' }, { Host: 'evil.test' }]) assert.equal((await request(srv.url, '/api/agents', 'GET', undefined, headers)).status, 403);
    let catalog = await request(srv.url, '/api/agents'); assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.roles.map((r) => r.id), ['michael', 'dwight', 'oscar', 'hank', 'angela']);
    assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'PUT', { text: 'x'.repeat(32769) })).status, 413);
    assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'PUT', { text: '  ' })).status, 400);
    assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'PUT', { text: 'A saved custom role' })).status, 200);
    catalog = await request(srv.url, '/api/agents'); const oscar = catalog.body.roles.find((r) => r.id === 'oscar');
    assert.equal(oscar.prompt.source, 'custom'); assert.equal(oscar.prompt.text, 'A saved custom role');
    assert.deepEqual(oscar.prompt.missingKeywords, ['REVIEW_APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']);
    assert.equal(fs.readFileSync(path.join(dir, registry ? 'data' : 'hive', 'prompts', 'oscar.md'), 'utf8'), 'A saved custom role\n');
    assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'DELETE')).status, 200);
    assert.equal((await request(srv.url, '/api/agents')).body.roles.find((r) => r.id === 'oscar').prompt.source, 'builtin');
    assert.deepEqual((await request(srv.url, '/api/control')).body.defaults.workflow, { gates: [['angela']] });
    for (const workflow of [{ gates: [] }, { gates: [['dwight']] }, { gates: [['hank'], ['hank']] }]) assert.equal((await request(srv.url, '/api/runs', 'POST', { request: 'bad', workflow })).status, registry ? 404 : 400);
  }
});

test('configuration-pinned prompts reject both update and reset without modifying files', async (t) => {
  const { PACKAGE_ROOT } = await import('../../src/core/config.js');
  const root = path.resolve('.scratch/roles-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'pinned-'));
  const skill = path.join(dir, 'pinned.md'); fs.writeFileSync(skill, 'Pinned [REVIEW_APPROVED]');
  const originalRead = fs.readFileSync;
  const configFile = path.join(PACKAGE_ROOT, 'scranton.config.json');
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === configFile) return JSON.stringify({ agents: { oscar: { skill } } });
    return originalRead.call(this, file, ...args);
  });
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, control: { workspace: path.join(dir, 'workspace'), auth: { close() {} } } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const role = (await request(srv.url, '/api/agents')).body.roles.find((r) => r.id === 'oscar');
  assert.equal(role.prompt.editable, false); assert.equal(role.prompt.source, 'config');
  assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'PUT', { text: 'replacement' })).status, 409);
  assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'DELETE')).status, 409);
  assert.equal(originalRead(skill, 'utf8'), 'Pinned [REVIEW_APPROVED]');
  assert.equal(fs.existsSync(path.join(dir, 'hive', 'prompts', 'oscar.md')), false);
});

test('initial and follow-up runs pass workflow and five-role model choices to children', async (t) => {
  const { EventEmitter } = await import('node:events');
  for (const route of ['/api/runs', '/api/projects/default/chats/default/runs']) {
    const root = path.resolve('.scratch/roles-backend'); fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'launch-'));
    let launch, child;
    const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0, control: {
      workspace: path.join(dir, 'workspace'), auth: { close() {}, listModels: async () => ({ providers: [{ id: 'fake', signedIn: true, models: [{ id: 'catalog' }] }] }) },
      runner: (_exe, args, options) => { launch = { args, options }; child = new EventEmitter(); child.pid = 123; child.stdin = { on() {}, write() {} }; return child; }
    } });
    t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const models = Object.fromEntries(['michael', 'dwight', 'oscar', 'hank', 'angela'].map((role) => [role, { provider: 'fake', model: 'catalog' }]));
    const workflow = { gates: [['oscar', 'hank'], ['angela']] };
    for (const gates of [[], [['dwight']], [['hank'], ['hank']]]) assert.equal((await request(srv.url, route, 'POST', { request: 'bad', workflow: { gates }, models })).status, 400);
    assert.equal(launch, undefined);
    const response = await request(srv.url, route, 'POST', { request: 'pass gates', workflow, models });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(launch.args[launch.args.indexOf('--gates') + 1], 'oscar+hank,angela');
    for (const role of Object.keys(models)) {
      assert.equal(launch.options.env[`SCRANTON_${role.toUpperCase()}_PROVIDER`], 'fake');
      assert.equal(launch.options.env[`SCRANTON_${role.toUpperCase()}_MODEL`], 'catalog');
    }
    child.emit('message', { type: 'scranton-startup-refused', token: launch.options.env.SCRANTON_RUN_LEASE });
    child.emit('close', 2);
    assert.equal(fs.existsSync(path.join(dir, 'hive', 'control', 'owner.json')), false);
  }
});

test('agent prompt routes are unavailable without control and refuse incorrect methods', async (t) => {
  const dir = path.resolve('.scratch/roles-backend/no-control'); fs.mkdirSync(dir, { recursive: true });
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, port: 0 });
  t.after(() => srv.close());
  assert.equal((await request(srv.url, '/api/agents')).status, 404);
  assert.equal((await request(srv.url, '/api/agents/oscar/prompt', 'PUT', { text: 'no' })).status, 404);
});
