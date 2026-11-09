import './docker-model-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createRegistryRouter } from '../../src/server/registry-router.js';
import { createControl } from '../../src/server/control.js';
import { runCli } from '../../src/core/cli.js';

function fixture(t) {
  const base = path.resolve('.scratch/mp-fix-backend'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'server-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), ws = path.join(dir, 'ws'); fs.mkdirSync(ws);
  const registry = createProjectRegistry({ dataDir: data });
  const project = registry.addProject({ name: 'Test', workspace: ws }), chat = registry.createChat(project.id);
  return { dir, data, ws, registry, project, chat };
}
function request() {
  return Object.assign(new PassThrough(), { method: 'POST', headers: { host: '127.0.0.1:1771', 'x-scranton-client': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1', localPort: 1771 } });
}
function response() { return { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } }; }
function child() { return Object.assign(new EventEmitter(), { pid: 123 }); }

test('registry pins contexts while request body and catalog are pending; derived title is safe', async (t) => {
  const { data, ws, project, chat, registry } = fixture(t);
  let resolveCatalog, lookedUp;
  const entered = new Promise((resolve) => { lookedUp = resolve; });
  const catalog = new Promise((resolve) => { resolveCatalog = resolve; });
  const proc = child(); let closed = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const router = createRegistryRouter({ dataDir: data, control: { workspace: ws, auth: { close() {} } }, maxConcurrentRuns: 4,
    contextFactory({ hive, control }) {
      const controller = createControl({ hive, ...control, auth: { listModels() { lookedUp(); return catalog; } }, runner: () => proc });
      return { controller, subscribers: 0, async close() { closed++; await controller.close(); } };
    } });
  t.after(async () => { proc.emit('close', 0); await router.close(); });

  const req = request(), res = response();
  const pending = router.handle(req, res, `/api/projects/${project.id}/chats/${chat.id}/runs`);
  t.mock.timers.tick(1100);
  assert.equal(closed, 0, 'body wait must pin context');
  req.end(JSON.stringify({ request: 'First\nsecond\tthird', models: {} }));
  await entered; t.mock.timers.tick(1100);
  assert.equal(closed, 0, 'catalog wait must pin context');
  resolveCatalog({ providers: [] }); await pending;
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(registry.getChat(project.id, chat.id).title, 'First second third');
});

test('server child explicitly selects a hive despite config dataDir', async (t) => {
  const { dir, ws, chat } = fixture(t);
  let invocation; const proc = child();
  const controller = createControl({ hive: chat.hiveDir, workspace: ws, auth: { close() {} }, runner: (...args) => { invocation = args; return proc; } });
  t.after(async () => { proc.emit('close', 0); await controller.close(); });
  const req = request(), res = response();
  const pending = controller.handle(req, res, '/api/runs'); req.end(JSON.stringify({ request: 'goal' })); await pending;
  const config = path.join(dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ dataDir: path.join(dir, 'data') }));
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  let ran = false;
  t.mock.method(Orchestrator.prototype, 'run', async () => { ran = true; return { status: 'success' }; });
  const argv = invocation[1].slice(1); argv.splice(argv.indexOf('--'), 0, '--config', config);
  let output = ''; const stream = { write(s) { output += s; } };
  // Reuse the server's existing lease only for the mocked orchestrator.
  const env = { ...invocation[2].env, SCRANTON_PARENT_GUARD: '1' };
  assert.equal(await runCli(argv, { cwd: dir, env, stdout: stream, stderr: stream }), 0, output);
  assert.equal(ran, true);
});

test('project polling caches archived events and isolates corrupt chats from other run starts', async (t) => {
  const { data, ws, project, chat, registry } = fixture(t);
  const archive = path.join(chat.hiveDir, 'runs', 'old'); fs.mkdirSync(archive, { recursive: true });
  const events = path.join(archive, 'events.jsonl');
  fs.writeFileSync(events, JSON.stringify({ runId: 'old', type: 'run_finished', status: 'success' }) + '\n');
  const proc = child();
  const router = createRegistryRouter({ dataDir: data, control: { workspace: ws, auth: { close() {} } }, maxConcurrentRuns: 4,
    contextFactory({ hive, control }) { const controller = createControl({ hive, ...control, runner: () => proc }); return { controller, close: () => controller.close() }; } });
  t.after(async () => { proc.emit('close', 0); await router.close(); });
  let reads = 0; const original = fs.openSync;
  t.mock.method(fs, 'openSync', function (file, ...args) { if (file === events) reads++; return original.call(this, file, ...args); });
  const poll = async () => { const req = request(); req.method = 'GET'; const res = response(); await router.handle(req, res, '/api/projects'); return res; };
  assert.equal((await poll()).status, 200); const first = reads;
  await poll(); assert.equal(reads, first, 'unchanged archives must not be reread');
  const bad = registry.createChat(project.id);
  fs.writeFileSync(path.join(data, 'projects', project.id, 'chats', bad.id, 'chat.json'), 'null');
  const listing = await poll(); assert.equal(listing.status, 200);
  assert.equal(listing.body.projects[0].chats.find((c) => c.id === bad.id).status, 'error');
  const req = request(), res = response(); const pending = router.handle(req, res, `/api/projects/${project.id}/chats/${chat.id}/runs`);
  req.end(JSON.stringify({ request: 'goal' })); await pending; assert.equal(res.status, 202);
});
