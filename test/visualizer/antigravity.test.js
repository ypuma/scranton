// Google Antigravity (provider google-antigravity): the Google account sign-in of the Accounts drawer. It uses the
// same /api/auth login, input, open, cancel and logout flow as Claude and ChatGPT, never asks for an API key, and
// leaves the separate Gemini API-key row (google) in place as the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTIGRAVITY, ANTIGRAVITY_NOTE, ANTIGRAVITY_SCOPE, ANTIGRAVITY_CODE_TEXT, ANTIGRAVITY_INPUT_ERROR, DOCKER_NOTE, GEMINI_NOTE, PROVIDER_LABEL, parseAuth,
  parseLogin, parseModels, parseProviders, methodsOf, accountView, loginView, buildLoginInput, signOutConfirm, otherKeyProviders, modelGroups, modelKey, resolveChoices, buildModels, planNote,
} from '../../visualizer/public/js/accounts.js';
import { createAccountsPanel } from '../../visualizer/public/js/accounts-panel.js';
import { installTree, TreeEl } from './fixtures/tree-dom.js';

const ACCOUNTS = [
  { id: 'anthropic', label: 'Claude (Pro/Max)', status: 'signed_out', kind: null, methods: ['oauth', 'api_key'] },
  { id: 'openai', label: 'ChatGPT', status: 'signed_out', kind: null, methods: ['oauth', 'api_key'] },
  { id: 'google-antigravity', label: 'Google Antigravity', status: 'signed_out', kind: null, methods: ['oauth'] },
  { id: 'google', label: 'Gemini', status: 'signed_out', kind: null, methods: ['api_key'] },
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s';
// synthetic: no real sign-in is involved
const REDIRECT = 'http://localhost:51121/oauth-callback?code=4%2F0Ab-synthetic&state=s';
const host = { demo: false, host: true, noPlan: false, configured: null };

test('Google Antigravity is a Google sign-in row: label, OAuth only, no API key, its own note', () => {
  assert.equal(ANTIGRAVITY, 'google-antigravity');
  assert.equal(PROVIDER_LABEL[ANTIGRAVITY], 'Google Antigravity');
  const [a] = parseAuth({ accounts: [{ id: ANTIGRAVITY, status: 'signed_out' }] }).accounts;
  assert.equal(a.label, 'Google Antigravity', 'a server without a label still names it');
  assert.deepEqual(a.methods, ['oauth'], 'a server without methods still offers the sign-in');
  assert.deepEqual(methodsOf({ id: ANTIGRAVITY }), ['oauth']);
  const v = accountView(a);
  assert.deepEqual([v.status, v.signIn, v.signInLabel, v.addKey, v.removeKey, v.signOut], ['Signed out', true, 'Sign in', false, false, false]);
  assert.equal(v.detail, ANTIGRAVITY_NOTE);
  assert.match(ANTIGRAVITY_NOTE, /Google account/);
  assert.match(ANTIGRAVITY_NOTE, /no API key/);
  assert.equal(ANTIGRAVITY_SCOPE, 'Usable in Team and Pipeline runs, whatever the sandbox. The sign-in stays on this computer and is refreshed here; the model calls are made from this computer.');
  assert.ok(ANTIGRAVITY_NOTE.includes(ANTIGRAVITY_SCOPE), 'the row says where the sign-in can be used');
  assert.doesNotMatch(ANTIGRAVITY_NOTE, /not the Docker|not supported|trusted host only/i, 'Docker runs are no longer refused');
  assert.doesNotMatch(ANTIGRAVITY_NOTE, /free|unlimited|quota|every model|all models/i, 'no promise about what the account includes');
  assert.doesNotMatch(ANTIGRAVITY_NOTE, /isolat|never leaves|fully secure|cannot be read/i, 'no promise of absolute isolation');
});

test('Google Antigravity states read as a Google account sign-in; expired and error keep the shared texts', () => {
  const base = { id: ANTIGRAVITY, label: 'Google Antigravity', methods: ['oauth'], detail: null, expiresAt: null, renewFailedAt: null };
  const on = accountView({ ...base, status: 'signed_in', kind: 'oauth', renewsOnUse: false });
  assert.deepEqual([on.status, on.kind, on.tone, on.signIn, on.signOut, on.addKey], ['Signed in', 'OAuth', 'on', false, true, false]);
  assert.equal(on.detail, `Google account sign-in, refreshed automatically. ${ANTIGRAVITY_SCOPE}`);
  assert.match(on.detail, /whatever the sandbox/);
  assert.doesNotMatch(on.detail, /API key|not the Docker/, 'a signed-in row stays a Google sign-in, also for Docker');
  assert.equal(on.addKey, false, 'Docker support adds no key path to this row');
  const renew = accountView({ ...base, status: 'signed_in', kind: 'oauth', renewsOnUse: true });
  assert.equal(renew.detail, `Google account sign-in. Renews automatically on next use. ${ANTIGRAVITY_SCOPE}`);
  assert.equal(renew.signInAgain, true);
  const expired = accountView({ ...base, status: 'expired', kind: 'oauth' });
  assert.deepEqual([expired.status, expired.tone, expired.signInLabel, expired.detail], ['Expired', 'loud', 'Sign in again', 'The sign-in expired. Sign in again.']);
  assert.equal(accountView({ ...base, status: 'error', kind: null }).detail, 'The stored credential could not be read.');
  // Claude and ChatGPT keep their subscription wording
  assert.equal(accountView({ ...base, id: 'openai', label: 'ChatGPT', status: 'signed_in', kind: 'oauth' }).detail, 'Subscription sign-in, refreshed automatically.');
  const c = signOutConfirm({ ...base, status: 'signed_in', kind: 'oauth' });
  assert.equal(c.title, 'Sign out of Google Antigravity?');
  assert.doesNotMatch(c.detail, /API key/, 'there is no key to fall back to on this row');
  assert.match(signOutConfirm({ id: 'openai', label: 'ChatGPT', methods: ['oauth', 'api_key'] }).detail, /new sign-in or an API key/);
  const lv = loginView(parseLogin({ id: 'G1', provider: ANTIGRAVITY, state: 'waiting_browser', authUrl: AUTH_URL }), parseAuth({ accounts: ACCOUNTS }).accounts);
  assert.equal(lv.title, 'Signing in to Google Antigravity');
  assert.equal(lv.url, AUTH_URL);
});

test('the Antigravity manual step asks for the whole redirect address; Claude and ChatGPT keep the code flow', () => {
  const accounts = parseAuth({ accounts: ACCOUNTS }).accounts;
  const g = parseLogin({ id: 'G1', provider: ANTIGRAVITY, state: 'waiting_code', authUrl: AUTH_URL });
  const v = loginView(g, accounts);
  assert.equal(v.code, true);
  assert.equal(v.text, `Finish signing in to Google Antigravity in your browser. ${ANTIGRAVITY_CODE_TEXT}`);
  assert.deepEqual([v.codeLabel, v.codeHint], ['Address of the page after sign-in', 'the whole http://localhost address']);
  for (const t of [v.text, v.codeLabel, v.codeHint, ANTIGRAVITY_INPUT_ERROR]) assert.doesNotMatch(t, /paste the code|authorization code|code or/i, 'no invitation to paste a code alone');
  assert.match(ANTIGRAVITY_CODE_TEXT, /full address.*http:\/\/localhost:.*code=.*state=.*code alone does not work/);

  assert.deepEqual(buildLoginInput(` ${REDIRECT} `, g), { body: { id: 'G1', value: REDIRECT } });
  for (const bad of ['4/0Ab-synthetic', '', 'localhost:51121/oauth-callback?code=c&state=s', 'http://localhost:51121/oauth-callback?code=c',
    'http://localhost:51121/oauth-callback?state=s', 'https://accounts.google.com/?code=c&state=s', 'not a url']) {
    assert.deepEqual(buildLoginInput(bad, g), { error: ANTIGRAVITY_INPUT_ERROR }, bad);
  }

  for (const provider of ['openai', 'anthropic']) {
    const l = parseLogin({ id: 'L1', provider, state: 'waiting_code', authUrl: 'https://auth.example.com/authorize' });
    const o = loginView(l, accounts);
    assert.match(o.text, /paste the code or the full address of that page below\.$/);
    assert.deepEqual([o.codeLabel, o.codeHint], ['Code or page address', 'shown after you sign in']);
    assert.deepEqual(buildLoginInput(' abc-code ', l), { body: { id: 'L1', value: 'abc-code' } }, `${provider} still takes a bare code`);
    assert.equal(buildLoginInput(' ', l).error, 'Paste the code or the address of the page first.');
  }
});

test('the Docker note says the model calls and every credential stay on this computer: only commands run in the container', () => {
  assert.match(DOCKER_NOTE, /^In Docker only the agents' commands run in the container\./);
  assert.match(DOCKER_NOTE, /Model calls, sign-ins and API keys stay on this computer/);
  assert.doesNotMatch(DOCKER_NOTE, /access token|temporary permission|passed as they are|broker/i, 'no credential travels into a container any more');
  assert.doesNotMatch(DOCKER_NOTE, /free|unlimited|quota|every model|isolat|cannot be read/i);
});

test('the Gemini API-key row stays separate: a key only, its own note, and it is not offered under Antigravity', () => {
  const list = parseAuth({ accounts: ACCOUNTS }).accounts;
  const gemini = accountView(list.find((a) => a.id === 'google'));
  assert.deepEqual([gemini.status, gemini.signIn, gemini.addKey, gemini.detail], ['No key', false, true, GEMINI_NOTE]);
  const providers = parseProviders({ providers: [
    { id: ANTIGRAVITY, label: 'Google Antigravity', methods: ['oauth'] }, { id: 'google', label: 'Google', methods: ['api_key'] },
    { id: 'openrouter', label: 'OpenRouter', methods: ['api_key'] },
  ] }).providers;
  assert.deepEqual(otherKeyProviders(providers, list).map((p) => p.id), ['openrouter'], 'neither Google row is offered again in the key picker');
});

test('Google Antigravity models are picked like any other provider\'s and kept apart from Gemini', () => {
  const cat = parseModels({ providers: [
    { id: ANTIGRAVITY, signedIn: true, models: [{ id: 'gemini-x-pro', name: 'Gemini X Pro', reasoning: true }, { id: 'claude-y' }] },
    { id: 'google', label: 'Gemini', signedIn: false, models: [{ id: 'gemini-x-pro', name: 'Gemini X Pro' }] },
  ] });
  const groups = modelGroups(cat);
  assert.deepEqual(groups.map((g) => [g.label, g.disabled]), [['Google Antigravity', false], ['Gemini (signed out)', true]]);
  assert.equal(groups[0].options[0].value, modelKey(ANTIGRAVITY, 'gemini-x-pro'));
  assert.equal(groups[0].options[0].title, 'google-antigravity/gemini-x-pro · reasoning');
  assert.equal(groups[0].options[1].text, 'claude-y');
  const pick = { dwight: modelKey(ANTIGRAVITY, 'gemini-x-pro') };
  assert.deepEqual(buildModels(pick, cat, host), { models: { dwight: { provider: ANTIGRAVITY, model: 'gemini-x-pro' } } });
  assert.match(buildModels({ dwight: modelKey('google', 'gemini-x-pro') }, cat, host).error, /not available/, 'the same model id under Gemini is another choice');
  assert.equal(resolveChoices({ dwight: { provider: ANTIGRAVITY, model: 'gemini-x-pro' } }, cat).dwight.value, pick.dwight);
  assert.match(planNote(cat, [{ id: ANTIGRAVITY, kind: 'oauth', status: 'signed_in' }]), /^Not every listed model is included in every Google Antigravity plan\./);
});

// ------------------------------------------------------------ the Accounts drawer, offline

function drawer() {
  const $ = installTree();
  const make = globalThis.document.createElement;
  // renderRow toggles a class; the tree fake has add/remove only
  globalThis.document.createElement = (tag) => {
    const n = make(tag);
    n.classList.toggle = (c, on) => (on ? n.classList.add(c) : n.classList.remove(c));
    return n;
  };
  const close = new TreeEl('button');
  close.dataset.close = '';
  $('accounts-dialog').append(close);
  $('provider-panel').reset = () => {};
  $('login-panel').append($('login-title'), $('login-code'), $('login-cancel'), $('login-dismiss'), $('login-reopen'));
  $('login-code').append($('login-code-input'), $('login-code-submit'));
  const server = { accounts: ACCOUNTS.map((a) => ({ ...a })), login: null };
  const posts = [];
  const answers = { '/api/auth/login': () => [202, { id: `G${posts.filter((p) => p.url === '/api/auth/login').length}` }] };
  globalThis.fetch = async (url, init = {}) => {
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) });
      const [status, body] = answers[url]?.() ?? [202, { ok: true }];
      return json(status, body);
    }
    if (url === '/api/auth') return json(200, structuredClone(server));
    if (url === '/api/auth/providers') return json(200, { providers: [] });
    return json(404, {});
  };
  const ctl = { on: true };
  const confirms = [];
  const panel = createAccountsPanel({ getControl: () => ({ gates: { on: ctl.on, alive: false } }), confirm: (c) => confirms.push(c) });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await panel.refresh();
  };
  const row = (id) => {
    const li = $('accounts-list').children.find((n) => n.querySelector('button')?.dataset.provider === id);
    if (!li) return null;
    const [head, detail, actions] = li.children;
    const [name, state, kind] = head.children;
    const [signIn, key, again, signOut, unkey, remove] = actions.children;
    return { li, help: li.querySelector('.account-help'), name: name.textContent, state: state.textContent, kind: kind.hidden ? null : kind.textContent, detail: detail.textContent, signIn, key, again, signOut, unkey, remove };
  };
  const stop = () => {
    ctl.on = false;
    panel.render();
  };
  return { $, server, posts, confirms, panel, settle, row, stop };
}

test('drawer: the Antigravity row signs in through the browser flow, never asks for a key, and Gemini keeps its key button', async (t) => {
  const d = drawer();
  t.after(d.stop);
  d.panel.render();
  await d.settle();
  assert.equal(d.panel.open(), true);
  await d.settle();

  const g = d.row(ANTIGRAVITY);
  assert.deepEqual([g.name, g.state, g.kind, g.detail], ['Google Antigravity', 'Signed out', null,
    'Sign in with your Google account, no API key needed. The sign-in stays on this computer and is refreshed here; the model calls are made from this computer.']);
  assert.equal(g.help.tagName, 'DETAILS');
  assert.equal(g.help.open, false);
  assert.equal(g.help.hidden, false);
  assert.equal(g.help.querySelector('summary').textContent, 'Usage and model availability');
  assert.equal(g.help.querySelector('p').textContent, 'Usable in Team and Pipeline runs, whatever the sandbox. Which models you can use depends on that account.');
  assert.ok(!g.help.contains(g.signIn), 'the main action is outside folded guidance');
  assert.ok(!g.help.contains(g.li.querySelector('.account-state')), 'status is not folded');
  g.help.open = true;
  await d.settle();
  assert.equal(d.row(ANTIGRAVITY).help, g.help, 'polling keeps the disclosure node');
  assert.equal(g.help.open, true, 'polling preserves its open state');
  assert.deepEqual([g.signIn.hidden, g.signIn.textContent, g.signIn.getAttribute('aria-label')], [false, 'Sign in', 'Sign in to Google Antigravity']);
  assert.match(g.signIn.className, /\bbtn-primary\b/, 'the sign-in is the row\'s main action');
  assert.deepEqual([g.key.hidden, g.unkey.hidden, g.signOut.hidden, g.remove.hidden], [true, true, true, true], 'no API key on this row');
  const gem = d.row('google');
  assert.deepEqual([gem.name, gem.detail, gem.signIn.hidden, gem.key.hidden, gem.key.textContent], ['Gemini', GEMINI_NOTE, true, false, 'Add API key']);

  await g.signIn.click();
  await d.settle();
  assert.deepEqual(d.posts, [{ url: '/api/auth/login', body: { provider: ANTIGRAVITY } }], 'the same login route as Claude and ChatGPT');
  d.server.login = { id: 'G1', provider: ANTIGRAVITY, state: 'waiting_browser', authUrl: AUTH_URL, startedAt: '2026-11-11T12:00:00.000Z' };
  await d.settle();
  assert.equal(d.$('login-panel').hidden, false);
  assert.equal(d.$('login-title').textContent, 'Signing in to Google Antigravity');
  assert.equal(d.$('login-progress').textContent, 'Finish signing in to Google Antigravity in your browser. This page updates by itself.');
  assert.equal(d.$('login-url').textContent, AUTH_URL);
  assert.equal(d.$('login-code').hidden, true);
  assert.equal(d.$('login-code-label').textContent, 'Address of the page after sign-in');
  assert.equal(d.row(ANTIGRAVITY).signIn.disabled, true, 'one sign-in at a time');
  assert.equal(d.row('google').key.disabled, false, 'the Gemini key is a separate credential and stays usable');

  await d.$('login-reopen').dispatch('click');
  assert.deepEqual(d.posts.at(-1), { url: '/api/auth/login/open', body: { id: 'G1' } }, 'Open again names the session only');

  await d.$('login-cancel').dispatch('click');
  assert.deepEqual(d.posts.at(-1), { url: '/api/auth/login/cancel', body: { id: 'G1' } });
  d.server.login = { ...d.server.login, state: 'cancelled' };
  await d.settle();
  assert.equal(d.$('login-progress').textContent, 'Sign-in to Google Antigravity cancelled. Nothing was changed.');
  assert.equal(d.$('login-dismiss').hidden, false);
  await d.$('login-dismiss').dispatch('click');
  assert.equal(d.$('login-panel').hidden, true);
  assert.equal(d.row(ANTIGRAVITY).signIn.disabled, false, 'a cancelled sign-in can be started again');

  await d.row(ANTIGRAVITY).signIn.click();
  await d.settle();
  assert.deepEqual(d.posts.at(-1), { url: '/api/auth/login', body: { provider: ANTIGRAVITY } });
  d.server.login = { id: 'G2', provider: ANTIGRAVITY, state: 'waiting_code', authUrl: AUTH_URL };
  await d.settle();
  assert.equal(d.$('login-code').hidden, false, 'the pasted redirect address finishes it when the callback does not return');
  assert.equal(d.$('login-progress').textContent, `Finish signing in to Google Antigravity in your browser. ${ANTIGRAVITY_CODE_TEXT}`);
  assert.deepEqual([d.$('login-code-label').textContent, d.$('login-code-hint').textContent], ['Address of the page after sign-in', 'the whole http://localhost address']);
  const sent = d.posts.length;
  d.$('login-code-input').value = ' 4/0Ab-synthetic ';
  await d.$('login-code').dispatch('submit');
  assert.equal(d.posts.length, sent, 'a bare code is not sent');
  assert.deepEqual([d.$('login-code-error').textContent, d.$('login-code-input').getAttribute('aria-invalid')], [ANTIGRAVITY_INPUT_ERROR, 'true']);
  await d.$('login-code-input').dispatch('input');
  assert.equal(d.$('login-code-error').textContent, '', 'typing clears the error');
  d.$('login-code-input').value = ` ${REDIRECT} `;
  await d.$('login-code').dispatch('submit');
  assert.deepEqual(d.posts.at(-1), { url: '/api/auth/login/input', body: { id: 'G2', value: REDIRECT } });

  d.server.login = { ...d.server.login, state: 'done' };
  d.server.accounts = d.server.accounts.map((a) => (a.id === ANTIGRAVITY ? { ...a, status: 'signed_in', kind: 'oauth' } : a));
  await d.settle();
  assert.equal(d.$('login-title').textContent, 'Signed in to Google Antigravity');
  const on = d.row(ANTIGRAVITY);
  assert.deepEqual([on.state, on.kind, on.detail, on.signIn.hidden, on.signOut.hidden, on.key.hidden],
    ['Signed in', 'OAuth', 'Google account sign-in, refreshed automatically. The sign-in stays on this computer and is refreshed here; the model calls are made from this computer.', true, false, true]);
  assert.equal(on.help.hidden, false);
  assert.ok(!on.help.contains(on.signOut));
  d.server.accounts = d.server.accounts.map((a) => a.id === ANTIGRAVITY ? { ...a, status: 'expired', detail: 'Renewal failed. Sign in again.' } : a);
  await d.settle();
  assert.equal(d.row(ANTIGRAVITY).detail, 'Renewal failed. Sign in again.', 'credential errors remain fully visible');
  assert.equal(d.row(ANTIGRAVITY).help.hidden, true, 'no secondary guidance beside an error');

  await on.signOut.click();
  assert.equal(d.confirms.length, 1);
  assert.equal(d.confirms[0].title, 'Sign out of Google Antigravity?');
  await d.confirms[0].action();
  assert.deepEqual(d.posts.at(-1), { url: '/api/auth/logout', body: { provider: ANTIGRAVITY } });

  assert.ok(!d.posts.some((p) => p.url === '/api/auth/key' || 'key' in p.body), 'no request of the Antigravity flow carries a key');
  const gemini = d.row('google');
  assert.deepEqual([gemini.state, gemini.key.hidden], ['No key', false], 'the Gemini fallback is untouched');
});
