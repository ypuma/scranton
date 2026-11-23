// The Settings drawer: appearance, notifications and what the New run form starts with, all kept on this
// computer and applied as they change, voice dictation, and the desktop app's updates. Accounts and agents keep
// their own drawers; Settings opens them.
import { store } from './control-panel.js';
import { WORKFLOW_KEY, parseStoredWorkflow } from './control.js';
import { PREFS_KEY, RUN_DEFAULTS_KEY, parsePrefs, applyPrefs, parseParallel, parseRunDefaults } from './prefs.js';
import { relayTarget, relayCommands, mayBeRelay, relayPaired } from './phone-relay.js';
import { createUpdates } from './update-panel.js';
import { createVoiceSettings } from './voice-panel.js';

const $ = (id) => document.getElementById(id);

// before the first paint of anything that reads them
export function loadPrefs() {
  const prefs = parsePrefs(store.get(PREFS_KEY));
  applyPrefs(document.documentElement, prefs);
  return prefs;
}

// voice: the dictation of the page (dictation.js); confirm: the shared confirm dialog
export function createSettings({ voice = null, confirm = null } = {}) {
  const e = {
    dialog: $('prefs-dialog'), open: $('bar-settings'),
    density: $('prefs-density'), motion: $('prefs-motion'), color: $('prefs-color'),
    notify: $('prefs-notify'), notifyRow: $('prefs-notify-row'), notifyHint: $('prefs-notify-hint'), bell: $('notify-toggle'),
    parallel: $('prefs-parallel'), parallelHint: $('prefs-parallel-hint'), sandbox: $('prefs-sandbox'),
    workflowNote: $('prefs-workflow-note'), workflowReset: $('prefs-workflow-reset'),
    accounts: $('prefs-accounts'), agents: $('prefs-agents'), linksNote: $('prefs-links-note'),
    accountsOpen: $('accounts-open'), agentsOpen: $('agents-open'), runActions: $('run-actions'),
  };
  const relay = { box: $('prefs-relay'), local: $('prefs-relay-local'), control: $('prefs-relay-control'), phone: $('prefs-relay-phone') };
  const target = relayTarget(location);
  if (target) {
    const commands = relayCommands(target.port);
    $('prefs-relay-port').textContent = target.port;
    $('prefs-relay-checkout').textContent = commands.checkout;
    $('prefs-relay-windows').textContent = commands.windows;
    $('prefs-relay-commands').hidden = !target.attached;
    $('prefs-relay-loopback').hidden = target.attached;
    relay.local.hidden = false;
    relay.box.hidden = false;
  }
  // asked when Settings opens, until a paired relay session is proven
  let paired = false;
  let asking = null;
  function checkPaired() {
    if (paired || asking || !mayBeRelay(location)) return;
    asking = relayPaired().then((yes) => {
      asking = null;
      if (!yes) return;
      paired = true;
      relay.phone.hidden = false;
      relay.box.hidden = false;
    });
  }
  const updates = createUpdates();
  const voicePrefs = voice ? createVoiceSettings({ voice, confirm }) : null;
  $('prefs-voice').hidden = !voicePrefs;
  let prefs = loadPrefs();
  const PARALLEL_HINT = e.parallelHint.textContent;

  function savePrefs(change) {
    prefs = { ...prefs, ...change };
    store.set(PREFS_KEY, JSON.stringify(prefs));
    applyPrefs(document.documentElement, prefs);
    fill();
  }

  function choice(group, value) {
    for (const b of group.querySelectorAll('.seg')) b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }

  function fill() {
    choice(e.density, prefs.density);
    choice(e.motion, prefs.motion);
    e.color.checked = prefs.color;
    // the bell of the top bar owns the permission and the choice; this is its other handle
    const blocked = e.bell.getAttribute('aria-disabled') === 'true';
    const off = e.bell.hidden || blocked;
    e.notify.disabled = off;
    e.notifyRow.dataset.disabled = String(off);
    e.notify.checked = !off && e.bell.getAttribute('aria-pressed') === 'true';
    e.notifyHint.textContent = e.bell.hidden ? 'not available in this window'
      : blocked ? 'blocked for this page in the browser\'s site settings' : 'when a run needs you or ends';
    const run = parseRunDefaults(store.get(RUN_DEFAULTS_KEY));
    if (document.activeElement !== e.parallel) e.parallel.value = run.maxParallel ? String(run.maxParallel) : '';
    e.sandbox.value = run.sandbox ?? '';
    const remembered = parseStoredWorkflow(store.get(WORKFLOW_KEY)) !== null;
    e.workflowNote.textContent = remembered
      ? 'New run starts with the gate stages you used last.'
      : 'New run starts with the stages of the project\'s configuration. The stages you pick for a run are remembered here.';
    e.workflowReset.hidden = !remembered;
    const controls = !e.runActions.hidden;
    e.accounts.hidden = !controls || e.accountsOpen.hidden;
    e.agents.hidden = !controls || e.agentsOpen.hidden;
    e.linksNote.hidden = !(e.accounts.hidden && e.agents.hidden);
    relay.control.hidden = controls || !target?.attached;
  }

  function saveRun(change) {
    const next = { ...parseRunDefaults(store.get(RUN_DEFAULTS_KEY)), ...change };
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === '') delete next[k];
    store.set(RUN_DEFAULTS_KEY, JSON.stringify(next));
  }

  for (const [group, name] of [[e.density, 'density'], [e.motion, 'motion']]) {
    group.addEventListener('click', (event) => {
      const b = event.target.closest?.('.seg');
      if (b?.dataset.value) savePrefs({ [name]: b.dataset.value });
    });
  }
  e.color.addEventListener('change', () => savePrefs({ color: e.color.checked }));
  e.notify.addEventListener('change', () => {
    e.bell.click();
    fill();
  });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (e.dialog.open) fill(); }).observe(e.bell, { attributes: true });
  }
  e.parallel.addEventListener('input', () => {
    const text = e.parallel.value.trim();
    const n = parseParallel(text);
    const bad = text !== '' && n === null;
    e.parallelHint.textContent = bad ? 'Enter a whole number from 1 to 32, or leave it empty.' : PARALLEL_HINT;
    e.parallelHint.dataset.tone = bad ? 'error' : '';
    if (bad) e.parallel.setAttribute('aria-invalid', 'true');
    else e.parallel.removeAttribute('aria-invalid');
    if (!bad) saveRun({ maxParallel: n });
  });
  e.sandbox.addEventListener('change', () => saveRun({ sandbox: e.sandbox.value }));
  e.workflowReset.addEventListener('click', () => {
    store.set(WORKFLOW_KEY, '');
    fill();
    e.workflowNote.focus?.();
  });
  // one modal at a time: Settings steps aside for the drawer it opens
  for (const [button, target] of [[e.accounts, e.accountsOpen], [e.agents, e.agentsOpen]]) {
    button.addEventListener('click', () => {
      e.dialog.close();
      target.click();
    });
  }

  e.open.addEventListener('click', () => {
    if (e.dialog.open) return;
    fill();
    checkPaired();
    updates.refresh();
    voicePrefs?.refresh();
    e.dialog.showModal();
    e.dialog.querySelector('[data-close]').focus();
  });
  for (const b of e.dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => e.dialog.close());
  // a press on the scrim beside the drawer closes it
  e.dialog.addEventListener('click', (event) => { if (event.target === e.dialog) e.dialog.close(); });
  e.dialog.addEventListener('close', () => {
    voicePrefs?.stop();
    e.open.focus();
  });
  fill();

  return { prefs: () => prefs };
}
