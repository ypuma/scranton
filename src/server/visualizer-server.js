// Visualizer HTTP/SSE server: static UI, /events (tail of hive/events.jsonl) and /api/state.
import http from 'node:http';
import { isLoopbackAddress } from '../core/network.js';
import { createControl, json } from './control.js';
import { createRegistryRouter } from './registry-router.js';
import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;

const DEFAULT_PORT = 1725;
const DEFAULT_HOST = '127.0.0.1';
const POLL_MS = 300;
const PING_MS = 15000;
const READ_CHUNK = 1024 * 1024;
const HEAD_BYTES = 64;
const IDLE_STATE = { v: 1, status: 'idle' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Incrementally reads complete JSONL lines from one file. Survives the file
 * missing, appended in chunks, truncated and replaced (new run).
 */
class EventTail {
  constructor(file, onEvent) {
    this.file = file;
    this.onEvent = onEvent;
    this.running = false;
    this.dirty = false;
    this.closed = false;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.head = Buffer.alloc(0);
    this.identity = null;
    this.mtime = null;
  }

  async poll() {
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.dirty = false;
        await this.step().catch(() => {});
      } while (this.dirty && !this.closed);
    } finally {
      this.running = false;
    }
  }

  async step() {
    let st;
    try {
      st = await fsp.stat(this.file, { bigint: true });
    } catch (err) {
      if (err.code === 'ENOENT') this.reset();
      return;
    }
    const identity = `${st.ino}:${st.birthtimeNs}`;
    const size = Number(st.size);
    if (this.identity !== null && (identity !== this.identity || size < this.offset)) this.reset();
    this.identity = identity;
    if (size === this.offset && st.mtimeNs === this.mtime) return;
    this.mtime = st.mtimeNs;

    let fh;
    try {
      fh = await fsp.open(this.file, 'r');
      // Truncate + rewrite to >= the old size keeps ino/birthtime; the file head gives it away.
      if (this.offset > 0 && this.head.length > 0) {
        const probe = Buffer.alloc(this.head.length);
        const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
        if (bytesRead < probe.length || !probe.equals(this.head)) {
          this.reset();
          this.identity = identity;
          this.mtime = st.mtimeNs;
        }
      }
      while (!this.closed && this.offset < size) {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - this.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        if (this.head.length < HEAD_BYTES) {
          this.head = Buffer.concat([this.head, chunk]).subarray(0, HEAD_BYTES);
        }
        this.offset += bytesRead;
        this.feed(chunk);
      }
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  // Lines are cut on LF at the byte level, so a multibyte char is never split.
  feed(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let idx;
    while ((idx = this.pending.indexOf(10)) !== -1) {
      const line = this.pending.subarray(0, idx).toString('utf8').replace(/\r$/, '').trim();
      this.pending = this.pending.subarray(idx + 1);
      if (line) this.emit(line);
    }
  }

  emit(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj === null || typeof obj !== 'object') return;
    this.onEvent(line, obj);
  }
}

/** The server could not start (port busy, bad host, ...); the message is meant to be shown as is. */
export class ServerStartError extends Error {
  name = 'ServerStartError';
}

const isLoopbackHost = (host) => /^(localhost|\[?::1\]?|(::ffff:)?127(\.\d{1,3}){3})$/i.test(host);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the Host header names this machine (any port); anything else may be a DNS-rebinding page. */
function hostHeaderIsLocal(value) {
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::\d+)?$/.exec(String(value ?? '').trim());
  return Boolean(m) && (LOCAL_HOSTNAMES.has(m[1].toLowerCase()) || isLoopbackAddress(m[1].replace(/^\[|\]$/g, '')));
}

function notFound(res, head) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(head ? undefined : 'Not found');
}

/** Maps a request pathname to a file inside root, or null if it would escape or is malformed. */
function resolveStatic(root, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\') || rel.includes(':')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

async function serveStatic(req, res, root, realRoot, pathname) {
  const head = req.method === 'HEAD';
  let target = resolveStatic(root, pathname);
  if (!target) return notFound(res, head);
  try {
    let st = await fsp.stat(target);
    if (st.isDirectory()) {
      target = path.join(target, 'index.html');
      st = await fsp.stat(target);
    }
    if (!st.isFile()) return notFound(res, head);
    // Symlinks must not lead out of publicDir either.
    const real = await fsp.realpath(target);
    const rootReal = await realRoot();
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return notFound(res, head);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(path.extname(target).toLowerCase() === '.html' ? {
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      } : {}),
    });
    if (head) return res.end();
    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    if (!res.headersSent) notFound(res, head);
    else res.destroy();
  }
}

export function createHiveContext({ hive, control }) {
  const eventsFile = path.join(hive, 'events.jsonl');
  const stateFile = path.join(hive, 'state.json');
  const controller = control ? createControl({ hive, ...control }) : null;
  const clients = new Set(); // { res, tail, ping }
  let watcher = null;
  let pollTimer = null;
  let closed = false;
  let lastGoodState = null;

  const pollAll = () => {
    for (const c of clients) c.tail.poll();
  };

  const startWatching = () => {
    if (!pollTimer) pollTimer = setInterval(() => {
      if (!watcher) tryWatch();
      pollAll();
    }, POLL_MS);
    tryWatch();
  };

  // fs.watch is only a latency optimisation; the stat poll is the source of truth.
  function tryWatch() {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(hive, () => pollAll());
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  const stopWatching = () => {
    clearInterval(pollTimer);
    pollTimer = null;
    watcher?.close();
    watcher = null;
  };

  function removeClient(c) {
    if (!clients.delete(c)) return;
    c.tail.closed = true;
    clearInterval(c.ping);
    if (clients.size === 0) stopWatching();
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') return res.end();
    res.socket?.setNoDelay(true);
    res.write('retry: 2000\n\n');
    const tail = new EventTail(eventsFile, (line, obj) => {
      const id = Number.isFinite(obj.seq) ? `id: ${obj.seq}\n` : '';
      res.write(`${id}data: ${line}\n\n`);
    });
    const c = { res, tail, ping: setInterval(() => res.write(': ping\n\n'), PING_MS) };
    clients.add(c);
    const done = () => removeClient(c);
    res.on('close', done);
    res.on('error', done);
    req.on('error', done);
    if (clients.size === 1) startWatching();
    tail.poll();
  }

  async function readState() {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const text = await fsp.readFile(stateFile, 'utf8');
        const obj = JSON.parse(text);
        lastGoodState = text.trim();
        return lastGoodState || JSON.stringify(obj);
      } catch (err) {
        if (err.code === 'ENOENT') return lastGoodState ?? JSON.stringify(IDLE_STATE);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    return lastGoodState ?? JSON.stringify(IDLE_STATE);
  }

  async function handleState(req, res) {
    const body = await readState();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return { controller, get subscribers() { return clients.size; }, handleEvents, handleState,
    async close() {
      closed = true;
      for (const c of [...clients]) { removeClient(c); c.res.end(); }
      stopWatching();
      await controller?.close();
    }
  };
}

/**
 * @param {{ hiveDir: string, publicDir: string, port?: number, host?: string }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startVisualizerServer({ hiveDir, publicDir, port = DEFAULT_PORT, host = DEFAULT_HOST, control, dataDir, maxConcurrentRuns = 4, projectsRoot, legacyWorkspace } = {}) {
  if (!hiveDir && !dataDir) throw new TypeError('startVisualizerServer: hiveDir is required');
  if (!publicDir) throw new TypeError('startVisualizerServer: publicDir is required');

  const root = path.resolve(publicDir);
  const single = dataDir ? null : createHiveContext({ hive: path.resolve(hiveDir), control });
  const registryRouter = createRegistryRouter({ dataDir, hiveDir, control, maxConcurrentRuns, projectsRoot, legacyWorkspace,
    contextFactory: createHiveContext, single });
  const controller = single?.controller ?? registryRouter.authController;
  let realRootPromise = null;
  const realRoot = () => (realRootPromise ??= fsp.realpath(root));
  let closed = false;
  const checkHost = isLoopbackHost(host);
  const server = http.createServer(async (req, res) => {
    if (checkHost && !hostHeaderIsLocal(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    const controlPath = req.url.split(/[?#]/, 1)[0];
    try { if (await registryRouter.handle(req, res, controlPath)) return; }
    catch (err) { return json(res, err.status ?? 500, { error: err.status ? err.message : 'Registry operation failed' }); }
    if (controlPath === '/api/agents' || /^\/api\/agents\/[^/]+(?:\/prompt)?$/.test(controlPath)) {
      if (!controller) return notFound(res, req.method === 'HEAD');
      if (!hostHeaderIsLocal(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
      if (controlPath === '/api/agents' ? ['GET', 'POST'].includes(req.method) : controlPath.endsWith('/prompt') ? ['PUT', 'DELETE'].includes(req.method) : ['PATCH', 'DELETE'].includes(req.method)) return controller.handle(req, res, controlPath);
      return notFound(res, req.method === 'HEAD');
    }
    const authPath = ['/api/auth', '/api/models', '/api/auth/login', '/api/auth/login/input', '/api/auth/login/open', '/api/auth/login/cancel', '/api/auth/logout', '/api/auth/key', '/api/auth/providers', '/api/providers', '/api/providers/discover', '/api/providers/remove'].includes(controlPath);
    if (authPath) {
      if (!controller) return notFound(res, req.method === 'HEAD');
      if (!isLoopbackAddress(req.socket.remoteAddress) || !hostHeaderIsLocal(req.headers.host)) return json(res, 403, { error: 'Forbidden' });
      if ((['/api/auth', '/api/models', '/api/auth/providers'].includes(controlPath) && req.method === 'GET') ||
          (!['/api/auth', '/api/models', '/api/auth/providers'].includes(controlPath) && req.method === 'POST')) return controller.handle(req, res, controlPath);
      return notFound(res, req.method === 'HEAD');
    }
    if (['/api/control', '/api/runs', '/api/hitl', '/api/runs/stop', '/api/runs/release', '/api/chat'].includes(controlPath) &&
        !isLoopbackAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'Forbidden peer' });
    if (controlPath === '/api/control' && req.method === 'GET') {
      if (!hostHeaderIsLocal(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
      await controller?.recoverGone();
      return json(res, 200, controller?.snapshot() ?? { v: 1, enabled: false });
    }
    if (['/api/runs', '/api/hitl', '/api/runs/stop', '/api/runs/release', '/api/chat'].includes(controlPath)) {
      if (!controller) return notFound(res, req.method === 'HEAD');
      if (req.method === 'POST') {
        if (!hostHeaderIsLocal(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
        return controller.handle(req, res, controlPath);
      }
      return notFound(res, req.method === 'HEAD');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed');
    }
    // Not `new URL`: it would read "//x" as a host and normalise away `..`.
    const pathname = req.url.split(/[?#]/, 1)[0];
    if (!pathname.startsWith('/')) return notFound(res, req.method === 'HEAD');
    if (pathname === '/events') return single.handleEvents(req, res);
    if (pathname === '/api/state') {
      return single.handleState(req, res).catch(() => res.destroy());
    }
    serveStatic(req, res, root, realRoot, pathname).catch(() => res.destroy());
  });
  server.on('clientError', (err, socket) => socket.destroy());

  function close() {
    if (closed) return closing;
    closed = true;
    closing = (async () => {
      await registryRouter.close();
      await single?.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    })();
    return closing;
  }
  let closing = null;

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new ServerStartError(`Port ${port} is already in use on ${host}. Pick another one with --port <number>.`));
      } else {
        reject(new ServerStartError(`Cannot listen on ${host}:${port}: ${err.message}`));
      }
    });
    server.listen(port, host, () => {
      const actual = server.address().port;
      const shownHost = host.includes(':') ? `[${host}]` : host;
      resolve({ url: `http://${shownHost}:${actual}`, port: actual, close });
    });
  });
}

export default startVisualizerServer;
