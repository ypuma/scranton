// The Updates group of Settings and the "ready" line in the top bar. The desktop shell checks, downloads and
// installs (.enma/updater-contract.md); this page only shows its status object and calls its commands. A browser
// has no shell to update, so it says how Scranton is updated instead.
import {
  UPDATE_COMMANDS, BROWSER_TEXT, UNAVAILABLE_TEXT, parseStatus, parseBusy, stateLine, lastCheckText, readyText, updateActions,
  notesOf, refusal, missingCommand, updaterApi, busyReason,
} from './updates.js';
import { CLIENT_HEADERS } from './control.js';

const $ = (id) => document.getElementById(id);
const BUSY_URL = '/api/app/busy';

// -> { running, waitingForHuman } from the app server, or null when it cannot say
async function askBusy(fetcher) {
  try {
    const res = await fetcher(BUSY_URL, { headers: CLIENT_HEADERS, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    return res?.ok ? parseBusy(await res.json()) : null;
  } catch {
    return null;
  }
}

// busyEvery: how often the server is asked while an update waits to install; 0 asks only on the occasions below
export function createUpdates({ tauri = globalThis.__TAURI__, now = () => Date.now(), fetcher = (...a) => globalThis.fetch(...a), busyEvery = 15_000 } = {}) {
  const e = {
    app: $('prefs-update-app'), browser: $('prefs-update-browser'), browserText: $('prefs-update-browser-text'),
    version: $('prefs-update-version'), state: $('prefs-update-state'), checked: $('prefs-update-checked'),
    check: $('prefs-update-check'), download: $('prefs-update-download'), install: $('prefs-update-install'),
    busy: $('prefs-update-busy'), action: $('prefs-update-action'),
    autoCheck: $('prefs-update-auto-check'), autoInstall: $('prefs-update-auto-install'),
    notesBox: $('prefs-update-notes-box'), notesTitle: $('prefs-update-notes-title'), notes: $('prefs-update-notes'),
    ready: $('update-ready'), readyText: $('update-ready-text'), readyBusy: $('update-ready-busy'), restart: $('update-ready-restart'),
  };
  const api = updaterApi(tauri);
  if (!api) {
    e.browserText.textContent = BROWSER_TEXT;
    e.browser.hidden = false;
    e.app.hidden = true;
    e.ready.hidden = true;
    return { desktop: false, refresh() {}, status: () => null };
  }

  let status = null;
  // the command on its way; the controls wait for its answer
  let pending = null;
  let unavailable = false;
  // The shell keeps the counts of its last refused install until the state changes, so they go stale once the
  // runs end. The server's own answer, the same one the shell asks before it installs, wins while it has one.
  let busy = null;
  let asking = null;
  let timer = null;
  // a server answer asked for before the latest refusal is older than it
  let ticket = 0;
  const shown = () => (status && busy ? { ...status, busy } : status);

  function askAgain() {
    if (asking || status?.state !== 'ready') return;
    const mine = ticket;
    asking = askBusy(fetcher).then((counts) => {
      asking = null;
      if (mine !== ticket) return;
      busy = counts;
      render();
    });
  }
  function follow() {
    const ready = status?.state === 'ready';
    if (ready && !timer && busyEvery > 0) timer = setInterval(askAgain, busyEvery);
    if (!ready && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function note(text, tone = '') {
    e.action.textContent = text;
    e.action.dataset.tone = tone;
  }

  function render() {
    const status = shown();
    e.app.hidden = unavailable;
    e.browser.hidden = !unavailable;
    if (unavailable) e.browserText.textContent = UNAVAILABLE_TEXT;
    e.version.textContent = status?.current ?? '';
    const s = stateLine(status);
    e.state.textContent = unavailable ? '' : s.text;
    e.state.dataset.tone = unavailable ? '' : s.tone;
    e.checked.textContent = status ? lastCheckText(status, now()) : '';
    const a = updateActions(status);
    const waiting = pending !== null;
    e.check.hidden = !a.check.shown;
    e.check.disabled = waiting || a.check.disabled;
    e.download.hidden = !a.download.shown;
    e.download.disabled = waiting || a.download.disabled;
    e.install.hidden = !a.install.shown;
    e.install.disabled = waiting || a.install.disabled;
    e.busy.textContent = a.install.reason ? `Restart and update waits: ${a.install.reason}` : '';
    e.busy.hidden = !(a.install.shown && a.install.reason);
    for (const [box, key] of [[e.autoCheck, 'autoCheck'], [e.autoInstall, 'autoInstall']]) {
      box.disabled = !status || waiting;
      box.checked = Boolean(status?.[key]);
    }
    const n = notesOf(status);
    e.notesBox.hidden = !n;
    e.notesTitle.textContent = n?.title ?? '';
    e.notes.textContent = n?.text ?? '';

    const ready = readyText(status);
    e.ready.hidden = !ready;
    e.readyText.textContent = ready;
    e.readyText.title = ready;
    e.restart.disabled = waiting || a.install.disabled;
    e.readyBusy.textContent = a.install.reason ? `(${a.install.reason})` : '';
    e.readyBusy.hidden = !a.install.reason;
  }

  function take(next) {
    const becameReady = next.state === 'ready' && status?.state !== 'ready';
    status = next;
    unavailable = false;
    follow();
    if (becameReady) {
      busy = null;
      ticket += 1;
      askAgain();
    }
  }

  function adopt(doc) {
    const next = parseStatus(doc);
    if (!next) return false;
    take(next);
    render();
    return true;
  }

  // -> true when the shell answered with a status
  async function call(name, args, failText) {
    if (pending) return false;
    pending = name;
    note('');
    render();
    let answer;
    let failed = null;
    try {
      answer = await api.call(name, args);
    } catch (err) {
      failed = refusal(err);
    }
    pending = null;
    if (!failed) {
      if (!adopt(answer)) render();
      return true;
    }
    if (failed.status) take(failed.status);
    // a refused install is the shell's answer of just now
    const counts = failed.status?.busy ?? failed.busy;
    if (name === UPDATE_COMMANDS.install && counts) {
      busy = counts;
      ticket += 1;
    }
    if (!status && missingCommand(failed.message)) unavailable = true;
    const reason = busyReason(shown()?.busy);
    if (name === UPDATE_COMMANDS.install && reason) note(`Not now: ${reason}. Restart and update when the runs are done.`, 'error');
    // an error state says it in the state line already
    else if (!unavailable && failed.status?.state !== 'error') note(failed.message ? `${failText}: ${failed.message}` : failText, 'error');
    render();
    return Boolean(failed.status);
  }

  const refresh = () => {
    askAgain();
    return call(UPDATE_COMMANDS.status, undefined, 'The update status could not be read');
  };
  const install = () => call(UPDATE_COMMANDS.install, undefined, 'The update could not be installed');

  e.check.addEventListener('click', () => call(UPDATE_COMMANDS.check, undefined, 'The check did not finish'));
  e.download.addEventListener('click', () => call(UPDATE_COMMANDS.download, undefined, 'The download did not start'));
  e.install.addEventListener('click', install);
  e.restart.addEventListener('click', install);
  e.autoCheck.addEventListener('change', () => call(UPDATE_COMMANDS.settings, { autoCheck: e.autoCheck.checked }, 'The setting was not saved'));
  e.autoInstall.addEventListener('change', () => call(UPDATE_COMMANDS.settings, { autoInstall: e.autoInstall.checked }, 'The setting was not saved'));

  if (api.listen) {
    // a shell that refuses the subscription still answers the commands
    Promise.resolve().then(() => api.listen((payload) => adopt(payload))).catch(() => {});
  }
  render();
  refresh();
  return { desktop: true, refresh, status: () => status };
}
