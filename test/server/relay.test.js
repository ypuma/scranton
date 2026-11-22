import './docker-model-env.js';
import './runtime-env.js';
import '../core/isolation-test-root.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../../src/server/relay.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const cleanups = new WeakMap();

function cleanup(t, close) {
  if (!cleanups.has(t)) {
    const stack = [];
    cleanups.set(t, stack);
    // Node skips later after hooks if an earlier one throws.
    t.after(async () => {
      const errors = [];
      for (const dispose of stack.reverse()) {
        try { await dispose(); } catch (err) { errors.push(err); }
      }
      if (errors.length) throw new AggregateError(errors, 'Relay fixture cleanup failed');
    }, { timeout: 20000 });
  }
  cleanups.get(t).push(close);
}

function tempDir(t) {
  const root = fileURLToPath(new URL('../../.scratch/relay-wave-tests/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'dashboard-'));
  cleanup(t, () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return dir;
}

const origin = 'https://scranton.example.test';
const host = new URL(origin).host;
const publicDir = fileURLToPath(new URL('../../visualizer/public', import.meta.url));
const client = { 'X-Scranton-Client': '1' };
const post = (body) => ({ method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const pairing = (code) => ({ method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ code }) });

async function setup(t, { control = true, registry = false } = {}) {
  const dir = tempDir(t);
  if (registry) t.mock.method(os, 'homedir', () => path.join(dir, 'profile'));
  const upstream = await startVisualizerServer({
    hiveDir: path.join(dir, 'hive'), dataDir: registry ? path.join(dir, 'data') : undefined,
    projectsRoot: path.join(dir, 'projects'),
    port: 0, publicDir, control: control ? { workspace: path.join(dir, 'workspace') } : undefined
  });
  cleanup(t, upstream.close);
  const start = () => startRelay({ origin, targetPort: upstream.port, port: 0 });
  return { start, dir };
}

// Model HTTPS termination by preserving the browser-facing Host and Origin on loopback.
function request(relay, resource, { headers, cookie, body, chunks, ...options } = {}) {
  const requestHeaders = { Host: host, ...client, ...(cookie ? { Cookie: cookie } : {}), ...headers };
  for (const name of Object.keys(requestHeaders)) {
    if (requestHeaders[name] === undefined) delete requestHeaders[name];
  }
  if (body instanceof URLSearchParams) {
    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    body = body.toString();
  }
  return new Promise((resolve, reject) => {
    const req = http.request(relay.url + resource, {
      signal: AbortSignal.timeout(5000), ...options, headers: requestHeaders
    }, (res) => {
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
    }
    req.end(body);
  });
}

async function connect(relay) {
  const response = await request(relay, '/_relay/pair', pairing(relay.code));
  assert.equal(response.status, 303);
  await response.text();
  assert.equal(response.headers.get('location'), '/');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-scranton-relay=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  return cookie.split(';', 1)[0];
}

test('phone relay pairs and protects dashboard, control and session boundaries', { timeout: 20000 }, async (t) => {
  const { start } = await setup(t);
  const relay = await start();
  cleanup(t, relay.close);
  assert.equal(new URL(relay.url).hostname, '127.0.0.1');
  const login = await request(relay, '/');
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.match(await login.text(), /Pair with Scranton/);
  assert.equal((await request(relay, '/', { headers: { Host: 'evil.test' } })).status, 403);
  assert.equal((await request(relay, '/events')).status, 401);
  assert.equal((await request(relay, '/api/runs', post({ demo: { scenario: 'happy' } }))).status, 401);
  assert.equal((await request(relay, '/_relay/pair', pairing('wrong'))).status, 401);
  assert.equal((await request(relay, '/_relay/pair', pairing('x'.repeat(512)))).status, 413);

  const cookie = await connect(relay);
  const page = await request(relay, '/', { cookie });
  assert.match(await page.text(), /Scranton - Agent Orchestration/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /localhost/);
  for (const asset of ['/styles.css', '/js/main.js', '/fonts/geist-latin-wght-normal.woff2']) {
    const response = await request(relay, asset, { cookie });
    assert.equal(response.status, 200, asset);
    await response.arrayBuffer();
  }
  const status = await request(relay, '/api/control', { cookie });
  assert.equal((await status.json()).enabled, true);
  for (const route of ['/api/auth', '/api/auth/login', '/api/agents', '/api/agents/dwight/prompt']) {
    assert.equal((await request(relay, route, { cookie })).status, 404, route);
    assert.equal((await request(relay, route, { ...post({}), cookie })).status, 404, route);
  }
  const stop = (headers) => request(relay, '/api/runs/stop', { ...post({}), cookie, headers });
  assert.equal((await stop({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await stop({ ...post({}).headers, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await stop({ ...post({}).headers, 'X-Scranton-Client': '' })).status, 403);
  assert.equal((await stop({ ...post({}).headers, 'Content-Type': 'text/plain' })).status, 415);
  // The local API received the authorized request and found no current run.
  assert.equal((await stop(post({}).headers)).status, 409);

  await relay.close();
  const restarted = await start();
  cleanup(t, restarted.close);
  assert.notEqual(restarted.code, relay.code);
  assert.equal((await request(restarted, '/api/control', { cookie })).status, 401);
});

test('phone relay refuses an uncontrolled dashboard and a non-HTTPS origin', async (t) => {
  const { start } = await setup(t, { control: false });
  await assert.rejects(start, /No controlled Scranton dashboard/);
  await assert.rejects(startRelay({ origin: 'http://scranton.example.test' }), /HTTPS origin/);
});

test('direct HTTPS requires a private bind and a matching port', async () => {
  const domain = 'https://scranton.example.test:8443';
  const tls = { certFile: 'cert.pem', keyFile: 'key.pem' };
  await assert.rejects(startRelay({ origin: domain, listenIp: '192.168.1.20' }), /requires --tls-cert and --tls-key/);
  await assert.rejects(startRelay({ origin: domain, ...tls, listenIp: '0.0.0.0' }), /private IPv4/);
  await assert.rejects(startRelay({ origin: domain, ...tls, listenIp: '192.168.1.20', port: 443 }), /must match/);
  await assert.rejects(startRelay({ origin: 'https://192.168.1.20:8443', ...tls, listenIp: '192.168.1.21' }), /must match/);
});

test('paired phone starts a registry run, streams events, answers a question and stops it', { timeout: 90000 }, async (t) => {
  const { start } = await setup(t, { registry: true });
  const relay = await start();
  cleanup(t, relay.close);
  const cookie = await connect(relay);
  async function get(resource) {
    const response = await request(relay, resource, { cookie });
    assert.equal(response.status, 200, resource);
    return response.json();
  }
  async function write(resource, body, expected) {
    const response = await request(relay, resource, { ...post(body), cookie });
    const doc = await response.json();
    assert.equal(response.status, expected, JSON.stringify(doc));
    return doc;
  }
  const { project } = await write('/api/projects', { name: 'Relay test' }, 201);
  const { chat } = await write(`/api/projects/${project.id}/chats`, { title: 'Phone control' }, 201);
  const scope = `/api/projects/${project.id}/chats/${chat.id}`;
  const controller = new AbortController();
  cleanup(t, () => controller.abort());
  const events = await request(relay, scope + '/events', { cookie, signal: controller.signal });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(events.headers.get('x-accel-buffering'), 'no');
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let log = '';
  const started = (async () => {
    while (!log.includes('"type":"run_started"')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      log += decoder.decode(value, { stream: true });
    }
  })();
  await Promise.all([
    started,
    write(scope + '/runs', { demo: { scenario: 'blocked', delayMs: 0 } }, 202)
  ]);
  await reader.cancel();

  async function waitFor(predicate, { expectRunning = false } = {}) {
    // Under full-suite load one run-state step has taken over 12 s (alone it is ~4 s).
    const deadline = Date.now() + 30000;
    do {
      const snapshot = await get(scope + '/control');
      if (predicate(snapshot)) return snapshot;
      if (expectRunning && !snapshot.run && snapshot.lastExit) assert.fail(snapshot.lastExit.outputTail);
      await sleep(100);
    } while (Date.now() < deadline);
    assert.fail('Timed out waiting for run state');
  }
  const paused = await waitFor((snapshot) => snapshot.pendingHuman, { expectRunning: true });
  assert.equal(paused.run.runId, paused.pendingHuman.runId);
  await write(scope + '/hitl', { decision: 'abort' }, 202);
  await waitFor((snapshot) => !snapshot.run && snapshot.lastExit);
  await write(scope + '/runs', { demo: { scenario: 'happy', delayMs: 5000 } }, 202);
  await write(scope + '/runs/stop', {}, 202);
  const stopped = await waitFor((snapshot) => !snapshot.run && snapshot.lastExit);
  assert.equal(stopped.lastExit.exitCode, 130);
});

async function disposableDashboard(t) {
  const writes = [];
  const streams = new Map();
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/control') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"enabled":true}');
    }
    if (req.method === 'POST') {
      const write = { url: req.url, headers: req.headers, size: 0 };
      writes.push(write);
      req.on('data', (chunk) => { write.size += chunk.length; });
      req.on('end', () => { res.writeHead(200); res.end('ok'); });
      return;
    }
    streams.set(req.url, res);
    res.on('close', () => streams.delete(req.url));
    res.writeHead(200, { 'Content-Type': req.url.startsWith('/events') ? 'text/event-stream' : 'text/plain' });
    res.write(': connected\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise((resolve) => {
    upstream.close(resolve);
    upstream.closeAllConnections();
  }));
  const relay = await startRelay({ origin, targetPort: upstream.address().port, port: 0 });
  cleanup(t, relay.close);
  return { relay, writes, streams };
}

async function waitUntil(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for stream teardown');
    await sleep(10);
  }
}

async function openStream(relay, cookie, resource) {
  const response = await request(relay, resource, { cookie, signal: undefined });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  const ended = reader.closed.then(() => true, () => true);
  const closed = () => Promise.race([
    ended,
    sleep(2000, undefined, { ref: false }).then(() => assert.fail('Relay did not close the device stream'))
  ]);
  return { reader, closed };
}

test('each pairing is independent; a plain same-origin logout closes only that phone forwards', { timeout: 5000 }, async (t) => {
  const { relay, streams } = await disposableDashboard(t);
  const a = await connect(relay);
  const b = await connect(relay);
  assert.notEqual(a, b);
  assert.equal((await request(relay, '/_relay/session')).status, 401);
  for (const cookie of [a, b]) {
    const session = await request(relay, '/_relay/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await session.json(), { paired: true });
  }
  const aEvents = await openStream(relay, a, '/events?device=a');
  const aForward = await openStream(relay, a, '/api/state');
  const bEvents = await openStream(relay, b, '/events?device=b');
  assert.equal((await request(relay, '/_relay/logout', { cookie: a })).status, 404);
  for (const headers of [{}, { Origin: 'https://evil.test' }]) {
    assert.equal((await request(relay, '/_relay/logout', { method: 'POST', cookie: a, headers })).status, 403);
  }
  const logout = await request(relay, '/_relay/logout', {
    method: 'POST', cookie: a,
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Scranton-Client': undefined },
    body: ''
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/');
  assert.equal(logout.headers.get('set-cookie'), '__Host-scranton-relay=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  await logout.text();
  await Promise.all([aEvents.closed(), aForward.closed()]);
  await waitUntil(() => streams.size === 1);
  assert.equal((await request(relay, '/_relay/session', { cookie: a })).status, 401);
  assert.equal((await request(relay, '/_relay/session', { cookie: b })).status, 200);
  streams.get('/events?device=b').write('data: still connected\n\n');
  assert.match(new TextDecoder().decode((await bEvents.reader.read()).value), /still connected/);
  await relay.close();
  await bEvents.closed();
  await waitUntil(() => streams.size === 0);
});

test('sessions expire absolutely after twelve hours without extending on activity', { timeout: 5000 }, async (t) => {
  const { relay, streams } = await disposableDashboard(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const a = await connect(relay);
  const aEvents = await openStream(relay, a, '/events?device=a');
  now += 1000;
  const b = await connect(relay);
  now += 12 * 60 * 60 * 1000 - 1001;
  assert.equal((await request(relay, '/_relay/session', { cookie: a })).status, 200);
  now += 1;
  assert.equal((await request(relay, '/_relay/session', { cookie: a })).status, 401);
  assert.equal((await request(relay, '/_relay/session', { cookie: b })).status, 200);
  await aEvents.closed();
  await waitUntil(() => streams.size === 0);
});

test('the session deadline timer closes idle streams without needing another request', { timeout: 5000 }, async (t) => {
  const { relay, streams } = await disposableDashboard(t);
  const timers = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 12 * 60 * 60 * 1000) timers.push(fn);
    return realTimeout(fn, delay, ...args);
  });
  const cookie = await connect(relay);
  const events = await openStream(relay, cookie, '/events');
  assert.equal(timers.length, 1);
  timers[0]();
  await events.closed();
  await waitUntil(() => streams.size === 0);
  assert.equal((await request(relay, '/_relay/session', { cookie })).status, 401);
});

test('at most eight sessions are retained; logout releases capacity without evicting other phones', async (t) => {
  const { relay } = await disposableDashboard(t);
  const cookies = [];
  for (let i = 0; i < 8; i++) cookies.push(await connect(relay));
  assert.equal(new Set(cookies).size, 8);
  const full = await request(relay, '/_relay/pair', pairing(relay.code));
  assert.equal(full.status, 429);
  assert.ok(Number(full.headers.get('retry-after')) > 0);
  assert.equal(full.headers.get('set-cookie'), null);
  await full.text();
  await request(relay, '/_relay/logout', { method: 'POST', cookie: cookies[0], headers: { Origin: origin } });
  await connect(relay);
  assert.equal((await request(relay, '/_relay/session', { cookie: cookies[1] })).status, 200);
});

test('five failed pairing forms impose a bounded thirty-second cooldown, ignoring forwarded IPs', async (t) => {
  const { relay } = await disposableDashboard(t);
  const cookie = await connect(relay);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 5; i++) {
    const bad = pairing('wrong');
    bad.headers['X-Forwarded-For'] = `192.0.2.${i}`;
    const response = await request(relay, '/_relay/pair', bad);
    assert.equal(response.status, i === 4 ? 429 : 401);
    if (i === 4) assert.equal(response.headers.get('retry-after'), '30');
    const html = await response.text();
    assert.doesNotMatch(html, new RegExp(relay.code));
  }
  now += 1000;
  const blocked = await request(relay, '/_relay/pair', pairing(relay.code));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '29');
  assert.equal(blocked.headers.get('set-cookie'), null);
  await blocked.text();
  assert.equal((await request(relay, '/_relay/session', { cookie })).status, 200);
  now += 29000;
  await connect(relay);
  assert.equal((await request(relay, '/_relay/pair', pairing('wrong'))).status, 401);
});

test('oversized chunked writes never reach upstream, and limits count bytes rather than characters', async (t) => {
  const { relay, writes } = await disposableDashboard(t);
  const cookie = await connect(relay);
  const headers = post({}).headers;
  const huge = await request(relay, '/api/runs', {
    method: 'POST', headers, cookie, chunks: [Buffer.alloc(131072, 'x'), Buffer.alloc(131073, 'x')]
  });
  assert.equal(huge.status, 413);
  await huge.text();
  assert.equal(writes.length, 0, 'not even upstream request headers may be sent for an oversized write');
  const unicode = await request(relay, '/api/runs', { method: 'POST', headers, cookie, chunks: ['é'.repeat(131073)] });
  assert.equal(unicode.status, 413);
  await unicode.text();
  assert.equal(writes.length, 0);
  const atLimit = await request(relay, '/api/runs', {
    method: 'POST', headers, cookie, chunks: [Buffer.alloc(131072, 'x'), Buffer.alloc(131072, 'x')]
  });
  assert.equal(atLimit.status, 200);
  await atLimit.text();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].size, 262144);
  assert.equal(writes[0].headers['content-length'], '262144');
  assert.equal(writes[0].headers.cookie, undefined);
  assert.equal(writes[0].headers['transfer-encoding'], undefined);
});

test('relay fixture cleanup unwinds resources before files and continues after an error', async () => {
  let after;
  const fixture = { after(fn) { assert.equal(after, undefined); after = fn; } };
  const calls = [];
  const failure = new Error('close failed');
  cleanup(fixture, () => calls.push('remove directory'));
  cleanup(fixture, async () => { calls.push('close upstream'); });
  cleanup(fixture, () => { calls.push('close relay'); throw failure; });
  cleanup(fixture, () => calls.push('abort stream'));
  await assert.rejects(after, (err) => {
    assert.ok(err instanceof AggregateError);
    assert.deepEqual(err.errors, [failure]);
    return true;
  });
  assert.deepEqual(calls, ['abort stream', 'close relay', 'close upstream', 'remove directory']);
});
