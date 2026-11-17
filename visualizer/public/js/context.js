// Pure logic of the Context surface (.enma/context-contract.md sections 8 and 10): the routes of a project's and a
// chat's context documents, tolerant parsers for them, the one-line indicator in the follow-up composer, the
// summary the drawer shows and the request bodies. No DOM, so Node can test it.
import { stripBidi } from './format.js';
import { clip, responseError } from './control.js';
import { PROJECT_ID_RE, CHAT_ID_RE } from './scope.js';

export const NOTES_MAX = 4000;
export const TEAM_BUDGET = 24000;
export const PIPELINE_BUDGET = 32768;
export const PROJECT_ACTIONS = ['settings', 'notes'];
export const CHAT_ACTIONS = ['reset', 'restore'];
export const LAYER_TITLE = {
  notes: 'Project notes', memory: 'Project memory', 'other-chats': 'Other chats of this project',
  earlier: 'This chat - earlier turns', recent: 'This chat - recent turns',
};
export const ENGINE_LABEL = { team: 'Team', pipeline: 'Pipeline' };
export const UNREADABLE = 'The server sent a context answer this page cannot read.';

// a pack is at most 24000 chars (Team) or 32768 wire bytes (Pipeline); anything longer is not a section of it
const TEXT_MAX = 40000;
const SECTIONS_MAX = 16;
const CHATS_MAX = 200;
const SECTION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const enc = encodeURIComponent;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const line = (v, max = 200) => (typeof v === 'string' ? clip(stripBidi(v), max) : '');
const block = (v) => (typeof v === 'string' ? stripBidi(v).slice(0, TEXT_MAX) : '');
const n = (v) => v.toLocaleString('en-US');
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

// -> '/api/projects/:p/context[/settings|/notes]' or null for a bad id or action
export function contextUrl(projectId, action = '') {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  if (action && !PROJECT_ACTIONS.includes(action)) return null;
  return `/api/projects/${enc(projectId)}/context${action ? `/${action}` : ''}`;
}

// -> '/api/projects/:p/chats/:c/context[/reset|/restore]' or null
export function chatContextUrl(projectId, chatId, action = '') {
  if (!contextUrl(projectId) || typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) return null;
  if (action && !CHAT_ACTIONS.includes(action)) return null;
  return `/api/projects/${enc(projectId)}/chats/${enc(chatId)}/context${action ? `/${action}` : ''}`;
}

const crossChatOf = (settings) => obj(settings)?.crossChat !== false;

// The project document -> what the drawer shows; malformed input gives the storage defaults with valid: false
export function parseProjectContext(doc) {
  const d = obj(doc);
  const valid = Boolean(d) && d.v === 1;
  const notes = (valid && obj(d.notes)) || {};
  // the editor's value: what the user typed comes back as it is, or the next Save would drop it
  const text = typeof notes.text === 'string' ? notes.text.slice(0, NOTES_MAX * 2) : '';
  return {
    valid,
    settings: { crossChat: valid ? crossChatOf(d.settings) : true },
    notes: { text, chars: Number.isInteger(notes.chars) && notes.chars >= 0 ? notes.chars : text.length, limit: count(notes.limit) || NOTES_MAX, updatedAt: iso(notes.updatedAt) },
    chats: (valid && Array.isArray(d.chats) ? d.chats.slice(0, CHATS_MAX) : []).map(obj).filter((c) => c && typeof c.id === 'string' && CHAT_ID_RE.test(c.id)).map((c) => ({
      id: c.id, title: line(c.title, 120) || 'Untitled chat', engine: c.engine === 'pipeline' ? 'pipeline' : 'team',
      turns: count(c.turns), lastActiveAt: iso(c.lastActiveAt), reset: c.reset === true,
    })),
  };
}

function parseSection(v) {
  const s = obj(v);
  if (!s || typeof s.id !== 'string' || !SECTION_ID_RE.test(s.id)) return null;
  const text = block(s.text);
  if (!text) return null;
  return { id: s.id, title: line(s.title, 120) || LAYER_TITLE[s.id] || s.id, chars: Number.isInteger(s.chars) && s.chars >= 0 ? s.chars : text.length, text, exact: s.exact === true };
}

// The chat document (what the next turn of this chat would receive now); malformed input gives an empty
// document with valid: false
export function parseChatContext(doc) {
  const d = obj(doc);
  const valid = Boolean(d) && d.v === 1;
  const g = (k) => (valid && obj(d[k])) || {};
  const engine = valid && d.engine === 'pipeline' ? 'pipeline' : 'team';
  const t = g('turns');
  const budget = g('budget');
  const dev = valid ? obj(d.developer) : null;
  const ids = new Set();
  return {
    valid, engine,
    settings: { crossChat: valid ? crossChatOf(d.settings) : true },
    reset: valid && iso(obj(d.reset)?.at) ? { at: d.reset.at } : null,
    turns: { total: count(t.total), visible: count(t.visible), detailed: count(t.detailed), condensed: count(t.condensed), omitted: count(t.omitted) },
    otherChats: { chats: count(g('otherChats').chats), turns: count(g('otherChats').turns) },
    notes: { chars: count(g('notes').chars), limit: count(g('notes').limit) || NOTES_MAX },
    memory: { chars: count(g('memory').chars) },
    budget: { limit: count(budget.limit) || (engine === 'pipeline' ? PIPELINE_BUDGET : TEAM_BUDGET), used: count(budget.used) },
    truncated: valid && d.truncated === true,
    degraded: valid && d.degraded === true,
    sections: (valid && Array.isArray(d.sections) ? d.sections.slice(0, SECTIONS_MAX) : []).map(parseSection).filter((s) => s && !ids.has(s.id) && ids.add(s.id)),
    // a Pipeline chat has no developer brief; a Team chat with an empty one still says so
    developer: engine === 'team' && dev ? { chars: count(dev.chars), text: block(dev.text) } : null,
  };
}

// -> 'Context: 5 turns · 2 other chats · notes', '' for no document; stale: the last read failed, this is older
export function contextLine(d, stale = false) {
  if (!d?.valid) return '';
  const parts = [];
  const k = d.turns.visible;
  if (k) parts.push(d.reset ? `${plural(k, 'turn', 'turns')} since the fresh start` : plural(k, 'turn', 'turns'));
  else if (d.reset) parts.push('fresh start');
  if (d.otherChats.chats) parts.push(plural(d.otherChats.chats, 'other chat', 'other chats'));
  if (d.notes.chars) parts.push('notes');
  if (d.memory.chars) parts.push('memory');
  // the legacy fallback has a section but no counters
  return `Context${stale ? ' (not current)' : ''}: ${parts.length ? parts.join(' · ') : d.sections.length ? 'reduced fallback' : 'none yet'}`;
}

const unit = (d) => (d.engine === 'pipeline' ? 'bytes' : 'characters');

export function budgetText(d) {
  const pct = d.budget.limit ? Math.round((d.budget.used / d.budget.limit) * 100) : 0;
  return `${n(d.budget.used)} of ${n(d.budget.limit)} ${unit(d)} (${pct}%)`;
}

// -> [[label, value]] for the drawer's summary
export function summaryRows(d) {
  const t = d.turns;
  const hidden = t.total - t.visible;
  const turns = [`${t.detailed} in detail`, `${t.condensed} condensed`, `${t.omitted} omitted`].join(' · ');
  return [
    ['Turns', t.total ? `${t.visible} of ${t.total} · ${turns}${hidden > 0 && d.reset ? ` · ${hidden} hidden by the fresh start` : ''}` : 'No earlier turn yet'],
    ['Other chats', !d.settings.crossChat ? 'Sharing between chats is off' : d.otherChats.chats ? `${plural(d.otherChats.chats, 'chat', 'chats')} · ${plural(d.otherChats.turns, 'turn', 'turns')}` : 'None'],
    ['Project notes', d.notes.chars ? `${n(d.notes.chars)} of ${n(d.notes.limit)} characters` : 'None'],
    ['Project memory', d.memory.chars ? `${n(d.memory.chars)} characters` : 'None'],
    ['Budget used', budgetText(d)],
  ];
}

// the flags the server raised, in words; '' when there is none
export function flagsText(d) {
  const out = [];
  if (d.truncated) out.push('Some turns were shortened or left out to fit the limits.');
  if (d.degraded) out.push('Degraded: part of the context could not be read and was left out. The next turn still starts.');
  return out.join(' ');
}

export function resetText(d, fmt) {
  if (!d.reset) return 'Every finished turn of this chat counts. The run that is live now never does.';
  return `Started fresh ${fmt(d.reset.at)}. Turns of this chat that started before then are left out of every pack, including the other chats' view of this one. They stay in the history. Project notes and memory are not affected.`;
}

export const resetQuestion = (d) => {
  const k = d.turns.visible;
  const what = k ? `the ${plural(k, 'earlier turn', 'earlier turns')} of this chat` : 'the earlier turns of this chat';
  return `Leave ${what} out of the next turns? They are also left out of what the other chats of this project see of this chat. Project notes and project memory stay as they are. Nothing is deleted, and Restore earlier turns brings them back.`;
};

export const sectionNote = (s) => (s.exact ? 'Exact text the next turn receives.' : 'A readable summary of what the planner receives, not the literal text.');

// -> { body } | { error }
export function buildCrossChat(value) {
  if (typeof value !== 'boolean') return { error: 'Sharing is on or off.' };
  return { body: { crossChat: value } };
}

// -> { body } | { error, field }; the limit is the JS string length, the unit of the textarea's maxlength and the server's
export function buildNotes(text) {
  if (typeof text !== 'string') return { error: 'The notes are text.', field: 'notes' };
  const value = text.replace(/\r\n?/g, '\n');
  const k = value.length;
  if (k > NOTES_MAX) return { error: `The notes are ${n(k)} characters; the limit is ${n(NOTES_MAX)}.`, field: 'notes' };
  return { body: { text: value } };
}

// a route this server does not have: single-hive mode, or a server from before the context system
export const unsupported = (status) => [404, 405, 501].includes(status);

// status: HTTP code (0 = no answer); data: the server's JSON error body
export function contextError(status, data) {
  if (status === 0) return 'The server did not answer. Is it still running?';
  const msg = typeof data?.error === 'string' ? line(data.error, 300) : '';
  if (status === 404) return msg && msg !== 'Not found' ? msg : 'This server does not offer context for this chat, or the chat is gone.';
  return responseError(status, data);
}
