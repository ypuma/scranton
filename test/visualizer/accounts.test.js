// Subscription sign-in UI logic (.enma/auth-contract.md): /api/auth and /api/models documents, the login
// session the Accounts drawer shows, and the per-role model choice sent with POST /api/runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOGIN_INPUT_MAX, DOCKER_NOTE, REOPEN_MS, parseAuth, parseLogin, loginActive, shouldPoll, nextLogin, loginView, accountView,
  accountsSummary, signOutConfirm, buildLoginInput, buildReopen, parseModels, modelKey, parseModelKey, modelGroups, parseStoredModels,
  resolveChoices, missingNote, storeChoice, buildModels, credentialHint,
  GEMINI_NOTE, KEY_MAX, MODELS_MAX, ABLITERATION_PRESET, API_TYPES, methodsOf, statusLabel, keyNote, buildKey, checkKey, scrubSecret,
  removeKeyConfirm, removeProviderConfirm, parseProviders, otherKeyProviders, slugify, checkBaseUrl, parseModelIds, buildDiscover,
  parseDiscovered, buildProvider, providerErrorField,
} from '../../visualizer/public/js/accounts.js';
import { buildRunRequest, parseControl, errorField } from '../../visualizer/public/js/control.js';
import { getJson } from '../../visualizer/public/js/accounts-panel.js';
import { formatClock } from '../../visualizer/public/js/format.js';
import { postJson } from '../../visualizer/public/js/control-panel.js';

const SIGNED_OUT = [
  { id: 'anthropic', label: 'Claude (Pro/Max)', status: 'signed_out', kind: null },
  { id: 'openai', label: 'ChatGPT', status: 'signed_out', kind: null },
];
const LOGIN = { id: 'L1', provider: 'openai', state: 'waiting_code', authUrl: 'https://auth.openai.com/oauth/authorize?x=1', startedAt: '2026-11-08T12:00:00.000Z' };
const CATALOG = {
  providers: [
    { id: 'anthropic', label: 'Claude (Pro/Max)', signedIn: false, models: [{ id: 'claude-a', name: 'Claude A', reasoning: true, contextWindow: 200000 }] },
    { id: 'openai', label: 'ChatGPT', signedIn: true, models: [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt/b:1', name: 'GPT B' }] },
  ],
};

test('parseAuth: only an auth document counts; unknown statuses never read as signed in', () => {
  for (const bad of [null, 'x', {}, { accounts: 'no' }]) assert.equal(parseAuth(bad), null);
  const a = parseAuth({ accounts: [...SIGNED_OUT, { id: 'Bad Id!', status: 'signed_in' }, { id: 'openai', status: 'signed_in' }, { id: 'x', status: 'weird', kind: 'cookie' }], login: null });
  assert.deepEqual(a.accounts.map((x) => x.id), ['anthropic', 'openai', 'x'], 'invalid ids and duplicates are dropped');
  assert.equal(a.accounts[1].status, 'signed_out', 'the first entry of an id wins');
  assert.equal(a.accounts[2].status, 'error');
  assert.equal(a.accounts[2].kind, null);
  assert.equal(a.login, null);
});

test('parseLogin: server text is scrubbed and only https addresses are shown', () => {
  assert.equal(parseLogin({ id: 'L', state: 'exploded' }), null);
  assert.equal(parseLogin({ state: 'starting' }), null);
  const l = parseLogin({ ...LOGIN, message: 'go \u202Eon', verificationUri: 'javascript:alert(1)', authUrl: 'http://evil.example/' });
  assert.equal(l.message, 'go on');
  assert.equal(l.authUrl, null);
  assert.equal(l.verificationUri, null);
  assert.equal(parseLogin(LOGIN).authUrl, LOGIN.authUrl);
});

test('the drawer polls only while it is open or a login is active', () => {
  assert.equal(shouldPoll({ open: false, login: null }), false);
  assert.equal(shouldPoll({ open: true, login: null }), true);
  for (const state of ['starting', 'waiting_browser', 'waiting_code', 'completing']) assert.equal(shouldPoll({ login: { state } }), true, state);
  for (const state of ['done', 'failed', 'cancelled']) {
    assert.equal(shouldPoll({ login: { state } }), false, state);
    assert.equal(loginActive({ state }), false);
  }
});

test('nextLogin: the server session wins; a dropped session settles from the account status', () => {
  const prev = parseLogin(LOGIN);
  assert.equal(nextLogin({ prev, server: { ...prev, state: 'completing' } }).state, 'completing');
  const signedIn = SIGNED_OUT.map((a) => (a.id === 'openai' ? { ...a, status: 'signed_in', kind: 'oauth' } : a));
  assert.equal(nextLogin({ prev, server: null, accounts: signedIn }).state, 'done');
  const failed = nextLogin({ prev, server: null, accounts: SIGNED_OUT });
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /without a result/);
  assert.equal(nextLogin({ prev, server: null, accounts: SIGNED_OUT, cancelledId: 'L1' }).state, 'cancelled');
  // a result stays until dismissed, also once the server forgets it
  const done = { ...prev, state: 'done' };
  assert.equal(nextLogin({ prev: done, server: null }), done);
  assert.equal(nextLogin({ prev: done, server: done, dismissedId: 'L1' }), null);
  assert.equal(nextLogin({ prev: done, server: null, dismissedId: 'L1' }), null);
  // an ended session from before the page loaded is history; a running one is shown
  assert.equal(nextLogin({ server: done, initial: true }), null);
  assert.equal(nextLogin({ server: prev, initial: true }), prev);
  // a new session replaces a dismissed one
  assert.equal(nextLogin({ prev: null, server: { ...prev, id: 'L2', state: 'starting' }, dismissedId: 'L1' }).id, 'L2');
});

test('loginView: progress text per state; URL while waiting, code input only for waiting_code', () => {
  const v = (state, extra = {}) => loginView(parseLogin({ ...LOGIN, state, ...extra }), SIGNED_OUT);
  assert.match(v('starting').text, /Starting the ChatGPT sign-in/);
  assert.equal(v('waiting_browser').code, false);
  assert.equal(v('waiting_browser').url, LOGIN.authUrl);
  assert.equal(v('waiting_code').code, true);
  assert.equal(v('waiting_code').canCancel, true);
  assert.equal(v('completing').url, null);
  assert.equal(v('done').tone, 'done');
  assert.equal(v('done').finished, true);
  assert.equal(v('done').canCancel, false);
  assert.equal(v('failed', { error: 'invalid_grant' }).text, 'Sign-in to ChatGPT failed: invalid_grant');
  assert.equal(v('failed').tone, 'error');
  assert.match(v('cancelled').text, /cancelled/);
  assert.match(v('waiting_browser', { message: 'Waiting for the callback' }).text, /Waiting for the callback$/);
});

test('accountView: status, kind and the actions per state; one login at a time', () => {
  const v = (a, o) => accountView({ id: 'anthropic', label: 'Claude (Pro/Max)', expiresAt: null, detail: null, ...a }, o);
  assert.deepEqual([v({ status: 'signed_out', kind: null }).signIn, v({ status: 'signed_out', kind: null }).signOut], [true, false]);
  const oauth = v({ status: 'signed_in', kind: 'oauth' });
  assert.deepEqual([oauth.status, oauth.kind, oauth.tone, oauth.signIn, oauth.signOut], ['Signed in', 'OAuth', 'on', false, true]);
  const key = v({ status: 'signed_in', kind: 'api_key' });
  assert.deepEqual([key.kind, key.signIn, key.signOut], ['API key', true, false], 'an API key is not signed out here');
  const expired = v({ status: 'expired', kind: 'oauth' });
  assert.deepEqual([expired.status, expired.tone, expired.signInLabel, expired.signOut], ['Expired', 'loud', 'Sign in again', true]);
  assert.equal(v({ status: 'error', kind: null, detail: 'auth.json is locked' }).detail, 'auth.json is locked');
  assert.equal(v({ status: 'signed_out' }, { busy: true }).signInDisabled, true);
  assert.equal(accountsSummary(parseAuth({ accounts: [SIGNED_OUT[0], { ...SIGNED_OUT[1], status: 'signed_in', kind: 'oauth' }] }).accounts),
    'Claude (Pro/Max): Signed out · ChatGPT: Signed in (OAuth)');
});

test('a renewable OAuth sign-in whose access token expired reads as a calm signed-in row', () => {
  const past = '2026-11-08T20:36:28.000Z';
  const [a] = parseAuth({ accounts: [{ id: 'openai', label: 'ChatGPT', status: 'signed_in', kind: 'oauth', renewsOnUse: true, expiresAt: past }] }).accounts;
  assert.equal(a.renewsOnUse, true);
  const v = accountView(a);
  assert.deepEqual([v.status, v.tone, v.kind, v.signIn, v.signOut], ['Signed in', 'on', 'OAuth', false, true], 'the actions of a signed-in subscription');
  assert.equal(v.detail, 'Subscription sign-in. Renews automatically on next use.');
  assert.ok(!v.detail.includes(formatClock(past)), 'the past access-token expiry is not shown');
  assert.doesNotMatch(v.detail, /expired|Sign in again/);
  assert.equal(accountView({ ...a, renewsOnUse: null }).detail, 'Subscription sign-in, refreshed automatically.', 'an older server keeps its text');
});

test('a failed renewal is loud and asks for a new sign-in; an older expired answer keeps its text', () => {
  const failedAt = '2026-11-08T21:40:05.000Z';
  const [failed, old, bare] = parseAuth({ accounts: [
    { id: 'openai', label: 'ChatGPT', status: 'expired', kind: 'oauth', expiresAt: '2026-11-08T20:36:28.000Z', renewFailedAt: failedAt },
    { id: 'anthropic', status: 'expired', kind: 'oauth', expiresAt: '2026-11-08T20:36:28.000Z' },
    { id: 'x', status: 'expired', kind: 'oauth' },
  ] }).accounts;
  const f = accountView(failed);
  assert.deepEqual([f.status, f.tone, f.signIn, f.signInLabel, f.signOut], ['Expired', 'loud', true, 'Sign in again', true]);
  assert.equal(f.detail, `Renewal failed at ${formatClock(failedAt)}. Sign in again.`);
  assert.equal(accountView(old).detail, `The sign-in expired at ${formatClock('2026-11-08T20:36:28.000Z')}. Sign in again.`);
  assert.equal(accountView(old).tone, 'loud');
  assert.equal(accountView(bare).detail, 'The sign-in expired. Sign in again.');
});

test('a renewable OAuth row offers a quiet Sign in again next to Sign out; a fresh or expired row keeps its actions', () => {
  const past = '2026-11-08T20:36:28.000Z';
  const [renewable, fresh, expired, key, older] = parseAuth({ accounts: [
    { id: 'openai', label: 'ChatGPT', status: 'signed_in', kind: 'oauth', renewsOnUse: true, expiresAt: past },
    { id: 'anthropic', status: 'signed_in', kind: 'oauth', renewsOnUse: false },
    { id: 'x', status: 'expired', kind: 'oauth', methods: ['oauth'], renewFailedAt: past },
    { id: 'y', status: 'signed_in', kind: 'api_key', methods: ['oauth', 'api_key'], renewsOnUse: true },
    { id: 'z', status: 'signed_in', kind: 'oauth', methods: ['oauth'] },
  ] }).accounts;
  const r = accountView(renewable);
  assert.deepEqual([r.signIn, r.signInAgain, r.signOut, r.tone], [false, true, true, 'on'], 'quiet: the loud sign-in stays hidden');
  assert.equal(accountView(renewable, { busy: true }).signInDisabled, true, 'one login at a time');
  const f = accountView(fresh);
  assert.deepEqual([f.signIn, f.signInAgain, f.signOut], [false, false, true], 'a fresh sign-in keeps today\'s actions');
  const e = accountView(expired);
  assert.deepEqual([e.signIn, e.signInLabel, e.signInAgain, e.tone], [true, 'Sign in again', false, 'loud'], 'expired keeps the loud one');
  assert.equal(accountView(key).signInAgain, false, 'an API key signs in with the loud button');
  assert.equal(accountView(older).signInAgain, false, 'an older server without renewsOnUse');
});

test('parseAuth: renewsOnUse only as a boolean, renewFailedAt only as a date; unknown statuses still never read as signed in', () => {
  const at = '2026-11-08T21:40:05.000Z';
  const a = parseAuth({ accounts: [
    { id: 'a1', status: 'signed_in', kind: 'oauth', renewsOnUse: false, renewFailedAt: at },
    { id: 'a2', status: 'signed_in', kind: 'oauth', renewsOnUse: 'true', renewFailedAt: 'yesterday' },
    { id: 'a3', status: 'signed_in', kind: 'oauth', renewsOnUse: 1, renewFailedAt: 1762637405000 },
    { id: 'a4', status: 'renewing', kind: 'oauth', renewsOnUse: true },
    { id: 'a5', status: 'expired', kind: 'oauth', renewFailedAt: '' },
  ] }).accounts;
  assert.deepEqual(a.map((x) => x.renewsOnUse), [false, null, null, true, null]);
  assert.deepEqual(a.map((x) => x.renewFailedAt), [at, null, null, null, null]);
  assert.equal(a[3].status, 'error', 'renewsOnUse does not make an unknown status signed in');
  assert.notEqual(accountView(a[3]).tone, 'on');
  assert.equal(accountView(a[1]).detail, 'Subscription sign-in, refreshed automatically.', 'a dropped renewsOnUse is not trusted');
  assert.equal(accountView(a[4]).detail, 'The sign-in expired. Sign in again.', 'a dropped renewFailedAt keeps the older text');
});

test('sign out confirms and warns while a run is active', () => {
  const a = { id: 'openai', label: 'ChatGPT' };
  assert.doesNotMatch(signOutConfirm(a).detail, /in progress/);
  assert.match(signOutConfirm(a, { runActive: true }).detail, /A run is in progress/);
  assert.equal(signOutConfirm(a).ok, 'Sign out');
});

test('buildLoginInput: only while waiting for a code, trimmed, within 4096 characters', () => {
  const l = parseLogin(LOGIN);
  assert.ok(buildLoginInput('abc', { ...l, state: 'waiting_browser' }).error);
  assert.ok(buildLoginInput('abc', null).error);
  assert.ok(buildLoginInput('   ', l).error);
  assert.ok(buildLoginInput('x'.repeat(LOGIN_INPUT_MAX + 1), l).error);
  assert.deepEqual(buildLoginInput('  http://localhost:1455/auth/callback?code=c&state=s ', l), { body: { id: 'L1', value: 'http://localhost:1455/auth/callback?code=c&state=s' } });
});

test('Open again: only for an active session with an address, and only its id is sent', () => {
  assert.equal(REOPEN_MS, 2000);
  const v = (state, extra = {}) => loginView(parseLogin({ ...LOGIN, state, ...extra }), SIGNED_OUT);
  for (const state of ['starting', 'waiting_browser', 'waiting_code']) assert.equal(v(state).reopen, true, state);
  for (const state of ['completing', 'done', 'failed', 'cancelled']) assert.equal(v(state).reopen, false, state);
  assert.equal(v('waiting_browser', { authUrl: undefined }).reopen, false, 'no address, nothing to open');
  const l = parseLogin({ ...LOGIN, state: 'waiting_browser' });
  assert.deepEqual(buildReopen(l), { body: { id: 'L1' } }, 'the address never leaves the page');
  assert.ok(buildReopen({ ...l, authUrl: null }).error);
  assert.ok(buildReopen({ ...l, state: 'done' }).error);
  assert.ok(buildReopen(null).error);
});

test('every accounts and models request sends X-Scranton-Client (the server answers 403 without it)', async () => {
  const src = readFileSync(new URL('../../visualizer/public/js/accounts-panel.js', import.meta.url), 'utf8');
  assert.equal(src.match(/\bfetch\(/g).length, 1, 'only getJson fetches; everything else goes through getJson / postJson');
  const calls = [...src.matchAll(/\b(getJson|postJson)\('(\/api\/[^']+)'/g)].map((m) => [m[1], m[2]]);
  const urls = [...src.matchAll(/'(\/api\/(?:auth|models|providers)[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(calls.map(([, u]) => u).sort(), [...urls].sort(), 'no /api address is requested any other way');
  for (const u of ['/api/auth', '/api/models', '/api/auth/login', '/api/auth/login/input', '/api/auth/login/cancel', '/api/auth/login/open', '/api/auth/logout',
    '/api/auth/key', '/api/auth/providers', '/api/providers/discover', '/api/providers', '/api/providers/remove']) {
    assert.ok(urls.includes(u), `${u} is requested`);
  }
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    for (const [fn, url] of calls) await (fn === 'getJson' ? getJson(url) : postJson(url, { id: 'L1' }));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, calls.length);
  for (const r of seen) assert.equal(r.headers.get('X-Scranton-Client'), '1', `${r.method} ${r.url}`);
  assert.ok(seen.some((r) => r.method === 'GET') && seen.some((r) => r.method === 'POST'));
});

test('model keys round-trip any model id; groups disable providers without credentials', () => {
  assert.deepEqual(parseModelKey(modelKey('openai', 'gpt/b:1')), { provider: 'openai', model: 'gpt/b:1' });
  for (const bad of ['', 'x', '[1,2]', '["a"]', '{"a":1}']) assert.equal(parseModelKey(bad), null, bad);
  assert.equal(parseModels({}), null);
  const cat = parseModels({ providers: [...CATALOG.providers, { id: 'openai', models: [] }, { id: 'empty', signedIn: true, models: [] }] });
  assert.equal(cat.providers.length, 3, 'duplicates are dropped');
  const groups = modelGroups(cat);
  assert.deepEqual(groups.map((g) => [g.label, g.disabled]), [['Claude (Pro/Max) (signed out)', true], ['ChatGPT', false]], 'empty providers get no group');
  assert.equal(groups[0].options[0].title, 'anthropic/claude-a · 200k context · reasoning');
});

test('stored choices: unknown roles and shapes are dropped; an unavailable choice falls back to pi default with a note', () => {
  assert.deepEqual(parseStoredModels('not json'), {});
  assert.deepEqual(parseStoredModels(JSON.stringify({ dwight: { provider: 'openai', model: 'gpt-a' }, kevin: { provider: 'x', model: 'y' }, angela: { provider: 'openai' } })),
    { dwight: { provider: 'openai', model: 'gpt-a' } });
  const stored = { michael: { provider: 'anthropic', model: 'claude-a' }, dwight: { provider: 'openai', model: 'gpt-a' }, angela: { provider: 'openai', model: 'gone' } };
  const r = resolveChoices(stored, parseModels(CATALOG));
  assert.equal(r.dwight.value, modelKey('openai', 'gpt-a'));
  assert.equal(r.michael.value, '', 'signed-out provider');
  assert.deepEqual(r.michael.missing, stored.michael);
  assert.equal(r.angela.value, '', 'no longer offered');
  assert.match(missingNote(r.angela.missing), /gone is not available/);
  assert.equal(missingNote(null), '');
  assert.deepEqual(storeChoice(stored, 'dwight', ''), { michael: stored.michael, angela: stored.angela });
  assert.deepEqual(storeChoice({}, 'angela', modelKey('openai', 'gpt-a')), { angela: { provider: 'openai', model: 'gpt-a' } });
});

test('buildModels: only roles that are not pi default, and only models of signed-in providers', () => {
  const cat = parseModels(CATALOG);
  assert.deepEqual(buildModels({ michael: '', dwight: '', angela: '' }, cat), { models: {} });
  assert.deepEqual(buildModels({ dwight: modelKey('openai', 'gpt-a') }, cat), { models: { dwight: { provider: 'openai', model: 'gpt-a' } } });
  assert.deepEqual(buildModels({ michael: modelKey('anthropic', 'claude-a') }, cat).field, 'models.michael');
  assert.match(buildModels({ angela: modelKey('openai', 'nope') }, cat).error, /Angela's model/);
  assert.equal(buildModels({ angela: 'garbage' }, cat).field, 'models.angela');
});

test('buildRunRequest sends models for a real run only', () => {
  const c = parseControl({ v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'] });
  const models = { dwight: { provider: 'openai', model: 'gpt-a' } };
  assert.deepEqual(buildRunRequest({ request: 'x', models }, c), { body: { request: 'x', models } });
  assert.deepEqual(buildRunRequest({ request: 'x', models: {} }, c), { body: { request: 'x' } });
  assert.deepEqual(buildRunRequest({ request: '', demo: true, scenario: 'happy', models }, c), { body: { demo: { scenario: 'happy' } } });
});

test('server errors about models point at the model selects', () => {
  assert.equal(errorField('models.dwight: openai/gpt-x is not in the catalog'), 'models.dwight');
  assert.equal(errorField('models: provider anthropic is not signed in'), 'models');
  assert.equal(errorField('workspace: must be absolute'), 'workspace');
});

test('the sign-in hint needs both: no signed-in account and no provider with a key', () => {
  const cat = parseModels(CATALOG);
  assert.equal(credentialHint({}), false, 'nothing known, nothing claimed');
  assert.equal(credentialHint({ accounts: parseAuth({ accounts: SIGNED_OUT }).accounts }), true);
  assert.equal(credentialHint({ accounts: parseAuth({ accounts: SIGNED_OUT }).accounts, catalog: cat }), false, 'openai has a credential');
  assert.equal(credentialHint({ catalog: { providers: [{ ...cat.providers[0] }] } }), true);
  assert.equal(credentialHint({ accounts: [{ id: 'openai', status: 'signed_in', kind: 'api_key' }], catalog: { providers: [] } }), false);
  assert.equal(DOCKER_NOTE, 'Subscriptions are passed to containers as short-lived access tokens.');
});

// ------------------------------------------------------------ API keys and custom providers (addendum 2026-11-08 18:10)

const EXTENDED = [
  { id: 'anthropic', label: 'Claude (Pro/Max)', status: 'signed_out', kind: null, methods: ['oauth', 'api_key'] },
  { id: 'openai', label: 'ChatGPT', status: 'signed_in', kind: 'oauth', methods: ['oauth', 'api_key'] },
  { id: 'google', label: 'Gemini', status: 'signed_out', kind: null, methods: ['api_key'] },
  { id: 'deepseek', label: 'DeepSeek', status: 'signed_in', kind: 'api_key', methods: ['api_key'] },
  { id: 'abliteration', label: 'abliteration.ai', status: 'signed_in', kind: 'api_key', methods: ['api_key'], custom: true, baseUrl: 'https://api.abliteration.ai/v1', api: 'openai-completions' },
];
const SECRET = 'ak_live_0123456789abcdef';

test('parseAuth keeps methods, custom and base URL; an older server without methods keeps its sign-ins', () => {
  const a = parseAuth({ accounts: [...EXTENDED, { id: 'evil', status: 'signed_in', kind: 'api_key', methods: ['cookie'], baseUrl: 'javascript:alert(1)', custom: 'yes' }] }).accounts;
  assert.deepEqual(a.map((x) => x.methods), [['oauth', 'api_key'], ['oauth', 'api_key'], ['api_key'], ['api_key'], ['api_key'], ['api_key']]);
  assert.equal(a[4].custom, true);
  assert.equal(a[4].baseUrl, 'https://api.abliteration.ai/v1');
  assert.equal(a[5].custom, false, 'only true is custom');
  assert.equal(a[5].baseUrl, null, 'only http(s) addresses are shown');
  const old = parseAuth({ accounts: SIGNED_OUT }).accounts;
  assert.deepEqual(old.map((x) => x.methods), [['oauth'], ['oauth']]);
  assert.deepEqual(methodsOf({ id: 'google' }), ['api_key']);
  assert.deepEqual(methodsOf({ id: 'mystery' }), [], 'an unknown provider offers nothing it did not say');
  assert.equal(parseAuth({ accounts: [{ id: 'google', status: 'signed_out' }] }).accounts[0].label, 'Gemini');
});

test('accountView: Claude and ChatGPT offer sign-in and a key, Gemini a key only, custom rows can be removed', () => {
  const [claude, chatgpt, gemini, deepseek, custom] = parseAuth({ accounts: EXTENDED }).accounts;
  const c = accountView(claude);
  assert.deepEqual([c.signIn, c.addKey, c.keyLabel, c.signOut, c.removeKey, c.removeProvider], [true, true, 'Add API key', false, false, false]);
  const o = accountView(chatgpt);
  assert.deepEqual([o.signIn, o.signOut, o.addKey, o.keyLabel], [false, true, true, 'Add API key']);
  const g = accountView(gemini);
  assert.deepEqual([g.status, g.signIn, g.signOut, g.addKey, g.removeKey], ['No key', false, false, true, false]);
  assert.equal(g.detail, GEMINI_NOTE);
  assert.match(GEMINI_NOTE, /^Gemini uses an API key from Google AI Studio\.$/);
  const d = accountView(deepseek);
  assert.deepEqual([d.status, d.kind, d.keyLabel, d.removeKey, d.removeProvider], ['Key set', 'API key', 'Replace key', true, false]);
  const k = accountView(custom);
  assert.deepEqual([k.custom, k.keyLabel, k.removeKey, k.removeProvider, k.signIn], ['Custom', 'Replace key', false, true, false]);
  assert.equal(k.detail, 'OpenAI chat completions · https://api.abliteration.ai/v1');
  const claudeKey = accountView({ ...claude, status: 'signed_in', kind: 'api_key' });
  assert.deepEqual([claudeKey.signIn, claudeKey.keyLabel, claudeKey.removeKey, claudeKey.signOut], [true, 'Replace key', true, false]);
  assert.equal(statusLabel(gemini), 'No key');
  assert.equal(statusLabel(claude), 'Signed out');
  assert.match(accountsSummary([gemini, deepseek]), /^Gemini: No key · DeepSeek: Key set \(API key\)$/);
});

test('keyNote warns before a key replaces a subscription sign-in and says where Gemini keys come from', () => {
  const [claude, chatgpt, gemini, deepseek] = parseAuth({ accounts: EXTENDED }).accounts;
  assert.equal(keyNote(null), '');
  assert.equal(keyNote(claude), '');
  assert.match(keyNote(chatgpt), /replaces the ChatGPT subscription sign-in/);
  assert.match(keyNote(gemini), /Google AI Studio/);
  assert.match(keyNote(deepseek), /replaces the stored DeepSeek key/);
});

test('remove key and remove provider confirm, and warn while a run is active', () => {
  const a = { id: 'abliteration', label: 'abliteration.ai' };
  assert.equal(removeKeyConfirm(a).ok, 'Remove key');
  assert.match(removeKeyConfirm(a).detail, /environment variable is not affected/);
  assert.equal(removeProviderConfirm(a).ok, 'Remove provider');
  assert.match(removeProviderConfirm(a).detail, /never touched/);
  assert.match(removeProviderConfirm(a, { runActive: true }).detail, /A run is in progress/);
  assert.doesNotMatch(removeKeyConfirm(a).detail, /in progress/);
});

test('buildKey: trimmed key and provider only; errors never contain the key', () => {
  assert.deepEqual(buildKey('google', `  ${SECRET}\n`), { body: { provider: 'google', key: SECRET } });
  assert.equal(buildKey('', SECRET).field, 'provider');
  assert.equal(buildKey('Bad Id', SECRET).field, 'provider');
  for (const bad of ['', '   ', `${SECRET} ${SECRET}`, `${SECRET}\nx`, 'k'.repeat(KEY_MAX + 1)]) {
    const r = buildKey('google', bad);
    assert.equal(r.field, 'key', JSON.stringify(bad.slice(0, 20)));
    assert.ok(!r.body);
    if (bad.trim()) assert.ok(!r.error.includes(bad.trim().slice(0, 12)), 'the error does not quote the key');
  }
  assert.deepEqual(checkKey('k'.repeat(KEY_MAX)), { key: 'k'.repeat(KEY_MAX) });
});

test('scrubSecret: a server that quotes the key back never gets it shown', () => {
  assert.equal(scrubSecret(`key: the provider rejected ${SECRET}`, SECRET), 'key: the provider rejected [key]');
  assert.equal(scrubSecret(`${SECRET}${SECRET}`, ` ${SECRET} `), '[key][key]', 'every copy, and the trimmed key that was sent');
  assert.equal(scrubSecret('id: already exists', SECRET), 'id: already exists');
  assert.equal(scrubSecret('rejected abc', 'abc'), 'The server rejected the request.', 'a short key drops the whole message');
  assert.equal(scrubSecret('nothing', ''), 'nothing');
});

test('checkBaseUrl: https, or http only for localhost, 127.0.0.1 and [::1]', () => {
  assert.deepEqual(checkBaseUrl(' https://api.abliteration.ai/v1/ '), { url: 'https://api.abliteration.ai/v1' });
  assert.deepEqual(checkBaseUrl('https://example.com'), { url: 'https://example.com' });
  for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) assert.ok(checkBaseUrl(ok).url, ok);
  for (const bad of ['', 'api.example.com/v1', 'http://example.com/v1', 'http://localhost.evil.example/v1', 'http://127.0.0.2/v1', 'ftp://example.com',
    'javascript:alert(1)', 'https://user:pw@example.com/v1', 'https://example.com/v1?key=x', 'https://example.com/v1#x', `https://example.com/${'a'.repeat(2048)}`]) {
    assert.ok(checkBaseUrl(bad).error, bad.slice(0, 60));
  }
});

test('slugify prefills a valid id from the name; the abliteration.ai preset is complete', () => {
  assert.equal(slugify('abliteration.ai'), 'abliteration-ai');
  assert.equal(slugify('  Résumé  AI!! '), 'resume-ai');
  assert.equal(slugify('42 Labs'), 'labs', 'the id starts with a letter');
  assert.equal(slugify('A'.repeat(40) + ' x'), 'a'.repeat(32));
  assert.equal(slugify('x-'.repeat(20)).length <= 32, true);
  assert.doesNotMatch(slugify('x-'.repeat(20)), /-$/);
  assert.equal(slugify('***'), '');
  assert.deepEqual({ ...ABLITERATION_PRESET }, { label: 'abliteration.ai', id: 'abliteration', baseUrl: 'https://api.abliteration.ai/v1', api: 'openai-completions' });
  assert.deepEqual(API_TYPES.map((t) => t.id), ['openai-completions', 'openai-responses', 'anthropic-messages']);
  const r = buildProvider({ ...ABLITERATION_PRESET, key: SECRET, manual: 'abliterated-model' });
  assert.deepEqual(r.body, { id: 'abliteration', label: 'abliteration.ai', baseUrl: 'https://api.abliteration.ai/v1', api: 'openai-completions', models: [{ id: 'abliterated-model' }], key: SECRET });
});

test('buildDiscover and parseDiscovered: validated request, cleaned model list', () => {
  assert.deepEqual(buildDiscover({ baseUrl: 'https://api.abliteration.ai/v1/', api: 'openai-completions', key: ` ${SECRET} ` }),
    { body: { baseUrl: 'https://api.abliteration.ai/v1', api: 'openai-completions', key: SECRET } });
  assert.equal(buildDiscover({ baseUrl: 'http://example.com', api: 'openai-completions', key: SECRET }).field, 'baseUrl');
  assert.equal(buildDiscover({ baseUrl: 'https://example.com', api: 'google-generative-ai', key: SECRET }).field, 'api');
  assert.equal(buildDiscover({ baseUrl: 'https://example.com', api: 'anthropic-messages', key: '' }).field, 'key');
  assert.equal(parseDiscovered({}), null);
  const d = parseDiscovered({ models: [{ id: 'a', contextWindow: 8192, maxTokens: -1 }, { id: 'a' }, { id: 'has space' }, { id: 'x,y' }, null, { id: 'b', contextWindow: 1.5 }] });
  assert.deepEqual(d, { models: [{ id: 'a', contextWindow: 8192, maxTokens: null }, { id: 'b', contextWindow: null, maxTokens: null }] });
});

test('buildProvider: one error per field in form order, at least one model, exact request body', () => {
  const base = { label: 'Local', id: 'local', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-responses', key: SECRET };
  const field = (f, o) => buildProvider({ ...base, manual: 'm', ...f }, o).field;
  assert.equal(field({ label: ' ' }), 'label');
  assert.equal(field({ label: 'x'.repeat(65) }), 'label');
  for (const id of ['', 'a', 'Local', '1local', 'lo cal', 'local_', 'x'.repeat(33)]) assert.equal(field({ id }), 'id', id);
  assert.equal(field({}, { taken: ['local'] }), 'id', 'an id that is already a provider');
  assert.equal(field({ baseUrl: 'http://192.168.1.4/v1' }), 'baseUrl');
  assert.equal(field({ api: '' }), 'api');
  assert.equal(field({ key: 'a b' }), 'key');
  assert.equal(field({ manual: '' }), 'models');
  assert.equal(field({ manual: 'ok, not\u0007ok' }), 'manual');
  assert.equal(buildProvider({ ...base, discovered: [{ id: 'a' }], checked: [] }).field, 'models', 'fetched but none checked');
  assert.match(buildProvider({ ...base, manual: Array.from({ length: MODELS_MAX + 1 }, (_, i) => `m${i}`).join(',') }).error, /at most 100/);
  const discovered = parseDiscovered({ models: [{ id: 'a', contextWindow: 8192, maxTokens: 2048 }, { id: 'b' }, { id: 'c' }] }).models;
  const r = buildProvider({ ...base, discovered, checked: ['a', 'c', 'gone'], manual: ' c, d ,d  e' });
  assert.deepEqual(r, { body: {
    id: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-responses',
    models: [{ id: 'a', contextWindow: 8192, maxTokens: 2048 }, { id: 'c' }, { id: 'd' }, { id: 'e' }], key: SECRET,
  } });
  for (const f of ['label', 'id', 'baseUrl', 'key', 'manual']) {
    const bad = buildProvider({ ...base, manual: 'm', [f]: f === 'key' ? `${SECRET} x` : '' });
    assert.ok(!bad.error.includes(SECRET.slice(0, 12)), `the ${f} error does not quote the key`);
  }
  assert.deepEqual(parseModelIds('a, b,,a\nc'), ['a', 'b', 'c']);
});

test('server errors point at the provider form field they are about', () => {
  assert.equal(providerErrorField('id: abliteration already exists'), 'id');
  assert.equal(providerErrorField('baseurl: must be https'), 'baseUrl');
  assert.equal(providerErrorField('models: at least one model'), 'models');
  assert.equal(providerErrorField('Could not list models'), null);
  assert.equal(providerErrorField(undefined), null);
});

test('the other-provider picker lists providers that take a key and have no row yet', () => {
  assert.equal(parseProviders({}), null);
  const p = parseProviders({ providers: [
    { id: 'openrouter', label: 'OpenRouter', methods: ['api_key'] }, { id: 'google', label: 'Google', methods: ['api_key'] },
    { id: 'deepseek', label: 'DeepSeek', methods: ['api_key', 'magic'] }, { id: 'github-copilot', label: 'GitHub Copilot', methods: ['oauth'] },
    { id: 'Bad!', methods: ['api_key'] }, { id: 'deepseek', label: 'dupe', methods: [] },
  ] }).providers;
  assert.deepEqual(p.map((x) => x.id), ['openrouter', 'google', 'deepseek', 'github-copilot']);
  assert.deepEqual(p[2].methods, ['api_key']);
  const rows = parseAuth({ accounts: EXTENDED.slice(0, 3) }).accounts;
  assert.deepEqual(otherKeyProviders(p, rows).map((x) => x.id), ['deepseek', 'openrouter'], 'sorted by name; Gemini already has a row; oauth-only is not offered');
});

test('api-key and custom providers show up in the run model pickers under their own labels', () => {
  const cat = parseModels({ providers: [
    { id: 'google', label: 'Gemini', signedIn: true, models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }] },
    { id: 'abliteration', label: 'abliteration.ai', signedIn: true, models: [{ id: 'abliterated-model', contextWindow: 262144 }] },
    { id: 'deepseek', label: 'DeepSeek', signedIn: false, models: [{ id: 'deepseek-chat' }] },
  ] });
  const groups = modelGroups(cat);
  assert.deepEqual(groups.map((g) => [g.label, g.disabled]), [['Gemini', false], ['abliteration.ai', false], ['DeepSeek (signed out)', true]]);
  assert.equal(groups[1].options[0].text, 'abliterated-model', 'a declared model without a name shows its id');
  assert.equal(groups[1].options[0].value, modelKey('abliteration', 'abliterated-model'));
  assert.deepEqual(buildModels({ angela: modelKey('abliteration', 'abliterated-model') }, cat), { models: { angela: { provider: 'abliteration', model: 'abliterated-model' } } });
});

test('key and provider requests send exactly the built body with the control headers', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ error: `key: rejected ${SECRET}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  };
  let r;
  try {
    const key = buildKey('google', SECRET).body;
    r = await postJson('/api/auth/key', key);
    await postJson('/api/providers/discover', buildDiscover({ baseUrl: 'https://api.abliteration.ai/v1', api: 'openai-completions', key: SECRET }).body);
    await postJson('/api/providers', buildProvider({ ...ABLITERATION_PRESET, key: SECRET, manual: 'abliterated-model' }).body);
    await postJson('/api/providers/remove', { id: 'abliteration' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen.map((s) => s.url), ['/api/auth/key', '/api/providers/discover', '/api/providers', '/api/providers/remove']);
  for (const s of seen) {
    assert.equal(s.headers.get('X-Scranton-Client'), '1');
    assert.equal(s.headers.get('Content-Type'), 'application/json');
  }
  assert.deepEqual(seen[0].body, { provider: 'google', key: SECRET });
  assert.deepEqual(Object.keys(seen[1].body), ['baseUrl', 'api', 'key']);
  assert.deepEqual(Object.keys(seen[2].body), ['id', 'label', 'baseUrl', 'api', 'models', 'key']);
  assert.deepEqual(seen[3].body, { id: 'abliteration' });
  assert.equal(r.ok, false);
  assert.equal(scrubSecret(r.error, SECRET), 'key: rejected [key]', 'what the drawer shows of an echoing server');
});

test('a typed key is never retained: no storage, no logging, fields cleared once sent and on close', () => {
  const panel = readFileSync(new URL('../../visualizer/public/js/accounts-panel.js', import.meta.url), 'utf8');
  const logic = readFileSync(new URL('../../visualizer/public/js/accounts.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  for (const [name, src] of [['accounts-panel.js', panel], ['accounts.js', logic]]) {
    // comments may name what the code never does
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\bconsole\.|localStorage|sessionStorage|indexedDB|document\.cookie|\.setAttribute\('value'/, name);
  }
  assert.deepEqual([...panel.matchAll(/store\.set\(([^,]+),/g)].map((m) => m[1]), ['MODELS_KEY'], 'only the model choice is stored');
  for (const id of ['key-input', 'provider-key']) {
    assert.match(html, new RegExp(`<input id="${id}"[^>]*type="password"[^>]*autocomplete="off"`), id);
    assert.doesNotMatch(html, new RegExp(`<input id="${id}"[^>]*\\svalue=`), `${id} has no value attribute`);
  }
  // the only writes to a key field empty it
  for (const field of ['keyInput', 'pKey']) {
    const writes = [...panel.matchAll(new RegExp(`e\\.${field}\\.value\\s*=\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
    assert.ok(writes.length >= 2, `${field} is cleared`);
    assert.ok(writes.every((w) => w === "''"), `${field}: ${writes.join(' | ')}`);
  }
  const submit = (marker) => panel.slice(panel.indexOf(marker), panel.indexOf('await postJson', panel.indexOf(marker)));
  assert.match(submit("e.keyForm.addEventListener('submit'"), /e\.keyInput\.value = '';/, 'the key field is emptied before the request');
  assert.match(submit("e.pForm.addEventListener('submit'"), /e\.pKey\.value = '';/, 'the provider key field is emptied before the request');
  const close = panel.slice(panel.indexOf("e.dialog.addEventListener('close'"), panel.indexOf('schedule();', panel.indexOf("e.dialog.addEventListener('close'")));
  assert.match(close, /closeKey\(\);[\s\S]*closeProvider\(\);/, 'closing the drawer clears both forms');
  // every server error shown after a request that carried a key goes through scrubSecret
  const shown = [...panel.matchAll(/r\.error/g)].length;
  const scrubbed = [...panel.matchAll(/scrubSecret\(r\.error, built\.body\.key\)/g)].length;
  assert.equal(scrubbed, 3, 'key save, model fetch and provider save scrub the key out of server errors');
  assert.ok(shown >= scrubbed);
});
