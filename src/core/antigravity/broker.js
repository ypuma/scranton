import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { antigravityProvider } from './provider.js';

const MAX_BODY = 16 * 1024 * 1024;
export async function startAntigravityBroker({ auth, host = '127.0.0.1', provider = antigravityProvider(), lifetimeMs = 30 * 60 * 1000 }) {
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 24 * 60 * 60 * 1000) throw Error('Invalid broker lifetime');
  const capability = randomBytes(32).toString('hex');
  const active = new Set(); let closed = false;
  const server = http.createServer(async (req, res) => {
    const supplied = req.headers.authorization;
    const expected = `Bearer ${capability}`;
    if (closed || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== 'POST' || req.url !== '/inference' || req.headers['content-type'] !== 'application/json') { res.writeHead(400); res.end(); return; }
    if (active.size >= 4) { res.writeHead(429); res.end(); return; }
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    res.on('close', () => controller.abort());
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length; if (bytes > MAX_BODY) throw Error(); chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || Object.keys(data).some((k) => !['model', 'context', 'options'].includes(k))) throw Error();
      const model = provider.getModels().find((m) => m.id === data.model);
      if (!model || !data.context || Object.keys(data.context).some((k) => k !== 'messages') || !Array.isArray(data.context.messages) || data.context.messages.length > 10000) throw Error();
      const options = data.options ?? {};
      if (Object.keys(options).some((k) => !['reasoning', 'thinking', 'temperature', 'maxTokens', 'toolChoice'].includes(k))) throw Error();
      if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > model.maxTokens)) throw Error();
      if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw Error();
      if (options.reasoning !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.reasoning)) throw Error();
      if (options.thinking !== undefined && (!options.thinking || typeof options.thinking !== 'object' || Array.isArray(options.thinking) || Object.keys(options.thinking).some((k) => !['enabled', 'level'].includes(k)) || typeof options.thinking.enabled !== 'boolean' || (options.thinking.level !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.thinking.level)))) throw Error();
      if (options.toolChoice !== undefined && !['auto', 'none', 'any'].includes(options.toolChoice)) throw Error();
      // Resolve on every inference: Pi owns locked refresh and persistence on the host.
      let apiKey;
      try { apiKey = await auth.mintAccessToken('google-antigravity', { minExpiryMs: 60000 }); }
      catch { res.writeHead(401); res.end('Google Antigravity sign-in unavailable; sign in again in Accounts before retrying Docker'); return; }
      controller.signal.throwIfAborted();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      const stream = provider.streamSimple(model, data.context, { ...options, apiKey, signal: controller.signal });
      let sent = 0;
      for await (const event of stream) {
        const { partial, ...wire } = event;
        if (event.type === 'start') wire.partial = { ...partial, content: [] };
        else if (partial && /_(start|end)$/.test(event.type)) {
          const block = partial.content[event.contentIndex];
          wire.block = event.type.endsWith('_end') ? block : block.type === 'toolCall' ? { ...block, arguments: {} } : { type: block.type, [block.type === 'thinking' ? 'thinking' : 'text']: '' };
          delete wire.content; delete wire.toolCall;
        }
        const line = JSON.stringify(wire) + '\n'; sent += Buffer.byteLength(line);
        if (sent > 64 * 1024 * 1024) throw Error();
        await new Promise((resolve, reject) => res.write(line, (error) => error ? reject(error) : resolve()));
      }
      res.end();
    } catch {
      if (!res.headersSent) { res.writeHead(400); res.end('Antigravity inference unavailable'); }
      else res.destroy();
    } finally { clearTimeout(timer); controller.abort(); active.delete(controller); }
  });
  server.maxConnections = 32;
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  let closing;
  const close = () => closing ??= (async () => {
    closed = true; clearTimeout(expiry);
    for (const controller of active) controller.abort();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  })();
  const expiry = setTimeout(() => { void close(); }, lifetimeMs); expiry.unref();
  return { capability, port: server.address().port, close };
}
