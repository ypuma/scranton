// Long text made readable (js/long-text.js): counting lines, what is a payload, the code block whose wrapped lines
// keep their indent, the path that wraps between its folders, and the control that folds a long text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  countLines, isFoldable, foldWord, jsonPayload, looksStructured, richBlocks, codeLines, pathParts, codeBlock, richText, pathNode, createFold,
  FOLD_LINES, FOLD_SLACK, WRAP_CHARS,
} from '../../visualizer/public/js/long-text.js';
import { installTree, all } from './fixtures/tree-dom.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');
const LINES = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n');

test('lines: the text\'s own, and the ones a long line wraps to in the reading column', () => {
  assert.deepEqual([FOLD_LINES, FOLD_SLACK, WRAP_CHARS], [12, 4, 68]);
  assert.deepEqual([countLines(''), countLines(null), countLines('one'), countLines('a\nb\n\nd')], [1, 1, 1, 4]);
  assert.equal(countLines('x'.repeat(WRAP_CHARS)), 1);
  assert.equal(countLines('x'.repeat(WRAP_CHARS + 1)), 2);
  assert.equal(countLines(`${'x'.repeat(WRAP_CHARS * 3)}\nshort`), 4, 'a paragraph on one line counts as the lines it takes');
  assert.equal(countLines('x'.repeat(250), 100), 3);
  // folding hides nothing worth a button until the text is clearly longer than the fold
  assert.deepEqual([isFoldable(12), isFoldable(16), isFoldable(17), isFoldable(28, 24), isFoldable(29, 24)], [false, false, true, false, true]);
  assert.deepEqual([foldWord(false, 30), foldWord(true, 30)], ['Show all (30 lines)', 'Show less']);
});

test('a payload: text that is one JSON object or array; anything else is prose', () => {
  const plan = { milestones: [{ id: 'm1', title: 'Storage' }] };
  assert.equal(jsonPayload(JSON.stringify(plan)), JSON.stringify(plan, null, 2), 'one line of JSON is laid out');
  assert.equal(jsonPayload(`  ${JSON.stringify(plan)}\n`), JSON.stringify(plan, null, 2));
  const pretty = JSON.stringify(plan, null, 4);
  assert.equal(jsonPayload(pretty), pretty, 'JSON that already has its lines is kept as it was written');
  // what would not come back the same is not laid out again: no digit of the model is touched
  const odd = '{"n":1.0,"big":12345678901234567890}';
  assert.equal(jsonPayload(odd), odd);
  assert.equal(jsonPayload('[1,2]'), '[\n  1,\n  2\n]');
  for (const text of ['', null, 'I planned three milestones.', '[PLAN_READY]', '{"milestones": oops}', '{ not json }', '"a string"', '42', 'Result: {"a":1}', '{"a":1} and more']) {
    assert.equal(jsonPayload(text), null, String(text));
  }
  // a text still being written cannot be parsed: how it starts decides
  for (const text of ['{', '{\n  "milestones": [', '[\n  {', '{"a', '[{"id":', '```json\n{', '  ```']) assert.equal(looksStructured(text), true, text);
  for (const text of ['', 'The plan', '[PLAN_READY]', '[three] steps', '{curly} prose', 'Use `code` here']) assert.equal(looksStructured(text), false, text);
  assert.deepEqual(richBlocks('{"a":1}'), [{ type: 'code', lang: 'json', text: '{\n  "a": 1\n}' }]);
  assert.deepEqual(richBlocks('Text\n```js\nx()\n```').map((b) => b.type), ['p', 'code'], 'anything else is the Markdown subset');
});

test('code lines: every line with the columns of its indent, a tab as two, a very deep one capped', () => {
  assert.deepEqual(codeLines('a\n  b\n\tc\n \t d\n'), [
    { indent: 0, text: 'a' }, { indent: 2, text: '  b' }, { indent: 2, text: '\tc' }, { indent: 4, text: ' \t d' }, { indent: 0, text: '' },
  ]);
  assert.equal(codeLines(`${' '.repeat(80)}deep`)[0].indent, 24, 'the text keeps most of the line');
  assert.deepEqual(codeLines(''), [{ indent: 0, text: '' }]);
});

test('codeBlock: a line per element, the text unchanged, the indent as a custom property, and a copy button', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installTree();
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (s) => { copied.push(s); } } } });
  const src = 'function a() {\n  return `<b>${x}</b>`;\n}\n';
  const pre = codeBlock(src, { lang: 'js' });
  assert.deepEqual([pre.tagName, pre.className, pre.dataset.lang], ['PRE', 'code-block copy-host', 'js']);
  assert.deepEqual(pre.children.map((n) => n.tagName), ['CODE', 'BUTTON']);
  const lines = pre.querySelector('code').children;
  assert.deepEqual(lines.map((l) => [l.tagName, l.className, l.textContent, l.style['--indent']]), [
    ['SPAN', 'code-line', 'function a() {\n', undefined], ['SPAN', 'code-line', '  return `<b>${x}</b>`;\n', '2'], ['SPAN', 'code-line', '}\n', undefined], ['SPAN', 'code-line', '', undefined],
  ]);
  assert.equal(pre.textContent, src, 'selecting the block gives the text as it was written');
  assert.ok(!all(pre).some((n) => n.tagName === 'B'), 'code is text');
  assert.equal(pre.querySelector('.copy-btn').getAttribute('aria-label'), 'Copy code');
  await pre.querySelector('.copy-btn').click();
  assert.deepEqual(copied, [src]);
  // what is copied may be the text before it was laid out; and a block may do without the button
  const laid = codeBlock('{\n  "a": 1\n}', { lang: 'json', copy: 'JSON', source: '{"a":1}' });
  await laid.querySelector('.copy-btn').click();
  assert.deepEqual([copied.at(-1), laid.querySelector('.copy-btn').getAttribute('aria-label')], ['{"a":1}', 'Copied']);
  const bare = codeBlock('x', { copy: '' });
  assert.deepEqual([bare.className, bare.children.map((n) => n.tagName)], ['code-block', ['CODE']]);
});

test('richText: the Markdown subset with its code blocks line by line; JSON as a whole is one code block', () => {
  installTree();
  const nodes = richText('# Title\n\nSome **bold** text.\n\n```sh\nnpm test\n```\n\n- a\n- b');
  assert.deepEqual(nodes.map((n) => [n.tagName, n.className]), [['H3', ''], ['P', ''], ['PRE', 'code-block copy-host'], ['UL', '']]);
  assert.equal(nodes[2].querySelector('code').textContent, 'npm test');
  const [json] = richText('{"a":[1,2]}');
  assert.deepEqual([json.tagName, json.dataset.lang, json.querySelector('code').textContent], ['PRE', 'json', '{\n  "a": [\n    1,\n    2\n  ]\n}']);
  const hostile = richText('<img src=x onerror=alert(1)>\n\n```\n<script>alert(2)</script>\n```');
  assert.deepEqual([...new Set(hostile.flatMap((n) => [n, ...all(n)]).map((n) => n.tagName))].sort(), ['BUTTON', 'CODE', 'P', 'PATH', 'PRE', 'SPAN', 'SVG']);
  assert.deepEqual(richText(''), []);
});

test('a path wraps after a separator, never in the middle of a name, and says itself whole in its title', () => {
  assert.deepEqual(pathParts('C:\\Users\\me\\Project_Scranton'), ['C:\\', 'Users\\', 'me\\', 'Project_Scranton']);
  assert.deepEqual(pathParts('/home/me/ws/'), ['/', 'home/', 'me/', 'ws/']);
  assert.deepEqual(pathParts('\\\\server\\share\\x'), ['\\\\', 'server\\', 'share\\', 'x']);
  assert.deepEqual([pathParts('todo.js'), pathParts(''), pathParts(null)], [['todo.js'], [''], ['']]);
  installTree();
  const node = pathNode('C:\\ws\\todo');
  assert.deepEqual([node.tagName, node.className, node.title, node.textContent], ['SPAN', 'path mono', 'C:\\ws\\todo', 'C:\\ws\\todo']);
  assert.deepEqual(node.childNodes.map((n) => (n.nodeType === 3 ? n.textContent : n.tagName)), ['C:\\', 'WBR', 'ws\\', 'WBR', 'todo']);
  assert.equal(pathNode('src/a.js', 'changes-path mono').className, 'changes-path mono');
});

test('createFold: short text has no control; a long one is closed until pressed, tells its owner, and can be pinned open', async () => {
  installTree();
  const box = document.createElement('div');
  const toggles = [];
  const fold = createFold(box, { onToggle: (open) => toggles.push(open) });
  assert.deepEqual([fold.more.tagName, fold.more.type, fold.more.className, fold.more.hidden, box.dataset.clamp, fold.long()], ['BUTTON', 'button', 'msg-more clamp-more', true, undefined, false]);
  fold.set({ lines: 16 });
  assert.deepEqual([fold.more.hidden, box.dataset.clamp], [true, undefined], 'four lines over the fold are shown');
  fold.set({ lines: 40 });
  assert.deepEqual([fold.more.hidden, fold.more.textContent, fold.more.getAttribute('aria-expanded'), box.dataset.clamp, fold.long(), fold.open()], [false, 'Show all (40 lines)', 'false', 'closed', true, false]);
  await fold.more.click();
  assert.deepEqual([fold.more.textContent, fold.more.getAttribute('aria-expanded'), box.dataset.clamp, fold.open(), toggles], ['Show less', 'true', 'open', true, [true]]);
  // the owner decides too: it knows what was open before the node was built again
  fold.set({ open: false });
  assert.deepEqual([box.dataset.clamp, toggles], ['closed', [true]], 'setting it is not a press');
  // a text that may not be folded now: no cut and no button, and the choice is kept for later
  fold.set({ open: true, pinned: true });
  assert.deepEqual([box.dataset.clamp, fold.more.hidden], [undefined, true]);
  fold.set({ pinned: false });
  assert.deepEqual([box.dataset.clamp, fold.more.hidden], ['open', false]);
  // a longer fold for output that is read in the page
  const out = createFold(document.createElement('pre'), { limit: 24 });
  out.set({ lines: 28 });
  assert.equal(out.long(), false);
  out.set({ lines: 29 });
  assert.equal(out.long(), true);
  assert.equal(LINES(3), 'Line 1\nLine 2\nLine 3');
});

test('stylesheet and module: the shared rules exist, and the builders never parse HTML', () => {
  const css = read('styles.css');
  assert.match(css, /\[data-clamp="closed"\] \{\s*max-height: var\(--clamp-h, 19\.2em\);\s*overflow: hidden;\s*-webkit-mask-image:/);
  assert.match(css, /\.code-block \{[^}]*padding: var\(--s3\) var\(--s4\);[^}]*font: var\(--fs-s\)\/1\.55 var\(--mono\);/);
  assert.match(css, /\.path \{ overflow-wrap: anywhere; \}/, 'a name longer than the line still breaks, as the last resort');
  const js = read('js/long-text.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|\.href\b|\.src\b/);
});

test('a manual fold captures the reading anchor before layout changes and restores it after the owner saves state', async () => {
  installTree();
  const box = document.createElement('div');
  const steps = [];
  const fold = createFold(box, {
    onBeforeToggle: () => {
      steps.push(['before', box.dataset.clamp]);
      return () => steps.push(['restore', box.dataset.clamp]);
    },
    onToggle: (on) => steps.push(['saved', on, box.dataset.clamp]),
  });
  fold.set({ lines: 42 });
  assert.deepEqual(steps, [], 'automatic updates do not hold the reader');
  await fold.more.click();
  assert.deepEqual(steps, [['before', 'closed'], ['saved', true, 'open'], ['restore', 'open']]);
  steps.length = 0;
  await fold.more.click();
  assert.deepEqual(steps, [['before', 'open'], ['saved', false, 'closed'], ['restore', 'closed']]);
});
