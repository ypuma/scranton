import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatTokens, formatCost, formatDuration, formatClock, runElapsed, plural, stripBidi } from '../../visualizer/public/js/format.js';
import { MS_GLYPH } from '../../visualizer/public/js/dashboard.js';
import { demoDelays } from '../../visualizer/public/js/feed.js';
import { parseJsonl } from '../../visualizer/public/js/state.js';

const SAMPLE = fileURLToPath(new URL('../../visualizer/public/demo/sample-events.jsonl', import.meta.url));

// Same spec as the terminal dashboard.
test('tokens: plain integer below 1000, then one decimal with k / M', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(999.6), '1.0k');
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(2300), '2.3k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(56_600), '56.6k');
  assert.equal(formatTokens(184_210), '184.2k');
  assert.equal(formatTokens(999_960), '1.0M', 'rounding up rolls over to M, never 1000.0k');
  assert.equal(formatTokens(1_200_000), '1.2M');
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(formatTokens(-5), '0');
  assert.equal(formatTokens('x'), '0');
});

test('cost: 3 decimals below $1, 2 from $1', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.006), '$0.006');
  assert.equal(formatCost(0.0714), '$0.071');
  assert.equal(formatCost(0.138), '$0.138');
  assert.equal(formatCost(0.9996), '$1.00', 'rounding up to $1 switches to 2 decimals');
  assert.equal(formatCost(1), '$1.00');
  assert.equal(formatCost(1.25), '$1.25');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatCost(-1), '$0.00');
});

test('the active milestone uses the filled dot, like the terminal dashboard', () => {
  assert.equal(MS_GLYPH.active, '●');
  assert.equal(MS_GLYPH.pending, '○');
  assert.equal(MS_GLYPH.passed, '✓');
});

test('stripBidi removes the bidi embedding, override, isolate and mark controls', () => {
  const controls = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F'];
  assert.equal(stripBidi(`a${controls.join('')}b`), 'ab');
  assert.equal(stripBidi('npm test \u202Etxt.exe'), 'npm test txt.exe');
  assert.equal(stripBidi('plain - äöü ✓ 日本'), 'plain - äöü ✓ 日本');
  assert.equal(stripBidi('\u200D zero width joiner stays'), '\u200D zero width joiner stays');
  assert.equal(stripBidi(null), '');
});

test('plural', () => {
  assert.equal(plural(1, 'run'), '1 run');
  assert.equal(plural(3, 'run'), '3 runs');
});

test('durations and clock', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(12_000), '12s');
  assert.equal(formatDuration(45_900), '45s');
  assert.equal(formatDuration(323_000), '5m 23s');
  assert.equal(formatDuration(754_000), '12m 34s');
  assert.equal(formatDuration(3_725_000), '1h 02m');
  assert.equal(formatDuration(-1), '-');
  assert.equal(formatClock(new Date(2026, 6, 12, 14, 22, 33).toISOString()), '14:22:33');
  assert.equal(formatClock('nope'), '--:--:--');
});

test('the clock shows local time, like the terminal dashboard', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata';
  try {
    assert.equal(formatClock('2026-07-12T14:22:33.000Z'), '19:52:33');
    assert.equal(formatClock('2026-07-12T20:05:09.000Z'), '01:35:09');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('runElapsed uses event time, and ticks only when asked', () => {
  assert.equal(runElapsed({ startedAt: null }), null);
  const s = { startedAt: '2026-07-12T14:00:00.000Z', updatedAt: '2026-07-12T14:01:00.000Z', finishedAt: null };
  assert.equal(runElapsed(s), 60_000);
  assert.equal(runElapsed(s, { ticking: true, now: Date.parse('2026-07-12T14:02:00.000Z') }), 120_000);
  assert.equal(runElapsed({ ...s, finishedAt: '2026-07-12T14:00:30.000Z' }, { ticking: true, now: Date.now() }), 30_000);
});

test('demo timing follows the ts deltas, is capped and lands near the target length', () => {
  const events = parseJsonl(readFileSync(SAMPLE, 'utf8'));
  const delays = demoDelays(events, { targetMs: 75_000, capMs: 2600 });
  assert.equal(delays.length, events.length);
  assert.equal(delays[0], 0);
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(total >= 60_000 && total <= 90_000, `total ${total} ms`);
  assert.ok(Math.max(...delays) <= 2600);
  // the human took 45 s to answer: that gap is capped, not stretched
  const answer = events.findIndex((e) => e.type === 'hitl_response');
  assert.equal(delays[answer], 2600);
  // a gap after a hive_write is long enough for the handoff animation
  events.forEach((e, i) => { if (i > 0 && events[i - 1].type === 'hive_write') assert.ok(delays[i] >= 1100); });
});
