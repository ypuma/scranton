// Engine-neutral logic of the Chat view (.enma/chat-view-contract.md section 7): the entries every adapter
// produces, cleaning of untrusted model text, the keyword chip, what counts as a long message, the runs of a
// conversation and what a screen reader is told. No DOM, so Node can test it and any adapter can reuse it.
//
// Entry: { id, runId, kind: 'request' | 'agent' | 'activity' | 'human' | 'question' | 'reply', ts,
//          who?: { id, name, title }, context?, text?, final?, truncated?, tone?: 'ok' | 'fail' | 'warn' | null,
//          replyKind?: 'answer' | 'report' | 'summary' | 'result' }
// A reply's context is its outcome line; a question with tone 'warn' is still waiting for its answer.
import { stripBidi, formatWhen } from './format.js';

export const ENTRY_KINDS = ['request', 'agent', 'activity', 'human', 'question', 'reply'];
export const REPLY_KINDS = ['answer', 'report', 'summary', 'result'];
export const REPLY_LABEL = { answer: 'Answer', report: 'Report', summary: 'Summary', result: 'Result' };
// the cap of agent_message.text and run_reply.text
export const TEXT_MAX = 16000;
// the user's own request is shown in full: a Team request is at most 32768 chars, a Pipeline task 32768 bytes
export const REQUEST_TEXT_MAX = 32768;
// a message longer than about this many lines of the reading column is collapsed
export const LONG_LINES = 12;
export const LONG_CHARS = 1200;

// C0 and C1 controls except tab and line feed: a model can emit them, a terminal escape among them
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Untrusted text as it may be shown: no bidi or control characters, Unix line ends, at most max characters.
// -> { text, truncated }
export function cleanText(v, max = TEXT_MAX) {
  const t = stripBidi(typeof v === 'string' ? v : '').replace(/\r\n?/g, '\n').replace(CONTROLS, '');
  return t.length > max ? { text: t.slice(0, max), truncated: true } : { text: t, truncated: false };
}

// The same for a one-line field: white space collapsed, clipped with an ellipsis.
export function cleanLine(v, max = 200) {
  const t = cleanText(v, TEXT_MAX).text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

// A handoff keyword on its own last line ("[TASK_COMPLETE]") is shown as a chip, not as text.
// -> { text, keyword } (keyword null when the text does not end in one)
export function splitKeyword(text) {
  const t = String(text ?? '').replace(/\s+$/, '');
  const at = t.lastIndexOf('\n');
  const m = /^\s*\[([A-Z][A-Z0-9_]{1,39})\]$/.exec(t.slice(at + 1));
  return m ? { text: t.slice(0, Math.max(0, at)).replace(/\s+$/, ''), keyword: m[1] } : { text: t, keyword: null };
}

export function isLong(text) {
  const t = String(text ?? '');
  return t.length > LONG_CHARS || t.split('\n').length > LONG_LINES;
}

// The runs of a conversation in the order they first appear. -> [{ runId, entries }]
export function groupRuns(entries) {
  const runs = new Map();
  for (const x of entries ?? []) {
    if (!runs.has(x.runId)) runs.set(x.runId, []);
    runs.get(x.runId).push(x);
  }
  return [...runs].map(([runId, list]) => ({ runId, entries: list }));
}

// What an earlier run shows before its agent messages are asked for.
export function runDigest(entries) {
  return entries.filter((x) => x.kind === 'request' || x.kind === 'reply');
}

// Consecutive entries of one speaker read as one turn: its first message carries the label line (name, title,
// context, time), and the messages and tool lines that follow under the same speaker and context do without one.
// A tool line belongs to the turn when it names no other place than the label does. -> Set of the ids that follow
export function followers(entries) {
  const out = new Set();
  let lead = null;
  for (const x of entries ?? []) {
    const same = Boolean(lead && x.who && x.who.id === lead.who.id && x.who.name === lead.who.name);
    const label = lead?.context ?? '';
    if (x.kind === 'agent' && x.who) {
      if (same && (x.context ?? '') === label) out.add(x.id);
      else lead = x;
    } else if (x.kind === 'activity' && same && (!x.context || x.context === label || label.startsWith(`${x.context} `))) out.add(x.id);
    else lead = null;
  }
  return out;
}

// Whether the entry on screen has to be drawn again. Long texts never change under the same id, so they are
// compared by length and their ends.
export function entryKey(x, open = false) {
  const t = x.text ?? '';
  const text = t.length > 240 ? `${t.length}:${t.slice(0, 48)}:${t.slice(-48)}` : t;
  return JSON.stringify([x.kind, x.ts, x.who?.name, x.who?.title, x.context, text, x.final, x.truncated, x.tone, x.replyKind, open]);
}

// The accessible name of an entry: who, as what, about what, when.
export function entryLabel(x, now = Date.now()) {
  const name = x.who?.name || 'Scranton';
  const lead = x.kind === 'reply' ? `${REPLY_LABEL[x.replyKind] ?? 'Reply'} from ${name}`
    : x.kind === 'question' ? `Question from ${name}`
      : [name, x.who?.title].filter(Boolean).join(', ');
  const about = x.kind === 'reply' ? '' : x.context;
  const waiting = x.kind === 'question' && x.tone === 'warn' ? 'waiting for an answer' : '';
  return [lead, about, waiting, x.ts ? formatWhen(x.ts, now) : ''].filter(Boolean).join(', ');
}

// What the page announces: a new reply and a question that waits for its answer, nothing else. -> text or ''
export function announcement(x) {
  if (x.kind === 'reply') return `${REPLY_LABEL[x.replyKind] ?? 'Reply'} from ${x.who?.name || 'Scranton'}: ${cleanLine(splitKeyword(x.text).text, 160)}`;
  if (x.kind === 'question' && x.tone === 'warn') return `${x.who?.name || 'Scranton'} asks: ${cleanLine(x.text, 160)}`;
  return '';
}
