import test from 'node:test';
import assert from 'node:assert/strict';
import { units, tokens, clipUnits, cutUnits, pct } from '../../src/core/context/tokens.js';

const vectors = [['', 0, 0], ['Hello, World!', 13, 4], ['M\u00fcnchen & K\u00f6ln', 16, 4], ['\u6771\u4eac\u3068\u5317\u4eac', 20, 5], ['Scranton \ud83d\ude80\u2728', 15, 4], ['bad\uD800surrogate\uDC00', 20, 5], ['Hello \u00e4\u00f6\u00fc \u4e2d\u6587 \ud83d\ude80 \uD800!', 32, 8], ['cut\u2026', 4, 1]];
const generated = Array.from({ length: 100 }, (_, i) => Array.from({ length: i }, (_, j) => ['x', '\u00e4', '\u4e2d', '\ud83d\ude80', '\ud800', '\udc00', '\u2026'][(i * 17 + j * 11) % 7]).join(''));
// Revert tokens.js weight/codePointAt, Math.ceil, prefix iteration or max-1 to fail these guards.
test('unit vectors, non-strings and Unicode boundaries follow the normative table', () => {
  for (const [text, u, t] of vectors) { assert.equal(units(text), u); assert.equal(tokens(text), t); }
  for (const text of [undefined, null, {}, 7, []]) { assert.equal(units(text), 0); assert.equal(tokens(text), 0); assert.equal(clipUnits(text, 8), ''); }
  assert.equal(units('\u007f\u0080\u2e7f\u2e80\ud800\u2026'), 14);
});
test('generated prefixes preserve code points, unit bounds and additivity at whole-code-point seams', () => {
  for (const text of generated) {
    assert.ok(units(text) >= text.length);
    const points = [...text];
    for (let i = 0; i <= points.length; i++) {
      const a = points.slice(0, i).join(''), b = points.slice(i).join('');
      assert.equal(units(a + b), units(a) + units(b));
    }
    for (let n = 0; n < units(text) + 2; n++) {
      const clipped = clipUnits(text, n), cut = cutUnits(text, n);
      assert.ok(units(clipped) <= n); assert.ok(units(cut) <= n);
      assert.ok(text.startsWith(clipped));
      assert.deepEqual([...clipped], points.slice(0, [...clipped].length));
      const next = points[[...clipped].length]; if (next) assert.ok(units(clipped + next) > n);
      assert.equal(cut, !n ? '' : units(text) <= n ? text : clipUnits(text, n - 1) + '\u2026');
    }
  }
  assert.equal(clipUnits('\ud83d\ude80', 3), ''); assert.equal(cutUnits('abc', -1), '');
});
test('surrogate seam is the explicit exception to concatenation additivity', () => {
  assert.equal(units('\ud800') + units('\udc00'), 8); assert.equal(units('\ud800\udc00'), 4);
});
test('percent formatting uses shared zero, sub-tenth, decimal and rounded rules', () => {
  for (const [n, d, expected] of [[0, 0, '0'], [1, 2000, '<0.1'], [1, 1000, '0.1'], [3, 2000, '0.2'], [1045, 10000, '10'], [1, 0, '0'], [1, -1, '0'], [Infinity, 1000, '0'], [1, Infinity, '0'], [NaN, 1000, '0'], [99, 1000, '9.9'], [50, 1000, '5.0'], [996, 10000, '10'], [995, 10000, '10'], [100, 1000, '10'], [126, 1000, '13'], [2, 1, '200']]) assert.equal(pct(n, d), expected);
});
test('browser and Node unit, token and percentage estimators have parity', async (t) => {
  const browser = await import('../../visualizer/public/js/context.js');
  if (typeof browser.units !== 'function' || typeof browser.tokens !== 'function' || typeof browser.pct !== 'function') { t.skip('pending lane F estimator exports'); return; }
  for (const text of [...vectors.map(([s]) => s), ...generated, null, 7]) { assert.equal(browser.units(text), units(text)); assert.equal(browser.tokens(text), tokens(text)); }
  for (const [n, d] of [[0, 0], [0, 1000], [1, 0], [1, -1], [Infinity, 1000], [1, Infinity], [NaN, 1000], [3, 2000], [1045, 10000], [1, 2000], [1, 1000], [50, 1000], [99, 1000], [995, 10000], [996, 10000], [100, 1000]]) assert.equal(browser.pct(n, d), pct(n, d));
  for (let n = 0; n <= 20000; n++) for (const d of [1000, 10000, 128000]) assert.equal(browser.pct(n, d), pct(n, d), `pct(${n}, ${d})`);
});
