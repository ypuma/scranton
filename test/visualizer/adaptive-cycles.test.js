// Adaptive milestone cycles (.enma/adaptive-cycles-contract.md): the progress check after a failed cycle, why the
// breaker asks, the run settings, and older streams that carry none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reduce, reduceAll, createState, checkView, breakerTitle, describe, stalledText, budgetText, DEFAULT_MAX_FAILED_CYCLES, parseJsonl,
} from '../../visualizer/public/js/state.js';
import { reduce as nodeReduce, initialState } from '../../src/core/state.js';
import { buildRunRequest, parseControl, errorField, hitlTitle, CYCLES_MAX, STALLED_MAX, TOKEN_BUDGET_MAX } from '../../visualizer/public/js/control.js';
import { breakerTile, createDashboard } from '../../visualizer/public/js/dashboard.js';
import { milestoneColumn, teamBoard } from '../../visualizer/public/js/activity-model.js';
import { attemptText } from '../../visualizer/public/js/board.js';
import { typeLabel } from '../../visualizer/public/js/log.js';
import { installTree } from './fixtures/tree-dom.js';

const RUN = 'run-adaptive';

function journal() {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 22, 9, 0, seq)).toISOString(), runId: RUN, type, ...fields });
}

// one milestone that fails a cycle; adaptive: the run is from a runtime with the progress check
function failedOnce(adaptive) {
  const e = journal();
  const events = [
    e('run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: adaptive ? 12 : 3, ...(adaptive ? { maxStalledCycles: 2, milestoneTokenBudget: 500000 } : {}) }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'Auth' }, { id: 'm2', title: 'Docs', dependsOn: ['m1'] }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'Auth', index: 0, total: 2 }),
    e('cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Hank reported [SECURITY_ISSUES]: Security audit' }),
  ];
  return { e, events };
}

const check = (fields = {}) => ['progress_check', {
  milestoneId: 'm1', cycle: 1, verdict: 'progress', source: 'michael', rule: null, reason: 'The token leak is fixed; a narrower finding is left.',
  changed: true, stalledCycles: 0, maxStalledCycles: 2, tokens: 120000, tokenBudget: 500000, ...fields,
}];

const add = (state, e, list) => list.reduce((s, [type, fields]) => reduce(s, e(type, fields)), state);

test('the reducer keeps a milestone\'s last progress check and the run\'s cycle settings', () => {
  const { e, events } = failedOnce(true);
  let s = reduceAll(events);
  assert.deepEqual([s.maxFailedCycles, s.maxStalledCycles, s.milestoneTokenBudget], [12, 2, 500000]);
  assert.equal(s.milestones[0].progressCheck, null, 'no check before the first failed cycle is judged');
  s = add(s, e, [check()]);
  const c = s.milestones[0].progressCheck;
  assert.deepEqual(
    [c.cycle, c.verdict, c.source, c.rule, c.reason, c.changed, c.stalledCycles, c.maxStalledCycles, c.tokens, c.tokenBudget],
    [1, 'progress', 'michael', null, 'The token leak is fixed; a narrower finding is left.', true, 0, 2, 120000, 500000],
  );
  s = add(s, e, [check({ cycle: 2, verdict: 'stalled', source: 'rule', rule: 'repeat', reason: 'Same failure as cycle 1.', stalledCycles: 1, tokens: 240000 })]);
  assert.deepEqual(checkView(s.milestones[0]), {
    cycle: 2, verdict: 'stalled', word: 'No progress', how: 'same failure again', reason: 'Same failure as cycle 1.',
    meter: 'no progress 1 of 2 · 240.0k of 500.0k tokens',
  });
  assert.equal(s.milestones[1].progressCheck, null, 'a check belongs to its milestone only');
  assert.equal(s.applied, events.length + 2, 'progress_check is a known event type');
});

test('a tripped breaker keeps its cause, and the contract titles say it', () => {
  const { e, events } = failedOnce(true);
  const base = add(reduceAll(events), e, [check({ cycle: 2, verdict: 'stalled', source: 'rule', rule: 'no_change', reason: 'Dwight changed nothing.', stalledCycles: 2 })]);
  const trip = (fields) => add(base, e, [['circuit_breaker', {
    milestoneId: 'm1', state: 'tripped', failedCycles: 2, maxFailedCycles: 12, stalledCycles: 2, maxStalledCycles: 2, tokens: 512345, tokenBudget: 500000, ...fields,
  }]]);
  const stalled = trip({ cause: 'stalled' });
  assert.equal(stalled.trip.cause, 'stalled');
  assert.equal(stalled.milestones[0].trip.cause, 'stalled');
  assert.equal(breakerTitle(stalled), 'No progress on m1: Dwight changed nothing.');
  assert.equal(breakerTitle(trip({ cause: 'budget' })), 'm1 used 512.3k tokens without passing');
  assert.equal(breakerTitle(trip({ cause: 'limit', failedCycles: 12 })), 'm1 reached the cycle limit (12)');
  assert.equal(breakerTitle(stalled, 'm2'), null, 'a question about another milestone is not this trip');
  assert.equal(stalled.log.at(-1).text, 'Circuit breaker tripped: No progress on m1: Dwight changed nothing.');
  assert.deepEqual(milestoneColumn(stalled, stalled.milestones[0]), { column: 'blocked', word: 'no progress' });
  assert.deepEqual(milestoneColumn(trip({ cause: 'budget' }), stalled.milestones[0]), { column: 'blocked', word: 'budget used' });

  // the answer card and the alert use the title
  const pending = { runId: RUN, requestSeq: 99, milestoneId: 'm1', reason: 'r', options: ['feedback', 'retry'] };
  assert.equal(hitlTitle(pending, stalled), 'No progress on m1: Dwight changed nothing.');
  assert.equal(hitlTitle({ ...pending, milestoneId: 'm2' }, stalled), 'Human input required');
  assert.equal(hitlTitle(null, stalled), 'Human input required');

  // a decision drops the last check and the token window; the reset closes the breaker
  const asked = add(stalled, e, [['hitl_request', { milestoneId: 'm1', reason: 'No progress on m1', options: ['feedback', 'retry', 'skip', 'abort'] }]]);
  const answered = add(asked, e, [['hitl_response', { milestoneId: 'm1', decision: 'retry' }], ['circuit_breaker', { milestoneId: 'm1', state: 'reset', failedCycles: 0, maxFailedCycles: 12 }]]);
  assert.deepEqual([answered.breaker, answered.trip, answered.milestones[0].trip], ['closed', null, null]);
  assert.deepEqual([answered.milestones[0].progressCheck, answered.milestones[0].tokens], [null, 0]);
  assert.equal(checkView(answered.milestones[0]), null);
  const skipped = add(asked, e, [['hitl_response', { milestoneId: 'm1', decision: 'skip' }]]);
  assert.equal(skipped.milestones[0].progressCheck.stalledCycles, 2, 'skip does not restart the count');
});

test('the log shows progress_check lines', () => {
  const { e, events } = failedOnce(true);
  const s = add(reduceAll(events), e, [check(), check({ cycle: 2, verdict: 'stalled', source: 'rule', rule: 'repeat', reason: 'Same failure.', stalledCycles: 1, tokenBudget: 0 })]);
  const lines = s.log.filter((l) => l.type === 'progress_check');
  assert.deepEqual(lines.map((l) => [l.tone, l.category, l.text]), [
    ['info', 'results', 'm1 cycle 1 progress (judged by the Planner): The token leak is fixed; a narrower finding is left. · no progress 0 of 2 · 120.0k of 500.0k tokens'],
    ['warn', 'results', 'm1 cycle 2 no progress (same failure again): Same failure. · no progress 1 of 2 · 120.0k tokens'],
  ]);
  assert.equal(typeLabel('progress_check'), 'Progress');
});

test('the breaker tile: cycle, verdict and reason, no progress X of N, tokens of the budget', () => {
  const { e, events } = failedOnce(true);
  const before = breakerTile(reduceAll(events));
  assert.deepEqual([before.label, before.value, before.sub, before.of, before.progress], ['Progress', 'Closed', 'no progress 0 of 2', 2, false]);
  const s = add(reduceAll(events), e, [check({ cycle: 2, verdict: 'stalled', source: 'rule', rule: 'repeat', reason: 'Same failure as cycle 1.', stalledCycles: 1, tokens: 240000 })]);
  assert.deepEqual(breakerTile(s), {
    label: 'Progress', value: 'No progress', sub: 'cycle 2 · no progress 1 of 2 · 240.0k of 500.0k tokens',
    reason: 'No progress, same failure again: Same failure as cycle 1.', filled: 1, of: 2, tripped: false, progress: true,
  });
  const tripped = add(s, e, [['circuit_breaker', { milestoneId: 'm1', state: 'tripped', cause: 'budget', failedCycles: 2, maxFailedCycles: 12, tokens: 500100, tokenBudget: 500000 }]]);
  assert.deepEqual([breakerTile(tripped).value, breakerTile(tripped).tripped], ['Budget used', true]);

  // rendered: plain text in the tile, the reason in full in its title, the alert headed by the contract title
  const $ = installTree();
  for (const cls of ['pill-glyph', 'pill-text']) $('run-status').append(Object.assign(document.createElement('span'), { className: cls }));
  const dash = createDashboard();
  const evil = add(s, e, [check({ cycle: 3, verdict: 'stalled', reason: '<img src=x onerror=alert(1)> again', stalledCycles: 2 })]);
  const asked = add(evil, e, [
    ['circuit_breaker', { milestoneId: 'm1', state: 'tripped', cause: 'stalled', failedCycles: 3, maxFailedCycles: 12, stalledCycles: 2, maxStalledCycles: 2 }],
    ['hitl_request', { milestoneId: 'm1', reason: 'Last failure: Hank reported [SECURITY_ISSUES]', options: ['feedback', 'retry'] }],
  ]);
  dash.render(asked);
  assert.equal($('kpi-breaker-label').textContent, 'Progress');
  assert.equal($('kpi-breaker').textContent, 'No progress');
  assert.equal($('kpi-breaker-sub').textContent, 'cycle 3 · no progress 2 of 2 · 120.0k of 500.0k tokens');
  assert.equal($('kpi-breaker-reason').textContent, 'No progress, judged by the Planner: <img src=x onerror=alert(1)> again');
  assert.equal($('kpi-breaker-reason').children.length, 0, 'model text stays text');
  assert.equal($('kpi-breaker-tile').dataset.progress, 'true');
  assert.equal($('kpi-breaker-meter').children.filter((i) => i.dataset.fill === 'full').length, 2);
  assert.equal($('alert-title').textContent, 'No progress on m1: <img src=x onerror=alert(1)> again');
  assert.equal($('alert-detail').textContent, 'Human input required in the orchestrator terminal. Last failure: Hank reported [SECURITY_ISSUES]');
  assert.doesNotMatch($('kpi-breaker-sub').textContent, /failed/, 'the failed-cycles wording is gone');
});

test('board cards count cycles without progress instead of failed ones', () => {
  const { e, events } = failedOnce(true);
  const s = add(reduceAll(events), e, [check()]);
  const card = teamBoard(s).columns.flatMap((c) => c.cards).find((c) => c.id === 'm1');
  assert.deepEqual(card.check, { word: 'Progress', how: 'judged by the Planner', reason: 'The token leak is fixed; a narrower finding is left.', meter: 'no progress 0 of 2 · 120.0k of 500.0k tokens' });
  assert.equal(attemptText(card, 'milestone'), 'cycle 1 · no progress 0 of 2 · 120.0k of 500.0k tokens');
  assert.equal(teamBoard(s).columns.flatMap((c) => c.cards).find((c) => c.id === 'm2').check, null);
});

test('an older stream renders as before: no progress info, the old meter text', () => {
  const { e, events } = failedOnce(false);
  let s = reduceAll(events);
  assert.deepEqual([s.maxFailedCycles, s.maxStalledCycles, s.milestoneTokenBudget], [3, null, null]);
  assert.equal(checkView(s.milestones[0]), null);
  assert.deepEqual(breakerTile(s), { label: 'Breaker', value: 'Closed', sub: '1/3 failed', reason: '', filled: 1, of: 3, tripped: false, progress: false });
  s = add(s, e, [['circuit_breaker', { milestoneId: 'm1', state: 'tripped', failedCycles: 3, maxFailedCycles: 3 }]]);
  assert.equal(s.trip.cause, null);
  assert.equal(breakerTitle(s), null);
  assert.equal(hitlTitle({ milestoneId: 'm1' }, s), 'Human input required');
  assert.equal(s.log.at(-1).text, 'Circuit breaker tripped after 3/3 failed cycles');
  assert.deepEqual(milestoneColumn(s, s.milestones[0]), { column: 'blocked', word: 'breaker tripped' });
  const card = teamBoard(s).columns.flatMap((c) => c.cards).find((c) => c.id === 'm1');
  assert.equal(card.check, null);
  assert.equal(attemptText(card, 'milestone'), 'cycle 1 · 1 failed');
  // a stream without maxFailedCycles at all assumes the new safety cap
  assert.equal(createState().maxFailedCycles, DEFAULT_MAX_FAILED_CYCLES);
  assert.equal(DEFAULT_MAX_FAILED_CYCLES, 12);
});

test('negative control: malformed progress fields are dropped, never shown', () => {
  const { e, events } = failedOnce(true);
  const s = add(reduceAll(events), e, [
    check({ verdict: 'maybe' }),
    check({ milestoneId: 'm9' }),
  ]);
  assert.equal(s.milestones[0].progressCheck, null, 'an unknown verdict is no check');
  assert.equal(s.log.filter((l) => l.type === 'progress_check').length, 1, 'only the unknown verdict has no line');
  const odd = add(reduceAll(events), e, [check({ source: 'oracle', rule: 'gut', stalledCycles: -1, tokens: 'lots', tokenBudget: 1.5, maxStalledCycles: 0, reason: 'x'.repeat(400) })]);
  const c = odd.milestones[0].progressCheck;
  assert.deepEqual([c.source, c.rule, c.stalledCycles, c.tokens, c.tokenBudget, c.maxStalledCycles], [null, null, null, null, null, null]);
  assert.equal(c.reason.length, 300);
  assert.deepEqual([stalledText(c), budgetText(c), checkView(odd.milestones[0]).meter, checkView(odd.milestones[0]).how], ['', '', '', '']);
  const unknown = add(reduceAll(events), e, [['circuit_breaker', { milestoneId: 'm1', state: 'tripped', cause: 'boredom', failedCycles: 1, maxFailedCycles: 12 }]]);
  assert.equal(breakerTitle(unknown), null, 'an unknown cause falls back to the old wording');
  assert.equal(describe({ type: 'progress_check', milestoneId: 'm1', cycle: 1, verdict: 'nope' }), null);
});

test('run settings: cycle limit 1..50, cycles without progress 1..10, token budget 0..20000000', () => {
  const c = parseControl({ v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'], run: null, lastExit: null, pendingHuman: null });
  assert.deepEqual([CYCLES_MAX, STALLED_MAX, TOKEN_BUDGET_MAX], [50, 10, 20000000]);
  const run = (fields) => buildRunRequest({ request: 'x', ...fields }, c);
  assert.deepEqual(run({ maxCycles: '12', maxStalledCycles: '2', milestoneTokenBudget: '500000' }).body,
    { request: 'x', maxCycles: 12, maxStalledCycles: 2, milestoneTokenBudget: 500000, conversation: true });
  assert.deepEqual(run({ maxCycles: '', maxStalledCycles: ' ', milestoneTokenBudget: '' }).body, { request: 'x', conversation: true }, 'empty fields leave the server defaults');
  assert.equal(run({ milestoneTokenBudget: '0' }).body.milestoneTokenBudget, 0, '0 turns the budget off');
  for (const [v, ok] of [['1', true], ['50', true], ['0', false], ['51', false]]) assert.equal(Boolean(run({ maxCycles: v }).body), ok, `maxCycles ${v}`);
  for (const [v, ok] of [['1', true], ['10', true], ['0', false], ['11', false], ['1.5', false], ['two', false]]) {
    const r = run({ maxStalledCycles: v });
    assert.equal(Boolean(r.body), ok, `maxStalledCycles ${v}`);
    if (!ok) assert.deepEqual(r, { error: 'Cycles without progress must be a whole number from 1 to 10.', field: 'maxStalledCycles' });
  }
  for (const [v, ok] of [['20000000', true], ['20000001', false], ['-1', false], ['5e5', false]]) {
    const r = run({ milestoneTokenBudget: v });
    assert.equal(Boolean(r.body), ok, `milestoneTokenBudget ${v}`);
    if (!ok) assert.equal(r.field, 'milestoneTokenBudget');
  }
  assert.equal(run({ maxCycles: '51' }).error, 'The cycle limit must be a whole number from 1 to 50.');
  assert.equal(errorField('Invalid maxStalledCycles'), 'maxStalledCycles');
  assert.equal(errorField('Invalid milestoneTokenBudget'), 'milestoneTokenBudget');
  assert.equal(errorField('Invalid maxCycles'), 'maxCycles');
});

test('the run settings are labelled as the contract says', () => {
  const html = readFileSync(new URL('../../visualizer/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="f-cycles">Cycle limit \(safety\)<\/label>/);
  assert.match(html, /id="f-cycles" name="maxCycles"[^>]*placeholder="12"/);
  assert.match(html, /<label for="f-stalled">Stop after N cycles without progress<\/label>/);
  assert.match(html, /id="f-stalled" name="maxStalledCycles"[^>]*placeholder="2"/);
  assert.match(html, /id="f-budget" name="milestoneTokenBudget"[^>]*placeholder="500000"/);
  assert.doesNotMatch(html, /Max failed cycles/);
});

test('the demo shows a progress check and a stalled trip', () => {
  const events = parseJsonl(readFileSync(new URL('../../visualizer/public/demo/sample-events.jsonl', import.meta.url), 'utf8'));
  const checks = events.filter((x) => x.type === 'progress_check');
  assert.deepEqual(checks.map((x) => [x.milestoneId, x.cycle, x.verdict]), [['m2', 1, 'progress'], ['m2', 2, 'stalled']]);
  const trip = events.findIndex((x) => x.type === 'circuit_breaker' && x.state === 'tripped');
  assert.equal(events[trip].cause, 'stalled');
  const at = reduceAll(events.slice(0, trip + 1));
  assert.match(breakerTitle(at), /^No progress on m2: `node cli\.js done 1` still crashes/);
  assert.equal(breakerTile(at).value, 'No progress');
  assert.equal(breakerTile(at).sub, 'cycle 2 · no progress 1 of 1 · 19.4k of 500.0k tokens');
  assert.equal(at.log.filter((l) => l.type === 'progress_check').length, 2);
});

test('in a parallel run the tile names the milestone it speaks for', () => {
  const e = journal();
  const s = reduceAll([
    e('run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 12, maxStalledCycles: 2, milestoneTokenBudget: 0 }),
    e('plan_ready', { milestones: [{ id: 'm1', title: 'Auth' }, { id: 'm2', title: 'CLI' }] }),
    e('milestone_started', { milestoneId: 'm1', title: 'Auth', index: 0, total: 2 }),
    e('milestone_started', { milestoneId: 'm2', title: 'CLI', index: 1, total: 2 }),
    e('cycle_result', { milestoneId: 'm2', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Tests failed' }),
    e(...check({ milestoneId: 'm2', tokenBudget: 0 })),
  ]);
  assert.deepEqual([s.activeMilestoneIds, s.currentMilestoneId], [['m1', 'm2'], 'm1']);
  assert.equal(breakerTile(s).sub, 'm2 cycle 1 · no progress 0 of 2 · 120.0k tokens', 'the current milestone has no check yet, m2 has');
});

// The per-milestone progress and token fields of the Node reducer (state.json) and the view, in one shape.
const CHECK_FIELDS = ['cycle', 'verdict', 'source', 'rule', 'reason', 'changed', 'stalledCycles', 'maxStalledCycles', 'tokens', 'tokenBudget'];
const pick = (c) => (c ? Object.fromEntries(CHECK_FIELDS.map((k) => [k, c[k]])) : null);
const nodeFields = (s) => s.milestones.map((m) => ({ id: m.id, tokens: m.tokens ?? 0, check: pick(m.progress) }));
const viewFields = (s) => s.milestones.map((m) => ({ id: m.id, tokens: m.tokens, check: pick(m.progressCheck) }));

// Replays the events through both reducers and asserts they agree after every one; -> the view fields per step
function replayBoth(events) {
  let node = initialState();
  let view = createState();
  return events.map((ev) => {
    node = nodeReduce(node, ev);
    view = reduce(view, ev);
    assert.deepEqual(viewFields(view), nodeFields(node), `after seq ${ev.seq} ${ev.type}`);
    return viewFields(view);
  });
}

const usage = (milestoneId, input, output) => ['agent_usage', {
  agent: 'dwight', instanceId: `dwight-${milestoneId ?? 'x'}`, ...(milestoneId ? { milestoneId } : {}), usage: { input, output, cost: 0.01 },
}];

test('both reducers count milestone tokens live and drop the check on retry', () => {
  const e = journal();
  const list = [
    ['run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 12, maxStalledCycles: 1, milestoneTokenBudget: 500000 }],
    ['plan_ready', { milestones: [{ id: 'm1', title: 'Auth' }, { id: 'm2', title: 'Docs', dependsOn: ['m1'] }] }],
    ['milestone_started', { milestoneId: 'm1', title: 'Auth', index: 0, total: 2 }],
    usage('m1', 1000, 200),
    // an agent_usage without milestoneId counts for the run, never for a milestone
    usage(null, 50, 5),
    ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Tests failed' }],
    check({ tokens: 1200, maxStalledCycles: 1 }),
    usage('m1', 300, 100),
    ['cycle_result', { milestoneId: 'm1', cycle: 2, result: 'failed', failedCycles: 2, reason: 'Tests failed' }],
    check({ cycle: 2, verdict: 'stalled', source: 'rule', rule: 'repeat', reason: 'Same failure.', stalledCycles: 1, maxStalledCycles: 1, tokens: 1600 }),
    ['circuit_breaker', { milestoneId: 'm1', state: 'tripped', cause: 'stalled', failedCycles: 2, maxFailedCycles: 12, stalledCycles: 1, maxStalledCycles: 1, tokens: 1600, tokenBudget: 500000 }],
    ['hitl_request', { milestoneId: 'm1', reason: 'No progress on m1', options: ['feedback', 'retry', 'skip', 'abort'] }],
    ['hitl_response', { milestoneId: 'm1', decision: 'retry' }],
    // what the orchestrator's resetWindow emits
    ['circuit_breaker', { milestoneId: 'm1', state: 'reset', failedCycles: 0, maxFailedCycles: 12, stalledCycles: 0, maxStalledCycles: 1, tokens: 0, tokenBudget: 500000 }],
    usage('m1', 70, 30),
    ['milestone_finished', { milestoneId: 'm1', status: 'passed' }],
  ];
  const steps = replayBoth(list.map(([type, fields]) => e(type, fields)));
  // from plan_ready on
  const planned = steps.slice(1);
  const m1 = planned.map((x) => x[0]);
  assert.deepEqual(m1.map((m) => m.tokens), [0, 0, 1200, 1200, 1200, 1200, 1600, 1600, 1600, 1600, 1600, 0, 0, 100, 100]);
  assert.deepEqual([m1[5].check.tokens, m1[6].check.tokens], [1200, 1600], 'the last check follows the live count');
  assert.equal(m1[10].check.verdict, 'stalled');
  assert.deepEqual(m1.slice(11).map((m) => m.check), [null, null, null, null], 'retry drops the check');
  assert.ok(planned.every((x) => x[1].tokens === 0 && x[1].check === null), 'm2 never ran');
});

test('both reducers: feedback drops the check, skip keeps it unless the breaker resets', () => {
  const e = journal();
  const base = [
    ['run_started', { request: 'Build', workspace: 'C:\\w', maxFailedCycles: 12, maxStalledCycles: 2, milestoneTokenBudget: 0 }],
    ['plan_ready', { milestones: [{ id: 'm1', title: 'Auth' }, { id: 'm2', title: 'CLI' }] }],
    ['milestone_started', { milestoneId: 'm1', title: 'Auth', index: 0, total: 2 }],
    ['milestone_started', { milestoneId: 'm2', title: 'CLI', index: 1, total: 2 }],
    usage('m1', 400, 100),
    usage('m2', 900, 100),
    check({ milestoneId: 'm1', tokens: 500, tokenBudget: 0 }),
    check({ milestoneId: 'm2', tokens: 1000, tokenBudget: 0 }),
    ['hitl_request', { milestoneId: 'm1', reason: 'r', options: ['feedback', 'skip'] }],
  ];
  const feedback = replayBoth([...base, ['hitl_response', { milestoneId: 'm1', decision: 'feedback', feedback: 'Use the cache.' }]].map(([t, f]) => e(t, f))).at(-1);
  assert.deepEqual(feedback.map((m) => [m.id, m.tokens, m.check?.tokens ?? null]), [['m1', 0, null], ['m2', 1000, 1000]], 'only the answered milestone starts over');
  const f = journal();
  const skip = replayBoth([...base, ['hitl_response', { milestoneId: 'm1', decision: 'skip' }]].map(([t, x]) => f(t, x))).at(-1);
  assert.deepEqual(skip.map((m) => [m.id, m.tokens, m.check?.tokens ?? null]), [['m1', 500, 500], ['m2', 1000, 1000]]);
  // skip after a trip: the orchestrator's resetWindow emits a reset, which drops the check
  const g = journal();
  const tripped = replayBoth([
    ...base.slice(0, -1),
    ['circuit_breaker', { milestoneId: 'm1', state: 'tripped', cause: 'stalled', failedCycles: 2, maxFailedCycles: 12, stalledCycles: 2, maxStalledCycles: 2, tokens: 500, tokenBudget: 0 }],
    base.at(-1),
    ['hitl_response', { milestoneId: 'm1', decision: 'skip' }],
    ['circuit_breaker', { milestoneId: 'm1', state: 'reset', failedCycles: 0, maxFailedCycles: 12, stalledCycles: 0, maxStalledCycles: 2, tokens: 0, tokenBudget: 0 }],
    ['milestone_finished', { milestoneId: 'm1', status: 'skipped' }],
  ].map(([t, x]) => g(t, x))).at(-1);
  assert.deepEqual(tripped.map((m) => [m.id, m.tokens, m.check?.tokens ?? null]), [['m1', 0, null], ['m2', 1000, 1000]], 'the reset drops only m1\'s check');
});

test('both reducers: an older stream without milestoneId on agent_usage counts no milestone tokens', () => {
  const { e, events } = failedOnce(false);
  const steps = replayBoth([
    ...events,
    e(...usage(null, 1000, 200)),
    e('agent_usage', { agent: 'dwight', usage: { input: -5, output: 'lots' } }),
    e('circuit_breaker', { milestoneId: 'm1', state: 'tripped', failedCycles: 3, maxFailedCycles: 3 }),
    e('hitl_response', { milestoneId: 'm1', decision: 'retry' }),
  ]);
  assert.ok(steps.every((x) => x.every((m) => m.tokens === 0 && m.check === null)));
});
