import './docker-model-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { createRegistryRouter } from '../../src/server/registry-router.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createControl } from '../../src/server/control.js';
import { createPipelineSupervisor } from '../../src/core/pipeline-supervisor.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

function fixture(t) {
  const root = path.resolve('.scratch/dreaming-integration/http'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-')), closers = [];
  // Node runs after hooks in registration order; stop writers before removing their files.
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'source'); fs.mkdirSync(workspace);
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Project', workspace });
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { dir, dataDir, workspace, registry, project, write, onClose: (close) => closers.push(close) };
}
async function server(t) {
  const f = fixture(t), srv = await startVisualizerServer({ dataDir: f.dataDir, publicDir: f.dir, port: 0, control: { auth: { close() {} } } }); f.onClose(() => srv.close());
  const route = `/api/projects/${f.project.id}/dreaming`;
  const req = async (suffix = '', body, headers = {}) => {
    const res = await fetch(srv.url + route + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  return { ...f, srv, req, route };
}

test('Dreaming fixture awaits resource shutdown before removing files', async (t) => {
  let dir;
  await t.test('owned resources', async (t) => {
    const f = fixture(t); dir = f.dir;
    f.onClose(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(fs.existsSync(dir), 'Resource shutdown runs before directory removal');
      f.write(path.join(dir, 'shutdown.json'), { closed: true });
    });
  });
  assert.equal(fs.existsSync(dir), false, 'Fixture is removed after awaited shutdown');
});

test('Dreaming project HTTP defaults, guarded bodies, preview, settings, rollback and project scope', async (t) => {
  const f = await server(t), state = path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json');
  assert.equal((await f.req()).value.enabled, false); assert.equal((await f.req('/preview', {})).value.preview, true); assert.equal(fs.existsSync(state), false);
  for (const [headers, status] of [[{ 'X-Scranton-Client': '' }, 403], [{ Origin: 'https://foreign.test' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) assert.equal((await f.req('/sweep', {}, headers)).status, status, JSON.stringify(headers));
  for (const [suffix, body] of [['/preview', { path: 'arbitrary' }], ['/settings', { enabled: 'yes' }], ['/settings', { intervalMinutes: 14 }], ['/settings', { command: 'node' }], ['/sweep', []]]) assert.equal((await f.req(suffix, body)).status, 400);
  const enabled = await f.req('/settings', { enabled: true, intervalMinutes: 15 }); assert.equal(enabled.status, 200); assert.equal(enabled.value.applyPolicy, false);
  const other = f.registry.addProject({ name: 'Other', workspace: path.join(f.dir, 'other'), create: true });
  const otherRes = await fetch(f.srv.url + `/api/projects/${other.id}/dreaming`, { headers: { 'X-Scranton-Client': '1' } }); assert.equal((await otherRes.json()).enabled, false);
  assert.equal((await f.req('/rollback', {})).value.enabled, false); assert.equal((await f.req('/sweep', {})).status, 200);
  const missing = await fetch(f.srv.url + '/api/projects/missing/dreaming', { headers: { 'X-Scranton-Client': '1' } }); assert.equal(missing.status, 404);
  const oversized = await fetch(f.srv.url + f.route + '/settings', { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: ' '.repeat(262145) }); assert.equal(oversized.status, 413);
});

test('project idle guards include suspended Pipeline and corrupt Team owner metadata', async (t) => {
  const f = await server(t), chat = f.registry.createChat(f.project.id, { engine: 'pipeline' });
  const status = path.join(f.dataDir, 'projects', f.project.id, 'chats', chat.id, 'pipeline/runs/abc12345/status.json');
  f.write(status, { schema: 1, run_id: 'abc12345', status: 'suspended', created_at: '', updated_at: '' });
  assert.equal((await f.req()).value.state, 'busy');
  for (const action of ['preview', 'sweep', 'rollback', 'settings']) assert.equal((await f.req('/' + action, {})).status, 409);
  fs.rmSync(path.dirname(status), { recursive: true });
  const team = f.registry.createChat(f.project.id); f.write(path.join(team.hiveDir, 'control/owner.json'), 'null');
  assert.equal((await f.req('/sweep', {})).status, 409);
});

test('single-hive Dreaming is explicitly unsupported', async (t) => {
  const f = fixture(t), srv = await startVisualizerServer({ hiveDir: path.join(f.dir, 'hive'), publicDir: f.dir, port: 0 }); f.onClose(() => srv.close());
  const res = await fetch(srv.url + '/api/projects/default/dreaming', { headers: { 'X-Scranton-Client': '1' } }); assert.equal(res.status, 409); assert.equal((await res.json()).error, 'single_mode');
});

test('Team next-run cap and bounded advisory context reach argv without changing gates or overrides', async (t) => {
  const f = fixture(t); let args, calls = [];
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const control = createControl({ hive: path.join(f.dir, 'hive'), workspace: f.workspace, prepareThread: true, auth: { close() {} },
    dreaming: () => ({ policy: (...a) => { calls.push(a); return 1; }, context: () => 'Historical structural memory' }),
    runner(_exe, argv) { args = argv; return child; } });
  const req = Object.assign(new PassThrough(), { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1', localPort: 1 } });
  let response; const res = { writeHead() {}, end(s) { response = JSON.parse(s); } };
  try {
    const handled = control.handle(req, res, '/api/runs');
    req.end(JSON.stringify({ request: 'Current task', maxCycles: 2, trustedHost: true })); await handled;
    assert.ok(args, JSON.stringify(response)); assert.equal(args[args.indexOf('--max-cycles') + 1], '1'); assert.equal(calls[0][1], 2); assert.match(calls[0][2], /^[a-f0-9]{64}$/);
    assert.equal(args.at(-1), 'Current task');
    const history = JSON.parse(fs.readFileSync(args[args.indexOf('--thread-context') + 1])); assert.match(history.text, /advisory historical data/); assert.match(history.text, /Historical structural memory/); assert.ok(history.text.length <= 8000);
  } finally { child.emit('close', 0); await control.close(); }
});

test('Pipeline snapshots cap and structured project memory at start only, final-scope recipe abstains', async (t) => {
  const f = fixture(t), chat = f.registry.createChat(f.project.id, { engine: 'pipeline' }); let calls = [];
  const memory = [{ id: 'memory', text: 'Pipeline: recorded structural outcome.', sources: [`projects/${f.project.id}/source.json`] }];
  const env = { ...process.env, SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(f.dir, 'workspaces') };
  const auth = { listAccounts: () => [{ id: 'openai', kind: 'api_key', status: 'signed_in' }], listModels: () => ({ providers: [{ id: 'openai', models: [{ id: 'fake' }] }] }), resolveDockerCredential: () => ({ value: 'test-key' }) };
  const supervisor = createPipelineSupervisor({ dataDir: f.dataDir, env, auth, dreaming: (p) => { assert.equal(p, f.project.id); return { policy: (...a) => { calls.push(a); return 1; }, structuredContext: () => memory }; } });
  f.onClose(async () => {
    await supervisor.close();
    assert.equal(supervisor.liveCount, 0);
    assert.ok(fs.existsSync(f.dir), 'Fixture survives until Pipeline writers have stopped');
  });
  const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'openai', model: 'fake' }]));
  const body = { task: 'Current task', models, sandbox: { mode: 'host', trustHost: true }, checks: [{ id: 'test', kind: 'test', command: 'node --test' }] };
  const started = await supervisor.start(f.project, chat, body);
  const root = path.join(f.dataDir, 'projects', f.project.id, 'chats', chat.id, 'pipeline/requests', started.runId);
  const cfg = JSON.parse(fs.readFileSync(root + '.json')); assert.equal(cfg.limits.max_step_attempts, 1); assert.equal(cfg.approvals.plan, 'always'); assert.equal(cfg.checks.length, 1); assert.match(calls[0][2], /^[a-f0-9]{64}$/);
  const h = JSON.parse(fs.readFileSync(root + '.history.json')); assert.deepEqual(h.runs, []); assert.deepEqual(h.project_memory, memory);
  const other = f.registry.createChat(f.project.id, { engine: 'pipeline' }); calls = [];
  const next = await supervisor.start(f.project, other, { ...body, checks: [{ ...body.checks[0], scope: 'final' }] });
  assert.equal(calls.length, 0); const nextFile = path.join(f.dataDir, 'projects', f.project.id, 'chats', other.id, 'pipeline/requests', next.runId + '.json'); assert.equal(JSON.parse(fs.readFileSync(nextFile)).limits.max_step_attempts, undefined);
});

test('idle scheduler is default-off, defers recovery, runs enabled projects only and stops on close', async (t) => {
  const f = fixture(t), chat = f.registry.createChat(f.project.id);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const router = createRegistryRouter({ dataDir: f.dataDir, maxConcurrentRuns: 3, control: { auth: { close() {} } } });
  f.onClose(() => router.close());
  const state = path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json');
  const source = path.join(chat.hiveDir, 'events.jsonl'), owner = path.join(chat.hiveDir, 'control/owner.json');
  const publish = (runId) => f.write(source, [
    { type: 'run_started', request: 'Task', maxFailedCycles: 1 },
    { type: 'cycle_result', milestoneId: 'm1', cycle: 1, result: 'failed' },
    { type: 'milestone_finished', milestoneId: 'm1', status: 'failed' }, { type: 'run_finished', status: 'failed' }
  ].map((e, i) => JSON.stringify({ v: 1, seq: i + 1, runId, ts: new Date().toISOString(), ...e })).join('\n') + '\n');
  publish('first'); t.mock.timers.tick(60000); assert.equal(fs.existsSync(state), false);
  const dream = f.registry.dreaming(f.project.id); f.onClose(() => dream.close()); dream.configure({ enabled: true, intervalMinutes: 15 });
  f.write(owner, 'null'); t.mock.timers.tick(60000); assert.equal(dream.status().lastSweepAt, null);
  fs.rmSync(owner); t.mock.timers.tick(60000); assert.ok(dream.status().lastSweepAt);
  dream.configure({ enabled: false }); const disabled = fs.readFileSync(state, 'utf8');
  publish('second'); t.mock.timers.tick(16 * 60000); assert.equal(fs.readFileSync(state, 'utf8'), disabled);
  dream.configure({ enabled: true }); await router.close(); const closed = fs.readFileSync(state, 'utf8');
  publish('third'); t.mock.timers.tick(16 * 60000); assert.equal(fs.readFileSync(state, 'utf8'), closed);
});

test('Dreaming rejects rebinding Host using the actual HTTP transport header', async (t) => {
  const f = await server(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.srv.url + f.route, { headers: { Host: 'foreign.test', 'X-Scranton-Client': '1' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});

test('optional Team Dreaming failures never block starts or leak diagnostics or partially apply caps', async (t) => {
  const f = fixture(t);
  f.write(path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json'), '{PRIVATE-SECRET');
  for (const fault of ['factory', 'context', 'policy', 'authority']) {
    let args;
    const child = Object.assign(new EventEmitter(), { pid: 123 });
    const boom = () => { throw Error('PRIVATE-SECRET-DO-NOT-EXPOSE'); };
    const control = createControl({ hive: path.join(f.dir, fault), workspace: f.workspace, prepareThread: true, auth: { close() {} },
      dreaming: () => fault === 'authority' ? f.registry.dreaming(f.project.id) : fault === 'factory' ? boom() : { context: () => fault === 'context' ? boom() : 'MUST-NOT-INJECT', policy: boom },
      runner(_exe, argv) { args = argv; return child; } });
    const req = Object.assign(new PassThrough(), { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1', localPort: 1 } });
    let response;
    try {
      const handled = control.handle(req, { writeHead() {}, end(s) { response = JSON.parse(s); } }, '/api/runs');
      req.end(JSON.stringify({ request: 'Current task', maxCycles: 2, trustedHost: true })); await handled;
      assert.ok(args, JSON.stringify(response)); assert.equal(args[args.indexOf('--max-cycles') + 1], '2');
      assert.doesNotMatch(fs.readFileSync(args[args.indexOf('--thread-context') + 1], 'utf8'), /MUST-NOT-INJECT|PRIVATE-SECRET/);
      assert.match(control.snapshot().dreamingWarning, /Optional Dreaming unavailable/);
      assert.doesNotMatch(JSON.stringify(response), /PRIVATE-SECRET/);
    } finally { child.emit('close', 0); await control.close(); }
  }
});

test('optional Pipeline Dreaming failures keep configured ceilings, checks and fresh approvals', async (t) => {
  const f = fixture(t);
  const env = { ...process.env, SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(f.dir, 'workspaces') };
  const auth = { listAccounts: () => [{ id: 'openai', kind: 'api_key', status: 'signed_in' }], listModels: () => ({ providers: [{ id: 'openai', models: [{ id: 'fake' }] }] }), resolveDockerCredential: () => ({ value: 'test-key' }) };
  const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'openai', model: 'fake' }]));
  f.write(path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json'), '{PRIVATE-SECRET');
  for (const fault of ['factory', 'context', 'policy', 'authority']) {
    const boom = () => { throw Error('PRIVATE-SECRET-DO-NOT-EXPOSE'); };
    const supervisor = createPipelineSupervisor({ dataDir: f.dataDir, env, auth, dreaming: () => fault === 'authority' ? f.registry.dreaming(f.project.id) : fault === 'factory' ? boom() : { structuredContext: () => fault === 'context' ? boom() : [{ id: 'memory', text: 'MUST-NOT-INJECT', sources: [] }], policy: boom } });
    try {
      const chat = f.registry.createChat(f.project.id, { engine: 'pipeline' });
      const started = await supervisor.start(f.project, chat, { task: 'Current task', models, sandbox: { mode: 'host', trustHost: true }, checks: [{ id: 'test', kind: 'test', command: 'node --test' }] });
      assert.match(started.dreamingWarning, /Optional Dreaming unavailable/); assert.doesNotMatch(JSON.stringify(started), /PRIVATE-SECRET/);
      const root = path.join(f.dataDir, 'projects', f.project.id, 'chats', chat.id, 'pipeline/requests', started.runId);
      const cfg = JSON.parse(fs.readFileSync(root + '.json')); assert.equal(cfg.limits.max_step_attempts, undefined); assert.equal(cfg.approvals.plan, 'always'); assert.equal(cfg.checks.length, 1);
      assert.equal(fs.existsSync(root + '.history.json'), false);
      await assert.rejects(supervisor.start(f.project, f.registry.createChat(f.project.id, { engine: 'pipeline' }), { task: '' }), /task/i);
    } finally { await supervisor.close(); }
  }
});

test('explicit Dreaming API still reports corrupt authority fail-closed with safe error', async (t) => {
  const f = await server(t);
  f.write(path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json'), '{PRIVATE-SECRET');
  for (const action of ['', '/preview', '/sweep']) {
    const result = await f.req(action, action ? {} : undefined);
    assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE-SECRET/);
  }
});
