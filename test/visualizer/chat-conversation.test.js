// Conversation mode on the page (.enma/chat-view-contract.md sections 1, 2, 13.7 and 13.11): every run the page
// starts asks for it, the reducer keeps the reply exactly as the engine's state.json does, and the Events tab
// shows the two new events as one line each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRequest, parseControl } from '../../visualizer/public/js/control.js';
import { buildFollowUp } from '../../visualizer/public/js/scope.js';
import { createState, reduce, reduceAll, describe, totals } from '../../visualizer/public/js/state.js';
import { harness, CONTROL } from './fixtures/run-drawer.js';

const control = parseControl(CONTROL);
const RUN = 'run-c';
function events(list) {
  return list.map(([type, fields], i) => ({ v: 1, seq: i + 1, ts: new Date(Date.UTC(2026, 10, 11, 9, 0, i)).toISOString(), runId: RUN, type, ...fields }));
}
const START = ['run_started', { request: 'What does the CLI do?', workspace: 'C:\\ws', maxFailedCycles: 3, execution: { conversation: true } }];

test('every run request the page builds asks for a conversation: a real run, a follow-up and a demo', () => {
  assert.deepEqual(buildRunRequest({ request: 'Build it' }, control), { body: { request: 'Build it', conversation: true } });
  assert.equal(buildRunRequest({ request: 'Build it', maxParallel: '2', sandbox: 'docker', noPlan: true, workflow: { stages: { angela: 1 } } }, control).body.conversation, true);
  assert.deepEqual(buildRunRequest({ request: '', demo: true, scenario: 'happy', delayMs: '0' }, control), { body: { demo: { scenario: 'happy', delayMs: 0 }, conversation: true } });
  assert.deepEqual(buildFollowUp({ goal: 'And the flags?' }, control), { body: { request: 'And the flags?', conversation: true } });
  assert.equal(buildFollowUp({ goal: 'Next', execution: { sandbox: 'host', trustedHost: true }, models: { michael: { provider: 'openai', model: 'gpt-a' } } }, control).body.conversation, true);
  // a request that is refused is not sent at all
  assert.equal(buildRunRequest({ request: '   ' }, control).body, undefined);
  assert.equal(buildFollowUp({ goal: '' }, control).body, undefined);
});

test('the New run drawer and the follow-up composer post it: real, demo and follow-up bodies', async (t) => {
  const real = harness();
  // setMode('demo') stops the control poll, which would keep the process alive
  t.after(() => real.panel.setMode('demo'));
  await real.open();
  real.$('f-sandbox-host').checked = true;
  real.$('f-sandbox-docker').checked = false;
  real.$('f-trusted').checked = true;
  await real.$('run-form').fire('submit');
  assert.equal(real.posts.length, 1, real.$('run-error').textContent);
  assert.equal(real.posts[0].url, '/api/projects/core/chats/a/runs');
  assert.equal(real.posts[0].body.request, 'Build it');
  assert.equal(real.posts[0].body.conversation, true);

  const demo = harness();
  t.after(() => demo.panel.setMode('demo'));
  await demo.open();
  demo.$('f-request').value = '';
  demo.$('f-demo').checked = true;
  demo.$('f-scenario').value = 'happy';
  await demo.$('run-form').fire('submit');
  assert.equal(demo.posts.length, 1, demo.$('run-error').textContent);
  assert.deepEqual(demo.posts[0].body.demo.scenario, 'happy');
  assert.equal(demo.posts[0].body.conversation, true, 'a fake-pi demo is a conversation run too');

  const follow = harness();
  t.after(() => follow.panel.setMode('demo'));
  follow.panel.setMode('live');
  await follow.tick();
  follow.$('f-sandbox-host').checked = true;
  follow.$('f-sandbox-docker').checked = false;
  follow.$('f-trusted').checked = true;
  const r = await follow.panel.startFollowUp('And the flags?');
  assert.deepEqual(r, { ok: true });
  assert.equal(follow.posts.at(-1).url, '/api/projects/core/chats/a/runs');
  assert.equal(follow.posts.at(-1).body.request, 'And the flags?');
  assert.equal(follow.posts.at(-1).body.conversation, true);
});

test('the reducer keeps the reply as state.json does: absent until a run_reply, removed by the next run_started', () => {
  assert.equal(Object.hasOwn(createState(), 'reply'), false, 'absent, not null, before any reply');
  const started = reduceAll(events([START]));
  assert.equal(Object.hasOwn(started, 'reply'), false);

  const answered = reduceAll(events([START, ['run_reply', { from: 'michael', kind: 'answer', text: 'It runs agents.' }]]));
  assert.deepEqual(answered.reply, { from: 'michael', kind: 'answer', text: 'It runs agents.' });
  assert.deepEqual(Object.keys(answered.reply), ['from', 'kind', 'text'], 'truncated only when the event says so');
  const clipped = reduceAll(events([START, ['run_reply', { from: 'system', kind: 'summary', text: 'x', truncated: true }]]));
  assert.deepEqual(clipped.reply, { from: 'system', kind: 'summary', text: 'x', truncated: true });
  assert.equal(reduceAll(events([START, ['run_reply', { from: 'michael', kind: 'report', text: 'x', truncated: false }]])).reply.truncated, undefined);

  // the reply survives run_finished, and a run_reply changes nothing else
  const before = reduceAll(events([START]));
  const after = reduce(before, events([START, ['run_reply', { from: 'michael', kind: 'answer', text: 'A' }]])[1]);
  const { reply, lastSeq, updatedAt, applied, log, ...rest } = after;
  const { lastSeq: l0, updatedAt: u0, applied: a0, log: g0, ...rest0 } = before;
  assert.deepEqual(rest, rest0);
  assert.deepEqual([lastSeq, applied, log.length], [l0 + 1, a0 + 1, g0.length + 1]);
  const finished = reduceAll(events([START, ['run_reply', { from: 'michael', kind: 'answer', text: 'A' }], ['run_finished', { status: 'success', summary: 'Answered by Michael' }]]));
  assert.deepEqual([finished.reply.text, finished.result, finished.summary], ['A', 'success', 'Answered by Michael']);

  // the same hive runs again: the old reply is gone at once
  const again = reduce(finished, { v: 1, seq: 4, ts: '2026-11-11T10:00:00.000Z', runId: RUN, type: 'run_started', request: 'Next' });
  assert.equal(Object.hasOwn(again, 'reply'), false);
  // and another run starts without one
  assert.equal(Object.hasOwn(reduce(finished, { v: 1, seq: 1, runId: 'run-d', type: 'run_started', request: 'Next' }), 'reply'), false);
  // bidi controls never reach the view model, as for every other event text
  assert.equal(reduceAll(events([START, ['run_reply', { from: 'michael', kind: 'answer', text: 'a\u202Eb' }]])).reply.text, 'ab');
});

test('agent_message moves lastSeq and updatedAt and nothing else of the run', () => {
  const before = reduceAll(events([START, ['agent_status', { agent: 'michael', status: 'thinking', activity: 'Planning' }]]));
  const e = events([START, ['x', {}], ['agent_message', { agent: 'michael', instanceId: 'michael', milestoneId: null, cycle: null, text: 'Looking at bin/.', final: false }]])[2];
  const after = reduce(before, e);
  const { lastSeq, updatedAt, applied, log, ...rest } = after;
  const { lastSeq: l0, updatedAt: u0, applied: a0, log: g0, ...rest0 } = before;
  assert.deepEqual(rest, rest0, 'agents, instances, milestones, totals and status are untouched');
  assert.deepEqual([lastSeq, updatedAt, applied], [3, e.ts, a0 + 1]);
  assert.notEqual(updatedAt, u0);
  assert.deepEqual(totals(after), totals(before));
  assert.equal(Object.hasOwn(after, 'reply'), false);
  assert.equal(reduce(after, e), after, 'a replay of the same event changes nothing');
});

test('the Events tab shows agent_message and run_reply as one clipped line each', () => {
  const long = `First line of the message.\n\nSecond paragraph.\n${'more '.repeat(200)}`;
  const s = reduceAll(events([
    START,
    ['agent_message', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, text: 'Checking the workspace.', final: false }],
    ['agent_message', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, text: long, final: true }],
    ['agent_message', { agent: 'angela', instanceId: 'angela-m1', milestoneId: 'm1', cycle: 1, text: `\n\n${'x'.repeat(400)}`, final: true }],
    ['run_reply', { from: 'michael', kind: 'report', text: 'Both milestones passed.\n\n- m1\n- m2' }],
    ['run_reply', { from: 'system', kind: 'summary', text: 'Run finished with status "partial".' }],
  ]));
  const rows = s.log.slice(1).map((l) => [l.type, l.source, l.category, l.tone, l.text]);
  assert.deepEqual(rows, [
    ['agent_message', 'dwight-m1', 'status', 'muted', 'Checking the workspace.'],
    ['agent_message', 'dwight-m1', 'status', 'info', 'First line of the message. ...'],
    ['agent_message', 'angela-m1', 'status', 'info', `${'x'.repeat(137)}...`],
    ['run_reply', 'michael', 'results', 'info', 'Reply (report): Both milestones passed. ...'],
    ['run_reply', 'orchestrator', 'results', 'info', 'Reply (summary): Run finished with status "partial".'],
  ]);
  for (const l of s.log) assert.doesNotMatch(l.text, /\n/, 'one line');
  assert.equal(s.applied, 6, 'both are known event types');
  assert.deepEqual(describe({ type: 'agent_message', text: '', final: true }), { tone: 'info', text: '' });
});
