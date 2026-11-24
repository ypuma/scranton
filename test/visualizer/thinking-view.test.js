// The Thinking view on screen (js/thinking-view.js): blocks with a label row, payloads as code, tool calls as one
// run, folding that survives a redraw, copy, the agent strip, one agent over the whole width, and "Jump to latest".
// Driven with the tree fake DOM; the stream of a column is made in thoughts.js (thinking.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createThinkingView } from '../../visualizer/public/js/thinking-view.js';
import { groupTools, columnText, entryText } from '../../visualizer/public/js/thoughts.js';
import { installTree, all } from './fixtures/tree-dom.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const EVIL = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
const LINES = (n, word = 'Line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n');
const at = (s) => `2026-11-16T10:00:${String(s).padStart(2, '0')}Z`;
const item = (id, kind, text, ts = at(1)) => ({ id, kind, ts, text, cut: false });
const col = (over = {}) => ({ id: 'dwight-m1', name: 'dwight-m1', role: 'Developer · m1', status: 'working', live: true, line: 'Editing cli.js', items: [], open: null, ...over });

// The view, opened. draw(columns): what main.js gives it about once a second.
function harness() {
  const $ = installTree();
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t) => { copied.push(t); } } } });
  // as in the page: the note and the columns are the view's own children
  $('think-view').append($('think-note'), $('think-cols'));
  const view = createThinkingView();
  const h = { $, view, copied };
  h.draw = (columns, live = true) => view.render({ runId: 'r1', columns, off: false, live });
  h.cols = () => $('think-cols').children;
  h.column = (id) => h.cols().find((c) => c.querySelector('.think-name').textContent === id);
  h.blocks = (id) => h.column(id).querySelectorAll('.think-item');
  h.strip = () => $('think-view').querySelector('.think-strip');
  h.chips = () => h.strip().querySelectorAll('.think-chip').filter((b) => !b.hidden);
  h.chip = (id) => h.chips().find((b) => b.querySelector('.think-chip-name')?.textContent === id);
  $('bar-think').click();
  return h;
}

test('the stream as it is laid out: a run of tool calls is one entry that grows, and a column copies as plain text', () => {
  const items = [item('t1', 'reasoning', 'Look first'), item('e7', 'tool', 'Reading cli.js', at(3)), item('e8', 'tool', 'Editing cli.js', at(5)), item('t2', 'answer', 'Done.', at(6)), item('e9', 'tool', 'Running node --test', at(7))];
  const groups = groupTools(items);
  assert.deepEqual(groups.map((x) => [x.id, x.kind, x.calls?.map((c) => c.text)]), [
    ['t1', 'reasoning', undefined], ['ge7', 'tools', ['Reading cli.js', 'Editing cli.js']], ['t2', 'answer', undefined], ['ge9', 'tools', ['Running node --test']],
  ]);
  assert.equal(groupTools([...items, item('e10', 'tool', 'Reading a.js', at(8))]).at(-1).id, 'ge9', 'a run that grows keeps its name');
  assert.deepEqual(groupTools(undefined), []);
  assert.equal(entryText(groups[1]), 'Reading cli.js\nEditing cli.js');
  assert.equal(columnText(col({ items, open: { kind: 'reasoning', label: 'Reasoning', body: 'Now the tests', cut: true } })), [
    'dwight-m1 · Developer · m1',
    `Reasoning · ${at(1)}\nLook first`,
    `Tools · ${at(3)}\nReading cli.js\nEditing cli.js`,
    `Answer · ${at(6)}\nDone.`,
    `Tools · ${at(7)}\nRunning node --test`,
    'Reasoning · in progress\n... Now the tests',
  ].join('\n\n'));
});

test('a block: a label row with its time and a copy button, the text under it; tool calls of a run are one list', () => {
  const h = harness();
  h.draw([col({ items: [item('t1', 'reasoning', `Check ${EVIL}`), item('e7', 'tool', 'Reading cli.js', at(3)), item('e8', 'tool', 'Editing cli.js', at(5)), item('t2', 'answer', '## Result\n- one\n- two', at(6))] })]);
  const [reasoning, tools, answer] = h.blocks('dwight-m1');
  assert.deepEqual(h.blocks('dwight-m1').map((b) => [b.tagName, b.dataset.kind]), [['ARTICLE', 'reasoning'], ['SECTION', 'tools'], ['ARTICLE', 'answer']]);
  assert.deepEqual(reasoning.querySelector('.think-item-head').children.map((n) => [n.tagName, n.className]), [['SPAN', 'think-label'], ['TIME', 'chat-time mono'], ['BUTTON', 'copy-btn']]);
  assert.equal(reasoning.querySelector('.think-label').textContent, 'Reasoning');
  assert.equal(reasoning.querySelector('time').dateTime, at(1));
  assert.equal(reasoning.querySelector('.copy-btn').getAttribute('aria-label'), 'Copy reasoning');
  assert.equal(reasoning.querySelector('.think-body').textContent, `Check ${EVIL}`);
  assert.ok(!all(h.$('think-cols')).some((n) => ['IMG', 'SCRIPT'].includes(n.tagName)), 'model text never becomes markup');
  // an answer goes through the Markdown subset of the Chat view
  assert.deepEqual(answer.querySelector('.think-body').children.map((n) => n.tagName), ['H4', 'UL']);
  // the two calls read as one run
  assert.equal(tools.getAttribute('aria-label'), '2 tool calls');
  assert.deepEqual(tools.querySelector('.think-tools').children.map((li) => li.children.map((n) => [n.className, n.textContent])), [
    [['think-tool-time', tools.querySelector('time').textContent], ['think-tool-text', 'Reading cli.js']],
    [['think-tool-time', tools.querySelectorAll('time')[1].textContent], ['think-tool-text', 'Editing cli.js']],
  ]);
  assert.equal(h.column('dwight-m1').querySelector('.think-scroll').getAttribute('aria-live'), 'off');

  // the next tick: the same nodes; a third call joins the run it belongs to
  h.draw([col({ items: [item('t1', 'reasoning', `Check ${EVIL}`), item('e7', 'tool', 'Reading cli.js', at(3)), item('e8', 'tool', 'Editing cli.js', at(5)), item('e9', 'tool', 'Running node --test', at(5)), item('t2', 'answer', '## Result\n- one\n- two', at(6))] })]);
  assert.deepEqual(h.blocks('dwight-m1'), [reasoning, tools, answer], 'no block is built again');
  assert.equal(tools.querySelector('.think-tools').children.length, 3);
  assert.equal(tools.getAttribute('aria-label'), '3 tool calls');
});

test('a payload is a code block: JSON as a whole, a fence inside prose, and the block being written from its first line', () => {
  const h = harness();
  const plan = { milestones: [{ id: 'm1', title: 'Storage', dependsOn: [] }] };
  const fence = '`'.repeat(3);
  h.draw([col({ id: 'michael', name: 'michael', live: false, status: 'done', items: [
    item('t1', 'answer', JSON.stringify(plan)), item('t2', 'answer', `Run it:\n${fence}sh\nnpm test\n  --watch=false\n${fence}\nThen read the output.`, at(2)), item('t3', 'reasoning', 'Plain prose [not a payload].', at(3)),
  ] })]);
  const [json, fenced, prose] = h.blocks('michael');
  const pre = json.querySelector('pre');
  assert.deepEqual([pre.className, pre.dataset.lang], ['code-block copy-host', 'json']);
  assert.equal(pre.querySelector('code').textContent, JSON.stringify(plan, null, 2), 'one line of JSON is laid out, every key and value as it was');
  const lines = pre.querySelectorAll('.code-line');
  assert.deepEqual(lines.slice(0, 4).map((l) => [l.textContent, l.style['--indent']]), [['{\n', undefined], ['  "milestones": [\n', '2'], ['    {\n', '4'], ['      "id": "m1",\n', '6']],
    'each line knows its indent, so a wrapped line hangs under it');
  assert.deepEqual(fenced.querySelector('.think-body').children.map((n) => n.tagName), ['P', 'PRE', 'P']);
  assert.equal(fenced.querySelector('pre').querySelector('code').textContent, 'npm test\n  --watch=false');
  assert.equal(prose.querySelector('pre'), null);

  // the block in progress cannot be parsed yet: it is set as code when it starts like a payload
  h.draw([col({ id: 'michael', name: 'michael', open: { kind: 'answer', label: 'Answer', body: '{\n  "milestones": [', cut: false } })]);
  const open = h.blocks('michael').at(-1);
  assert.deepEqual([open.dataset.open, open.dataset.kind, open.dataset.payload, open.querySelector('.think-text').textContent], ['true', 'answer', 'true', '{\n  "milestones": [']);
  h.draw([col({ id: 'michael', name: 'michael', open: { kind: 'reasoning', label: 'Reasoning', body: 'The plan needs [three] steps', cut: true } })]);
  assert.deepEqual([open.dataset.payload, open.querySelector('.think-text').textContent, open.querySelector('.think-now').textContent], ['false', '... The plan needs [three] steps', 'now']);
  const css = read('styles.css');
  assert.match(css, /\.code-line \{[^}]*padding-left: calc\(var\(--indent, 0\) \* 1ch\); text-indent: calc\(var\(--indent, 0\) \* -1ch\); \}/);
  assert.match(css, /\.code-block code \{[^}]*white-space: pre-wrap; overflow-wrap: anywhere; \}/, 'a code block wraps: nothing scrolls sideways');
  assert.match(css, /\.think-item\[data-payload="true"\] \.think-text \{ font: var\(--fs-s\)\/1\.55 var\(--mono\); \}/);
});

test('folding: a long block shows about twelve lines until it is opened, and what the reader opened stays open across redraws', async () => {
  const h = harness();
  const items = [item('t1', 'reasoning', LINES(30)), item('t2', 'answer', 'Short.', at(2)), item('t3', 'answer', LINES(40, 'Row'), at(3))];
  h.draw([col({ live: false, status: 'done', items })], false);
  const [long, short, last] = h.blocks('dwight-m1');
  const more = long.querySelector('.clamp-more');
  assert.deepEqual([long.querySelector('.think-body').dataset.clamp, more.hidden, more.textContent, more.getAttribute('aria-expanded'), more.type], ['closed', false, 'Show all (30 lines)', 'false', 'button']);
  assert.ok(long.querySelector('.think-body').textContent.includes('Line 30'), 'the whole text is in the page; the stylesheet cuts it');
  assert.deepEqual([short.querySelector('.think-body').dataset.clamp, short.querySelector('.clamp-more').hidden], [undefined, true], 'a short block has nothing to fold');
  assert.equal(last.querySelector('.think-body').dataset.clamp, 'closed', 'an agent that is done: its last block folds like the others');

  await more.click();
  assert.deepEqual([long.querySelector('.think-body').dataset.clamp, more.textContent, more.getAttribute('aria-expanded')], ['open', 'Show less', 'true']);
  // the view is drawn again, with one more block
  h.draw([col({ live: false, status: 'done', items: [...items, item('t4', 'reasoning', 'After.', at(4))] })], false);
  assert.equal(h.blocks('dwight-m1')[0], long, 'the same node');
  assert.equal(long.querySelector('.think-body').dataset.clamp, 'open', 'still open');
  assert.equal(last.querySelector('.think-body').dataset.clamp, 'closed', 'and what was not opened is still folded');
  await more.click();
  h.draw([col({ live: false, status: 'done', items })], false);
  assert.deepEqual([long.querySelector('.think-body').dataset.clamp, more.textContent], ['closed', 'Show all (30 lines)'], 'closed again, and it stays closed');
  assert.match(read('styles.css'), /\[data-clamp="closed"\] \{\s*max-height: var\(--clamp-h, 19\.2em\);\s*overflow: hidden;/);
});

test('folding: the block being written is never folded, nor the newest block of an agent at work', () => {
  const h = harness();
  const items = [item('t1', 'reasoning', LINES(30)), item('t2', 'answer', LINES(40, 'Row'), at(2))];
  h.draw([col({ items })]);
  const [first, newest] = h.blocks('dwight-m1');
  assert.equal(first.querySelector('.think-body').dataset.clamp, 'closed');
  assert.deepEqual([newest.querySelector('.think-body').dataset.clamp, newest.querySelector('.clamp-more').hidden], [undefined, true], 'the agent works: its newest block is read as it stands');
  // it starts the next block: that one is being written, the one before folds
  h.draw([col({ items, open: { kind: 'reasoning', label: 'Reasoning', body: LINES(60), cut: false } })]);
  const open = h.blocks('dwight-m1').at(-1);
  assert.equal(newest.querySelector('.think-body').dataset.clamp, 'closed');
  assert.deepEqual([open.dataset.open, open.querySelector('.think-body').dataset.clamp, open.querySelector('.clamp-more')], ['true', undefined, null], 'no fold and no button on the block in progress');
  // a long run of tool calls folds like a text, and not while it is the newest thing of a working agent
  const calls = Array.from({ length: 20 }, (_, i) => item(`e${i}`, 'tool', `Reading f${i}.js`, at(i)));
  h.draw([col({ items: calls })]);
  const run = h.blocks('dwight-m1')[0];
  assert.equal(run.querySelector('.think-tools').dataset.clamp, undefined);
  h.draw([col({ items: [...calls, item('t9', 'answer', 'Done.', at(30))] })]);
  assert.deepEqual([run.querySelector('.think-tools').dataset.clamp, run.querySelector('.clamp-more').textContent], ['closed', 'Show all (20 lines)']);
});

test('Expand all / Collapse all per column: every long block at once, new ones included, one closed by hand stays closed', async () => {
  const h = harness();
  const items = [item('t1', 'reasoning', LINES(30)), item('t2', 'answer', LINES(40, 'Row'), at(2))];
  const done = (list) => [col({ live: false, status: 'done', items: list }), col({ id: 'angela-m1', name: 'angela-m1', live: false, status: 'done', items: [item('a1', 'answer', LINES(25), at(1))] })];
  h.draw(done(items), false);
  const expand = h.column('dwight-m1').querySelector('.think-expand');
  const clamps = (id = 'dwight-m1') => h.blocks(id).map((b) => b.querySelector('.think-body').dataset.clamp);
  assert.deepEqual([expand.hidden, expand.textContent, expand.type], [false, 'Expand all', 'button']);
  await expand.click();
  assert.deepEqual([clamps(), expand.textContent], [['open', 'open'], 'Collapse all']);
  assert.deepEqual(clamps('angela-m1'), ['closed'], 'the other column is left alone');
  // a block that arrives afterwards is open too, and the redraw keeps the rest
  const more = [...items, item('t3', 'reasoning', LINES(20, 'New'), at(3))];
  h.draw(done(more), false);
  assert.deepEqual(clamps(), ['open', 'open', 'open']);
  // one closed by hand: the column no longer says "Collapse all", and the redraw keeps the choice
  await h.blocks('dwight-m1')[1].querySelector('.clamp-more').click();
  assert.deepEqual([clamps(), expand.textContent], [['open', 'closed', 'open'], 'Expand all']);
  h.draw(done(more), false);
  assert.deepEqual(clamps(), ['open', 'closed', 'open']);
  await expand.click();
  await expand.click();
  assert.deepEqual([clamps(), expand.textContent], [['closed', 'closed', 'closed'], 'Expand all']);
  // nothing to fold: no button
  h.draw([col({ live: false, items: [item('t9', 'answer', 'Short.')] })], false);
  assert.equal(h.column('dwight-m1').querySelector('.think-expand').hidden, true);
});

test('copy: every block copies its own text as it was written, and "Copy all" the whole column', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const json = '{"milestones":[{"id":"m1"}]}';
  const items = [item('t1', 'reasoning', '**Plan** it'), item('e7', 'tool', 'Reading cli.js', at(3)), item('e8', 'tool', 'Editing cli.js', at(4)), item('t2', 'answer', json, at(5))];
  const column = col({ items, open: { kind: 'answer', label: 'Answer', body: 'Writing', cut: false } });
  h.draw([column]);
  const [reasoning, tools, answer, open] = h.blocks('dwight-m1');
  await reasoning.querySelector('.copy-btn').click();
  await tools.querySelector('.copy-btn').click();
  await answer.querySelector('.think-item-head').querySelector('.copy-btn').click();
  await answer.querySelector('pre').querySelector('.copy-btn').click();
  await open.querySelector('.copy-btn').click();
  assert.deepEqual(h.copied, ['**Plan** it', 'Reading cli.js\nEditing cli.js', json, json, 'Writing'], 'the text of the model, not the laid out one');
  assert.equal(reasoning.querySelector('.copy-btn').dataset.state, 'copied');
  for (const b of h.blocks('dwight-m1')) assert.ok(b.className.split(' ').includes('copy-host'), 'the button shows on hover and focus of its block');

  const all = h.column('dwight-m1').querySelector('.think-col-tools').querySelector('.copy-btn');
  assert.deepEqual([all.querySelector('.copy-btn-label').textContent, all.getAttribute('aria-label')], ['Copy all', 'Copy all of dwight-m1']);
  await all.click();
  assert.equal(h.copied.at(-1), columnText(column));
  // the column moved on: the button copies what is there now
  const next = col({ items: [...items, item('t3', 'answer', 'Done.', at(9))] });
  h.draw([next]);
  await all.click();
  assert.equal(h.copied.at(-1), columnText(next));
  assert.ok(h.copied.at(-1).endsWith(`Answer · ${at(9)}\nDone.`));
});

test('the agent strip: a chip per agent with its status, live ones marked, and a press brings the column into view', async () => {
  const h = harness();
  const three = [
    col({ id: 'michael', name: 'michael', role: 'Planner', status: 'done', live: false }),
    col(),
    col({ id: 'angela-m1', name: 'angela-m1', role: 'QA · m1', status: 'failed', live: false }),
  ];
  h.draw(three);
  assert.deepEqual([h.strip().hidden, h.strip().getAttribute('role'), h.strip().getAttribute('aria-label')], [false, 'group', 'Agents of this run']);
  assert.deepEqual(h.$('think-view').children, [h.strip(), h.$('think-note'), h.$('think-cols')], 'built into the view, above the note and the columns');
  assert.deepEqual(h.chips().map((b) => [b.type, b.querySelector('.think-chip-name').textContent, b.dataset.status, b.dataset.live, b.getAttribute('aria-label'), b.getAttribute('aria-current')]), [
    ['button', 'michael', 'done', 'false', 'michael, Planner, done', null],
    ['button', 'dwight-m1', 'working', 'true', 'dwight-m1, Developer · m1, working', null],
    ['button', 'angela-m1', 'failed', 'false', 'angela-m1, QA · m1, failed', null],
  ]);
  for (const b of h.chips()) assert.equal(b.querySelector('.think-chip-glyph').getAttribute('aria-hidden'), 'true');
  const seen = [];
  for (const c of h.cols()) c.scrollIntoView = (o) => seen.push([c.querySelector('.think-name').textContent, o]);
  await h.chip('angela-m1').click();
  assert.deepEqual(seen, [['angela-m1', { inline: 'start', block: 'nearest' }]]);
  assert.equal(h.$('think-cols').dataset.mode, 'all', 'side by side: nobody is hidden by it');

  // the same chips for the same agents on the next tick; one that left the run loses its chip
  const chip = h.chip('michael');
  h.draw([three[0], { ...three[1], status: 'done', live: false }]);
  assert.equal(h.chip('michael'), chip);
  assert.deepEqual(h.chips().map((b) => [b.querySelector('.think-chip-name').textContent, b.dataset.status, b.dataset.live]), [['michael', 'done', 'false'], ['dwight-m1', 'done', 'false']]);
  // one agent needs no strip
  h.draw([three[0]]);
  assert.equal(h.strip().hidden, true);
});

test('one agent over the whole width: the column button picks it, the strip switches and leads back, and a redraw keeps it', async () => {
  const h = harness();
  const three = [col({ id: 'michael', name: 'michael', role: 'Planner', status: 'done', live: false }), col(), col({ id: 'angela-m1', name: 'angela-m1', role: 'QA · m1', status: 'waiting', live: false })];
  h.draw(three);
  const shown = () => h.cols().filter((c) => !c.hidden).map((c) => c.querySelector('.think-name').textContent);
  const only = h.column('dwight-m1').querySelector('.think-only');
  assert.deepEqual([only.type, only.getAttribute('aria-label'), only.getAttribute('aria-pressed'), only.title, only.hidden], ['button', 'Show only dwight-m1', 'false', 'Show only dwight-m1', false]);
  assert.deepEqual([h.$('think-cols').dataset.mode, shown().length], ['all', 3]);

  await only.click();
  assert.deepEqual([h.$('think-cols').dataset.mode, shown()], ['one', ['dwight-m1']]);
  assert.deepEqual([only.getAttribute('aria-pressed'), only.title, document.activeElement], ['true', 'Show all agents side by side', only]);
  assert.deepEqual(h.chips().map((b) => [b.textContent.replace(/^\W+/, ''), b.getAttribute('aria-current')]), [['All agents', null], ['michael', null], ['dwight-m1', 'true'], ['angela-m1', null]]);
  // remembered while the view is drawn again and again
  h.draw(three);
  h.draw(three);
  assert.deepEqual([h.$('think-cols').dataset.mode, shown()], ['one', ['dwight-m1']]);
  // a chip is now the agent that is read
  const asked = [];
  for (const c of h.cols()) c.scrollIntoView = () => asked.push(c);
  await h.chip('michael').click();
  assert.deepEqual([shown(), h.chip('michael').getAttribute('aria-current'), h.chip('dwight-m1').getAttribute('aria-current'), asked.length], [['michael'], 'true', null, 0]);
  // and back
  await h.chips()[0].click();
  assert.deepEqual([h.$('think-cols').dataset.mode, shown().length, h.chips().length, document.activeElement], ['all', 3, 3, h.chip('michael')]);
  assert.equal(h.column('michael').querySelector('.think-only').getAttribute('aria-pressed'), 'false');
  // the same button leaves the mode it entered
  await only.click();
  await only.click();
  assert.deepEqual([h.$('think-cols').dataset.mode, shown().length], ['all', 3]);

  // the agent that had the width left the run: side by side again
  await only.click();
  h.draw([three[0], three[2]]);
  assert.deepEqual([h.$('think-cols').dataset.mode, shown()], ['all', ['michael', 'angela-m1']]);
  // a run of one agent is a reading column without anyone choosing it, and offers no button for it
  h.draw([three[0]]);
  assert.deepEqual([h.$('think-cols').dataset.mode, h.column('michael').querySelector('.think-only').hidden], ['one', true]);
  // another chat: nobody has the width
  h.draw(three);
  await h.column('angela-m1').querySelector('.think-only').click();
  h.view.reset();
  h.draw(three);
  assert.deepEqual([h.$('think-cols').dataset.mode, shown().length], ['all', 3]);
  const css = read('styles.css');
  assert.match(css, /\.think-cols\[data-mode="one"\] \{ grid-auto-columns: minmax\(0, 44rem\); justify-content: center; \}/);
});

// a column whose scroll box has a size, as on screen
function sized(h, id, { view = 100, height = 500 } = {}) {
  const scroll = h.column(id).querySelector('.think-scroll');
  Object.assign(scroll, { clientHeight: view, scrollHeight: height });
  return scroll;
}

test('"Jump to latest": a reader who scrolled up in a working agent\'s column keeps the place and gets the way back', async () => {
  const h = harness();
  const items = [item('t1', 'reasoning', 'One'), item('t2', 'answer', 'Two', at(2))];
  h.draw([col({ items })]);
  const scroll = sized(h, 'dwight-m1');
  const jump = h.column('dwight-m1').querySelector('.jump');
  assert.deepEqual([jump.tagName, jump.type, jump.textContent, jump.hidden], ['BUTTON', 'button', 'Jump to latest', true]);
  // a follower is taken to the newest block on every tick
  h.draw([col({ items })]);
  assert.equal(scroll.scrollTop, 500);
  // the reader scrolls up
  scroll.scrollTop = 120;
  await scroll.fire('scroll');
  assert.equal(jump.hidden, false);
  scroll.scrollHeight = 900;
  h.draw([col({ items: [...items, item('t3', 'reasoning', 'Three', at(3))], open: { kind: 'answer', label: 'Answer', body: 'Writing', cut: false } })]);
  assert.equal(scroll.scrollTop, 120, 'new blocks do not move the reader');
  assert.equal(jump.hidden, false);

  jump.focus();
  await jump.click();
  assert.deepEqual([scroll.scrollTop, jump.hidden, document.activeElement], [900, true, scroll], 'at the newest block; the focus goes to the column, not to the page');
  scroll.scrollHeight = 1200;
  h.draw([col({ items })]);
  assert.equal(scroll.scrollTop, 1200, 'following again');

  // back up, and the agent finishes: nothing more will come, so there is nothing to jump to
  scroll.scrollTop = 0;
  await scroll.fire('scroll');
  assert.equal(jump.hidden, false);
  h.draw([col({ items, live: false, status: 'done' })], false);
  assert.deepEqual([jump.hidden, scroll.scrollTop], [true, 0]);
  assert.match(read('styles.css'), /\.think-col > \.jump \{ right: var\(--s4\); bottom: var\(--s4\); \}/, 'the look of the chat\'s and the log\'s button, in the column');
});

test('following is a choice, not a measurement: a column without a box keeps it, and opening a block is reading it', async () => {
  const h = harness();
  const items = [item('t1', 'reasoning', LINES(30)), item('t2', 'answer', 'Two', at(2)), item('t3', 'answer', 'Three', at(3))];
  h.draw([col({ items })]);
  const scroll = sized(h, 'dwight-m1');
  scroll.scrollTop = 40;
  await scroll.fire('scroll');
  // the view is closed (or another agent has the width): no box, every measurement is 0
  Object.assign(scroll, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
  await scroll.fire('scroll');
  h.draw([col({ items })]);
  // on screen again: the reader is where they were, not at the end
  Object.assign(scroll, { clientHeight: 100, scrollHeight: 500 });
  h.draw([col({ items })]);
  assert.equal(scroll.scrollTop, 40);
  assert.equal(h.column('dwight-m1').querySelector('.jump').hidden, false);

  // a follower opens a long block: the end is now far away, and the next tick must not scroll the block away
  await h.column('dwight-m1').querySelector('.jump').click();
  assert.equal(scroll.scrollTop, 500);
  scroll.scrollHeight = 1400;
  await h.blocks('dwight-m1')[0].querySelector('.clamp-more').click();
  h.draw([col({ items })]);
  assert.equal(scroll.scrollTop, 500, 'still reading the block that was opened');
});

test('the strip of columns says which side has more: the edge fades there', async () => {
  const h = harness();
  const cols = h.$('think-cols');
  h.draw([col(), col({ id: 'a', name: 'a' }), col({ id: 'b', name: 'b' })]);
  assert.equal(cols.dataset.more, 'none', 'everything fits (or nothing is measured)');
  Object.assign(cols, { clientWidth: 1000, scrollWidth: 1600, scrollLeft: 0 });
  h.draw([col(), col({ id: 'a', name: 'a' }), col({ id: 'b', name: 'b' })]);
  assert.equal(cols.dataset.more, 'end');
  cols.scrollLeft = 300;
  await cols.fire('scroll');
  assert.equal(cols.dataset.more, 'both');
  cols.scrollLeft = 600;
  await cols.fire('scroll');
  assert.equal(cols.dataset.more, 'start');
  const css = read('styles.css');
  for (const side of ['end', 'start', 'both']) assert.match(css, new RegExp(`\\.think-cols\\[data-more="${side}"\\] \\{ -webkit-mask-image: linear-gradient\\(`), side);
  assert.match(css, /\.think-col \{[^}]*scroll-snap-align: start; \}/);
});

test('the header of a column: name, role and status on one line, what it does on up to two, each said whole in its title', () => {
  const h = harness();
  h.draw([col({ line: 'Finished: REPORT_READY' })]);
  const c = h.column('dwight-m1');
  assert.deepEqual([c.querySelector('.think-line').textContent, c.querySelector('.think-line').title, c.querySelector('.think-name').title, c.querySelector('.act-role').title],
    ['Finished: REPORT_READY', 'Finished: REPORT_READY', 'dwight-m1', 'Developer · m1']);
  assert.deepEqual(c.querySelector('.think-col-tools').children.map((n) => n.className), ['msg-more think-expand', 'copy-btn', 'icon-btn think-only']);
  const css = read('styles.css');
  const line = css.match(/\.think-line \{([^}]+)\}/)[1];
  assert.match(line, /overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 2;/);
  assert.doesNotMatch(line, /nowrap/, 'the line wraps instead of being cut after a few words');
  assert.match(css, /\.think-body \{ max-width: 72ch; line-height: 1\.6;/);
  assert.match(css, /\.think-scroll \{[^}]*overscroll-behavior: contain;[^}]*padding: var\(--s4\); \}/);
});
// A scroll box with browser-like clamping and block heights derived from the fold state, not fixed test values.
function readingBox(h, id, view = 600) {
  const column = h.column(id);
  const scroll = column.querySelector('.think-scroll');
  let top = 0;
  const blocks = () => h.blocks(id);
  const height = (b) => {
    const body = b.querySelector('.think-body') ?? b.querySelector('.think-tools');
    return 40 + (body.dataset.clamp === 'closed' ? 252 : 756) + 32;
  };
  const content = () => 32 + blocks().reduce((n, b) => n + height(b) + 16, 0);
  const max = () => Math.max(0, content() - view);
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, get: () => view },
    scrollHeight: { configurable: true, get: content },
    scrollTop: { configurable: true, get: () => Math.min(top, max()), set: (n) => { top = Math.max(0, Math.min(n, max())); } },
  });
  scroll.getBoundingClientRect = () => ({ top: 100, bottom: 100 + view, height: view });
  for (const b of blocks()) {
    const body = b.querySelector('.think-body') ?? b.querySelector('.think-tools');
    let clamp = body.dataset.clamp;
    Object.defineProperty(body.dataset, 'clamp', {
      configurable: true, get: () => clamp,
      set: (next) => {
        const before = content();
        const anchored = scroll.scrollTop === max();
        clamp = next;
        // A browser can anchor to the focused fold button below the growing body.
        if (anchored && content() > before) scroll.scrollTop += content() - before;
      },
    });
    b.getBoundingClientRect = () => {
      const offset = 16 + blocks().slice(0, blocks().indexOf(b)).reduce((n, x) => n + height(x) + 16, 0);
      return { top: 100 + offset - scroll.scrollTop, bottom: 100 + offset + height(b) - scroll.scrollTop, height: height(b) };
    };
  }
  return { scroll, max, blocks, column };
}

test('manual planner JSON folding keeps its header visible instead of following the newly revealed end', async () => {
  const h = harness();
  const plan = JSON.stringify({ milestones: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, title: 'Read the existing code', dependsOn: [] })) });
  const planner = col({ id: 'michael', name: 'michael', status: 'done', live: false, items: [item('plan', 'answer', plan)] });
  h.draw([planner], false);
  const box = readingBox(h, 'michael');
  h.draw([planner], false);
  const block = box.blocks()[0];
  const fold = block.querySelector('.clamp-more');
  assert.equal(box.max(), 0, 'the folded planner answer fits in the column');
  await fold.click();
  assert.equal(box.scroll.scrollTop, 0, 'expansion leaves the start of the planner answer in view');
  h.draw([planner], false);
  assert.equal(box.scroll.scrollTop, 0, 'a redraw cannot revive tail-follow after a manual expansion');
  assert.ok(block.getBoundingClientRect().top >= box.scroll.getBoundingClientRect().top, 'the header is still visible');
});

test('manual collapse of a tall block reveals its header, holds reading across scroll events, and Jump explicitly resumes', async () => {
  const h = harness();
  const items = [item('t1', 'answer', LINES(42)), item('t2', 'answer', LINES(42)), item('t3', 'answer', 'Newest')];
  h.draw([col({ items })]);
  const box = readingBox(h, 'dwight-m1');
  const block = box.blocks()[0];
  const fold = block.querySelector('.clamp-more');
  box.scroll.scrollTop = 0;
  await box.scroll.fire('scroll');
  await fold.click();
  box.scroll.scrollTop = 500;
  await box.scroll.fire('scroll');
  await fold.click();
  assert.equal(box.scroll.scrollTop, 16, 'when collapsing from below the header, return to that header');
  // Browser scroll anchoring/clamping can emit a scroll event after folding, even without user scrolling.
  box.scroll.scrollTop = box.max();
  await box.scroll.fire('scroll');
  const held = box.scroll.scrollTop;
  h.draw([col({ items, open: { kind: 'answer', label: 'Answer', body: 'More live output', cut: false } })]);
  assert.equal(box.scroll.scrollTop, held, 'a geometry-only scroll event does not resume following');
  const jump = box.column.querySelector('.jump');
  assert.equal(jump.hidden, false);
  await jump.click();
  assert.equal(box.scroll.scrollTop, box.max());
  assert.equal(jump.hidden, true);
});

test('per-column Expand all and Collapse all preserve a reader at the start while live redraws keep the fold choice', async () => {
  const h = harness();
  const items = [item('t1', 'reasoning', LINES(42)), item('t2', 'answer', LINES(42))];
  const current = col({ live: false, status: 'done', items });
  h.draw([current], false);
  const box = readingBox(h, 'dwight-m1', 900);
  const expand = box.column.querySelector('.think-expand');
  assert.equal(box.max(), 0, 'the two folded blocks fit; the column is still following');
  for (const state of ['open', 'closed']) {
    await expand.click();
    assert.equal(box.scroll.scrollTop, 0, `${state}: no jump to newest during the action`);
    await box.scroll.fire('scroll');
    h.draw([current]);
    assert.equal(box.scroll.scrollTop, 0, `${state}: no jump on the next live redraw`);
    assert.deepEqual(box.blocks().slice(0, 2).map((b) => b.querySelector('.think-body').dataset.clamp), [state, state]);
    assert.equal(box.column.querySelector('.jump').hidden, true, 'a finished agent has no jump action');
  }
  h.draw([col({ items, open: { kind: 'reasoning', label: 'Reasoning', body: 'Still working', cut: false } })]);
  assert.equal(box.scroll.scrollTop, 0, 'live output does not resume following after the manual action');
  assert.equal(box.blocks().at(-1).querySelector('.clamp-more'), null, 'the active block stays pinned');
});
