import './docker-model-env.js';
import './runtime-env.js';
import { isolationTestEnv } from '../core/isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createControl } from '../../src/server/control.js';
import { acquireRunLease, guardParent, readRunLease, registerParentStartup } from '../../src/core/run-lease.js';

function fixture(t) {
  const root = path.resolve('.scratch/fix-lifecycle');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function post(control, route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'x-scranton-client': '1', 'content-type': 'application/json' };
  req.socket = { localPort: 1234, remoteAddress: '127.0.0.1' };
  req.method = 'POST';
  let status;
  let value;
  await control.handle(req, { writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } }, route);
  return { status, value };
}
async function ended(control) {
  for (let i = 0; i < 400; i++) {
    const snapshot = control.snapshot();
    if (!snapshot.run) return snapshot;
    await sleep(50);
  }
  throw Error('Run did not exit');
}

test('invalid CLI config refuses before work, exits 2, and permits a valid next run', { timeout: 30000 }, async (t) => {
  const dir = fixture(t);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, '{bad');
  const control = createControl({ hive: path.join(dir, 'hive'), workspace: path.join(dir, 'ws'), runner(exe, args, options) {
    args.splice(2, 0, '--config', config);
    return spawn(exe, args, { ...options, env: isolationTestEnv(options.env) });
  } });
  t.after(() => control.close());
  assert.equal((await post(control, '/api/runs', { request: 'invalid config' })).status, 202);
  const failed = await ended(control);
  assert.equal(failed.lastExit.exitCode, 2, failed.lastExit.outputTail);
  assert.equal(failed.recoveryRequired, false);
  fs.writeFileSync(config, JSON.stringify({ execution: { maxParallel: 1, isolation: 'shared', sandbox: { mode: 'host' } } }));
  assert.equal((await post(control, '/api/runs', { demo: { scenario: 'happy', delayMs: 0 } })).status, 202);
  const done = await ended(control);
  assert.equal(done.lastExit.exitCode, 0, done.lastExit.outputTail);
  assert.equal(done.recoveryRequired, false);
});

for (const scenario of ['no-proof', 'wrong-token', 'begun', 'guarded', 'refused']) {
  test(`startup close requires private pre-work proof: ${scenario}`, async (t) => {
    const dir = fixture(t);
    let env;
    const child = Object.assign(new EventEmitter(), { pid: 123 });
    const hive = path.join(dir, 'hive');
    const control = createControl({ hive, workspace: dir, runner(_exe, _args, options) { env = options.env; assert.equal(options.stdio[3], 'ipc'); return child; } });
    t.after(() => control.close());
    assert.equal((await post(control, '/api/runs', { request: 'test' })).status, 202);
    const token = env.SCRANTON_RUN_LEASE;
    if (scenario === 'begun') child.emit('message', { type: 'scranton-startup-begun', token });
    if (scenario === 'guarded') child.emit('message', { type: 'scranton-guard-registered', token });
    if (scenario !== 'no-proof') child.emit('message', { type: 'scranton-startup-refused', token: scenario === 'wrong-token' ? 'wrong' : token });
    assert.ok(readRunLease(hive), 'proof alone cannot release a live child');
    if (scenario === 'refused') {
      child.emit('error', new Error('kill failed while child is still alive'));
      assert.ok(control.snapshot().run, 'process errors are not proof of exit');
      assert.ok(readRunLease(hive));
    }
    child.emit('close', 2);
    assert.equal(control.snapshot().recoveryRequired, scenario !== 'refused');
    if (scenario !== 'refused') assert.equal((await post(control, '/api/runs', { request: 'orphan stays locked' })).status, 409);
  });
}

test('startup registration flushes messages and never refuses after begin', async () => {
  const messages = [];
  const env = { SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: 'private' };
  const send = (message, callback) => { messages.push(message); setImmediate(callback); };
  const startup = registerParentStartup({ env, send });
  await startup.begin();
  await startup.refuse();
  assert.deepEqual(messages, [{ type: 'scranton-startup-begun', token: 'private' }]);
  await registerParentStartup({ env, send }).refuse();
  assert.equal(messages[1].type, 'scranton-startup-refused');
});

test('recipient contract accepts reusable invocation states and rejects completed or malformed states', async (t) => {
  const dir = fixture(t);
  const hive = path.join(dir, 'hive');
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const control = createControl({ hive, workspace: dir, runner: () => child });
  t.after(() => child.emit('close', 0));
  t.after(() => control.close());
  await post(control, '/api/runs', { request: 'chat' });
  const runId = control.snapshot().run.runId;
  for (const status of ['idle', 'thinking', 'working', 'waiting', 'blocked', 'error', 'done', 'completed', 'finished', 'failed', 'aborted', 'stopped', 'cancelled', 'unknown', null]) {
    fs.writeFileSync(path.join(hive, 'state.json'), JSON.stringify({ runId, instances: { michael: { status } } }));
    const result = await post(control, '/api/chat', { runId, to: 'michael', text: 'hello' });
    assert.equal(result.status, ['idle', 'thinking', 'working', 'waiting', 'blocked', 'error'].includes(status) ? 202 : 409, String(status));
  }
});

for (const heartbeats of [true, false]) {
  test(`six-second child event-loop stall preserves ${heartbeats ? 'live heartbeat and EOF' : 'hung parent timeout'} semantics`, { timeout: 18000 }, async (t) => {
    const hive = fixture(t);
    const lease = acquireRunLease(hive, { runId: 'stall' });
    const moduleUrl = new URL('../../src/core/run-lease.js', import.meta.url).href;
    const code = `import {guardParent} from ${JSON.stringify(moduleUrl)};
      const keep = setInterval(()=>{},100);
      const dispose = guardParent({hiveDir:${JSON.stringify(hive)},abort:()=>{
        console.log('aborted');clearInterval(keep);dispose({clean:true});process.exitCode=0;
      }});
      console.log('ready');
      setTimeout(()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6000);console.log('resumed');},100);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token } });
    t.after(() => child.kill());
    const closed = once(child, 'close');
    let output = '';
    let errors = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.stdin.on('error', () => {});
    const timer = heartbeats ? setInterval(() => child.stdin.write('heartbeat\n'), 200) : null;
    t.after(() => clearInterval(timer));
    while (!output.includes('resumed')) { assert.equal(child.exitCode, null, errors); await sleep(50); }
    await sleep(800);
    assert.ok(!output.includes('aborted'), output);
    if (heartbeats) child.stdin.end();
    const [exit] = await closed;
    assert.equal(exit, 0, errors);
    assert.match(output, /aborted/);
    assert.equal(readRunLease(hive), null);
  });
}

test('delayed watchdog callback lets buffered heartbeat run before judging parent stale', (t) => {
  const hive = fixture(t);
  const lease = acquireRunLease(hive, { runId: 'delayed-watchdog' });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const stdin = new PassThrough();
  let aborted = 0;
  const dispose = guardParent({ hiveDir: hive, stdin, env: { SCRANTON_PARENT_GUARD: '1', SCRANTON_RUN_LEASE: lease.token }, abort: () => aborted++ });
  t.after(() => dispose({ clean: true }));
  t.mock.timers.tick(6000);
  assert.equal(aborted, 0, 'a delayed timer is not evidence that the parent stopped heartbeating');
  stdin.write('heartbeat\n');
  for (let i = 0; i < 10; i++) t.mock.timers.tick(500);
  assert.equal(aborted, 0);
  stdin.emit('end');
  assert.equal(aborted, 1, 'EOF remains authoritative even just after a stall');
});

test('real surviving worker remains locked across controller replacement and unclean exit', { timeout: 10000 }, async (t) => {
  const dir = fixture(t);
  const hive = path.join(dir, 'hive');
  let child;
  const first = createControl({ hive, workspace: dir, runner(_exe, _args, options) {
    child = spawn(process.execPath, ['-e', 'process.send({type:"scranton-startup-begun",token:process.env.SCRANTON_RUN_LEASE});setInterval(()=>{},1000)'], options);
    return child;
  } });
  t.after(async () => { child?.kill(); await first.close(); });
  assert.equal((await post(first, '/api/runs', { request: 'orphan fixture' })).status, 202);
  await once(child, 'message');
  const replacement = createControl({ hive, workspace: dir, runner: () => { throw Error('Must not spawn beside surviving worker'); } });
  t.after(() => replacement.close());
  assert.equal(replacement.snapshot().recoveryRequired, true);
  assert.equal((await post(replacement, '/api/runs', { request: 'overlap' })).status, 409);
  const closed = once(child, 'close');
  child.kill();
  await closed;
  assert.equal(replacement.snapshot().recoveryRequired, true, 'unclean death is not proof that descendants stopped');
  assert.equal((await post(replacement, '/api/runs', { request: 'still unsafe' })).status, 409);
});
