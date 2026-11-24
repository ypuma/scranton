// Copy to the clipboard (js/copy.js): the function never throws and falls back to a selected text area; the button
// names what it copies, says how it went for a moment, and keeps its click to itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyText, copyButton, COPIED_MS } from '../../visualizer/public/js/copy.js';
import { installTree, TreeEl } from './fixtures/tree-dom.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

// a document that copies what is selected, as execCommand('copy') does
function fallbackDoc({ works = true, throws = false } = {}) {
  installTree();
  const doc = globalThis.document;
  doc.copied = [];
  doc.execCommand = (what) => {
    if (throws) throw new Error('not allowed');
    const area = doc.body.querySelector('textarea');
    if (what === 'copy' && works && area?.selected) doc.copied.push(area.value);
    return works;
  };
  TreeEl.prototype.select = function select() { this.selected = true; };
  return doc;
}

test('copyText: the clipboard API when there is one; the text is what was handed over', async () => {
  const written = [];
  const clipboard = { writeText: async (t) => { written.push(t); } };
  assert.equal(await copyText('C:\\ws\\todo', { clipboard, doc: null }), true);
  assert.equal(await copyText(undefined, { clipboard, doc: null }), true, 'nothing is copied as an empty text');
  assert.equal(await copyText(42, { clipboard, doc: null }), true);
  assert.deepEqual(written, ['C:\\ws\\todo', '', '42']);
});

test('copyText: without the API, or when it refuses, a hidden text area is selected and copied, and removed again', async () => {
  const doc = fallbackDoc();
  const from = doc.createElement('button');
  doc.body.append(from);
  from.focus();
  assert.equal(await copyText('line 1\nline 2', { clipboard: undefined, doc }), true);
  assert.deepEqual(doc.copied, ['line 1\nline 2']);
  assert.equal(doc.body.querySelector('textarea'), null, 'the text area does not stay in the page');
  assert.equal(doc.activeElement, from, 'the focus is back where it was');

  const refusing = { writeText: async () => { throw new Error('NotAllowedError'); } };
  assert.equal(await copyText('again', { clipboard: refusing, doc }), true, 'a refusal of the API is not the end');
  assert.deepEqual(doc.copied, ['line 1\nline 2', 'again']);

  // the text area is how the fallback looks in the page: a class of the stylesheet, no inline style
  assert.match(read('styles.css'), /\.copy-sink \{[^}]*position: fixed;[^}]*opacity: 0;/);
  assert.doesNotMatch(read('js/copy.js'), /\.style\b|setAttribute\('style'/);
});

test('copyText never throws: every way that fails answers false', async () => {
  assert.equal(await copyText('x', { clipboard: null, doc: null }), false, 'no clipboard and no document');
  assert.equal(await copyText('x', { clipboard: null, doc: fallbackDoc({ works: false }) }), false, 'the document says it did not copy');
  const doc = fallbackDoc({ throws: true });
  assert.equal(await copyText('x', { clipboard: { writeText: async () => { throw new Error('no'); } }, doc }), false, 'both ways throw');
  assert.equal(doc.body.querySelector('textarea'), null, 'the text area is removed after a failure too');
  assert.equal(await copyText('x', { clipboard: { writeText: () => { throw new Error('sync'); } }, doc: { body: null } }), false);
});

// Selecting the sink replaces the document selection; focusing the trigger can replace it too.
function selectionDoc({ works = true, throws = false, selectThrows = false } = {}) {
  const doc = fallbackDoc({ works, throws });
  const from = doc.createElement('button');
  doc.body.append(from);
  from.focus();
  const clones = [];
  const originals = ['first prose range', 'second prose range'].map((text) => ({
    text,
    cloneRange() { const clone = { text: this.text }; clones.push(clone); return clone; },
  }));
  let ranges = [...originals];
  const selection = {
    get rangeCount() { return ranges.length; },
    getRangeAt: (i) => ranges[i],
    removeAllRanges() { ranges = []; },
    addRange(range) { ranges.push(range); },
  };
  doc.getSelection = () => selection;
  const focus = from.focus.bind(from);
  from.focus = () => { ranges = []; focus(); };
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'textarea') {
      node.select = () => {
        node.focus();
        node.selected = true;
        ranges = [{ text: node.value, temporary: true }];
        for (const range of originals) range.text = 'changed after select';
        if (selectThrows) throw new Error('selection refused');
      };
      const remove = node.remove.bind(node);
      node.remove = () => { ranges = ranges.filter((r) => !r.temporary); remove(); };
    }
    return node;
  };
  return { doc, from, clones, selection };
}

test('copyText fallback preserves cloned document ranges and focus on success, refusal and exceptions', async () => {
  for (const options of [{}, { works: false }, { throws: true }, { selectThrows: true }]) {
    const h = selectionDoc(options);
    const expected = !options.throws && !options.selectThrows && options.works !== false;
    const clipboard = { writeText: async () => { throw new Error('NotAllowedError'); } };
    assert.equal(await copyText('copied payload', { clipboard, doc: h.doc }), expected);
    assert.equal(h.doc.activeElement, h.from, 'focus is restored alongside selection');
    assert.equal(h.doc.body.querySelector('textarea'), null, 'sink removed even on failure');
    assert.equal(h.selection.rangeCount, 2, 'both original document ranges are restored');
    assert.equal(h.clones.length, 2, 'ranges are cloned before selecting the temporary textarea');
    assert.deepEqual(h.clones.map((r) => r.text), ['first prose range', 'second prose range']);
    for (let i = 0; i < 2; i += 1) assert.equal(h.selection.getRangeAt(i), h.clones[i], 'the saved clone is restored in order');
    assert.deepEqual(h.doc.copied, expected ? ['copied payload'] : []);
  }
});

test('copyText fallback tolerates unavailable or throwing Selection APIs without losing copy feedback', async () => {
  for (const getSelection of [undefined, () => null, () => { throw new Error('unsupported'); },
    () => ({ rangeCount: 1 }),
    () => ({ rangeCount: 1, getRangeAt() { return { cloneRange() { throw new Error('detached'); } }; } }),
    () => ({ rangeCount: 0, removeAllRanges() { throw new Error('unavailable'); }, addRange() {} }),
    () => ({ rangeCount: 1, getRangeAt: () => ({ cloneRange: () => ({}) }), removeAllRanges() {}, addRange() { throw new Error('detached'); } })]) {
    const doc = fallbackDoc();
    doc.getSelection = getSelection;
    const from = doc.createElement('button');
    doc.body.append(from);
    from.focus();
    assert.equal(await copyText('payload', { clipboard: null, doc }), true, 'selection support cannot turn a successful copy into failure');
    assert.equal(doc.activeElement, from);
    assert.equal(doc.body.querySelector('textarea'), null);
    assert.deepEqual(doc.copied, ['payload']);
  }
});

function buttonHarness(opts = {}) {
  installTree();
  const timers = { pending: [], delays: [], cleared: 0, setTimeout(fn, ms) { this.pending.push(fn); this.delays.push(ms); return this.pending.length; }, clearTimeout() { this.cleared += 1; } };
  const copied = [];
  let ok = true;
  const b = copyButton({ timers, copy: async (t) => { copied.push(t); return ok; }, ...opts });
  return { b, timers, copied, fail: () => { ok = false; } };
}

test('copyButton: a button with an icon and a name, and a visible word only when a label is given', () => {
  const { b } = buttonHarness({ text: 'x', what: 'the workspace path' });
  assert.deepEqual([b.tagName, b.type, b.className, b.dataset.state], ['BUTTON', 'button', 'copy-btn', 'idle']);
  assert.deepEqual([b.getAttribute('aria-label'), b.title], ['Copy the workspace path', 'Copy the workspace path']);
  assert.deepEqual(b.children.map((n) => n.tagName), ['SVG']);
  assert.equal(b.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(b.textContent, '', 'the icon alone: the name is the label');

  const labelled = buttonHarness({ text: 'x', label: 'Copy all' }).b;
  assert.deepEqual(labelled.children.map((n) => [n.tagName, n.className]), [['SVG', ''], ['SPAN', 'copy-btn-label']]);
  assert.equal(labelled.querySelector('.copy-btn-label').textContent, 'Copy all');
  assert.equal(labelled.getAttribute('aria-label'), 'Copy text', 'the default name');
});

test('copyButton: a click copies, says "Copied" for 1600 ms, and does not reach the row it sits in', async () => {
  const { b, timers, copied } = buttonHarness({ text: 'the text', what: 'block', label: 'Copy' });
  const row = document.createElement('div');
  let rowClicks = 0;
  row.addEventListener('click', () => { rowClicks += 1; });
  row.append(b);
  await b.click();
  assert.deepEqual(copied, ['the text']);
  assert.equal(rowClicks, 0, 'the click does not bubble');
  assert.deepEqual([b.dataset.state, b.getAttribute('aria-label'), b.title, b.querySelector('.copy-btn-label').textContent], ['copied', 'Copied', 'Copied', 'Copied']);
  assert.deepEqual(timers.delays, [COPIED_MS]);
  assert.equal(COPIED_MS, 1600);
  timers.pending.at(-1)();
  assert.deepEqual([b.dataset.state, b.getAttribute('aria-label'), b.title, b.querySelector('.copy-btn-label').textContent], ['idle', 'Copy block', 'Copy block', 'Copy']);
  // a second click while it still says "Copied" starts the time again
  await b.click();
  await b.click();
  assert.equal(timers.cleared, 3, 'one timer at a time');
});

test('copyButton: the text may be a function, asked at the click; a copy that fails or throws says "Copy failed"', async () => {
  let n = 0;
  const h = buttonHarness({ text: () => `value ${n += 1}` });
  await h.b.click();
  await h.b.click();
  assert.deepEqual(h.copied, ['value 1', 'value 2'], 'read when it is pressed, not when it was built');
  h.fail();
  await h.b.click();
  assert.deepEqual([h.b.dataset.state, h.b.getAttribute('aria-label'), h.b.title], ['failed', 'Copy failed', 'Copy failed']);

  installTree();
  const timers = { setTimeout: () => 1, clearTimeout() {} };
  const throwing = copyButton({ text: 'x', timers, copy: async () => { throw new Error('boom'); } });
  await throwing.click();
  assert.equal(throwing.dataset.state, 'failed');
  const noText = copyButton({ text: () => { throw new Error('gone'); }, timers, copy: async () => true });
  await noText.click();
  assert.equal(noText.dataset.state, 'failed', 'a text that cannot be read is not reported as copied');
  await tick();
});

test('stylesheet: the button, its three states, and a host that shows it on hover, on focus and always on touch', () => {
  const css = read('styles.css');
  assert.match(css, /\.copy-btn \{[^}]*cursor: pointer;/);
  assert.match(css, /\.copy-btn\[data-state="copied"\] \{ color: var\(--ok\); \}/);
  assert.match(css, /\.copy-btn\[data-state="failed"\] \{ color: var\(--bad\); \}/);
  assert.match(css, /\.copy-host \{ position: relative; \}/);
  assert.match(css, /@media \(hover: hover\) \{\s*\.copy-host:not\(:hover, :focus-within\) \.copy-btn\[data-state="idle"\] \{ opacity: 0; \}\s*\}/,
    'hidden only where there is a pointer to hover with, and never while it reports');
  const js = read('js/copy.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
});
