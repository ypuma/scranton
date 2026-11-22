import { randomUUID } from 'node:crypto';
import { createCredentialStore, credentialsDirectory, failure, validateKey, validateCredential, validateProvider, validId } from './store.js';
import { createOAuthProviders, isRefreshRejection, openAuthBrowser, validateAuthUrl } from './oauth.js';
import { PROVIDER_ENV_NAMES } from './environment.js';

export { createCredentialStore, credentialsDirectory, createOAuthProviders, isRefreshRejection, openAuthBrowser, validateAuthUrl, PROVIDER_ENV_NAMES };
export const AUTH_PROVIDERS = Object.freeze([
  { id: 'anthropic', label: 'Claude (Pro/Max)', methods: ['oauth', 'api_key'] },
  { id: 'openai', label: 'ChatGPT', methods: ['oauth', 'api_key'] },
  { id: 'google', label: 'Gemini', methods: ['api_key'] },
  { id: 'google-antigravity', label: 'Google Antigravity', methods: ['oauth'] },
  { id: 'google-vertex', label: 'Google Vertex AI', methods: ['api_key'] }
]);
export function credentialMode(provider, c) {
  return provider === 'openai' && (c.grantKind === 'codex' || c.accountId) ? { mode: 'chatgpt' }
    : ['direct', 'chatgpt'].includes(c.mode) ? { mode: c.mode } : {};
}
const terminal = new Set(['done', 'failed', 'cancelled']);
const httpFailure = (status, message) => Object.assign(new Error(message), { status });
const builtins = () => [...AUTH_PROVIDERS.map((p) => structuredClone(p)), ...Object.keys(PROVIDER_ENV_NAMES).filter((id) => !AUTH_PROVIDERS.some((p) => p.id === id)).map((id) => ({ id, label: id, methods: ['api_key'] }))];

export async function createCredentials({ env = process.env, dir = credentialsDirectory({ env }), store = createCredentialStore({ dir }),
  oauth = createOAuthProviders(), now = Date.now, minValidityMs = 60000, renewalTimeoutMs = 20000,
  timeoutMs = 10 * 60 * 1000, opener = openAuthBrowser, onChange = () => {} } = {}) {
  if (!Number.isFinite(minValidityMs) || minValidityMs < 0) throw httpFailure(400, 'Invalid token validity');
  await store.initialize({ env });
  let session = null, operation = null, abort, pending, closed = false, keyOperation = false, lastBrowserOpen = -Infinity;
  const renewals = new Map();
  const snapshot = () => session ? { ...session } : null;
  const update = (fields) => { Object.assign(session, fields); try { onChange(snapshot()); } catch {} };
  function listProviders() {
    const custom = Object.values(store.read().providers).map((p) => ({ id: p.id, label: p.label, methods: ['api_key'] }));
    return { providers: [...builtins(), ...custom.filter((p) => !builtins().some((b) => b.id === p.id))] };
  }
  function listAccounts() {
    let data;
    try { data = store.read(); } catch { return AUTH_PROVIDERS.map((p) => ({ ...p, status: 'error', kind: null, detail: 'Cannot read Scranton credential store' })); }
    const catalog = listProviders().providers;
    const ids = new Set([...AUTH_PROVIDERS.map((p) => p.id), ...Object.keys(data.credentials), ...Object.keys(data.providers)]);
    return [...ids].map((id) => {
      const custom = Object.hasOwn(data.providers, id) ? data.providers[id] : undefined;
      const p = { ...(catalog.find((p) => p.id === id) ?? { id, label: id, methods: [] }), ...(custom ? { custom: true, baseUrl: custom.baseUrl, api: custom.api } : {}) };
      const stored = Object.hasOwn(data.credentials, id), credential = data.credentials[id];
      if (!stored) {
        const ambient = (PROVIDER_ENV_NAMES[id] ?? []).some((name) => env[name]);
        return { ...p, status: ambient ? 'signed_in' : 'signed_out', kind: ambient ? 'api_key' : null };
      }
      try { validateCredential(credential); } catch { return { ...p, status: 'error', kind: null, detail: 'Invalid credential; sign in again' }; }
      if (credential.type === 'api_key') return { ...p, status: 'signed_in', kind: 'api_key' };
      const metadata = data.renewals[id];
      const renewFailedAt = metadata?.expires === credential.expires && Number.isFinite(Date.parse(metadata.failedAt)) ? metadata.failedAt : undefined;
      return { ...p, status: renewFailedAt ? 'expired' : 'signed_in', kind: 'oauth', ...credentialMode(id, credential), expiresAt: new Date(credential.expires).toISOString(),
        renewsOnUse: !renewFailedAt && credential.expires <= now(), ...(renewFailedAt ? { renewFailedAt } : {}) };
    });
  }
  function clientAuth(provider, c) {
    if (c.type === 'api_key') return { type: 'api_key', key: c.key };
    if (provider === 'google-antigravity' && (typeof c.projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(c.projectId))) throw failure('SCRANTON_AUTH_MISSING', 'Antigravity project unavailable; sign in again');
    return { type: 'oauth', access: c.access,
      ...(typeof c.accountId === 'string' ? { accountId: c.accountId } : {}),
      ...(typeof c.projectId === 'string' ? { projectId: c.projectId } : {}),
      ...credentialMode(provider, c) };
  }
  async function resolveAuth(provider, { minExpiryMs = minValidityMs, signal } = {}) {
    if (!validId(provider)) throw failure('SCRANTON_CREDENTIAL_INVALID', 'Invalid provider ID');
    if (!Number.isFinite(minExpiryMs) || minExpiryMs < 0) throw httpFailure(400, 'Invalid token validity');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), renewalTimeoutMs);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      const read = store.read();
      if (!Object.hasOwn(read.credentials, provider)) {
        const name = (PROVIDER_ENV_NAMES[provider] ?? []).find((name) => env[name]);
        const key = name ? env[name] : undefined;
        if (!key) throw failure('SCRANTON_AUTH_MISSING', 'Provider credentials unavailable; sign in first');
        return name === 'ANTHROPIC_OAUTH_TOKEN' ? { type: 'oauth', access: validateKey(key) } : { type: 'api_key', key: validateKey(key) };
      }
      validateCredential(read.credentials[provider]);
      const current = read.credentials[provider];
      if (current.type === 'api_key' || current.expires > now() + minExpiryMs) return clientAuth(provider, current);
      const result = await store.transaction(async (data) => {
        let c = data.credentials[provider];
        validateCredential(c);
        // Re-read under the lock: a concurrent refresh, logout or key replacement may have won.
        if (c.type === 'api_key') return clientAuth(provider, c);
        if (c.expires <= now() + minExpiryMs) {
          if (!oauth[provider]) throw failure('SCRANTON_OAUTH_TEMPORARY', 'Provider renewal is unavailable');
          try {
            c = validateCredential(await oauth[provider].refresh(structuredClone(c), combined));
            combined.throwIfAborted();
            data.credentials[provider] = c; delete data.renewals[provider];
          } catch (error) {
            if (isRefreshRejection(provider, error)) {
              data.renewals[provider] = { expires: c.expires, failedAt: new Date(now()).toISOString() };
              return { rejected: true };
            }
            throw failure('SCRANTON_OAUTH_TEMPORARY', 'Sign-in renewal unavailable right now; check the connection or request shorter validity');
          }
        }
        if (c.expires < now() + minExpiryMs) return { insufficient: true };
        return clientAuth(provider, c);
      }, { signal: combined });
      if (result.rejected) throw Object.assign(failure('SCRANTON_OAUTH_REJECTED', 'Sign-in renewal was rejected; sign in again'), { provider });
      if (result.insufficient) throw failure('SCRANTON_OAUTH_TEMPORARY', 'Token validity unavailable; request shorter validity');
      return result;
    } catch (error) {
      if (error.code?.startsWith('SCRANTON_')) throw error;
      throw failure('SCRANTON_OAUTH_TEMPORARY', 'Credential resolution unavailable right now');
    } finally { clearTimeout(timer); }
  }
  async function credentialOperation(fn) {
    if (closed) throw httpFailure(409, 'Credential service is closed');
    if (operation || keyOperation) throw httpFailure(409, 'A credential operation is running');
    keyOperation = true;
    try { return await fn(); } finally { keyOperation = false; }
  }
  function setApiKey(provider, value) {
    const key = validateKey(value);
    if (!listProviders().providers.some((p) => p.id === provider && p.methods.includes('api_key'))) throw httpFailure(400, 'Provider does not support API keys');
    return credentialOperation(() => store.set(provider, { type: 'api_key', key }));
  }
  function addProvider(value) {
    const key = validateKey(value?.key), definition = validateProvider(value);
    if (builtins().some((p) => p.id === definition.id) || definition.id === 'openai-codex') throw httpFailure(400, 'Provider ID is reserved');
    if (JSON.stringify(definition).includes(key)) throw httpFailure(400, 'Provider metadata must not contain the API key');
    return credentialOperation(() => store.transaction((data) => {
      if (Object.hasOwn(data.credentials, definition.id) || Object.hasOwn(data.providers, definition.id)) throw Object.assign(failure('SCRANTON_PROVIDER_CONFLICT', 'Provider already exists'), { status: 409 });
      data.providers[definition.id] = definition; data.credentials[definition.id] = { type: 'api_key', key };
    }));
  }
  function removeProvider(id) {
    return credentialOperation(() => store.transaction((data) => {
      if (!Object.hasOwn(data.providers, id)) throw failure('SCRANTON_PROVIDER_INVALID', 'Provider is not managed by Scranton');
      delete data.providers[id]; delete data.credentials[id]; delete data.renewals[id];
    }));
  }
  function requireSession(id) { if (!session || session.id !== id) throw httpFailure(409, 'Login session is not current'); }
  async function openBrowser() {
    const { provider, authUrl } = session;
    lastBrowserOpen = now();
    try { await opener(provider, authUrl); } catch { throw httpFailure(500, 'Could not open system browser'); }
  }
  function startLogin(provider, { method = 'browser' } = {}) {
    if (closed || operation || keyOperation) throw httpFailure(409, 'A login is already running or the service is closed');
    if (!AUTH_PROVIDERS.some((p) => p.id === provider && p.methods.includes('oauth')) || !oauth[provider]) throw httpFailure(400, 'Unknown OAuth provider');
    if (!['browser', ...(provider === 'openai' ? ['device_code'] : [])].includes(method)) throw httpFailure(400, 'Unsupported sign-in method');
    abort = new AbortController(); const controller = abort;
    session = { id: randomUUID(), provider, state: 'starting', startedAt: new Date(now()).toISOString() };
    lastBrowserOpen = -Infinity;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const io = { signal: controller.signal,
      notify(event) {
        controller.signal.throwIfAborted();
        if (event.type === 'auth_url' || event.type === 'device_code') {
          const url = validateAuthUrl(provider, event.type === 'auth_url' ? event.url : event.verificationUri);
          update({ state: 'waiting_browser', authUrl: url, message: 'Complete sign-in in your browser',
            ...(event.type === 'device_code' ? { userCode: event.userCode, verificationUri: url } : {}) });
          openBrowser().catch(() => {});
        } else if (event.type === 'progress') update({ state: 'completing', message: 'Completing sign-in' });
      },
      prompt(request) {
        const signal = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : [])]);
        return new Promise((resolve, reject) => {
          const finish = (value, error) => { signal.removeEventListener('abort', cancel); if (pending?.finish === finish) pending = null; error ? reject(error) : resolve(value); };
          const cancel = () => finish(null, Error('Login cancelled'));
          pending = { finish };
          signal.addEventListener('abort', cancel, { once: true });
          update({ state: 'waiting_code', message: request.message });
          if (signal.aborted) cancel();
        });
      }
    };
    operation = Promise.resolve().then(async () => {
      try {
        const credential = validateCredential(await oauth[provider].login(io, { method, getDeviceId: () => store.read().deviceId, agentName: 'Scranton' }));
        controller.signal.throwIfAborted();
        await store.set(provider, credential);
        update({ state: 'done', message: 'Signed in' });
      } catch {
        update({ state: controller.signal.aborted && !timedOut ? 'cancelled' : 'failed', message: timedOut ? 'Sign-in timed out' : controller.signal.aborted ? 'Sign-in cancelled' : 'Sign-in failed',
          ...(controller.signal.aborted && !timedOut ? {} : { error: 'Sign-in failed; try again' }) });
      } finally { clearTimeout(timer); pending?.finish(null, Error('Login ended')); operation = null; }
      return snapshot();
    });
    return { id: session.id };
  }
  function input(id, value) {
    requireSession(id);
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw httpFailure(400, 'Input must contain 1 to 4096 characters');
    if (!pending || session.state !== 'waiting_code') throw httpFailure(409, 'Login is not waiting for input');
    update({ state: 'completing', message: 'Completing sign-in' }); pending.finish(value);
  }
  async function cancel(id) { requireSession(id); if (!operation || terminal.has(session.state)) return; abort.abort(); await operation; }
  async function logout(provider) {
    if (!validId(provider)) throw httpFailure(400, 'Unknown provider');
    if (operation && session.provider === provider) await cancel(session.id);
    return credentialOperation(() => store.delete(provider));
  }
  function checkRenewals(accounts = listAccounts()) {
    if (closed || operation || keyOperation) return;
    for (const account of accounts) {
      if (!oauth[account.id] || !account.renewsOnUse) continue;
      const previous = renewals.get(account.id);
      if (previous?.pending || previous && now() - previous.startedAt < 300000) continue;
      const entry = { pending: true, startedAt: now() }; renewals.set(account.id, entry);
      entry.promise = resolveAuth(account.id, { minExpiryMs: 0 }).catch(() => {}).finally(() => { entry.pending = false; });
    }
  }
  return { store, resolveAuth, listAccounts, listProviders, setApiKey, addProvider, removeProvider, startLogin, input, cancel, logout, checkRenewals,
    getLogin: snapshot, waitForLogin: () => operation ?? Promise.resolve(snapshot()),
    openLogin: (id) => { requireSession(id); if (!operation || terminal.has(session.state) || !session.authUrl) throw httpFailure(409, 'No active sign-in URL'); if (now() - lastBrowserOpen < 2000) throw httpFailure(429, 'Wait before opening sign-in again'); return openBrowser(); },
    mintAccessToken: async (provider, { minExpiryMs } = {}) => { if (!Number.isFinite(minExpiryMs) || minExpiryMs < 0) throw httpFailure(400, 'Invalid token validity'); const c = await resolveAuth(provider, { minExpiryMs }); if (c.type !== 'oauth') throw failure('SCRANTON_AUTH_MISSING', 'OAuth credential required'); return c.access; },
    close: async () => { closed = true; if (operation) await cancel(session.id); await Promise.all([...renewals.values()].map((e) => e.promise)); }
  };
}
