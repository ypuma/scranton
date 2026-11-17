import fs from 'node:fs';
import { builtinCatalog, PROVIDER_ENV_NAMES, createProviderStore, validateKey, discoverModels } from './providers.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { sleepSync } from './util.js';
import { antigravityProvider } from './antigravity/provider.js';

export const AUTH_PROVIDERS = Object.freeze([
  { id: 'anthropic', label: 'Claude (Pro/Max)', methods: ['oauth', 'api_key'] },
  { id: 'openai', label: 'ChatGPT', methods: ['oauth', 'api_key'] },
  { id: 'google', label: 'Gemini', methods: ['api_key'] },
  { id: 'google-antigravity', label: 'Google Antigravity', methods: ['oauth'] }
]);
const hosts = { anthropic: ['claude.ai'], openai: ['auth.openai.com'], 'google-antigravity': ['accounts.google.com'] };
const terminal = new Set(['done', 'failed', 'cancelled']);
const failure = (status, message) => Object.assign(new Error(message), { status });
const cancelled = () => new Error('Login cancelled');

export function validateAuthUrl(provider, value) {
  let url;
  try { url = new URL(value); } catch { throw failure(400, 'Invalid sign-in URL'); }
  if (url.protocol !== 'https:' || !hosts[provider]?.includes(url.hostname) || url.username || url.password ||
      (url.port && url.port !== '443') || url.hash || [...url.searchParams.keys()].some((key) => /token|secret/i.test(key))) {
    throw failure(400, 'Untrusted sign-in URL');
  }
  return url.href;
}

function isRefreshRejection(provider, error) {
  const prefix = `OAuth refresh failed for ${provider}: `;
  if (error?.code !== 'oauth' || !error.message?.startsWith(prefix)) return false;
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    const message = typeof cause.message === 'string' ? cause.message.replace(prefix, '') : '';
    if (provider === 'openai' && (
      /^OpenAI OAuth token request failed \((?:400|401)\):/.test(message) ||
      /^Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT\b/.test(message) ||
      /^OpenAI OAuth grant did not include chatgpt\.tokens\.use\.direct\b/.test(message))) return true;
    if (provider === 'google-antigravity' && /^Antigravity token refresh rejected \((?:400|401)\)$/.test(message)) return true;
    if (provider === 'anthropic' && /^Anthropic token refresh request failed\. url=https:\/\/platform\.claude\.com\/v1\/oauth\/token; details=Error: HTTP request failed\. status=(?:400|401);/.test(message)) return true;
  }
  return false;
}

export async function openAuthBrowser(provider, value, { platform = process.platform, runner = spawn } = {}) {
  const url = validateAuthUrl(provider, value);
  const [command, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  await new Promise((resolve, reject) => {
    const child = runner(command, args, { shell: false, windowsHide: true, stdio: 'ignore', detached: true });
    child.once('error', () => reject(new Error('Could not open system browser')));
    child.once('spawn', () => { child.unref(); resolve(); });
  }).catch(() => { throw new Error('Could not open system browser'); });
}

async function defaultRuntime(options) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create(options);
  runtime.registerNativeProvider(antigravityProvider());
  return runtime;
}

export function createModelRuntime({ env = process.env, authPath } = {}) {
  const override = env.PI_CODING_AGENT_DIR;
  const agentDir = override ? path.resolve(override.replace(/^~(?=$|[\\/])/, homedir())) : path.join(homedir(), '.pi', 'agent');
  authPath ??= path.join(agentDir, 'auth.json');
  return defaultRuntime({ authPath, modelsPath: path.join(path.dirname(authPath), 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
}

export function createAuthService({ env = process.env, authPath, runtimeFactory = defaultRuntime,
  opener = openAuthBrowser, timeoutMs = 10 * 60 * 1000, renewalTimeoutMs = 20000, now = Date.now, onChange = () => {} } = {}) {
  const override = env.PI_CODING_AGENT_DIR;
  const agentDir = override ? path.resolve(override.replace(/^~(?=$|[\\/])/, homedir())) : path.join(homedir(), '.pi', 'agent');
  authPath ??= path.join(agentDir, 'auth.json');
  const runtime = () => runtimeFactory({ authPath, modelsPath: path.join(path.dirname(authPath), 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  const providerStore = createProviderStore(path.dirname(authPath));
  const renewalFile = (provider) => path.join(path.dirname(authPath), `scranton-renewal-${encodeURIComponent(provider)}.json`);
  function clearRenewal(provider) { fs.rmSync(renewalFile(provider), { force: true }); }
  function renewalFailure(provider, credential) {
    try {
      const value = JSON.parse(fs.readFileSync(renewalFile(provider), 'utf8'));
      return value.expires === credential.expires && Number.isFinite(Date.parse(value.failedAt)) ? value.failedAt : undefined;
    } catch { return undefined; }
  }
  function markRenewalFailed(provider, credential) {
    if (!credential) return;
    const file = renewalFile(provider), tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ expires: credential.expires, failedAt: new Date(now()).toISOString() }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  const renewals = new Map();
  let closed = false;
  let keyOperation = false;
  let session = null;
  let operation = null;
  let abort = null;
  let pending = null;
  let lastBrowserOpen = -Infinity;
  const snapshot = () => session ? { ...session } : null;
  const update = (fields) => { Object.assign(session, fields); onChange(snapshot()); };
  const providerId = (id) => {
    if (!['anthropic', 'openai', 'google-antigravity'].includes(id)) throw failure(400, 'Unknown provider');
    return id;
  };
  async function store() {
    for (let attempt = 0; ; attempt++) {
      try {
        const value = JSON.parse(fs.readFileSync(authPath, 'utf8').replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
        return value;
      } catch (err) {
        if (err.code === 'ENOENT') return {};
        // Pi truncates under its writer lock; allow a concurrent write to finish.
        if (!(err instanceof SyntaxError) || attempt === 10) throw new Error('Cannot read Pi credential store');
        await sleep(25);
      }
    }
  }
  function listAccounts() {
    let data;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          data = JSON.parse(fs.readFileSync(authPath, 'utf8').replace(/^\uFEFF/, ''));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
          break;
        } catch (err) {
          if (err.code === 'ENOENT') { data = {}; break; }
          if (!(err instanceof SyntaxError) || attempt === 10) throw err;
          sleepSync(25);
        }
      }
    } catch { return AUTH_PROVIDERS.map((p) => ({ ...p, status: 'error', kind: null, detail: 'Cannot read Pi credential store' })); }
    const custom = providerStore.list();
    const catalog = listProviders().providers;
    const ids = new Set([...AUTH_PROVIDERS.map((p) => p.id), ...Object.keys(data), ...custom.map((p) => p.id)]);
    return [...ids].map((id) => {
      const c = custom.find((p) => p.id === id);
      const p = { ...(catalog.find((p) => p.id === id) ?? { id, label: id, methods: [] }), ...(providerStore.getDetail() ? { detail: providerStore.getDetail() } : {}), ...(c ? { custom: true, baseUrl: c.baseUrl, api: c.api } : {}) };
      if (c?.status === 'error') return { ...p, status: 'error', kind: null, detail: c.detail };
      const credential = data[p.id];
      if (credential === null) return { ...p, status: 'error', kind: null };
      const ambient = (PROVIDER_ENV_NAMES[p.id] ?? []).some((name) => env[name]);
      if (!credential) return { ...p, status: ambient ? 'signed_in' : 'signed_out', kind: ambient ? 'api_key' : null };
      if (credential?.type === 'api_key') return { ...p, status: typeof credential.key === 'string' && credential.key ? 'signed_in' : 'error', kind: 'api_key' };
      if (credential?.type !== 'oauth' || !Number.isFinite(credential.expires) || !credential.access || !credential.refresh) return { ...p, status: 'error', kind: null, detail: 'Invalid Pi credential; sign in again' };
      const expiresAt = new Date(credential.expires);
      if (!Number.isFinite(expiresAt.getTime())) return { ...p, status: 'error', kind: null };
      const renewFailedAt = renewalFailure(p.id, credential);
      return { ...p, status: renewFailedAt ? 'expired' : 'signed_in', kind: 'oauth', expiresAt: expiresAt.toISOString(), renewsOnUse: !renewFailedAt && credential.expires <= now(), ...(renewFailedAt ? { renewFailedAt } : {}) };
    });
  }
  function deviceId() {
    const file = path.join(path.dirname(authPath), 'scranton-device-id');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid installation ID');
    return value;
  }
  function startLogin(provider) {
    providerId(provider);
    if (operation || keyOperation) throw failure(409, 'A login is already running');
    abort = new AbortController();
    const controller = abort;
    session = { id: randomUUID(), provider, state: 'starting', startedAt: new Date(now()).toISOString() };
    const id = session.id;
    lastBrowserOpen = -Infinity;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const prompt = async (request) => {
      controller.signal.throwIfAborted();
      if (request.type === 'select') {
        if (!request.options?.some((option) => option.id === 'browser')) throw Error('Unsupported sign-in choice');
        return 'browser';
      }
      if (!['manual_code', 'text', 'secret'].includes(request.type)) throw Error('Unsupported sign-in prompt');
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      return new Promise((resolve, reject) => {
        const finish = (value, err) => {
          signal.removeEventListener('abort', cancel);
          if (pending?.finish === finish) pending = null;
          if (!terminal.has(session.state)) update({ state: 'completing', message: 'Completing sign-in' });
          err ? reject(err) : resolve(value);
        };
        const cancel = () => finish(null, cancelled());
        pending = { finish };
        signal.addEventListener('abort', cancel, { once: true });
        update({ state: 'waiting_code', message: provider === 'google-antigravity' ? 'Complete sign-in in your browser, or paste the complete redirect URL including code and state (not a bare code)' : 'Complete sign-in in your browser, or paste the authorization code / redirect URL' });
        if (signal.aborted) cancel();
      });
    };
    const notify = (event) => {
      controller.signal.throwIfAborted();
      if (event.type === 'auth_url' || event.type === 'device_code') {
        const url = validateAuthUrl(provider, event.type === 'auth_url' ? event.url : event.verificationUri);
        update({ state: 'waiting_browser', authUrl: url, message: 'Complete sign-in in your browser',
          ...(event.type === 'device_code' ? { userCode: event.userCode, verificationUri: url } : {}) });
        // notify is synchronous in Pi; observe opener errors without leaking provider diagnostics.
        openBrowser().catch(() => {});
      } else if (event.type === 'progress') update({ message: 'Completing sign-in' });
    };
    operation = (async () => {
      try {
        const r = await runtime();
        controller.signal.throwIfAborted();
        await r.login(provider, 'oauth', { signal: controller.signal, prompt, notify }, { getDeviceId: deviceId, agentName: 'Scranton' });
        clearRenewal(provider);
        // A successful Pi login has already saved the credential, even after a late abort.
        update({ state: 'done', message: 'Signed in' });
      } catch (error) {
        const setup = provider === 'google-antigravity' && error?.code === 'SCRANTON_ANTIGRAVITY_SETUP';
        update({ state: timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed',
          message: timedOut ? 'Sign-in timed out' : controller.signal.aborted ? 'Sign-in cancelled' : 'Sign-in failed',
          error: timedOut ? 'Sign-in timed out; try again' : controller.signal.aborted ? undefined : setup ? 'Google Antigravity project unavailable; complete account setup in Antigravity and sign in again' : 'Sign-in failed; try again' });
      } finally {
        clearTimeout(timer);
        pending?.finish(null, cancelled());
        operation = null;
      }
      return snapshot();
    })();
    return { id };
  }
  function openBrowser() {
    const { id, provider, authUrl } = session;
    lastBrowserOpen = now();
    return Promise.resolve().then(() => opener(provider, authUrl)).catch(() => {
      if (session.id === id && !terminal.has(session.state)) update({ message: 'Open the sign-in URL in your system browser' });
      throw failure(500, 'Could not open system browser');
    });
  }
  function openLogin(id) {
    requireSession(id);
    if (!operation || terminal.has(session.state) || !session.authUrl) throw failure(409, 'No active sign-in URL');
    if (now() - lastBrowserOpen < 2000) throw failure(429, 'Wait before opening sign-in again');
    return openBrowser();
  }
  function requireSession(id) { if (!session || session.id !== id) throw failure(409, 'Login session is not current'); }
  function input(id, value) {
    requireSession(id);
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw failure(400, 'Input must contain 1 to 4096 characters');
    if (session.state !== 'waiting_code' || !pending) throw failure(409, 'Login is not waiting for input');
    pending.finish(value);
  }
  async function cancel(id) {
    requireSession(id);
    if (!operation || terminal.has(session.state)) return;
    abort.abort();
    await operation;
  }
  async function logout(provider) {
    if (!(await listProviders()).providers.some((p) => p.id === provider) && !Object.hasOwn(await store(), provider)) throw failure(400, 'Unknown provider');
    if (keyOperation) throw failure(409, 'A credential operation is running');
    if (operation && session.provider === provider) await cancel(session.id);
    try { await store(); await (await runtime()).logout(provider); clearRenewal(provider); } catch { throw failure(500, 'Could not sign out of Pi'); }
  }
  function listProviders() {
    const custom = providerStore.list().map(({ id, label, methods }) => ({ id, label, methods }));
    return { providers: [...builtinCatalog.filter((p) => p.id !== 'openai-codex').map((p) => ({ id: p.id,
      label: AUTH_PROVIDERS.find((a) => a.id === p.id)?.label ?? p.name ?? p.id,
      methods: [...(p.auth.oauth ? ['oauth'] : []), ...(p.auth.apiKey?.login ? ['api_key'] : [])] })).filter((p) => p.methods.length), AUTH_PROVIDERS.find((p) => p.id === 'google-antigravity'), ...custom] };
  }
  async function saveKey(provider, key) {
    const r = await runtime();
    try {
      await r.login(provider, 'api_key', { signal: new AbortController().signal, notify: () => {}, prompt: async (request) => {
        if (request.type === 'secret') return key;
        if (request.type === 'text' && provider.startsWith('cloudflare-')) {
          const name = request.message?.includes('Gateway') ? 'CLOUDFLARE_GATEWAY_ID' : 'CLOUDFLARE_ACCOUNT_ID';
          const value = env[name] ?? (await store())[provider]?.env?.[name];
          if (typeof value === 'string' && value && value !== key) return value;
          throw Error('Cloudflare account/gateway metadata is required');
        }
        if (request.type === 'select' && request.options?.some((o) => o.id === 'api-key')) return 'api-key';
        if (request.type === 'select' && request.options?.some((o) => o.id === 'bearer-token')) return 'bearer-token';
        throw Error();
      } });
      clearRenewal(provider);
    } catch { throw failure(500, 'Could not store Pi API key'); }
  }
  async function setApiKey(provider, value) {
    const key = validateKey(value);
    if (!(await listProviders()).providers.some((p) => p.id === provider && p.methods.includes('api_key'))) throw failure(400, 'Provider does not support API keys');
    if (operation || keyOperation) throw failure(409, 'A credential operation is running');
    keyOperation = true;
    try { await store(); await saveKey(provider, key); } finally { keyOperation = false; }
  }
  async function addProvider(value) {
    const { key: raw, ...definition } = value;
    const key = validateKey(raw);
    if (JSON.stringify(definition).includes(key)) throw failure(400, 'Provider metadata must not contain the API key');
    if (operation || keyOperation) throw failure(409, 'A credential operation is running');
    keyOperation = true;
    try {
      await store();
      await providerStore.add(definition, async () => {
        try {
          await saveKey(definition.id, key);
          await (await runtime()).refresh({ allowNetwork: false });
        } catch {
          try { await (await runtime()).logout(definition.id); } catch {}
          throw failure(500, 'Could not add provider; check configuration and try again');
        }
      }, async (managed) => {
        const exists = Object.hasOwn(await store(), definition.id);
        if (exists && !managed) throw failure(409, 'Provider ID already has a credential not managed by Scranton');
        return !exists;
      });
    } finally { keyOperation = false; }
  }
  async function removeProvider(id) {
    if (operation || keyOperation) throw failure(409, 'A credential operation is running');
    keyOperation = true;
    try {
      await store();
      await providerStore.remove(id, async () => { await (await runtime()).logout(id); });
      await (await runtime()).refresh({ allowNetwork: false });
    } catch (e) { if (e.status) throw e; throw failure(500, 'Could not remove provider'); }
    finally { keyOperation = false; }
  }
  async function resolveDockerCredential(provider, { minExpiryMs } = {}) {
    if (provider === 'google-antigravity') throw new Error('Google Antigravity credentials stay on the host; Docker must use the run-scoped inference broker.');
    try {
      const data = await store();
      const custom = providerStore.list().find((p) => p.id === provider);
      if (custom?.status === 'error') throw Error();
      const credential = data[provider];
      if (credential?.type === 'oauth') {
        const name = provider === 'anthropic' ? 'ANTHROPIC_OAUTH_TOKEN' : provider === 'openai' ? 'OPENAI_API_KEY' : null;
        if (!name) throw Error();
        return { name, value: await mintAccessToken(provider, { minExpiryMs }) };
      }
      const name = custom ? 'SCRANTON_PROVIDER_' + provider.toUpperCase().replaceAll('-', '_') + '_KEY' : PROVIDER_ENV_NAMES[provider]?.[0];
      if (!name) throw Error();
      if (Object.hasOwn(data, provider) && credential?.type !== 'api_key') throw Error();
      const value = credential?.type === 'api_key' ? credential.key : (PROVIDER_ENV_NAMES[provider] ?? []).map((n) => env[n]).find(Boolean);
      if (typeof value !== 'string' || !value || /^[!$]/.test(value)) throw Error();
      if (custom && JSON.stringify(custom).includes(value)) throw Error();
      const extraEnv = {};
      if (provider.startsWith('cloudflare-')) {
        for (const field of ['CLOUDFLARE_ACCOUNT_ID', ...(provider === 'cloudflare-ai-gateway' ? ['CLOUDFLARE_GATEWAY_ID'] : [])]) {
          const metadata = credential?.env?.[field] ?? env[field];
          if (typeof metadata !== 'string' || !metadata || metadata === value) throw Error();
          extraEnv[field] = metadata;
        }
      }
      return { name, value, extraEnv, ...(custom ? { models: { providers: { [provider]: { name: custom.label, baseUrl: custom.baseUrl, api: custom.api, models: custom.models, authHeader: true, apiKey: '$' + name } } } } : {}) };
    } catch (err) {
      if (err.code === 'SCRANTON_OAUTH_TEMPORARY' || err.code === 'SCRANTON_OAUTH_REJECTED') throw err;
      throw new Error('Provider credential unavailable; sign in again before launching Docker');
    }
  }
  async function listModels() {
    try {
      const r = await runtime();
      const models = await r.getAvailable();
      const catalog = (await listProviders()).providers;
      const providers = [];
      for (const model of models) {
        if (model.provider === 'openai-codex') continue;
        let entry = providers.find((p) => p.id === model.provider);
        if (!entry) { entry = { id: model.provider, label: catalog.find((p) => p.id === model.provider)?.label ?? model.provider, signedIn: true, models: [] }; providers.push(entry); }
        entry.models.push({ id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow });
      }
      return { providers };
    } catch { throw failure(500, 'Could not list Pi models'); }
  }
  async function mintAccessToken(provider, { minExpiryMs } = {}) {
    providerId(provider);
    if (!Number.isFinite(minExpiryMs) || minExpiryMs < 0) throw failure(400, 'Invalid token validity');
    let credential;
    let attempted = false;
    const controller = new AbortController();
    let timer;
    try {
      credential = (await store())[provider];
      if (credential?.type !== 'oauth') throw Error();
      const result = await Promise.race([
        (async () => {
          const r = await runtime();
          controller.signal.throwIfAborted();
          attempted = true;
          return r.getAuth(provider, { minOAuthValidityMs: minExpiryMs, signal: controller.signal });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Renewal timed out')); }, renewalTimeoutMs); })
      ]);
      if (result?.source !== 'OAuth' || typeof result.auth?.apiKey !== 'string' || !result.auth.apiKey) throw Error();
      clearRenewal(provider);
      return result.auth.apiKey;
    } catch (err) {
      // Pi's ModelsError uses code and appends provider diagnostics to its message.
      const rejected = attempted && isRefreshRejection(provider, err);
      if (rejected) {
        try {
          const current = (await store())[provider];
          if (current?.type === 'oauth' && current.expires === credential.expires && current.refresh === credential.refresh && current.access === credential.access) markRenewalFailed(provider, current);
        } catch {}
      }
      const label = AUTH_PROVIDERS.find((p) => p.id === provider).label;
      throw Object.assign(new Error(rejected ? `${label} sign-in renewal was rejected; sign in again`
        : `Could not renew the ${label} sign-in right now; check the connection and try again (or request a shorter token validity)`),
      { code: rejected ? 'SCRANTON_OAUTH_REJECTED' : 'SCRANTON_OAUTH_TEMPORARY' });
    } finally { clearTimeout(timer); }
  }
  function checkRenewals(accounts) {
    if (closed || operation || keyOperation) return;
    for (const account of accounts) {
      if (!['anthropic', 'openai', 'google-antigravity'].includes(account.id) || !account.renewsOnUse) continue;
      const previous = renewals.get(account.id);
      if (previous?.pending || previous && now() - previous.startedAt < 5 * 60 * 1000) continue;
      const entry = { startedAt: now(), pending: true };
      renewals.set(account.id, entry);
      entry.promise = mintAccessToken(account.id, { minExpiryMs: 0 }).catch(() => {}).finally(() => { entry.pending = false; });
    }
  }
  return { checkRenewals, listAccounts, listProviders, setApiKey, addProvider, removeProvider, discoverModels, resolveDockerCredential, listModels, startLogin, openLogin, input, cancel, logout, mintAccessToken, getLogin: snapshot,
    waitForLogin: () => operation ?? Promise.resolve(snapshot()), close: async () => { closed = true; if (operation) await cancel(session.id); await Promise.all([...renewals.values()].map((entry) => entry.promise)); } };
}

let shared;
export const getAuthService = () => shared ??= createAuthService();
