import './docker-model-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture } from '../core/dreaming-reflection-fixtures.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createControl } from '../../src/server/control.js';
import { createPipelineSupervisor } from '../../src/core/pipeline-supervisor.js';

async function server(t, complete) {
  const f = fixture(t); f.team();
  const srv = await startVisualizerServer({ dataDir: f.dataDir, publicDir: f.dir, port: 0, control: { auth: f.auth, completeReflection: complete ? (r) => complete(r, f) : async () => f.completion() } });
  f.onClose(() => srv.close()); const route = `/api/projects/${f.project.id}/dreaming`;
  const req = async (suffix = '', body, headers = {}) => {
    const r = await fetch(srv.url + route + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, value: await r.json() };
  };
  return { ...f, srv, route, req };
}
async function settled(f) {
  for (let i = 0; i < 50; i++) { const r = await f.req('/proposal'); if (r.value.state !== 'running') return r.value; await new Promise((r) => setTimeout(r, 10)); }
  assert.fail('Reflection did not settle');
}

test('HTTP proposal is 202 only after synchronous preflight, review is ID-specific, status retains reflection', async (t) => {
  let finish; const f = await server(t, () => new Promise((resolve) => { finish = resolve; }));
  assert.equal((await f.req('/propose', {})).status, 400);
  assert.equal((await f.req('/propose', { model: 'fixture/unknown' })).status, 400);
  assert.equal((await f.req('/propose', { provider: 'fixture' })).status, 400);
  const started = await f.req('/propose', { provider: 'fixture', model: 'scripted' });
  assert.equal(started.status, 202); assert.equal(started.value.reflection.state, 'running'); assert.ok(finish);
  assert.equal((await f.req('/propose', { model: 'fixture/scripted' })).status, 409);
  finish(f.completion()); const ready = await settled(f); assert.equal(ready.state, 'ready');
  assert.equal((await f.req('/propose', { model: 'fixture/scripted' })).status, 409);
  assert.equal((await f.req('/proposal/apply', { proposalId: 'stale' })).status, 409);
  const applied = await f.req('/proposal/apply', { proposalId: ready.proposal.id });
  assert.equal(applied.status, 200); assert.equal(applied.value.reflection.memory.length, 1);
  assert.equal((await f.req()).value.reflection.memory.length, 1);
  assert.equal((await f.req('/rollback', {})).value.reflection.memory.length, 0);
});

test('proposal routes retain Host/Origin/client/content-type/size/strict-body guards and busy preflight', async (t) => {
  const f = await server(t);
  for (const [headers, status] of [[{ 'X-Scranton-Client': '' }, 403], [{ Origin: 'https://foreign.test' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) assert.equal((await f.req('/propose', { model: 'fixture/scripted' }, headers)).status, status);
  for (const [suffix, body] of [['/propose', { model: {} }], ['/propose', { model: 'fixture/scripted', tools: [] }], ['/proposal/apply', { proposalId: 'x', path: 'private' }], ['/proposal/reject', {}], ['/cancel', { force: true }], ['/settings', { reflectionTimeoutSeconds: 61 }], ['/settings', { reflectionEnabled: 'true' }]]) assert.equal((await f.req(suffix, body)).status, 400, suffix);
  const hostStatus = await new Promise((resolve, reject) => { const req = http.request(f.srv.url + f.route + '/proposal', { headers: { Host: 'foreign.test', 'X-Scranton-Client': '1' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); }); assert.equal(hostStatus, 403);
  const r = await fetch(f.srv.url + f.route + '/propose', { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: ' '.repeat(65537) }); assert.equal(r.status, 413);
  f.write(path.join(f.chat.hiveDir, 'control/owner.json'), 'null');
  assert.equal((await f.req('/propose', { model: 'fixture/scripted' })).status, 409);
});

test('HTTP cancel aborts owned job, ignores late result and catches a background provider failure', async (t) => {
  let finish, signal; const f = await server(t, (r) => { signal = r.signal; return new Promise((resolve) => { finish = resolve; }); });
  await f.req('/propose', { model: 'fixture/scripted' });
  assert.equal((await f.req('/cancel', {})).status, 200); assert.equal(signal.aborted, true);
  finish(f.completion()); const done = await settled(f); assert.equal(done.state, 'cancelled'); assert.equal(done.proposal, null); assert.deepEqual(done.memory, []);
  const broken = await server(t, async () => { throw Error('PRIVATE PROVIDER BODY'); });
  assert.equal((await broken.req('/propose', { model: 'fixture/scripted' })).status, 202);
  const failed = await settled(broken); assert.equal(failed.state, 'failed'); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE PROVIDER BODY/);
});

test('Team launch aborts reflection before runner and never waits for optional cleanup', async (t) => {
  const f = fixture(t); let cancelled = false, launched = false;
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const control = createControl({ hive: path.join(f.dir, 'hive'), workspace: f.workspace, prepareThread: true, auth: { close() {} },
    dreaming: () => ({ cancelReflection() { cancelled = true; return new Promise(() => {}); }, context: () => '', policy: () => null }),
    runner() { assert.equal(cancelled, true); launched = true; return child; } });
  f.onClose(() => control.close());
  const req = Object.assign(new PassThrough(), { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1', localPort: 1 } });
  let response; const pending = control.handle(req, { writeHead() {}, end(s) { response = JSON.parse(s); } }, '/api/runs');
  req.end(JSON.stringify({ request: 'Current task', trustedHost: true })); await pending;
  assert.equal(launched, true, JSON.stringify(response)); child.emit('close', 0);
});

test('Pipeline start aborts reflection synchronously before capability probe without awaiting cleanup', async (t) => {
  const f = fixture(t); let cancelled = false;
  const supervisor = createPipelineSupervisor({ dataDir: f.dataDir, env: { ...process.env, SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(f.dir, 'workspaces') }, auth: f.auth,
    dreaming: () => ({ cancelReflection() { cancelled = true; return new Promise(() => {}); } }) });
  f.onClose(() => supervisor.close());
  const pending = supervisor.start(f.project, f.pipeline, { demo: true, task: 'Synthetic task' }); assert.equal(cancelled, true);
  assert.ok((await pending).runId);
});

test('shutdown drains the HTTP listener even when a controller cleanup rejects', async (t) => {
  const f = fixture(t); let closed = 0;
  const srv = await startVisualizerServer({ dataDir: f.dataDir, publicDir: f.dir, port: 0, control: { auth: { close() { closed++; throw Error('Synthetic cleanup failure'); } } } });
  f.onClose(() => srv.close().catch(() => {}));
  await assert.rejects(srv.close(), /Visualizer resource cleanup failed/);
  assert.equal(closed, 1);
  await assert.rejects(fetch(srv.url), /fetch failed/);
  await assert.rejects(srv.close(), /Visualizer resource cleanup failed/);
  assert.equal(closed, 1, 'cleanup is not retried after its failure');
});

test('project history deletion drains active reflection before removing its authority directory', async (t) => {
  let aborted = false, cleaned = false;
  const f = await server(t, ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      setTimeout(() => { cleaned = true; resolve({ text: '{"summary":"","operations":[]}', usage: null }); }, 40);
    }, { once: true });
  }));
  assert.equal((await f.req('/propose', { model: 'fixture/scripted' })).status, 202);
  const directory = path.join(f.dataDir, 'projects', f.project.id);
  const response = await fetch(f.srv.url + '/api/projects/remove', { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: f.project.id, deleteHistory: true }) });
  assert.equal(response.status, 200, await response.text());
  assert.equal(aborted, true); assert.equal(cleaned, true);
  assert.equal(fs.existsSync(directory), false, 'cancel persistence must not recreate deleted history');
  assert.ok(!f.registry.listProjects().some((p) => p.id === f.project.id));
});
