import './docker-model-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { tempDir } from '../core/helpers.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

async function setup(t, control = {}) {
  const dir = tempDir(t);
  const hive = path.join(dir, 'hive');
  const workspace = path.join(dir, 'ws');
  const srv = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0, control: control === false ? undefined : { workspace, ...control } });
  t.after(() => srv.close());
  return { srv, hive, workspace };
}
function request(srv, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${srv.url}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1', ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let value; try { value = JSON.parse(text); } catch { value = text; } resolve({ status: res.statusCode, value, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}
async function until(fn, predicate, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (predicate(value)) return value; await sleep(50); }
  throw Error('Timed out');
}

test('read-only control discovery and disabled POST routes', async (t) => {
  const { srv } = await setup(t, false);
  assert.deepEqual((await request(srv, '/api/control')).value, { v: 1, enabled: false });
  for (const route of ['/api/runs', '/api/hitl', '/api/runs/stop']) assert.equal((await request(srv, route, {})).status, 404);
});

test('control request hardening', async (t) => {
  const { srv } = await setup(t);
  for (const route of ['/api/runs', '/api/hitl', '/api/runs/stop']) {
    for (const [headers, status] of [
      [{ 'X-Scranton-Client': '' }, 403],
      [{ Origin: 'https://foreign.test' }, 403],
      [{ Host: 'foreign.test' }, 403],
      [{ 'Content-Type': 'text/plain' }, 415]
    ]) assert.equal((await request(srv, route, {}, headers)).status, status, `${route} ${JSON.stringify(headers)}`);
    assert.equal((await request(srv, route, ' '.repeat(65537))).status, 413);
    assert.equal((await request(srv, route, '{bad')).status, 400);
    assert.equal((await request(srv, route, {}, { Origin: srv.url })).headers['access-control-allow-origin'], undefined);
  }
});

test('run and HITL validation, no pending stop/answer conflicts', async (t) => {
  const { srv } = await setup(t);
  for (const body of [{}, { request: '' }, { request: 'x'.repeat(4001) }, { request: 'x', workspace: 'relative' }, { demo: { scenario: 'no' } }, { demo: { scenario: 'happy', delayMs: 5001 } }, { request: 'x', maxCycles: 11 }, { request: 'x', noPlan: 'yes' }]) {
    assert.equal((await request(srv, '/api/runs', body)).status, 400);
  }
  assert.equal((await request(srv, '/api/hitl', { decision: 'skip' })).status, 409);
  assert.equal((await request(srv, '/api/runs/stop', {})).status, 409);
});

test('real demo breaker -> pendingHuman -> feedback -> success', { timeout: 60000 }, async (t) => {
  const { srv } = await setup(t);
  assert.equal((await request(srv, '/api/runs', { demo: { scenario: 'breaker', delayMs: 0 } })).status, 202);
  assert.equal((await request(srv, '/api/runs', { demo: { scenario: 'happy' } })).status, 409);
  const control = () => request(srv, '/api/control').then((r) => r.value);
  const paused = await until(control, (c) => c.pendingHuman);
  assert.equal(paused.run.runId, paused.pendingHuman.runId);
  assert.equal(paused.pendingHuman.milestoneId, 'm2');
  for (const body of [{ decision: 'bad' }, { decision: 'feedback' }, { decision: 'feedback', feedback: ' ' }, { decision: 'feedback', feedback: 'x'.repeat(8001) }]) assert.equal((await request(srv, '/api/hitl', body)).status, 400);
  assert.equal((await request(srv, '/api/hitl', { decision: 'feedback', feedback: 'Use current directory' })).status, 202);
  const done = await until(control, (c) => c.lastExit);
  assert.equal(done.lastExit.exitCode, 0, done.lastExit.outputTail);
  assert.equal(done.run, null);
  assert.equal(done.pendingHuman, null);
  assert.match(done.lastExit.outputTail, /Run finished: success/);
});

test('stop API before/during run publishes aborted exit 130; close stops human wait', { timeout: 30000 }, async (t) => {
  const { srv } = await setup(t);
  const control = () => request(srv, '/api/control').then((r) => r.value);
  await request(srv, '/api/runs', { demo: { scenario: 'happy', delayMs: 5000 } });
  assert.equal((await request(srv, '/api/runs/stop', {})).status, 202);
  const done = await until(control, (c) => c.lastExit);
  assert.equal(done.lastExit.exitCode, 130);
  await request(srv, '/api/runs', { demo: { scenario: 'blocked', delayMs: 0 } });
  await until(control, (c) => c.pendingHuman);
  await srv.close();
});

test('injectable runner receives argv-only request, workspace and output tail', async (t) => {
  let invocation;
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  const { srv, workspace } = await setup(t, { runner: (...args) => { invocation = args; return child; } });
  const text = '--evil & echo "hi"';
  assert.equal((await request(srv, '/api/runs', { request: text, noPlan: true, maxCycles: 2 })).status, 202);
  assert.equal(invocation[0], process.execPath);
  assert.equal(invocation[1].at(-1), text);
  assert.equal(invocation[2].shell, undefined);
  assert.ok(fs.existsSync(workspace));
  child.stdout.write('\x1b[31m' + 'x'.repeat(6000));
  child.stderr.write('end\x1b[0m');
  child.emit('close', 7);
  const done = (await request(srv, '/api/control')).value;
  assert.equal(done.lastExit.exitCode, 7);
  assert.equal(done.lastExit.outputTail.length, 4096);
  assert.ok(!done.lastExit.outputTail.includes('\x1b'));
});

for (const shutdown of [false, true]) {
  test(`${shutdown ? 'close' : 'stop'} kills an uncooperative child after fallback`, { timeout: 22000 }, async (t) => {
    const { spawn } = await import('node:child_process');
    const { srv } = await setup(t, { runner: () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }) });
    await request(srv, '/api/runs', { request: 'hang' });
    if (shutdown) await srv.close();
    else {
      assert.equal((await request(srv, '/api/runs/stop', {})).status, 202);
      const done = await until(() => request(srv, '/api/control').then((r) => r.value), (c) => c.lastExit, 20000);
      assert.notEqual(done.lastExit.exitCode, 0);
    }
  });
}

test('chunked oversized body receives 413 rather than a disconnected socket', async (t) => {
  const { srv } = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${srv.url}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write('x'.repeat(40000));
    req.end('x'.repeat(40000));
  });
  assert.equal(status, 413);
});

test('alternate literal loopback bind supports control without accepting rebinding hosts', async (t) => {
  const dir = tempDir(t);
  const srv = await startVisualizerServer({ hiveDir: path.join(dir, 'hive'), publicDir: dir, host: '127.0.0.2', port: 0, control: { workspace: dir } });
  t.after(() => srv.close());
  assert.equal((await request(srv, '/api/control')).status, 200);
  assert.equal((await request(srv, '/api/runs/stop', {}, { Origin: srv.url })).status, 409);
  for (const Host of ['evil.test', '127.0.0.2.evil.test', '128.0.0.1']) {
    assert.equal((await request(srv, '/api/control', undefined, { Host })).status, 403);
  }
});

test('identity is assigned before spawn and exit retains it without events', async (t) => {
  let env;
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  t.after(() => child.emit('close', 1));
  const { srv } = await setup(t, { runner: (_exe, _args, options) => { env = options.env; assert.equal(options.stdio[0], 'pipe'); return child; } });
  await request(srv, '/api/runs', { request: 'identity' });
  const running = (await request(srv, '/api/control')).value.run;
  assert.ok(running.runId);
  assert.equal(env.SCRANTON_RUN_ID, running.runId);
  assert.equal(env.SCRANTON_PARENT_GUARD, '1');
  child.emit('close', 1);
  const { lastExit } = (await request(srv, '/api/control')).value;
  assert.equal(lastExit.runId, running.runId);
  assert.equal(lastExit.startedAt, running.startedAt);
});

test('durable ownership survives controller replacement and recovers only by scoped stop', async (t) => {
  const { acquireRunLease } = await import('../../src/core/run-lease.js');
  const { srv, hive } = await setup(t);
  acquireRunLease(hive, { runId: 'orphan', startedAt: new Date().toISOString() });
  const control = (await request(srv, '/api/control')).value;
  assert.equal(control.recoveryRequired, true);
  assert.equal(control.orphan.runId, 'orphan');
  assert.equal((await request(srv, '/api/runs', { request: 'must not spawn' })).status, 409);
  assert.equal((await request(srv, '/api/runs/stop', {})).status, 202);
  assert.equal(JSON.parse(fs.readFileSync(path.join(hive, 'control', 'stop.json'))).runId, 'orphan');
  assert.equal((await request(srv, '/api/runs', { request: 'still blocked' })).status, 409);
});

test('parent lifetime guard aborts on EOF and releases only matching clean ownership', async (t) => {
  const { acquireRunLease, guardParent, readRunLease, releaseRunLease } = await import('../../src/core/run-lease.js');
  const hive = tempDir(t);
  const lease = acquireRunLease(hive, { runId: 'guarded' });
  const stdin = new PassThrough();
  let aborted = false;
  const dispose = guardParent({ hiveDir: hive, stdin, env: { SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token }, abort: () => { aborted = true; } });
  stdin.end();
  await sleep(10);
  assert.equal(aborted, true);
  releaseRunLease(hive, 'wrong-token');
  assert.ok(readRunLease(hive));
  dispose({ clean: true });
  assert.equal(readRunLease(hive), null);
});

test('execution overrides are validated and forwarded before request terminator', async (t) => {
  let args;
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  t.after(() => child.emit('close', 0));
  const { srv } = await setup(t, { runner: (_exe, argv) => { args = argv; return child; } });
  for (const options of [{ maxParallel: 0 }, { sandbox: 'host' }, { sandbox: 'unknown' }, { sandboxNetwork: 'host' }, { sandboxImage: '--help' }, { sandbox: 'docker', trustedHost: true }]) {
    assert.equal((await request(srv, '/api/runs', { request: 'test', ...options })).status, 400);
  }
  assert.equal((await request(srv, '/api/runs', { request: '--test', maxParallel: 3, sandbox: 'host', trustedHost: true, sandboxImage: 'local/image:1', sandboxNetwork: 'none' })).status, 202);
  assert.deepEqual(args.slice(args.indexOf('--parallel'), args.indexOf('--')), ['--parallel', '3', '--trusted-host', '--sandbox-image', 'local/image:1', '--sandbox-network', 'none']);
  assert.equal(args.at(-1), '--test');
});

test('chat uses authenticated atomic run-scoped queued commands, rejecting stale or terminal recipients', async (t) => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  t.after(() => child.emit('close', 0));
  const { srv, hive } = await setup(t, { runner: () => child });
  await request(srv, '/api/runs', { request: 'chat' });
  const runId = (await request(srv, '/api/control')).value.run.runId;
  fs.writeFileSync(path.join(hive, 'state.json'), JSON.stringify({ runId, instances: { 'dwight-m1': { status: 'thinking' }, 'angela-m1': { status: 'finished' } }, sessions: { 'dwight-m1': { sessionId: 'session-1' } }, chatAck: { id: 'ack-1', delivery: 'delivered' } }));
  const body = { runId, to: 'dwight-m1', text: 'hello', from: 'michael' };
  assert.equal((await request(srv, '/api/chat', body, { 'X-Scranton-Client': '' })).status, 403);
  assert.equal((await request(srv, '/api/chat', body, { Host: 'evil.test' })).status, 403);
  assert.equal((await request(srv, '/api/chat', body, { Origin: 'https://evil.test' })).status, 403);
  for (const invalid of [{ runId: 'old' }, { to: 'missing' }, { to: 'constructor' }, { to: 'angela-m1' }, { to: '../escape' }, { text: '' }, { text: 'x'.repeat(4001) }]) {
    assert.ok([400, 409].includes((await request(srv, '/api/chat', { ...body, ...invalid })).status));
  }
  const queued = await request(srv, '/api/chat', body);
  assert.equal(queued.status, 202);
  assert.equal(queued.value.delivery, 'queued');
  const files = fs.readdirSync(path.join(hive, 'control', 'chat'));
  assert.deepEqual(files, [`${queued.value.id}.json`]);
  const command = JSON.parse(fs.readFileSync(path.join(hive, 'control', 'chat', files[0])));
  assert.equal(command.from, 'human');
  assert.equal(command.runId, runId);
  assert.equal(command.text, 'hello');
  const control = (await request(srv, '/api/control')).value;
  assert.equal(control.instances['dwight-m1'].status, 'thinking');
  assert.ok(control.defaults.execution);
  assert.equal(control.sessions['dwight-m1'].sessionId, 'session-1');
  assert.equal(control.chatAck.id, 'ack-1');
});

test('guardian heartbeat timeout aborts a live child and releases clean ownership', { timeout: 12000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { acquireRunLease, readRunLease } = await import('../../src/core/run-lease.js');
  const hive = tempDir(t);
  const lease = acquireRunLease(hive, { runId: 'abrupt-parent' });
  const moduleUrl = new URL('../../src/core/run-lease.js', import.meta.url).href;
  const childCode = `import {guardParent} from ${JSON.stringify(moduleUrl)};
    const work = setInterval(()=>{},100);
    const dispose = guardParent({hiveDir:${JSON.stringify(hive)}, abort:()=>{
      setTimeout(()=>{clearInterval(work);dispose({clean:true});process.exit(0);},20);
    }});console.log('guard-ready');`;
  const parentCode = `import {spawn} from 'node:child_process';
    spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{stdio:['pipe',1,2]});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode], {
    env: { ...process.env, SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => parent.kill());
  await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.once('data', (data) => data.toString().includes('guard-ready') ? resolve() : reject(Error(data.toString())));
    parent.stderr.once('data', (data) => reject(Error(data.toString())));
  });
  assert.ok(readRunLease(hive));
  await until(() => readRunLease(hive), (lease) => lease === null, 8000);
});

test('unverifiable ownership never permits a new controller to start', async (t) => {
  const { srv, hive } = await setup(t);
  fs.mkdirSync(path.join(hive, 'control'), { recursive: true });
  fs.writeFileSync(path.join(hive, 'control', 'owner.json'), 'null');
  assert.equal((await request(srv, '/api/control')).value.recoveryRequired, true);
  assert.equal((await request(srv, '/api/runs', { request: 'blocked' })).status, 409);
  assert.equal((await request(srv, '/api/runs/stop', {})).status, 409);
});

test('bad launch configuration remains observable without breaking stop control', async (t) => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  t.after(() => child.emit('close', 0));
  const { srv, workspace, hive } = await setup(t, { runner: () => child });
  await request(srv, '/api/runs', { request: 'test' });
  const priorThinking = process.env.SCRANTON_MICHAEL_THINKING;
  t.after(() => { if (priorThinking === undefined) delete process.env.SCRANTON_MICHAEL_THINKING; else process.env.SCRANTON_MICHAEL_THINKING = priorThinking; });
  process.env.SCRANTON_MICHAEL_THINKING = 'invalid-thinking-level';
  const control = await request(srv, '/api/control');
  assert.equal(control.status, 200);
  assert.equal(control.value.defaults.execution, null);
  assert.equal(typeof control.value.defaults.configurationError, 'string');
  assert.equal((await request(srv, '/api/runs/stop', {})).status, 202);
  assert.ok(fs.existsSync(path.join(hive, 'control', 'stop.json')));
});

test('guardian refreshes heartbeat deadlines and aborts only once when stale', async (t) => {
  const { acquireRunLease, guardParent } = await import('../../src/core/run-lease.js');
  const hiveDir = tempDir(t);
  const lease = acquireRunLease(hiveDir, { runId: 'heartbeat-clock' });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const stdin = new PassThrough();
  let aborted = 0;
  const dispose = guardParent({ hiveDir, stdin, env: { SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token }, abort: () => aborted++ });
  t.after(() => { dispose(); stdin.destroy(); });
  for (let i = 0; i < 9; i++) t.mock.timers.tick(500);
  assert.equal(aborted, 0);
  stdin.emit('data', Buffer.from('heartbeat\n'));
  for (let i = 0; i < 10; i++) t.mock.timers.tick(500);
  assert.equal(aborted, 0);
  t.mock.timers.tick(500);
  assert.equal(aborted, 1);
  stdin.emit('close');
  assert.equal(aborted, 1);
});
