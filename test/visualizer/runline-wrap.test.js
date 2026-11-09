// The run line under the chat title must fit a phone: at 375px the figures used to run 66px past the viewport
// (scrollWidth 431 vs 365). Groups wrap as units, the segment bars shrink and long figure text breaks, while a
// wide screen keeps its single line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }));
const rule = (selector) => {
  // a sole selector, so `:is(.pill, .elapsed, .summary, ...)` does not answer for `.summary`
  const found = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === selector);
  assert.ok(found, `no rule for ${selector}`);
  return found.body;
};

test('run line: the row and the run state wrap instead of overflowing', () => {
  assert.match(rule('.run-row'), /flex-wrap:\s*wrap/);
  const state = rule('.run-state');
  assert.match(state, /flex-wrap:\s*wrap/);
  assert.match(state, /min-width:\s*0/);
  assert.doesNotMatch(state, /flex:\s*none/, 'a rigid run state pushes the figures off a narrow screen');
});

test('run line: the figures keep a minimum basis so they drop under the run state on narrow screens', () => {
  const summary = rule('.summary');
  assert.match(summary, /flex:\s*1 1 0/);
  assert.match(summary, /min-width:\s*min\(100%,\s*[\d.]+rem\)/, 'with min-width 0 the figures squeeze into a sliver and spill out');
});

test('run line: each figure wraps its parts, long sub text breaks, the current milestone still clips', () => {
  assert.match(rule('.fig dd'), /flex-wrap:\s*wrap/);
  const sub = rule('.fig-sub');
  assert.match(sub, /white-space:\s*normal/);
  assert.match(sub, /overflow-wrap:\s*anywhere/);
  assert.match(sub, /min-width:\s*0/);
  assert.match(rule('.fig-current dd'), /flex-wrap:\s*nowrap/);
  assert.match(rule('.fig-current .fig-value'), /text-overflow:\s*ellipsis/);
  assert.match(rule('.fig-current .fig-sub'), /max-width:\s*100%/);
});

test('run line: segment bars shrink but never vanish', () => {
  const bar = rule('.segments');
  assert.doesNotMatch(bar, /flex:\s*none/, 'a rigid bar of 12 segments is wider than a phone figure');
  assert.match(bar, /min-width:\s*0/);
  const seg = rule('.segments i');
  assert.match(seg, /width:\s*0\.625rem/, 'the bar sizes itself from the segment width, so it keeps its wide look');
  assert.match(seg, /min-width:\s*0\.\d+rem/);
});
