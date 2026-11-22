import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createOAuth as createAntigravityOAuth, responseJson } from '../antigravity/oauth.js';
import { failure } from './store.js';

const hosts = { anthropic: ['claude.ai'], openai: ['auth.openai.com'], 'google-antigravity': ['accounts.google.com'] };
export function validateAuthUrl(provider, value) {
  let url;
  try { url = new URL(value); } catch { throw failure('SCRANTON_AUTH_URL', 'Invalid sign-in URL'); }
  if (url.protocol !== 'https:' || !hosts[provider]?.includes(url.hostname) || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || [...url.searchParams.keys()].some((k) => /token|secret/i.test(k))) throw failure('SCRANTON_AUTH_URL', 'Untrusted sign-in URL');
  return url.href;
}
export async function openAuthBrowser(provider, value, { platform = process.platform, runner = spawn } = {}) {
  const url = validateAuthUrl(provider, value);
  const [command, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    await new Promise((resolve, reject) => {
      const child = runner(command, args, { shell: false, detached: true, windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch { throw failure('SCRANTON_AUTH_BROWSER', 'Could not open system browser'); }
}
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 65536 && !/[\s\x00-\x1f\x7f]/.test(v);
export function isRefreshRejection(provider, error) {
  return error?.code === 'SCRANTON_OAUTH_REJECTED' && error.provider === provider;
}
function rejected(provider) { return Object.assign(failure('SCRANTON_OAUTH_REJECTED', 'Sign-in renewal was rejected; sign in again'), { provider }); }
const temporary = () => failure('SCRANTON_OAUTH_TEMPORARY', 'Sign-in renewal unavailable right now; check the connection or request shorter validity');
const defaults = {
  anthropic: { clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', authorizeUrl: 'https://claude.ai/oauth/authorize', tokenUrl: 'https://platform.claude.com/v1/oauth/token', redirectUri: 'http://localhost:53692/callback', scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload' },
  openai: { clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', authorizeUrl: 'https://auth.openai.com/api/accounts/authorize', tokenUrl: 'https://auth.openai.com/oauth/token', directTokenUrl: 'https://auth.openai.com/api/accounts/oauth/token', redirectUri: 'http://127.0.0.1:1455/auth/callback', scope: 'openid profile email offline_access', deviceUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode', pollUrl: 'https://auth.openai.com/api/accounts/deviceauth/token', verificationUri: 'https://auth.openai.com/codex/device', deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback' }
};
function accountId(access) {
  try { const value = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id; return text(value) ? value : undefined; } catch { return undefined; }
}
export function createOAuthProviders({ fetcher = fetch, now = Date.now, endpoints = {}, antigravity = {} } = {}) {
  async function request(url, fields, signal, { json = false, refreshProvider } = {}) {
    const response = await fetcher(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: json ? JSON.stringify(fields) : new URLSearchParams(fields) });
    if (!response.ok) {
      await response.body?.cancel();
      if (refreshProvider && [400, 401].includes(response.status)) throw rejected(refreshProvider);
      throw Error('OAuth request failed');
    }
    return responseJson(response);
  }
  function create(provider) {
    const config = { ...defaults[provider], ...endpoints[provider] };
    function credential(data, previous, direct = false) {
      const refresh = data.refresh_token ?? previous?.refresh;
      if (!text(data.access_token) || !text(refresh) || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000 || (data.token_type !== undefined && data.token_type?.toLowerCase() !== 'bearer')) throw Error('Invalid token response');
      const result = { ...previous, type: 'oauth', access: data.access_token, refresh, expires: now() + data.expires_in * 1000 };
      if (provider === 'openai') {
        if (direct) {
          if (typeof data.scope !== 'string' || !data.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) throw rejected(provider);
          result.scopes = data.scope.split(/\s+/); result.grantKind = 'direct';
        } else {
          result.accountId = accountId(data.access_token) ?? previous?.accountId;
          if (!result.accountId) throw Error('Missing account identity');
          result.grantKind = 'codex'; result.mode = 'chatgpt';
        }
      }
      return result;
    }
    async function exchange(fields, signal, previous) {
      const direct = provider === 'openai' && previous?.grantKind !== 'codex' && !previous?.accountId && Boolean(previous);
      if (direct && !text(previous.clientId)) throw rejected(provider);
      const data = await request(direct ? config.directTokenUrl : config.tokenUrl, {
        client_id: direct ? previous.clientId : config.clientId, ...fields,
        ...(direct ? { resource: 'https://api.openai.com/v1' } : {})
      }, signal, { json: provider === 'anthropic', refreshProvider: fields.grant_type === 'refresh_token' ? provider : undefined });
      if (direct && fields.grant_type === 'authorization_code' && !text(data.id_token)) throw Error('Missing ID token');
      return credential(data, previous, direct);
    }
    async function browser(io, options) {
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const target = new URL(config.redirectUri);
      if (target.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(target.hostname) || target.username || target.password || target.search || target.hash) throw Error('Invalid callback configuration');
      const manualAbort = new AbortController(), signal = AbortSignal.any([io.signal, manualAbort.signal]);
      let server, onAbort, issuedClientId;
      function parse(value, manual = false) {
        if (typeof value !== 'string' || value.length > 4096) throw Error('Invalid authorization input');
        let url;
        try { url = new URL(value); } catch {
          if (manual && provider === 'anthropic') {
            const [code, pastedState, extra] = value.trim().split('#');
            if (!pastedState || pastedState !== state || extra !== undefined) throw Error('Invalid OAuth state; paste the complete code#state or redirect URL');
            if (!text(code)) throw Error('Invalid authorization code');
            return code;
          }
          throw Error('Paste the complete redirect URL');
        }
        if (url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password || url.hash ||
            url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) throw Error('Invalid OAuth state');
        if (url.searchParams.has('error')) throw failure('SCRANTON_OAUTH_DENIED', 'Sign-in declined');
        if (url.searchParams.getAll('code').length !== 1 || !text(url.searchParams.get('code'))) throw Error('Invalid authorization code');
        if (provider === 'openai') {
          const id = url.searchParams.get('client_id');
          if (url.searchParams.getAll('client_id').length !== 1 || !text(id)) throw Error('Missing issued client identity');
          issuedClientId = id;
        }
        return url.searchParams.get('code');
      }
      try {
        let resolveCallback, rejectCallback;
        const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
        server = http.createServer((req, res) => {
          try {
            if (req.method !== 'GET') throw Error();
            const code = parse(new URL(req.url, target.origin).href);
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Signed in. You may close this window.'); resolveCallback(code);
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Sign-in callback not accepted.');
            if (error.code === 'SCRANTON_OAUTH_DENIED') rejectCallback(error);
          }
        });
        const listening = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(Number(target.port), '127.0.0.1', () => resolve(true)); });
        io.signal.throwIfAborted();
        const url = new URL(config.authorizeUrl);
        url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope,
          code_challenge: challenge, code_challenge_method: 'S256', state,
          ...(provider === 'anthropic' ? { code: 'true' } : { client_id: 'dynamic_agent_client',
            agent_name_hint: options?.agentName ?? 'Scranton', ext_agent_host_id: `urn:uuid:${options?.getDeviceId?.() ?? randomUUID()}`,
            resource: 'https://api.openai.com/v1', scope: `${config.scope} resource.invoke chatgpt.tokens.use.direct`, nonce: randomBytes(32).toString('base64url') }) }).toString();
        io.notify({ type: 'auth_url', url: url.href });
        const manual = Promise.resolve().then(async () => {
          let message = 'Paste the authorization code with #state / complete redirect URL';
          for (;;) {
            signal.throwIfAborted();
            const value = await io.prompt({ type: 'manual_code', message, signal });
            signal.throwIfAborted();
            try { return parse(value, true); } catch (error) {
              if (error.code === 'SCRANTON_OAUTH_DENIED') throw error;
              message = 'Invalid authorization code or OAuth state; paste the complete code#state / redirect URL';
            }
          }
        });
        const aborted = new Promise((_, reject) => { onAbort = () => reject(Error('Login cancelled')); io.signal.addEventListener('abort', onAbort, { once: true }); if (io.signal.aborted) onAbort(); });
        const code = await Promise.race([manual, aborted, ...(listening ? [callback] : [])]);
        manualAbort.abort(); io.signal.throwIfAborted();
        io.notify({ type: 'progress' });
        return await exchange({ grant_type: 'authorization_code', code, state, code_verifier: verifier, redirect_uri: config.redirectUri }, io.signal, provider === 'openai' ? { clientId: issuedClientId } : undefined);
      } finally { io.signal.removeEventListener('abort', onAbort); manualAbort.abort(); server?.closeAllConnections(); server?.close(); }
    }
    async function device(io) {
      const device = await request(config.deviceUrl, { client_id: config.clientId }, io.signal, { json: true });
      let interval = Number(device.interval);
      if (!text(device.device_auth_id) || !text(device.user_code) || !Number.isFinite(interval) || interval < 0 || interval > 60) throw Error('Invalid device response');
      io.notify({ type: 'device_code', userCode: device.user_code, verificationUri: config.verificationUri });
      const deadline = now() + 15 * 60 * 1000;
      while (now() < deadline) {
        await sleep(Math.max(10, interval * 1000), undefined, { signal: io.signal });
        const response = await fetcher(config.pollUrl, { method: 'POST', redirect: 'error', signal: io.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }) });
        if (response.ok) {
          const data = await responseJson(response);
          if (!text(data.authorization_code) || !text(data.code_verifier)) throw Error('Invalid device grant');
          return exchange({ grant_type: 'authorization_code', code: data.authorization_code, code_verifier: data.code_verifier, redirect_uri: config.deviceRedirectUri }, io.signal);
        }
        if ([403, 404].includes(response.status)) { await response.body?.cancel(); continue; }
        const data = await responseJson(response);
        const code = typeof data.error === 'string' ? data.error : data.error?.code;
        if (code === 'slow_down') { interval += 5; continue; }
        if (['authorization_pending', 'deviceauth_authorization_pending'].includes(code)) continue;
        throw Error('Device sign-in failed');
      }
      throw Error('Device sign-in timed out');
    }
    return {
      login: (io, options = {}) => provider === 'openai' && options.method === 'device_code' ? device(io) : browser(io, options),
      refresh: (c, signal) => exchange({ grant_type: 'refresh_token', refresh_token: c.refresh }, signal, c)
    };
  }
  const google = createAntigravityOAuth({
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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', redirectUri: 'http://localhost:51121/oauth-callback',
    scopes: ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map((s) => `https://www.googleapis.com/auth/${s}`),
    fetcher, now,
    provision: async (access, signal) => {
      const response = await fetcher('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)' }, body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }) });
      if (!response.ok) { await response.body?.cancel(); throw Error('Antigravity project unavailable'); }
      const data = await responseJson(response), project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
      if (!text(project) || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(project)) throw Error('Antigravity project unavailable');
      return project;
    }, ...antigravity
  });
  const providers = { anthropic: create('anthropic'), openai: create('openai'), 'google-antigravity': google };
  return Object.fromEntries(Object.entries(providers).map(([id, adapter]) => [id, {
    async login(io, options) {
      const signal = AbortSignal.any([io.signal ?? new AbortController().signal, AbortSignal.timeout(10 * 60 * 1000)]);
      try { return await adapter.login({ ...io, signal }, options); }
      catch { throw failure(signal.aborted ? 'SCRANTON_AUTH_ABORTED' : 'SCRANTON_AUTH_LOGIN', signal.aborted ? 'Sign-in cancelled or timed out' : 'Sign-in failed; try again'); }
    },
    async refresh(c, callerSignal) {
      const signal = AbortSignal.any([callerSignal ?? new AbortController().signal, AbortSignal.timeout(20000)]);
      try { return await adapter.refresh(c, signal); }
      catch (error) {
        if (isRefreshRejection(id, error) || (id === 'google-antigravity' && /^Antigravity token refresh rejected \((400|401)\)$/.test(error.message))) throw rejected(id);
        throw temporary();
      }
    }
  }]));
}
