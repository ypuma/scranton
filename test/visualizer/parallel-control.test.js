import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseControl, buildRunRequest, errorField, controlGates, exitHint, runModeOf, executionDefaults, EXECUTION_DEFAULTS,
} from '../../visualizer/public/js/control.js';
import {
  chatRecipients, buildChatRequest, transcript, pruneOutbox, outboxStale, deliveryNews, composerBlock, matchOutbox, CHAT_MAX, OUTBOX_STALE_MS,
} from '../../visualizer/public/js/chat.js';
import { reduceAll } from '../../visualizer/public/js/state.js';

const RUN = { pid: 42, mode: 'run', request: 'Todo', workspace: 'C:\\ws', startedAt: '2026-11-08T12:00:00.000Z', runId: 'r1', exitCode: null };
const DEFAULTS = { execution: { maxParallel: 4, isolation: 'worktree', sandbox: { mode: 'docker', image: 'scranton-sandbox:1.5.0-r2', network: 'none' } } };

function doc(fields = {}) {
  return { v: 1, enabled: true, workspace: 'C:\\ws', scenarios: ['happy'], run: null, lastExit: null, pendingHuman: null, ...fields };
}

const form = (fields = {}) => ({ request: 'Build it', workspace: '', maxCycles: '', noPlan: false, demo: false, maxParallel: '3', sandbox: 'docker', trustedHost: false, sandboxImage: '', sandboxNetwork: 'bridge', ...fields });

function maker(runId) {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 8, 12, 0, seq)).toISOString(), runId, type, ...fields });
}

function liveState() {
  const e = maker('r1');
  return reduceAll([
    e('run_started', { request: 'Todo', workspace: 'C:\\ws', maxFailedCycles: 3 }),
    e('instance_started', { id: 'michael', instanceId: 'michael', agent: 'michael', milestoneId: null }),
    e('agent_status', { agent: 'michael', instanceId: 'michael', status: 'idle', activity: 'Idle' }),
    e('instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Coding' }),
    e('instance_started', { id: 'dwight-m2', instanceId: 'dwight-m2', agent: 'dwight', milestoneId: 'm2' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m2', status: 'done', activity: 'Done' }),
  ]);
}

test('parseControl reads defaults.execution, instances and recovery', () => {
  const c = parseControl(doc({
    defaults: DEFAULTS,
    instances: { 'dwight-m1': { id: 'dwight-m1', agent: 'dwight', milestoneId: 'm1', status: 'working', sessionId: 's\u202E1' }, bad: 'x' },
    recoveryRequired: true, orphan: { runId: 'old-run', startedAt: '2026-11-08T11:00:00.000Z' },
  }));
  assert.equal(c.execution.maxParallel, 4);
  assert.equal(c.execution.sandbox.network, 'none');
  assert.deepEqual(Object.keys(c.instances), ['dwight-m1']);
  assert.equal(c.instances['dwight-m1'].sessionId, 's1', 'server text is scrubbed');
  assert.equal(c.recoveryRequired, true);
  // a server without the owner fields: no owner status, so no release (orphan-recovery-contract.md section 14)
  assert.deepEqual(c.orphan, {
    runId: 'old-run', startedAt: '2026-11-08T11:00:00.000Z', owner: null, heartbeatAt: null, stopRequestedAt: null, recoveryError: null,
  });
  // a live run of this server is never an orphan, whatever the flag says
  assert.equal(parseControl(doc({ run: RUN, recoveryRequired: true })).recoveryRequired, false);
  assert.equal(parseControl(doc({ defaults: { ...DEFAULTS, configurationError: 'maxParallel > 1 needs worktree\u202E isolation' } })).configurationError,
    'maxParallel > 1 needs worktree isolation');
  const old = parseControl(doc());
  assert.equal(old.execution, null);
  assert.equal(old.configurationError, null);
  assert.equal(old.recoveryRequired, false);
  assert.deepEqual(old.instances, {});
  assert.equal(parseControl(null).recoveryRequired, false);
});

test('executionDefaults: the server defaults, else the engine defaults', () => {
  assert.deepEqual(executionDefaults(parseControl(doc({ defaults: DEFAULTS }))), { maxParallel: 4, sandbox: 'docker', image: 'scranton-sandbox:1.5.0-r2', network: 'none' });
  assert.deepEqual(executionDefaults(parseControl(doc())), { maxParallel: 3, sandbox: 'docker', image: EXECUTION_DEFAULTS.sandbox.image, network: 'bridge' });
});

test('buildRunRequest: parallelism and the docker sandbox by default', () => {
  const c = parseControl(doc());
  assert.deepEqual(buildRunRequest(form(), c), { body: { request: 'Build it', maxParallel: 3, sandbox: 'docker', conversation: true } });
  assert.deepEqual(buildRunRequest(form({ sandboxImage: ' my/img:2 ', sandboxNetwork: 'none' }), c).body,
    { request: 'Build it', maxParallel: 3, sandbox: 'docker', sandboxImage: 'my/img:2', sandboxNetwork: 'none', conversation: true });
  assert.equal(buildRunRequest(form({ maxParallel: '' }), c).body.maxParallel, undefined, 'empty leaves the engine default');
  for (const bad of ['0', '33', '1.5', 'x']) assert.equal(buildRunRequest(form({ maxParallel: bad }), c).field, 'maxParallel', bad);
  assert.equal(buildRunRequest(form({ maxParallel: '32' }), c).body.maxParallel, 32);
  assert.equal(buildRunRequest(form({ sandboxImage: '-rm -rf' }), c).field, 'sandboxImage');
  assert.equal(buildRunRequest(form({ sandboxNetwork: 'host' }), c).field, 'sandboxNetwork');
  assert.equal(buildRunRequest(form({ sandbox: 'vm' }), c).field, 'sandbox');
  // an older form without a sandbox choice sends none
  assert.deepEqual(buildRunRequest({ request: 'x' }, c), { body: { request: 'x', conversation: true } });
});

test('buildRunRequest: trusted host needs the explicit confirmation and drops docker options', () => {
  const c = parseControl(doc());
  assert.deepEqual(buildRunRequest(form({ sandbox: 'host' }), c), {
    error: 'Confirm that the agents may run commands directly on this computer, or pick the Docker sandbox.', field: 'trustedHost',
  });
  assert.deepEqual(buildRunRequest(form({ sandbox: 'host', trustedHost: 'true' }), c).field, 'trustedHost', 'only a real true counts');
  assert.deepEqual(buildRunRequest(form({ sandbox: 'host', trustedHost: true, sandboxImage: 'x:1', sandboxNetwork: 'none' }), c).body,
    { request: 'Build it', maxParallel: 3, sandbox: 'host', trustedHost: true, conversation: true });
});

test('buildRunRequest: a demo never sends sandbox fields, so it cannot look sandboxed', () => {
  const c = parseControl(doc());
  const r = buildRunRequest(form({ demo: true, request: '', scenario: 'happy', delayMs: '', sandbox: 'host', trustedHost: true }), c);
  assert.deepEqual(r.body, { maxParallel: 3, demo: { scenario: 'happy' }, conversation: true });
});

test('errorField maps the server execution messages onto their inputs', () => {
  assert.equal(errorField('maxParallel must be an integer from 1 to 32'), 'maxParallel');
  assert.equal(errorField('Host execution requires trustedHost:true'), 'trustedHost');
  assert.equal(errorField('trustedHost conflicts with docker sandbox'), 'trustedHost');
  assert.equal(errorField('Invalid sandboxImage'), 'sandboxImage');
  assert.equal(errorField('Invalid sandboxNetwork'), 'sandboxNetwork');
  assert.equal(errorField('Invalid sandbox'), 'sandbox');
  assert.equal(errorField('Workspace must be absolute'), 'workspace');
});

test('control gates: an orphaned owner disables New run; a stop request needs its run id', () => {
  const orphan = parseControl(doc({ recoveryRequired: true, orphan: { runId: 'old', startedAt: null } }));
  const g = controlGates({ control: orphan, mode: 'live' });
  assert.equal(g.recovery, true);
  assert.equal(g.canStart, false);
  assert.equal(g.canStopOrphan, true);
  assert.equal(controlGates({ control: orphan, mode: 'live', stopping: true }).canStopOrphan, false);
  const unknown = parseControl(doc({ recoveryRequired: true }));
  assert.equal(controlGates({ control: unknown, mode: 'live' }).canStopOrphan, false, 'no id: nothing to stop blindly');
  assert.equal(controlGates({ control: unknown, mode: 'live' }).canStart, false);
  assert.equal(controlGates({ control: orphan, mode: 'demo' }).recovery, false);
});

test('exitHint names the missing prerequisite without claiming anything works', () => {
  assert.match(exitHint({ outputTail: 'error: docker: command not found' }), /scranton doctor/);
  assert.match(exitHint({ outputTail: 'Sandbox image scranton-sandbox:1.5.0-r2 not found' }), /trusted host/);
  assert.match(exitHint({ outputTail: 'Hive is owned by another run' }), /recover ownership/);
  assert.equal(exitHint({ outputTail: 'TypeError: x is undefined' }), '');
  assert.equal(exitHint(null), '');
});

test('runModeOf: only a run this server started says whether it is a demo', () => {
  const s = { runId: 'r1' };
  assert.equal(runModeOf(parseControl(doc({ run: { ...RUN, mode: 'demo' } })), s), 'demo');
  assert.equal(runModeOf(parseControl(doc({ lastExit: { runId: 'r1', mode: 'demo', exitCode: 0, outputTail: '' } })), s), 'demo');
  assert.equal(runModeOf(parseControl(doc({ run: { ...RUN, runId: 'other' } })), s), null);
  assert.equal(runModeOf(parseControl(null), s), null);
});

test('chatRecipients: live instances of the run on screen only', () => {
  const s = liveState();
  assert.deepEqual(chatRecipients(s, parseControl(doc({ run: RUN }))).map((r) => r.id), ['michael', 'dwight-m1']);
  // the control document adds an instance the stream has not shown yet, and can only end one, never revive it
  const c = parseControl(doc({ run: RUN, instances: {
    'angela-m1': { id: 'angela-m1', agent: 'angela', milestoneId: 'm1', status: 'thinking' },
    'dwight-m1': { id: 'dwight-m1', agent: 'dwight', status: 'finished' },
    'dwight-m2': { id: 'dwight-m2', agent: 'dwight', status: 'working' },
    'Bad Id': { id: 'Bad Id', status: 'working' },
  } }));
  assert.deepEqual(chatRecipients(s, c).map((r) => r.id), ['michael', 'angela-m1']);
  assert.deepEqual(chatRecipients(s, parseControl(doc({ run: { ...RUN, runId: 'other' }, instances: c.instances }))).map((r) => r.id), ['michael', 'dwight-m1']);
  assert.deepEqual(chatRecipients({ runId: null }, c), []);
});

test('buildChatRequest: an exact live recipient and bounded text', () => {
  const recipients = [{ id: 'dwight-m1', status: 'working' }];
  const ctx = { runId: 'r1', recipients };
  assert.deepEqual(buildChatRequest({ to: 'dwight-m1', text: '  Use todos.json  ' }, ctx), { body: { runId: 'r1', to: 'dwight-m1', text: 'Use todos.json' } });
  assert.equal(buildChatRequest({ to: 'dwight-m1', text: 'x' }, { recipients }).error, 'No run is in progress.');
  assert.equal(buildChatRequest({ to: '', text: 'x' }, ctx).field, 'to');
  assert.equal(buildChatRequest({ to: 'dwight', text: 'x' }, ctx).field, 'to', 'no role aliases');
  assert.equal(buildChatRequest({ to: 'angela-m1', text: 'x' }, ctx).field, 'to');
  assert.equal(buildChatRequest({ to: 'dwight-m1', text: '   ' }, ctx).field, 'text');
  assert.equal(buildChatRequest({ to: 'dwight-m1', text: 'x'.repeat(CHAT_MAX + 1) }, ctx).field, 'text');
  assert.ok(buildChatRequest({ to: 'dwight-m1', text: 'x'.repeat(CHAT_MAX) }, ctx).body);
});

test('outbox: a queued message shows until its chat_message arrives, and is only ever queued', () => {
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  const outbox = [
    { id: 'a', runId: 'r1', from: 'human', to: 'dwight-m1', text: 'hi', delivery: 'queued', sentAt: now },
    { id: 'b', runId: 'old', from: 'human', to: 'dwight-m1', text: 'old run', delivery: 'queued', sentAt: now },
  ];
  const state = { runId: 'r1', chat: [] };
  const t = transcript(state, outbox);
  assert.deepEqual(t.map((m) => [m.id, m.delivery, m.local]), [['a', 'queued', true]]);
  assert.equal(outboxStale(t[0], now + OUTBOX_STALE_MS - 1), false);
  assert.equal(outboxStale(t[0], now + OUTBOX_STALE_MS), true);
  const echoed = { runId: 'r1', chat: [{ id: 'a', from: 'human', to: 'dwight-m1', text: 'hi', delivery: 'delivered' }] };
  assert.deepEqual(pruneOutbox(outbox, echoed), []);
  assert.deepEqual(transcript(echoed, outbox).map((m) => [m.id, m.delivery, m.local ?? false]), [['a', 'delivered', false]]);
});

test('outbox: only the id POST /api/chat returned settles a queued copy, never a look-alike message', () => {
  const sent = (id) => ({ id, runId: 'r1', from: 'human', to: 'dwight-m1', text: 'same text', delivery: 'queued', sentAt: 0 });
  const other = { id: 'x0', seq: 3, from: 'human', to: 'dwight-m1', text: 'same text', delivery: 'delivered' };
  assert.deepEqual([...matchOutbox([sent('a')], { runId: 'r1', chat: [other] })], []);
  assert.deepEqual(transcript({ runId: 'r1', chat: [other] }, [sent('a')]).map((m) => m.id), ['x0', 'a']);
  const state = { runId: 'r1', chat: [other, { ...other, id: 'a', seq: 6 }] };
  assert.deepEqual([...matchOutbox([sent('a'), sent('b')], state)], ['a']);
  assert.deepEqual(pruneOutbox([sent('a'), sent('b')], state).map((o) => o.id), ['b']);
  assert.equal(matchOutbox([sent('a')], { ...state, runId: 'r2' }).size, 0, 'another run');
});

test('deliveryNews announces settled deliveries of own messages once', () => {
  const entries = [{ id: 'a', to: 'dwight-m1' }, { id: 'b', to: 'angela-m1', reason: 'Recipient completed before acknowledgement' }];
  const prev = new Map([['a', 'queued'], ['b', 'queued']]);
  assert.equal(deliveryNews(prev, new Map([['a', 'delivered'], ['b', 'rejected']]), entries),
    'Message to dwight-m1 delivered. Message to angela-m1 rejected: Recipient completed before acknowledgement');
  assert.equal(deliveryNews(new Map([['a', 'delivered']]), new Map([['a', 'delivered']]), entries), '');
  assert.equal(deliveryNews(new Map(), new Map([['a', 'queued']]), entries), '');
});

test('composerBlock says why messaging is off', () => {
  const base = { enabled: true, mode: 'live', alive: true, sameRun: true, recipients: [{ id: 'x' }] };
  assert.equal(composerBlock(base), '');
  assert.match(composerBlock({ ...base, mode: 'demo' }), /replay/);
  assert.match(composerBlock({ ...base, enabled: false }), /--control/);
  assert.match(composerBlock({ ...base, alive: false }), /No run/);
  assert.match(composerBlock({ ...base, sameRun: false }), /publish/);
  assert.match(composerBlock({ ...base, recipients: [] }), /No agent instance/);
});
