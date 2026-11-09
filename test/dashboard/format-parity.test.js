import test from 'node:test';
import assert from 'node:assert/strict';
import * as term from '../../src/dashboard/render.js';
import * as web from '../../visualizer/public/js/format.js';

// The terminal and the web dashboard must print the same numbers for the same run.
test('terminal and web dashboards format tokens, cost and durations identically', () => {
  const tokens = [0, 7, 999, 999.4, 999.5, 1000, 1049, 1050, 1150, 1450, 2310, 9999, 56600, 150000, 999949, 999950, 1150000, 1450000, 12345678];
  for (const n of tokens) assert.equal(term.formatTokens(n), web.formatTokens(n), `tokens ${n}`);
  const costs = [0, 0.0004, 0.0005, 0.006, 0.0415, 0.138, 0.1745, 0.9994, 0.9996, 1, 1.25, 12.5];
  for (const c of costs) assert.equal(term.formatCost(c), web.formatCost(c), `cost ${c}`);
  const durations = [0, 999, 12000, 59000, 60000, 323000, 3599000, 3720000, 90061000];
  for (const ms of durations) assert.equal(term.formatDuration(ms), web.formatDuration(ms), `duration ${ms}`);
});
