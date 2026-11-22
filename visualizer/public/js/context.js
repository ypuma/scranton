// Pure logic of the Context surface (.enma/context-contract.md sections 8 and 10, .enma/context-budget-contract.md
// sections 2, 9 and 11): the routes of a project's and a chat's context documents, tolerant parsers for them, the
// token estimate, the one-line indicator in the follow-up composer, the summary the drawer shows and the request
// bodies. No DOM, so Node can test it.
import { stripBidi } from './format.js';
import { clip, responseError } from './control.js';
import { PROJECT_ID_RE, CHAT_ID_RE } from './scope.js';

export const NOTES_MAX = 16000;
export const WINDOW_DEFAULT = 128000;
export const BUDGET_MIN = 256;
export const BUDGET_MAX = 200000;
export const BUDGET_MODES = ['percent', 'tokens'];
export const CAPPED = ['min', 'window', 'max', 'engine'];
export const DEFAULT_RULE = Object.freeze({ mode: 'percent', value: 10 });
// pipeline: the [min, max] tokens the Pipeline engine keeps its budget within; null when the server does not say
export const DEFAULTS = Object.freeze({ budget: DEFAULT_RULE, window: WINDOW_DEFAULT, percent: [1, 50], tokens: [1000, 200000], models: 32, pipeline: null, pipelineBytes: null });
export const METER_CELLS = 20;
export const PROJECT_ACTIONS = ['settings', 'notes'];
export const CHAT_ACTIONS = ['reset', 'restore'];
export const LAYER_TITLE = {
  notes: 'Project notes', memory: 'Project memory', 'other-chats': 'Other chats of this project',
  earlier: 'This chat - earlier turns', recent: 'This chat - recent turns',
};
export const ENGINE_LABEL = { team: 'Team', pipeline: 'Pipeline' };
export const UNREADABLE = 'The server sent a context answer this page cannot read.';
// the model a role without an agent default runs on, as accounts.js AUTOMATIC names it
export const DEFAULT_MODEL_LABEL = 'Automatic';

// the transport ceiling of a planner pack: exact: true promises the injected text, so it is never cut here
const TEXT_MAX = 800000;
const SECTIONS_MAX = 16;
const CHATS_MAX = 200;
const MODEL_ID_MAX = 513;
const QUERY_MAX = 256;
const SECTION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
// the server lists at most 50 nested AGENTS.md files; nestedCount is the full total
const NESTED_MAX = 50;
// no whitespace and no control characters (the recipient ids and query values of section 3)
const BARE_RE = /^[^\s\u0000-\u001F\u007F-\u009F]+$/u;
// model ids are map keys on the server
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const enc = encodeURIComponent;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const given = (v, fallback) => (Number.isInteger(v) && v >= 0 ? v : fallback);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const line = (v, max = 200) => (typeof v === 'string' ? clip(stripBidi(v), max) : '');
const block = (v) => (typeof v === 'string' ? stripBidi(v).slice(0, TEXT_MAX) : '');
const n = (v) => v.toLocaleString('en-US');
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
// -> '≈1 token', '≈4,210 tokens'; shown: the number as printed
export const tokenText = (k, shown = n(k)) => `≈${shown} ${k === 1 ? 'token' : 'tokens'}`;

// ------------------------------------------------------------ token estimate (section 2, identical to Node's)

// U+0000..U+007F and the cut mark: 1; the rest up to U+2E7F: 2; everything else, lone surrogates included: 4
export function units(text) {
  if (typeof text !== 'string') return 0;
  let u = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    u += c <= 0x7f || c === 0x2026 ? 1 : c <= 0x2e7f ? 2 : 4;
  }
  return u;
}

export const tokens = (text) => Math.ceil(units(text) / 4);

// n of d in percent, as text: '0', '<0.1', one decimal below 10, else a whole number
export function pct(k, d) {
  if (!Number.isFinite(k) || !Number.isFinite(d) || k <= 0 || d <= 0) return '0';
  const v = (k * 100) / d;
  if (v < 0.1) return '<0.1';
  const r = Math.round(v * 10) / 10;
  return r < 10 ? r.toFixed(1) : String(Math.round(v));
}

// 999 -> '999', 6200 -> '6.2k', 1000 -> '1k', 123456 -> '123k'
export function compactTokens(k) {
  const v = Number.isFinite(k) && k > 0 ? Math.round(k) : 0;
  if (v < 1000) return String(v);
  if (v < 100000) return `${Math.round(v / 100) / 10}k`;
  return `${Math.round(v / 1000)}k`;
}

// ------------------------------------------------------------ routes

export const modelIdOk = (v) => typeof v === 'string' && v.length <= MODEL_ID_MAX && BARE_RE.test(v) && !RESERVED.has(v);
const queryOk = (v) => typeof v === 'string' && v.length <= QUERY_MAX && BARE_RE.test(v);

// -> '/api/projects/:p/context[/settings|/notes]' or null for a bad id or action
export function contextUrl(projectId, action = '') {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  if (action && !PROJECT_ACTIONS.includes(action)) return null;
  return `/api/projects/${enc(projectId)}/context${action ? `/${action}` : ''}`;
}

// -> '/api/projects/:p/chats/:c/context[/reset|/restore]' or null. pick: the planner pick of a Pipeline chat
// ({ provider, model }); the read carries it as ?provider=&model=, both or neither
export function chatContextUrl(projectId, chatId, action = '', pick = null) {
  if (!contextUrl(projectId) || typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) return null;
  if (action && !CHAT_ACTIONS.includes(action)) return null;
  const q = !action && queryOk(pick?.provider) && queryOk(pick?.model) ? `?provider=${enc(pick.provider)}&model=${enc(pick.model)}` : '';
  return `/api/projects/${enc(projectId)}/chats/${enc(chatId)}/context${action ? `/${action}` : ''}${q}`;
}

// ------------------------------------------------------------ parsing

// { mode, value } within the ranges, else null
function ruleOf(v, ranges = DEFAULTS) {
  const r = obj(v);
  if (!r || !BUDGET_MODES.includes(r.mode) || !Number.isInteger(r.value)) return null;
  const [lo, hi] = ranges[r.mode];
  return r.value >= lo && r.value <= hi ? { mode: r.mode, value: r.value } : null;
}

// a recipient: { id: string | null (Automatic), window, known }
function recipientOf(v) {
  const m = obj(v) ?? {};
  const ok = Number.isSafeInteger(m.window) && m.window > 0;
  return { id: modelIdOk(m.id) ? m.id : null, window: ok ? m.window : WINDOW_DEFAULT, known: ok && m.known === true };
}

// the overrides are keyed by user input: built without a prototype, reserved names refused
function settingsOf(v, valid) {
  const s = (valid && obj(v)) || {};
  const models = Object.create(null);
  const m = obj(s.models);
  if (m) {
    for (const k of Object.keys(m).slice(0, DEFAULTS.models)) {
      const r = modelIdOk(k) ? ruleOf(m[k]) : null;
      if (r) models[k] = r;
    }
  }
  return { crossChat: s.crossChat !== false, budget: ruleOf(s.budget) ?? { ...DEFAULT_RULE }, models };
}

// a server may narrow the ranges of the contract, never widen them
function rangeOf(v, [lo, hi]) {
  return Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= lo && v[0] <= v[1] && v[1] <= hi ? [v[0], v[1]] : [lo, hi];
}

function defaultsOf(v) {
  const d = obj(v) ?? {};
  const ranges = { percent: rangeOf(d.percent, DEFAULTS.percent), tokens: rangeOf(d.tokens, DEFAULTS.tokens) };
  const p = d.pipeline, bytes = obj(d.pipelineBytes);
  const byteRange = (r) => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger) && r[0] > 0 && r[0] <= r[1] && r[1] <= 4 * BUDGET_MAX;
  return {
    budget: ruleOf(d.budget, ranges) ?? { ...DEFAULT_RULE },
    window: Number.isSafeInteger(d.window) && d.window > 0 ? d.window : WINDOW_DEFAULT,
    ...ranges,
    models: Number.isInteger(d.models) && d.models >= 0 && d.models <= DEFAULTS.models ? d.models : DEFAULTS.models,
    // optional: a server from before it sends none, and then nothing is clamped
    pipeline: Array.isArray(p) && p.length === 2 && p.every(Number.isInteger) && p[0] >= BUDGET_MIN && p[0] <= p[1] && p[1] <= BUDGET_MAX ? [p[0], p[1]] : null,
    pipelineBytes: bytes && byteRange(bytes.history) && byteRange(bytes.context) ? { history: [...bytes.history], context: [...bytes.context] } : null,
  };
}

// The project document -> what the drawer shows; malformed input gives the storage defaults with valid: false
export function parseProjectContext(doc) {
  const d = obj(doc);
  const valid = Boolean(d) && d.v === 2;
  const notes = (valid && obj(d.notes)) || {};
  // the editor's value: what the user typed comes back as it is, or the next Save would drop it
  const text = typeof notes.text === 'string' ? notes.text.slice(0, NOTES_MAX * 2) : '';
  return {
    valid,
    settings: settingsOf(d?.settings, valid),
    defaults: defaultsOf(valid && d.defaults),
    notes: { text, chars: given(notes.chars, text.length), tokens: given(notes.tokens, tokens(text)), limit: count(notes.limit) || NOTES_MAX, updatedAt: iso(notes.updatedAt) },
    instructions: valid ? parseInstructions(d.instructions) : undefined,
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
  return {
    id: s.id, title: line(s.title, 120) || LAYER_TITLE[s.id] || s.id, chars: given(s.chars, text.length), tokens: given(s.tokens, tokens(text)),
    text, exact: s.exact === true,
  };
}

function budgetOf(v, model) {
  const b = obj(v) ?? {};
  const mode = BUDGET_MODES.includes(b.mode) ? b.mode : null;
  return {
    tokens: count(b.tokens), used: count(b.used), mode, value: mode && Number.isInteger(b.value) && b.value > 0 ? b.value : null,
    source: b.source === 'model' && model.id ? 'model' : 'project', capped: CAPPED.includes(b.capped) ? b.capped : null,
  };
}

// The chat document (what the next turn of this chat would receive now); malformed input gives an empty
// document with valid: false
export function parseChatContext(doc) {
  const d = obj(doc);
  const valid = Boolean(d) && d.v === 2;
  const g = (k) => (valid && obj(d[k])) || {};
  const engine = valid && d.engine === 'pipeline' ? 'pipeline' : 'team';
  const t = g('turns');
  const model = recipientOf(valid && d.model);
  const dev = valid ? obj(d.developer) : null;
  const ids = new Set();
  let developer = null;
  // a Pipeline chat has no developer brief; a Team chat with an empty one still says so
  if (engine === 'team' && dev) {
    const text = block(dev.text);
    const db = obj(dev.budget) ?? {};
    developer = { model: recipientOf(dev.model), budget: { tokens: count(db.tokens), used: count(db.used) }, chars: given(dev.chars, text.length), tokens: given(dev.tokens, tokens(text)), text };
  }
  return {
    valid, engine,
    settings: settingsOf(d?.settings, valid),
    reset: valid && iso(obj(d.reset)?.at) ? { at: d.reset.at } : null,
    model,
    budget: budgetOf(valid && d.budget, model),
    turns: { total: count(t.total), visible: count(t.visible), detailed: count(t.detailed), condensed: count(t.condensed), omitted: count(t.omitted) },
    otherChats: { chats: count(g('otherChats').chats), turns: count(g('otherChats').turns) },
    notes: { chars: count(g('notes').chars), tokens: count(g('notes').tokens), limit: count(g('notes').limit) || NOTES_MAX, cut: g('notes').cut === true },
    memory: { chars: count(g('memory').chars), tokens: count(g('memory').tokens) },
    truncated: valid && d.truncated === true,
    degraded: valid && d.degraded === true,
    sections: (valid && Array.isArray(d.sections) ? d.sections.slice(0, SECTIONS_MAX) : []).map(parseSection).filter((s) => s && !ids.has(s.id) && ids.add(s.id)),
    developer,
    instructions: valid ? parseInstructions(d.instructions) : undefined,
  };
}

// The AGENTS.md summary of the project workspace (.enma/agents-md-contract.md, Audit and visibility). -> undefined
// when the server sends none or something unreadable (a server from before), null for no file at all, else
// { root, bytes, tokens, truncated, nested: [paths], more: the files not listed, partial: the subfolder scan stopped early }
export function parseInstructions(v) {
  if (v === null) return null;
  const i = obj(v);
  if (!i) return undefined;
  const nested = (Array.isArray(i.nested) ? i.nested.slice(0, NESTED_MAX) : []).map((p) => line(p, 300)).filter(Boolean);
  const total = Number.isSafeInteger(i.nestedCount) && i.nestedCount >= nested.length ? i.nestedCount : nested.length;
  const more = total - nested.length;
  const root = typeof i.file === 'string' && i.file !== '';
  const partial = i.partial === true;
  // a scan that stopped early cannot say there is none
  if (!root && !total && !partial) return null;
  return { root, bytes: count(i.bytes), tokens: count(i.tokens), truncated: root && i.truncated === true, nested, more, partial };
}

// ------------------------------------------------------------ what is shown

export const modelText = (id) => (id ? stripBidi(id) : DEFAULT_MODEL_LABEL);

// -> 'Context: 5 turns · 2 other chats · notes · ≈6.2k tokens (3.1%)', '' for no document; the percentage is of
// the recipient's window. stale: the last read failed, this is older
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
  const what = parts.length ? parts.join(' · ') : d.sections.length ? 'reduced fallback' : 'none yet';
  const used = d.budget.used ? ` · ${tokenText(d.budget.used, compactTokens(d.budget.used))} (${pct(d.budget.used, d.model.window)}%)` : '';
  return `Context${stale ? ' (not current)' : ''}: ${what}${used}`;
}

// -> '≈4,210 of 20,000 tokens (21% of budget · 2.1% of the 200,000-token window)'
export function usageText(d) {
  const { used, tokens: budget } = d.budget;
  const win = `${pct(used, d.model.window)}% of the ${n(d.model.window)}-token window`;
  return budget ? `≈${n(used)} of ${n(budget)} tokens (${pct(used, budget)}% of budget · ${win})` : `${tokenText(used)} (${win})`;
}

// the cells of the meter that are filled: none for nothing used, at least one for anything
export function meterFill(used, budget, cells = METER_CELLS) {
  if (!(used > 0) || !(budget > 0)) return 0;
  return Math.min(cells, Math.max(1, Math.round((used / budget) * cells)));
}

export const windowNote = (m) => (m.known ? '' : `Model window unknown - assuming ${n(m.window)} tokens`);

export function cappedText(d) {
  switch (d.budget.capped) {
    case 'min': return `The budget was limited to the minimum of ${n(BUDGET_MIN)} tokens; the rule asks for less.`;
    case 'window': return `The budget was limited to half of the model's ${n(d.model.window)}-token context window.`;
    case 'max': return `The budget was limited to the maximum of ${n(BUDGET_MAX)} tokens.`;
    case 'engine': return 'Set by the Pipeline engine\'s prompt budget, which bounds what the planner can receive.';
    default: return '';
  }
}

export const ruleText = (r) => (r.mode === 'percent' ? `${r.value}% of the model's context window` : `${n(r.value)} tokens`);

function budgetRow(d) {
  const b = d.budget;
  if (!b.mode || !b.value) return b.tokens ? `${n(b.tokens)} tokens` : 'Unknown';
  return `${ruleText(b)} · ${b.source === 'model' ? `only for ${modelText(d.model.id)}` : 'project rule'}`;
}

// -> [[label, value]] for the drawer's summary
export function summaryRows(d) {
  const t = d.turns;
  const hidden = t.total - t.visible;
  const turns = [`${t.detailed} in detail`, `${t.condensed} condensed`, `${t.omitted} omitted`].join(' · ');
  return [
    ['Turns', t.total ? `${t.visible} of ${t.total} · ${turns}${hidden > 0 && d.reset ? ` · ${hidden} hidden by the fresh start` : ''}` : 'No earlier turn yet'],
    ['Other chats', !d.settings.crossChat ? 'Sharing between chats is off' : d.otherChats.chats ? `${plural(d.otherChats.chats, 'chat', 'chats')} · ${plural(d.otherChats.turns, 'turn', 'turns')}` : 'None'],
    ['Project notes', d.notes.chars ? `${n(d.notes.chars)} of ${n(d.notes.limit)} characters · ${tokenText(d.notes.tokens)}${d.notes.cut ? ' · cut to fit the budget' : ''}` : 'None'],
    ['Project memory', d.memory.chars ? `${n(d.memory.chars)} ${d.memory.chars === 1 ? 'character' : 'characters'} · ${tokenText(d.memory.tokens)}` : 'None'],
    ['Model', `${modelText(d.model.id)} · ${n(d.model.window)}-token window${d.model.known ? '' : ' (assumed)'}`],
    ['Budget', budgetRow(d)],
  ];
}

// the developer brief has its own recipient and budget
export function developerText(dev) {
  const { used, tokens: budget } = dev.budget;
  const of = budget ? `≈${n(used)} of ${n(budget)} tokens (${pct(used, budget)}% of the brief's budget)` : tokenText(used);
  return `${of} · ${modelText(dev.model.id)}, ${n(dev.model.window)}-token window${dev.model.known ? '' : ' (assumed)'}`;
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

// 300 -> '0.3', 12345 -> '12'
const kb = (b) => {
  const v = b / 1024;
  return v >= 10 || v === 0 ? n(Math.round(v)) : String(Math.max(0.1, Math.round(v * 10) / 10));
};

// -> 'Repository instructions: AGENTS.md (12 KB, ~3,086 tokens) - 2 more in subfolders'; '' when the server says nothing
export function instructionsText(i) {
  if (i === undefined) return '';
  if (i === null) return 'No AGENTS.md in this project';
  const k = i.nested.length + i.more;
  const partial = i.partial ? ' - subfolder scan incomplete' : '';
  if (!i.root) return `No AGENTS.md at the project root${k ? ` - ${n(k)} in subfolders` : ''}${partial}`;
  const size = `${kb(i.bytes)} KB, ~${n(i.tokens)} ${i.tokens === 1 ? 'token' : 'tokens'}`;
  return `Repository instructions: AGENTS.md (${size})${i.truncated ? ' - truncated at 32 KiB' : ''}${k ? ` - ${n(k)} more in subfolders` : ''}${partial}`;
}

// the nested paths, one per line; '' for none
export const instructionsPaths = (i) => (i ? [...i.nested, ...(i.more ? [`(+${n(i.more)} more)`] : [])].join('\n') : '');

export const sectionNote = (s) => (s.exact ? 'Exact text the next turn receives.' : 'A readable summary of what the planner receives, not the literal text.');

// ------------------------------------------------------------ the budget control

// What the control starts from: the override of this recipient when there is one, else the project rule.
// d: the chat document, p: the project document (null until read). -> { id, override, mode, value, only }
export function budgetState(d, p) {
  const id = d?.model.id ?? null;
  const models = p?.settings.models ?? d?.settings.models ?? Object.create(null);
  const own = id && Object.hasOwn(models, id) ? models[id] : null;
  const r = own ?? p?.settings.budget ?? d?.settings.budget ?? DEFAULT_RULE;
  return { id, override: Boolean(own), mode: r.mode, value: String(r.value), only: Boolean(own) };
}

// §4 for the window of this recipient: what a rule gives before the Pipeline engine bounds it
export function budgetPreview(rule, window) {
  const raw = rule.mode === 'percent' ? Math.floor((window * rule.value) / 100) : rule.value;
  return Math.max(BUDGET_MIN, Math.min(raw, Math.min(BUDGET_MAX, Math.floor(window / 2))));
}

// Pipeline's separate byte allowances, not just its token range, determine the preview.
export function previewText(rule, d, defaults = DEFAULTS) {
  const k = budgetPreview(rule, d.model.window);
  const bytes = d.engine === 'pipeline' ? defaults.pipelineBytes : null;
  const range = bytes ? defaults.pipeline : null;
  const shown = bytes ? Math.floor((Math.max(bytes.history[0], Math.min(3 * k, bytes.history[1])) + Math.max(bytes.context[0], Math.min(k, bytes.context[1]))) / 4) : k;
  const tail = d.engine !== 'pipeline' ? ''
    : range ? `; the Pipeline engine keeps the budget between ${n(range[0])} and ${n(range[1])} tokens` : '; the Pipeline engine\'s prompt budget can raise or lower it';
  return `${tokenText(shown)} with the ${n(d.model.window)}-token window of ${modelText(d.model.id)}${tail}.`;
}

// Another mode keeps the budget it stands for, within the new mode's range. -> the value as text
export function switchMode(mode, value, window, defaults = DEFAULTS) {
  const v = Number(value);
  if (!BUDGET_MODES.includes(mode) || !Number.isInteger(v) || v <= 0) return mode === 'tokens' ? String(budgetPreview(DEFAULT_RULE, window)) : String(DEFAULT_RULE.value);
  const [lo, hi] = defaults[mode];
  const next = mode === 'tokens' ? Math.floor((window * v) / 100) : Math.round((v * 100) / window);
  return String(Math.min(hi, Math.max(lo, next)));
}

export const rangeText = (mode, defaults = DEFAULTS) => {
  const [lo, hi] = defaults[mode];
  return mode === 'percent' ? `percent, ${lo}-${hi}` : `tokens, ${n(lo)}-${n(hi)}`;
};

// form: { mode, value (text), only }; state: budgetState(); p: the project document.
// -> { body } (the settings patch of section 4) | { error, field: 'mode' | 'value' | 'only' }
export function buildBudget(form = {}, state = {}, p = null) {
  const defaults = p?.defaults ?? DEFAULTS;
  if (!BUDGET_MODES.includes(form.mode)) return { error: 'Choose a share of the context window or a fixed number of tokens.', field: 'mode' };
  const text = typeof form.value === 'string' ? form.value.trim() : '';
  const [lo, hi] = defaults[form.mode];
  const v = /^\d{1,7}$/.test(text) ? Number(text) : NaN;
  if (!(v >= lo && v <= hi)) {
    return { error: form.mode === 'percent' ? `Enter a whole number from ${lo} to ${hi} percent.` : `Enter a whole number of tokens from ${n(lo)} to ${n(hi)}.`, field: 'value' };
  }
  const rule = { mode: form.mode, value: v };
  const id = modelIdOk(state.id) ? state.id : null;
  if (form.only === true && id) {
    const models = p?.settings.models ?? Object.create(null);
    if (!Object.hasOwn(models, id) && Object.keys(models).length >= defaults.models) {
      return { error: `This project already has ${defaults.models} model overrides. Reset one of them first.`, field: 'only' };
    }
    return { body: { models: { [id]: rule } } };
  }
  // the project rule for every model: this model's override would still win, so it goes
  return { body: state.override && id ? { budget: rule, models: { [id]: null } } : { budget: rule } };
}

// Reset to default: the override of this recipient when one applies, else the project rule. -> { body }
export const buildBudgetReset = (state = {}) => ({ body: state.override && modelIdOk(state.id) ? { models: { [state.id]: null } } : { budget: null } });

// nothing to reset: no override applies and the project rule is the default
export const atDefault = (state, p) => !state.override && (!p || (p.settings.budget.mode === p.defaults.budget.mode && p.settings.budget.value === p.defaults.budget.value));

// ------------------------------------------------------------ the other changes

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

// -> '120 / 16,000 · ≈30 tokens'
export const notesCount = (text) => `${n(text.length)} / ${n(NOTES_MAX)} · ${tokenText(tokens(text))}`;

// a route this server does not have: single-hive mode, or a server from before the context system
export const unsupported = (status) => [404, 405, 501].includes(status);

// status: HTTP code (0 = no answer); data: the server's JSON error body
export function contextError(status, data) {
  if (status === 0) return 'The server did not answer. Is it still running?';
  const msg = typeof data?.error === 'string' ? line(data.error, 300) : '';
  if (status === 404) return msg && msg !== 'Not found' ? msg : 'This server does not offer context for this chat, or the chat is gone.';
  return responseError(status, data);
}
