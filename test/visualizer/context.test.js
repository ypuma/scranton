// The Context surface (.enma/context-contract.md sections 8 and 10): the routes, the tolerant parsers of the project
// and chat documents, the indicator line in the follow-up composer and the drawer with its four changes. The
// server is a stub that follows the section 8 documents; nothing here starts a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextPanel } from '../../visualizer/public/js/context-panel.js';
import {
  contextUrl, chatContextUrl, parseProjectContext, parseChatContext, contextLine, summaryRows, buildNotes, buildCrossChat,
  contextError, flagsText, resetQuestion, NOTES_MAX, UNREADABLE, LAYER_TITLE,
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

function chatDoc(over = {}) {
  return {
    v: 1, engine: 'team', settings: { crossChat: true }, reset: null,
    turns: { total: 7, visible: 5, detailed: 4, condensed: 1, omitted: 0 },
    otherChats: { chats: 2, turns: 5 }, notes: { chars: 120, limit: 4000 }, memory: { chars: 0 },
    budget: { limit: 24000, used: 10321 }, truncated: false, degraded: false,
    sections: [
      { id: 'notes', title: 'Project notes', chars: 11, text: 'Use tabs.\n', exact: true },
      { id: 'recent', title: 'This chat - recent turns', chars: 40, text: '#5 [success] add login\n<b>not html</b>', exact: true },
    ],
    developer: { chars: 30, text: 'Notes: Use tabs.\n#5 [success] add login' },
    ...over,
  };
}

const projectDoc = (over = {}) => ({
  v: 1, settings: { crossChat: true }, notes: { text: 'Use tabs.', chars: 9, limit: 4000, updatedAt: '2026-11-16T10:00:00.000Z' },
  chats: [{ id: 'a', title: 'Alpha', engine: 'team', turns: 7, lastActiveAt: null, reset: false }], ...over,
});

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

test('parseChatContext: the section 8 document as it is, malformed parts as safe defaults, never a throw', () => {
  const d = parseChatContext(chatDoc());
  assert.equal(d.valid, true);
  assert.deepEqual(d.turns, { total: 7, visible: 5, detailed: 4, condensed: 1, omitted: 0 });
  assert.deepEqual(d.budget, { limit: 24000, used: 10321 });
  assert.deepEqual(d.sections.map((s) => [s.id, s.chars, s.exact]), [['notes', 11, true], ['recent', 40, true]]);
  assert.equal(d.sections[1].text, '#5 [success] add login\n<b>not html</b>', 'the text is kept verbatim, line breaks included');
  assert.equal(d.developer.text, 'Notes: Use tabs.\n#5 [success] add login');

  for (const junk of [null, undefined, 7, 'x', [], { v: 2 }, { ...chatDoc(), v: '1' }]) {
    const x = parseChatContext(junk);
    assert.equal(x.valid, false);
    assert.equal(contextLine(x), '', 'an unreadable document says nothing in the line');
    assert.deepEqual(x.sections, []);
    assert.equal(x.settings.crossChat, true, 'the storage default');
  }
  const odd = parseChatContext(chatDoc({
    engine: 'robot', reset: { at: 'yesterday' }, turns: { total: -1, visible: 2.5, detailed: '4' }, budget: 'big', truncated: 'yes',
    sections: [{ id: 'recent', text: 'a\u202Eb' }, { id: 'recent', text: 'dup' }, { id: '../x', text: 'bad id' }, { id: 'earlier', text: '' }, 'nope', { id: 'memory', text: 42 }],
    developer: 'brief',
  }));
  assert.equal(odd.engine, 'team');
  assert.equal(odd.reset, null, 'a marker without a time is no marker');
  assert.deepEqual(odd.turns, { total: 0, visible: 0, detailed: 0, condensed: 0, omitted: 0 });
  assert.deepEqual(odd.budget, { limit: 24000, used: 0 });
  assert.equal(odd.truncated, false);
  assert.deepEqual(odd.sections.map((s) => [s.id, s.title, s.text, s.chars, s.exact]), [['recent', 'This chat - recent turns', 'ab', 2, false]], 'duplicates, bad ids and empty layers are dropped; bidi controls stripped');
  assert.equal(odd.developer, null);

  const pipe = parseChatContext(chatDoc({ engine: 'pipeline', budget: { used: 900 }, developer: { chars: 3, text: 'x' } }));
  assert.equal(pipe.budget.limit, 32768, 'a pipeline pack is measured against its wire budget');
  assert.equal(pipe.developer, null, 'a pipeline chat has no developer brief');
  assert.match(summaryRows(pipe).at(-1)[1], /^900 of 32,768 bytes/);
});

test('parseProjectContext: settings, notes and chats; junk reads as the defaults', () => {
  const p = parseProjectContext(projectDoc({ settings: { crossChat: false } }));
  assert.equal(p.valid, true);
  assert.equal(p.settings.crossChat, false);
  assert.deepEqual(p.notes, { text: 'Use tabs.', chars: 9, limit: 4000, updatedAt: '2026-11-16T10:00:00.000Z' });
  assert.deepEqual(p.chats.map((c) => [c.id, c.engine, c.turns]), [['a', 'team', 7]]);
  for (const junk of [null, 'x', { v: 1, settings: 'off', notes: [], chats: {} }, { v: 3, settings: { crossChat: false } }]) {
    const x = parseProjectContext(junk);
    assert.equal(x.settings.crossChat, true);
    assert.deepEqual(x.notes, { text: '', chars: 0, limit: 4000, updatedAt: null });
    assert.deepEqual(x.chats, []);
  }
  assert.equal(parseProjectContext({ v: 1, chats: [{ id: '../x' }, { id: 'ok', title: 5, engine: 'pipeline' }] }).chats[0].title, 'Untitled chat');
});

test('contextLine: turns, other chats, notes, nothing yet, and the fresh start', () => {
  const line = (over) => contextLine(parseChatContext(chatDoc(over)));
  assert.equal(line(), 'Context: 5 turns · 2 other chats · notes');
  assert.equal(line({ turns: { total: 0, visible: 0 } }), 'Context: 2 other chats · notes', 'a fresh chat with project context only');
  assert.equal(line({ turns: { total: 1, visible: 1 }, otherChats: { chats: 1, turns: 1 }, notes: { chars: 0 } }), 'Context: 1 turn · 1 other chat');
  assert.equal(line({ turns: {}, otherChats: {}, notes: {}, memory: { chars: 300 } }), 'Context: memory');
  assert.equal(line({ turns: {}, otherChats: {}, notes: {}, sections: [] }), 'Context: none yet');
  assert.equal(line({ reset: { at: '2026-11-16T10:00:00.000Z' }, turns: { total: 7, visible: 2 } }), 'Context: 2 turns since the fresh start · 2 other chats · notes');
  assert.equal(line({ reset: { at: '2026-11-16T10:00:00.000Z' }, turns: { total: 7, visible: 0 }, otherChats: {}, notes: {} }), 'Context: fresh start');
});

test('request bodies: crossChat is a boolean, notes at most 4000 chars (JS string length) with CRLF as LF', () => {
  assert.deepEqual(buildCrossChat(false), { body: { crossChat: false } });
  assert.ok(buildCrossChat('false').error);
  assert.deepEqual(buildNotes('a\r\nb\rc'), { body: { text: 'a\nb\nc' } });
  assert.deepEqual(buildNotes(''), { body: { text: '' } }, 'empty clears');
  assert.deepEqual(buildNotes('x'.repeat(NOTES_MAX)), { body: { text: 'x'.repeat(NOTES_MAX) } });
  assert.match(buildNotes(`${'x'.repeat(NOTES_MAX)}y`).error, /4,001 characters; the limit is 4,000/);
  // the unit of the textarea's maxlength: an emoji is two
  const emoji = '\u{1F600}'.repeat(NOTES_MAX / 2);
  assert.deepEqual(buildNotes(emoji), { body: { text: emoji } });
  assert.match(buildNotes(`${emoji}x`).error, /4,001 characters/);
  // a CRLF counts once, as the server stores it
  assert.deepEqual(buildNotes(`${'x'.repeat(NOTES_MAX - 1)}\r\n`), { body: { text: `${'x'.repeat(NOTES_MAX - 1)}\n` } });
  assert.equal(buildNotes(3).field, 'notes');
  assert.match(contextError(404, { error: 'Not found' }), /does not offer context/);
  assert.equal(contextError(400, { error: 'Invalid body' }), 'Invalid body');
  assert.match(contextError(0, null), /did not answer/);
});

// the panel with a stub server; held: keys whose answer waits for release(key); late: answered as the server stood
// when asked, delivered on release(key); reject: keys whose fetch rejects (no answer at all)
function harness({ nav = NAV(), answers = {}, held = [], late = [], reject = [] } = {}) {
  const $ = installDom();
  const close = new FakeEl();
  $('context-dialog').querySelectorAll = () => [close];
  $('context-dialog').querySelector = () => close;
  $('context-line').isConnected = true;
  const requests = [];
  const waiting = new Map();
  const server = { crossChat: true, notes: 'Use tabs.', chats: { a: chatDoc(), b: chatDoc({ turns: { total: 2, visible: 2, detailed: 2, condensed: 0, omitted: 0 }, otherChats: { chats: 1, turns: 7 } }) } };
  const project = () => projectDoc({ settings: { crossChat: server.crossChat }, notes: { text: server.notes, chars: server.notes.length, limit: 4000, updatedAt: null } });
  const reply = (code, body) => ({ ok: code < 300, status: code, json: async () => structuredClone(body) });
  globalThis.fetch = (url, opts = {}) => {
    const m = /^\/api\/projects\/([a-z0-9-]+)(?:\/chats\/([^/]+))?\/context(?:\/([a-z]+))?$/.exec(url);
    const key = m[2] ? `${m[2]}:${m[3] ?? 'get'}` : `project:${m[3] ?? 'get'}`;
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    requests.push({ url, key, method: opts.method ?? 'GET', headers: opts.headers ?? {}, cache: opts.cache, body });
    const answer = () => {
      if (answers[key]) return reply(...answers[key]);
      if (key === 'project:settings') server.crossChat = body.crossChat;
      if (key === 'project:notes') server.notes = body.text;
      if (m[3] === 'reset') server.chats[m[2]] = { ...server.chats[m[2]], reset: { at: '2026-11-16T12:00:00.000Z' }, turns: { total: 7, visible: 0, detailed: 0, condensed: 0, omitted: 0 }, sections: server.chats[m[2]].sections.filter((s) => s.id !== 'recent') };
      if (m[3] === 'restore') server.chats[m[2]] = chatDoc();
      if (!m[2]) return reply(200, project());
      const doc = server.chats[m[2]];
      return reply(200, { ...doc, settings: { crossChat: server.crossChat }, ...(server.crossChat ? {} : { otherChats: { chats: 0, turns: 0 } }) });
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
  const panel = createContextPanel({ getProjects: () => navDoc, confirm: (c) => confirms.push(c) });
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
  assert.equal(h.$('context-line-text').textContent, 'Context: 5 turns · 2 other chats · notes');

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
  assert.deepEqual(figures.filter((_, i) => i % 2 === 0), ['Turns', 'Other chats', 'Project notes', 'Project memory', 'Budget used']);
  assert.equal(figures[1], '5 of 7 · 4 in detail · 1 condensed · 0 omitted');
  assert.equal(figures[9], '10,321 of 24,000 characters (43%)');
  const blocks = h.$('context-sections').childNodes;
  assert.deepEqual(blocks.map((b) => b.dataset.section), ['notes', 'recent']);
  const [summary, note, pre] = blocks[1].childNodes;
  assert.deepEqual(summary.childNodes.map((x) => x.textContent), ['This chat - recent turns', 'Exact', '40 chars']);
  assert.equal(note.textContent, 'Exact text the next turn receives.');
  assert.equal(pre.textContent, '#5 [success] add login\n<b>not html</b>', 'set as text, never parsed');
  assert.equal(pre.tabIndex, 0);
  assert.equal(h.$('context-developer-section').hidden, false);
  assert.equal(h.$('context-developer').childNodes[0].childNodes[2].textContent, 'Notes: Use tabs.\n#5 [success] add login');
  assert.equal(h.$('context-restore').hidden, true, 'no marker, nothing to restore');
  assert.equal(h.$('context-cross').checked, true);
  assert.equal(h.$('context-notes').value, 'Use tabs.');
  assert.equal(h.$('context-notes-count').textContent, '9 / 4,000');
  assert.equal(h.$('context-notes-save').disabled, true, 'nothing changed yet');
});

test('a pipeline chat shows readable summaries and no developer brief', async () => {
  const h = harness();
  h.server.chats.a = chatDoc({ engine: 'pipeline', budget: { limit: 32768, used: 2048 }, developer: null, sections: [{ id: 'recent', title: 'This chat - recent turns', chars: 9, text: '{"runs":[]}', exact: false }] });
  await h.scope('a');
  await h.open();
  assert.equal(h.$('context-engine').textContent, 'Pipeline');
  assert.equal(h.$('context-developer-section').hidden, true);
  const [summary, note] = h.$('context-sections').childNodes[0].childNodes;
  assert.equal(summary.childNodes[1].textContent, 'Summary');
  assert.match(note.textContent, /readable summary .* not the literal text/);
});

test('sharing switch: POST settings with the control headers, re-rendered from the answer, the chat read again', async () => {
  const h = harness();
  await h.scope('a');
  await h.open();
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
  assert.equal(h.$('context-line-text').textContent, 'Context: 5 turns · notes');
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
  assert.equal(h.$('context-notes-count').textContent, '29 / 4,000', 'the counter counts like maxlength');
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
  assert.match(h.$('context-notes-error').textContent, /4,001 characters/);
  assert.equal(h.$('context-notes').getAttribute('aria-invalid'), 'true');
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
  assert.equal(h.$('context-line-text').textContent, 'Context: fresh start · 2 other chats · notes');
  assert.match(h.$('context-reset-at').textContent, /^Fresh start /);
  assert.equal(h.$('context-restore').hidden, false);
  assert.deepEqual(h.$('context-sections').childNodes.map((b) => b.dataset.section), ['notes']);

  await h.$('context-restore').fire('click');
  const restore = h.requests.at(-1);
  assert.deepEqual([restore.method, restore.url, restore.body], ['POST', '/api/projects/core/chats/a/context/restore', {}]);
  assert.equal(h.$('context-restore').hidden, true);
  assert.equal(h.$('context-line-text').textContent, 'Context: 5 turns · 2 other chats · notes');
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

test('a reply for the chat that was on screen before is dropped', async () => {
  const h = harness({ held: ['a:get'] });
  h.panel.setScope({ project: 'core', chat: 'a' });
  await h.tick();
  await h.scope('b');
  assert.equal(h.$('context-line-text').textContent, 'Context: 2 turns · 1 other chat · notes');
  await h.release('a:get');
  assert.equal(h.$('context-line-text').textContent, 'Context: 2 turns · 1 other chat · notes', 'chat a answered late and is ignored');
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
  assert.equal(m.$('context-line-text').textContent, 'Context: 2 turns · 1 other chat · notes');
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
  assert.equal(h.$('context-line-text').textContent, 'Context (not current): 5 turns · 2 other chats · notes');
  assert.equal(h.$('context-line').dataset.tone, 'error');
  assert.equal(h.$('context-line').title, 'The last read failed, this is the context read before: boom');
  await h.open();
  assert.equal(h.$('context-dialog').open, true);
  assert.equal(h.$('context-content').hidden, false, 'the older document is still shown');
  assert.equal(h.$('context-error').textContent, 'boom');
  delete answers['a:get'];
  await h.$('context-retry').fire('click');
  await h.tick();
  assert.equal(h.$('context-line-text').textContent, 'Context: 5 turns · 2 other chats · notes');
  assert.equal(h.$('context-line').dataset.tone, '');
  assert.equal(h.$('context-line').title, 'What the next turn of this chat receives as context');
});

test('contextLine: the legacy fallback has a section but no counters, so it is a reduced context, never none yet', () => {
  const legacy = { id: 'recent', title: 'Earlier runs (legacy fallback)', chars: 3, text: 'abc', exact: true };
  assert.equal(contextLine(parseChatContext(chatDoc({ degraded: true, turns: {}, otherChats: {}, notes: {}, sections: [legacy] }))), 'Context: reduced fallback');
  assert.equal(contextLine(parseChatContext(chatDoc({ degraded: true, turns: {}, otherChats: {}, notes: {}, sections: [] }))), 'Context: none yet');
});

test('wording: a reset also hides this chat from the other chats; notes reach the Team planner in full, others shortened', () => {
  const q = resetQuestion(parseChatContext(chatDoc()));
  assert.match(q, /also left out of what the other chats of this project see of this chat/);
  assert.doesNotMatch(q, /other chats stay as they are/);
  const hint = /id="context-notes-hint">([^<]*)</.exec(html)[1];
  assert.equal(hint, 'The Team planner gets them in full, below the request it comes with; other roles and Pipeline chats get a shortened copy. Empty clears them.');
});

test('notes keep the bidi marks the user typed; only displayed server text is stripped', async () => {
  const typed = 'Hebrew \u200Fמימין\u200E ok';
  assert.equal(parseProjectContext(projectDoc({ notes: { text: typed, chars: typed.length, limit: 4000, updatedAt: null } })).notes.text, typed);
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
  await h.$('context-reset').fire('click');
  await h.$('context-reset-ok').fire('click');
  await h.tick();
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
      assert.equal(h.$('context-line-text').textContent, 'Context: 6 turns · 2 other chats · notes', `${label}: the dropped read is made up for`);
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
  assert.equal(h.$('context-line-text').textContent, 'Context: 6 turns · 2 other chats · notes');
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
  assert.equal(h.$('context-line-text').textContent, 'Context: 5 turns · 2 other chats · notes');
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
  assert.equal(h.$('context-line-text').textContent, 'Context: 5 turns · 2 other chats · notes');
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
  // one turn whose request is longer than an older detailed turn keeps: the server marks the pack truncated
  write(path.join(team.hiveDir, 'runs/run1/events.jsonl'), [{ type: 'run_started', runId: 'run1', request: `Add login. ${'x'.repeat(900)}`, ts: date }, { type: 'run_finished', runId: 'run1', status: 'success', summary: 'Delivered', ts: date }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const run = path.join(dataDir, 'projects', p.id, 'chats', pipe.id, 'pipeline/runs/pipe0001');
  write(path.join(run, 'status.json'), { status: 'succeeded', task: 'Pipeline task', created_at: date, updated_at: date });
  write(path.join(run, 'run.json'), { task: 'Pipeline task' });
  const context = createContext({ dataDir, registry, now: () => '2026-01-02T00:00:00.000Z' });
  context.setNotes(p.id, 'Use tabs.');
  const wire = (x) => JSON.parse(JSON.stringify(x));
  const broken = createContext({ dataDir, registry: { ...registry, listChats() { throw Error('injected'); } } });
  return {
    project: wire(context.status(p.id)), team: wire(context.inspect(p.id, team.id)), pipeline: wire(context.inspect(p.id, pipe.id)),
    legacy: wire(broken.inspect(p.id, team.id)), ids: { team: team.id, pipe: pipe.id },
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
  assert.equal(team.budget.limit, 24000);
  assert.ok(team.budget.used > 0 && team.budget.used === r.team.budget.used);
  assert.equal(team.truncated, true, 'one long request is enough');
  assert.equal(flagsText(team), TRUNCATED);
  assert.equal(team.sections.length, r.team.sections.length);
  assert.ok(team.sections.every((s) => s.exact && s.id in LAYER_TITLE && s.text));
  assert.ok(team.developer.text.length > 0);
  assert.equal(contextLine(team), 'Context: 1 turn · 1 other chat · notes');

  const pipe = parseChatContext(r.pipeline);
  assert.equal(pipe.valid, true);
  assert.equal(pipe.engine, 'pipeline');
  assert.equal(pipe.developer, null);
  assert.equal(pipe.budget.limit, 32768);
  assert.deepEqual([pipe.turns.total, pipe.turns.visible, pipe.turns.detailed], [1, 1, 1]);
  assert.equal(pipe.otherChats.chats, 1);
  assert.ok(pipe.sections.length > 0 && pipe.sections.every((s) => !s.exact && s.id in LAYER_TITLE));
  assert.equal(contextLine(pipe), 'Context: 1 turn · 1 other chat · notes');

  const project = parseProjectContext(r.project);
  assert.equal(project.valid, true);
  assert.deepEqual(project.notes.text, 'Use tabs.');
  assert.deepEqual(project.chats.map((c) => [c.id, c.engine, c.turns]).sort(), [[r.ids.pipe, 'pipeline', 1], [r.ids.team, 'team', 1]].sort());

  const legacy = parseChatContext(r.legacy);
  assert.equal(legacy.degraded, true);
  assert.equal(legacy.turns.visible, 0, 'the fallback has no counters');
  assert.ok(legacy.sections.length > 0);
  assert.equal(contextLine(legacy), 'Context: reduced fallback');
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
