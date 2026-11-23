// The desktop app's auto-update in Settings (.enma/updater-contract.md §4, §5): the status object of the Rust shell
// rendered for every state, the busy reason that holds Restart and update back, the toggles and buttons calling the
// shell's commands, the `update-status` event, the browser fallback, and release notes kept as plain text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  UPDATE_STATES, RELEASES_URL, BROWSER_TEXT, UNAVAILABLE_TEXT, parseStatus, stateLine, busyReason, readyText, updateActions,
  notesOf, plainNotes, lastCheckText, refusal, updaterApi,
} from '../../visualizer/public/js/updates.js';
import { createUpdates } from '../../visualizer/public/js/update-panel.js';
import { installDom } from './fixtures/fake-dom.js';

const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
const SCRIPT_NOTES = 'Fixes:\r\n- <script>alert(1)</script> no longer runs\n\n\n\n- <img src=x onerror=alert(2)>';

const status = (fields = {}) => ({ current: '0.6.0', autoCheck: true, autoInstall: true, state: 'idle', ...fields });
const offer = (state, fields = {}) => status({ state, available: { version: '0.7.0', notes: 'Faster start.', date: '2026-11-24T10:00:00Z' }, ...fields });

// What the page sees as globalThis.__TAURI__. answers: per command a value, or a function of the args that may throw.
function fakeShell(answers = {}) {
  const calls = [];
  const listeners = [];
  const tauri = {
    core: {
      invoke: async (name, args) => {
        calls.push(args === undefined ? [name] : [name, args]);
        const a = answers[name];
        return typeof a === 'function' ? a(args) : a;
      },
    },
    event: { listen: async (name, fn) => { listeners.push([name, fn]); return () => {}; } },
  };
  const emit = (payload) => { for (const [name, fn] of listeners) if (name === 'update-status') fn({ event: name, id: 1, payload }); };
  return { tauri, calls, listeners, emit };
}

// server: what GET /api/app/busy answers (a function of the call count), or nothing for a server without it
async function panel(shell, { server, busyEvery = 0 } = {}) {
  const $ = installDom();
  // as index.html has them
  for (const id of ['prefs-update-app', 'prefs-update-browser', 'update-ready', 'prefs-update-check', 'prefs-update-download', 'prefs-update-install', 'prefs-update-busy', 'prefs-update-notes-box', 'update-ready-busy']) $(id).hidden = true;
  const asked = [];
  const fetcher = async (url, init) => {
    asked.push([url, init]);
    return server ? Response.json(server(asked.length)) : new Response('', { status: 404 });
  };
  const u = createUpdates({ tauri: shell?.tauri, now: () => Date.parse('2026-11-24T12:00:00Z'), fetcher, busyEvery });
  await tick();
  return { $, u, asked };
}

test('status: every state has its line, and a status object is read tolerantly', () => {
  const lines = Object.fromEntries(UPDATE_STATES.map((state) => [state, stateLine(parseStatus(offer(state, state === 'error' ? { error: 'offline' } : {})))]));
  assert.deepEqual(lines, {
    idle: { text: 'Not checked yet', tone: '' },
    checking: { text: 'Checking for updates', tone: 'busy' },
    up_to_date: { text: 'Scranton is up to date', tone: '' },
    available: { text: 'Scranton 0.7.0 is available', tone: '' },
    downloading: { text: 'Downloading Scranton 0.7.0', tone: 'busy' },
    ready: { text: 'Scranton 0.7.0 is ready - installs at the next start', tone: '' },
    installing: { text: 'Installing Scranton 0.7.0. Scranton restarts when it is done.', tone: 'busy' },
    unsupported: { text: 'No update for this platform yet', tone: '' },
    error: { text: 'Update failed: offline', tone: 'error' },
  });
  assert.equal(stateLine(parseStatus(offer('downloading', { progress: { downloaded: 450, total: 1000 } }))).text, 'Downloading Scranton 0.7.0: 45%');
  assert.equal(stateLine(parseStatus(offer('downloading', { progress: { downloaded: 5 * 1024 * 1024 + 300000, total: null } }))).text, 'Downloading Scranton 0.7.0: 5.3 MB');
  assert.equal(stateLine(parseStatus(status({ state: 'error' }))).text, 'Update failed');
  assert.equal(readyText(parseStatus(offer('ready', { autoInstall: false }))), 'Scranton 0.7.0 is ready to install', 'without the automatic install nothing installs at the next start');
  assert.equal(readyText(parseStatus(offer('available'))), '');

  for (const bad of [null, 'ready', [], {}, { state: 'done' }, { state: 'READY' }]) assert.equal(parseStatus(bad), null, JSON.stringify(bad));
  const s = parseStatus({ state: 'available', current: 7, autoCheck: 'no', available: { version: '\u202E0.7.0', notes: 3, date: 'soon' }, progress: { downloaded: -1 }, lastCheck: 'yesterday', busy: 'yes' });
  assert.deepEqual(s, { current: null, autoCheck: true, autoInstall: true, state: 'available', available: { version: '0.7.0', notes: '', date: null }, progress: null, lastCheck: null, error: null, busy: null });
  assert.equal(parseStatus(status({ autoCheck: false, autoInstall: false })).autoInstall, false);
  assert.equal(lastCheckText(parseStatus(status({ lastCheck: '2026-11-24T11:59:00Z' })), Date.parse('2026-11-24T12:00:00Z')).startsWith('Last checked '), true);
  assert.equal(lastCheckText(parseStatus(status())), 'Not checked yet');
});

test('busy: the reason names the active runs and the waiting question, and holds the install back', () => {
  assert.equal(busyReason(null), '');
  assert.equal(busyReason({ running: 0, waitingForHuman: 0 }), '');
  assert.equal(busyReason({ running: 1, waitingForHuman: 0 }), '1 run active');
  assert.equal(busyReason({ running: 2, waitingForHuman: 0 }), '2 runs active');
  assert.equal(busyReason({ running: 0, waitingForHuman: 1 }), 'a run waits for your answer');
  assert.equal(busyReason({ running: 0, waitingForHuman: true }), 'a run waits for your answer', 'a flag counts as one question');
  assert.equal(busyReason({ running: 2, waitingForHuman: 3 }), '2 runs active, 3 runs wait for your answer');
  assert.equal(busyReason({ running: -1, waitingForHuman: 'x' }), '');

  const free = updateActions(parseStatus(offer('ready')));
  assert.deepEqual(free.install, { shown: true, disabled: false, reason: '' });
  const held = updateActions(parseStatus(offer('ready', { busy: { running: 2, waitingForHuman: 0 } })));
  assert.deepEqual(held.install, { shown: true, disabled: true, reason: '2 runs active' });
  assert.deepEqual(updateActions(parseStatus(offer('available'))).download, { shown: true, disabled: false });
  assert.equal(updateActions(parseStatus(offer('available'))).install.shown, false);
  for (const state of ['checking', 'downloading', 'installing']) assert.equal(updateActions(parseStatus(offer(state))).check.disabled, true, state);
});

test('panel: Restart and update is disabled with the busy reason, in Settings and in the ready line', async () => {
  const shell = fakeShell({ update_status: offer('ready', { busy: { running: 0, waitingForHuman: 1 } }) });
  const { $ } = await panel(shell);
  assert.deepEqual(shell.calls, [['update_status']]);
  assert.equal($('prefs-update-state').textContent, 'Scranton 0.7.0 is ready - installs at the next start');
  assert.deepEqual([$('prefs-update-install').hidden, $('prefs-update-install').disabled], [false, true]);
  assert.deepEqual([$('prefs-update-busy').hidden, $('prefs-update-busy').textContent], [false, 'Restart and update waits: a run waits for your answer']);
  assert.deepEqual([$('update-ready').hidden, $('update-ready-text').textContent], [false, 'Scranton 0.7.0 is ready - installs at the next start']);
  assert.deepEqual([$('update-ready-restart').disabled, $('update-ready-busy').textContent], [true, '(a run waits for your answer)']);

  shell.emit(offer('ready', { busy: { running: 0, waitingForHuman: 0 } }));
  assert.deepEqual([$('prefs-update-install').disabled, $('prefs-update-busy').hidden, $('update-ready-restart').disabled, $('update-ready-busy').hidden], [false, true, false, true]);
});

test('panel: the server says when the runs are done; the shell keeps the counts of its last refusal', async (t) => {
  const stale = offer('ready', { error: 'busy', busy: { running: 2, waitingForHuman: 0 } });
  let counts = { running: 1, waitingForHuman: 0 };
  const shell = fakeShell({ update_status: stale, update_install: () => { throw offer('ready', { error: 'busy', busy: { running: 0, waitingForHuman: 1 } }); } });
  const { $, asked } = await panel(shell, { server: () => counts, busyEvery: 5 });
  // leaving the ready state ends the asking, also when an assertion fails first
  t.after(() => shell.emit(offer('installing')));
  await tick();
  assert.equal(asked[0][0], '/api/app/busy');
  assert.deepEqual([asked[0][1].headers, asked[0][1].credentials, asked[0][1].cache], [{ 'X-Scranton-Client': '1' }, 'same-origin', 'no-store']);
  assert.equal($('prefs-update-busy').textContent, 'Restart and update waits: 1 run active', 'the server over the stale shell counts');

  counts = { running: 0, waitingForHuman: 0 };
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(asked.length >= 2, 'asked again while the update waits');
  assert.deepEqual([$('prefs-update-install').disabled, $('prefs-update-busy').hidden, $('update-ready-restart').disabled], [false, true, false]);

  await $('update-ready-restart').fire('click');
  assert.equal($('prefs-update-action').textContent, 'Not now: a run waits for your answer. Restart and update when the runs are done.', 'a refused install is the newest word');
  assert.equal($('update-ready-restart').disabled, true);

  shell.emit(offer('installing'));
  const after = asked.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked.length, after, 'nothing is asked once the update is no longer waiting');
});

test('panel: the buttons and toggles call the shell and show what it answers', async () => {
  let saved = { autoCheck: true, autoInstall: true };
  const shell = fakeShell({
    update_status: () => status({ ...saved, lastCheck: '2026-11-24T11:00:00Z' }),
    update_check: () => offer('available', saved),
    update_download: () => offer('downloading', { ...saved, progress: { downloaded: 0, total: 2000 } }),
    update_set_settings: (args) => { saved = { ...saved, ...args }; return offer('available', saved); },
    update_install: () => offer('installing', saved),
  });
  const { $ } = await panel(shell);
  assert.deepEqual([$('prefs-update-app').hidden, $('prefs-update-browser').hidden], [false, true]);
  assert.equal($('prefs-update-version').textContent, '0.6.0');
  assert.equal($('prefs-update-state').textContent, 'Not checked yet');
  assert.match($('prefs-update-checked').textContent, /^Last checked \d\d:\d\d:\d\d$/);
  assert.deepEqual([$('prefs-update-auto-check').checked, $('prefs-update-auto-check').disabled, $('prefs-update-auto-install').checked], [true, false, true]);
  assert.deepEqual([$('prefs-update-check').hidden, $('prefs-update-download').hidden, $('prefs-update-install').hidden], [false, true, true]);

  await $('prefs-update-check').fire('click');
  assert.deepEqual(shell.calls.at(-1), ['update_check']);
  assert.equal($('prefs-update-state').textContent, 'Scranton 0.7.0 is available');
  assert.equal($('prefs-update-download').hidden, false);
  assert.deepEqual([$('prefs-update-notes-box').hidden, $('prefs-update-notes-title').textContent, $('prefs-update-notes').textContent],
    [false, 'Release notes of Scranton 0.7.0 - 2026-11-24', 'Faster start.']);

  $('prefs-update-auto-check').checked = false;
  await $('prefs-update-auto-check').fire('change');
  assert.deepEqual(shell.calls.at(-1), ['update_set_settings', { autoCheck: false }]);
  assert.equal($('prefs-update-auto-check').checked, false);
  $('prefs-update-auto-install').checked = false;
  await $('prefs-update-auto-install').fire('change');
  assert.deepEqual(shell.calls.at(-1), ['update_set_settings', { autoInstall: false }]);
  assert.deepEqual(saved, { autoCheck: false, autoInstall: false });

  await $('prefs-update-download').fire('click');
  assert.deepEqual(shell.calls.at(-1), ['update_download']);
  assert.equal($('prefs-update-state').textContent, 'Downloading Scranton 0.7.0: 0%');
  assert.deepEqual([$('prefs-update-state').dataset.tone, $('prefs-update-check').disabled, $('prefs-update-download').hidden], ['busy', true, true]);

  shell.emit(offer('ready', saved));
  assert.equal($('prefs-update-state').textContent, 'Scranton 0.7.0 is ready to install');
  await $('update-ready-restart').fire('click');
  assert.deepEqual(shell.calls.at(-1), ['update_install']);
  assert.equal($('prefs-update-state').textContent, 'Installing Scranton 0.7.0. Scranton restarts when it is done.');
  assert.deepEqual([$('prefs-update-install').disabled, $('update-ready').hidden], [true, true]);
});

test('panel: a refused command keeps the saved setting and says why; one command at a time', async () => {
  let release;
  const shell = fakeShell({
    update_status: status(),
    update_set_settings: () => { throw 'settings file is read-only'; },
    update_check: () => new Promise((r) => { release = () => r(offer('up_to_date')); }),
    update_install: () => { throw offer('ready', { busy: { running: 2, waitingForHuman: 0 } }); },
  });
  const { $ } = await panel(shell);
  $('prefs-update-auto-install').checked = false;
  await $('prefs-update-auto-install').fire('change');
  assert.equal($('prefs-update-auto-install').checked, true, 'back to what the shell has');
  assert.deepEqual([$('prefs-update-action').textContent, $('prefs-update-action').dataset.tone], ['The setting was not saved: settings file is read-only', 'error']);

  $('prefs-update-check').fire('click');
  await tick();
  assert.deepEqual([$('prefs-update-check').disabled, $('prefs-update-auto-check').disabled], [true, true], 'the controls wait for the answer');
  $('prefs-update-check').fire('click');
  assert.equal(shell.calls.filter(([n]) => n === 'update_check').length, 1);
  release();
  await tick();
  assert.equal($('prefs-update-state').textContent, 'Scranton is up to date');
  assert.equal($('prefs-update-action').textContent, '');

  shell.emit(offer('ready'));
  await $('prefs-update-install').fire('click');
  assert.equal($('prefs-update-action').textContent, 'Not now: 2 runs active. Restart and update when the runs are done.');
  assert.deepEqual([$('prefs-update-install').disabled, $('prefs-update-busy').textContent], [true, 'Restart and update waits: 2 runs active']);
  assert.deepEqual(refusal({ busy: { running: 1, waitingForHuman: false } }), { status: null, busy: { running: 1, waitingForHuman: 0 }, message: '' });

  // the shell rejects a failed check with its error state: said once, in the state line
  const offline = fakeShell({ update_status: status(), update_check: () => { throw status({ state: 'error', error: 'Could not check for updates. Check your connection and try again.' }); } });
  const { $: $off } = await panel(offline);
  await $off('prefs-update-check').fire('click');
  assert.deepEqual([$off('prefs-update-state').textContent, $off('prefs-update-state').dataset.tone], ['Update failed: Could not check for updates. Check your connection and try again.', 'error']);
  assert.equal($off('prefs-update-action').textContent, '');
  assert.equal($off('prefs-update-check').disabled, false, 'the next check can be asked for');
});

test('events: update-status re-renders whatever state it carries; a malformed payload is ignored', async () => {
  const shell = fakeShell({ update_status: status() });
  const { $, u } = await panel(shell);
  assert.deepEqual(shell.listeners.map(([name]) => name), ['update-status']);
  for (const state of UPDATE_STATES) {
    shell.emit(offer(state, state === 'error' ? { error: 'timed out' } : {}));
    assert.equal(u.status().state, state);
    assert.equal($('prefs-update-state').textContent, stateLine(parseStatus(offer(state, state === 'error' ? { error: 'timed out' } : {}))).text, state);
    assert.equal($('update-ready').hidden, state !== 'ready', state);
  }
  shell.emit({ state: 'exploded' });
  shell.emit(null);
  assert.equal(u.status().state, 'error');
});

test('browser: no shell, no command; the page says how Scranton updates and links the releases', async () => {
  delete globalThis.__TAURI__;
  assert.equal(updaterApi(undefined), null);
  assert.equal(updaterApi({ core: {} }), null);
  const { $, u } = await panel(undefined);
  assert.equal(u.desktop, false);
  assert.deepEqual([$('prefs-update-browser').hidden, $('prefs-update-app').hidden, $('update-ready').hidden], [false, true, true]);
  assert.equal($('prefs-update-browser-text').textContent, 'Updates are installed by the desktop app; a source checkout updates with git pull.');
  assert.equal(BROWSER_TEXT, $('prefs-update-browser-text').textContent);
  const box = html.match(/<div class="field" id="prefs-update-browser" hidden>[\s\S]*?<\/div>/)?.[0];
  assert.ok(box);
  assert.match(box, new RegExp(`<a class="update-link" href="${RELEASES_URL}" target="_blank" rel="noopener noreferrer">[^<]+</a>`));
  assert.equal(RELEASES_URL, 'https://github.com/ypuma/scranton/releases');

  // a desktop app from before the updater: the same text box, with what to do instead
  const old = fakeShell({ update_status: () => { throw 'Command update_status not found'; } });
  const { $: $old } = await panel(old);
  assert.deepEqual([$old('prefs-update-app').hidden, $old('prefs-update-browser').hidden], [true, false]);
  assert.equal($old('prefs-update-browser-text').textContent, UNAVAILABLE_TEXT);
});

test('notes: plain text only, even with markup in them', async () => {
  assert.equal(plainNotes(SCRIPT_NOTES), 'Fixes:\n- <script>alert(1)</script> no longer runs\n\n- <img src=x onerror=alert(2)>');
  assert.equal(plainNotes('a\u0000b\u001Bc\u202Ed\te'), 'abcd\te');
  assert.equal(plainNotes('x'.repeat(9000)).length, 8000);
  assert.equal(notesOf(parseStatus(offer('up_to_date'))), null, 'no notes for a release that is not on offer');

  const shell = fakeShell({ update_status: offer('available', { available: { version: '0.7.0', notes: SCRIPT_NOTES, date: null } }) });
  const { $ } = await panel(shell);
  const notes = $('prefs-update-notes');
  assert.equal(notes.textContent, plainNotes(SCRIPT_NOTES), 'set as text, so the markup is shown and never parsed');
  assert.deepEqual(notes.childNodes, []);
  assert.equal($('prefs-update-notes-title').textContent, 'Release notes of Scranton 0.7.0');
  const source = readFileSync(new URL('../../visualizer/public/js/update-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|createElement/);
  assert.match(readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8'), /\.update-notes \{[^}]*white-space: pre-wrap;/);
});

test('markup: the Updates group and the ready line start hidden until the script knows the shell', () => {
  const group = html.match(/<fieldset class="exec" id="prefs-updates">[\s\S]*?<\/fieldset>/)?.[0];
  assert.ok(group, 'Settings has an Updates group');
  assert.match(group, /<legend>Updates<\/legend>/);
  assert.match(group, /<div class="update-app" id="prefs-update-app" hidden>/);
  for (const label of ['Check now', 'Download', 'Restart and update']) assert.match(group, new RegExp(`<button type="button" class="btn[^"]*" id="prefs-update-[a-z]+"[^>]* hidden>${label}</button>`), label);
  assert.match(group, /<input type="checkbox" id="prefs-update-auto-check" disabled><span>Check for updates automatically /);
  assert.match(group, /<input type="checkbox" id="prefs-update-auto-install" disabled><span>Install updates automatically at the next start /);
  assert.match(group, /id="prefs-update-state" role="status" aria-live="polite"/);
  assert.match(html, /<p class="update-ready" id="update-ready" role="status" hidden>[\s\S]*?<button type="button" class="link-btn" id="update-ready-restart"[^>]*>Restart now<\/button><\/p>/);
});
