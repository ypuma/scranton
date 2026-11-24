// An agent card in a narrow row. Measured at 1440x900 after the agents were renamed: "Develope" / "r" beside the
// status badge in a 167px card, "Plans the work · 2 lan…" in its role line, and "REPORT_REA" / "DY" in the meta
// line of a 117px card. A name wraps between its words only and the status goes under a name it does not fit
// beside; what the agent does wraps, the lane count in one piece; a keyword breaks after an underscore. One word
// wider than the card (a custom agent's name or keyword is up to 40 characters) breaks at the card's edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPipeline, keywordParts } from '../../visualizer/public/js/pipeline.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { installTree, TreeEl } from './fixtures/tree-dom.js';

const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const parse = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
// every rule, the ones inside a container or media query too
const rules = parse(css);
// the rules that hold at any width
const base = parse(css.replace(/@[^{}]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''));
const rule = (selector, list = base) => {
  const found = list.find((r) => r.selector === selector);
  assert.ok(found, `no rule for ${selector}`);
  return found.body;
};
// the rules whose selector list ends one of its selectors in `end`
const targets = (end) => rules.filter((r) => r.selector.split(',').some((s) => s.trim().endsWith(end)));

// one word of 34 characters, as a custom agent may be named
const ONE_WORD = 'Internationalizationcompliancetest';
// what breaks a word that would fit a line of its own, and what cuts text short
const MID_WORD = /overflow-wrap: anywhere|word-break|hyphens/;
const CUT = /nowrap|ellipsis|overflow: hidden|line-clamp/;

// a run with the default gates: the planner reported, the developer has two lanes and one of them finished badly
// later(e): events that follow
function run(later = () => []) {
  let seq = 0;
  const e = (type, fields = {}) => ({ v: 1, seq: ++seq, ts: `2026-11-24T14:00:${String(seq).padStart(2, '0')}Z`, runId: 'r1', type, ...fields });
  return reduceAll([
    e('run_started', {
      request: 'Build', workspace: 'C:\\w', execution: { maxParallel: 2, workflow: { gates: [['oscar', 'hank', 'a11y'], ['angela', 'i18n']] } },
      roles: [
        { id: 'a11y', name: 'Accessibility Reviewer', title: 'Checks the pages with a screen reader', kind: 'gate', passKeyword: 'A11Y_PASSED', failKeyword: 'A11Y_FAILED' },
        { id: 'i18n', name: ONE_WORD, title: 'Checks the translations', kind: 'gate', passKeyword: 'I18N_PASSED', failKeyword: 'I18N_FAILED' },
      ],
    }),
    e('instance_started', { agent: 'michael', instanceId: 'michael', milestoneId: 'plan' }),
    e('agent_status', { agent: 'michael', instanceId: 'michael', status: 'working', activity: 'Planning' }),
    e('agent_finished', { agent: 'michael', instanceId: 'michael', keyword: 'REPORT_READY', exitCode: 0, durationMs: 900, usage: { input: 100, output: 20, cost: 0.01 } }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'One' }, { id: 'm2', title: 'Two' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'One', index: 0, total: 2 }),
    e('milestone_started', { milestoneId: 'm2', title: 'Two', index: 1, total: 2 }),
    e('instance_started', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1' }),
    e('instance_started', { agent: 'dwight', instanceId: 'dwight-m2', milestoneId: 'm2' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', status: 'working', activity: 'Working...' }),
    e('agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 1, durationMs: 900 }),
    ...later(e),
  ]);
}

function mount() {
  installTree();
  const root = new TreeEl('div');
  const pipeline = createPipeline(root);
  pipeline.render(run());
  return (id) => root.querySelector(`[data-node="${id}"]`);
}
// a node's children as they are laid out: text, or the tag of an element
const pieces = (node) => node.childNodes.map((n) => (n.nodeType === 3 ? n.textContent : `<${n.tagName.toLowerCase()}>`));

test('a name wraps between its words, the status goes under a name it does not fit beside, and only a word wider than the card breaks', () => {
  const head = rule('.agent-head');
  assert.match(head, /display: flex;/);
  assert.match(head, /flex-wrap: wrap;/, 'in a row that cannot wrap the name is squeezed beside the badge and breaks inside a word');
  for (const r of targets('.agent-head')) assert.doesNotMatch(r.body, /flex-wrap: nowrap/, r.selector);

  // A word that fits a line of its own stays whole as long as the name is as wide as its text: alone on a line it
  // is only narrower when the card is. A size from the row, or one letter as its smallest size, squeezes it.
  const names = targets('.agent-head h3');
  assert.ok(names.length > 0);
  for (const r of names) {
    assert.doesNotMatch(r.body, MID_WORD, `${r.selector} breaks inside a word that fits a line`);
    assert.doesNotMatch(r.body, /flex(-basis|-grow|-shrink)?:|(?<![-\w])width:|min-width: (?!0;)/, `${r.selector} takes its width from the row, not from its text`);
    assert.doesNotMatch(r.body, CUT, `${r.selector} cuts the name`);
  }
  // One word wider than the card: break-word breaks it where its line ends, and min-width: 0 lets that line end at
  // the card. break-word leaves the name's smallest size at its longest word, so without min-width: 0 the name
  // stays as wide as the word and runs out of the card unbroken.
  const name = rule('.agent-head h3');
  assert.match(name, /overflow-wrap: break-word;/, 'one word of 40 characters runs out of the card');
  assert.match(name, /min-width: 0;/, 'a name as wide as its longest word never breaks that word: it runs out of the card');
  // the badge keeps its width, so it is the badge that moves
  assert.match(rule('.status'), /flex: none/);
  assert.match(rule('.badge'), /white-space: nowrap/);

  // a custom agent's name is its author's text, in one text node the browser wraps at its spaces
  const card = mount();
  assert.deepEqual(pieces(card('a11y').querySelector('h3')), ['Accessibility Reviewer']);
  assert.deepEqual(card('a11y').querySelector('.agent-head').children.map((n) => n.className), ['', 'badge status'], 'name, then status');
  // one long word is not shortened in code, and is whole in the tooltip however the card breaks it
  assert.deepEqual(pieces(card('i18n').querySelector('h3')), [ONE_WORD]);
  assert.equal(card('i18n').querySelector('h3').title, `${ONE_WORD}: Checks the translations`);
});

test('what the agent does is never cut: it wraps, the lane count in one piece with its separator behind the text', () => {
  const lines = targets('.role');
  assert.ok(lines.length > 0);
  for (const r of lines) {
    assert.doesNotMatch(r.body, CUT, `${r.selector} cuts the line`);
    assert.doesNotMatch(r.body, MID_WORD, `${r.selector} breaks inside a word that fits a line`);
  }
  // a block as wide as the card, whatever is in it: a word wider than the card breaks at its edge
  assert.match(rule('.role'), /display: block;[^}]*overflow-wrap: break-word;/, 'a word wider than the card runs out of it');
  assert.match(rule('.role-lanes > span'), /white-space: nowrap/, '"2 lanes" is not split');
  assert.match(rule('.pipeline[data-wide="true"] .role-lanes'), /display: none/, 'a crowded row still leaves the count to the lanes list');

  const card = mount();
  const role = card('dwight').querySelector('.role');
  assert.deepEqual(role.childNodes.map((n) => [n.className ?? '#text', n.textContent]), [['#text', 'Writes the code'], ['role-lanes', '\u00a0\u00b7 2 lanes']]);
  // the separator holds on to the text before it; the line breaks after it, before the count
  const lanes = role.querySelector('.role-lanes');
  assert.deepEqual(lanes.childNodes.map((n) => [n.tagName ?? '#text', n.textContent]), [['#text', '\u00a0\u00b7 '], ['SPAN', '2 lanes']]);
  assert.equal(role.title, 'Writes the code \u00b7 2 lanes');
  assert.deepEqual(pieces(card('angela').querySelector('.role')), ['Tests the result'], 'no lane, no count');
  assert.deepEqual(pieces(card('a11y').querySelector('.role')), ['Checks the pages with a screen reader']);
});

test('a keyword breaks after an underscore, never inside a word: closed and in the opened list', () => {
  assert.deepEqual(keywordParts('REPORT_READY'), ['REPORT_', 'READY']);
  assert.deepEqual(keywordParts('TASK_COMPLETE'), ['TASK_', 'COMPLETE']);
  assert.deepEqual(keywordParts('NO_SECURITY_ISSUES'), ['NO_', 'SECURITY_', 'ISSUES']);
  assert.deepEqual(keywordParts('BLOCKED'), ['BLOCKED'], 'one word has no break');
  assert.deepEqual(keywordParts('A'.repeat(40)), ['A'.repeat(40)], 'the longest keyword may be one piece: the card breaks it');
  assert.deepEqual(keywordParts('A__B_'), ['A_', '_', 'B_']);
  for (const k of ['REPORT_READY', 'A__B_', 'BLOCKED']) assert.equal(keywordParts(k).join(''), k);

  const card = mount();
  const word = (id) => card(id).querySelector('.fact-keyword').querySelector('.meta-value').firstElementChild;
  assert.deepEqual(pieces(word('michael')), ['REPORT_', '<wbr>', 'READY'], 'text nodes and a break opportunity, no markup from a string');
  assert.equal(word('michael').textContent, 'REPORT_READY', 'read and copied as the keyword it is');
  assert.equal(word('michael').className, '');
  assert.deepEqual(pieces(word('dwight')), ['TASK_', '<wbr>', 'COMPLETE']);
  assert.equal(word('dwight').className, 'keyword-bad', 'a finish that failed keeps its mark');
  assert.match(rule('.keyword-bad'), /box-decoration-break: clone;/, 'the mark is whole on both lines');

  // the opened list shows the same nodes; its value may shrink to the card, so the break is used there too
  const more = card('michael').querySelector('.agent-more');
  const before = word('michael');
  more.open = true;
  assert.equal(word('michael'), before);
  // A piece wider than the card breaks at the edge: on a line of its own, the part may be as narrow as the card.
  // The break after an underscore is taken first; the one inside a piece only when no other is left on the line.
  assert.match(rule('.agent-meta'), /flex-wrap: wrap;/);
  for (const r of [...targets('.agent-meta > span'), ...targets('.meta-value'), ...targets('.fact-keyword')]) {
    assert.doesNotMatch(r.body, MID_WORD, `${r.selector} breaks inside a piece that fits a line`);
    assert.doesNotMatch(r.body, CUT, r.selector);
  }
  assert.match(rule('.agent-meta > span'), /min-width: 0; overflow-wrap: break-word;/, 'a piece wider than the card runs out of it');
  assert.match(rule('.agent-more[open] .meta-value'), /min-width: 0/);
});

test('a card drawn again replaces its role line and its keyword in place', () => {
  installTree();
  const root = new TreeEl('div');
  const pipeline = createPipeline(root);
  const card = root.querySelector('[data-node="dwight"]');
  const role = card.querySelector('.role');
  const keyword = card.querySelector('.fact-keyword');
  const totals = card.querySelector('.agent-totals');
  const parts = (node) => node.childNodes.map((n) => [n.className ?? '#text', n.textContent]);
  const word = () => keyword.querySelector('.meta-value').firstElementChild;

  pipeline.render(run());
  const first = word();
  pipeline.render(run());
  assert.deepEqual(parts(role), [['#text', 'Writes the code'], ['role-lanes', '\u00a0\u00b7 2 lanes']], 'one text, one lane count');
  assert.deepEqual(parts(keyword), [['meta-label', 'Keyword '], ['meta-value', 'TASK_COMPLETE']], 'one keyword');
  assert.equal(word(), first, 'a line that says the same is left alone');
  assert.deepEqual(parts(totals).map((p) => p[0]), ['meta-label', 'meta-value'], 'one set of totals');

  // a third lane starts and the second finishes with another keyword
  pipeline.render(run((e) => [
    e('instance_started', { agent: 'dwight', instanceId: 'dwight-m3', milestoneId: 'm3' }),
    e('agent_finished', { agent: 'dwight', instanceId: 'dwight-m2', milestoneId: 'm2', cycle: 1, keyword: 'NEEDS_MORE_WORK', exitCode: 0, durationMs: 900 }),
  ]));
  assert.equal(card.querySelector('.role'), role);
  assert.deepEqual(parts(role), [['#text', 'Writes the code'], ['role-lanes', '\u00a0\u00b7 3 lanes']], 'the new count instead of the old one');
  assert.equal(role.title, 'Writes the code \u00b7 3 lanes');
  assert.deepEqual(parts(keyword), [['meta-label', 'Keyword '], ['meta-value', 'NEEDS_MORE_WORK']], 'the new keyword instead of the old one');
  assert.deepEqual(pieces(word()), ['NEEDS_', '<wbr>', 'MORE_', '<wbr>', 'WORK']);
  assert.equal(word().textContent, 'NEEDS_MORE_WORK', 'still the whole word');
  assert.equal(word().className, '', 'the mark of the failed finish went with it');
  assert.deepEqual(parts(totals), [['meta-label', 'Totals '], ['meta-value', '2 runs\u00a0\u00b7 0 tok\u00a0\u00b7 $0.00']], 'the new totals instead of the old ones');

  // no run on screen: nothing of the last one stays
  pipeline.render(reduceAll([]));
  assert.deepEqual(parts(role), [['#text', 'Writes the code']], 'no lane count');
  assert.deepEqual(parts(keyword), [], 'no keyword');
});

test('a crowded row gives its cards room: the strip\'s padding from four columns on, and five columns wrap before "Developer" is too wide', () => {
  // 15px/600 "Developer" is 74px and a mono "REQUESTED" 69px behind the 14px marker: a card needs 85px inside
  assert.match(rule('.pipeline[data-wide="true"] .agent'), /padding: var\(--s3\);/);
  assert.match(rule('.stage-column'), /flex: 1 1 calc\(2 \* var\(--s3\)\)/, 'the stack starts from the same padding, so its cards are as wide as the others');
  const inside = (width, columns, human = 3.5) => (width * 16 - human * 16 - columns * 20) / columns - 24;
  const strips = [...css.matchAll(/@container \(max-width: ([\d.]+)rem\) \{\s*\.pipeline\[data-(wide|columns|many)="(true|5)"\] \{ flex-wrap: wrap;/g)].map((m) => [m[2], Number(m[1])]);
  assert.deepEqual(strips, [['wide', 36], ['columns', 44], ['many', 52]]);
  for (const [name, width, columns] of [['wide', 36, 4], ['columns', 44, 5], ['many', 52, 6]]) {
    assert.ok(inside(width, columns) >= 85, `${name}: ${inside(width, columns).toFixed(1)}px inside a card where the row begins`);
  }
});
