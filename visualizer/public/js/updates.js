// Pure logic of the desktop app's auto-update (.enma/updater-contract.md §4, §5): the status object the Rust shell
// answers every update command with and emits as `update-status`, the texts Settings shows for it, and the bridge
// to the shell's commands. Release notes are plain text and stay plain text. No DOM, so Node can test it.
import { stripBidi, formatWhen } from './format.js';
import { clip } from './control.js';

export const UPDATE_STATES = ['idle', 'checking', 'up_to_date', 'available', 'downloading', 'ready', 'installing', 'unsupported', 'error'];
export const UPDATE_EVENT = 'update-status';
export const UPDATE_COMMANDS = { status: 'update_status', check: 'update_check', download: 'update_download', settings: 'update_set_settings', install: 'update_install' };
export const RELEASES_URL = 'https://github.com/ypuma/scranton/releases';
export const BROWSER_TEXT = 'Updates are installed by the desktop app; a source checkout updates with git pull.';
export const UNAVAILABLE_TEXT = 'This version of the desktop app cannot update itself. Install a newer version from the releases page once.';
const VERSION_MAX = 64;
const ERROR_MAX = 300;
const NOTES_MAX = 8000;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const line = (v, max) => (typeof v === 'string' ? clip(stripBidi(v), max) : '');

// Notes as the release wrote them, minus what could hide or reorder text: line breaks and tabs survive.
export function plainNotes(text) {
  if (typeof text !== 'string') return '';
  const t = stripBidi(text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > NOTES_MAX ? `${t.slice(0, NOTES_MAX - 3)}...` : t;
}

// { running, waitingForHuman } -> both as counts; a shell that sends a flag for the question counts it as one
export function parseBusy(doc) {
  const b = obj(doc);
  if (!b) return null;
  const waiting = b.waitingForHuman === true ? 1 : b.waitingForHuman === false ? 0 : count(b.waitingForHuman) ?? 0;
  return { running: count(b.running) ?? 0, waitingForHuman: waiting };
}

// -> the status object, or null when it is none (no known state)
export function parseStatus(doc) {
  const d = obj(doc);
  if (!d || !UPDATE_STATES.includes(d.state)) return null;
  const a = obj(d.available);
  const version = a ? line(a.version, VERSION_MAX) : '';
  const p = obj(d.progress);
  const downloaded = p ? count(p.downloaded) : null;
  const total = p ? count(p.total) : null;
  return {
    current: line(d.current, VERSION_MAX) || null,
    autoCheck: d.autoCheck !== false,
    autoInstall: d.autoInstall !== false,
    state: d.state,
    available: version ? { version, notes: plainNotes(a.notes), date: iso(a.date) } : null,
    progress: downloaded === null ? null : { downloaded, total: total || null },
    lastCheck: iso(d.lastCheck),
    error: line(d.error, ERROR_MAX) || null,
    busy: parseBusy(d.busy),
  };
}

// '' while nothing holds the install back, else '2 runs active', 'a run waits for your answer' or both
export function busyReason(busy) {
  const b = parseBusy(busy);
  if (!b) return '';
  const parts = [];
  if (b.running) parts.push(`${b.running} ${b.running === 1 ? 'run' : 'runs'} active`);
  if (b.waitingForHuman) parts.push(b.waitingForHuman === 1 ? 'a run waits for your answer' : `${b.waitingForHuman} runs wait for your answer`);
  return parts.join(', ');
}

function size(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const named = (s) => (s.available ? `Scranton ${s.available.version}` : 'the update');

// The automatic install happens only when it is on; otherwise a ready download waits for Restart and update.
export function readyText(s) {
  if (s?.state !== 'ready') return '';
  return s.autoInstall ? `${named(s)} is ready - installs at the next start` : `${named(s)} is ready to install`;
}

// -> { text, tone: '' | 'busy' | 'error' } for the state line
export function stateLine(s) {
  if (!s) return { text: 'Update status unknown', tone: '' };
  switch (s.state) {
    case 'checking': return { text: 'Checking for updates', tone: 'busy' };
    case 'up_to_date': return { text: 'Scranton is up to date', tone: '' };
    case 'available': return { text: `${named(s)} is available`, tone: '' };
    case 'downloading': {
      const p = s.progress;
      const done = !p ? '' : p.total ? `: ${Math.min(100, Math.floor((p.downloaded / p.total) * 100))}%` : p.downloaded ? `: ${size(p.downloaded)}` : '';
      return { text: `Downloading ${named(s)}${done}`, tone: 'busy' };
    }
    case 'ready': return { text: readyText(s), tone: '' };
    case 'installing': return { text: `Installing ${named(s)}. Scranton restarts when it is done.`, tone: 'busy' };
    case 'unsupported': return { text: 'No update for this platform yet', tone: '' };
    case 'error': return { text: s.error ? `Update failed: ${s.error}` : 'Update failed', tone: 'error' };
    default: return { text: 'Not checked yet', tone: '' };
  }
}

export function lastCheckText(s, now = Date.now()) {
  return s?.lastCheck ? `Last checked ${formatWhen(s.lastCheck, now)}` : 'Not checked yet';
}

// What the buttons offer for a state. reason: why Restart and update waits, '' when it does not.
export function updateActions(s) {
  const state = s?.state;
  const working = ['checking', 'downloading', 'installing'].includes(state);
  const reason = busyReason(s?.busy);
  return {
    check: { shown: Boolean(s), disabled: working },
    download: { shown: state === 'available', disabled: false },
    install: { shown: state === 'ready' || state === 'installing', disabled: state === 'installing' || reason !== '', reason },
  };
}

// The notes of the release on offer, while there is one to look at
export function notesOf(s) {
  if (!s?.available?.notes || !['available', 'downloading', 'ready', 'installing'].includes(s.state)) return null;
  const date = s.available.date ? ` - ${s.available.date.slice(0, 10)}` : '';
  return { title: `Release notes of Scranton ${s.available.version}${date}`, text: s.available.notes };
}

// A rejected command: the shell rejects with the status object; anything else is a message.
export function refusal(err) {
  const status = parseStatus(err);
  const busy = status ? null : parseBusy(obj(err)?.busy);
  const raw = typeof err === 'string' ? err : obj(err) ? (err.error ?? err.message) : '';
  return { status, busy, message: line(typeof raw === 'string' ? raw : '', ERROR_MAX) };
}

// a shell from before the updater has none of the commands
export const missingCommand = (message) => /not found|unknown command|not allowed/i.test(message ?? '');

// The desktop shell's update commands and event (withGlobalTauri), or null in a browser.
export function updaterApi(tauri = globalThis.__TAURI__) {
  const invoke = tauri?.core?.invoke;
  if (typeof invoke !== 'function') return null;
  const listen = tauri?.event?.listen;
  return {
    call: (name, args) => (args === undefined ? invoke(name) : invoke(name, args)),
    listen: typeof listen === 'function' ? (fn) => listen(UPDATE_EVENT, (event) => fn(event?.payload)) : null,
  };
}
