import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_HEADERS, BASE_TITLE, HUMAN_TITLE, SENT_STALE_MS, EXIT_SETTLE_MS, NOTIFY_MAX_AGE_MS,
  parseControl, isAbsolutePath, buildRunRequest, buildHitlRequest, responseError, answeredInState, sentSettled,
  hitlPhase, exitToShow, exitSettleLeft, exitKey, notificationFor, documentTitle, humanWhere,
  exitOwner, runGone, sentOutcome, hitlAnnouncement, errorField, controlGates, openPending,
} from '../../visualizer/public/js/control.js';
import { createState, reduceAll } from '../../visualizer/public/js/state.js';

const SCENARIOS = ['happy', 'flaky', 'breaker', 'blocked'];
const RUN = { pid: 42, mode: 'demo', request: 'Demo', workspace: 'C:\\ws', startedAt: '2026-07-12T12:00:00.000Z', runId: 'r1', exitCode: null };
const PENDING = { runId: 'r1', requestSeq: 7, milestoneId: 'm1', reason: 'Breaker tripped', options: ['feedback', 'retry', 'skip', 'abort'] };

function doc(fields = {}) {
  return { v: 1, enabled: true, workspace: 'C:\\Users\\me\\ws', scenarios: SCENARIOS, run: null, lastExit: null, pendingHuman: null, ...fields };
}

test('the POST headers are the ones the control routes require', () => {
  assert.deepEqual(CONTROL_HEADERS, { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' });
});

test('parseControl: anything but an enabled document is disabled', () => {
  for (const bad of [null, undefined, 'x', 404, {}, { v: 1, enabled: false }, { enabled: 'true' }]) {
    assert.equal(parseControl(bad).enabled, false, JSON.stringify(bad));
  }
  const c = parseControl(doc());
  assert.equal(c.enabled, true);
  assert.equal(c.workspace, 'C:\\Users\\me\\ws');
  assert.deepEqual(c.scenarios, SCENARIOS);
  assert.equal(c.run, null);
});

test('parseControl: pendingHuman only counts while a run is alive, with known options only', () => {
  assert.equal(parseControl(doc({ pendingHuman: PENDING })).pendingHuman, null);
  const c = parseControl(doc({ run: RUN, pendingHuman: { ...PENDING, options: ['retry', 'explode', 'abort'] } }));
  assert.deepEqual(c.pendingHuman.options, ['retry', 'abort']);
  assert.equal(c.pendingHuman.requestSeq, 7);
  assert.equal(parseControl(doc({ run: RUN, pendingHuman: { ...PENDING, requestSeq: '7' } })).pendingHuman, null);
});

test('parseControl strips bidi controls from server text that is shown', () => {
  const c = parseControl(doc({ run: RUN, pendingHuman: { ...PENDING, reason: 'npm test \u202Etxt.exe' }, lastExit: { mode: 'run', request: 'r', exitCode: 1, finishedAt: 'x', outputTail: 'a\u2066b' } }));
  assert.equal(c.pendingHuman.reason, 'npm test txt.exe');
  assert.equal(c.lastExit.outputTail, 'ab');
});

test('absolute paths: Windows drive, UNC and POSIX', () => {
  for (const p of ['C:\\ws', 'c:/ws', '\\\\server\\share', '/home/me/ws']) assert.equal(isAbsolutePath(p), true, p);
  for (const p of ['ws', '.\\ws', 'C:ws', '~/ws', '']) assert.equal(isAbsolutePath(p), false, p);
});

test('buildRunRequest: a plain run sends the trimmed request and only the fields that were set', () => {
  const c = parseControl(doc());
  assert.deepEqual(buildRunRequest({ request: '  Build it  ', workspace: '', maxCycles: '', noPlan: false, demo: false }, c), { body: { request: 'Build it' } });
  assert.deepEqual(buildRunRequest({ request: 'x', workspace: ' D:\\w ', maxCycles: '5', noPlan: true }, c),
    { body: { request: 'x', workspace: 'D:\\w', maxCycles: 5, noPlan: true } });
});

test('buildRunRequest: validation names the field', () => {
  const c = parseControl(doc());
  assert.equal(buildRunRequest({ request: '   ' }, c).field, 'request');
  assert.equal(buildRunRequest({ request: 'x'.repeat(4001) }, c).field, 'request');
  assert.ok(buildRunRequest({ request: 'x'.repeat(4000) }, c).body);
  assert.equal(buildRunRequest({ request: 'x', workspace: 'relative\\ws' }, c).field, 'workspace');
  for (const bad of ['0', '11', '2.5', '-1', 'three']) assert.equal(buildRunRequest({ request: 'x', maxCycles: bad }, c).field, 'maxCycles', bad);
  assert.equal(buildRunRequest({ request: 'x', maxCycles: '10' }, c).body.maxCycles, 10);
});

test('buildRunRequest: a demo needs no request but a known scenario and a sane delay', () => {
  const c = parseControl(doc());
  assert.deepEqual(buildRunRequest({ request: '', demo: true, scenario: 'breaker', delayMs: '250' }, c), { body: { demo: { scenario: 'breaker', delayMs: 250 } } });
  assert.deepEqual(buildRunRequest({ request: 'Mine', demo: true, scenario: 'happy', delayMs: '' }, c), { body: { request: 'Mine', demo: { scenario: 'happy' } } });
  assert.equal(buildRunRequest({ demo: true, scenario: 'nope' }, c).field, 'scenario');
  assert.equal(buildRunRequest({ demo: true, scenario: 'happy', delayMs: '5001' }, c).field, 'delayMs');
  // scenario fields are ignored when demo is off
  assert.deepEqual(buildRunRequest({ request: 'x', demo: false, scenario: 'nope', delayMs: 'bad' }, c), { body: { request: 'x' } });
});

test('buildHitlRequest: decision must be offered; feedback needs text within 8000 chars', () => {
  assert.ok(buildHitlRequest({ decision: 'retry' }, null).error);
  assert.deepEqual(buildHitlRequest({ decision: 'retry', feedback: 'ignored' }, PENDING), { body: { decision: 'retry' } });
  assert.ok(buildHitlRequest({ decision: 'skip' }, { ...PENDING, options: ['retry', 'abort'] }).error);
  assert.equal(buildHitlRequest({ decision: 'feedback', feedback: '  ' }, PENDING).field, 'feedback');
  assert.equal(buildHitlRequest({ decision: 'feedback', feedback: 'x'.repeat(8001) }, PENDING).field, 'feedback');
  assert.deepEqual(buildHitlRequest({ decision: 'feedback', feedback: ' Use a state machine ' }, PENDING), { body: { decision: 'feedback', feedback: 'Use a state machine' } });
});

test('responseError prefers the server message', () => {
  assert.equal(responseError(409, { error: 'A run is alive' }), 'A run is alive');
  assert.match(responseError(409, null), /Conflict/);
  assert.match(responseError(400, {}), /rejected/);
  assert.match(responseError(415, null), /415/);
  assert.match(responseError(500, 'x'), /HTTP 500/);
});

test('hitl phase: answer -> sent -> stale, and back to answer for a new request', () => {
  const sent = { runId: 'r1', requestSeq: 7, decision: 'retry', at: 1000 };
  assert.equal(hitlPhase({ pending: null }), 'none');
  assert.equal(hitlPhase({ pending: PENDING }), 'answer');
  assert.equal(hitlPhase({ pending: PENDING, sent, now: 2000 }), 'sent');
  assert.equal(hitlPhase({ pending: PENDING, sent, now: 1000 + SENT_STALE_MS }), 'stale');
  // the server already dropped it, the hitl_response is not here yet
  assert.equal(hitlPhase({ pending: null, sent, now: 1000 + SENT_STALE_MS }), 'sent');
  assert.equal(hitlPhase({ pending: { ...PENDING, requestSeq: 20 }, sent, now: 2000 }), 'answer');
});

test('a sent answer settles on hitl_response, a dead run or a different request', () => {
  const sent = { runId: 'r1', requestSeq: 7, decision: 'retry', at: 0 };
  assert.equal(sentSettled({ sent: null }), true);
  assert.equal(sentSettled({ sent, pending: PENDING, answered: false, alive: true }), false);
  assert.equal(sentSettled({ sent, pending: null, answered: false, alive: true }), false);
  assert.equal(sentSettled({ sent, pending: PENDING, answered: true, alive: true }), true);
  assert.equal(sentSettled({ sent, pending: null, answered: false, alive: false }), true);
  assert.equal(sentSettled({ sent, pending: { ...PENDING, requestSeq: 9 }, answered: false, alive: true }), true);
});

function maker(runId) {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 6, 12, 12, 0, seq)).toISOString(), runId, type, ...fields });
}

test('answeredInState follows the reducer: open after hitl_request, answered after hitl_response', () => {
  const e = maker('r1');
  const events = [e('run_started', { request: 'x', workspace: 'C:\\w', maxFailedCycles: 3 }), e('hitl_request', { milestoneId: null, reason: 'r', options: ['retry'] })];
  const sent = { runId: 'r1', requestSeq: 2, decision: 'retry', at: 0 };
  assert.equal(answeredInState(createState(), sent), false, 'stream has not reached the request yet');
  const open = reduceAll(events);
  assert.equal(answeredInState(open, sent), false);
  const answered = reduceAll([e('hitl_response', { milestoneId: null, decision: 'retry' })], open);
  assert.equal(answeredInState(answered, sent), true);
  assert.equal(answeredInState(answered, { ...sent, runId: 'r0' }), false);
  assert.equal(answeredInState(answered, null), false);
});

test('a pending request the event stream already shows answered is not offered again', () => {
  const e = maker('r1');
  const open = reduceAll([e('run_started', { request: 'x', workspace: 'C:\\w', maxFailedCycles: 3 }), e('hitl_request', { milestoneId: null, reason: 'r', options: ['retry'] })]);
  const c = parseControl(doc({ run: RUN, pendingHuman: { ...PENDING, requestSeq: 2 } }));
  assert.equal(openPending(c, open), c.pendingHuman);
  assert.equal(openPending(c, createState()), c.pendingHuman, 'stream behind the poll');
  // the poll that clears pendingHuman is still on its way
  const answered = reduceAll([e('hitl_response', { milestoneId: null, decision: 'retry' })], open);
  assert.equal(openPending(c, answered), null);
  const sent = { runId: 'r1', requestSeq: 2, decision: 'retry', at: 0 };
  const pending = openPending(c, answered);
  const outcome = sentOutcome({ sent, pending, answered: answeredInState(answered, sent), alive: true });
  assert.equal(hitlPhase({ pending, sent: null }), 'none');
  assert.equal(hitlAnnouncement({ prev: 'sent', next: 'none', outcome, decision: 'retry' }).text, 'Answer received - the run continues');
});

test('exit output shows only for a non-zero exit without its own run_finished', () => {
  const now = Date.parse('2026-07-12T12:10:00.000Z');
  const le = { mode: 'run', request: 'x', exitCode: 1, finishedAt: '2026-07-12T12:05:00.000Z', outputTail: 'No API key found' };
  const c = (fields) => parseControl(doc({ lastExit: le, ...fields }));
  const blank = createState();
  assert.equal(exitToShow(c(), blank, null, now)?.exitCode, 1, 'exited before any event');
  assert.equal(exitToShow(c({ run: RUN }), blank, null, now), null, 'a run is alive again');
  assert.equal(exitToShow(c({ lastExit: { ...le, exitCode: 0 } }), blank, null, now), null);
  assert.equal(exitToShow(c({ lastExit: { ...le, outputTail: ' \n' } }), blank, null, now), null);
  assert.equal(exitToShow(c(), blank, exitKey(parseControl(doc({ lastExit: le })).lastExit), now), null, 'dismissed');
  const inRun = { ...blank, runId: 'r1', status: 'paused', result: null };
  assert.ok(exitToShow(c(), inRun, null, now), 'died mid-run');
  const own = { ...blank, runId: 'r1', result: 'partial', finishedAt: '2026-07-12T12:04:59.500Z' };
  assert.equal(exitToShow(c(), own, null, now), null, 'exit 1 after its own run_finished(partial)');
  const earlier = { ...own, finishedAt: '2026-07-12T11:00:00.000Z' };
  assert.ok(exitToShow(c(), earlier, null, now), 'the shown run_finished belongs to an earlier run');
  assert.equal(exitToShow(parseControl({ enabled: false }), blank, null, now), null);
});

test('an exit older than the run on screen is not shown for it', () => {
  const now = Date.parse('2026-07-12T12:10:00.000Z');
  const le = { mode: 'run', request: 'x', exitCode: 1, finishedAt: '2026-07-12T12:05:00.000Z', outputTail: 'Run partial' };
  const c = (fields = {}) => parseControl(doc({ lastExit: { ...le, ...fields } }));
  const later = { ...createState(), runId: 'r2', status: 'paused', result: null, startedAt: '2026-07-12T12:06:00.000Z' };
  assert.equal(exitOwner(c().lastExit, later), 'earlier');
  assert.equal(exitToShow(c(), later, null, now), null, 'a terminal run started after the UI run exited');
  const own = { ...later, startedAt: '2026-07-12T12:01:00.000Z' };
  assert.equal(exitOwner(c().lastExit, own), 'run');
  assert.ok(exitToShow(c(), own, null, now), 'the run on screen died mid-run');
  // the server may name the run and the spawn time
  assert.equal(exitToShow(c({ runId: 'r1' }), own, null, now), null, 'another run id');
  assert.ok(exitToShow(c({ runId: 'r2' }), later, null, now), 'same run id wins over clock skew');
  assert.equal(exitOwner(c({ startedAt: '2026-07-12T12:02:00.000Z' }).lastExit, own), 'later', 'the child never published a run');
  assert.ok(exitToShow(c({ startedAt: '2026-07-12T12:02:00.000Z' }), own, null, now), 'its output is still the latest news');
  assert.equal(exitOwner(c().lastExit, createState()), 'none');
});

test('the run process is gone: derived from /api/control, not from the exit panel', () => {
  const s = { ...createState(), runId: 'r1', status: 'paused', hitl: { reason: 'Breaker' }, result: null, startedAt: '2026-07-12T12:00:00.000Z' };
  const le = { mode: 'demo', request: '', exitCode: 1, finishedAt: '2026-07-12T12:05:00.000Z', outputTail: '' };
  const c = (fields) => parseControl(doc(fields));
  assert.equal(runGone(c({ lastExit: le }), s), true, 'empty output tail, nothing to show, still gone');
  assert.equal(exitToShow(c({ lastExit: le }), s), null);
  assert.equal(runGone(c({ lastExit: { ...le, outputTail: 'x' } }), s), true, 'also while the exit settles or is dismissed');
  assert.equal(runGone(c({ lastExit: le, run: RUN }), s), false, 'its process is alive');
  assert.equal(runGone(c({ lastExit: le, run: { ...RUN, runId: null } }), s), true, 'a new process, the old run still on screen');
  assert.equal(runGone(c({ lastExit: { ...le, finishedAt: '2026-07-12T11:59:00.000Z' } }), s), false, 'a terminal run after the UI run');
  assert.equal(runGone(c({ lastExit: null }), s), false, 'not started by this server');
  assert.equal(runGone(c({ lastExit: le }), { ...s, result: 'aborted' }), false, 'it finished');
  assert.equal(runGone(parseControl({ enabled: false }), s), false);
  // never claim a human is needed for a run nobody can answer
  assert.equal(humanWhere({ enabled: true, alive: false, gone: true }), 'exited');
  assert.equal(humanWhere({ enabled: true, alive: true, gone: true }), 'exited');
  assert.equal(documentTitle({ enabled: true, pending: false, live: true, hitl: true, gone: true }), BASE_TITLE);
});

test('a settled answer announces what actually happened', () => {
  const sent = { runId: 'r1', requestSeq: 7, decision: 'retry', at: 0 };
  assert.equal(sentOutcome({ sent, pending: PENDING, answered: true, alive: true }), 'answered');
  assert.equal(sentOutcome({ sent, pending: null, answered: false, alive: false }), 'gone');
  assert.equal(sentOutcome({ sent, pending: { ...PENDING, requestSeq: 9 }, answered: false, alive: true }), 'superseded');
  assert.equal(sentOutcome({ sent, pending: null, answered: false, alive: true }), null);
  const settle = (outcome, decision, result = null) => hitlAnnouncement({ prev: 'sent', next: 'none', outcome, decision, result });
  assert.equal(settle('answered', 'retry').text, 'Answer received - the run continues');
  assert.equal(settle('answered', 'feedback').text, 'Answer received - the run continues');
  assert.equal(settle('answered', 'skip').text, 'Answer received - skipping the milestone');
  assert.equal(settle('answered', 'abort').text, 'Answer received - the run is aborting');
  assert.equal(settle('gone', 'retry').text, 'The run process exited before the answer was applied');
  assert.equal(settle('gone', 'abort', 'aborted').text, 'Run aborted');
  assert.equal(settle('gone', 'abort').text, 'The run process exited after the abort');
  assert.equal(settle('answered', 'retry').focus, false);
  assert.equal(hitlAnnouncement({ prev: 'none', next: 'none', outcome: null }), null);
});

test('a new request is announced and focused, also right after an answer', () => {
  const reason = 'Breaker   tripped\nagain';
  const first = hitlAnnouncement({ prev: 'none', next: 'answer', fresh: true, pending: { ...PENDING, reason }, outcome: null });
  assert.deepEqual(first, { text: 'Human input required: Breaker tripped again', focus: true });
  for (const [prev, outcome] of [['sent', 'superseded'], ['stale', 'superseded'], ['none', 'answered']]) {
    const a = hitlAnnouncement({ prev, next: 'answer', fresh: true, pending: PENDING, outcome });
    assert.equal(a?.focus, true, prev);
    assert.match(a.text, /Human input required: Breaker tripped/, prev);
  }
  assert.equal(hitlAnnouncement({ prev: 'answer', next: 'answer', fresh: false, pending: PENDING, outcome: null }), null, 'same request, next poll');
  // "Answer again" after a stale answer moves focus itself
  assert.equal(hitlAnnouncement({ prev: 'stale', next: 'answer', fresh: true, pending: PENDING, outcome: null }), null);
  assert.match(hitlAnnouncement({ prev: 'answer', next: 'answer', fresh: true, pending: PENDING, outcome: null }).text, /Human input required/, 'answered elsewhere, asked again');
});

test('a server 400 points at the field it names, in any case', () => {
  assert.equal(errorField('Workspace must be absolute'), 'workspace');
  assert.equal(errorField('Invalid request'), 'request');
  assert.equal(errorField('Invalid maxCycles'), 'maxCycles');
  assert.equal(errorField('invalid DELAYMS'), 'delayMs');
  assert.equal(errorField('Invalid noPlan'), null);
  assert.equal(errorField(undefined), null);
});

test('control gates: start once, stop once, answer once, nothing in demo mode', () => {
  const idle = parseControl(doc());
  const alive = parseControl(doc({ run: RUN, pendingHuman: PENDING }));
  assert.deepEqual(controlGates({ control: idle, mode: 'live' }), { on: true, alive: false, recovery: false, canStart: true, canStop: false, canStopOrphan: false, canAnswer: false });
  assert.equal(controlGates({ control: idle, mode: 'live', submitting: true }).canStart, false, 'double submit');
  assert.equal(controlGates({ control: alive, mode: 'live' }).canStart, false, 'a run is alive');
  assert.equal(controlGates({ control: alive, mode: 'live' }).canStop, true);
  assert.equal(controlGates({ control: alive, mode: 'live', stopping: true }).canStop, false, 'double stop');
  assert.equal(controlGates({ control: alive, mode: 'live' }).canAnswer, true);
  assert.equal(controlGates({ control: alive, mode: 'live', sending: true }).canAnswer, false, 'double answer');
  assert.deepEqual(controlGates({ control: alive, mode: 'demo' }), { on: false, alive: false, recovery: false, canStart: false, canStop: false, canStopOrphan: false, canAnswer: false });
  assert.equal(controlGates({ control: parseControl(null), mode: 'live' }).on, false);
});

test('a fresh exit waits for the event stream before it is shown', () => {
  const finishedAt = '2026-07-12T12:05:00.000Z';
  const t = Date.parse(finishedAt);
  const c = parseControl(doc({ lastExit: { mode: 'demo', request: '', exitCode: 130, finishedAt, outputTail: 'interrupted' } }));
  assert.equal(exitToShow(c, createState(), null, t + 200), null);
  assert.equal(exitSettleLeft(c.lastExit, t + 200), EXIT_SETTLE_MS - 200);
  assert.ok(exitToShow(c, createState(), null, t + EXIT_SETTLE_MS));
  assert.equal(exitSettleLeft({ finishedAt: 'bad' }, t), 0);
});

test('notifications: live, not replayed, recent, and only for the human and the finish', () => {
  const now = Date.parse('2026-07-12T12:00:10.000Z');
  const hitl = { v: 1, seq: 5, ts: '2026-07-12T12:00:09.000Z', runId: 'r1', type: 'hitl_request', reason: 'Breaker tripped\nmore', options: [] };
  assert.deepEqual(notificationFor(hitl, { live: true, instant: false, now }), { title: 'Human needed', body: 'Breaker tripped', tag: 'r1:5' });
  assert.equal(notificationFor(hitl, { live: false, instant: false, now }), null, 'demo mode');
  assert.equal(notificationFor(hitl, { live: true, instant: true, now }), null, 'replay after connect');
  assert.equal(notificationFor(hitl, { live: true, instant: false, now: now + NOTIFY_MAX_AGE_MS + 1000 }), null, 'old event');
  const fin = { ...hitl, seq: 9, type: 'run_finished', status: 'success', summary: 'All 3 milestones passed' };
  assert.deepEqual(notificationFor(fin, { live: true, instant: false, now }), { title: 'Run finished - success', body: 'All 3 milestones passed', tag: 'r1:9' });
  assert.equal(notificationFor({ ...hitl, type: 'agent_status' }, { live: true, instant: false, now }), null);
  assert.equal(notificationFor({ ...hitl, reason: '' }, { live: true, instant: false, now }).body, 'The orchestrator is waiting for a decision.');
});

test('document title flags a pending human only with control enabled', () => {
  assert.equal(documentTitle({ enabled: false, pending: true, live: true, hitl: true }), BASE_TITLE);
  assert.equal(documentTitle({ enabled: true, pending: true, live: false, hitl: false }), HUMAN_TITLE);
  assert.equal(documentTitle({ enabled: true, pending: false, live: true, hitl: true }), HUMAN_TITLE);
  assert.equal(documentTitle({ enabled: true, pending: false, live: false, hitl: true }), BASE_TITLE);
  assert.equal(HUMAN_TITLE, '● Human needed - Scranton');
});

test('the alert sends the human to the panel, the terminal, or says the process is gone', () => {
  assert.equal(humanWhere({ enabled: false, alive: true, gone: true }), 'terminal');
  assert.equal(humanWhere({ enabled: true, alive: true, gone: false }), 'here');
  assert.equal(humanWhere({ enabled: true, alive: false, gone: true }), 'exited');
  assert.equal(humanWhere({ enabled: true, alive: false, gone: false }), 'terminal');
});
