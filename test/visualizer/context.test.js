// The Context surface (.enma/context-contract.md sections 8 and 10, .enma/context-budget-contract.md sections 2, 9
// and 11): the routes, the token estimate, the tolerant parsers of the v2 project and chat documents, the indicator
// line in the follow-up composer and the drawer with its changes. The server is a stub that follows the section 9
// documents; nothing here starts a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextPanel } from '../../visualizer/public/js/context-panel.js';
import {
  contextUrl, chatContextUrl, parseProjectContext, parseChatContext, contextLine, summaryRows, buildNotes, buildCrossChat,
  contextError, flagsText, resetQuestion, NOTES_MAX, UNREADABLE, LAYER_TITLE, units, tokens, pct, compactTokens, usageText,
  cappedText, windowNote, meterFill, budgetState, buildBudget, buildBudgetReset, switchMode, budgetPreview, developerText, notesCount,
} from '../../visualizer/public/js/context.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createContext } from '../../src/core/context/index.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const NAV = (over = {}) => ({
  mode: 'registry',
  projects: [{ id: 'core', name: 'Core', workspace: '', chats: [
    { id: 'a', title: 'Alpha', status: 'idle', runs: 7, ...over.a },
    { id: 'b', title: 'Beta', status: 'idle', runs: 2, ...over.b },
  ] }],
});

const MODEL = 'anthropic/claude-sonnet-4-5';
const RULE = { mode: 'percent', value: 10 };
// the token part of the indicator for the chat document below: 1053 of a 200000-token window
const T = ' · ≈1.1k tokens (0.5%)';

// the Team chat document of context-budget-contract section 9
function chatDoc(over = {}) {
  return {
    v: 2, engine: 'team', settings: { crossChat: true, budget: RULE, models: {} }, reset: null,
    model: { id: MODEL, window: 200000, known: true },
    budget: { tokens: 20000, used: 1053, mode: 'percent', value: 10, source: 'project', capped: null },
    turns: { total: 7, visible: 5, detailed: 4, condensed: 1, omitted: 0 },
    otherChats: { chats: 2, turns: 5 }, notes: { chars: 120, tokens: 30, limit: 16000, cut: false }, memory: { chars: 0, tokens: 0 },
    truncated: false, degraded: false,
    sections: [
      { id: 'notes', title: 'Project notes', chars: 11, tokens: 3, text: 'Use tabs.\n', exact: true },
      { id: 'recent', title: 'This chat - recent turns', chars: 40, tokens: 10, text: '#5 [success] add login\n<b>not html</b>', exact: true },
    ],
    developer: { model: { id: null, window: 128000, known: false }, budget: { tokens: 1280, used: 450 }, chars: 30, tokens: 8, text: 'Notes: Use tabs.\n#5 [success] add login' },
    ...over,
  };
}

const DEFAULTS_DOC = { budget: RULE, window: 128000, percent: [1, 50], tokens: [1000, 200000], models: 32, pipeline: [4000, 18750], pipelineBytes: { history: [12000, 50000], context: [4000, 25000] } };
// a server from before defaults.pipeline
const { pipeline: _range, pipelineBytes: _bytes, ...OLDER_DEFAULTS } = DEFAULTS_DOC;
const projectDoc = (over = {}) => ({
  v: 2, settings: { crossChat: true, budget: RULE, models: {} }, defaults: DEFAULTS_DOC,
  notes: { text: 'Use tabs.', chars: 9, tokens: 3, limit: 16000, updatedAt: '2026-11-16T10:00:00.000Z' },
  chats: [{ id: 'a', title: 'Alpha', engine: 'team', turns: 7, lastActiveAt: null, reset: false }], ...over,
});

// a map built without a prototype, as plain data
const plain = (m) => ({ ...m });

test('routes: the six endpoints, ids checked and encoded', () => {
  assert.equal(contextUrl('core'), '/api/projects/core/context');
  assert.equal(contextUrl('core', 'settings'), '/api/projects/core/context/settings');
  assert.equal(contextUrl('core', 'notes'), '/api/projects/core/context/notes');
  assert.equal(chatContextUrl('core', 'a.1'), '/api/projects/core/chats/a.1/context');
  assert.equal(chatContextUrl('core', 'a', 'reset'), '/api/projects/core/chats/a/context/reset');
  assert.equal(chatContextUrl('core', 'a', 'restore'), '/api/projects/core/chats/a/context/restore');
  for (const bad of [contextUrl('../x'), contextUrl('Core'), contextUrl('core', 'reset'), chatContextUrl('core', '../a'), chatContextUrl('core', 'a', 'notes'), chatContextUrl('x/y', 'a'), chatContextUrl('core', null)]) {
    assert.equal(bad, null);
  }
});

test('routes: the chat read carries the planner pick as provider and model, both or neither, encoded', () => {
  const pick = { provider: 'openrouter', model: 'qwen/qwen3-coder:free' };
  assert.equal(chatContextUrl('core', 'a', '', pick), '/api/projects/core/chats/a/context?provider=openrouter&model=qwen%2Fqwen3-coder%3Afree');
  assert.equal(chatContextUrl('core', 'a', 'reset', pick), '/api/projects/core/chats/a/context/reset', 'a change carries no pick');
  for (const bad of [null, {}, { provider: 'openai' }, { model: 'gpt-5' }, { provider: '', model: 'm' }, { provider: 'a b', model: 'm' }, { provider: 'p', model: 'm\n' },
    { provider: 'p', model: 'x'.repeat(257) }, { provider: 7, model: 'm' }, { provider: 'p\u0085', model: 'm' }]) {
    assert.equal(chatContextUrl('core', 'a', '', bad), '/api/projects/core/chats/a/context', JSON.stringify(bad));
  }
  assert.equal(chatContextUrl('core', 'a', '', { provider: 'p', model: 'x'.repeat(256) }).length, '/api/projects/core/chats/a/context?provider=p&model='.length + 256);
});

test('units and tokens: the vectors of section 2', () => {
  const vectors = [
    ['', 0, 0, 0], ['Hello, World!', 13, 13, 4], ['M\u00fcnchen & K\u00f6ln', 14, 16, 4], ['\u6771\u4eac\u3068\u5317\u4eac', 5, 20, 5],
    ['Scranton \u{1F680}\u2728', 12, 15, 4], ['bad\uD800surrogate\uDC00', 14, 20, 5], ['Hello \u00e4\u00f6\u00fc \u4e2d\u6587 \u{1F680} \uD800!', 18, 32, 8], ['cut\u2026', 4, 4, 1],
  ];
  for (const [s, length, u, t] of vectors) {
    assert.deepEqual([s.length, units(s), tokens(s)], [length, u, t], JSON.stringify(s));
  }
  for (const junk of [null, undefined, 42, ['abc'], { length: 3 }]) assert.deepEqual([units(junk), tokens(junk)], [0, 0]);
  // the edges of the table: U+007F 1, U+0080 2, U+2E7F 2, U+2E80 4, U+FFFF 4
  assert.deepEqual(['\u007F', '\u0080', '\u2E7F', '\u2E80', '\uFFFF', '\u{10000}'].map(units), [1, 2, 2, 4, 4, 4]);
  // additive in units, not in tokens
  assert.equal(units('ab\u{1F600}') + units('\u00e4'), units('ab\u{1F600}\u00e4'));
  assert.deepEqual([tokens('a'), tokens('b'), tokens('ab')], [1, 1, 1]);
});

test('pct: 0, below 0.1, one decimal below 10, whole numbers above; compact token counts', () => {
  assert.deepEqual([pct(0, 100), pct(0, 0), pct(5, 0), pct(-1, 10), pct(NaN, 10), pct(1, Infinity)], ['0', '0', '0', '0', '0', '0']);
  assert.deepEqual([pct(1, 200000), pct(99, 100000), pct(1, 1000)], ['<0.1', '<0.1', '0.1']);
  assert.deepEqual([pct(6200, 200000), pct(1053, 200000), pct(5, 100), pct(9949, 100000)], ['3.1', '0.5', '5.0', '9.9']);
  assert.deepEqual([pct(9960, 100000), pct(4210, 20000), pct(1, 1), pct(3, 2)], ['10', '21', '100', '150'], '9.96 rounds into the whole numbers');
  assert.deepEqual([0, 7, 999, 1000, 1049, 1050, 6200, 12345, 99949, 99950, 100000, 123456, 1500000].map(compactTokens),
    ['0', '7', '999', '1k', '1k', '1.1k', '6.2k', '12.3k', '99.9k', '100k', '100k', '123k', '1500k']);
  assert.deepEqual([-5, NaN, undefined].map(compactTokens), ['0', '0', '0']);
});

test('parseChatContext: the section 9 document as it is, malformed parts as safe defaults, never a throw', () => {
  const d = parseChatContext(chatDoc());
  assert.equal(d.valid, true);
  assert.deepEqual(d.turns, { total: 7, visible: 5, detailed: 4, condensed: 1, omitted: 0 });
  assert.deepEqual(d.model, { id: MODEL, window: 200000, known: true });
  assert.deepEqual(d.budget, { tokens: 20000, used: 1053, mode: 'percent', value: 10, source: 'project', capped: null });
  assert.deepEqual(d.notes, { chars: 120, tokens: 30, limit: 16000, cut: false });
  assert.deepEqual(d.memory, { chars: 0, tokens: 0 });
  assert.deepEqual([d.settings.crossChat, d.settings.budget, plain(d.settings.models)], [true, RULE, {}]);
  assert.deepEqual(d.sections.map((s) => [s.id, s.chars, s.tokens, s.exact]), [['notes', 11, 3, true], ['recent', 40, 10, true]]);
  assert.equal(d.sections[1].text, '#5 [success] add login\n<b>not html</b>', 'the text is kept verbatim, line breaks included');
  assert.deepEqual(d.developer, { model: { id: null, window: 128000, known: false }, budget: { tokens: 1280, used: 450 }, chars: 30, tokens: 8, text: 'Notes: Use tabs.\n#5 [success] add login' });
  assert.equal(developerText(d.developer), '≈450 of 1,280 tokens (35% of the brief\'s budget) · Automatic, 128,000-token window (assumed)');

  // the 0.3.0 document, and every other version, is one this page cannot read
  const v1 = { ...chatDoc(), v: 1, budget: { limit: 24000, used: 10321 } };
  for (const junk of [null, undefined, 7, 'x', [], { v: 1 }, { ...chatDoc(), v: '2' }, v1, { ...chatDoc(), v: 3 }]) {
    const x = parseChatContext(junk);
    assert.equal(x.valid, false);
    assert.equal(contextLine(x), '', 'an unreadable document says nothing in the line');
    assert.deepEqual(x.sections, []);
    assert.equal(x.settings.crossChat, true, 'the storage default');
  }
  assert.equal(contextLine(parseChatContext({ v: 2 })), 'Context: none yet', 'a bare v2 document is read');
  const odd = parseChatContext(chatDoc({
    engine: 'robot', reset: { at: 'yesterday' }, turns: { total: -1, visible: 2.5, detailed: '4' }, budget: 'big', truncated: 'yes', model: 'gpt',
    sections: [{ id: 'recent', text: 'a\u202Eb' }, { id: 'recent', text: 'dup' }, { id: '../x', text: 'bad id' }, { id: 'earlier', text: '' }, 'nope', { id: 'memory', text: 42 }],
    developer: 'brief',
  }));
  assert.equal(odd.engine, 'team');
  assert.equal(odd.reset, null, 'a marker without a time is no marker');
  assert.deepEqual(odd.turns, { total: 0, visible: 0, detailed: 0, condensed: 0, omitted: 0 });
  assert.deepEqual(odd.budget, { tokens: 0, used: 0, mode: null, value: null, source: 'project', capped: null });
  assert.deepEqual(odd.model, { id: null, window: 128000, known: false });
  assert.equal(odd.truncated, false);
  assert.deepEqual(odd.sections.map((s) => [s.id, s.title, s.text, s.chars, s.tokens, s.exact]), [['recent', 'This chat - recent turns', 'ab', 2, 1, false]], 'duplicates, bad ids and empty layers are dropped; bidi controls stripped; tokens estimated when missing');
  assert.equal(odd.developer, null);
  assert.equal(usageText(odd), '≈0 tokens (0% of the 128,000-token window)');

  // the Pipeline document: the planner recipient, the allowance bounded by the engine, readable sections
  const pipe = parseChatContext(chatDoc({
    engine: 'pipeline', model: { id: 'openai/gpt-5', window: 400000, known: true },
    budget: { tokens: 17500, used: 2100, mode: 'percent', value: 10, source: 'project', capped: 'engine' }, developer: { chars: 3, text: 'x' },
  }));
  assert.equal(pipe.developer, null, 'a pipeline chat has no developer brief');
  assert.deepEqual([pipe.budget.tokens, pipe.budget.capped], [17500, 'engine']);
  assert.equal(usageText(pipe), '≈2,100 of 17,500 tokens (12% of budget · 0.5% of the 400,000-token window)');
  assert.equal(cappedText(pipe), 'Set by the Pipeline engine\'s prompt budget, which bounds what the planner can receive.');
  assert.deepEqual(summaryRows(pipe).slice(-2), [['Model', 'openai/gpt-5 · 400,000-token window'], ['Budget', '10% of the model\'s context window · project rule']]);
});

test('parseChatContext: hostile values in the v2 fields never reach the view as they are', () => {
  const bad = parseChatContext(chatDoc({
    model: { id: 'has space', window: 1.5, known: true },
    budget: { tokens: -1, used: '9', mode: 'all', value: 10, source: 'model', capped: 'none' },
    notes: { chars: 5, tokens: -3, cut: 'yes' }, memory: { chars: 4, tokens: 1e400 },
    settings: { crossChat: false, budget: { mode: 'percent', value: 51 }, models: JSON.parse('{"__proto__":{"mode":"tokens","value":5000},"constructor":{"mode":"tokens","value":5000},"ok/m":{"mode":"tokens","value":999},"x\\ny":{"mode":"percent","value":5},"good":{"mode":"tokens","value":5000}}') },
    sections: [{ id: 'recent', text: 'abc', chars: 'many', tokens: 2.5 }],
  }));
  assert.deepEqual(bad.model, { id: null, window: 128000, known: false }, 'a window that is no integer is unknown, and so is the id with a space');
  assert.deepEqual(bad.budget, { tokens: 0, used: 0, mode: null, value: null, source: 'project', capped: null }, 'an override of Automatic is no override');
  assert.deepEqual([bad.notes.tokens, bad.notes.cut, bad.memory.tokens], [0, false, 0]);
  assert.equal(bad.settings.crossChat, false);
  assert.deepEqual(bad.settings.budget, RULE, 'a rule out of range is the default rule');
  assert.equal(Object.getPrototypeOf(bad.settings.models), null);
  assert.deepEqual(Object.keys(bad.settings.models), ['good'], 'reserved names, keys with control characters and rules out of range are dropped');
  assert.equal({}.mode, undefined, 'no prototype was touched');
  assert.deepEqual([bad.sections[0].chars, bad.sections[0].tokens], [3, 1]);
  const big = parseChatContext(chatDoc({ model: { id: 'm'.repeat(514), window: 2 ** 53, known: true } }));
  assert.deepEqual(big.model, { id: null, window: 128000, known: false });
  assert.equal(parseChatContext(chatDoc({ model: { id: 'm'.repeat(513), window: 32000, known: 'true' } })).model.known, false);
});

test('parseChatContext: section text is shown in full up to the transport ceiling', () => {
  const text = 'x'.repeat(799999);
  const d = parseChatContext(chatDoc({ sections: [{ id: 'recent', text, exact: true }], developer: { ...chatDoc().developer, text: 'y'.repeat(8000) } }));
  assert.equal(d.sections[0].text.length, 799999, 'the 40000-char cut of 0.3.0 is gone');
  assert.equal(d.developer.text.length, 8000);
  assert.equal(parseChatContext(chatDoc({ sections: [{ id: 'recent', text: 'x'.repeat(800100) }] })).sections[0].text.length, 800000);
});

test('the window and capped hints: unknown windows say what is assumed; each capped kind in words', () => {
  const unknown = parseChatContext(chatDoc({ model: { id: null, window: 128000, known: false } }));
  assert.equal(windowNote(unknown.model), 'Model window unknown - assuming 128,000 tokens');
  assert.equal(windowNote(parseChatContext(chatDoc()).model), '');
  assert.deepEqual(summaryRows(unknown).at(-2), ['Model', 'Automatic · 128,000-token window (assumed)']);
  assert.equal(contextLine(unknown), 'Context: 5 turns · 2 other chats · notes · ≈1.1k tokens (0.8%)', 'the percentage is of the assumed window');
  const capped = (c, model = { id: 'x', window: 32000, known: true }) => cappedText(parseChatContext(chatDoc({ model, budget: { ...chatDoc().budget, capped: c } })));
  assert.equal(capped(null), '');
  assert.equal(capped('min'), 'The budget was limited to the minimum of 256 tokens; the rule asks for less.');
  assert.equal(capped('window'), 'The budget was limited to half of the model\'s 32,000-token context window.');
  assert.equal(capped('max'), 'The budget was limited to the maximum of 200,000 tokens.');
  assert.match(capped('engine'), /^Set by the Pipeline engine's prompt budget/);
  assert.equal(capped('huge'), '');
  // the meter: nothing used is empty, anything used is at least one cell, never more than all
  assert.deepEqual([meterFill(0, 100), meterFill(1, 20000), meterFill(1053, 20000), meterFill(10000, 20000), meterFill(30000, 20000), meterFill(5, 0)], [0, 1, 1, 10, 20, 0]);
});

test('parseProjectContext: settings, defaults, notes and chats; junk reads as the defaults', () => {
  const p = parseProjectContext(projectDoc({ settings: { crossChat: false, budget: { mode: 'tokens', value: 24000 }, models: { [MODEL]: { mode: 'percent', value: 20 } } } }));
  assert.equal(p.valid, true);
  assert.equal(p.settings.crossChat, false);
  assert.deepEqual(p.settings.budget, { mode: 'tokens', value: 24000 });
  assert.deepEqual(plain(p.settings.models), { [MODEL]: { mode: 'percent', value: 20 } });
  assert.deepEqual(p.defaults, DEFAULTS_DOC);
  assert.deepEqual(p.notes, { text: 'Use tabs.', chars: 9, tokens: 3, limit: 16000, updatedAt: '2026-11-16T10:00:00.000Z' });
  assert.deepEqual(p.chats.map((c) => [c.id, c.engine, c.turns]), [['a', 'team', 7]]);
  const v1 = { v: 1, settings: { crossChat: false }, notes: { text: 'x', chars: 1, limit: 4000, updatedAt: null }, chats: [] };
  for (const junk of [null, 'x', { v: 2, settings: 'off', notes: [], chats: {} }, { v: 3, settings: { crossChat: false } }, v1]) {
    const x = parseProjectContext(junk);
    assert.equal(x.settings.crossChat, true);
    assert.deepEqual(x.settings.budget, RULE);
    assert.deepEqual(x.defaults, { ...DEFAULTS_DOC, pipeline: null, pipelineBytes: null });
    assert.deepEqual(x.notes, { text: '', chars: 0, tokens: 0, limit: 16000, updatedAt: null });
    assert.deepEqual(x.chats, []);
  }
  assert.equal(parseProjectContext({ v: 2, chats: [{ id: '../x' }, { id: 'ok', title: 5, engine: 'pipeline' }] }).chats[0].title, 'Untitled chat');
  // a server may narrow the ranges, never widen them; the notes estimate is made here when it is missing
  const narrow = parseProjectContext(projectDoc({ defaults: { budget: { mode: 'tokens', value: 2000 }, window: 64000, percent: [5, 20], tokens: [0, 900000], models: 99 }, notes: { text: '\u4e2d\u6587' } }));
  assert.deepEqual(narrow.defaults, { budget: { mode: 'tokens', value: 2000 }, window: 64000, percent: [5, 20], tokens: [1000, 200000], models: 32, pipeline: null, pipelineBytes: null });
  assert.deepEqual([narrow.notes.chars, narrow.notes.tokens], [2, 2]);
  assert.deepEqual(parseProjectContext(projectDoc({ defaults: { percent: [30, 10], tokens: 'all' } })).defaults, { ...DEFAULTS_DOC, pipeline: null, pipelineBytes: null });
  // defaults.pipeline is optional: a range of whole token counts within the budget bounds, else none
  for (const junk of [[18750, 4000], [100, 18750], [4000, 300000], [4000.5, 18750], [4000], '4000-18750', null]) {
    assert.equal(parseProjectContext(projectDoc({ defaults: { ...DEFAULTS_DOC, pipeline: junk } })).defaults.pipeline, null, JSON.stringify(junk));
  }
  assert.equal(parseProjectContext(projectDoc({ defaults: OLDER_DEFAULTS })).defaults.pipeline, null);
});

test('contextLine: turns, other chats, notes, nothing yet, and the fresh start', () => {
  const line = (over) => contextLine(parseChatContext(chatDoc(over)));
  assert.equal(line(), `Context: 5 turns · 2 other chats · notes${T}`);
  assert.equal(line({ turns: { total: 0, visible: 0 } }), `Context: 2 other chats · notes${T}`, 'a fresh chat with project context only');
  assert.equal(line({ turns: { total: 1, visible: 1 }, otherChats: { chats: 1, turns: 1 }, notes: { chars: 0 } }), `Context: 1 turn · 1 other chat${T}`);
  assert.equal(line({ turns: {}, otherChats: {}, notes: {}, memory: { chars: 300 } }), `Context: memory${T}`);
  assert.equal(line({ turns: {}, otherChats: {}, notes: {}, sections: [], budget: { tokens: 20000, used: 0 } }), 'Context: none yet', 'no token part when nothing is used');
  assert.equal(line({ budget: { tokens: 20000, used: 0 } }), 'Context: 5 turns · 2 other chats · notes');
  assert.equal(line({ budget: { tokens: 20000, used: 6200 } }), 'Context: 5 turns · 2 other chats · notes · ≈6.2k tokens (3.1%)', 'the example of section 11');
  assert.equal(line({ reset: { at: '2026-11-16T10:00:00.000Z' }, turns: { total: 7, visible: 2 } }), `Context: 2 turns since the fresh start · 2 other chats · notes${T}`);
  assert.equal(line({ reset: { at: '2026-11-16T10:00:00.000Z' }, turns: { total: 7, visible: 0 }, otherChats: {}, notes: {} }), `Context: fresh start${T}`);
});

test('request bodies: crossChat is a boolean, notes at most 16000 chars (JS string length) with CRLF as LF', () => {
  assert.equal(NOTES_MAX, 16000);
  assert.deepEqual(buildCrossChat(false), { body: { crossChat: false } });
  assert.ok(buildCrossChat('false').error);
  assert.deepEqual(buildNotes('a\r\nb\rc'), { body: { text: 'a\nb\nc' } });
  assert.deepEqual(buildNotes(''), { body: { text: '' } }, 'empty clears');
  assert.deepEqual(buildNotes('x'.repeat(NOTES_MAX)), { body: { text: 'x'.repeat(NOTES_MAX) } });
  assert.match(buildNotes(`${'x'.repeat(NOTES_MAX)}y`).error, /16,001 characters; the limit is 16,000/);
  // the unit of the textarea's maxlength: an emoji is two
  const emoji = '\u{1F600}'.repeat(NOTES_MAX / 2);
  assert.deepEqual(buildNotes(emoji), { body: { text: emoji } });
  assert.match(buildNotes(`${emoji}x`).error, /16,001 characters/);
  assert.equal(notesCount('Use tabs.\n\u{1F600}'), '12 / 16,000 · ≈4 tokens', 'the counter counts like maxlength, the estimate like the server');
  // a CRLF counts once, as the server stores it
  assert.deepEqual(buildNotes(`${'x'.repeat(NOTES_MAX - 1)}\r\n`), { body: { text: `${'x'.repeat(NOTES_MAX - 1)}\n` } });
  assert.equal(buildNotes(3).field, 'notes');
  assert.match(contextError(404, { error: 'Not found' }), /does not offer context/);
  assert.equal(contextError(400, { error: 'Invalid body' }), 'Invalid body');
  assert.match(contextError(0, null), /did not answer/);
});

// the panel with a stub server; held: keys whose answer waits for release(key); late: answered as the server stood
// when asked, delivered on release(key); reject: keys whose fetch rejects (no answer at all)
// The budget the stub reports for a recipient: section 4 with the stub's settings.
function stubBudget(settings, model, used) {
  const own = model.id && Object.hasOwn(settings.models, model.id) ? settings.models[model.id] : null;
  const rule = own ?? settings.budget;
  const raw = rule.mode === 'percent' ? Math.floor((model.window * rule.value) / 100) : rule.value;
  const ceiling = Math.min(200000, Math.floor(model.window / 2));
  const tokens = Math.max(256, Math.min(raw, ceiling));
  const capped = tokens === raw ? null : tokens === 256 ? 'min' : ceiling === 200000 ? 'max' : 'window';
  return { tokens, used, ...rule, source: own ? 'model' : 'project', capped };
}

function harness({ nav = NAV(), answers = {}, held = [], late = [], reject = [], plannerModel } = {}) {
  const $ = installDom();
  const close = new FakeEl();
  $('context-dialog').querySelectorAll = () => [close];
  $('context-dialog').querySelector = () => close;
  $('context-line').isConnected = true;
  const requests = [];
  const waiting = new Map();
  const server = {
    crossChat: true, budget: RULE, models: {}, notes: 'Use tabs.',
    chats: { a: chatDoc(), b: chatDoc({ turns: { total: 2, visible: 2, detailed: 2, condensed: 0, omitted: 0 }, otherChats: { chats: 1, turns: 7 } }) },
  };
  const settings = () => ({ crossChat: server.crossChat, budget: server.budget, models: server.models });
  const project = () => projectDoc({ settings: settings(), notes: { text: server.notes, chars: server.notes.length, tokens: tokens(server.notes), limit: 16000, updatedAt: null } });
  // the configure patch of section 4, merged into the stored settings
  const configure = (patch) => {
    if ('crossChat' in patch) server.crossChat = patch.crossChat;
    if ('budget' in patch) server.budget = patch.budget ?? RULE;
    if ('models' in patch) {
      const models = { ...server.models };
      for (const [k, v] of Object.entries(patch.models)) {
        if (v === null) delete models[k];
        else models[k] = v;
      }
      server.models = models;
    }
  };
  const reply = (code, body) => ({ ok: code < 300, status: code, json: async () => structuredClone(body) });
  globalThis.fetch = (url, opts = {}) => {
    const m = /^\/api\/projects\/([a-z0-9-]+)(?:\/chats\/([^/?]+))?\/context(?:\/([a-z]+))?(?:\?(.*))?$/.exec(url);
    const key = m[2] ? `${m[2]}:${m[3] ?? 'get'}` : `project:${m[3] ?? 'get'}`;
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    const query = m[4] === undefined ? null : Object.fromEntries(new URLSearchParams(m[4]));
    requests.push({ url, key, query, method: opts.method ?? 'GET', headers: opts.headers ?? {}, cache: opts.cache, body });
    const answer = () => {
      if (answers[key]) return reply(...answers[key]);
      if (key === 'project:settings') configure(body);
      if (key === 'project:notes') server.notes = body.text;
      if (m[3] === 'reset') server.chats[m[2]] = { ...server.chats[m[2]], reset: { at: '2026-11-16T12:00:00.000Z' }, turns: { total: 7, visible: 0, detailed: 0, condensed: 0, omitted: 0 }, sections: server.chats[m[2]].sections.filter((s) => s.id !== 'recent') };
      if (m[3] === 'restore') server.chats[m[2]] = chatDoc();
      if (!m[2]) return reply(200, project());
      const doc = server.chats[m[2]];
      // a Pipeline read names its planner, as the server does with the query
      const model = doc.engine === 'pipeline' && query ? { id: `${query.provider}/${query.model}`, window: 400000, known: true } : doc.model;
      return reply(200, {
        ...doc, model, settings: settings(), budget: stubBudget(settings(), model, doc.budget.used),
        ...(server.crossChat ? {} : { otherChats: { chats: 0, turns: 0 } }),
      });
    };
    if (reject.includes(key)) return Promise.reject(new TypeError('Failed to fetch'));
    if (late.includes(key)) {
      const now = answer();
      return new Promise((r) => waiting.set(key, () => r(now)));
    }
    if (held.includes(key)) return new Promise((r) => waiting.set(key, () => r(answer())));
    return Promise.resolve(answer());
  };
  let navDoc = nav;
  const confirms = [];
  const panel = createContextPanel({ getProjects: () => navDoc, confirm: (c) => confirms.push(c), ...(plannerModel ? { plannerModel } : {}) });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const release = async (key) => {
    waiting.get(key)?.();
    waiting.delete(key);
    await tick();
  };
  const scope = async (chat = 'a') => {
    panel.setScope({ project: 'core', chat });
    await tick();
  };
  const open = async () => {
    $('context-line').focus();
    await $('context-line').fire('click');
    await tick();
  };
  return { $, panel, requests, server, tick, release, scope, open, close, confirms, held, late, waiting, setNav: (d) => { navDoc = d; } };
}

test('indicator: shown with the chat document on 200, hidden on 404, in single mode and without a chat', async () => {
  const h = harness();
  await h.scope('a');
  assert.deepEqual(h.requests.map((r) => [r.method, r.url, r.headers['X-Scranton-Client'], r.cache]), [['GET', '/api/projects/core/chats/a/context', '1', 'no-store']]);
  assert.equal(h.$('context-line').hidden, false);
  assert.equal(h.$('context-line-text').textContent, `Context: 5 turns · 2 other chats · notes${T}`);

  const gone = harness({ answers: { 'a:get': [404, { error: 'Not found' }] } });
  await gone.scope('a');
  assert.equal(gone.$('context-line').hidden, true, 'a server without the routes shows nothing');
  await gone.$('context-line').fire('click');
  assert.equal(gone.$('context-dialog').open, false);

  const single = harness({ nav: { ...NAV(), mode: 'single' } });
  await single.scope('a');
  assert.deepEqual(single.requests, [], 'a single-hive server is not asked');
  assert.equal(single.$('context-line').hidden, true);

  h.panel.setScope({ project: 'core', chat: null });
  await h.tick();
  assert.equal(h.$('context-line').hidden, true, 'a project without a chat has no chat context');
  assert.equal(h.requests.length, 1);
});

test('a failed read is one quiet line and an inline error with Try again, never a broken composer', async () => {
  const h = harness({ answers: { 'a:get': [500, { error: 'boom' }] } });
  await h.scope('a');
  assert.equal(h.$('context-line').hidden, false);
  assert.equal(h.$('context-line-text').textContent, 'Context: not loaded');
  assert.equal(h.$('context-line').dataset.tone, 'error');
  await h.open();
  assert.equal(h.$('context-error').textContent, 'boom');
  assert.equal(h.$('context-retry-row').hidden, false);
  assert.equal(h.$('context-content').hidden, true);
});

test('drawer: summary, one block per section with its verbatim text, and the Team developer brief', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-dialog').open, true);
  assert.deepEqual(h.requests.slice(1).map((r) => r.key).sort(), ['a:get', 'project:get'], 'opening reads the chat and the project again');
  assert.equal(h.$('context-chat').textContent, 'Alpha');
  assert.equal(h.$('context-content').hidden, false);
  assert.equal(h.$('context-engine').textContent, 'Team');
  const figures = h.$('context-figures').childNodes.map((x) => x.textContent);
  assert.deepEqual(figures.filter((_, i) => i % 2 === 0), ['Turns', 'Other chats', 'Project notes', 'Project memory', 'Model', 'Budget']);
  assert.equal(figures[1], '5 of 7 · 4 in detail · 1 condensed · 0 omitted');
  assert.equal(figures[5], '120 of 16,000 characters · ≈30 tokens');
  assert.equal(figures[9], 'anthropic/claude-sonnet-4-5 · 200,000-token window');
  assert.equal(figures[11], '10% of the model\'s context window · project rule');
  assert.equal(h.$('context-usage').textContent, '≈1,053 of 20,000 tokens (5.3% of budget · 0.5% of the 200,000-token window)');
  const meter = h.$('context-meter');
  assert.equal(meter.hidden, false);
  assert.deepEqual(meter.childNodes.map((c) => c.dataset.fill), ['full', ...Array(19).fill('')]);
  assert.deepEqual(['aria-valuenow', 'aria-valuemax', 'aria-valuetext'].map((k) => meter.getAttribute(k)), ['1053', '20000', h.$('context-usage').textContent]);
  assert.deepEqual([h.$('context-window-note').hidden, h.$('context-capped').hidden], [true, true], 'a known window, nothing capped');
  assert.equal(h.$('context-developer-usage').textContent, '≈450 of 1,280 tokens (35% of the brief\'s budget) · Automatic, 128,000-token window (assumed)');
  assert.equal(h.$('context-developer').childNodes[0].childNodes[0].childNodes[2].textContent, '≈8 tokens');
  const blocks = h.$('context-sections').childNodes;
  assert.deepEqual(blocks.map((b) => b.dataset.section), ['notes', 'recent']);
  const [summary, note, pre] = blocks[1].childNodes;
  assert.deepEqual(summary.childNodes.map((x) => x.textContent), ['This chat - recent turns', 'Exact', '≈10 tokens']);
  assert.equal(note.textContent, 'Exact text the next turn receives.');
  assert.equal(pre.textContent, '#5 [success] add login\n<b>not html</b>', 'set as text, never parsed');
  assert.equal(pre.tabIndex, 0);
  assert.equal(h.$('context-developer-section').hidden, false);
  assert.equal(h.$('context-developer').childNodes[0].childNodes[2].textContent, 'Notes: Use tabs.\n#5 [success] add login');
  assert.equal(h.$('context-restore').hidden, true, 'no marker, nothing to restore');
  assert.equal(h.$('context-cross').checked, true);
  assert.equal(h.$('context-notes').value, 'Use tabs.');
  assert.equal(h.$('context-notes-count').textContent, '9 / 16,000 · ≈3 tokens');
  assert.equal(h.$('context-notes-save').disabled, true, 'nothing changed yet');
  // the budget control starts from the project rule
  assert.deepEqual([h.$('context-budget-mode').value, h.$('context-budget-value').value, h.$('context-budget-only').checked], ['percent', '10', false]);
  assert.equal(h.$('context-budget-only-row').hidden, false);
  assert.equal(h.$('context-budget-only-label').textContent, 'Only for anthropic/claude-sonnet-4-5');
  assert.equal(h.$('context-budget-range').textContent, 'percent, 1-50');
  assert.deepEqual([h.$('context-budget-value').getAttribute('min'), h.$('context-budget-value').getAttribute('max')], ['1', '50']);
  assert.equal(h.$('context-budget-preview').textContent, '≈20,000 tokens with the 200,000-token window of anthropic/claude-sonnet-4-5.');
  assert.deepEqual([h.$('context-budget-save').disabled, h.$('context-budget-reset').disabled], [true, true], 'nothing changed, nothing to reset');
});

const PIPE_NAV = () => ({ ...NAV(), projects: [{ ...NAV().projects[0], chats: [{ id: 'a', title: 'Alpha', status: 'idle', runs: 7, engine: 'pipeline' }] }] });
const pipeDoc = () => chatDoc({
  engine: 'pipeline', model: { id: null, window: 128000, known: false },
  budget: { tokens: 12800, used: 2048, mode: 'percent', value: 10, source: 'project', capped: null }, developer: null,
  sections: [{ id: 'recent', title: 'This chat - recent turns', chars: 9, tokens: 3, text: '{"runs":[]}', exact: false }],
});

test('a pipeline chat shows readable summaries and no developer brief', async () => {
  const h = harness();
  h.server.chats.a = pipeDoc();
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-engine').textContent, 'Pipeline');
  assert.equal(h.$('context-developer-section').hidden, true);
  const [summary, note] = h.$('context-sections').childNodes[0].childNodes;
  assert.equal(summary.childNodes[1].textContent, 'Summary');
  assert.match(note.textContent, /readable summary .* not the literal text/);
});

test('a pipeline chat reads its document with the planner pick; without one the window is unknown and nothing can be set per model', async () => {
  const pick = { provider: 'openai', model: 'gpt-5' };
  const h = harness({ nav: PIPE_NAV(), plannerModel: () => pick });
  h.server.chats.a = { ...pipeDoc(), budget: { ...pipeDoc().budget, capped: 'engine' } };
  await h.scope('a');
  assert.deepEqual([h.requests[0].url, h.requests[0].query], ['/api/projects/core/chats/a/context?provider=openai&model=gpt-5', { provider: 'openai', model: 'gpt-5' }]);
  await h.open();
  assert.ok(h.requests.filter((r) => r.key === 'a:get').every((r) => r.query?.model === 'gpt-5'), 'every read of the chat carries it');
  assert.equal(h.$('context-budget-only-label').textContent, 'Only for openai/gpt-5');
  assert.equal(h.$('context-window-note').hidden, true);
  assert.equal(h.$('context-budget-preview').textContent, '≈18,750 tokens with the 400,000-token window of openai/gpt-5; the Pipeline engine keeps the budget between 4,000 and 18,750 tokens.');

  // a Start fresh answers without the pick: the document is read again with it
  await h.$('context-reset').fire('click');
  await h.$('context-reset-ok').fire('click');
  await h.tick();
  assert.deepEqual(h.requests.slice(-2).map((r) => [r.key, r.query?.model ?? null]), [['a:reset', null], ['a:get', 'gpt-5']]);
  assert.equal(h.$('context-budget-only-label').textContent, 'Only for openai/gpt-5');

  const none = harness({ nav: PIPE_NAV(), plannerModel: () => null });
  none.server.chats.a = { ...pipeDoc(), budget: { ...pipeDoc().budget, capped: 'engine' } };
  await none.scope('a');
  await none.open();
  assert.equal(none.requests[0].url, '/api/projects/core/chats/a/context');
  assert.equal(none.$('context-window-note').textContent, 'Model window unknown - assuming 128,000 tokens');
  assert.equal(none.$('context-window-note').hidden, false);
  assert.equal(none.$('context-capped').hidden, true, 'the stub computes the plain rule here');
  assert.equal(none.$('context-budget-only-row').hidden, true, 'Automatic has no id to keep an override under');
  assert.equal(none.$('context-figures').childNodes[9].textContent, 'Automatic · 128,000-token window (assumed)');

  // a Team chat never sends the pick
  const team = harness({ plannerModel: () => pick });
  await team.scope('a');
  assert.equal(team.requests[0].query, null);
});

test('the capped hint and the Pipeline engine bound are shown in the drawer', async () => {
  const h = harness({ answers: { 'a:get': [200, { ...pipeDoc(), budget: { ...pipeDoc().budget, tokens: 17500, capped: 'engine' } }] } });
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-capped').hidden, false);
  assert.match(h.$('context-capped').textContent, /^Set by the Pipeline engine's prompt budget/);
  assert.equal(h.$('context-usage').textContent, '≈2,048 of 17,500 tokens (12% of budget · 1.6% of the 128,000-token window)');
});

test('sharing switch: POST settings with the control headers, re-rendered from the answer, the chat read again', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  // the line under the box says what the box says, not what Off would mean
  assert.equal(h.$('context-cross-hint').textContent, 'On: the next turn of every chat here also gets a short digest of the other chats of this project. Projects never share anything with each other.');
  const before = h.requests.length;
  h.$('context-cross').checked = false;
  await h.$('context-cross').fire('change');
  await h.tick();
  const [post, reread] = h.requests.slice(before);
  assert.deepEqual([post.method, post.url, post.body, post.headers['Content-Type'], post.headers['X-Scranton-Client'], post.cache],
    ['POST', '/api/projects/core/context/settings', { crossChat: false }, 'application/json', '1', 'no-store']);
  assert.deepEqual([reread.method, reread.key], ['GET', 'a:get'], 'the pack follows the setting');
  assert.equal(h.$('context-cross').checked, false);
  assert.match(h.$('context-cross-status').textContent, /^Sharing is off/);
  assert.match(h.$('context-cross-hint').textContent, /^Off: no chat of this project receives or provides/);
  assert.equal(h.$('context-line-text').textContent, `Context: 5 turns · notes${T}`);
  assert.equal(h.$('context-figures').childNodes[3].textContent, 'Sharing between chats is off');

  const refused = harness({ answers: { 'project:settings': [400, { error: 'Invalid body' }] } });
  await refused.scope('a');
  await refused.open();
  refused.$('context-cross').checked = false;
  await refused.$('context-cross').fire('change');
  assert.equal(refused.$('context-cross').checked, true, 'a refused change shows the saved state again');
  assert.equal(refused.$('context-cross-status').textContent, 'Invalid body');
  assert.equal(refused.$('context-cross-status').dataset.tone, 'error');
});

test('notes: live counter, Save posts { text }, the editor follows the answer; over the limit is refused here', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  h.$('context-notes').value = 'Use spaces.\r\nNo semicolons \u{1F600}';
  await h.$('context-notes').fire('input');
  assert.equal(h.$('context-notes-count').textContent, '29 / 16,000 · ≈8 tokens', 'the counter counts like maxlength, plus the estimate');
  assert.equal(h.$('context-notes-save').disabled, false);
  assert.equal(h.$('context-foot').textContent, 'Unsaved notes');
  const before = h.requests.length;
  await h.$('context-project').fire('submit');
  await h.tick();
  const post = h.requests[before];
  assert.deepEqual([post.method, post.url, post.body, post.headers['Content-Type']], ['POST', '/api/projects/core/context/notes', { text: 'Use spaces.\nNo semicolons \u{1F600}' }, 'application/json']);
  assert.equal(h.$('context-notes').value, 'Use spaces.\nNo semicolons \u{1F600}', 'the editor shows what the server saved');
  assert.equal(h.$('context-notes-status').textContent, 'Notes saved. New turns of every chat in this project get them.');
  assert.equal(h.$('context-notes-save').disabled, true);
  assert.equal(h.requests[before + 1].key, 'a:get');

  h.$('context-notes').value = 'x'.repeat(NOTES_MAX + 1);
  await h.$('context-notes').fire('input');
  const sent = h.requests.length;
  await h.$('context-project').fire('submit');
  assert.equal(h.requests.length, sent, 'nothing is sent');
  assert.match(h.$('context-notes-error').textContent, /16,001 characters/);
  assert.equal(h.$('context-notes').getAttribute('aria-invalid'), 'true');
});

test('budget: Save posts the project rule, the override, or the rule plus the removal of this model\'s override; both documents follow', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  const save = async () => {
    const before = h.requests.length;
    await h.$('context-budget').fire('submit');
    await h.tick();
    return h.requests.slice(before);
  };
  // a fixed number of tokens for the project
  h.$('context-budget-mode').value = 'tokens';
  await h.$('context-budget-mode').fire('change');
  assert.equal(h.$('context-budget-value').value, '20000', 'the mode switch keeps the budget it stands for');
  assert.equal(h.$('context-budget-range').textContent, 'tokens, 1,000-200,000');
  h.$('context-budget-value').value = '24000';
  await h.$('context-budget-value').fire('input');
  assert.equal(h.$('context-budget-save').disabled, false);
  assert.equal(h.$('context-foot').textContent, 'Unsaved budget');
  let [post, reread] = await save();
  assert.deepEqual([post.method, post.url, post.body, post.headers['Content-Type'], post.headers['X-Scranton-Client']],
    ['POST', '/api/projects/core/context/settings', { budget: { mode: 'tokens', value: 24000 } }, 'application/json', '1']);
  assert.deepEqual([reread.method, reread.key], ['GET', 'a:get'], 'the chat document follows the project');
  assert.equal(h.$('context-budget-status').textContent, 'Budget saved. The next turn of every chat in this project uses it.');
  assert.equal(h.$('context-usage').textContent, '≈1,053 of 24,000 tokens (4.4% of budget · 0.5% of the 200,000-token window)');
  assert.equal(h.$('context-figures').childNodes[11].textContent, '24,000 tokens · project rule');
  assert.deepEqual([h.$('context-budget-save').disabled, h.$('context-budget-reset').disabled], [true, false]);

  // only for this model: an override, kept under its id
  h.$('context-budget-mode').value = 'percent';
  await h.$('context-budget-mode').fire('change');
  assert.equal(h.$('context-budget-value').value, '12', '24,000 of a 200,000-token window');
  h.$('context-budget-value').value = '30';
  h.$('context-budget-only').checked = true;
  await h.$('context-budget-only').fire('change');
  [post] = await save();
  assert.deepEqual(post.body, { models: { [MODEL]: { mode: 'percent', value: 30 } } });
  assert.deepEqual(h.server.models, { [MODEL]: { mode: 'percent', value: 30 } });
  assert.equal(h.$('context-figures').childNodes[11].textContent, `30% of the model's context window · only for ${MODEL}`);
  assert.equal(h.$('context-budget-only').checked, true, 'the control shows the override that applies');
  assert.equal(h.$('context-budget-reset').title, `Remove the override for ${MODEL}; the project rule applies again`);
  assert.equal(h.$('context-budget-preview').textContent, `≈60,000 tokens with the 200,000-token window of ${MODEL}.`);

  // the project rule again, unticked: this model's override would still win, so it is removed in the same patch
  h.$('context-budget-value').value = '5';
  h.$('context-budget-only').checked = false;
  await h.$('context-budget-only').fire('change');
  [post] = await save();
  assert.deepEqual(post.body, { budget: { mode: 'percent', value: 5 }, models: { [MODEL]: null } });
  assert.deepEqual([h.server.budget, h.server.models], [{ mode: 'percent', value: 5 }, {}]);
  assert.equal(h.$('context-usage').textContent, '≈1,053 of 10,000 tokens (11% of budget · 0.5% of the 200,000-token window)');
});

test('budget: Reset to default removes the override that applies, else the project rule', async () => {
  const h = harness();
  h.server.budget = { mode: 'tokens', value: 50000 };
  h.server.models = { [MODEL]: { mode: 'percent', value: 2 }, 'other/model': { mode: 'percent', value: 40 } };
  await h.scope('a');
  await h.open();
  assert.deepEqual([h.$('context-budget-mode').value, h.$('context-budget-value').value, h.$('context-budget-only').checked], ['percent', '2', true]);
  await h.$('context-budget-reset').fire('click');
  await h.tick();
  assert.deepEqual(h.requests.filter((r) => r.method === 'POST').map((r) => r.body), [{ models: { [MODEL]: null } }]);
  assert.deepEqual(h.server.models, { 'other/model': { mode: 'percent', value: 40 } }, 'only the override of this model goes');
  assert.equal(h.$('context-budget-status').textContent, 'Budget reset to the default.');
  assert.deepEqual([h.$('context-budget-mode').value, h.$('context-budget-value').value, h.$('context-budget-only').checked], ['tokens', '50000', false], 'the project rule applies now');
  await h.$('context-budget-reset').fire('click');
  await h.tick();
  assert.deepEqual(h.requests.filter((r) => r.method === 'POST').at(-1).body, { budget: null });
  assert.deepEqual(h.server.budget, RULE);
  assert.equal(h.$('context-budget-reset').disabled, true, 'at the default nothing is left to reset');
  assert.equal(globalThis.document.activeElement, h.$('context-budget-value'), 'the focus leaves the button that is off now');
});

test('budget: out-of-range values are refused here, a refused save keeps the draft and says why', async () => {
  const h = harness({ answers: { 'project:settings': [400, { error: 'Invalid budget' }] } });
  await h.scope('a');
  await h.open();
  const sent = () => h.requests.filter((r) => r.method === 'POST').length;
  for (const [mode, value, msg] of [['percent', '0', /from 1 to 50 percent/], ['percent', '51', /from 1 to 50 percent/], ['percent', '2.5', /whole number/], ['tokens', '999', /from 1,000 to 200,000/], ['tokens', '1e5', /whole number/], ['tokens', '', /whole number/]]) {
    h.$('context-budget-mode').value = mode;
    h.$('context-budget-value').value = value;
    await h.$('context-budget-value').fire('input');
    await h.$('context-budget').fire('submit');
    assert.equal(sent(), 0, `${mode} ${value}: nothing is sent`);
    assert.match(h.$('context-budget-error').textContent, msg);
    assert.equal(h.$('context-budget-error').hidden, false);
    assert.equal(h.$('context-budget-value').getAttribute('aria-invalid'), 'true');
  }
  h.$('context-budget-value').value = '200000';
  await h.$('context-budget-value').fire('input');
  assert.equal(h.$('context-budget-error').hidden, true, 'typing clears the error');
  await h.$('context-budget').fire('submit');
  await h.tick();
  assert.equal(sent(), 1);
  assert.equal(h.$('context-budget-status').textContent, 'Invalid budget');
  assert.equal(h.$('context-budget-status').dataset.tone, 'error');
  assert.equal(h.$('context-budget-value').value, '200000', 'the draft stays');
  assert.equal(globalThis.document.activeElement, h.$('context-budget-value'));
});

test('Start fresh asks inline first; Restore shows only with a marker; both re-render from the answer', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  const before = h.requests.length;
  await h.$('context-reset').fire('click');
  assert.equal(h.requests.length, before, 'the first click only asks');
  assert.equal(h.$('context-reset-confirm').hidden, false);
  assert.equal(h.$('context-reset').getAttribute('aria-expanded'), 'true');
  assert.match(h.$('context-reset-question').textContent, /Leave the 5 earlier turns of this chat out of the next turns\? They are also left out of what the other chats of this project see of this chat\. Project notes and project memory stay/);
  assert.equal(globalThis.document.activeElement, h.$('context-reset-cancel'));
  await h.$('context-reset-cancel').fire('click');
  assert.equal(h.$('context-reset-confirm').hidden, true);
  assert.equal(h.requests.length, before);
  assert.equal(globalThis.document.activeElement, h.$('context-reset'));

  await h.$('context-reset').fire('click');
  // a block the human opened stays open across the rebuild; a real childNodes is a NodeList, without filter()
  const list = h.$('context-sections').childNodes;
  list[0].open = true;
  h.$('context-sections').childNodes = { length: list.length, item: (i) => list[i], [Symbol.iterator]: () => list[Symbol.iterator]() };
  await h.$('context-reset-ok').fire('click');
  assert.equal(h.$('context-sections').childNodes[0].open, true);
  const post = h.requests[before];
  assert.deepEqual([post.method, post.url, post.body, post.headers['X-Scranton-Client']], ['POST', '/api/projects/core/chats/a/context/reset', {}, '1']);
  assert.equal(h.$('context-reset-confirm').hidden, true);
  assert.equal(h.$('context-line-text').textContent, `Context: fresh start · 2 other chats · notes${T}`);
  assert.match(h.$('context-reset-at').textContent, /^Fresh start /);
  assert.equal(h.$('context-restore').hidden, false);
  assert.deepEqual(h.$('context-sections').childNodes.map((b) => b.dataset.section), ['notes']);

  await h.$('context-restore').fire('click');
  const restore = h.requests.at(-1);
  assert.deepEqual([restore.method, restore.url, restore.body], ['POST', '/api/projects/core/chats/a/context/restore', {}]);
  assert.equal(h.$('context-restore').hidden, true);
  assert.equal(h.$('context-line-text').textContent, `Context: 5 turns · 2 other chats · notes${T}`);
  assert.equal(globalThis.document.activeElement, h.$('context-reset'), 'the focus leaves the button that went');
});

test('Escape leaves the inline confirmation first, then closes; the focus goes back to the indicator', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  await h.$('context-reset').fire('click');
  let prevented = false;
  await h.$('context-dialog').fire('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.$('context-reset-confirm').hidden, true);
  assert.equal(h.$('context-dialog').open, true);
  prevented = false;
  await h.$('context-dialog').fire('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'nothing unsaved: the browser closes it');
  h.$('context-dialog').close();
  assert.equal(globalThis.document.activeElement, h.$('context-line'));

  await h.open();
  h.$('context-notes').value = 'draft';
  await h.$('context-notes').fire('input');
  await h.close.fire('click');
  assert.equal(h.$('context-dialog').open, true, 'unsaved notes ask first');
  assert.equal(h.confirms.at(-1).title, 'Discard notes changes?');
});

test('an unsaved budget asks before the drawer closes, on Close, the backdrop and Escape, and stays when the human stays', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
  h.$('context-budget-value').value = '20';
  await h.$('context-budget-value').fire('input');
  assert.equal(h.$('context-foot').textContent, 'Unsaved budget');
  await h.close.fire('click');
  assert.equal(h.$('context-dialog').open, true, 'Close asks first');
  assert.deepEqual([h.confirms.length, h.confirms[0].title, h.confirms[0].detail, h.confirms[0].ok], [1, 'Discard budget changes?', 'The context budget you changed is not saved.', 'Discard']);
  await h.$('context-dialog').fire('click', { target: h.$('context-dialog') });
  assert.equal(h.$('context-dialog').open, true, 'so does a click on the backdrop');
  let prevented = false;
  await h.$('context-dialog').fire('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'and Escape');
  assert.equal(h.confirms.length, 3);
  // the human stays: the edit is still there
  assert.deepEqual([h.$('context-budget-value').value, h.$('context-foot').textContent, h.$('context-budget-save').disabled], ['20', 'Unsaved budget', false]);
  h.$('context-notes').value = 'draft';
  await h.$('context-notes').fire('input');
  await h.close.fire('click');
  assert.equal(h.confirms.at(-1).title, 'Discard unsaved changes?', 'both unsaved: one question');
  // Discard closes; the next drawer starts from the saved rule
  h.confirms.at(-1).action();
  assert.equal(h.$('context-dialog').open, false);
  await h.open();
  assert.deepEqual([h.$('context-budget-value').value, h.$('context-foot').textContent], ['10', '']);
});

test('a Pipeline chat previews a rule within the Pipeline budget range of the project document, and names no numbers without it', async () => {
  const set = async (x, value) => {
    x.$('context-budget-value').value = value;
    await x.$('context-budget-value').fire('input');
    return x.$('context-budget-preview').textContent;
  };
  const h = harness({ nav: PIPE_NAV() });
  h.server.chats.a = pipeDoc();
  await h.scope('a');
  await h.open();
  const keeps = '; the Pipeline engine keeps the budget between 4,000 and 18,750 tokens.';
  assert.equal(h.$('context-budget-preview').textContent, `≈12,800 tokens with the 128,000-token window of Automatic${keeps}`);
  // 1 % of 128,000 is 1,280 tokens, which the engine raises
  assert.equal(await set(h, '1'), `≈4,000 tokens with the 128,000-token window of Automatic${keeps}`);
  assert.equal(await set(h, '50'), `≈18,750 tokens with the 128,000-token window of Automatic${keeps}`);
  h.$('context-budget-mode').value = 'tokens';
  assert.equal(await set(h, '1000'), `≈4,000 tokens with the 128,000-token window of Automatic${keeps}`);

  // a Team chat has no such range
  const team = harness();
  await team.scope('a');
  await team.open();
  assert.equal(await set(team, '1'), '≈2,000 tokens with the 200,000-token window of anthropic/claude-sonnet-4-5.');

  const bare = harness({ nav: PIPE_NAV(), answers: { 'project:get': [200, projectDoc({ defaults: OLDER_DEFAULTS })] } });
  bare.server.chats.a = pipeDoc();
  await bare.scope('a');
  await bare.open();
  assert.equal(await set(bare, '1'), '≈1,280 tokens with the 128,000-token window of Automatic; the Pipeline engine\'s prompt budget can raise or lower it.');
});

test('wording: one token is "≈1 token" wherever a count is printed with the word', async () => {
  const one = parseChatContext(chatDoc({
    budget: { tokens: 0, used: 1 }, notes: { chars: 1, tokens: 1, limit: 16000 }, memory: { chars: 1, tokens: 1 },
    developer: { ...chatDoc().developer, budget: { tokens: 0, used: 1 }, tokens: 1 },
  }));
  assert.equal(contextLine(one), 'Context: 5 turns · 2 other chats · notes · memory · ≈1 token (<0.1%)');
  assert.equal(usageText(one), '≈1 token (<0.1% of the 200,000-token window)');
  assert.deepEqual(summaryRows(one).slice(2, 4).map(([, v]) => v), ['1 of 16,000 characters · ≈1 token', '1 character · ≈1 token']);
  assert.equal(developerText(one.developer), '≈1 token · Automatic, 128,000-token window (assumed)');
  assert.equal(notesCount('a'), '1 / 16,000 · ≈1 token');
  assert.equal(notesCount(''), '0 / 16,000 · ≈0 tokens');
  const h = harness();
  h.server.chats.a = chatDoc({ sections: [{ id: 'notes', title: 'Project notes', chars: 1, tokens: 1, text: 'x', exact: true }], developer: { ...chatDoc().developer, tokens: 1 } });
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-sections').childNodes[0].childNodes[0].childNodes[2].textContent, '≈1 token');
  assert.equal(h.$('context-developer').childNodes[0].childNodes[0].childNodes[2].textContent, '≈1 token');
});

test('a reply for the chat that was on screen before is dropped', async () => {
  const h = harness({ held: ['a:get'] });
  h.panel.setScope({ project: 'core', chat: 'a' });
  await h.tick();
  await h.scope('b');
  assert.equal(h.$('context-line-text').textContent, `Context: 2 turns · 1 other chat · notes${T}`);
  await h.release('a:get');
  assert.equal(h.$('context-line-text').textContent, `Context: 2 turns · 1 other chat · notes${T}`, 'chat a answered late and is ignored');
  assert.equal(h.panel.doc().turns.total, 2);

  // a change on its way when the page moves on lands nowhere
  const m = harness({ held: ['a:reset'] });
  await m.scope('a');
  await m.open();
  await m.$('context-reset').fire('click');
  m.$('context-reset-ok').fire('click');
  await m.tick();
  await m.scope('b');
  await m.release('a:reset');
  assert.equal(m.panel.doc().turns.total, 2);
  assert.equal(m.$('context-line-text').textContent, `Context: 2 turns · 1 other chat · notes${T}`);
});

test('a run of the chat that finished reads the chat again; a run still going does not', async () => {
  const h = harness({ nav: NAV({ a: { status: 'running', runs: 8 } }) });
  await h.scope('a');
  const reads = () => h.requests.filter((r) => r.key === 'a:get').length;
  assert.equal(reads(), 1);
  h.panel.projects(NAV({ a: { status: 'running', runs: 8 } }));
  h.panel.projects(NAV({ a: { status: 'needs_human', runs: 8 } }));
  await h.tick();
  assert.equal(reads(), 1, 'the live run is never context: nothing to read');
  h.panel.projects(NAV({ a: { status: 'done', runs: 8 } }));
  await h.tick();
  assert.equal(reads(), 2);
  h.panel.projects(NAV({ a: { status: 'done', runs: 8 } }));
  h.panel.projects(NAV({ a: { status: 'done', runs: 8 }, b: { status: 'failed' } }));
  await h.tick();
  assert.equal(reads(), 2, 'the same state, or another chat, reads nothing');
  h.panel.projects(NAV({ a: { status: 'done', runs: 9 } }));
  await h.tick();
  assert.equal(reads(), 3, 'a turn that came and went between two polls');
});

test('an unreadable 200 keeps the routes and says so', async () => {
  const h = harness({ answers: { 'a:get': [200, { v: 9 }] } });
  await h.scope('a');
  assert.equal(h.$('context-line-text').textContent, 'Context: not loaded');
  await h.open();
  assert.equal(h.$('context-error').textContent, UNREADABLE);
});

// every write of a node's text, to tell a rewrite of the same alert from a new one
function writes(node) {
  const seen = [];
  let v = node.textContent;
  Object.defineProperty(node, 'textContent', { get: () => v, set: (x) => { v = x; seen.push(x); }, configurable: true });
  return seen;
}

const TRUNCATED = 'Some turns were shortened or left out to fit the limits.';

test('flags: truncated says turns were shortened or left out, in a quiet tone; degraded stays loud', async () => {
  assert.equal(flagsText(parseChatContext(chatDoc({ truncated: true }))), TRUNCATED);
  assert.match(html, /id="context-truncated" data-tone="quiet" hidden>Shortened</);
  const h = harness();
  h.server.chats.a = chatDoc({ truncated: true });
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-flags').textContent, TRUNCATED);
  assert.equal(h.$('context-flags').dataset.tone, 'quiet');
  assert.equal(h.$('context-truncated').hidden, false);
  h.server.chats.a = chatDoc({ truncated: true, degraded: true });
  await h.panel.refresh();
  assert.match(h.$('context-flags').textContent, /^Some turns .* Degraded: /);
  assert.equal(h.$('context-flags').dataset.tone, '');
});

test('an alert is written once: typing in the notes and sidebar polls do not announce it again; it clears once', async () => {
  const answers = {};
  const h = harness({ answers });
  const chat = writes(h.$('context-error'));
  const project = writes(h.$('context-project-error'));
  // a document first, so the project form (inside the content) is on screen
  await h.scope('a');
  Object.assign(answers, { 'a:get': [500, { error: 'boom' }], 'project:get': [503, { error: 'project boom' }] });
  await h.open();
  for (const text of ['a', 'ab', 'abc']) {
    h.$('context-notes').value = text;
    await h.$('context-notes').fire('input');
  }
  h.panel.projects(NAV());
  h.panel.projects(NAV({ b: { status: 'running' } }));
  h.panel.render();
  assert.deepEqual(chat, ['boom']);
  assert.deepEqual(project, ['project boom']);
  assert.equal(h.$('context-error').hidden, false);
  delete answers['a:get'];
  delete answers['project:get'];
  await h.$('context-retry').fire('click');
  await h.tick();
  h.panel.render();
  assert.deepEqual(chat, ['boom', '']);
  assert.deepEqual(project, ['project boom', '']);
  assert.equal(h.$('context-error').hidden, true);
  assert.equal(h.$('context-project-error').hidden, true);
});

test('a failed re-read keeps the older document and marks the line as not current, which still opens the drawer', async () => {
  const answers = {};
  const h = harness({ answers });
  await h.scope('a');
  assert.equal(h.$('context-line').title, 'What the next turn of this chat receives as context');
  answers['a:get'] = [500, { error: 'boom' }];
  h.panel.projects(NAV({ a: { runs: 8 } }));
  await h.tick();
  assert.equal(h.$('context-line').hidden, false);
  assert.equal(h.$('context-line-text').textContent, `Context (not current): 5 turns · 2 other chats · notes${T}`);
  assert.equal(h.$('context-line').dataset.tone, 'error');
  assert.equal(h.$('context-line').title, 'The last read failed, this is the context read before: boom');
  await h.open();
  assert.equal(h.$('context-dialog').open, true);
  assert.equal(h.$('context-content').hidden, false, 'the older document is still shown');
  assert.equal(h.$('context-error').textContent, 'boom');
  delete answers['a:get'];
  await h.$('context-retry').fire('click');
  await h.tick();
  assert.equal(h.$('context-line-text').textContent, `Context: 5 turns · 2 other chats · notes${T}`);
  assert.equal(h.$('context-line').dataset.tone, '');
  assert.equal(h.$('context-line').title, 'What the next turn of this chat receives as context');
});

test('contextLine: the legacy fallback has a section but no counters, so it is a reduced context, never none yet', () => {
  const legacy = { id: 'recent', title: 'Earlier runs (legacy fallback)', chars: 3, text: 'abc', exact: true };
  // the degraded fallback still reports the tokens of its legacy text
  assert.equal(contextLine(parseChatContext(chatDoc({ degraded: true, turns: {}, otherChats: {}, notes: {}, sections: [legacy] }))), `Context: reduced fallback${T}`);
  assert.equal(contextLine(parseChatContext(chatDoc({ degraded: true, turns: {}, otherChats: {}, notes: {}, sections: [], budget: { tokens: 20000, used: 0 } }))), 'Context: none yet');
});

test('wording: a reset also hides this chat from the other chats; notes reach the Team planner in full, others shortened', () => {
  const q = resetQuestion(parseChatContext(chatDoc()));
  assert.match(q, /also left out of what the other chats of this project see of this chat/);
  assert.doesNotMatch(q, /other chats stay as they are/);
  const hint = /id="context-notes-hint">([^<]*)</.exec(html)[1];
  // a v2 pack cuts notes that do not fit in half of the budget (context-budget-contract I3)
  assert.equal(hint, 'The Team planner gets them in full while they fit in half of its budget, below the request it comes with; other roles and Pipeline chats get a shortened copy. Empty clears them.');
  assert.match(html, /<textarea id="context-notes"[^>]*maxlength="16000"/);
  assert.match(html, /id="context-notes-count">0 \/ 16,000 · ≈0 tokens</);
});

test('notes keep the bidi marks the user typed; only displayed server text is stripped', async () => {
  const typed = 'Hebrew \u200Fמימין\u200E ok';
  assert.equal(parseProjectContext(projectDoc({ notes: { text: typed, chars: typed.length, limit: 16000, updatedAt: null } })).notes.text, typed);
  assert.equal(parseProjectContext(projectDoc({ chats: [{ id: 'a', title: 'A\u202Eb' }] })).chats[0].title, 'Ab');
  const h = harness();
  h.server.notes = typed;
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-notes').value, typed);
  assert.equal(h.$('context-notes-save').disabled, true, 'not dirty: nothing was changed on the way in');
  h.$('context-notes').value = `${typed}!`;
  await h.$('context-notes').fire('input');
  await h.$('context-project').fire('submit');
  await h.tick();
  assert.deepEqual(h.requests.find((r) => r.key === 'project:notes').body, { text: `${typed}!` });
});

test('every id inside the context drawer is used by the panel or referenced by the markup', () => {
  const start = html.indexOf('<dialog class="drawer drawer-wide" id="context-dialog"');
  const dialog = html.slice(start, html.indexOf('</dialog>', start));
  const src = fs.readFileSync(path.join(PUBLIC, 'js', 'context-panel.js'), 'utf8');
  const refs = new Set([...dialog.matchAll(/(?:aria-labelledby|aria-describedby|aria-controls|for)="([^"]+)"/g)].flatMap((m) => m[1].split(' ')));
  const ids = [...dialog.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 30);
  for (const id of ids) assert.ok(src.includes(`$('${id}')`) || refs.has(id), `#${id} is never filled nor referenced`);
});

test('every status line of the drawer is filled by one of the changes', async () => {
  const start = html.indexOf('<dialog class="drawer drawer-wide" id="context-dialog"');
  const dialog = html.slice(start, html.indexOf('</dialog>', start));
  const ids = [...dialog.matchAll(/id="([^"]+)" role="status"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3);
  const h = harness();
  const seen = Object.fromEntries(ids.map((id) => [id, writes(h.$(id))]));
  await h.scope('a');
  await h.open();
  h.$('context-cross').checked = false;
  await h.$('context-cross').fire('change');
  h.$('context-notes').value = 'Use spaces.';
  await h.$('context-notes').fire('input');
  await h.$('context-project').fire('submit');
  h.$('context-budget-value').value = '12';
  await h.$('context-budget').fire('submit');
  await h.$('context-reset').fire('click');
  await h.$('context-reset-ok').fire('click');
  await h.tick();
  assert.ok(ids.includes('context-budget-status'));
  for (const id of ids) assert.ok(seen[id].some(Boolean), `#${id} never says anything`);
});

test('a second click while a change is on its way sends one request only', async () => {
  const h = harness({ held: ['a:reset', 'a:restore'] });
  h.server.chats.a = chatDoc({ reset: { at: '2026-11-16T10:00:00.000Z' } });
  await h.scope('a');
  await h.open();
  await h.$('context-reset').fire('click');
  h.$('context-reset-ok').fire('click');
  h.$('context-reset-ok').fire('click');
  h.$('context-restore').fire('click');
  await h.tick();
  assert.deepEqual(h.requests.filter((r) => r.method === 'POST').map((r) => r.key), ['a:reset']);
  assert.equal(h.$('context-reset-ok').disabled, true);
  await h.release('a:reset');
  assert.deepEqual(h.requests.filter((r) => r.method === 'POST').map((r) => r.key), ['a:reset']);
  assert.equal(h.$('context-reset-ok').disabled, false);
});

test('closing while a notes save is on its way: no older read overwrites the saved notes, and a failure is not lost', async () => {
  const h = harness({ held: ['project:notes'] });
  await h.scope('a');
  await h.open();
  h.$('context-notes').value = 'Use spaces.';
  await h.$('context-notes').fire('input');
  h.$('context-project').fire('submit');
  await h.tick();
  await h.close.fire('click');
  assert.equal(h.confirms.at(-1).title, 'Discard notes changes?');
  h.confirms.at(-1).action();
  assert.equal(h.$('context-dialog').open, false);
  // opened again before the save answered: a read now could carry the notes from before the save
  h.late.push('project:get');
  await h.open();
  await h.release('project:notes');
  await h.release('project:get');
  assert.equal(h.$('context-notes').value, 'Use spaces.', 'the notes the server saved');
  assert.equal(h.$('context-notes').disabled, false);

  const f = harness({ held: ['project:notes'], answers: { 'project:notes': [500, { error: 'disk full' }] } });
  await f.scope('a');
  await f.open();
  f.$('context-notes').value = 'Use spaces.';
  await f.$('context-notes').fire('input');
  f.$('context-project').fire('submit');
  await f.tick();
  await f.close.fire('click');
  f.confirms.at(-1).action();
  await f.release('project:notes');
  await f.open();
  assert.equal(f.$('context-notes-error').textContent, 'disk full', 'the failure is still shown after the drawer opened again');
  assert.equal(f.$('context-notes-error').hidden, false);
  assert.equal(f.$('context-notes').value, 'Use tabs.', 'the editor shows what is saved');
  assert.equal(f.$('context-notes').disabled, false);

  // opened again before the failure answered: the read it skipped is made up for
  const g = harness({ held: ['project:notes'], answers: { 'project:notes': [500, { error: 'disk full' }] } });
  await g.scope('a');
  await g.open();
  g.$('context-notes').value = 'Use spaces.';
  await g.$('context-notes').fire('input');
  g.$('context-project').fire('submit');
  await g.tick();
  await g.close.fire('click');
  g.confirms.at(-1).action();
  await g.open();
  assert.equal(g.$('context-notes').disabled, true, 'nothing to edit until the save answered');
  await g.release('project:notes');
  await g.tick();
  assert.equal(g.$('context-notes-error').textContent, 'disk full');
  assert.equal(g.$('context-notes').value, 'Use tabs.');
  assert.equal(g.$('context-notes').disabled, false);
});

test('a failed notes or sharing change while a re-read of the chat is on its way: the chat document is read again', async () => {
  for (const kind of ['notes', 'settings']) {
    for (const how of ['refused', 'no answer']) {
      const key = `project:${kind}`;
      const answers = {};
      const reject = [];
      const h = harness({ answers, reject });
      await h.scope('a');
      await h.open();
      // a run of the chat finished; its re-read waits while the change is sent and fails
      h.held.push('a:get');
      h.server.chats.a = chatDoc({ turns: { total: 8, visible: 6, detailed: 5, condensed: 1, omitted: 0 } });
      h.panel.projects(NAV({ a: { runs: 8 } }));
      await h.tick();
      h.held.length = 0;
      if (how === 'refused') answers[key] = [409, { error: 'conflict' }];
      else reject.push(key);
      const where = h.$(kind === 'notes' ? 'context-notes-error' : 'context-cross-status');
      const seen = writes(where);
      if (kind === 'notes') {
        h.$('context-notes').value = 'Use spaces.';
        await h.$('context-notes').fire('input');
        await h.$('context-project').fire('submit');
      } else {
        h.$('context-cross').checked = false;
        await h.$('context-cross').fire('change');
      }
      await h.tick();
      const error = how === 'refused' ? 'conflict' : contextError(0, null);
      const label = `${kind}, ${how}`;
      assert.equal(where.textContent, error, label);
      assert.equal(seen.filter((t) => t === error).length, 1, `${label}: the error is shown once`);
      assert.equal(h.$('context-line-text').textContent, `Context: 6 turns · 2 other chats · notes${T}`, `${label}: the dropped read is made up for`);
      assert.equal(h.$('context-line').dataset.tone, '', label);
      assert.equal(h.$('context-figures').childNodes[1].textContent, '6 of 8 · 5 in detail · 1 condensed · 0 omitted', label);
      if (kind === 'notes') assert.equal(h.$('context-notes').value, 'Use spaces.', `${label}: the draft stays`);
      else assert.equal(h.$('context-cross').checked, true, `${label}: the saved state again`);
      // the read that was cancelled answers after all and is ignored
      h.server.chats.a = chatDoc();
      await h.release('a:get');
      assert.equal(h.panel.doc().turns.total, 8, label);
      assert.equal(seen.filter((t) => t === error).length, 1, label);
    }
  }
});

test('a failed Start fresh while a re-read of the chat is on its way reads the chat again', async () => {
  const h = harness({ answers: { 'a:reset': [500, { error: 'reset boom' }] } });
  await h.scope('a');
  await h.open();
  h.held.push('a:get');
  h.server.chats.a = chatDoc({ turns: { total: 8, visible: 6, detailed: 5, condensed: 1, omitted: 0 } });
  h.panel.projects(NAV({ a: { runs: 8 } }));
  await h.tick();
  h.held.length = 0;
  await h.$('context-reset').fire('click');
  await h.$('context-reset-ok').fire('click');
  await h.tick();
  assert.equal(h.$('context-action-status').textContent, 'reset boom');
  assert.equal(h.$('context-line-text').textContent, `Context: 6 turns · 2 other chats · notes${T}`);
});

test('a request with no answer at all: the line and the drawer say the server did not answer', async () => {
  const h = harness({ reject: ['a:get'] });
  await h.scope('a');
  assert.equal(h.$('context-line').hidden, false);
  assert.equal(h.$('context-line-text').textContent, 'Context: not loaded');
  await h.open();
  assert.match(h.$('context-error').textContent, /did not answer/);
  assert.equal(h.$('context-retry-row').hidden, false);

  const p = harness({ reject: ['project:get'] });
  await p.scope('a');
  await p.open();
  assert.match(p.$('context-project-error').textContent, /did not answer/);
  assert.equal(p.$('context-notes').disabled, true);

  const m = harness({ reject: ['a:reset'] });
  await m.scope('a');
  await m.open();
  await m.$('context-reset').fire('click');
  await m.$('context-reset-ok').fire('click');
  assert.match(m.$('context-action-status').textContent, /did not answer/);
  assert.equal(m.$('context-action-status').dataset.tone, 'error');
});

test('a failed reset closes the confirmation, shows the error once and keeps the document', async () => {
  const h = harness({ answers: { 'a:reset': [500, { error: 'reset boom' }] } });
  await h.scope('a');
  await h.open();
  const status = writes(h.$('context-action-status'));
  await h.$('context-reset').fire('click');
  await h.$('context-reset-ok').fire('click');
  h.$('context-notes').value = 'x';
  await h.$('context-notes').fire('input');
  h.panel.render();
  assert.equal(h.$('context-reset-confirm').hidden, true);
  assert.equal(globalThis.document.activeElement, h.$('context-reset'));
  assert.equal(status.filter((t) => t === 'reset boom').length, 1);
  assert.equal(h.$('context-action-status').textContent, 'reset boom');
  assert.equal(h.$('context-error').hidden, true, 'the chat document itself is fine');
  assert.equal(h.$('context-line-text').textContent, `Context: 5 turns · 2 other chats · notes${T}`);
  assert.equal(h.$('context-reset').disabled, false);
});

test('an error on the project document while the chat document is fine: the chat part works, the project part says why', async () => {
  const h = harness({ answers: { 'project:get': [500, { error: 'project boom' }] } });
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-content').hidden, false);
  assert.equal(h.$('context-error').hidden, true);
  assert.equal(h.$('context-project-error').textContent, 'project boom');
  assert.equal(h.$('context-project-error').hidden, false);
  assert.equal(h.$('context-retry-row').hidden, false);
  assert.equal(h.$('context-notes').disabled, true);
  assert.equal(h.$('context-cross').disabled, true);
  assert.equal(h.$('context-notes-save').disabled, true);
  assert.equal(h.$('context-reset').disabled, false, 'the chat changes do not need the project document');
  assert.equal(h.$('context-line-text').textContent, `Context: 5 turns · 2 other chats · notes${T}`);
});

// real documents, built by the server's own context module on a small registry under .scratch
function realDocs(t) {
  const base = path.resolve('.scratch/context-system/lane-f2');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const registry = createProjectRegistry({ dataDir, projectsRoot: path.join(root, 'workspaces') });
  const p = registry.addProject({ name: 'Project', create: true });
  const team = registry.createChat(p.id, { title: 'Team' });
  const pipe = registry.createChat(p.id, { title: 'Pipeline', engine: 'pipeline' });
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const date = '2026-01-01T00:00:00Z';
  // one turn whose request is longer than an older detailed turn keeps: the server marks the pack truncated. The
  // cap scales with the budget (context-budget-contract section 5): 1713 units for the unknown window's 12800 tokens
  write(path.join(team.hiveDir, 'runs/run1/events.jsonl'), [{ type: 'run_started', runId: 'run1', request: `Add login. ${'x'.repeat(4000)}`, ts: date }, { type: 'run_finished', runId: 'run1', status: 'success', summary: 'Delivered', ts: date }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const run = path.join(dataDir, 'projects', p.id, 'chats', pipe.id, 'pipeline/runs/pipe0001');
  write(path.join(run, 'status.json'), { status: 'succeeded', task: 'Pipeline task', created_at: date, updated_at: date });
  write(path.join(run, 'run.json'), { task: 'Pipeline task' });
  const context = createContext({ dataDir, registry, now: () => '2026-01-02T00:00:00.000Z' });
  context.setNotes(p.id, 'Use tabs.');
  const wire = (x) => JSON.parse(JSON.stringify(x));
  const broken = createContext({ dataDir, registry: { ...registry, listChats() { throw Error('injected'); } } });
  return {
    project: wire(context.status(p.id)), team: wire(context.inspect(p.id, team.id)), pipeline: wire(context.inspect(p.id, pipe.id)),
    legacy: wire(broken.inspect(p.id, team.id)), ids: { project: p.id, team: team.id, pipe: pipe.id }, context, wire,
  };
}

test('real documents from createContext: the parsers read the Team, Pipeline and project documents', (t) => {
  const r = realDocs(t);
  const team = parseChatContext(r.team);
  assert.equal(team.valid, true);
  assert.equal(team.engine, 'team');
  assert.deepEqual([team.turns.total, team.turns.visible], [1, 1]);
  assert.deepEqual(team.otherChats, { chats: 1, turns: 1 });
  assert.equal(team.notes.chars, 9);
  // no recipients given: the unknown window and the default rule
  assert.deepEqual(team.model, { id: null, window: 128000, known: false });
  assert.deepEqual([team.budget.tokens, team.budget.mode, team.budget.value, team.budget.source], [12800, 'percent', 10, 'project']);
  assert.ok(team.budget.used > 0 && team.budget.used === r.team.budget.used);
  assert.deepEqual(team.developer.budget.tokens, 1280);
  const tail = (d) => ` · ≈${compactTokens(d.budget.used)} tokens (${pct(d.budget.used, 128000)}%)`;
  assert.equal(team.truncated, true, 'one long request is enough');
  assert.equal(flagsText(team), TRUNCATED);
  assert.equal(team.sections.length, r.team.sections.length);
  assert.ok(team.sections.every((s) => s.exact && s.id in LAYER_TITLE && s.text));
  assert.ok(team.developer.text.length > 0);
  assert.equal(contextLine(team), `Context: 1 turn · 1 other chat · notes${tail(team)}`);

  const pipe = parseChatContext(r.pipeline);
  assert.equal(pipe.valid, true);
  assert.equal(pipe.engine, 'pipeline');
  assert.equal(pipe.developer, null);
  // section 8 for the unknown window: H 38400, C 12800, shown floor((H + C) / 4)
  assert.equal(pipe.budget.tokens, 12800);
  assert.ok(pipe.budget.used > 0);
  assert.deepEqual([pipe.turns.total, pipe.turns.visible, pipe.turns.detailed], [1, 1, 1]);
  assert.equal(pipe.otherChats.chats, 1);
  assert.ok(pipe.sections.length > 0 && pipe.sections.every((s) => !s.exact && s.id in LAYER_TITLE));
  assert.equal(contextLine(pipe), `Context: 1 turn · 1 other chat · notes${tail(pipe)}`);

  const project = parseProjectContext(r.project);
  assert.equal(project.valid, true);
  assert.deepEqual(project.notes.text, 'Use tabs.');
  assert.deepEqual(project.chats.map((c) => [c.id, c.engine, c.turns]).sort(), [[r.ids.pipe, 'pipeline', 1], [r.ids.team, 'team', 1]].sort());

  const legacy = parseChatContext(r.legacy);
  assert.equal(legacy.degraded, true);
  assert.equal(legacy.turns.visible, 0, 'the fallback has no counters');
  assert.ok(legacy.sections.length > 0);
  // section 9: the fallback still has the computed budget and the tokens of its legacy text
  assert.equal(legacy.budget.tokens, 12800);
  assert.ok(legacy.budget.used > 0);
  assert.equal(contextLine(legacy), `Context: reduced fallback${tail(legacy)}`);
});

test('real documents from createContext: the panel shows the Team and the Pipeline chat', async (t) => {
  const r = realDocs(t);
  for (const [doc, engine] of [[r.team, 'Team'], [r.pipeline, 'Pipeline']]) {
    const h = harness({ answers: { 'a:get': [200, doc], 'project:get': [200, r.project] } });
    await h.scope('a');
    await h.open();
    const d = parseChatContext(doc);
    assert.equal(h.$('context-line-text').textContent, contextLine(d));
    assert.equal(h.$('context-engine').textContent, engine);
    assert.equal(h.$('context-content').hidden, false);
    assert.equal(h.$('context-error').hidden, true);
    assert.deepEqual(h.$('context-sections').childNodes.map((b) => b.dataset.section), d.sections.map((s) => s.id));
    assert.equal(h.$('context-developer-section').hidden, engine === 'Pipeline');
    assert.equal(h.$('context-notes').value, 'Use tabs.');
    assert.equal(h.$('context-flags').hidden, !d.truncated && !d.degraded);
  }
});

// the recipients the server resolves, injected as it injects them (context-budget-contract section 3)
const SONNET = { id: MODEL, window: 200000, known: true };
const GPT = { id: 'openai/gpt-5', window: 400000, known: true };
const GEMINI = { id: 'google/gemini-2.5-pro', window: 1000000, known: true };

test('real documents from createContext: a known model, an override and every cap read as the server meant them', (t) => {
  const { context, ids, wire } = realDocs(t);
  const team = (planner, developer = GPT) => parseChatContext(wire(context.inspect(ids.project, ids.team, { recipients: { planner, developer } })));
  const k = (v) => v.toLocaleString('en-US');

  // a known window with the default rule: 10 % of it, nothing assumed
  const known = team(SONNET);
  assert.deepEqual(known.model, SONNET);
  assert.deepEqual([known.budget.tokens, known.budget.mode, known.budget.value, known.budget.source, known.budget.capped], [20000, 'percent', 10, 'project', null]);
  assert.equal(windowNote(known.model), '');
  assert.equal(usageText(known), `≈${k(known.budget.used)} of 20,000 tokens (${pct(known.budget.used, 20000)}% of budget · ${pct(known.budget.used, 200000)}% of the 200,000-token window)`);
  assert.deepEqual([known.developer.model, known.developer.budget.tokens], [GPT, 2000]);
  assert.equal(summaryRows(known).at(-2)[1], `${MODEL} · 200,000-token window`);

  // an override for that model
  const p = parseProjectContext(wire(context.configure(ids.project, { models: { [MODEL]: { mode: 'tokens', value: 50000 } } })));
  assert.deepEqual(plain(p.settings.models), { [MODEL]: { mode: 'tokens', value: 50000 } });
  const own = team(SONNET);
  assert.deepEqual([own.budget.tokens, own.budget.mode, own.budget.value, own.budget.source, own.budget.capped], [50000, 'tokens', 50000, 'model', null]);
  assert.deepEqual(budgetState(own, p), { id: MODEL, override: true, mode: 'tokens', value: '50000', only: true });
  assert.equal(summaryRows(own).at(-1)[1], `50,000 tokens · only for ${MODEL}`);
  assert.deepEqual(buildBudgetReset(budgetState(own, p)).body, { models: { [MODEL]: null } });
  assert.equal(team(GPT).budget.source, 'project', 'another model keeps the project rule');

  // the caps of section 4
  const half = team({ id: MODEL, window: 32000, known: true });
  assert.deepEqual([half.budget.tokens, half.budget.source, half.budget.capped], [16000, 'model', 'window']);
  assert.equal(cappedText(half), 'The budget was limited to half of the model\'s 32,000-token context window.');
  context.configure(ids.project, { budget: { mode: 'percent', value: 50 } });
  const max = team(GEMINI);
  assert.deepEqual([max.budget.tokens, max.budget.capped], [200000, 'max']);
  assert.equal(cappedText(max), 'The budget was limited to the maximum of 200,000 tokens.');
  context.configure(ids.project, { budget: { mode: 'tokens', value: 1000 } });
  const min = team({ id: 'tiny/model', window: 400, known: true });
  assert.deepEqual([min.budget.tokens, min.budget.capped], [256, 'min']);
  assert.equal(cappedText(min), 'The budget was limited to the minimum of 256 tokens; the rule asks for less.');

  // the Pipeline engine's bound for a planner with a large window (section 8: 18750 tokens)
  context.configure(ids.project, { budget: null });
  const pipe = parseChatContext(wire(context.inspect(ids.project, ids.pipe, { recipients: { planner: GEMINI } })));
  assert.deepEqual([pipe.model, pipe.budget.tokens, pipe.budget.capped, pipe.developer], [GEMINI, 18750, 'engine', null]);
  assert.match(cappedText(pipe), /^Set by the Pipeline engine's prompt budget/);
  // defaults.pipeline is optional in the project document
  const status = wire(context.status(ids.project));
  assert.deepEqual(parseProjectContext(status).defaults.pipeline, status.defaults.pipeline ?? null);
});

test('real documents from createContext: the drawer shows a capped override of a known model', async (t) => {
  const { context, ids, wire } = realDocs(t);
  const project = wire(context.configure(ids.project, { models: { [MODEL]: { mode: 'tokens', value: 50000 } } }));
  const doc = wire(context.inspect(ids.project, ids.team, { recipients: { planner: { id: MODEL, window: 32000, known: true }, developer: GPT } }));
  const h = harness({ answers: { 'a:get': [200, doc], 'project:get': [200, project] } });
  await h.scope('a');
  await h.open();
  const d = parseChatContext(doc);
  assert.equal(h.$('context-usage').textContent, usageText(d));
  assert.match(h.$('context-usage').textContent, /of 16,000 tokens .* of the 32,000-token window\)$/);
  assert.deepEqual([h.$('context-window-note').hidden, h.$('context-capped').hidden], [true, false]);
  assert.equal(h.$('context-capped').textContent, 'The budget was limited to half of the model\'s 32,000-token context window.');
  assert.deepEqual([h.$('context-budget-mode').value, h.$('context-budget-value').value, h.$('context-budget-only').checked], ['tokens', '50000', true]);
  assert.equal(h.$('context-budget-only-label').textContent, `Only for ${MODEL}`);
  assert.equal(h.$('context-budget-reset').title, `Remove the override for ${MODEL}; the project rule applies again`);
  assert.equal(h.$('context-budget-preview').textContent, `≈16,000 tokens with the 32,000-token window of ${MODEL}.`);
  assert.equal(h.$('context-developer-usage').textContent, `≈${d.developer.budget.used.toLocaleString('en-US')} of 2,000 tokens (${pct(d.developer.budget.used, 2000)}% of the brief's budget) · openai/gpt-5, 400,000-token window`);
});
