import './runtime-env.js';
import test from 'node:test';
import { cleanup } from '../core/fixture-cleanup.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { killTree } from '../../src/core/process-tree.js';
import { createControl } from '../../src/server/control.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import * as leases from '../../src/core/run-lease.js';
import { EventRecorder } from '../../src/core/events.js';

function fixture(t) {
  const root = path.resolve('.scratch/usability/fix3/orphan-recovery'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'r-'));
  cleanup(t, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const hive = path.join(dir, 'h'), workspace = path.join(dir, 'w'); fs.mkdirSync(workspace);
  const env = { ...process.env, SCRANTON_DATA: '', SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), SCRANTON_FAKE_MODE: '1', SCRANTON_ISOLATION_ROOT: path.join(dir, 'i'), PI_CODING_AGENT_DIR: path.join(dir, 'pi') };
  return { dir, hive, workspace, env };
}
const auth = { close() {} };
async function server(t, f, extra = {}) {
  const srv = await startVisualizerServer({ hiveDir: f.hive, publicDir: f.dir, port: 0, control: { workspace: f.workspace, auth,
    runner: (exe, args, options) => spawn(exe, args, { ...options, env: { ...options.env, ...f.env, SCRANTON_RUN_ID: options.env.SCRANTON_RUN_ID, SCRANTON_PARENT_GUARD: options.env.SCRANTON_PARENT_GUARD, SCRANTON_RUN_LEASE: options.env.SCRANTON_RUN_LEASE } }) }, ...extra });
  cleanup(t, () => srv.close()); return srv;
}
async function req(srv, route, body, headers = {}) {
  const res = await fetch(srv.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, value: await res.json() };
}
async function until(fn, pred, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (pred(value)) return value; await sleep(50); }
  throw Error('Timed out waiting for recovery fixture');
}
function hardKill(pid) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(-pid, 'SIGKILL');
}
function journal(hive) { return fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
function legacy(f, runId = '2dda5818') {
  fs.mkdirSync(path.join(f.hive, 'control'), { recursive: true });
  fs.writeFileSync(path.join(f.hive, 'control', 'owner.json'), JSON.stringify({ v: 1, mode: 'run', request: 'Hey', workspace: f.workspace, startedAt: '2026-11-08T22:56:00.000Z', runId, exitCode: null, token: 'legacy-token' }));
  return runId;
}

test('hard-killed server child is automatically finished on restart; chat accepts another passing run', { timeout: 90000 }, async (t) => {
  const f = fixture(t), srv = await server(t, f);
  assert.equal((await req(srv, '/api/runs', { demo: { scenario: 'blocked', delayMs: 0 } })).status, 202);
  const paused = await until(() => req(srv, '/api/control').then((r) => r.value), (s) => s.pendingHuman);
  const runId = paused.run.runId;
  assert.equal(leases.readRunHeartbeat(f.hive).pid, paused.run.pid);
  assert.equal((await req(srv, '/api/runs/release', { runId })).status, 409);
  assert.equal(leases.readRunLease(f.hive).runId, runId);
  hardKill(paused.run.pid);
  await srv.close();
  const restarted = await server(t, f);
  const recovered = (await req(restarted, '/api/control')).value;
  assert.equal(recovered.orphan, null, 'dead owner must be automatically recovered');
  assert.equal(recovered.pendingHuman, null);
  const finish = journal(f.hive).at(-1);
  assert.equal(finish.runId, runId); assert.equal(finish.type, 'run_finished'); assert.equal(finish.status, 'aborted');
  assert.equal(finish.summary, "Interrupted: the run's process ended without finishing");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.hive, 'state.json'))).status, 'aborted');
  assert.equal((await req(restarted, '/api/runs', { demo: { scenario: 'happy', delayMs: 0 } })).status, 202);
  const done = await until(() => req(restarted, '/api/control').then((r) => r.value), (s) => s.lastExit);
  assert.equal(done.lastExit.exitCode, 0, done.lastExit.outputTail);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.hive, 'runs', runId, 'state.json'))).status, 'aborted');
});

test('legacy unknown owner releases through protected single route and permits a new run', { timeout: 60000 }, async (t) => {
  const f = fixture(t), runId = legacy(f), srv = await server(t, f);
  assert.equal((await req(srv, '/api/control')).value.orphan.owner, 'unknown', 'legacy lease must be unknown');
  for (const [headers, status] of [[{ 'X-Scranton-Client': '' }, 403], [{ Origin: 'https://foreign.test' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
    assert.equal((await req(srv, '/api/runs/release', { runId }, headers)).status, status);
  }
  assert.equal((await req(srv, '/api/runs/release', ' '.repeat(262145))).status, 413);
  assert.equal((await req(srv, '/api/runs/release', { runId: 'wrong' })).status, 409);
  assert.ok(leases.readRunLease(f.hive));
  assert.deepEqual(await req(srv, '/api/runs/release', { runId }), { status: 200, value: { ok: true, warnings: [] } });
  assert.equal(journal(f.hive).at(-1).summary, 'Released by the user');
  assert.equal(leases.readRunLease(f.hive), null);
  assert.equal((await req(srv, '/api/runs/release', { runId })).status, 409);
  assert.equal((await req(srv, '/api/runs', { demo: { scenario: 'happy', delayMs: 0 } })).status, 202);
  const done = await until(() => req(srv, '/api/control').then((r) => r.value), (s) => s.lastExit);
  assert.equal(done.lastExit.exitCode, 0, done.lastExit.outputTail);
});

test('registry legacy release aliases clear live/delete guards and allow follow-up', { timeout: 60000 }, async (t) => {
  const f = fixture(t), dataDir = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Recovery', workspace: f.workspace });
  const chat = registry.createChat(project.id); f.hive = chat.hiveDir;
  const runId = legacy(f), srv = await server(t, f, { dataDir });
  const prefix = `/api/projects/${project.id}/chats/${chat.id}`;
  assert.equal((await req(srv, prefix + '/control')).value.orphan.owner, 'unknown');
  assert.equal((await req(srv, prefix + '/release', { runId: 'wrong' })).status, 409);
  assert.equal((await req(srv, prefix + '/runs/release', { runId })).status, 200);
  assert.equal((await req(srv, '/api/control')).value.running, 0);
  assert.equal((await req(srv, prefix + '/runs', { demo: { scenario: 'happy', delayMs: 0 } })).status, 202);
  const done = await until(() => req(srv, prefix + '/control').then((r) => r.value), (s) => s.lastExit);
  assert.equal(done.lastExit.exitCode, 0, done.lastExit.outputTail);
  const previousRoot = process.env.SCRANTON_ISOLATION_ROOT;
  process.env.SCRANTON_ISOLATION_ROOT = f.env.SCRANTON_ISOLATION_ROOT;
  try {
    const removed = await req(srv, `/api/projects/${project.id}/chats/remove`, { id: chat.id });
    assert.equal(removed.status, 200, removed.value.error);
  } finally {
    if (previousRoot === undefined) delete process.env.SCRANTON_ISOLATION_ROOT; else process.env.SCRANTON_ISOLATION_ROOT = previousRoot;
  }
});

test('external CLI owner is alive, release refuses, Request stop still aborts it', { timeout: 60000 }, async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['bin/scranton.js', 'demo', '--scenario', 'blocked', '--delay', '0', '--hive', f.hive, '--workspace', f.workspace, '--on-breaker', 'hive'], { env: f.env, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  cleanup(t, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    await killTree(child);
    await closed;
  });
  const closed = once(child, 'close');
  await until(() => { try { return journal(f.hive); } catch { return []; } }, (events) => events.some((e) => e.type === 'hitl_request'));
  const srv = await server(t, f);
  const orphan = (await req(srv, '/api/control')).value.orphan;
  assert.equal(orphan.owner, 'alive'); assert.ok(orphan.heartbeatAt);
  await until(() => leases.readRunHeartbeat(f.hive), (beat) => beat?.at > orphan.heartbeatAt, 12000);
  assert.equal((await req(srv, '/api/control')).value.orphan.owner, 'alive', 'human wait must keep heartbeating');
  assert.deepEqual(await req(srv, '/api/runs/release', { runId: orphan.runId }), { status: 409, value: { error: 'The run is still running. Request a stop instead.' } });
  assert.equal((await req(srv, '/api/runs/stop', {})).status, 202);
  const [code] = await closed; assert.equal(code, 130);
  assert.equal(leases.readRunLease(f.hive), null);
  assert.equal(fs.existsSync(path.join(f.hive, 'control', 'heartbeat.json')), false);
});

test('PID reuse stays unknown and stop request timestamp is correlated', async (t) => {
  const f = fixture(t), runId = legacy(f), srv = await server(t, f);
  fs.writeFileSync(path.join(f.hive, 'control', 'heartbeat.json'), JSON.stringify({ v: 1, runId, pid: process.pid, at: '2026-01-01T00:00:00.000Z' }));
  await req(srv, '/api/runs/stop', {});
  const orphan = (await req(srv, '/api/control')).value.orphan;
  assert.equal(orphan.owner, 'unknown'); assert.equal(orphan.heartbeatAt, '2026-01-01T00:00:00.000Z'); assert.ok(orphan.stopRequestedAt);
});

test('release rejects remote peers even with a forged local Host', async (t) => {
  const f = fixture(t); legacy(f);
  const controller = createControl({ hive: f.hive, workspace: f.workspace, auth }); cleanup(t, () => controller.close());
  let status;
  await controller.handle({ method: 'POST', headers: { host: '127.0.0.1', 'x-scranton-client': '1' }, socket: { remoteAddress: '192.0.2.1' } }, { writeHead(code) { status = code; }, end() {} }, '/api/runs/release');
  assert.equal(status, 403); assert.ok(leases.readRunLease(f.hive));
});

for (const down of [false, true]) test(`Docker release uses fake subprocess cleanup (unreachable=${down})`, async (t) => {
  const { execFile } = await import('node:child_process');
  const f = fixture(t), runId = legacy(f);
  const recorder = new EventRecorder({ hiveDir: f.hive, runId }); recorder.start();
  recorder.emit('run_started', { request: 'Docker recovery', workspace: f.workspace, maxFailedCycles: 3, execution: { sandbox: { mode: 'docker' } } });
  recorder.emit('hitl_request', { milestoneId: null, reason: 'help', options: ['abort'] });
  const name = 'scranton-11111111-1111-4111-8111-111111111111';
  const foreign = 'scranton-22222222-2222-4222-8222-222222222222';
  const store = path.join(f.dir, 'docker.json');
  fs.writeFileSync(store, JSON.stringify({ down, containers: [{ Name: name, Config: { Labels: { 'scranton.run': runId } } }, { Name: foreign, Config: { Labels: { 'scranton.run': 'another-run' } } }] }));
  const recoveryDocker = { executable: process.execPath, run: (exe, args) => new Promise((resolve, reject) => execFile(exe, [path.resolve('test/server/orphan-fake-docker.js'), store, ...args], { windowsHide: true }, (err, out) => err ? reject(err) : resolve(out.trim()))) };
  const srv = await server(t, f, { control: { workspace: f.workspace, auth, recoveryDocker } });
  const result = await req(srv, '/api/runs/release', { runId });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.warnings, down ? ['Docker is not reachable; containers of this run could not be checked'] : []);
  assert.deepEqual(JSON.parse(fs.readFileSync(store)).containers.map((c) => c.Name), down ? [name, foreign] : [foreign]);
  assert.equal(journal(f.hive).at(-1).status, 'aborted');
  assert.equal((await req(srv, '/api/control')).value.orphan, null);
});

for (const automatic of [false, true]) test(`pre-journal crash recovers and permits a new run (automatic=${automatic})`, { timeout: 60000 }, async (t) => {
  const f = fixFixture(t), runId = legacy(f);
  if (automatic) deadHeartbeat(f, runId);
  const recorder = new EventRecorder({ hiveDir: f.hive, runId: 'different-run' }); recorder.start();
  recorder.emit('run_started', { request: 'foreign', workspace: f.workspace, maxFailedCycles: 3 });
  const before = fs.readFileSync(path.join(f.hive, 'events.jsonl'), 'utf8');
  const srv = await server(t, f);
  if (!automatic) assert.equal((await req(srv, '/api/runs/release', { runId })).status, 200, 'pre-journal manual release must succeed');
  const state = (await req(srv, '/api/control')).value;
  assert.equal(state.orphan, null, 'pre-journal crash must be recoverable');
  assert.equal(fs.readFileSync(path.join(f.hive, 'runs', 'different-run', 'events.jsonl'), 'utf8'), before);
  assert.deepEqual(journal(f.hive).map((e) => e.type), ['run_started', 'run_finished']);
  assert.deepEqual(journal(f.hive)[0].roles, []);
  assert.equal(journal(f.hive)[0].request, 'Hey');
  assert.equal(journal(f.hive)[0].workspace, f.workspace);
  assert.equal(journal(f.hive).at(-1).runId, runId);
  assert.equal((await req(srv, '/api/runs', { demo: { scenario: 'happy', delayMs: 0 } })).status, 202);
  const done = await until(() => req(srv, '/api/control').then((r) => r.value), (s) => s.lastExit);
  assert.equal(done.lastExit.exitCode, 0, done.lastExit.outputTail);
});

function fixFixture(t) {
  const root = path.resolve('.scratch/usability/fix3/orphan-fix'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'server-'));
  cleanup(t, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const workspace = path.join(dir, 'w'); fs.mkdirSync(workspace);
  return { dir, hive: path.join(dir, 'h'), workspace, env: { ...process.env, SCRANTON_DATA: '', SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), SCRANTON_FAKE_MODE: '1', SCRANTON_ISOLATION_ROOT: path.join(dir, 'i'), PI_CODING_AGENT_DIR: path.join(dir, 'pi') } };
}
function deadHeartbeat(f, runId) {
  fs.writeFileSync(path.join(f.hive, 'control', 'heartbeat.json'), JSON.stringify({ v: 1, runId, pid: 2147483647, at: new Date().toISOString() }));
}
async function fakeDocker(f, options = {}) {
  const { execFile } = await import('node:child_process');
  const store = path.join(f.dir, 'docker.json');
  fs.writeFileSync(store, JSON.stringify({ containers: [], ...options }));
  return { executable: process.execPath, run: (exe, args) => new Promise((resolve, reject) => execFile(exe, [path.resolve('test/server/orphan-fake-docker.js'), store, ...args], { windowsHide: true }, (err, out) => err ? reject(err) : resolve(out.trim()))) };
}
function dockerJournal(f, runId) {
  const recorder = new EventRecorder({ hiveDir: f.hive, runId }); recorder.start();
  recorder.emit('run_started', { request: 'Docker recovery', workspace: f.workspace, maxFailedCycles: 3, execution: { sandbox: { mode: 'docker' } } });
  return recorder;
}

test('automatic Docker-unreachable recovery retains ownership; manual release returns warning', async (t) => {
  const f = fixFixture(t), runId = legacy(f); deadHeartbeat(f, runId);
  const recorder = dockerJournal(f, runId);
  recorder.emit('run_finished', { status: 'aborted', summary: 'Already finished with uncertain cleanup' });
  const recoveryDocker = await fakeDocker(f, { down: true });
  const controller = createControl({ hive: f.hive, workspace: f.workspace, auth, recoveryDocker });
  await controller.recoverGone();
  assert.ok(leases.readRunLease(f.hive), 'automatic recovery must keep lease when Docker is unreachable');
  assert.equal(controller.snapshot().orphan.recoveryError, 'Docker is not reachable; containers of this run could not be checked');
  await controller.close();
  const srv = await server(t, f, { control: { workspace: f.workspace, auth, recoveryDocker } });
  await until(() => req(srv, '/api/control').then((r) => r.value), (s) => s.orphan?.recoveryError);
  const result = await req(srv, '/api/runs/release', { runId });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.warnings, ['Docker is not reachable; containers of this run could not be checked']);
  assert.equal(leases.readRunLease(f.hive), null);
});

for (const kind of ['empty', 'dead', 'expired']) test(`stale recovery lock is reclaimed (${kind})`, async (t) => {
  const f = fixFixture(t), runId = legacy(f);
  const file = path.join(f.hive, 'control', 'recovery.lock');
  fs.writeFileSync(file, kind === 'empty' ? '' : JSON.stringify({ pid: kind === 'dead' ? 2147483647 : process.pid }));
  if (kind === 'expired') fs.utimesSync(file, new Date(0), new Date(0));
  const srv = await server(t, f);
  assert.equal((await req(srv, '/api/runs/release', { runId })).status, 200, `stale ${kind} recovery lock must not block release`);
  assert.equal(leases.readRunLease(f.hive), null);
});

test('slow automatic recovery does not block other chats and concurrent release returns pinned 409', async (t) => {
  const f = fixFixture(t), dataDir = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Slow recovery', workspace: f.workspace });
  const slow = registry.createChat(project.id), other = registry.createChat(project.id); f.hive = slow.hiveDir;
  const runId = legacy(f); deadHeartbeat(f, runId); dockerJournal(f, runId);
  const recoveryDocker = await fakeDocker(f, { delayMs: 1800 });
  const srv = await server(t, f, { dataDir, control: { workspace: f.workspace, auth, recoveryDocker } });
  const prefix = `/api/projects/${project.id}/chats/`;
  const start = Date.now();
  const response = await req(srv, prefix + other.id + '/control');
  assert.equal(response.status, 200);
  assert.ok(Date.now() - start < 1000, 'other chat must not wait for slow Docker recovery');
  const release = await req(srv, prefix + slow.id + '/release', { runId });
  assert.deepEqual(release, { status: 409, value: { error: 'Recovery is already in progress. Try again in a moment.' } });
  assert.equal((await req(srv, prefix + slow.id + '/control')).value.orphan.recoveryError, null, '409 must not become recoveryError');
  await until(() => req(srv, prefix + slow.id + '/control').then((r) => r.value), (s) => !s.orphan);
});

test('recovery errors clear on orphan replacement and 409 does not poison snapshots', async (t) => {
  const f = fixFixture(t), runId = legacy(f);
  deadHeartbeat(f, runId); dockerJournal(f, runId);
  const recoveryDocker = await fakeDocker(f, { down: true });
  const controller = createControl({ hive: f.hive, workspace: f.workspace, auth, recoveryDocker });
  cleanup(t, () => controller.close());
  await controller.recoverGone();
  assert.ok(controller.snapshot().orphan.recoveryError);
  leases.releaseRunLease(f.hive, leases.readRunLease(f.hive).token);
  legacy(f, 'replacement');
  assert.equal(controller.snapshot().orphan.recoveryError, null, 'replacement orphan must not inherit old recovery error');
  const srv = await server(t, f);
  assert.equal((await req(srv, '/api/runs/release', { runId: 'wrong' })).status, 409);
  assert.equal((await req(srv, '/api/control')).value.orphan.recoveryError, null, '409 must not set recoveryError');
});

test('release during single-chat automatic recovery returns 409 without recording an error', async (t) => {
  const f = fixFixture(t), runId = legacy(f); deadHeartbeat(f, runId); dockerJournal(f, runId);
  const recoveryDocker = await fakeDocker(f, { delayMs: 1000 });
  const srv = await server(t, f, { control: { workspace: f.workspace, auth, recoveryDocker } });
  assert.deepEqual(await req(srv, '/api/runs/release', { runId }), { status: 409, value: { error: 'Recovery is already in progress. Try again in a moment.' } }, 'release must identify recovery in progress');
  assert.equal((await req(srv, '/api/control')).value.orphan, null, 'successful recovery clears the orphan');
});

test('release conflicts do not become recovery errors', async (t) => {
  const f = fixFixture(t); legacy(f);
  const srv = await server(t, f);
  assert.equal((await req(srv, '/api/runs/release', { runId: 'wrong' })).status, 409);
  assert.equal((await req(srv, '/api/control')).value.orphan.recoveryError, null, '409 must not set recoveryError');
});

test('mixed matching journals still fail closed without clearing ownership', async (t) => {
  const f = fixFixture(t), runId = legacy(f);
  const recorder = dockerJournal(f, runId);
  fs.appendFileSync(recorder.eventsFile, JSON.stringify({ v: 1, runId: 'foreign', seq: 2, type: 'log' }) + '\n');
  const before = fs.readFileSync(recorder.eventsFile, 'utf8');
  const srv = await server(t, f);
  assert.equal((await req(srv, '/api/runs/release', { runId })).status, 500);
  assert.ok(leases.readRunLease(f.hive));
  assert.equal(fs.readFileSync(recorder.eventsFile, 'utf8'), before);
});

test('fix3 item1: server automatic undo recovery preserves the real last run byte for byte', async (t) => {
  const f = fixture(t), recorder = new EventRecorder({ hiveDir: f.hive, runId: 'real-last' }); recorder.start();
  recorder.emit('run_started', { request: 'Real request', workspace: f.workspace, roles: [] });
  recorder.emit('run_finished', { status: 'success', summary: 'Done' });
  const saved = Object.fromEntries(['events.jsonl', 'state.json'].map((name) => [name, fs.readFileSync(path.join(f.hive, name))]));
  const lease = leases.acquireRunLease(f.hive, { runId: 'undo-crashed', mode: 'undo' }); deadHeartbeat(f, lease.runId);
  const srv = await server(t, f);
  await until(() => req(srv, '/api/control').then((r) => r.value), (s) => !s.orphan);
  for (const [name, bytes] of Object.entries(saved)) assert.deepEqual(fs.readFileSync(path.join(f.hive, name)), bytes, name);
  assert.equal(fs.existsSync(path.join(f.hive, 'runs')), false);
  assert.equal(leases.readRunLease(f.hive), null); assert.equal(leases.readRunHeartbeat(f.hive), null);
});
