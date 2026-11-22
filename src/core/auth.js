import { randomUUID } from 'node:crypto';
import { createCredentials, createCredentialStore, credentialsDirectory, AUTH_PROVIDERS,
  openAuthBrowser, validateAuthUrl, PROVIDER_ENV_NAMES } from './credentials/index.js';
import { validateKey, validateProvider, discoverModels, builtinCatalog } from './providers.js';
import { models } from './llm/catalogue.js';

export { AUTH_PROVIDERS, openAuthBrowser, validateAuthUrl };
const failure = (status, message) => Object.assign(new Error(message), { status });
const terminal = new Set(['done', 'failed', 'cancelled']);
function publicError(error) {
  if (error.status || ['SCRANTON_OAUTH_REJECTED', 'SCRANTON_OAUTH_TEMPORARY', 'SCRANTON_AUTH_MISSING'].includes(error.code)) return error;
  const status = error.code === 'SCRANTON_PROVIDER_CONFLICT' || error.code === 'SCRANTON_CREDENTIAL_LOCKED' ? 409
    : ['SCRANTON_CREDENTIAL_INVALID', 'SCRANTON_PROVIDER_INVALID'].includes(error.code) ? 400 : 500;
  return Object.assign(new Error(status === 500 ? 'Scranton credential operation failed; check the credential store and try again' : error.message), { status, code: error.code });
}

// Kept as an offline catalogue adapter for callers of the old exported seam.
export async function createModelRuntime(options = {}) {
  const auth = createAuthService(options);
  return { getModel: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    getAllModels: () => models, getModels: (provider) => models.filter((m) => m.provider === provider),
    getAvailable: async () => { const available = await auth.listModels(); return available.providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id }))); },
    close: auth.close };
}

export function createAuthService({ env = process.env, dir = credentialsDirectory({ env }), store = createCredentialStore({ dir }),
  opener = openAuthBrowser, timeoutMs, renewalTimeoutMs, now = Date.now, onChange = () => {}, oauth,
  authPath, runtimeFactory } = {}) {
  if (authPath !== undefined || runtimeFactory !== undefined) throw failure(400, 'Pi authPath/runtimeFactory options are no longer supported; use SCRANTON_CREDENTIALS_DIR and OAuth adapters');
  let credentials, initializationError, login = null, loginOperation = null, closed = false, credentialBusy = false;
  const snapshot = () => login ? { ...login } : null;
  const changed = (session) => {
    login = { ...session, id: login?.id ?? session.id };
    try { onChange(snapshot()); } catch {}
  };
  const ready = createCredentials({ env, dir, store, opener, now, onChange: changed,
    ...(oauth ? { oauth } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(renewalTimeoutMs !== undefined ? { renewalTimeoutMs } : {}) })
    .then((value) => (credentials = value)).catch((error) => { initializationError = publicError(error); throw initializationError; });
  // Construction stays synchronous for the CLI and control routes; writes wait for import.
  ready.catch(() => {});
  async function invoke(method, ...args) {
    if (closed) throw failure(409, 'Credential service is closed');
    try { return await (await ready)[method](...args); } catch (error) { throw publicError(error); }
  }
  function listProviders() {
    const custom = Object.values(store.read().providers).map(({ id, label }) => ({ id, label, methods: ['api_key'] }));
    return { providers: [...builtinCatalog.map((p) => ({ id: p.id, label: p.name,
      methods: [...(p.auth.oauth ? ['oauth'] : []), ...(p.auth.apiKey ? ['api_key'] : [])] })),
    ...custom.filter((p) => !builtinCatalog.some((b) => b.id === p.id))] };
  }
  function listAccounts() {
    try {
      if (credentials && !initializationError) {
        const accounts = credentials.listAccounts();
        const catalog = listProviders().providers;
        return accounts.map((p) => ({ ...p, methods: catalog.find((b) => b.id === p.id)?.methods ?? [] }));
      }
      if (initializationError) throw initializationError;
      const data = store.read(), catalog = listProviders().providers;
      return [...new Set([...AUTH_PROVIDERS.map((p) => p.id), ...Object.keys(data.credentials), ...Object.keys(data.providers)])].map((id) => {
        const custom = data.providers[id], c = data.credentials[id];
        const p = { ...(catalog.find((p) => p.id === id) ?? { id, label: id, methods: [] }), ...(custom ? { custom: true, baseUrl: custom.baseUrl, api: custom.api } : {}) };
        if (!Object.hasOwn(data.credentials, id)) return { ...p, status: (PROVIDER_ENV_NAMES[id] ?? []).some((n) => env[n]) ? 'signed_in' : 'signed_out', kind: (PROVIDER_ENV_NAMES[id] ?? []).some((n) => env[n]) ? 'api_key' : null };
        if (c?.type === 'api_key') { try { validateKey(c.key); return { ...p, status: 'signed_in', kind: 'api_key' }; } catch {} }
        if (c?.type === 'oauth' && c.access && c.refresh && Number.isFinite(c.expires) && Math.abs(c.expires) <= 8.64e15) {
          const failed = data.renewals[id], renewFailedAt = failed?.expires === c.expires && Number.isFinite(Date.parse(failed.failedAt)) ? failed.failedAt : undefined;
          return { ...p, status: renewFailedAt ? 'expired' : 'signed_in', kind: 'oauth', expiresAt: new Date(c.expires).toISOString(), renewsOnUse: !renewFailedAt && c.expires <= now(), ...(renewFailedAt ? { renewFailedAt } : {}) };
        }
        return { ...p, status: 'error', kind: null, detail: 'Invalid credential; sign in again' };
      });
    } catch { return AUTH_PROVIDERS.map((p) => ({ ...p, status: 'error', kind: null, detail: 'Cannot read Scranton credential store' })); }
  }
  async function mutate(fn) {
    if (closed || loginOperation || credentialBusy) throw failure(409, 'A credential operation is running or the service is closed');
    credentialBusy = true;
    try { await ready; return await fn(); } catch (error) { throw publicError(error); }
    finally { credentialBusy = false; }
  }
  function startLogin(provider, options) {
    if (!AUTH_PROVIDERS.some((p) => p.id === provider && p.methods.includes('oauth'))) throw failure(400, 'Unknown provider');
    if (closed || loginOperation || credentialBusy) throw failure(409, 'A login is already running or the service is closed');
    login = { id: randomUUID(), provider, state: 'starting', startedAt: new Date(now()).toISOString() };
    const id = login.id;
    loginOperation = (async () => {
      try { const c = await ready; if (closed || login.state === 'cancelled') return snapshot(); c.startLogin(provider, options); changed(await c.waitForLogin()); }
      catch { changed({ ...login, state: 'failed', error: 'Sign-in failed; try again' }); }
      finally { loginOperation = null; }
      return snapshot();
    })();
    return { id };
  }
  function requireSession(id) { if (!login || login.id !== id) throw failure(409, 'Login session is not current'); }
  async function cancel(id) {
    requireSession(id);
    if (terminal.has(login.state)) return;
    if (credentials?.getLogin()) await credentials.cancel(credentials.getLogin().id);
    else changed({ ...login, state: 'cancelled', message: 'Sign-in cancelled' });
    await loginOperation;
  }
  async function listModels() {
    await ready;
    const signedIn = new Set(listAccounts().filter((a) => a.status === 'signed_in').map((a) => a.id));
    const custom = Object.values(store.read().providers);
    const catalog = listProviders().providers;
    return { providers: catalog.filter((p) => signedIn.has(p.id)).map((p) => ({ id: p.id, label: p.label, signedIn: true,
      models: (custom.find((c) => c.id === p.id)?.models ?? models.filter((m) => m.provider === p.id)).map((m) => ({ id: m.id, name: m.name ?? m.id,
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}), ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}) })) })) };
  }
  return { listAccounts, listProviders, listModels, discoverModels, startLogin, getLogin: snapshot,
    waitForLogin: () => loginOperation ?? Promise.resolve(snapshot()),
    input(id, value) { requireSession(id); if (!credentials?.getLogin()) throw failure(409, 'Login is not waiting for input'); return credentials.input(credentials.getLogin().id, value); },
    openLogin(id) { requireSession(id); if (!credentials?.getLogin()) throw failure(409, 'No active sign-in URL'); return credentials.openLogin(credentials.getLogin().id); }, cancel,
    async setApiKey(provider, key) { validateKey(key); if (!listProviders().providers.some((p) => p.id === provider && p.methods.includes('api_key'))) throw failure(400, 'Provider does not support API keys'); if (loginOperation) throw failure(409, 'A credential operation is running'); return mutate(() => credentials.setApiKey(provider, key)); },
    async logout(provider) { if (!listProviders().providers.some((p) => p.id === provider) && !Object.hasOwn(store.read().credentials, provider)) throw failure(400, 'Unknown provider'); return invoke('logout', provider); },
    async addProvider(value) { const { key: raw, ...definition } = value ?? {}; const key = validateKey(raw); validateProvider(definition); if (loginOperation) throw failure(409, 'A credential operation is running'); return mutate(() => store.transaction((data) => {
      if (Object.hasOwn(data.credentials, definition.id) || Object.hasOwn(data.providers, definition.id)) throw Object.assign(failure(409, 'Provider already exists'), { code: 'SCRANTON_PROVIDER_CONFLICT' });
      const safe = validateProvider(definition);
      if (JSON.stringify(safe).includes(key)) throw Object.assign(failure(400, 'Provider metadata must not contain the API key'), { code: 'SCRANTON_PROVIDER_INVALID' });
      data.providers[definition.id] = { id: definition.id, label: safe.name, baseUrl: safe.baseUrl, api: safe.api, models: safe.models };
      data.credentials[definition.id] = { type: 'api_key', key: validateKey(key) };
    })); },
    async removeProvider(id) { await ready; if (!Object.hasOwn(store.read().providers, id)) throw failure(409, 'Provider is not managed by Scranton'); return invoke('removeProvider', id); },
    mintAccessToken: (provider, options) => invoke('mintAccessToken', provider, options),
    checkRenewals(accounts) { if (!closed && !loginOperation && !credentialBusy) ready.then((c) => { if (!closed && !loginOperation && !credentialBusy) c.checkRenewals(accounts); }).catch(() => {}); },
    async close() { closed = true; if (login && !terminal.has(login.state)) await cancel(login.id); const c = await ready.catch(() => null); await c?.close(); }
  };
}
let shared;
export const getAuthService = () => shared ??= createAuthService();
