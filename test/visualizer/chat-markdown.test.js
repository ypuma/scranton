// The Markdown subset of the Chat view (.enma/chat-view-contract.md sections 7 and 13.9). Model text is untrusted:
// whatever is not in the subset stays the text it is, and nothing is ever parsed as HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInline, parseMarkdown, buildMarkdown, renderMarkdown } from '../../visualizer/public/js/chat-markdown.js';
import { installTree, all } from './fixtures/tree-dom.js';

const text = (t) => ({ type: 'text', text: t });
const p = (...spans) => ({ type: 'p', spans });
// the tree as [tag, text or children]
const shape = (node) => (node.nodeType === 3 ? node.textContent : [node.tagName.toLowerCase(), ...node.childNodes.map(shape)]);
const render = (src) => {
  installTree();
  return renderMarkdown(src);
};

test('paragraphs are split by blank lines and keep their own line breaks', () => {
  assert.deepEqual(parseMarkdown('One\ntwo\n\n\nThree'), [p(text('One\ntwo')), p(text('Three'))]);
  assert.deepEqual(parseMarkdown('\r\nOne\r\n\r\nTwo\r\n'), [p(text('One')), p(text('Two'))]);
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(undefined), []);
  assert.deepEqual(parseMarkdown('   \n\n  '), []);
});

test('headings: one to three hashes are h3 to h5; four or more, or no space, are text', () => {
  assert.deepEqual(parseMarkdown('# A\n## B\n### C #\n#### D\n#E'), [
    { type: 'h', level: 1, spans: [text('A')] },
    { type: 'h', level: 2, spans: [text('B')] },
    { type: 'h', level: 3, spans: [text('C')] },
    p(text('#### D\n#E')),
  ]);
  assert.deepEqual(parseMarkdown('# About C#')[0].spans, [text('About C#')], 'a hash that belongs to the title stays');
  assert.deepEqual(render('# A\n## B\n### C').map(shape), [['h3', 'A'], ['h4', 'B'], ['h5', 'C']]);
});

test('lists: bullets and numbers, a list right under a paragraph, nesting by indent, a loose list stays one list', () => {
  const [intro, list] = parseMarkdown('Changes:\n- one\n* two\n  continued\n- three');
  assert.deepEqual(intro, p(text('Changes:')));
  assert.deepEqual([list.type, list.items.map((i) => i.spans[0].text)], ['ul', ['one', 'two\ncontinued', 'three']]);

  const [ol] = parseMarkdown('3. c\n\n4. d\n5. e');
  assert.deepEqual([ol.type, ol.start, ol.items.length], ['ol', 3, 3]);

  const [nested, after] = parseMarkdown('- a\n  - a1\n  - a2\n    1. deep\n- b\n\nText');
  assert.equal(nested.items.length, 2);
  assert.deepEqual(nested.items[0].lists.map((l) => [l.type, l.items.map((i) => i.spans[0].text)]), [['ul', ['a1', 'a2']]]);
  assert.deepEqual(nested.items[0].lists[0].items[1].lists.map((l) => [l.type, l.items[0].spans[0].text]), [['ol', 'deep']]);
  assert.deepEqual(after, p(text('Text')));

  assert.deepEqual(parseMarkdown('- a\n1. b').map((b) => b.type), ['ul', 'ol'], 'another marker at the same level is the next list');
  assert.deepEqual(parseMarkdown('-no space\n*emphasis*\n1.5 is a number'), [p(text('-no space\n*emphasis*\n1.5 is a number'))]);

  assert.deepEqual(render('1. a\n2. b').map(shape), [['ol', ['li', 'a'], ['li', 'b']]]);
  assert.deepEqual(render('- a\n  - b').map(shape), [['ul', ['li', 'a', ['ul', ['li', 'b']]]]]);
  assert.equal(render('7. a')[0].start, 7);
});

test('fenced code keeps its text exactly; an open fence runs to the end; the language is a label only', () => {
  const src = 'Run:\n```js\nconst a = `x`;\n<b>not html</b>\n\n- not a list\n```\nAfter';
  assert.deepEqual(parseMarkdown(src), [
    p(text('Run:')),
    { type: 'code', lang: 'js', text: 'const a = `x`;\n<b>not html</b>\n\n- not a list' },
    p(text('After')),
  ]);
  assert.deepEqual(parseMarkdown('````\n```\ninner\n```\n````'), [{ type: 'code', lang: '', text: '```\ninner\n```' }], 'a longer fence holds a shorter one');
  assert.deepEqual(parseMarkdown('```\nstill writing'), [{ type: 'code', lang: '', text: 'still writing' }]);
  assert.deepEqual(parseMarkdown('```js"><script>alert(1)</script>\nx\n```')[0].lang, 'js', 'the info string is cut at the first odd character');
  assert.deepEqual(parseMarkdown('use ```inline``` here'), [p(text('use '), { type: 'code', text: 'inline' }, text(' here'))], 'a fence needs its own line');

  const [pre] = render('```sh\nnpm test -- --watch=false\n```');
  assert.deepEqual(shape(pre), ['pre', ['code', 'npm test -- --watch=false']]);
  assert.equal(pre.dataset.lang, 'sh');
});

test('inline code and bold; everything else is the text it is', () => {
  assert.deepEqual(parseInline('a `b` c'), [text('a '), { type: 'code', text: 'b' }, text(' c')]);
  assert.deepEqual(parseInline('`` a ` b ``'), [{ type: 'code', text: 'a ` b' }]);
  assert.deepEqual(parseInline('an `open tick'), [text('an `open tick')]);
  assert.deepEqual(parseInline('**bold** and **with `code`**'), [
    { type: 'strong', spans: [text('bold')] }, text(' and '), { type: 'strong', spans: [text('with '), { type: 'code', text: 'code' }] },
  ]);
  assert.deepEqual(parseInline('`**not bold**`'), [{ type: 'code', text: '**not bold**' }]);
  assert.deepEqual(parseInline('2 ** 3 ** 4'), [text('2 ** 3 ** 4')], 'a power is no bold');
  assert.deepEqual(parseInline('**open'), [text('**open')]);
  assert.deepEqual(parseInline('*em* _em_ ~~s~~'), [text('*em* _em_ ~~s~~')]);
  assert.deepEqual(parseInline(''), []);
  assert.deepEqual(render('**a** `b`').map(shape), [['p', ['strong', 'a'], ' ', ['code', 'b']]]);
});

test('a line of three or more dashes is a rule', () => {
  assert.deepEqual(parseMarkdown('Above\n\n---\nBelow\n-----'), [p(text('Above')), { type: 'rule' }, p(text('Below')), { type: 'rule' }]);
  assert.deepEqual(parseMarkdown('--\n- - -')[0], p(text('--')), 'two dashes are text');
  assert.deepEqual(render('---').map(shape), [['hr']]);
});

test('links, images, raw HTML and tables stay literal text: no element is made for them', () => {
  const hostile = [
    '[click me](javascript:alert(1)) and <https://evil.example/x> and https://plain.example',
    '![img](https://evil.example/pixel.png "t")',
    '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="https://evil.example">x</a>',
    '<iframe srcdoc="<script>alert(3)</script>"></iframe>',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '> quoted <b>bold</b>',
    '&lt;b&gt; &amp; &#x3C;script&#x3E;',
  ].join('\n\n');
  const nodes = render(hostile);
  const tags = new Set(nodes.flatMap((n) => [n, ...all(n)]).map((n) => n.tagName));
  assert.deepEqual([...tags].sort(), ['P'], 'paragraphs only');
  assert.equal(nodes.map((n) => n.textContent).join('\n\n'), hostile, 'every character is still there as text');
  // inside the constructs of the subset too
  const mixed = render('# <b>h</b>\n- [x](y) <i>i</i>\n\n**<u>u</u>** `<s>s</s>`');
  assert.deepEqual([...new Set(mixed.flatMap((n) => [n, ...all(n)]).map((n) => n.tagName))].sort(), ['CODE', 'H3', 'LI', 'P', 'STRONG', 'UL']);
  assert.deepEqual(mixed.map((n) => n.textContent), ['<b>h</b>', '[x](y) <i>i</i>', '<u>u</u> <s>s</s>']);
});

test('the builder makes only the elements of the subset, through createElement and createTextNode', () => {
  const made = [];
  const node = (tag) => ({ tag, dataset: {}, kids: [], append(...k) { this.kids.push(...k); }, set textContent(v) { this.kids = [v]; } });
  const doc = { createElement: (tag) => { made.push(tag); return node(tag); }, createTextNode: (t) => { made.push('#text'); return t; } };
  const every = '# h1\n## h2\n### h3\n\npara **b** `c`\n\n- u\n\n1. o\n\n```js\ncode\n```\n\n---\n<div onclick="x()">raw</div>';
  buildMarkdown(parseMarkdown(every), doc);
  assert.deepEqual([...new Set(made)].sort(), ['#text', 'code', 'h3', 'h4', 'h5', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'ul']);
  const src = readFileSync(new URL('../../visualizer/public/js/chat-markdown.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|srcdoc|DOMParser|createContextualFragment|setHTMLUnsafe|document\.write/);
  assert.doesNotMatch(code, /createElement\((['"`])(a|img|table|script|iframe|style|link|object|embed)\1\)/);
  assert.doesNotMatch(code, /\.href\b|\.src\b|setAttribute\(/, 'no attribute a model could aim at');
});

test('a 16000 character message of one line, and one of 16000 lines, are tokenized without trouble', () => {
  assert.equal(parseMarkdown('x'.repeat(16000))[0].spans[0].text.length, 16000);
  assert.equal(parseMarkdown('`'.repeat(16000)).length, 1);
  assert.equal(parseMarkdown('**'.repeat(8000)).length, 1);
  assert.equal(parseMarkdown(Array.from({ length: 8000 }, (_, i) => `- item ${i}`).join('\n'))[0].items.length, 8000);
  assert.equal(parseMarkdown(Array.from({ length: 4000 }, (_, i) => `${' '.repeat(i % 40)}- x`).join('\n')).length >= 1, true);
});
