import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pairPage } from './relay-page.js';

const LOOPBACK = '127.0.0.1';
const COOKIE = '__Host-scranton-relay';
const PAIR = '/_relay/pair';
const CLIENT = 'x-scranton-client';
const BODY_LIMIT = 262144;
const SESSION_LIMIT = 8;
const SESSION_LIFETIME = 12 * 60 * 60 * 1000;
const PAIR_FAILURE_LIMIT = 5;
const PAIR_COOLDOWN = 30000;
const POLICY = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function sendError(res, status, error) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error }));
}

function matches(secret, value) {
  return typeof value === 'string' && value.length === secret.length &&
    /^[A-Za-z0-9_-]+$/.test(value) && timingSafeEqual(Buffer.from(secret), Buffer.from(value));
}

function sessionCookie(req) {
  return (req.headers.cookie ?? '').split(';').map((pair) => pair.trim()).find((pair) => pair.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

async function readBody(req, res, limit, error) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      sendError(res, 413, error);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function revoke(sessions, token) {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  session.closed = true;
  clearTimeout(session.timer);
  for (const close of session.forwards) close();
  session.forwards.clear();
}

function activeSession(sessions, token) {
  const session = sessions.get(token);
  if (session && session.expires <= Date.now()) {
    revoke(sessions, token);
    return undefined;
  }
  return session;
}

function limitedPairPage(res, retryMs) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
  return pairPage(res, 429);
}

async function pair(req, res, code, sessions, failures, isClosing) {
  if (failures.until > Date.now()) return limitedPairPage(res, failures.until - Date.now());
  if (!/^application\/x-www-form-urlencoded(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) {
    return sendError(res, 415, 'Expected a pairing form');
  }
  const body = await readBody(req, res, 256, 'Pairing form too large');
  if (body === null || res.destroyed || isClosing()) return;
  const now = Date.now();
  // Recheck after the body: concurrent slow forms share this same bounded cooldown.
  if (failures.until > now) return limitedPairPage(res, failures.until - now);
  if (!matches(code, new URLSearchParams(body.toString('utf8')).get('code'))) {
    if (now >= failures.resetAt) failures.count = 0;
    if (!failures.count) failures.resetAt = now + PAIR_COOLDOWN;
    if (++failures.count >= PAIR_FAILURE_LIMIT) {
      failures.until = now + PAIR_COOLDOWN;
      failures.resetAt = failures.until;
      return limitedPairPage(res, PAIR_COOLDOWN);
    }
    return pairPage(res, 401);
  }
  for (const token of sessions.keys()) activeSession(sessions, token);
  if (sessions.size >= SESSION_LIMIT) {
    return limitedPairPage(res, Math.min(...[...sessions.values()].map((session) => session.expires)) - now);
  }
  const token = randomBytes(32).toString('base64url');
  const session = { expires: now + SESSION_LIFETIME, forwards: new Set() };
  session.timer = setTimeout(() => revoke(sessions, token), SESSION_LIFETIME);
  session.timer.unref();
  sessions.set(token, session);
  res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict` });
  res.end();
}

// Forward dashboard operations explicitly. Account setup and agent definitions stay local.
const STATIC = /^\/(?:index\.html|favicon\.ico|styles\.css|js\/[a-z0-9-]+\.js|fonts\/[A-Za-z0-9.-]+\.woff2|demo\/sample-events\.jsonl)$/;
const PROJECT = /^\/api\/projects\/[a-z0-9][a-z0-9-]{0,39}(\/.*)$/;
const CHAT = /^\/chats\/[a-z0-9][a-z0-9-]{0,39}(\/.*)$/;
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const TEAM_HISTORY = new RegExp(`^/runs/${ID}/(?:events|diff|thoughts)$`);
const PIPELINE_RUN = new RegExp(`^/pipeline/runs/${ID}(?:/artifacts/[A-Za-z0-9_.-]+)?$`);
const PIPELINE_ACTION = new RegExp(`^/pipeline/runs/${ID}/(?:decision|resume|cancel)$`);
const TEAM_READS = new Set(['/control', '/state', '/live', '/runs', '/events']);
const TEAM_WRITES = new Set(['/runs', '/runs/stop', '/runs/release', '/hitl', '/chat', '/stop']);

function allowed(method, pathname) {
  const write = method === 'POST';
  if (!write && ['/', '/events', '/api/projects', '/api/models', '/api/pipeline'].includes(pathname)) return true;
  if (!write && STATIC.test(pathname)) return true;
  if (pathname.startsWith('/api/') && (write ? TEAM_WRITES : TEAM_READS).has(pathname.slice(4))) return true;
  if (write && ['/api/projects', '/api/projects/rename', '/api/projects/remove', '/api/pipeline/sandbox/build'].includes(pathname)) return true;

  const project = PROJECT.exec(pathname)?.[1];
  if (!project) return false;
  if (write && ['/chats', '/chats/rename', '/chats/remove', '/pipeline/detect', '/context/settings', '/context/notes'].includes(project)) return true;
  if (write && /^\/dreaming\/(?:preview|sweep|settings|rollback|propose|proposal\/apply|proposal\/reject|cancel)$/.test(project)) return true;
  if (!write && ['/context', '/dreaming', '/dreaming/proposal'].includes(project)) return true;
  const chat = CHAT.exec(project)?.[1];
  if (!chat) return false;
  if (write) return TEAM_WRITES.has(chat) || ['/pipeline/runs', '/context/reset', '/context/restore'].includes(chat) || PIPELINE_ACTION.test(chat);
  return TEAM_READS.has(chat) || ['/context', '/pipeline'].includes(chat) || TEAM_HISTORY.test(chat) || PIPELINE_RUN.test(chat);
}

async function forward(req, res, targetPort, session) {
  let upstream;
  let response;
  const close = () => {
    upstream?.destroy();
    response?.destroy();
    res.destroy();
    req.resume();
  };
  session.forwards.add(close);
  res.once('close', () => {
    session.forwards.delete(close);
    if (!res.writableFinished) upstream?.destroy();
  });
  // Buffer writes before opening upstream so an oversized chunked body cannot execute in part.
  const body = req.method === 'POST' ? await readBody(req, res, BODY_LIMIT, 'Body too large') : undefined;
  if (body === null || session.closed || res.destroyed) return;
  const headers = {};
  const requestHeaders = req.method === 'POST' ? [CLIENT, 'content-type'] : [CLIENT, 'last-event-id'];
  for (const name of requestHeaders) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  // The relay has already authenticated and checked the browser's origin.
  if (req.headers.origin) headers.origin = `http://${LOOPBACK}:${targetPort}`;
  if (body) headers['content-length'] = String(body.length);
  upstream = http.request({ hostname: LOOPBACK, port: targetPort, path: req.url, method: req.method, headers });
  const disconnected = () => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy();
    else sendError(res, 502, 'The Scranton dashboard is unavailable');
  };
  upstream.on('error', disconnected);
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.on('response', (incoming) => {
    response = incoming;
    if (session.closed || res.destroyed) return response.destroy();
    const forwarded = {};
    for (const name of ['content-type', 'content-length', 'x-accel-buffering']) {
      if (response.headers[name] !== undefined) forwarded[name] = response.headers[name];
    }
    if (forwarded['content-type']?.startsWith('text/event-stream')) upstream.setTimeout(0);
    if (forwarded['content-type']?.startsWith('text/html')) {
      forwarded['content-security-policy'] = `${POLICY}; img-src 'self' data:`;
    }
    response.on('error', disconnected);
    res.writeHead(response.statusCode, forwarded);
    response.pipe(res);
  });
  upstream.end(body);
}

class RelayStartError extends Error {
  name = 'RelayStartError';
}

function parsePort(value, option, min) {
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > 65535) {
    throw new TypeError(`${option} must be ${min}-65535`);
  }
  return Number(value);
}

function parseOrigin(value) {
  const origin = URL.parse(value);
  if (origin?.protocol !== 'https:' || ![origin.origin, `${origin.origin}/`].includes(value)) {
    throw new TypeError('--origin must be the phone-facing HTTPS origin, e.g. https://scranton.example.net');
  }
  return origin;
}

function relayListener(external, port, certFile, keyFile, listenIp) {
  if (certFile === undefined && keyFile === undefined) {
    if (listenIp !== undefined) throw new TypeError('--listen-ip requires --tls-cert and --tls-key');
    return { host: LOOPBACK, port: parsePort(port ?? 1726, '--port', 0), httpServer: http.createServer };
  }
  if (!certFile || !keyFile) throw new TypeError('Provide both --tls-cert and --tls-key');
  const host = listenIp ?? external.hostname;
  if (isIPv4(external.hostname) && host !== external.hostname) throw new TypeError('--listen-ip must match the HTTPS origin IP');
  if (!isIPv4(host) || !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) {
    throw new TypeError('Direct HTTPS requires a private IPv4 address in --origin or --listen-ip');
  }
  const originPort = Number(external.port || 443);
  if (port !== undefined && parsePort(port, '--port', 1) !== originPort) {
    throw new TypeError('--port must match the HTTPS origin port');
  }
  let cert;
  let key;
  try {
    cert = readFileSync(certFile);
    key = readFileSync(keyFile);
    https.createServer({ cert, key });
  } catch (err) {
    throw new RelayStartError(`Cannot load the relay TLS certificate and key: ${err.message}`);
  }
  return {
    host, port: originPort,
    httpServer: (options, listener) => https.createServer({ ...options, cert, key }, listener)
  };
}

export async function startRelay({ origin, port, targetPort = 1725, certFile, keyFile, listenIp } = {}) {
  const external = parseOrigin(origin);
  const listener = relayListener(external, port, certFile, keyFile, listenIp);
  port = listener.port;
  targetPort = parsePort(targetPort, '--target-port', 1);
  if (port === targetPort) throw new TypeError('The relay port must differ from the dashboard port');
  const target = `http://${LOOPBACK}:${targetPort}`;
  try {
    const response = await fetch(`${target}/api/control`, { headers: { [CLIENT]: '1' }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok || (await response.json()).enabled !== true) throw new Error();
  } catch {
    throw new RelayStartError(`No controlled Scranton dashboard at ${target}. Start visualize --control or use --target-port with the running dashboard.`);
  }
  const code = randomBytes(24).toString('base64url');
  const sessions = new Map();
  const failures = { count: 0, resetAt: 0, until: 0 };
  let closing;
  const server = listener.httpServer({ headersTimeout: 10000, requestTimeout: 30000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.headers.host !== external.host || (req.headers.origin && req.headers.origin !== external.origin)) {
      return sendError(res, 403, 'Forbidden origin');
    }
    const { method, url } = req;
    const pathname = url.split('?', 1)[0];
    if (!/^\/[A-Za-z0-9_./-]*$/.test(pathname) || pathname.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)) {
      return sendError(res, 400, 'Invalid path');
    }
    if (method === 'POST' && req.headers.origin !== external.origin) return sendError(res, 403, 'Expected same-origin request');
    if (method === 'POST' && pathname === PAIR) {
      pair(req, res, code, sessions, failures, () => Boolean(closing)).catch(() => res.destroy());
      return;
    }
    const token = sessionCookie(req);
    const session = activeSession(sessions, token);
    if (!session) {
      if (['GET', 'HEAD'].includes(method) && ['/', '/index.html'].includes(pathname)) return pairPage(res);
      return sendError(res, 401, 'Pair with Scranton to continue');
    }
    if (method === 'POST' && pathname === '/_relay/logout') {
      revoke(sessions, token);
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
      return res.end();
    }
    if (method === 'GET' && pathname === '/_relay/session') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ paired: true }));
    }
    if (!['GET', 'HEAD', 'POST'].includes(method) || !allowed(method, pathname)) return sendError(res, 404, 'Not available through the relay');
    if (method === 'POST') {
      if (req.headers[CLIENT] !== '1') return sendError(res, 403, 'Missing Scranton client header');
      if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) return sendError(res, 415, 'Expected application/json');
      if (Number(req.headers['content-length']) > BODY_LIMIT) return sendError(res, 413, 'Body too large');
    }
    forward(req, res, targetPort, session).catch(() => res.destroy());
  });
  server.on('clientError', (_, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = (err) => reject(new RelayStartError(`Cannot listen on ${listener.host}:${port}: ${err.message}`));
    server.once('error', failed);
    server.listen(port, listener.host, () => {
      server.off('error', failed);
      resolve();
    });
  });
  return {
    origin: external.origin,
    url: certFile ? external.origin : `http://${LOOPBACK}:${server.address().port}`,
    code,
    close: () => (closing ??= new Promise((resolve) => {
      for (const token of sessions.keys()) revoke(sessions, token);
      server.close(resolve);
      server.closeAllConnections();
    }))
  };
}
