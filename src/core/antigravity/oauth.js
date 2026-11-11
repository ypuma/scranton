import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\x00-\x20\x7f]/.test(value);
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function parseRedirect(value, redirectUri, state) {
  let url;
  try { url = new URL(value); } catch { throw Error('Paste the complete OAuth redirect URL, including state'); }
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash ||
      url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state'), state) ||
      (!url.searchParams.has('error') && (url.searchParams.getAll('code').length !== 1 || !text(url.searchParams.get('code'))))) {
    throw Error('Invalid OAuth redirect or state');
  }
  if (url.searchParams.has('error')) throw Object.assign(Error('Antigravity sign-in declined'), { code: 'SCRANTON_OAUTH_DENIED' });
  return url.searchParams.get('code');
}

export async function responseJson(response, maxBytes = 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw Error('OAuth response too large'); }
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Error('OAuth response too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createOAuth({ clientId, clientSecret, redirectUri, scopes, provision, fetcher = (...args) => fetch(...args), now = Date.now }) {
  async function tokens(fields, signal, previous) {
    const started = now();
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(previous && [400, 401].includes(response.status) ? `Antigravity token refresh rejected (${response.status})` : 'Antigravity token request failed');
    }
    const data = await responseJson(response);
    const refresh = data.refresh_token ?? previous?.refresh;
    if (!text(data.access_token) || !text(refresh) || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400 ||
        (data.token_type !== undefined && data.token_type?.toLowerCase() !== 'bearer')) throw Error('Invalid Antigravity token response');
    return { ...previous, type: 'oauth', access: data.access_token, refresh, expires: started + data.expires_in * 1000 - 60000 };
  }
  return {
    name: 'Google Antigravity', isSubscription: true,
    async login(io) {
      io.signal.throwIfAborted();
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
        access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
      const controller = new AbortController();
      const signal = AbortSignal.any([io.signal, controller.signal]);
      let server, callback, onAbort;
      try {
        const target = new URL(redirectUri);
        if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.protocol !== 'http:') throw Error('Invalid OAuth callback configuration');
        callback = new Promise((resolve, reject) => {
          server = http.createServer((request, response) => {
            try {
              const code = parseRedirect(new URL(request.url, target.origin).href, redirectUri, state);
              response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Signed in. You may close this window.'); resolve(code);
            } catch (error) {
              response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Sign-in callback not accepted.');
              if (error.code === 'SCRANTON_OAUTH_DENIED') reject(error);
            }
          });
        });
        const listening = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(Number(target.port), '127.0.0.1', () => resolve(true)); });
        io.signal.throwIfAborted();
        io.notify({ type: 'auth_url', url: url.href });
        const manual = (async () => {
          while (true) {
            signal.throwIfAborted();
            const value = await io.prompt({ type: 'manual_code', message: 'Paste the complete redirect URL including code and state (not a bare code)', signal });
            signal.throwIfAborted();
            try { return parseRedirect(value, redirectUri, state); }
            catch (error) { if (error.code === 'SCRANTON_OAUTH_DENIED') throw error; }
          }
        })();
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(Error('Login cancelled'));
          io.signal.addEventListener('abort', onAbort, { once: true });
          if (io.signal.aborted) onAbort();
        });
        const code = await Promise.race([manual, cancelled, ...(listening ? [callback] : [])]);
        controller.abort();
        io.signal.throwIfAborted();
        const credential = await tokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, io.signal);
        const projectId = await provision(credential.access, io.signal);
        io.signal.throwIfAborted();
        return { ...credential, projectId };
      } finally { io.signal.removeEventListener('abort', onAbort); controller.abort(); server?.closeAllConnections(); server?.close(); }
    },
    refresh: (credential, signal) => tokens({ grant_type: 'refresh_token', refresh_token: credential.refresh }, signal, credential),
    async toAuth(credential) {
      if (!text(credential.access) || (typeof credential.projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(credential.projectId))) throw Error('Invalid Antigravity credential; sign in again');
      return { apiKey: JSON.stringify({ token: credential.access, projectId: credential.projectId }) };
    }
  };
}
