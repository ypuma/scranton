// A failure line wraps on an agent card or an instance lane in a critical state, and long paths or commands break
// anywhere: five lines on a card (its open meta disclosure shows it in full), in full in a lane (the server caps
// it at 300 characters). Every other state keeps one clipped line. The event log keeps a failure long enough for
// its open row to show it in full.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduceAll, LOG_SIZE, FAILURE_TEXT_MAX } from '../../visualizer/public/js/state.js';

const css = readFileSync(new URL('../../visualizer/public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }));
const wraps = (body) => /white-space:\s*normal/.test(body) && /overflow-wrap:\s*anywhere/.test(body);

function wrappingStates(target, owner) {
  const states = new Set();
  for (const r of rules) {
    if (!wraps(r.body)) continue;
    // a rule list such as `.agent:has(...) .activity, .agent:is([data-status="blocked"], ...) .activity` splits on its
    // inner commas too, so the selector text of the whole rule is searched
    const text = r.selectors.join(',');
    if (!text.includes(target) || !text.includes(owner)) continue;
    for (const m of text.matchAll(/data-status="([a-z]+)"/g)) states.add(m[1]);
  }
  return [...states].sort();
}

test('agent cards: blocked and error activities wrap in full; the plain line stays one clipped line', () => {
  assert.deepEqual(wrappingStates('.activity', '.agent'), ['blocked', 'error']);
  const base = rules.find((r) => r.selectors.includes('.activity'));
  assert.match(base.body, /white-space:\s*nowrap/);
  assert.match(base.body, /text-overflow:\s*ellipsis/);
});

test('instance lanes: blocked, error and failed activities wrap in full; others stay one clipped line', () => {
  assert.deepEqual(wrappingStates('.lane-activity', '.lane'), ['blocked', 'error', 'failed']);
  const base = rules.find((r) => r.selectors.includes('.lane-activity'));
  assert.match(base.body, /white-space:\s*nowrap/);
  assert.match(base.body, /min-width:\s*0/, 'the grid cell may shrink, so a long command never widens the row');
});

// the line count a rule clamps to, or null when it does not clamp
function clamp(body) {
  if (!/display:\s*-webkit-box/.test(body) || !/-webkit-box-orient:\s*vertical/.test(body)) return null;
  const m = /-webkit-line-clamp:\s*(\d+)/.exec(body);
  return m ? Number(m[1]) : null;
}
const failureRules = (target, owner) => rules.filter((r) => {
  const text = r.selectors.join(',');
  return wraps(r.body) && text.includes(target) && text.includes(owner) && /data-status="(blocked|error)"/.test(text);
});

test('agent cards: a failure stays within five lines, and the open meta disclosure shows it in full', () => {
  const failing = failureRules('.activity', '.agent');
  assert.ok(failing.length > 0);
  for (const r of failing) assert.equal(clamp(r.body), 5, r.selectors.join(','));
  const open = rules.filter((r) => r.selectors.some((s) => /^\.agent:has\(\.agent-more\[open\]\)\s+\.activity$/.test(s)));
  assert.ok(open.length > 0, 'an open disclosure has a rule of its own for the activity');
  for (const r of open) {
    assert.equal(clamp(r.body), null, 'not clamped while the disclosure is open');
    assert.match(r.body, /-webkit-line-clamp:\s*none/);
    assert.match(r.body, /display:\s*block/);
    assert.ok(wraps(r.body), 'the full text wraps instead of widening the card');
    assert.ok(!r.selectors.some((s) => s.includes('data-status')), 'not shared with the clamped failure rule');
  }
});

test('instance lanes: a failure shows in full and never scrolls sideways', () => {
  const failing = failureRules('.lane-activity', '.lane');
  assert.ok(failing.length > 0);
  for (const r of failing) {
    assert.equal(clamp(r.body), null, r.selectors.join(','));
    assert.doesNotMatch(r.body, /line-clamp|max-height|-webkit-box/, 'no clamp of any kind');
    assert.doesNotMatch(r.body, /overflow(-x)?:\s*(visible|scroll|auto)/);
  }
  for (const r of rules.filter((x) => x.selectors.some((s) => s.includes('.lane-activity')))) {
    assert.doesNotMatch(r.body, /line-clamp/, `${r.selectors.join(',')} clamps no lane activity`);
  }
});

test('event log: the narrow cells stay one clipped line, the detail is cut after two lines and an open row shows all of it', () => {
  const cells = rules.find((r) => r.selectors.includes('.log td'));
  assert.match(cells.body, /white-space:\s*nowrap/);
  assert.match(cells.body, /overflow:\s*hidden/);
  assert.match(cells.body, /text-overflow:\s*ellipsis/);
  const body = (selector) => rules.find((r) => r.selectors.length === 1 && r.selectors[0] === selector)?.body ?? '';
  const closed = body('.log .t-text');
  assert.equal(clamp(closed), 2, 'a closed row shows two lines of its detail');
  assert.ok(wraps(closed), 'and a long path breaks inside them');
  const open = body('.log tr[data-expanded] .t-text');
  assert.equal(clamp(open), null, 'an open row is not clamped');
  assert.match(open, /-webkit-line-clamp:\s*none/);
  assert.match(open, /white-space:\s*pre-wrap/, 'line breaks are kept');
  assert.doesNotMatch(open, /max-height|overflow:\s*(hidden|auto|scroll)/, 'nothing of it is cut or scrolls');
  // the detail is the only text of a row that wraps; the foot of an open row wraps its facts
  const wrapping = rules.filter((r) => /white-space:\s*(normal|pre-wrap)/.test(r.body) && r.selectors.some((s) => s.startsWith('.log ')));
  assert.deepEqual(wrapping.flatMap((r) => r.selectors), ['.log .t-text', '.log tr[data-expanded] .t-text', '.log .t-more']);
});

const at = (seq, fields) => ({ v: 1, seq, ts: '2026-11-08T12:00:00.000Z', runId: 'r', ...fields });

test('event log: an error log line and a failed activity keep their full text, others keep their caps', () => {
  const long = `x\u202E${'y'.repeat(1499)}`;
  const s = reduceAll([
    at(1, { type: 'log', level: 'error', message: long }),
    at(2, { type: 'agent_status', agent: 'dwight', status: 'error', activity: long }),
    at(3, { type: 'agent_status', agent: 'dwight', status: 'blocked', activity: long }),
    at(4, { type: 'log', level: 'info', message: long }),
    at(5, { type: 'log', level: 'warn', message: long }),
    at(6, { type: 'agent_status', agent: 'dwight', status: 'working', activity: long }),
  ]);
  const text = (seq) => s.log.find((e) => e.seq === seq).text;
  const full = `x${'y'.repeat(1499)}`;
  assert.equal(text(1), full, 'the 1500-character error survives, without its bidi control');
  assert.equal(text(2), `error: ${full}`);
  assert.equal(text(3), `blocked: ${full}`);
  assert.equal(text(4).length, 180, 'an info line keeps the 180 cap');
  assert.match(text(4), /\.\.\.$/);
  assert.equal(text(5).length, 180, 'a warning keeps the 180 cap');
  assert.equal(text(6), `working: ${full.slice(0, 117)}...`, 'a working activity keeps the 120 cap');
  for (const e of s.log) assert.doesNotMatch(e.text, /\u202E/);
});

test('event log: a failure is still bounded, and so is the log', () => {
  const huge = 'z'.repeat(FAILURE_TEXT_MAX * 3);
  const s = reduceAll([
    at(1, { type: 'log', level: 'error', message: huge }),
    at(2, { type: 'agent_status', agent: 'angela', status: 'error', activity: huge }),
  ]);
  assert.equal(s.log[0].text.length, FAILURE_TEXT_MAX);
  assert.equal(s.log[1].text.length, 'error: '.length + FAILURE_TEXT_MAX);
  const many = reduceAll(Array.from({ length: LOG_SIZE + 20 }, (_, i) => at(i + 1, { type: 'log', level: 'error', message: huge })));
  assert.equal(many.log.length, LOG_SIZE);
  assert.equal(many.log[0].seq, 21, 'the oldest rows go');
});
