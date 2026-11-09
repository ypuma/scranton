import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const SECRET = 'TOP-SECRET-OUTSIDE-PUBLIC';

function setup({ withPublic = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scranton-server-'));
  const hiveDir = path.join(tmp, 'hive');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(hiveDir);
  if (withPublic) fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(tmp, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(tmp, 'package.json'), SECRET);
  return { tmp, hiveDir, publicDir, events: path.join(hiveDir, 'events.jsonl'), state: path.join(hiveDir, 'state.json') };
}

async function withServer(opts, fn) {
  const env = setup(opts);
  const srv = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0 });
  try {
    await fn({ ...env, srv });
  } finally {
    await srv.close();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
}

// Raw path, no normalisation (unlike fetch/URL).
function request(srv, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: rawPath, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Like request() but with an explicit Host header ('' sends none).
function requestWithHost(srv, rawPath, host) {
  return new Promise((resolve, reject) => {
    const headers = host === '' ? {} : { Host: host };
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: rawPath, headers, agent: false, setHost: false }, (res) => {
      if (res.headers['content-type'] === 'text/event-stream') {
        res.destroy(); // an open SSE stream never ends
        return resolve({ status: res.statusCode, body: '' });
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sse(srv) {
  const client = { frames: [], headers: null, ended: false, buf: '' };
  client.ready = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', agent: false }, (res) => {
      client.headers = res.headers;
      client.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (d) => {
        client.buf += d;
        let i;
        while ((i = client.buf.indexOf('\n\n')) !== -1) {
          client.frames.push(client.buf.slice(0, i));
          client.buf = client.buf.slice(i + 2);
        }
      });
      res.on('end', () => (client.ended = true));
      res.on('close', () => (client.ended = true));
      resolve();
    });
    req.on('error', reject);
    client.req = req;
  });
  // Data frames only, parsed.
  client.events = () =>
    client.frames
      .filter((f) => f.includes('data: '))
      .map((f) => {
        const id = /^id: (.*)$/m.exec(f)?.[1];
        const data = /^data: (.*)$/m.exec(f)[1];
        return { id, data, obj: JSON.parse(data) };
      });
  client.waitFor = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred(client)) return;
      await sleep(10);
    }
    throw new Error(`timeout; frames=${JSON.stringify(client.frames)}`);
  };
  client.destroy = () => client.req.destroy();
  return client;
}

const ev = (seq, type, extra = {}) => JSON.stringify({ v: 1, seq, ts: '2025-01-01T00:00:00.000Z', runId: 'r1', type, ...extra });

test('serves static files with MIME types and / -> index.html', async () => {
  await withServer({}, async ({ srv, publicDir }) => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>hi</h1>');
    fs.writeFileSync(path.join(publicDir, 'app.js'), 'export {}');
    fs.writeFileSync(path.join(publicDir, 'style.css'), 'a{}');
    fs.writeFileSync(path.join(publicDir, 'data.jsonl'), '{}\n');
    fs.writeFileSync(path.join(publicDir, 'pic.png'), Buffer.from([137, 80, 78, 71]));
    fs.mkdirSync(path.join(publicDir, 'empty'));

    const root = await request(srv, '/');
    assert.equal(root.status, 200);
    assert.equal(root.body, '<h1>hi</h1>');
    assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(root.headers['cache-control'], 'no-cache');

    assert.equal((await request(srv, '/index.html?x=1')).body, '<h1>hi</h1>');
    assert.equal((await request(srv, '/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await request(srv, '/style.css')).headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await request(srv, '/data.jsonl')).headers['content-type'], 'application/x-ndjson; charset=utf-8');
    assert.equal((await request(srv, '/pic.png')).headers['content-type'], 'image/png');

    assert.equal((await request(srv, '/missing.html')).status, 404);
    assert.equal((await request(srv, '/empty/')).status, 404);

    const head = await request(srv, '/index.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], '11');
  });
});

test('missing publicDir answers 404 instead of crashing', async () => {
  await withServer({ withPublic: false }, async ({ srv }) => {
    assert.equal((await request(srv, '/')).status, 404);
    assert.equal((await request(srv, '/index.html')).status, 404);
    assert.equal((await request(srv, '/api/state')).status, 200);
  });
});

test('path traversal attempts never leak files', async () => {
  await withServer({}, async ({ srv, publicDir }) => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), 'ok');
    const attempts = [
      '/../package.json',
      '/../secret.txt',
      '/%2e%2e/%2e%2e/x',
      '/%2e%2e/secret.txt',
      '/..%5c..%5cx',
      '/..%5csecret.txt',
      '/..\\secret.txt',
      '/%00',
      '/index.html%00.txt',
      '/..%2fsecret.txt',
      '/C:/Windows/win.ini',
      '/C%3A%5CWindows%5Cwin.ini',
      '//secret.txt',
      '/%',
      '/%ZZ',
    ];
    for (const p of attempts) {
      const r = await request(srv, p);
      assert.ok(r.status === 404 || r.status === 403 || r.status === 400, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes(SECRET), `${p} leaked`);
    }
  });
});

test('non GET/HEAD methods get 405', async () => {
  await withServer({}, async ({ srv }) => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await request(srv, '/', method);
      assert.equal(r.status, 405, method);
      assert.match(r.headers.allow, /GET/);
    }
    assert.equal((await request(srv, '/events', 'POST')).status, 405);
  });
});

test('/api/state: missing -> idle, present, invalid -> last good', async () => {
  await withServer({}, async ({ srv, state }) => {
    const idle = await request(srv, '/api/state');
    assert.equal(idle.status, 200);
    assert.match(idle.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(idle.body), { v: 1, status: 'idle' });

    const snap = { v: 1, runId: 'r1', status: 'running', lastSeq: 4 };
    fs.writeFileSync(state, JSON.stringify(snap));
    assert.deepEqual(JSON.parse((await request(srv, '/api/state')).body), snap);

    fs.writeFileSync(state, '{"v":1,"runId":"r1","sta');
    const bad = await request(srv, '/api/state');
    assert.equal(bad.status, 200);
    assert.deepEqual(JSON.parse(bad.body), snap);
  });
});

test('/api/state: invalid with no prior good snapshot -> idle', async () => {
  await withServer({}, async ({ srv, state }) => {
    fs.writeFileSync(state, 'not json');
    assert.deepEqual(JSON.parse((await request(srv, '/api/state')).body), { v: 1, status: 'idle' });
  });
});

test('/api/state recovers when the file is rewritten mid-request', async () => {
  await withServer({}, async ({ srv, state }) => {
    fs.writeFileSync(state, '{"v":1,');
    const pending = request(srv, '/api/state');
    await sleep(30);
    fs.writeFileSync(state, '{"v":1,"status":"running"}');
    assert.equal(JSON.parse((await pending).body).status, 'running');
  });
});

test('SSE: headers, retry first, replay with ids', async () => {
  await withServer({}, async ({ srv, events }) => {
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n${ev(2, 'log', { level: 'info', message: 'héllo ✓' })}\r\n`);
    const c = sse(srv);
    await c.ready;
    assert.equal(c.status, 200);
    assert.equal(c.headers['content-type'], 'text/event-stream');
    assert.equal(c.headers['cache-control'], 'no-cache');
    assert.equal(c.headers.connection, 'keep-alive');
    assert.equal(c.headers['x-accel-buffering'], 'no');
    await c.waitFor((x) => x.events().length === 2);
    assert.equal(c.frames[0], 'retry: 2000');
    const got = c.events();
    assert.deepEqual(got.map((e) => e.id), ['1', '2']);
    assert.equal(got[1].obj.message, 'héllo ✓');
    c.destroy();
  });
});

test('SSE: a line appended later arrives live; each connection replays everything', async () => {
  await withServer({}, async ({ srv, events }) => {
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n`);
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 1);
    fs.appendFileSync(events, `${ev(2, 'log', { level: 'info', message: 'x' })}\n`);
    await c.waitFor((x) => x.events().length === 2);
    assert.equal(c.events()[1].id, '2');

    const c2 = sse(srv);
    await c2.ready;
    await c2.waitFor((x) => x.events().length === 2);
    c.destroy();
    c2.destroy();
  });
});

test('SSE: a line written in two chunks arrives exactly once, after its LF', async () => {
  await withServer({}, async ({ srv, events }) => {
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n`);
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 1);

    const line = ev(2, 'log', { level: 'info', message: 'split ✓ ünï' });
    const bytes = Buffer.from(line, 'utf8');
    // Cut inside a multibyte character.
    const cut = bytes.indexOf(Buffer.from('✓')) + 1;
    fs.appendFileSync(events, bytes.subarray(0, cut));
    await sleep(700);
    assert.equal(c.events().length, 1);
    fs.appendFileSync(events, bytes.subarray(cut));
    await sleep(700);
    assert.equal(c.events().length, 1, 'not delivered before LF');
    fs.appendFileSync(events, '\r\n');
    await c.waitFor((x) => x.events().length === 2);
    await sleep(700);
    const got = c.events();
    assert.equal(got.length, 2);
    assert.equal(got[1].obj.message, 'split ✓ ünï');
    c.destroy();
  });
});

test('SSE: invalid JSON lines are skipped', async () => {
  await withServer({}, async ({ srv, events }) => {
    fs.writeFileSync(events, `${ev(1, 'run_started')}\nthis is not json\n\n{"broken":\n`);
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 1);
    fs.appendFileSync(events, `garbage\n${ev(2, 'log', { level: 'info', message: 'after' })}\n`);
    await c.waitFor((x) => x.events().length === 2);
    assert.deepEqual(c.events().map((e) => e.obj.seq), [1, 2]);
    c.destroy();
  });
});

test('SSE: events without numeric seq are sent without id', async () => {
  await withServer({}, async ({ srv, events }) => {
    fs.writeFileSync(events, '{"v":1,"type":"log"}\n');
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 1);
    assert.equal(c.events()[0].id, undefined);
    c.destroy();
  });
});

test('SSE: file replaced by rename for a new run delivers the new run_started', async () => {
  await withServer({}, async ({ srv, events, hiveDir }) => {
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n${ev(2, 'log', { level: 'info', message: 'old' })}\n`);
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 2);

    // Orchestrator moves the old file away and starts a fresh one.
    const runs = path.join(hiveDir, 'runs', 'r1');
    fs.mkdirSync(runs, { recursive: true });
    fs.renameSync(events, path.join(runs, 'events.jsonl'));
    const fresh = JSON.stringify({ v: 1, seq: 1, ts: 'x', runId: 'r2', type: 'run_started', request: 'q', workspace: '/w', maxFailedCycles: 3 });
    fs.writeFileSync(events, `${fresh}\n`);
    await c.waitFor((x) => x.events().some((e) => e.obj.runId === 'r2'));
    c.destroy();
  });
});

test('SSE: truncation in place (same identity, shorter) delivers the new run_started', async () => {
  await withServer({}, async ({ srv, events }) => {
    const filler = 'x'.repeat(200);
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n${ev(2, 'log', { level: 'info', message: filler })}\n`);
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 2);

    fs.truncateSync(events, 0);
    await sleep(400);
    fs.appendFileSync(events, `${JSON.stringify({ v: 1, seq: 1, ts: 'x', runId: 'r2', type: 'run_started' })}\n`);
    await c.waitFor((x) => x.events().some((e) => e.obj.runId === 'r2'));
    c.destroy();
  });
});

test('SSE: in-place rewrite to a LARGER file is also detected', async () => {
  await withServer({}, async ({ srv, events }) => {
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n`);
    const c = sse(srv);
    await c.ready;
    await c.waitFor((x) => x.events().length === 1);

    const lines = [1, 2, 3].map((n) => JSON.stringify({ v: 1, seq: n, ts: 'x', runId: 'r2', type: n === 1 ? 'run_started' : 'log' }));
    fs.writeFileSync(events, `${lines.join('\n')}\n`);
    await c.waitFor((x) => x.events().filter((e) => e.obj.runId === 'r2').length === 3);
    c.destroy();
  });
});

test('SSE: events.jsonl created only after the client connected still streams', async () => {
  await withServer({}, async ({ srv, events }) => {
    const c = sse(srv);
    await c.ready;
    await sleep(400);
    assert.equal(c.events().length, 0);
    fs.writeFileSync(events, `${ev(1, 'run_started')}\n`);
    await c.waitFor((x) => x.events().length === 1);
    fs.appendFileSync(events, `${ev(2, 'log', { level: 'info', message: 'more' })}\n`);
    await c.waitFor((x) => x.events().length === 2);
    c.destroy();
  });
});

test('SSE: works when the hive directory does not exist yet', async () => {
  const env = setup();
  fs.rmSync(env.hiveDir, { recursive: true });
  const srv = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0 });
  try {
    const c = sse(srv);
    await c.ready;
    await sleep(400);
    fs.mkdirSync(env.hiveDir);
    fs.writeFileSync(env.events, `${ev(1, 'run_started')}\n`);
    await c.waitFor((x) => x.events().length === 1);
    c.destroy();
  } finally {
    await srv.close();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('close() ends open SSE streams and the server', async () => {
  const env = setup();
  const srv = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0 });
  fs.writeFileSync(env.events, `${ev(1, 'run_started')}\n`);
  const c1 = sse(srv);
  const c2 = sse(srv);
  await Promise.all([c1.ready, c2.ready]);
  await c1.waitFor((x) => x.events().length === 1);
  await srv.close();
  await c1.waitFor((x) => x.ended);
  await c2.waitFor((x) => x.ended);
  await srv.close(); // idempotent
  await assert.rejects(request(srv, '/'));
  fs.rmSync(env.tmp, { recursive: true, force: true });
});

test('close() also drops idle keep-alive sockets', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.publicDir, 'index.html'), 'ok');
  const srv = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0 });
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: '/', agent }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
  await srv.close();
  agent.destroy();
  fs.rmSync(env.tmp, { recursive: true, force: true });
});

test('port 0 picks a free port; busy port rejects with a --port hint', async () => {
  const env = setup();
  const a = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0 });
  try {
    assert.ok(a.port > 0);
    assert.equal(a.url, `http://127.0.0.1:${a.port}`);
    await assert.rejects(
      startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: a.port }),
      /--port/,
    );
  } finally {
    await a.close();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('loopback binding: a foreign Host header (DNS rebinding) gets 403 on every route', async () => {
  await withServer({}, async ({ srv, publicDir, state }) => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), 'ok');
    fs.writeFileSync(state, '{"v":1,"status":"running"}');
    for (const host of ['evil.example', 'evil.example:1725', '127.0.0.1.evil.example', 'localhost.evil.example', '10.0.0.5:80', '[::2]:80', 'localhost:abc']) {
      for (const p of ['/events', '/api/state', '/', '/index.html']) {
        const r = await requestWithHost(srv, p, host);
        assert.equal(r.status, 403, `${host} ${p}`);
        assert.ok(!r.body.includes('running'), `${host} ${p} leaked state`);
      }
    }
  });
});

test('loopback binding: localhost, 127.0.0.1 and [::1] (any port) are accepted, case-insensitively', async () => {
  await withServer({}, async ({ srv, publicDir }) => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), 'ok');
    for (const host of ['localhost', 'LOCALHOST:8080', '127.0.0.1', `127.0.0.1:${srv.port}`, '[::1]', '[::1]:1725']) {
      assert.equal((await requestWithHost(srv, '/api/state', host)).status, 200, host);
      assert.equal((await requestWithHost(srv, '/index.html', host)).body, 'ok', host);
    }
    const sseRes = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/events', headers: { Host: 'localhost:1' }, agent: false }, (res) => {
        res.destroy();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(sseRes, 200);
  });
});

test('loopback binding: a request without a Host header is refused', async () => {
  await withServer({}, async ({ srv }) => {
    // Node itself answers 400 to HTTP/1.1 without Host; either way no state is served.
    const r = await requestWithHost(srv, '/api/state', '');
    assert.ok([400, 403].includes(r.status), String(r.status));
  });
});

test('non-loopback binding skips the Host check', async () => {
  const env = setup();
  const srv = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0, host: '0.0.0.0' });
  try {
    assert.equal((await requestWithHost(srv, '/api/state', 'evil.example')).status, 200);
    assert.equal((await requestWithHost(srv, '/api/state', 'my-box.lan:1725')).status, 200);
  } finally {
    await srv.close();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a listen failure is a ServerStartError carrying the --port hint', async () => {
  const env = setup();
  const a = await startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: 0 });
  try {
    await assert.rejects(
      startVisualizerServer({ hiveDir: env.hiveDir, publicDir: env.publicDir, port: a.port }),
      (err) => err.name === 'ServerStartError' && /--port/.test(err.message),
    );
  } finally {
    await a.close();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});
