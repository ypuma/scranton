import './docker-model-env.js';
import { isolationTestEnv } from '../core/isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tempDir, ROOT } from '../core/helpers.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createControl } from '../../src/server/control.js';

async function post(control, route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'content-type': 'application/json', 'x-scranton-client': '1', host: 'localhost' };
  req.socket = { localPort: 80, remoteAddress: '127.0.0.1' };
  req.method = 'POST';
  const res = { writeHead(status) { this.status = status; }, end() {} };
  await control.handle(req, res, route);
  assert.equal(res.status, 202);
}

function fixture(t) {
  const hive = tempDir(t);
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const control = createControl({ hive, workspace: path.join(hive, 'ws'), runner: () => child });
  t.after(() => child.emit('close', 0));
  return { hive, child, control };
}

test('forged local Host cannot authorize a remote control peer', async (t) => {
  const original = http.createServer;
  t.mock.method(http, 'createServer', (listener) => original((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10', configurable: true });
    listener(req, res);
  }));
  const dir = tempDir(t);
  let starts = 0;
  const server = await startVisualizerServer({ host: '0.0.0.0', port: 0, hiveDir: dir, publicDir: dir,
    control: { workspace: dir, runner: () => { starts++; throw Error('must not spawn'); } } });
  t.after(() => server.close());
  const statuses = [];
  for (const route of ['/api/control', '/api/runs', '/api/hitl', '/api/runs/stop']) {
    const res = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: route === '/api/control' ? 'GET' : 'POST',
      headers: { Host: 'localhost', 'X-Scranton-Client': '1', 'Content-Type': 'application/json' },
      ...(route === '/api/control' ? {} : { body: '{"request":"test"}' }) });
    statuses.push([route, res.status]);
  }
  assert.deepEqual(statuses.map(([, status]) => status), [403, 403, 403, 403], JSON.stringify(statuses));
  assert.equal(starts, 0);
});

test('CLI refuses control on a non-loopback bind', (t) => {
  const dir = tempDir(t);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin/scranton.js'), 'visualize', '--control', '--host', '0.0.0.0', '--port', '0', '--hive', path.join(dir, 'hive'), '--workspace', path.join(dir, 'ws')], { env: isolationTestEnv(), encoding: 'utf8', timeout: 15000, cwd: dir });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--control.*loopback/i);
});

test('repeated stops preserve the first forced-kill deadline', async (t) => {
  const { control, child } = fixture(t);
  const timers = [];
  t.mock.method(globalThis, 'setInterval', () => ({}));
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  await post(control, '/api/runs', { request: 'hang' });
  await post(control, '/api/runs/stop', {});
  await post(control, '/api/runs/stop', {});
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 15000);
  const closing = control.close();
  assert.deepEqual(timers.map((timer) => timer.delay), [15000, 5000]);
  child.emit('close', 130);
  await closing;
});

test('child exit ends stop resends and removes only its leftover stop file', async (t) => {
  const { control, child, hive } = fixture(t);
  await post(control, '/api/runs', { request: 'stop' });
  fs.writeFileSync(path.join(hive, 'events.jsonl'), '{"type":"run_started","runId":"current"}\n');
  await post(control, '/api/runs/stop', {});
  const file = path.join(hive, 'control', 'stop.json');
  child.emit('exit', 130);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, '{"runId":"another"}');
  child.emit('close', 130);
  assert.equal(JSON.parse(fs.readFileSync(file)).runId, 'another');
});

test('HTML carries strict security headers', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Test</title>');
  const server = await startVisualizerServer({ port: 0, hiveDir: dir, publicDir: dir });
  t.after(() => server.close());
  const res = await fetch(server.url);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});
