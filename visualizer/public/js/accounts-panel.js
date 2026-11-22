// Sign-in, API keys and custom providers (.enma/auth-contract.md): the Accounts drawer behind the top-bar button,
// and the per-role model picker of the New run drawer. Invisible unless the control API is on and the server
// answers /api/auth. The server opens the sign-in page itself; this page shows its address and can only ask the
// server to open it again. A typed key lives in its password field until it is sent, never anywhere else.
import {
  AUTH_POLL_MS, REOPEN_MS, MODEL_ROLES, MODELS_KEY, DOCKER_NOTE, AUTOMATIC_NOTE, LOGIN_INPUT_MAX, API_TYPES, ABLITERATION_PRESET,
  parseAuth, loginActive, shouldPoll, nextLogin, loginView, accountView, accountsSummary, signOutConfirm, buildLoginInput, buildReopen,
  removeKeyConfirm, removeProviderConfirm, buildKey, keyNote, scrubSecret, parseProviders, otherKeyProviders, slugify,
  buildDiscover, parseDiscovered, buildProvider, providerErrorField,
  parseModels, modelGroups, parseStoredModels, resolveChoices, missingNote, storeChoice, buildModels, credentialHint, defaultLabel, planNote,
  runRoles,
} from './accounts.js';
import { CLIENT_HEADERS } from './control.js';
import { postJson, store } from './control-panel.js';
import { plural } from './format.js';
import { shortcut } from './platform.js';

const $ = (id) => document.getElementById(id);
const COPIED_MS = 2500;
const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// undefined = no answer (network), null = the server has no such route (older server or control off)
export async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', headers: CLIENT_HEADERS });
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    return await r.json().catch(() => undefined);
  } catch {
    return undefined;
  }
}

export function createAccountsPanel({ getControl, confirm, onChange }) {
  const e = {
    open: $('accounts-open'), mark: $('accounts-mark'), openState: $('accounts-open-state'),
    dialog: $('accounts-dialog'), error: $('accounts-error'), empty: $('accounts-empty'), list: $('accounts-list'), foot: $('accounts-foot'),
    login: $('login-panel'), loginMark: $('login-mark'), loginTitle: $('login-title'), progress: $('login-progress'),
    urlRow: $('login-url-row'), url: $('login-url'), copy: $('login-copy'), copyStatus: $('login-copy-status'), device: $('login-device'),
    reopen: $('login-reopen'), reopenStatus: $('login-reopen-status'),
    codeForm: $('login-code'), codeLabel: $('login-code-label'), codeHint: $('login-code-hint'), codeInput: $('login-code-input'), codeSubmit: $('login-code-submit'), codeError: $('login-code-error'),
    cancel: $('login-cancel'), dismiss: $('login-dismiss'), announcer: $('control-announcer'), status: $('accounts-status'),
    add: $('accounts-add'), keyOther: $('key-other'), providerAdd: $('provider-add'),
    keyForm: $('key-panel'), keyTitle: $('key-title'), keyProviderRow: $('key-provider-row'), keyProvider: $('key-provider'),
    keyProviderStatus: $('key-provider-status'), keyNote: $('key-note'), keyInput: $('key-input'), keyError: $('key-error'),
    keySubmit: $('key-submit'), keyCancel: $('key-cancel'),
    pForm: $('provider-panel'), pTitle: $('provider-title'), pPreset: $('provider-preset'), pLabel: $('provider-label'), pId: $('provider-id'),
    pUrl: $('provider-url'), pApi: $('provider-api'), pKey: $('provider-key'), pFetch: $('provider-fetch'), pFetchStatus: $('provider-fetch-status'),
    pModels: $('provider-models'), pModelList: $('provider-model-list'), pAll: $('provider-all'), pManualLabel: $('provider-manual-label'),
    pManual: $('provider-manual'), pError: $('provider-error'), pStatus: $('provider-status'), pSubmit: $('provider-submit'), pCancel: $('provider-cancel'),
  };
  // 'unknown' until the first answer, 'no' when the server has no /api/auth
  let support = 'unknown';
  let auth = null;
  let shown = null;
  let busy = false;
  let cancelledId = null;
  let dismissedId = null;
  let timer = 0;
  let inflight = null;
  let opener = null;
  let fallback = null;
  let wasOn = false;
  let changeKey = '';
  let copyTimer = 0;
  let reopenUntil = 0;
  let reopenTimer = 0;
  let reopenFor = null;
  // the key form: null (closed), { provider } for a row, { provider: null } for the "another provider" picker
  let keyFor = null;
  // GET /api/auth/providers: undefined = not asked yet or no answer, null = the server has no such route
  let providers;
  let providersLoading = false;
  let idEdited = false;
  let discovered = null;
  const rows = new Map();

  const on = () => Boolean(getControl()?.gates.on);
  const accounts = () => auth?.accounts ?? [];
  const say = (text) => { e.announcer.textContent = text; };

  function setText(node, text, tone) {
    if (node.textContent !== text) node.textContent = text;
    if (tone !== undefined && node.dataset.tone !== tone) node.dataset.tone = tone;
  }

  // ------------------------------------------------------------ polling
  function schedule() {
    clearTimeout(timer);
    if (on() && support !== 'no' && shouldPoll({ open: e.dialog.open, login: shown })) timer = setTimeout(refresh, AUTH_POLL_MS);
  }

  function refresh() {
    if (inflight) return inflight;
    clearTimeout(timer);
    inflight = getJson('/api/auth').then((doc) => {
      inflight = null;
      if (doc === null) {
        support = 'no';
        auth = null;
      } else if (doc !== undefined && parseAuth(doc)) {
        const prev = shown;
        const initial = support !== 'yes';
        support = 'yes';
        auth = parseAuth(doc);
        shown = nextLogin({ prev, server: auth.login, accounts: auth.accounts, cancelledId, dismissedId, initial });
        announceEnd(prev, shown);
        e.error.hidden = true;
      } else if (e.dialog.open) {
        e.error.textContent = 'The account status could not be loaded. Retrying...';
        e.error.hidden = false;
      }
      render();
      schedule();
    });
    return inflight;
  }

  // the drawer's live region says it while open; with the drawer closed the page announcer does
  function announceEnd(prev, next) {
    if (e.dialog.open || !next || loginActive(next) || prev?.id !== next.id || !loginActive(prev)) return;
    say(loginView(next, accounts()).text);
  }

  // ------------------------------------------------------------ rendering
  function render() {
    const enabled = on();
    if (!enabled) {
      if (e.dialog.open) e.dialog.close();
      clearTimeout(timer);
      if (wasOn) support = 'unknown';
      wasOn = false;
      e.open.hidden = true;
      return;
    }
    if (!wasOn) {
      wasOn = true;
      refresh();
    }
    e.open.hidden = support !== 'yes';
    const active = loginActive(shown);
    e.open.dataset.login = active ? 'active' : '';
    setText(e.mark, active ? '●' : '');
    setText(e.openState, active ? ', sign-in in progress' : '');
    e.open.title = auth ? accountsSummary(accounts()) || 'Accounts' : 'Accounts';
    const key = JSON.stringify(accounts().map((a) => [a.id, a.status, a.kind]));
    if (auth && key !== changeKey) {
      changeKey = key;
      onChange?.(accounts());
    }
    if (e.dialog.open) renderDrawer();
  }

  function renderDrawer() {
    const list = accounts();
    e.empty.hidden = Boolean(auth);
    if (!auth) setText(e.empty, support === 'no' ? 'This server does not offer account sign-in.' : 'Loading accounts...');
    e.list.hidden = !auth;
    const active = loginActive(shown);
    const ids = new Set(list.map((a) => a.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        if (row.li.contains(e.keyForm)) closeKey();
        row.li.remove();
        rows.delete(id);
      }
    }
    for (const a of list) renderRow(a, active);
    renderLogin();
    renderAdd();
    renderKey();
    renderProvider();
    setText(e.foot, active ? 'One sign-in at a time' : '');
  }

  function renderRow(a, active) {
    let row = rows.get(a.id);
    if (!row) {
      const li = el('li', 'account');
      const head = el('div', 'account-head');
      const name = el('span', 'account-name');
      const state = el('span', 'badge account-state');
      const kind = el('span', 'badge account-kind');
      kind.dataset.tone = 'quiet';
      const custom = el('span', 'badge account-custom', 'Custom');
      custom.dataset.tone = 'quiet';
      head.append(name, state, kind, custom);
      const detail = el('p', 'account-detail');
      const actions = el('div', 'account-actions');
      const button = (action, text, primary) => {
        const b = el('button', primary ? 'btn btn-small btn-primary' : 'btn btn-small', text);
        b.type = 'button';
        b.dataset.action = action;
        b.dataset.provider = a.id;
        return b;
      };
      const signIn = button('login', 'Sign in', true);
      const signOut = button('logout', 'Sign out');
      // the same sign-in, quiet: the row still reads as signed in
      const again = button('login', 'Sign in again');
      again.classList.add('btn-quiet');
      const key = button('key', 'Add API key');
      key.setAttribute('aria-controls', 'key-panel');
      const unkey = button('unkey', 'Remove key');
      const remove = button('remove', 'Remove provider');
      actions.append(signIn, key, again, signOut, unkey, remove);
      li.append(head, detail, actions);
      e.list.append(li);
      row = { li, name, state, kind, custom, detail, signIn, again, signOut, key, unkey, remove };
      rows.set(a.id, row);
    }
    const v = accountView(a, { busy: active || busy });
    // a key for the provider that is signing in right now would race the sign-in for the same store entry
    const locked = busy || (active && shown.provider === a.id);
    row.li.dataset.status = a.status;
    setText(row.name, a.label);
    setText(row.state, v.status, v.tone);
    row.kind.hidden = !v.kind;
    setText(row.kind, v.kind ?? '');
    row.custom.hidden = !v.custom;
    setText(row.detail, v.detail);
    row.signIn.hidden = !v.signIn;
    setText(row.signIn, v.signInLabel);
    row.signIn.disabled = v.signInDisabled;
    row.signIn.setAttribute('aria-label', `${v.signInLabel} to ${a.label}`);
    row.again.hidden = !v.signInAgain;
    row.again.disabled = v.signInDisabled;
    row.again.setAttribute('aria-label', `Sign in again to ${a.label}`);
    row.signOut.hidden = !v.signOut;
    row.signOut.disabled = busy;
    row.signOut.setAttribute('aria-label', `Sign out of ${a.label}`);
    row.key.hidden = !v.addKey;
    setText(row.key, v.keyLabel);
    row.key.disabled = locked;
    row.key.setAttribute('aria-label', `${v.keyLabel} for ${a.label}`);
    row.key.setAttribute('aria-expanded', String(keyFor?.provider === a.id));
    // a subscription row keeps its sign-in as the main action
    row.key.classList.toggle('btn-primary', !v.signIn && !v.signOut && !v.removeKey && !v.removeProvider);
    row.unkey.hidden = !v.removeKey;
    row.unkey.disabled = locked;
    row.unkey.setAttribute('aria-label', `Remove the ${a.label} API key`);
    row.remove.hidden = !v.removeProvider;
    row.remove.disabled = busy;
    row.remove.setAttribute('aria-label', `Remove provider ${a.label}`);
  }

  function renderAdd() {
    // a server without /api/auth/providers predates API keys and custom providers
    const extended = providers !== null && providers !== undefined;
    e.add.hidden = !auth || !extended;
    e.keyOther.setAttribute('aria-expanded', String(Boolean(keyFor) && keyFor.provider === null));
    e.providerAdd.setAttribute('aria-expanded', String(!e.pForm.hidden));
    e.keyOther.disabled = busy;
    e.providerAdd.disabled = busy;
  }

  function renderLogin() {
    if (!shown) {
      if (e.login.contains(document.activeElement)) focusFirstRow();
      e.login.hidden = true;
      return;
    }
    const v = loginView(shown, accounts());
    const hadFocus = e.login.contains(document.activeElement) ? document.activeElement : null;
    e.login.hidden = false;
    e.login.dataset.tone = v.tone;
    setText(e.loginTitle, v.title);
    setText(e.progress, v.text, v.tone);
    e.urlRow.hidden = !v.url;
    setText(e.url, v.url ?? '');
    e.reopen.hidden = !v.reopen;
    // aria-disabled, not disabled: the button keeps keyboard focus through the cooldown
    e.reopen.setAttribute('aria-disabled', String(Date.now() < reopenUntil));
    if (!v.reopen || reopenFor !== shown.id) setText(e.reopenStatus, '', '');
    const device = shown.userCode && !v.finished
      ? `Code ${shown.userCode}${shown.verificationUri ? ` at ${shown.verificationUri}` : ''}`
      : '';
    e.device.hidden = !device;
    setText(e.device, device);
    const showCode = v.code;
    const codeAppeared = showCode && e.codeForm.hidden;
    e.codeForm.hidden = !showCode;
    setText(e.codeLabel, v.codeLabel);
    setText(e.codeHint, v.codeHint);
    if (!showCode || codeAppeared) {
      setText(e.codeError, '', '');
      e.codeInput.removeAttribute('aria-invalid');
    }
    e.codeInput.disabled = busy;
    e.codeSubmit.disabled = busy;
    e.cancel.hidden = !v.canCancel;
    e.cancel.disabled = busy;
    e.dismiss.hidden = !v.finished;
    // keep the human's place when what they were using went away; never pull focus from elsewhere
    const active = document.activeElement;
    if (codeAppeared && (active === e.loginTitle || active === document.body || e.login.contains(active))) e.codeInput.focus();
    else if (hadFocus && (hadFocus.hidden || hadFocus.disabled || hadFocus.closest('[hidden]'))) (v.finished ? e.dismiss : e.loginTitle).focus();
  }

  function focusFirstRow() {
    const b = e.list.querySelector('button:not([hidden]):not(:disabled)');
    (b ?? e.dialog.querySelector('[data-close]')).focus();
  }

  // ------------------------------------------------------------ drawer
  // returnTo: where focus goes on close when the opener is gone by then (e.g. a hint that sign-in removed)
  function open({ returnTo = null } = {}) {
    if (support !== 'yes' || !on()) return false;
    opener = document.activeElement;
    fallback = returnTo;
    e.error.hidden = true;
    renderDrawer();
    e.dialog.showModal();
    if (shown) e.loginTitle.focus();
    else focusFirstRow();
    refresh();
    loadProviders();
    return true;
  }

  function loadProviders() {
    providersLoading = true;
    return getJson('/api/auth/providers').then((doc) => {
      providersLoading = false;
      if (doc === null) providers = null;
      else if (doc !== undefined && parseProviders(doc)) providers = parseProviders(doc).providers;
      if (keyFor?.provider === null) fillKeyProviders();
      if (e.dialog.open) renderDrawer();
    });
  }

  e.open.addEventListener('click', () => open());
  for (const b of e.dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => e.dialog.close());
  e.dialog.addEventListener('click', (ev) => {
    if (ev.target === e.dialog) e.dialog.close();
  });
  e.dialog.addEventListener('close', () => {
    // nothing typed into a key field outlives the drawer
    closeKey();
    closeProvider();
    setText(e.status, '');
    // a login keeps polling with the drawer closed; the top-bar mark shows it
    schedule();
    const usable = (t) => t && t !== document.body && t.isConnected && !t.closest('[hidden]') && !t.closest('dialog:not([open])') && !t.disabled;
    const target = [opener, fallback].find(usable);
    opener = null;
    fallback = null;
    if (target) target.focus();
    else if (!e.open.hidden) e.open.focus();
  });

  // ------------------------------------------------------------ sign in / out
  async function signIn(provider) {
    if (busy || loginActive(shown)) return;
    busy = true;
    e.error.hidden = true;
    renderDrawer();
    const r = await postJson('/api/auth/login', { provider });
    busy = false;
    if (!r.ok) {
      e.error.textContent = r.status === 409 ? `${r.error} Wait for it to finish or cancel it.` : r.error;
      e.error.hidden = false;
      await refresh();
      const row = rows.get(provider);
      if (!loginActive(shown)) (row && !row.again.hidden ? row.again : row?.signIn)?.focus();
      return;
    }
    const id = typeof r.data?.id === 'string' && r.data.id ? r.data.id : null;
    dismissedId = null;
    shown = id ? { id, provider, state: 'starting', authUrl: null, userCode: null, verificationUri: null, message: null, error: null, startedAt: null } : shown;
    renderDrawer();
    e.loginTitle.focus();
    refresh();
  }

  function signOut(provider) {
    const a = accounts().find((x) => x.id === provider);
    if (!a || busy) return;
    const c = signOutConfirm(a, { runActive: Boolean(getControl()?.gates.alive) });
    confirm({
      ...c,
      action: async () => {
        const r = await postJson('/api/auth/logout', { provider });
        if (!r.ok) return { error: r.error };
        say(`Signed out of ${a.label}`);
        await refresh();
        const row = rows.get(provider);
        return { focus: row && !row.signIn.hidden ? row.signIn : e.dialog.querySelector('[data-close]') };
      },
    });
  }

  function removeKey(provider) {
    const a = accounts().find((x) => x.id === provider);
    if (!a || busy) return;
    confirm({
      ...removeKeyConfirm(a, { runActive: Boolean(getControl()?.gates.alive) }),
      action: async () => {
        const r = await postJson('/api/auth/logout', { provider });
        if (!r.ok) return { error: r.error };
        setText(e.status, `Removed the ${a.label} API key.`);
        await refresh();
        const row = rows.get(provider);
        return { focus: row && !row.key.hidden ? row.key : e.dialog.querySelector('[data-close]') };
      },
    });
  }

  function removeProvider(id) {
    const a = accounts().find((x) => x.id === id);
    if (!a || busy) return;
    confirm({
      ...removeProviderConfirm(a, { runActive: Boolean(getControl()?.gates.alive) }),
      action: async () => {
        const r = await postJson('/api/providers/remove', { id });
        if (!r.ok) return { error: r.error };
        setText(e.status, `Removed provider ${a.label}.`);
        await refresh();
        return { focus: e.add.hidden ? e.dialog.querySelector('[data-close]') : e.providerAdd };
      },
    });
  }

  e.list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-action]');
    if (!b || b.disabled) return;
    const p = b.dataset.provider;
    if (b.dataset.action === 'login') signIn(p);
    else if (b.dataset.action === 'logout') signOut(p);
    else if (b.dataset.action === 'key') {
      if (keyFor?.provider === p) closeKey({ focus: b });
      else openKey(p);
    } else if (b.dataset.action === 'unkey') removeKey(p);
    else removeProvider(p);
  });

  // ------------------------------------------------------------ API key form
  function keyAccount() {
    return keyFor?.provider ? accounts().find((a) => a.id === keyFor.provider) ?? null : null;
  }

  function keyError(text, tone) {
    setText(e.keyError, text, tone);
    if (tone !== 'error') {
      e.keyInput.removeAttribute('aria-invalid');
      e.keyProvider.removeAttribute('aria-invalid');
    }
  }

  // provider = an account id, or null for the picker
  function openKey(provider) {
    closeProvider();
    e.keyInput.value = '';
    keyError('', '');
    setText(e.status, '');
    keyFor = { provider };
    const row = provider ? rows.get(provider) : null;
    if (row) row.li.append(e.keyForm);
    else e.add.after(e.keyForm);
    if (!provider) fillKeyProviders();
    renderDrawer();
    (provider || e.keyProvider.disabled ? e.keyInput : e.keyProvider).focus();
  }

  function closeKey({ focus = null } = {}) {
    const had = e.keyForm.contains(document.activeElement);
    e.keyInput.value = '';
    keyError('', '');
    const was = keyFor;
    keyFor = null;
    e.keyForm.hidden = true;
    e.add.after(e.keyForm);
    if (e.dialog.open) renderDrawer();
    if (focus) focus.focus();
    else if (was && had && e.dialog.open) (rows.get(was.provider)?.key ?? e.keyOther).focus();
  }

  function fillKeyProviders() {
    const list = otherKeyProviders(providers ?? [], accounts());
    const keep = e.keyProvider.value;
    const first = el('option', '', list.length ? 'Pick a provider' : 'No other provider');
    first.value = '';
    e.keyProvider.replaceChildren(first, ...list.map((p) => {
      const o = el('option', '', p.label === p.id ? p.id : `${p.label} (${p.id})`);
      o.value = p.id;
      return o;
    }));
    e.keyProvider.value = list.some((p) => p.id === keep) ? keep : '';
    e.keyProvider.disabled = !list.length;
    let status = list.length ? '' : 'Every provider that takes an API key is already listed above.';
    if (providers === undefined) status = providersLoading ? 'Loading providers...' : 'The provider list could not be loaded. Close and open Accounts to try again.';
    setText(e.keyProviderStatus, status);
  }

  function renderKey() {
    e.keyForm.hidden = !keyFor;
    if (!keyFor) return;
    const a = keyAccount();
    const picker = keyFor.provider === null;
    setText(e.keyTitle, picker ? 'API key for another provider' : `API key for ${a?.label ?? keyFor.provider}`);
    e.keyProviderRow.hidden = !picker;
    const note = keyNote(a);
    setText(e.keyNote, note);
    e.keyNote.hidden = !note;
    e.keyInput.disabled = busy;
    e.keySubmit.disabled = busy;
    e.keyCancel.disabled = busy;
  }

  e.keyOther.addEventListener('click', () => {
    if (keyFor && keyFor.provider === null) closeKey({ focus: e.keyOther });
    else openKey(null);
  });
  e.keyCancel.addEventListener('click', () => closeKey());
  e.keyProvider.addEventListener('change', () => {
    e.keyProvider.removeAttribute('aria-invalid');
    if (e.keyError.dataset.tone === 'error') keyError('', '');
  });
  e.keyInput.addEventListener('input', () => {
    e.keyInput.removeAttribute('aria-invalid');
    if (e.keyError.dataset.tone === 'error') keyError('', '');
  });

  e.keyForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy || !keyFor) return;
    const provider = keyFor.provider ?? e.keyProvider.value;
    const built = buildKey(provider, e.keyInput.value);
    if (built.error) {
      const field = built.field === 'provider' ? e.keyProvider : e.keyInput;
      keyError(built.error, 'error');
      field.setAttribute('aria-invalid', 'true');
      field.focus();
      return;
    }
    // the key leaves the field the moment it is sent; a failed save asks for it again
    e.keyInput.value = '';
    const label = accounts().find((a) => a.id === provider)?.label ?? providers?.find((p) => p.id === provider)?.label ?? provider;
    busy = true;
    keyError('Saving...', 'busy');
    renderDrawer();
    const r = await postJson('/api/auth/key', built.body);
    busy = false;
    if (!r.ok) {
      keyError(`${sentence(scrubSecret(r.error, built.body.key))} Enter the key again.`, 'error');
      renderDrawer();
      if (!e.keyForm.hidden) e.keyInput.focus();
      return;
    }
    closeKey();
    setText(e.status, `Key saved for ${label}.`);
    await refresh();
    const row = rows.get(provider);
    (row && !row.key.hidden && !row.key.disabled ? row.key : e.status).focus();
  });

  // ------------------------------------------------------------ custom provider form
  const fields = () => ({ label: e.pLabel, id: e.pId, baseUrl: e.pUrl, api: e.pApi, key: e.pKey, manual: e.pManual });
  e.pApi.replaceChildren(...API_TYPES.map((t) => {
    const o = el('option', '', t.label);
    o.value = t.id;
    return o;
  }));

  function checkedIds() {
    return [...e.pModelList.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
  }

  function providerError(text, field) {
    for (const f of Object.values(fields())) f.removeAttribute('aria-invalid');
    e.pError.textContent = text;
    e.pError.hidden = !text;
    if (!field) return;
    const target = field === 'models' ? (e.pModelList.querySelector('input') ?? e.pManual) : fields()[field];
    if (!target) return;
    if (field !== 'models') target.setAttribute('aria-invalid', 'true');
    target.focus();
  }

  function resetProvider() {
    e.pForm.reset();
    e.pKey.value = '';
    idEdited = false;
    discovered = null;
    e.pModelList.replaceChildren();
    setText(e.pFetchStatus, '', '');
    setText(e.pStatus, '', '');
    providerError('');
  }

  function openProvider() {
    closeKey();
    setText(e.status, '');
    resetProvider();
    e.pForm.hidden = false;
    renderDrawer();
    e.pLabel.focus();
  }

  function closeProvider({ focus = null } = {}) {
    const had = e.pForm.contains(document.activeElement);
    resetProvider();
    e.pForm.hidden = true;
    if (e.dialog.open) renderDrawer();
    if (focus) focus.focus();
    else if (had && e.dialog.open) e.providerAdd.focus();
  }

  function renderProvider() {
    if (e.pForm.hidden) return;
    const found = Boolean(discovered?.length);
    e.pModels.hidden = !found;
    setText(e.pManualLabel, found ? 'More model ids' : 'Model ids');
    const all = found && checkedIds().length === discovered.length;
    setText(e.pAll, all ? 'Clear all' : 'Select all');
    for (const c of e.pForm.querySelectorAll('input, select, button')) c.disabled = busy;
  }

  function showDiscovered() {
    e.pModelList.replaceChildren(...(discovered ?? []).map((m) => {
      const li = el('li');
      const label = el('label', 'check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = m.id;
      const text = el('span', 'mono', m.id);
      label.append(box, text);
      if (m.contextWindow) label.append(el('span', 'hint', `${Math.round(m.contextWindow / 1000)}k context`));
      li.append(label);
      return li;
    }));
  }

  // a new address or API type makes the fetched list stale
  function forgetDiscovered() {
    if (!discovered) return;
    discovered = null;
    showDiscovered();
    setText(e.pFetchStatus, 'The address or API type changed. Fetch the models again.', '');
    renderProvider();
  }

  e.providerAdd.addEventListener('click', () => {
    if (e.pForm.hidden) openProvider();
    else closeProvider({ focus: e.providerAdd });
  });
  e.pCancel.addEventListener('click', () => closeProvider({ focus: e.providerAdd }));
  for (const f of Object.values(fields())) f.addEventListener('input', () => {
    f.removeAttribute('aria-invalid');
    if (!e.pError.hidden) providerError('');
  });
  e.pLabel.addEventListener('input', () => {
    if (!idEdited) e.pId.value = slugify(e.pLabel.value);
  });
  // an emptied id follows the name again
  e.pId.addEventListener('input', () => { idEdited = e.pId.value !== ''; });
  e.pUrl.addEventListener('input', forgetDiscovered);
  e.pApi.addEventListener('change', forgetDiscovered);
  e.pModelList.addEventListener('change', () => {
    if (!e.pError.hidden) providerError('');
    renderProvider();
  });
  e.pAll.addEventListener('click', () => {
    const boxes = [...e.pModelList.querySelectorAll('input[type="checkbox"]')];
    const on = !boxes.every((c) => c.checked);
    for (const c of boxes) c.checked = on;
    renderProvider();
  });

  e.pPreset.addEventListener('click', () => {
    const p = ABLITERATION_PRESET;
    e.pLabel.value = p.label;
    e.pId.value = p.id;
    idEdited = true;
    e.pUrl.value = p.baseUrl;
    e.pApi.value = p.api;
    forgetDiscovered();
    providerError('');
    setText(e.pFetchStatus, 'abliteration.ai filled in. Enter your API key, then fetch the models.', '');
    e.pKey.focus();
  });

  e.pFetch.addEventListener('click', async () => {
    if (busy) return;
    const built = buildDiscover({ baseUrl: e.pUrl.value, api: e.pApi.value, key: e.pKey.value });
    if (built.error) return providerError(built.error, built.field);
    providerError('');
    busy = true;
    setText(e.pFetchStatus, 'Fetching models...', 'busy');
    renderDrawer();
    const r = await postJson('/api/providers/discover', built.body);
    busy = false;
    const list = r.ok ? parseDiscovered(r.data) : null;
    discovered = list?.models.length ? list.models : null;
    showDiscovered();
    renderDrawer();
    if (!discovered) {
      const why = !r.ok ? sentence(scrubSecret(r.error, built.body.key)) : list ? 'The provider listed no models.' : 'The answer had no model list.';
      setText(e.pFetchStatus, `${why} Enter the model ids by hand below.`, 'error');
      e.pManual.focus();
      return;
    }
    setText(e.pFetchStatus, `${plural(discovered.length, 'model')} found. Check the ones the agents may use.`, '');
    e.pModelList.querySelector('input').focus();
  });

  e.pForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const taken = [...(providers ?? []).map((p) => p.id), ...accounts().map((a) => a.id)];
    const built = buildProvider({
      label: e.pLabel.value, id: e.pId.value, baseUrl: e.pUrl.value, api: e.pApi.value, key: e.pKey.value,
      discovered, checked: checkedIds(), manual: e.pManual.value,
    }, { taken });
    if (built.error) return providerError(built.error, built.field);
    providerError('');
    e.pKey.value = '';
    busy = true;
    setText(e.pStatus, 'Saving...', 'busy');
    renderDrawer();
    const r = await postJson('/api/providers', built.body);
    busy = false;
    if (!r.ok) {
      setText(e.pStatus, '', '');
      renderDrawer();
      const field = providerErrorField(r.error);
      providerError(`${sentence(scrubSecret(r.error, built.body.key))} Enter the API key again.`, field && field !== 'key' ? field : 'key');
      return;
    }
    closeProvider();
    setText(e.status, `Added ${built.body.label} with ${plural(built.body.models.length, 'model')}. New runs can pick them.`);
    await refresh();
    const row = rows.get(built.body.id);
    (row && !row.remove.hidden ? row.remove : e.status).focus();
  });

  // ------------------------------------------------------------ login session
  e.codeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    const built = buildLoginInput(e.codeInput.value, shown);
    if (built.error) {
      setText(e.codeError, built.error, 'error');
      e.codeInput.setAttribute('aria-invalid', 'true');
      e.codeInput.focus();
      return;
    }
    busy = true;
    setText(e.codeError, 'Sending...', '');
    renderDrawer();
    const r = await postJson('/api/auth/login/input', built.body);
    busy = false;
    if (!r.ok) {
      setText(e.codeError, r.status === 409 ? 'The sign-in is not waiting for a code any more.' : r.error, 'error');
      await refresh();
      if (!e.codeForm.hidden) e.codeInput.focus();
      return;
    }
    e.codeInput.value = '';
    setText(e.codeError, '', '');
    await refresh();
    if (document.activeElement === document.body || e.codeForm.hidden) e.loginTitle.focus();
  });
  e.codeInput.addEventListener('input', () => {
    e.codeInput.removeAttribute('aria-invalid');
    if (e.codeError.dataset.tone === 'error') setText(e.codeError, '', '');
    if (e.codeInput.value.length >= LOGIN_INPUT_MAX) setText(e.codeError, `Limit of ${LOGIN_INPUT_MAX} characters reached.`, '');
  });

  e.cancel.addEventListener('click', async () => {
    if (!shown || busy) return;
    const id = shown.id;
    busy = true;
    renderDrawer();
    const r = await postJson('/api/auth/login/cancel', { id });
    busy = false;
    if (!r.ok) {
      e.error.textContent = r.error;
      e.error.hidden = false;
    } else {
      cancelledId = id;
    }
    await refresh();
    if (!e.dismiss.hidden) e.dismiss.focus();
  });

  e.dismiss.addEventListener('click', () => {
    dismissedId = shown?.id ?? null;
    shown = null;
    renderDrawer();
    focusFirstRow();
    schedule();
  });

  e.copy.addEventListener('click', async () => {
    const text = e.url.textContent;
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(text);
      e.copyStatus.textContent = 'Copied';
    } catch {
      // clipboard blocked: select the address so the copy shortcut copies it
      const range = document.createRange();
      range.selectNodeContents(e.url);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      e.copyStatus.textContent = `Selected - press ${shortcut('C')} to copy`;
    }
    copyTimer = setTimeout(() => { e.copyStatus.textContent = ''; }, COPIED_MS);
  });

  e.reopen.addEventListener('click', async () => {
    if (Date.now() < reopenUntil) return;
    const built = buildReopen(shown);
    reopenFor = shown?.id ?? null;
    if (built.error) {
      setText(e.reopenStatus, built.error, 'error');
      return;
    }
    reopenUntil = Date.now() + REOPEN_MS;
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(() => {
      reopenUntil = 0;
      if (e.reopenStatus.dataset.tone !== 'error') setText(e.reopenStatus, '', '');
      render();
    }, REOPEN_MS);
    setText(e.reopenStatus, 'Opening...', '');
    renderLogin();
    const r = await postJson('/api/auth/login/open', built.body);
    if (shown?.id !== built.body.id) return;
    if (r.ok) {
      setText(e.reopenStatus, Date.now() < reopenUntil ? 'The server opened it in your browser again.' : '', '');
      return;
    }
    setText(e.reopenStatus, r.status === 409 ? 'This sign-in has no page to open any more.' : r.error, 'error');
    refresh();
  });

  return {
    render, refresh, open,
    available: () => support === 'yes' && on(),
    accounts: () => (auth ? accounts() : null),
  };
}

// A model select: the default option, then one group per provider of the catalog (modelGroups). Returns the
// default option, whose text the caller may rename later.
export function fillModelSelect(s, groups, defaultLabel) {
  const def = el('option', '', defaultLabel);
  def.value = '';
  s.replaceChildren(def, ...groups.map((g) => {
    const og = document.createElement('optgroup');
    og.label = g.label;
    og.disabled = g.disabled;
    og.append(...g.options.map((o) => {
      const opt = el('option', '', o.text);
      opt.value = o.value;
      opt.title = o.title;
      return opt;
    }));
    return og;
  }));
  return def;
}

// The per-role model selects of the New run drawer, filled from GET /api/models. The built-in roles have their
// rows in index.html; a custom gate of the catalog (GET /api/control defaults.agents) gets one made for it.
// The picks hold in every sandbox: the model calls are made on this computer.
export function createModelPicker({ openAccounts, canOpenAccounts }) {
  const e = {
    fields: $('model-fields'), status: $('models-status'), note: $('models-note'), docker: $('models-docker-note'),
    plan: $('models-plan'), grid: $('model-grid'),
    signin: $('models-signin'), signinBtn: $('models-accounts'),
    selects: {
      michael: $('f-model-michael'), dwight: $('f-model-dwight'), oscar: $('f-model-oscar'), hank: $('f-model-hank'), angela: $('f-model-angela'),
    },
    notes: {
      michael: $('f-model-michael-note'), dwight: $('f-model-dwight-note'), oscar: $('f-model-oscar-note'), hank: $('f-model-hank-note'),
      angela: $('f-model-angela-note'),
    },
    rows: {
      michael: $('model-row-michael'), dwight: $('model-row-dwight'), oscar: $('model-row-oscar'), hank: $('model-row-hank'), angela: $('model-row-angela'),
    },
  };
  let support = 'unknown';
  let catalog = null;
  let accounts = null;
  let catalogKey = '';
  // every stored choice, also one for a custom agent the catalog does not list (yet)
  let stored = parseStoredModels(store.get(MODELS_KEY), null);
  let loading = null;
  let loadedOnce = false;
  let agentsKey = '';
  // gates: the stages the Workflow section picked (undefined: the engine default); agents: the server's catalog
  let ctx = { demo: false, sandbox: 'scranton', noPlan: false, configured: null, gates: undefined, agents: null, names: null };
  // the default option of each select, renamed by render() to what that role uses
  const defaults = {};
  const roles = () => Object.keys(e.selects);
  const values = () => Object.fromEntries(roles().map((r) => [r, e.selects[r].value]));

  function load() {
    if (loading) return loading;
    if (!loadedOnce) {
      e.status.textContent = 'Loading the model list...';
      e.status.hidden = false;
    }
    loading = getJson('/api/models').then((doc) => {
      loading = null;
      if (doc === null) {
        support = 'no';
      } else if (doc !== undefined && parseModels(doc)) {
        support = 'yes';
        loadedOnce = true;
        catalog = parseModels(doc);
        e.status.hidden = true;
      } else {
        // keep what was loaded before; without a list only the default is offered
        e.status.textContent = 'The model list could not be loaded; every role uses its default.';
        e.status.hidden = false;
        if (support === 'unknown') support = 'yes';
      }
      fill();
      render();
    });
    return loading;
  }

  function fill(force = false) {
    const key = JSON.stringify(catalog);
    if (key === catalogKey && !force) return;
    catalogKey = key;
    const choices = resolveChoices(stored, catalog, roles());
    const groups = modelGroups(catalog);
    for (const role of roles()) {
      const s = e.selects[role];
      const focused = document.activeElement === s;
      const keep = focused ? s.value : choices[role].value;
      defaults[role] = fillModelSelect(s, groups, defaultLabel(ctx.demo ? null : ctx.configured, role));
      s.value = keep;
      // a value that is not offered (any more) leaves the select on its default
      if (s.value !== keep || s.selectedOptions[0]?.parentElement?.disabled) s.value = '';
      const note = focused ? '' : missingNote(choices[role].missing);
      e.notes[role].textContent = note;
      e.notes[role].hidden = !note;
    }
  }

  function listen(role) {
    const s = e.selects[role];
    s.addEventListener('change', () => {
      stored = storeChoice(stored, role, s.value);
      store.set(MODELS_KEY, JSON.stringify(stored));
      e.notes[role].hidden = true;
      s.removeAttribute('aria-invalid');
      render();
    });
  }

  // One row per custom gate of the catalog, after the built-in ones and in catalog order; a deleted agent's row goes.
  function syncRoles() {
    const custom = (ctx.agents ?? []).filter((a) => !a.builtin && a.gate);
    const key = JSON.stringify(custom.map((a) => [a.id, a.name, a.title]));
    if (key === agentsKey) return;
    agentsKey = key;
    const ids = custom.map((a) => a.id);
    for (const role of roles()) {
      if (MODEL_ROLES.includes(role) || ids.includes(role)) continue;
      e.rows[role].remove();
      delete e.selects[role];
      delete e.notes[role];
      delete e.rows[role];
      delete defaults[role];
    }
    let added = false;
    for (const a of custom) {
      if (!Object.hasOwn(e.rows, a.id)) {
        const row = el('div', 'field');
        row.id = `model-row-${a.id}`;
        row.dataset.role = a.id;
        const label = el('label');
        label.htmlFor = `f-model-${a.id}`;
        const s = el('select');
        s.id = `f-model-${a.id}`;
        s.dataset.role = a.id;
        const note = el('span', 'hint');
        note.id = `f-model-${a.id}-note`;
        note.hidden = true;
        s.setAttribute('aria-describedby', note.id);
        row.append(label, s, note);
        e.rows[a.id] = row;
        e.selects[a.id] = s;
        e.notes[a.id] = note;
        listen(a.id);
        added = true;
      }
      const label = e.rows[a.id].childNodes[0];
      label.replaceChildren(`${a.name} `, el('span', 'hint', (a.title || 'custom gate').toLowerCase()));
      e.grid.append(e.rows[a.id]);
    }
    if (added) fill(true);
  }

  function render() {
    syncRoles();
    e.fields.hidden = support !== 'yes';
    // the sign-in note sits beside Start, outside the fields: it goes with them
    if (support !== 'yes') {
      e.signin.hidden = true;
      return;
    }
    e.fields.dataset.demo = String(ctx.demo);
    for (const s of Object.values(e.selects)) s.disabled = ctx.demo;
    // a select for each role the run starts; a demo shows them all, dimmed
    const used = runRoles({ noPlan: ctx.noPlan, gates: ctx.gates });
    for (const role of roles()) e.rows[role].hidden = !ctx.demo && !used.includes(role);
    e.note.textContent = ctx.demo
      ? 'A demo uses a scripted model; no real model is used.'
      : `Only models of signed-in accounts and configured API keys can be picked. ${AUTOMATIC_NOTE}`;
    for (const role of roles()) {
      const label = defaultLabel(ctx.demo ? null : ctx.configured, role);
      if (defaults[role] && defaults[role].textContent !== label) defaults[role].textContent = label;
    }
    e.docker.textContent = DOCKER_NOTE;
    e.docker.hidden = ctx.demo || ctx.sandbox !== 'docker';
    const plan = ctx.demo ? '' : planNote(catalog, accounts);
    e.plan.textContent = plan;
    e.plan.hidden = !plan;
    const hint = !ctx.demo && credentialHint({ accounts, catalog });
    e.signin.hidden = !hint;
    e.signinBtn.hidden = !canOpenAccounts();
  }

  for (const role of MODEL_ROLES) listen(role);
  // a sign-in hides the note; the selects may be folded away under Options, Start is always there
  e.signinBtn.addEventListener('click', () => openAccounts({ returnTo: $('run-submit') }));

  return {
    // the New run drawer opened
    open: load,
    // the Accounts drawer changed who is signed in
    setAccounts(list) {
      accounts = list;
      if (support === 'yes' && $('run-dialog').open) load();
      else render();
    },
    sync(next) {
      ctx = { ...ctx, ...next };
      render();
    },
    // run = { demo, noPlan, gates } of the run to start (a follow-up is never a demo) -> { models } or { error, field }
    selection(run = ctx) {
      if (support !== 'yes' || run.demo) return { models: {} };
      syncRoles();
      return buildModels(values(), catalog, { names: ctx.names, ...run });
    },
    // the model list as last read, null before: the empty states decide their sign-in note from it too
    catalog: () => (support === 'yes' ? catalog : null),
    // the select of a role, for an error that names it (a custom gate's select has no fixed id)
    field: (role) => (Object.hasOwn(e.selects, role) ? e.selects[role] : null),
  };
}
