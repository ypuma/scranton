// Pure logic of sign-in, API keys and custom providers (.enma/auth-contract.md, control routes /api/auth,
// /api/providers and /api/models): the account and login documents, what the Accounts drawer says per state,
// the key and provider requests, and the per-role model choice of the New run drawer. No DOM, so Node can test
// it. The API never returns token or key values; a key typed here only ever travels in one request body.
import { stripBidi, formatClock } from './format.js';
import { AGENT_IDS, LEGACY_GATES, ROLE_ID_RE, own, theName } from './state.js';

export const PROVIDER_LABEL = { anthropic: 'Claude (Pro/Max)', openai: 'ChatGPT', 'google-antigravity': 'Google Antigravity', google: 'Gemini' };
export const ACCOUNT_STATUSES = ['signed_in', 'signed_out', 'expired', 'error'];
export const STATUS_LABEL = { signed_in: 'Signed in', signed_out: 'Signed out', expired: 'Expired', error: 'Error' };
// a provider without a sign-in only has a key or none
export const KEY_STATUS_LABEL = { signed_in: 'Key set', signed_out: 'No key', expired: 'Expired', error: 'Error' };
export const KIND_LABEL = { oauth: 'OAuth', api_key: 'API key' };
export const AUTH_METHODS = ['oauth', 'api_key'];
// an older server sends no methods: its two accounts are subscription sign-ins
const DEFAULT_METHODS = { anthropic: ['oauth'], openai: ['oauth'], 'google-antigravity': ['oauth'], google: ['api_key'] };
export const GEMINI_NOTE = 'Gemini uses an API key from Google AI Studio.';
export const ANTIGRAVITY = 'google-antigravity';
// the Google sign-in; what it may use is up to Google, so nothing here promises models or quota. Model calls are made
// on the host in every sandbox, so the credential never leaves it.
export const ANTIGRAVITY_SCOPE = 'Usable in Team and Pipeline runs, whatever the sandbox. The sign-in stays on this computer and is refreshed here; the model calls are made from this computer.';
export const ANTIGRAVITY_NOTE = `Sign in with your Google account, no API key needed. ${ANTIGRAVITY_SCOPE} Which models you can use depends on that account.`;
export const KEY_MAX = 4096;
export const LOGIN_STATES = ['starting', 'waiting_browser', 'waiting_code', 'completing', 'done', 'failed', 'cancelled'];
export const LOGIN_TERMINAL = new Set(['done', 'failed', 'cancelled']);
export const LOGIN_INPUT_MAX = 4096;
// Antigravity takes only the whole loopback redirect (its state is checked), never a code on its own
export const ANTIGRAVITY_CODE_TEXT = 'If this page does not update, copy the full address from the browser\'s address bar once Google has sent you on (it starts with http://localhost: and contains code= and state=) and paste it below. The code alone does not work.';
export const ANTIGRAVITY_INPUT_ERROR = 'Paste the full address from the browser\'s address bar, starting with http://localhost: and containing code= and state=. The code alone does not work.';
export const AUTH_POLL_MS = 1000;
// the server opens the sign-in page again at most once per 2 s
export const REOPEN_MS = 2000;
export const MODEL_ROLES = AGENT_IDS;
export const MODELS_KEY = 'scranton.models';
// Scranton's own runtime calls the models on the host; a container only runs the agents' commands
export const DOCKER_NOTE = 'In Docker only the agents\' commands run in the container. Model calls, sign-ins and API keys stay on this computer and are never passed into it.';
export const AUTOMATIC = 'Automatic';
// the fixed order of .enma/agent-stream-contract.md (Model and compaction policy)
export const AUTOMATIC_ORDER = 'Claude, ChatGPT, Gemini, Google Antigravity';
export const AUTOMATIC_NOTE = `Agent default is the model set for the agent in the Agents drawer, scranton.config.json or SCRANTON_<ROLE>_PROVIDER and SCRANTON_<ROLE>_MODEL. A role without one runs on Automatic: the first signed-in account in this order: ${AUTOMATIC_ORDER}.`;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const str = (v) => (typeof v === 'string' ? stripBidi(v) : '');
// only shown as text, never followed: still nothing but an https address is shown as one
const https = (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v) ? stripBidi(v) : null);
const raw = (v) => (typeof v === 'string' ? v : '');
const date = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? stripBidi(v) : null);

export function methodsOf(a) {
  const m = Array.isArray(a?.methods) ? AUTH_METHODS.filter((x) => a.methods.includes(x)) : [];
  if (m.length) return m;
  return DEFAULT_METHODS[a?.id] ?? (a?.kind === 'api_key' || a?.custom === true ? ['api_key'] : []);
}

function parseAccount(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ID_RE.test(a.id)) return null;
  const kind = a.kind === 'oauth' || a.kind === 'api_key' ? a.kind : null;
  return {
    id: a.id,
    label: str(a.label) || PROVIDER_LABEL[a.id] || a.id,
    // a status this page does not know is not reported as signed in
    status: ACCOUNT_STATUSES.includes(a.status) ? a.status : 'error',
    kind,
    methods: methodsOf({ id: a.id, kind, custom: a.custom, methods: a.methods }),
    custom: a.custom === true,
    baseUrl: typeof a.baseUrl === 'string' && /^https?:\/\/[^\s]+$/i.test(a.baseUrl) ? stripBidi(a.baseUrl) : null,
    api: str(a.api) || null,
    expiresAt: str(a.expiresAt) || null,
    // Scranton renews an expired access token with the refresh token on the next model call
    renewsOnUse: typeof a.renewsOnUse === 'boolean' ? a.renewsOnUse : null,
    renewFailedAt: date(a.renewFailedAt),
    detail: str(a.detail) || null,
  };
}

export function parseLogin(l) {
  if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !l.id || !LOGIN_STATES.includes(l.state)) return null;
  return {
    id: l.id,
    provider: typeof l.provider === 'string' && ID_RE.test(l.provider) ? l.provider : '',
    state: l.state,
    authUrl: https(l.authUrl),
    userCode: str(l.userCode) || null,
    verificationUri: https(l.verificationUri),
    message: str(l.message) || null,
    error: str(l.error) || null,
    startedAt: str(l.startedAt) || null,
  };
}

// GET /api/auth -> { accounts, login } or null when the answer is not an auth document
export function parseAuth(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.accounts)) return null;
  const seen = new Set();
  const accounts = doc.accounts.map(parseAccount).filter((a) => a && !seen.has(a.id) && seen.add(a.id));
  return { accounts, login: parseLogin(doc.login) };
}

export function loginActive(login) {
  return Boolean(login) && !LOGIN_TERMINAL.has(login.state);
}

// The drawer polls every second while it is open or a login runs; otherwise not at all.
export function shouldPoll({ open = false, login = null }) {
  return open || loginActive(login);
}

function labelOf(accounts, provider) {
  return accounts?.find((a) => a.id === provider)?.label ?? PROVIDER_LABEL[provider] ?? provider ?? 'the provider';
}

// The session the drawer shows after a poll. prev = what it showed, server = parsed login (or null).
// A server that drops a session once it ends leaves its outcome to the account status; a result stays until
// the human dismisses it (dismissedId). initial = the page's first answer, where an ended session is history.
export function nextLogin({ prev = null, server = null, accounts = [], cancelledId = null, dismissedId = null, initial = false }) {
  if (server) return (initial || server.id === dismissedId) && LOGIN_TERMINAL.has(server.state) ? null : server;
  if (!prev || prev.id === dismissedId) return null;
  if (LOGIN_TERMINAL.has(prev.state)) return prev;
  if (prev.id === cancelledId) return { ...prev, state: 'cancelled' };
  if (accounts.find((a) => a.id === prev.provider)?.status === 'signed_in') return { ...prev, state: 'done' };
  return { ...prev, state: 'failed', error: prev.error ?? 'The sign-in ended without a result. Check the account status and try again.' };
}

// -> { title, text, tone: 'busy' | 'done' | 'error' | '', url, reopen, code, codeLabel, codeHint, canCancel, finished }
export function loginView(login, accounts = []) {
  const label = labelOf(accounts, login.provider);
  const reason = login.error || login.message || 'no reason given';
  const url = login.state === 'waiting_browser' || login.state === 'waiting_code' || login.state === 'starting' ? login.authUrl : null;
  const view = {
    title: `Signing in to ${label}`,
    text: '',
    tone: 'busy',
    url,
    reopen: Boolean(url) && loginActive(login),
    code: login.state === 'waiting_code',
    codeLabel: login.provider === ANTIGRAVITY ? 'Address of the page after sign-in' : 'Code or page address',
    codeHint: login.provider === ANTIGRAVITY ? 'the whole http://localhost address' : 'shown after you sign in',
    canCancel: loginActive(login),
    finished: LOGIN_TERMINAL.has(login.state),
  };
  switch (login.state) {
    case 'starting':
      view.text = `Starting the ${label} sign-in...`;
      break;
    case 'waiting_browser':
      view.text = `Finish signing in to ${label} in your browser. This page updates by itself.`;
      break;
    case 'waiting_code':
      view.text = login.provider === ANTIGRAVITY
        ? `Finish signing in to ${label} in your browser. ${ANTIGRAVITY_CODE_TEXT}`
        : `Finish signing in to ${label} in your browser. If the page shows a code or does not return here, paste the code or the full address of that page below.`;
      break;
    case 'completing':
      view.text = `Finishing the ${label} sign-in...`;
      break;
    case 'done':
      Object.assign(view, { title: `Signed in to ${label}`, text: `Signed in to ${label}. New runs can use its models.`, tone: 'done' });
      break;
    case 'failed':
      Object.assign(view, { title: `Sign-in to ${label} failed`, text: `Sign-in to ${label} failed: ${reason}`, tone: 'error' });
      break;
    default:
      Object.assign(view, { title: `Sign-in to ${label} cancelled`, text: `Sign-in to ${label} cancelled. Nothing was changed.`, tone: '' });
  }
  if (view.tone === 'busy' && login.message) view.text = `${view.text} ${login.message}`;
  return view;
}

export function statusLabel(a) {
  return (methodsOf(a).includes('oauth') ? STATUS_LABEL : KEY_STATUS_LABEL)[a.status];
}

const signInKind = (a) => (a.id === ANTIGRAVITY ? 'Google account sign-in' : 'Subscription sign-in');

// What one Accounts row shows. busy = some login is running (one at a time).
// -> { status, tone, kind, custom, detail, signIn, signInLabel, signInDisabled, signOut, addKey, keyLabel, removeKey, removeProvider }
export function accountView(a, { busy = false } = {}) {
  const methods = methodsOf(a);
  const tone = a.status === 'signed_in' ? 'on' : a.status === 'expired' || a.status === 'error' ? 'loud' : '';
  const oauth = a.kind === 'oauth';
  const keyed = a.kind === 'api_key' && a.status !== 'signed_out';
  let detail = a.detail ?? '';
  if (!detail) {
    if (a.status === 'expired' && a.renewFailedAt) detail = `Renewal failed at ${formatClock(a.renewFailedAt)}. Sign in again.`;
    else if (a.status === 'expired') detail = a.expiresAt ? `The sign-in expired at ${formatClock(a.expiresAt)}. Sign in again.` : 'The sign-in expired. Sign in again.';
    else if (a.status === 'error') detail = 'The stored credential could not be read.';
    else if (a.custom) detail = [apiLabel(a.api), a.baseUrl].filter(Boolean).join(' · ');
    else if (a.id === 'google') detail = GEMINI_NOTE;
    else if (a.id === ANTIGRAVITY && a.status === 'signed_out') detail = ANTIGRAVITY_NOTE;
    else if (a.status === 'signed_in' && a.kind === 'api_key') detail = methods.includes('oauth') ? 'Uses an API key. Sign in to use your subscription.' : 'Uses an API key.';
    // the past expiresAt of a renewable sign-in is not a problem, so it is not shown
    else if (a.status === 'signed_in' && oauth && a.renewsOnUse === true) detail = `${signInKind(a)}. Renews automatically on next use.`;
    else if (a.status === 'signed_in') detail = `${signInKind(a)}, refreshed automatically.`;
    if (a.id === ANTIGRAVITY && a.status === 'signed_in') detail = `${detail} ${ANTIGRAVITY_SCOPE}`;
  }
  return {
    status: statusLabel(a),
    tone,
    kind: KIND_LABEL[a.kind] ?? null,
    custom: a.custom ? 'Custom' : null,
    detail,
    signIn: methods.includes('oauth') && !(a.status === 'signed_in' && oauth),
    signInLabel: a.status === 'expired' ? 'Sign in again' : 'Sign in',
    // a refresh token that cannot be used any more still reads as renewable until the next model call: no sign-out needed
    signInAgain: a.status === 'signed_in' && oauth && a.renewsOnUse === true && methods.includes('oauth'),
    signInDisabled: busy,
    signOut: oauth && a.status !== 'signed_out',
    addKey: methods.includes('api_key'),
    keyLabel: keyed ? 'Replace key' : 'Add API key',
    // a key Scranton does not store (e.g. from the environment) is reported without api_key in methods: nothing to remove
    removeKey: keyed && !a.custom && methods.includes('api_key'),
    removeProvider: Boolean(a.custom),
  };
}

export function accountsSummary(accounts) {
  return accounts.map((a) => `${a.label}: ${statusLabel(a)}${a.kind ? ` (${KIND_LABEL[a.kind]})` : ''}`).join(' · ');
}

export function signOutConfirm(a, { runActive = false } = {}) {
  const detail = `Removes the ${a.label} sign-in from Scranton's credentials on this computer. Runs need a new sign-in${methodsOf(a).includes('api_key') ? ' or an API key' : ''} to use it again.`;
  return {
    title: `Sign out of ${a.label}?`,
    detail: runActive ? `${detail} A run is in progress: its agents that use ${a.label} fail at their next model call.` : detail,
    ok: 'Sign out',
  };
}

export function removeKeyConfirm(a, { runActive = false } = {}) {
  const detail = `Removes the ${a.label} API key from Scranton's credentials on this computer. A key set in an environment variable is not affected.`;
  return {
    title: `Remove the ${a.label} API key?`,
    detail: runActive ? `${detail} A run is in progress: its agents that use ${a.label} fail at their next model call.` : detail,
    ok: 'Remove key',
  };
}

export function removeProviderConfirm(a, { runActive = false } = {}) {
  const detail = `Removes ${a.label} from Scranton's provider configuration and deletes its stored API key.`;
  return {
    title: `Remove provider ${a.label}?`,
    detail: runActive ? `${detail} A run is in progress: its agents that use ${a.label} fail at their next model call.` : detail,
    ok: 'Remove provider',
  };
}

// -> { body } or { error }
export function buildLoginInput(value, login) {
  if (!login || login.state !== 'waiting_code') return { error: 'The sign-in is not waiting for a code any more.' };
  const v = raw(value).trim();
  if (!v) return { error: login.provider === ANTIGRAVITY ? ANTIGRAVITY_INPUT_ERROR : 'Paste the code or the address of the page first.' };
  if (v.length > LOGIN_INPUT_MAX) return { error: `That is ${v.length} characters; the limit is ${LOGIN_INPUT_MAX}.` };
  // only the shape is checked here; the server checks the exact callback and state
  if (login.provider === ANTIGRAVITY && !isRedirect(v)) return { error: ANTIGRAVITY_INPUT_ERROR };
  return { body: { id: login.id, value: v } };
}

function isRedirect(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && Boolean(u.searchParams.get('code')) && Boolean(u.searchParams.get('state'));
  } catch {
    return false;
  }
}

// POST /api/auth/login/open names the session only: the server opens the address it got from the provider.
// -> { body } or { error }
export function buildReopen(login) {
  if (!loginActive(login) || !login.authUrl) return { error: 'This sign-in has no page to open any more.' };
  return { body: { id: login.id } };
}

// ------------------------------------------------------------ API keys and custom providers

export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const API_TYPES = [
  { id: 'openai-completions', label: 'OpenAI chat completions' },
  { id: 'openai-responses', label: 'OpenAI responses' },
  { id: 'anthropic-messages', label: 'Anthropic messages' },
];
export const ABLITERATION_PRESET = Object.freeze({ label: 'abliteration.ai', id: 'abliteration', baseUrl: 'https://api.abliteration.ai/v1', api: 'openai-completions' });
export const LABEL_MAX = 64;
export const URL_MAX = 2048;
export const MODELS_MAX = 100;
const DISCOVER_MAX = 500;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MODEL_ID_RE = /^[\x21-\x2b\x2d-\x7e]{1,200}$/;
const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export function apiLabel(api) {
  return API_TYPES.find((t) => t.id === api)?.label ?? (api || '');
}

// Server text about a request that carried a key: a server that quotes the key back never gets it shown.
export function scrubSecret(text, secret) {
  const t = String(text ?? '');
  const s = raw(secret).trim();
  if (!s || !t.includes(s)) return t;
  // a short value would mangle the message; drop the message instead
  return s.length >= 8 ? t.split(s).join('[key]') : 'The server rejected the request.';
}

// -> { key } or { error }; the error never contains the value
export function checkKey(value) {
  const v = raw(value).trim();
  if (!v) return { error: 'Enter the API key first.' };
  if (v.length > KEY_MAX) return { error: `An API key has at most ${KEY_MAX} characters.` };
  if (/\s/.test(v)) return { error: 'An API key has no spaces or line breaks. Paste it again.' };
  return { key: v };
}

// POST /api/auth/key -> { body } or { error, field }
export function buildKey(provider, value) {
  if (typeof provider !== 'string' || !ID_RE.test(provider)) return { error: 'Pick a provider first.', field: 'provider' };
  const k = checkKey(value);
  return k.error ? { error: k.error, field: 'key' } : { body: { provider, key: k.key } };
}

// What the key form says above the field for an account (or '' for a provider picked from the list).
export function keyNote(a) {
  if (!a) return '';
  if (a.id === 'google') return `${GEMINI_NOTE} A stored key takes precedence over GEMINI_API_KEY in the environment.`;
  if (a.kind === 'oauth' && a.status !== 'signed_out') return `Saving a key replaces the ${a.label} subscription sign-in on this computer.`;
  if (a.kind === 'api_key' && a.status !== 'signed_out') return `The new key replaces the stored ${a.label} key.`;
  return '';
}

// GET /api/auth/providers -> { providers: [{ id, label, methods }] } or null
export function parseProviders(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.providers)) return null;
  const providers = [];
  for (const p of doc.providers) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id) || providers.some((q) => q.id === p.id)) continue;
    const methods = Array.isArray(p.methods) ? AUTH_METHODS.filter((m) => p.methods.includes(m)) : [];
    providers.push({ id: p.id, label: str(p.label) || PROVIDER_LABEL[p.id] || p.id, methods });
  }
  return { providers };
}

// The "another provider" picker: providers that take a key and have no row yet.
export function otherKeyProviders(providers, accounts = []) {
  return (providers ?? [])
    .filter((p) => p.methods.includes('api_key') && !accounts.some((a) => a.id === p.id))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Lowercase letters, digits and dashes, a letter first: what PROVIDER_ID_RE accepts (once 2+ long).
export function slugify(label) {
  return raw(label).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
}

// -> { url } (no trailing slash) or { error }
export function checkBaseUrl(text) {
  const v = raw(text).trim();
  if (!v) return { error: 'Enter the base URL of the API, for example https://api.example.com/v1.' };
  if (v.length > URL_MAX) return { error: `The base URL has at most ${URL_MAX} characters.` };
  let u;
  try {
    u = new URL(v);
  } catch {
    return { error: 'That is not a URL. It starts with https://.' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) {
    return { error: 'The base URL must use https:// (http:// only for localhost, 127.0.0.1 or [::1]).' };
  }
  if (u.username || u.password) return { error: 'Put the key in the API key field, not in the URL.' };
  if (u.search || u.hash) return { error: 'The base URL has no query or fragment (? or #).' };
  return { url: u.href.replace(/\/+$/, '') };
}

// Model ids typed by hand: comma (or space) separated, duplicates dropped.
export function parseModelIds(text) {
  return [...new Set(raw(text).split(/[\s,]+/).filter(Boolean))];
}

// POST /api/providers/discover -> { body } or { error, field }
export function buildDiscover({ baseUrl, api, key } = {}) {
  const u = checkBaseUrl(baseUrl);
  if (u.error) return { error: u.error, field: 'baseUrl' };
  if (!API_TYPES.some((t) => t.id === api)) return { error: 'Pick the API type.', field: 'api' };
  const k = checkKey(key);
  if (k.error) return { error: k.error, field: 'key' };
  return { body: { baseUrl: u.url, api, key: k.key } };
}

// The discover answer -> { models: [{ id, contextWindow, maxTokens }] } or null
export function parseDiscovered(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) return null;
  const models = [];
  for (const m of doc.models) {
    if (!m || typeof m.id !== 'string' || !MODEL_ID_RE.test(m.id) || models.some((n) => n.id === m.id)) continue;
    models.push({ id: m.id, contextWindow: posInt(m.contextWindow), maxTokens: posInt(m.maxTokens) });
    if (models.length >= DISCOVER_MAX) break;
  }
  return { models };
}

// The custom provider form -> POST /api/providers { body } or { error, field }.
// f = { label, id, baseUrl, api, key, discovered: [models], checked: [ids], manual: text }; taken = ids in use.
export function buildProvider(f = {}, { taken = [] } = {}) {
  const label = str(f.label).trim();
  if (!label) return { error: 'Give the provider a name.', field: 'label' };
  if (label.length > LABEL_MAX) return { error: `The name has at most ${LABEL_MAX} characters.`, field: 'label' };
  const id = raw(f.id).trim();
  if (!PROVIDER_ID_RE.test(id)) return { error: 'The id is 2-32 characters: a lowercase letter, then lowercase letters, digits or dashes.', field: 'id' };
  if (taken.includes(id)) return { error: `The id ${id} is already used by another provider. Pick another one.`, field: 'id' };
  const d = buildDiscover(f);
  if (d.error) return d;
  const found = new Map((f.discovered ?? []).map((m) => [m.id, m]));
  const models = [];
  for (const mid of f.checked ?? []) if (found.has(mid) && !models.some((m) => m.id === mid)) models.push(found.get(mid));
  const manual = parseModelIds(f.manual);
  const bad = manual.find((m) => !MODEL_ID_RE.test(m));
  if (bad !== undefined) return { error: 'A model id is 1-200 visible characters without commas or spaces.', field: 'manual' };
  for (const mid of manual) if (!models.some((m) => m.id === mid)) models.push({ id: mid });
  if (!models.length) return { error: 'Pick at least one model, or enter model ids separated by commas.', field: 'models' };
  if (models.length > MODELS_MAX) return { error: `Pick at most ${MODELS_MAX} models.`, field: 'models' };
  return {
    body: {
      id, label, baseUrl: d.body.baseUrl, api: d.body.api,
      models: models.map((m) => Object.fromEntries(Object.entries({ id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens }).filter(([, v]) => v != null))),
      key: d.body.key,
    },
  };
}

// "id: already exists" -> 'id'; which form field a server message is about
export function providerErrorField(message) {
  const m = /^\s*(label|id|baseUrl|api|key|models)\b/i.exec(typeof message === 'string' ? message : '');
  return m ? ['label', 'id', 'baseUrl', 'api', 'key', 'models'].find((f) => f.toLowerCase() === m[1].toLowerCase()) : null;
}

// ------------------------------------------------------------ models

// GET /api/models -> { providers } or null
export function parseModels(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.providers)) return null;
  const providers = [];
  for (const p of doc.providers) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID_RE.test(p.id) || providers.some((q) => q.id === p.id)) continue;
    const models = (Array.isArray(p.models) ? p.models : [])
      .filter((m) => m && typeof m.id === 'string' && m.id && m.id.length <= 200)
      .map((m) => ({
        id: m.id,
        name: str(m.name) || stripBidi(m.id),
        reasoning: m.reasoning === true,
        contextWindow: Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : null,
      }));
    providers.push({ id: p.id, label: str(p.label) || PROVIDER_LABEL[p.id] || p.id, signedIn: p.signedIn === true, models });
  }
  return { providers };
}

// A select value: '' is the role's default (its agent default, else Automatic). JSON so model ids with any punctuation round-trip.
export function modelKey(provider, model) {
  return JSON.stringify([provider, model]);
}

export function parseModelKey(value) {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) && v.length === 2 && v.every((s) => typeof s === 'string' && s) ? { provider: v[0], model: v[1] } : null;
  } catch {
    return null;
  }
}

function findModel(catalog, choice) {
  const p = catalog?.providers.find((q) => q.id === choice?.provider);
  const m = p?.models.find((n) => n.id === choice.model);
  return p && m ? { provider: p, model: m } : null;
}

// <optgroup>s for a role select; a provider without credentials is shown but cannot be picked.
// -> [{ label, disabled, options: [{ value, text, title }] }]
export function modelGroups(catalog) {
  return (catalog?.providers ?? []).filter((p) => p.models.length).map((p) => ({
    label: p.signedIn ? p.label : `${p.label} (signed out)`,
    disabled: !p.signedIn,
    options: p.models.map((m) => ({
      value: modelKey(p.id, m.id),
      text: m.name,
      title: [`${p.id}/${m.id}`, m.contextWindow && `${Math.round(m.contextWindow / 1000)}k context`, m.reasoning && 'reasoning'].filter(Boolean).join(' · '),
    })),
  }));
}

// localStorage text -> { role: { provider, model } } with valid roles only. roles: the roles to keep, or null for
// any custom agent id too (the picker keeps a choice for an agent the server has not listed yet).
export function parseStoredModels(text, roles = MODEL_ROLES) {
  let v = null;
  try {
    v = JSON.parse(text ?? 'null');
  } catch {
    return {};
  }
  const out = {};
  if (!v || typeof v !== 'object') return out;
  const keys = roles ?? Object.keys(v).filter((k) => ROLE_ID_RE.test(k));
  for (const role of keys) {
    const c = Object.hasOwn(v, role) ? v[role] : null;
    if (c && typeof c.provider === 'string' && c.provider && typeof c.model === 'string' && c.model) out[role] = { provider: c.provider, model: c.model };
  }
  return out;
}

// What each select shows for the stored choices. -> { role: { value, missing: { provider, model } | null } }
export function resolveChoices(stored, catalog, roles = MODEL_ROLES) {
  const out = {};
  for (const role of roles) {
    const c = stored ? own(stored, role) : null;
    const hit = c ? findModel(catalog, c) : null;
    out[role] = hit && hit.provider.signedIn ? { value: modelKey(c.provider, c.model), missing: null } : { value: '', missing: c ?? null };
  }
  return out;
}

export function missingNote(missing) {
  return missing ? `Saved choice ${missing.model} is not available right now (signed out or no longer offered); the default is used.` : '';
}

// The stored choices after a select changed.
export function storeChoice(stored, role, value) {
  const next = { ...stored };
  const c = parseModelKey(value);
  if (c) next[role] = c;
  else delete next[role];
  return next;
}

// The roles a run starts: the built-ins in pipeline order, then its custom gates in stage order; without a plan
// the planner has nothing to do (the server checks the same list). gates = the run's workflow stages; none given is
// the engine default, the tests alone.
export function runRoles({ noPlan = false, gates = LEGACY_GATES } = {}) {
  const used = new Set([...(noPlan ? [] : ['michael']), 'dwight', ...gates.flat()]);
  return [...MODEL_ROLES, ...gates.flat().filter((r) => !MODEL_ROLES.includes(r))].filter((r) => used.has(r));
}

// "the Developer"; a custom agent by the name the catalog gives it
const roleLabel = (role, names) => (AGENT_IDS.includes(role) ? theName(role) : (names ? own(names, role) : undefined) ?? role);

// The default option of a role select: what that role will actually use. configured = GET /api/control
// defaults.models (null: not reported); a role without an agent default runs on Automatic, in every sandbox.
export function defaultLabel(configured, role) {
  const c = configured ? own(configured, role) : null;
  return c ? `Agent default (${c.provider}/${c.model})` : AUTOMATIC;
}

// A subscription lists every model of its provider, but a plan may not include them all.
export function planNote(catalog, accounts) {
  const plans = (catalog?.providers ?? [])
    .filter((p) => p.signedIn && p.models.length && (accounts ?? []).some((a) => a.id === p.id && a.kind === 'oauth' && a.status === 'signed_in'))
    .map((p) => (p.id === 'openai' ? 'ChatGPT' : p.id === 'anthropic' ? 'Claude' : p.label));
  if (!plans.length) return '';
  return `Not every listed model is included in every ${plans.join(' or ')} plan. If a run reports a permission error, pick another model.`;
}

// values = { role: select value }, run = { demo, noPlan, gates, names } of the run to start (none: every role).
// The model calls stay on this computer in every sandbox, so a pick holds for each of them.
// -> { models } (only the roles that are not on their default; with gates, only the roles the run uses) or { error, field }
export function buildModels(values, catalog, run = null) {
  if (run?.demo) return { models: {} };
  const models = {};
  const roles = run?.gates ? runRoles({ noPlan: run.noPlan, gates: run.gates }) : MODEL_ROLES;
  for (const role of roles) {
    const v = own(values ?? {}, role) ?? '';
    if (!v) continue;
    const c = parseModelKey(v);
    const hit = c ? findModel(catalog, c) : null;
    if (!hit || !hit.provider.signedIn) {
      return { error: `The model picked for ${roleLabel(role, run?.names)} is not available any more. Pick another one or the default.`, field: `models.${role}` };
    }
    models[role] = { provider: c.provider, model: c.model };
  }
  return { models };
}

// Nobody signed in and no provider has a key: a run has no model to use. Unknown data claims nothing.
export function credentialHint({ accounts = null, catalog = null }) {
  if (!accounts && !catalog) return false;
  return !(accounts ?? []).some((a) => a.status === 'signed_in') && !(catalog?.providers ?? []).some((p) => p.signedIn);
}

// The empty states of a fresh installation lead to Accounts: only where its panel can open and, as the New run note
// decides it, nobody is signed in and no provider has a key. panel: the Accounts panel (accounts-panel.js) or null;
// catalog: the model list the New run drawer read last, or null.
export const accountsMissing = (panel, catalog = null) => Boolean(panel?.available()) && credentialHint({ accounts: panel.accounts(), catalog });
