// The event log by keyboard: one tab stop for the whole grid, the APG data-grid keys between the cells of the
// rows the filter shows, Enter and Space to open a row, and an open row that shows its full timestamp as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLog } from '../../visualizer/public/js/log.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { FakeEl, installDom } from './fixtures/fake-dom.js';

const ROW_PX = 20;
const VIEW_PX = 100;

// an element in a tree: parents, removal and focus events bubble the way the log relies on
class Node extends FakeEl {
  constructor(tag = '') {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.classList = new Set();
    this.parentNode = null;
    this.tabIndex = tag === 'td' ? -1 : 0;
  }
  get children() { return this.childNodes; }
  get firstElementChild() { return this.childNodes[0]; }
  hasAttribute(k) { return this.attrs.has(k); }
  append(...nodes) {
    for (const n of nodes) {
      for (const c of n.fragment ? n.childNodes.splice(0) : [n]) {
        c.parentNode = this;
        this.childNodes.push(c);
      }
    }
  }
  replaceChildren(...c) {
    // like remove(): a browser moves the focus of a removed element to the page
    for (const n of this.childNodes) {
      if (n.contains(document.activeElement)) document.activeElement = document.body;
      n.parentNode = null;
    }
    this.childNodes = [];
    this.append(...c);
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    // a browser moves the focus of a removed element to the page
    if (this.contains(document.activeElement)) document.activeElement = document.body;
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  closest(sel) {
    for (let x = this; x; x = x.parentNode) if (x.tagName === sel.toUpperCase()) return x;
    return null;
  }
  focus(opts) {
    const before = document.activeElement;
    document.activeElement = this;
    this.focusOptions = opts;
    for (let x = before; x; x = x.parentNode) x.listeners?.get('focusout')?.forEach((fn) => fn({ target: before, relatedTarget: this }));
    for (let x = this; x; x = x.parentNode) x.listeners?.get('focusin')?.forEach((fn) => fn({ target: this }));
  }
  scrollIntoView() { Node.scrolled?.(this); }
  // what is on screen as text
  get text() { return [this.textContent, ...this.childNodes.map((c) => c.text)].join(' '); }
}

const ENTRY_TS = (seq) => new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString();

// frames: rAF callbacks wait for frame(), the way a browser sends scroll events before them
function harness({ frames = false } = {}) {
  installDom();
  globalThis.ResizeObserver = undefined;
  const queued = [];
  globalThis.requestAnimationFrame = (fn) => { if (frames) queued.push(fn); else fn(); return 0; };
  let selection = '';
  globalThis.getSelection = () => selection;
  document.createElement = (tag) => new Node(tag);
  document.createDocumentFragment = () => Object.assign(new Node(), { fragment: true });

  const table = new Node('table');
  table.dataset.filter = 'all';
  const body = new Node('tbody');
  table.append(body);
  const shown = () => body.children.filter((tr) => table.dataset.filter === 'all' || tr.dataset.cat === table.dataset.filter);
  // a scroll box with a browser's clamping; the rows the filter hides take no space
  const scroller = new (class extends Node {
    get clientHeight() { return VIEW_PX; }
    set clientHeight(v) {}
    get scrollHeight() { return shown().length * ROW_PX; }
    set scrollHeight(v) {}
    get scrollTop() { return this.top ?? 0; }
    set scrollTop(v) { this.top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); }
  })('div');
  scroller.append(table);
  Node.scrolled = (tr) => {
    const top = shown().indexOf(tr) * ROW_PX;
    const before = scroller.scrollTop;
    if (top < before) scroller.scrollTop = top;
    else if (top + ROW_PX > before + VIEW_PX) scroller.scrollTop = top + ROW_PX - VIEW_PX;
    if (scroller.scrollTop !== before) scroller.fire('scroll');
  };
  const jump = new Node('button');
  jump.hidden = true;
  const filters = new Node('div');
  const log = createLog({ table, body, scroller, empty: new Node('p'), jump, filters });

  let entries = [];
  let keep = Infinity;
  let runId = 'r1';
  const render = () => log.render({ runId, log: entries.slice(-keep) });
  const add = (n, category) => {
    for (let i = 0; i < n; i++) {
      const seq = entries.length + 1;
      entries.push({ seq, ts: ENTRY_TS(seq), source: 'dwight', type: seq % 2 ? 'tool_call' : 'handoff', category: category ?? (seq % 2 ? 'tools' : 'handoffs'), tone: '', text: `row ${seq}` });
    }
    render();
  };
  const row = (seq) => body.children.find((tr) => tr.dataset.seq === String(seq));
  const cell = (seq) => row(seq).childNodes.find((td) => td.className === 't-detail');
  const cellAt = (seq, col) => row(seq).childNodes[col];
  const stopCells = () => body.children.flatMap((tr) => tr.childNodes).filter((td) => td.tabIndex === 0);
  const stops = () => stopCells().map((td) => Number(td.parentNode.dataset.seq));
  const focused = () => Number(document.activeElement?.parentNode?.dataset?.seq);
  // column of the focused cell, -1 when the focus is not on a cell
  const col = () => document.activeElement?.parentNode?.childNodes?.indexOf(document.activeElement) ?? -1;
  const key = (k, mods = {}) => {
    const out = { prevented: false };
    body.fire('keydown', { key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods, target: document.activeElement, preventDefault() { out.prevented = true; } });
    return out;
  };
  const filter = (name) => filters.fire('click', { target: { closest: () => ({ dataset: { filter: name } }) } });
  const click = (target) => body.fire('click', { target });
  return {
    log, table, body, scroller, jump, add, row, cell, cellAt, stopCells, stops, focused, col, key, filter, click,
    frame: () => { for (const fn of queued.splice(0)) fn(); },
    expanded: (seq) => row(seq).childNodes.map((td) => td.getAttribute('aria-expanded')),
    // the rows of the scroll box on screen
    inView: (seq) => {
      const top = (Number(seq) - 1) * ROW_PX;
      return top >= scroller.scrollTop && top + ROW_PX <= scroller.scrollTop + VIEW_PX;
    },
    select: (text) => { selection = text; },
    // the reducer keeps the newest n rows: the next row pushes the oldest out
    trimTo: (n) => { keep = n; add(1); },
    newRun: (id, n) => { runId = id; entries = []; keep = Infinity; add(n); },
  };
}

test('the event log is one tab stop: a grid whose newest row holds the roving tabindex', () => {
  const h = harness();
  h.add(6);
  assert.deepEqual(h.stops(), [6], 'only the newest row is in the tab order');
  for (const tr of h.body.children) assert.equal(h.cell(tr.dataset.seq).getAttribute('aria-expanded'), 'false');
  for (const tr of h.body.children) assert.deepEqual(h.expanded(tr.dataset.seq), ['false', 'false', 'false', 'false'], 'on every cell');
  h.add(2);
  assert.deepEqual(h.stops(), [8], 'the stop goes on to the newest row while nobody is in the log');

  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="log-scroll" id="log-scroll">/, 'the scroll box is no tab stop of its own');
  assert.match(html, /<table class="log" id="log" data-filter="main" role="grid" aria-readonly="true" aria-label="[^"]+">/);
});

test('Up, Down, Ctrl+Home and Ctrl+End move between the rows the filter shows', () => {
  const h = harness();
  h.add(8);
  h.cell(8).focus();
  h.key('ArrowUp');
  assert.equal(h.focused(), 7);
  assert.deepEqual(h.stops(), [7], 'the tab stop moves with the focus');
  h.key('Home', { ctrlKey: true });
  assert.equal(h.focused(), 1);
  h.key('ArrowUp');
  assert.equal(h.focused(), 1, 'the first row stays put');
  h.key('ArrowDown');
  assert.equal(h.focused(), 2);
  h.key('End', { ctrlKey: true });
  assert.equal(h.focused(), 8);
  h.key('ArrowDown');
  assert.equal(h.focused(), 8, 'the last row stays put');
  assert.deepEqual(h.stops(), [8]);
  assert.deepEqual(h.cell(8).focusOptions, { preventScroll: true }, 'the log scrolls the row into view itself');

  h.filter('tools');
  assert.deepEqual(h.stops(), [7], 'a row the filter hides gives the stop to a shown one');
  h.cell(7).focus();
  h.key('ArrowUp');
  assert.equal(h.focused(), 5, 'the hidden row 6 is skipped');
  h.key('End', { ctrlKey: true });
  assert.equal(h.focused(), 7);
  h.key('Home', { ctrlKey: true });
  assert.equal(h.focused(), 1);
});

test('Left and Right move between the cells of a row, and Up and Down keep the column', () => {
  const h = harness();
  h.add(8);
  h.cell(5).focus();
  assert.equal(h.col(), 3, 'the detail cell is the last of four');
  assert.equal(h.key('ArrowLeft').prevented, true);
  assert.equal(document.activeElement, h.cellAt(5, 2), 'the type cell');
  h.key('ArrowLeft');
  h.key('ArrowLeft');
  assert.equal(document.activeElement, h.cellAt(5, 0), 'the time cell');
  h.key('ArrowLeft');
  assert.equal(document.activeElement, h.cellAt(5, 0), 'the first cell stays put');
  h.key('ArrowRight');
  assert.equal(document.activeElement, h.cellAt(5, 1), 'the source cell');
  assert.deepEqual(h.stopCells(), [h.cellAt(5, 1)], 'the tab stop is that one cell');

  h.key('ArrowUp');
  assert.equal(document.activeElement, h.cellAt(4, 1), 'the same column one row up');
  h.add(3);
  assert.deepEqual(h.stopCells(), [h.cellAt(4, 1)], 'the stop keeps its row and column through new rows');
  h.filter('tools');
  assert.deepEqual(h.stopCells(), [h.cellAt(5, 1)], 'a hidden row gives the stop to the next shown row, same column');
  h.filter('all');
  assert.deepEqual(h.stopCells(), [h.cellAt(4, 1)]);

  h.cellAt(4, 3).focus();
  h.key('ArrowRight');
  assert.equal(document.activeElement, h.cellAt(4, 3), 'the last cell stays put');
});

test('Home and End go to the first and last cell of the row; Ctrl+Home and Ctrl+End keep the column', () => {
  const h = harness();
  h.add(8);
  h.cellAt(4, 1).focus();
  assert.equal(h.key('Home').prevented, true);
  assert.equal(document.activeElement, h.cellAt(4, 0), 'Home: first cell, same row');
  assert.equal(h.key('End').prevented, true);
  assert.equal(document.activeElement, h.cellAt(4, 3), 'End: last cell, same row');
  h.key('ArrowLeft');
  assert.equal(h.key('Home', { ctrlKey: true }).prevented, true);
  assert.equal(document.activeElement, h.cellAt(1, 2), 'Ctrl+Home: first row, same column');
  assert.equal(h.key('End', { ctrlKey: true }).prevented, true);
  assert.equal(document.activeElement, h.cellAt(8, 2), 'Ctrl+End: last row, same column');
  h.filter('handoffs');
  h.cellAt(8, 0).focus();
  h.key('Home', { ctrlKey: true });
  assert.equal(document.activeElement, h.cellAt(2, 0), 'Ctrl+Home: first row the filter shows');
});

test('Shift, Alt, Meta and other Ctrl combinations are left to the browser', () => {
  const h = harness();
  h.add(8);
  const combos = [
    ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].flatMap((k) => [
      [k, { shiftKey: true }], [k, { altKey: true }], [k, { metaKey: true }],
    ]),
    ['Home', { ctrlKey: true, shiftKey: true }], ['End', { ctrlKey: true, shiftKey: true }],
    ['ArrowUp', { ctrlKey: true }], ['ArrowLeft', { ctrlKey: true }], ['Enter', { ctrlKey: true }], [' ', { ctrlKey: true }],
  ];
  for (const start of [h.cell(5), h.cellAt(5, 1)]) {
    start.focus();
    for (const [k, mods] of combos) {
      const label = `${Object.keys(mods).join('+')}+${k === ' ' ? 'Space' : k}`;
      assert.equal(h.key(k, mods).prevented, false, `${label} is not taken`);
      assert.equal(document.activeElement, start, `${label} does not move the focus`);
      assert.equal(h.cell(5).getAttribute('aria-expanded'), 'false', `${label} does not open the row`);
      assert.deepEqual(h.expanded(5), ['false', 'false', 'false', 'false'], `${label} does not open the row`);
    }
  }
});

test('Enter and Space open the row from any of its cells, and the focus stays on that cell', () => {
  const h = harness();
  h.add(4);
  h.cellAt(2, 0).focus();
  assert.equal(h.key('Enter').prevented, true);
  assert.equal(h.cell(2).getAttribute('aria-expanded'), 'true');
  assert.equal(h.row(2).hasAttribute('data-expanded'), true);
  assert.equal(document.activeElement, h.cellAt(2, 0));
  assert.equal(document.activeElement.getAttribute('aria-expanded'), 'true', 'the focused time cell announces it');
  assert.deepEqual(h.expanded(2), ['true', 'true', 'true', 'true']);
  h.key('ArrowRight');
  h.key(' ');
  assert.equal(h.cell(2).getAttribute('aria-expanded'), 'false', 'Space on the source cell closes it');
  assert.equal(document.activeElement.getAttribute('aria-expanded'), 'false', 'the focused source cell announces it');
  assert.deepEqual(h.expanded(2), ['false', 'false', 'false', 'false']);
});

test('a new run keeps the focus in the log instead of dropping it to the page', () => {
  const h = harness();
  h.add(6);
  h.cellAt(3, 1).focus();
  h.newRun('r2', 4);
  assert.notEqual(document.activeElement, document.body, 'not on the page');
  assert.equal(h.focused(), 4, 'on the newest row of the new run');
  assert.deepEqual(h.stops(), [4]);

  h.newRun('r3', 0);
  assert.equal(document.activeElement, h.table, 'an empty new run: the grid itself holds the focus');
  assert.equal(h.table.tabIndex, -1, 'the grid can take the focus but is no tab stop of its own');
  h.add(2);
  assert.equal(h.focused(), 2, 'the first rows take the focus back into a cell');
  assert.deepEqual(h.stops(), [2]);
});

test('render(null) keeps the focus in the log', () => {
  const h = harness();
  h.add(5);
  h.cell(2).focus();
  h.log.render(null);
  assert.equal(h.body.children.length, 0);
  assert.equal(document.activeElement, h.table, 'the grid holds the focus, not the page');
  assert.deepEqual(h.stops(), []);
});

test('a trim that leaves no shown row keeps the focus in the log', () => {
  const h = harness();
  h.add(1, 'results');
  h.add(2, 'tools');
  h.filter('results');
  h.cell(1).focus();
  h.trimTo(2);
  assert.equal(h.row(1), undefined, 'row 1 is trimmed away');
  assert.notEqual(document.activeElement, document.body, 'not on the page');
  assert.equal(document.activeElement, h.table, 'the filter shows no row: the grid holds the focus');
  h.filter('all');
  assert.deepEqual(h.stops(), [3], 'the filter shows rows again: the oldest row left holds the stop');
});

test('Enter and Space open and close the focused row without the default action', () => {
  const h = harness();
  h.add(8);
  h.cell(5).focus();
  const top = h.scroller.scrollTop;
  const enter = h.key('Enter');
  assert.equal(enter.prevented, true);
  assert.equal(h.row(5).hasAttribute('data-expanded'), true);
  assert.equal(h.cell(5).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.expanded(5), ['true', 'true', 'true', 'true']);
  const space = h.key(' ');
  assert.equal(space.prevented, true, 'Space does not scroll the page');
  assert.equal(h.row(5).hasAttribute('data-expanded'), false);
  assert.equal(h.cell(5).getAttribute('aria-expanded'), 'false');
  h.key(' ');
  assert.equal(h.cell(5).getAttribute('aria-expanded'), 'true');
  assert.equal(h.scroller.scrollTop, top, 'opening a row does not move the log');
  assert.equal(h.key('a').prevented, false, 'other keys are left alone');
});

test('an open row shows the full timestamp, source and type as text; a closed row stays one line', () => {
  const h = harness();
  h.add(3);
  assert.match(h.row(2).text, /^ 2026-11-0[789] \d\d:\d\d dwight /, 'a closed row of another day has its date and time, nothing more');
  for (const td of h.row(2).childNodes) assert.equal(td.title, '', `${td.className} has no tooltip-only text`);
  h.cell(2).focus();
  h.key('Enter');
  assert.match(h.cell(2).text, new RegExp(`Time\\s+${ENTRY_TS(2).replace(/[.]/g, '\\.')}`), 'the full ts is in the focused cell');
  assert.match(h.cell(2).text, /Source\s+dwight/);
  assert.match(h.cell(2).text, /Type\s+handoff/);
  assert.match(h.cell(2).text, /row 2/);
  h.key('Enter');
  assert.doesNotMatch(h.row(2).text, /Time\s|Source\s|T\d\d:\d\d/, 'closing removes it again');
});

test('an open row shows a long failure in full, reachable by keyboard', () => {
  const h = harness();
  const long = `Build failed in C:\\work\\${'deep\\'.repeat(150)}index.js`;
  assert.equal(long.length > 700, true);
  const ev = (seq, fields) => ({ v: 1, seq, ts: ENTRY_TS(seq), runId: 'long', ...fields });
  const s = reduceAll([
    ev(1, { type: 'log', level: 'error', message: long }),
    ev(2, { type: 'agent_status', agent: 'dwight', instanceId: 'dwight-m1', status: 'error', activity: long }),
  ]);
  h.log.render(s);
  for (const seq of [1, 2]) {
    h.cell(seq).focus();
    h.key('Enter');
    assert.equal(h.row(seq).hasAttribute('data-expanded'), true);
    assert.equal(h.cell(seq).text.includes(long), true, `row ${seq} holds the whole text`);
  }
});

test('a click still opens a row and takes the focus, but not while text is selected', () => {
  const h = harness();
  h.add(4);
  h.click(h.row(2).childNodes[0]);
  assert.equal(h.cell(2).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.expanded(2), ['true', 'true', 'true', 'true'], 'the clicked time cell too');
  assert.equal(h.focused(), 2);
  assert.deepEqual(h.stops(), [2]);
  h.select('row');
  h.click(h.cell(2));
  assert.equal(h.cell(2).getAttribute('aria-expanded'), 'true', 'a selection does not collapse it');
});

test('focus and open rows survive new rows, filter changes and the trim', () => {
  const h = harness();
  h.add(8);
  h.cell(3).focus();
  h.key('Enter');
  h.add(4);
  assert.equal(h.focused(), 3, 'new rows leave the focus where it is');
  assert.deepEqual(h.stops(), [3]);
  assert.equal(h.cell(3).getAttribute('aria-expanded'), 'true');

  h.filter('handoffs');
  assert.deepEqual(h.stops(), [4], 'row 3 is hidden: the next shown row holds the stop');
  h.filter('all');
  assert.deepEqual(h.stops(), [3], 'and it comes back to row 3');
  assert.equal(h.row(3).hasAttribute('data-expanded'), true);

  h.cell(5).focus();
  h.key('Enter');
  h.cell(2).focus();
  h.trimTo(10);
  assert.equal(h.row(2), undefined, 'row 2 is trimmed away');
  assert.equal(h.focused(), 4, 'the focus goes to the oldest row left, not to the page');
  assert.deepEqual(h.stops(), [4]);
  assert.equal(h.cell(5).getAttribute('aria-expanded'), 'true', 'an open row that stays is still open');
});

test('keyboard focus keeps tail-follow: the newest row follows, an older row out of view reads back', () => {
  const h = harness();
  h.add(20);
  const bottom = () => h.scroller.scrollHeight - h.scroller.clientHeight;
  assert.equal(h.scroller.scrollTop, bottom());
  h.cell(20).focus();
  h.key('End', { ctrlKey: true });
  h.add(3);
  assert.equal(h.scroller.scrollTop, bottom(), 'a follower on the newest row still follows');
  assert.equal(h.jump.hidden, true);

  h.key('Home', { ctrlKey: true });
  assert.equal(h.scroller.scrollTop, 0, 'the first row is brought into view');
  h.add(2);
  assert.equal(h.scroller.scrollTop, 0, 'a reader on an older row keeps the place');
  assert.equal(h.jump.textContent, '2 new · Jump to latest');

  h.key('End', { ctrlKey: true });
  assert.equal(h.scroller.scrollTop, bottom(), 'Ctrl+End is back on the newest row');
  h.add(1);
  assert.equal(h.scroller.scrollTop, bottom(), 'and follows again');
  assert.equal(h.jump.hidden, true);
});

test('a key move to an older row already in view stops tail-follow, with no scroll to say so', () => {
  const h = harness();
  h.add(20);
  h.cell(20).focus();
  const top = h.scroller.scrollTop;
  h.key('ArrowUp');
  assert.equal(h.scroller.scrollTop, top, 'row 19 is in view: nothing scrolls');
  h.add(10);
  assert.equal(h.scroller.scrollTop, top, 'new rows do not scroll the reader away');
  assert.equal(h.inView(19), true, 'the focused row stays on screen');
  assert.equal(h.focused(), 19);
  assert.equal(h.jump.hidden, false);
  assert.equal(h.jump.textContent, '10 new · Jump to latest');
});

test('a key move stops tail-follow even while a render still holds its scroll as programmatic', () => {
  const h = harness({ frames: true });
  h.add(20);
  h.cell(20).focus();
  // the render's toBottom waits for the next frame to clear programmatic; the key lands before it
  h.key('Home', { ctrlKey: true });
  assert.equal(h.scroller.scrollTop, 0, 'the first row is brought into view');
  h.frame();
  h.add(2);
  h.frame();
  assert.equal(h.scroller.scrollTop, 0, 'a reader on the first row keeps the place');
  assert.equal(h.jump.textContent, '2 new · Jump to latest');
  assert.equal(h.inView(1), true);
});

test('a click that opens an older row stops tail-follow; one on the newest row follows', () => {
  const h = harness();
  h.add(20);
  const bottom = () => h.scroller.scrollHeight - h.scroller.clientHeight;
  h.click(h.cell(18));
  assert.equal(h.row(18).hasAttribute('data-expanded'), true);
  const top = h.scroller.scrollTop;
  h.add(5);
  assert.equal(h.scroller.scrollTop, top, 'the open row is not scrolled away');
  assert.equal(h.inView(18), true);
  assert.equal(h.jump.textContent, '5 new · Jump to latest');

  h.click(h.cell(25));
  assert.equal(h.scroller.scrollTop, bottom(), 'the newest row: back at the bottom');
  assert.equal(h.jump.hidden, true);
  h.add(1);
  assert.equal(h.scroller.scrollTop, bottom(), 'and following again');
});

test('moving back down to the newest row resumes tail-follow', () => {
  const h = harness();
  h.add(20);
  const bottom = () => h.scroller.scrollHeight - h.scroller.clientHeight;
  h.cell(20).focus();
  h.key('ArrowUp');
  h.add(1);
  assert.equal(h.jump.textContent, '1 new · Jump to latest', 'a reader on row 19');
  h.key('ArrowDown');
  h.add(1);
  assert.equal(h.jump.textContent, '2 new · Jump to latest', 'row 20 is no longer the newest: still reading');
  h.key('ArrowDown');
  h.key('ArrowDown');
  assert.equal(h.focused(), 22);
  assert.equal(h.scroller.scrollTop, bottom(), 'on the newest row');
  assert.equal(h.jump.hidden, true);
  h.add(3);
  assert.equal(h.scroller.scrollTop, bottom(), 'and follows again');
  assert.equal(h.jump.hidden, true);
  assert.equal(h.focused(), 22, 'the focus stays on its row');
});

// every node of a class under a row, in document order
const under = (node, cls) => node.childNodes.flatMap((c) => [...(c.className === cls ? [c] : []), ...(c.childNodes ? under(c, cls) : [])]);

test('the detail has a box of its own, which a closed row cuts after two lines and an open row shows whole', () => {
  const h = harness();
  h.add(2);
  const [text] = h.cell(2).childNodes;
  assert.deepEqual([h.cell(2).childNodes.length, text.className, text.textContent], [1, 't-text', 'row 2']);
  assert.equal(h.cell(2).textContent, '', 'the cell holds no text of its own beside it');
  h.cell(2).focus();
  h.key('Enter');
  assert.deepEqual(h.cell(2).childNodes.map((n) => n.className), ['t-text', 't-more'], 'opened: the same text, and what belongs to it under it');
  assert.equal(h.cell(2).childNodes[0], text);
});

test('an open row has a button that copies its whole detail; it is no cell of the grid', async () => {
  const h = harness();
  const long = `Build failed in C:\\work\\${'deep\\'.repeat(150)}index.js\nsecond line`;
  h.log.render({ runId: 'r1', log: [1, 2, 3].map((seq) => ({ seq, ts: ENTRY_TS(seq), source: 'dwight-m2', type: 'log', category: 'results', tone: 'bad', text: seq === 2 ? long : `row ${seq}` })) });
  assert.deepEqual(under(h.body, 'copy-btn'), [], 'a closed row has none');
  h.cell(2).focus();
  h.key('Enter');
  const [button, ...more] = under(h.row(2), 'copy-btn');
  assert.equal(more.length, 0);
  assert.equal(button.parentNode.className, 't-more', 'in the foot of the open row');
  assert.deepEqual([button.getAttribute('aria-label'), button.title, button.dataset.state], ['Copy event detail', 'Copy event detail', 'idle']);
  assert.deepEqual(h.stops(), [2], 'the grid keeps its one roving stop on a cell');

  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied.push(t); } } }, configurable: true });
  let bubbled = true;
  await button.fire('click', { stopPropagation() { bubbled = false; } });
  assert.deepEqual(copied, [long], 'the text of the event, line breaks and all, not what the row has room for');
  assert.equal(button.dataset.state, 'copied');
  assert.equal(bubbled, false, 'the click does not reach the row');
  assert.equal(h.row(2).hasAttribute('data-expanded'), true, 'so the row stays open');

  // the grid keys act on cells only: Enter and Space on the button are the button's
  for (const key of ['Enter', ' ', 'ArrowUp']) {
    const ev = { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, target: button, prevented: false, preventDefault() { ev.prevented = true; } };
    h.body.fire('keydown', ev);
    assert.equal(ev.prevented, false, `${key === ' ' ? 'Space' : key} on the button is left alone`);
  }
  assert.equal(h.row(2).hasAttribute('data-expanded'), true);
  h.cell(2).focus();
  h.key('Enter');
  assert.deepEqual(under(h.row(2), 'copy-btn'), [], 'closing takes the button with the foot');
});
