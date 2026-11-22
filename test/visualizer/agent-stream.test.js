// Live text from each working agent's stream (.enma/run-options-contract.md Live stream route,
// .enma/agent-stream-contract.md chunk format): SSE frames, attempts that replace each other, one stream per active
// instance, closed when the run ends or the chat switches, and the /live poll for every agent whose stream is not open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseFrames, createStreamTail, createAgentStreams, mergeLive, STREAM_KEEP } from '../../visualizer/public/js/agent-stream.js';
import { createLivePoll } from '../../visualizer/public/js/live-poll.js';
import { liveTargets, teamRunView, parseLive } from '../../visualizer/public/js/activity-model.js';
import { reduceAll } from '../../visualizer/public/js/state.js';
import { scopedUrl, streamSuffix } from '../../visualizer/public/js/scope.js';

const flush = () => new Promise((r) => setTimeout(r, 5));
const mark = (step, attempt) => ({ type: 'attempt_start', step, attempt });
const chunk = (step, attempt, kind, delta, seq = 0) => ({ v: 1, step, attempt, seq, kind, delta });
const frame = (value, id = 0, event = 'chunk') => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`;

// timers that only run when the test says so
function manualTimers() {
  let n = 0;
  const due = new Map();
  return {
    setTimeout(fn, ms) { n += 1; due.set(n, { fn, ms }); return n; },
    clearTimeout(id) { due.delete(id); },
    pending: () => [...due.values()].map((d) => d.ms),
    run(ms) {
      for (const [id, d] of [...due]) {
        if (d.ms !== ms) continue;
        due.delete(id);
        d.fn();
      }
    },
  };
}

// an SSE response whose body the test writes to; abort() closes it like a dropped connection. keepOnAbort: a body
// that goes on delivering after the abort, as a fetch may do with chunks already buffered
function sseServer({ keepOnAbort = false } = {}) {
  const calls = [];
  const open = new Map();
  const ask = async (url, opts = {}) => {
    calls.push({ url, opts });
    const status = open.get(url)?.status ?? 200;
    if (status !== 200) return { ok: false, status, body: null };
    let ctl;
    const body = new ReadableStream({ start(c) { ctl = c; } });
    const enc = new TextEncoder();
    const s = open.get(url) ?? {};
    s.write = (text) => ctl.enqueue(enc.encode(text));
    s.close = () => ctl.close();
    s.signal = opts.signal;
    open.set(url, s);
    if (!keepOnAbort) opts.signal?.addEventListener('abort', () => { try { ctl.error(new Error('aborted')); } catch { /* closed */ } });
    return { ok: true, status: 200, body };
  };
  return { ask, calls, open, refuse: (url, status) => open.set(url, { status }) };
}

function maker(runId) {
  let seq = 0;
  return (type, fields = {}) => ({ v: 1, seq: ++seq, ts: new Date(Date.UTC(2026, 10, 21, 12, 0, seq)).toISOString(), runId, type, ...fields });
}

function parallelState() {
  const e = maker('r1');
  return reduceAll([
    e('run_started', { request: 'Todo', workspace: 'C:\\ws', maxFailedCycles: 3 }),
    e('instance_started', { id: 'michael', instanceId: 'michael', agent: 'michael', milestoneId: null }),
    e('agent_status', { agent: 'michael', instanceId: 'michael', status: 'idle', activity: 'Idle' }),
    e('instance_started', { id: 'dwight-m1', instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }),
    e('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'working', activity: 'Coding' }),
    e('instance_started', { id: 'angela-m2', instanceId: 'angela-m2', agent: 'angela', milestoneId: 'm2' }),
    e('agent_status', { agent: 'angela', instanceId: 'angela-m2', status: 'thinking', activity: 'Thinking' }),
  ]);
}

const URL_OF = (runId, id) => `/api/projects/p/chats/c/${streamSuffix(runId, id)}`;

test('sseFrames: id, event and data of each complete message; comments and an unfinished message wait', () => {
  const { frames, rest } = sseFrames(': ping\n\nid: 3\nevent: chunk\ndata: {"a":1}\n\r\nid: 4\ndata: x\ndata: y\n\nevent: end\ndata: {"status":"SUCCESS"}\n\nid: 5\nevent: chu');
  assert.deepEqual(frames, [
    { id: '3', event: 'chunk', data: '{"a":1}' }, { id: '4', event: 'message', data: 'x\ny' }, { id: null, event: 'end', data: '{"status":"SUCCESS"}' },
  ]);
  assert.equal(rest, 'id: 5\nevent: chu');
  assert.deepEqual(sseFrames('retry: 2000\n\n').frames, [], 'a message without data');
});

test('stream tail: every marker starts over; chunks of a replaced attempt or another step are dropped; compaction is no answer', () => {
  const t = createStreamTail();
  assert.equal(t.push(mark('llm:0', 1)), true);
  t.push(chunk('llm:0', 1, 'thinking', 'Look at '));
  t.push(chunk('llm:0', 1, 'thinking', 'the file'));
  assert.deepEqual(t.instance('dwight'), { agent: 'dwight', phase: 'thinking', thinking: 'Look at the file', thinkingCut: false, text: null, textCut: false, updatedAt: t.instance('dwight').updatedAt, open: 'thinking' });
  // a retry of the same request: what attempt 1 said is gone, and its late chunks are not counted
  t.push(mark('llm:0', 2));
  assert.equal(t.push(chunk('llm:0', 1, 'text', 'stale')), false);
  t.push(chunk('llm:0', 2, 'text', 'Fixed it.'));
  assert.deepEqual([t.instance('d').thinking, t.instance('d').text, t.instance('d').phase, t.instance('d').open], [null, 'Fixed it.', 'text', 'text']);
  // recovery may restart an attempt with the same number: the marker still drops what was there
  t.push(mark('llm:0', 2));
  assert.equal(t.instance('d').text, null);
  assert.equal(t.push(chunk('llm:1', 2, 'text', 'other step')), false);
  // the next request of the turn
  t.push(mark('llm:1', 1));
  t.push(chunk('llm:1', 1, 'text', 'Next'));
  assert.equal(t.push(mark('compact:1:0', 1)), false, 'a compaction marker leaves the answer alone');
  assert.equal(t.push(chunk('compact:1:0', 1, 'text', 'summary')), false);
  assert.equal(t.instance('d').text, 'Next');
  for (const bad of [null, 'x', { v: 2, step: 'llm:1', attempt: 1, kind: 'text', delta: 'y' }, chunk('llm:1', 1, 'tool', 'y'), chunk('llm:1', 1, 'text', '')]) {
    assert.equal(t.push(bad), false, JSON.stringify(bad));
  }
  t.push(chunk('llm:1', 1, 'text', 'x'.repeat(STREAM_KEEP + 10)));
  assert.equal(t.instance('d').text.length, STREAM_KEEP);
  assert.equal(t.instance('d').textCut, true);
});

test('liveTargets: the active instances under their tail ids; a finished or idle one gets no stream', () => {
  const s = parallelState();
  assert.deepEqual(liveTargets(s), [{ id: 'dwight-m1', agent: 'dwight' }, { id: 'angela-m2', agent: 'angela' }]);
  assert.deepEqual(liveTargets(null), []);
  assert.equal(URL_OF('r1', 'dwight-m1'), '/api/projects/p/chats/c/runs/r1/agents/dwight-m1/stream');
  assert.equal(scopedUrl(null, streamSuffix('r 1', 'dwight-m1')), '/api/runs/r%201/agents/dwight-m1/stream', 'the unscoped route of a single hive');
  assert.equal(scopedUrl(null, 'runs/r1/thoughts'), null, 'no other run route is made unscoped');
});

test('streams: one per active agent with the control header; the deltas reach the run view as live text', async () => {
  const server = sseServer();
  const timers = manualTimers();
  let changes = 0;
  const streams = createAgentStreams({ url: URL_OF, fetch: server.ask, timers, onChange: () => { changes += 1; } });
  const state = parallelState();
  streams.sync({ runId: 'r1', targets: liveTargets(state), on: true });
  await flush();
  assert.deepEqual(server.calls.map((c) => c.url), [URL_OF('r1', 'dwight-m1'), URL_OF('r1', 'angela-m2')]);
  assert.equal(server.calls[0].opts.headers['X-Scranton-Client'], '1');
  assert.equal(server.calls[0].opts.headers.Accept, 'text/event-stream');
  assert.deepEqual(streams.states(), { 'dwight-m1': 'open', 'angela-m2': 'open' });
  assert.equal(streams.fallback(), false, 'every working agent is streamed: no poll needed');

  const d = server.open.get(URL_OF('r1', 'dwight-m1'));
  d.write(frame(mark('llm:0', 1), 0));
  d.write(frame(chunk('llm:0', 1, 'thinking', 'Reading <b>cli.js</b>'), 1).slice(0, 20));
  await flush();
  d.write(frame(chunk('llm:0', 1, 'thinking', 'Reading <b>cli.js</b>'), 1).slice(20));
  await flush();
  assert.ok(changes > 0);
  const live = streams.get();
  assert.equal(live.doc.runId, 'r1');
  assert.deepEqual(Object.keys(live.doc.instances), ['dwight-m1', 'angela-m2']);
  const rv = teamRunView({ state, live });
  const dwight = rv.agents.find((a) => a.id === 'dwight-m1');
  assert.deepEqual([dwight.text.kind, dwight.text.body], ['reasoning', 'Reading <b>cli.js</b>'], 'model text stays text');
  // the run ends: every stream is closed
  streams.sync({ runId: 'r1', targets: [], on: false });
  assert.equal(d.signal.aborted, true);
  assert.equal(streams.get(), null);
});

test('streams: 404 or a failure hand the agent to the poll and ask again later; end removes the tail and is final', async () => {
  const server = sseServer();
  const timers = manualTimers();
  const streams = createAgentStreams({ url: URL_OF, fetch: server.ask, timers });
  server.refuse(URL_OF('r1', 'dwight-m1'), 404);
  server.refuse(URL_OF('r1', 'angela-m2'), 500);
  streams.sync({ runId: 'r1', targets: liveTargets(parallelState()), on: true });
  await flush();
  assert.deepEqual(streams.states(), { 'dwight-m1': 'off', 'angela-m2': 'failed' });
  assert.equal(streams.fallback(), true);
  assert.equal(streams.get(), null);
  assert.equal(streams.serving(), false);

  // the workflow exists now (an agent that had only just started has none yet)
  server.open.delete(URL_OF('r1', 'dwight-m1'));
  timers.run(5000);
  await flush();
  assert.equal(streams.states()['dwight-m1'], 'open');
  assert.equal(streams.served('dwight-m1'), true);
  const d = server.open.get(URL_OF('r1', 'dwight-m1'));
  d.write(frame(mark('llm:0', 1)) + frame(chunk('llm:0', 1, 'text', 'Done.'), 1));
  await flush();
  assert.equal(streams.get().doc.instances['dwight-m1'].text.body, 'Done.');
  d.write(`event: end\ndata: ${JSON.stringify({ status: 'SUCCESS' })}\n\n`);
  await flush();
  assert.equal(streams.states()['dwight-m1'], 'ended');
  assert.equal(streams.get(), null, 'a finished agent shows no tail');
  const before = server.calls.length;
  timers.run(5000);
  await flush();
  assert.equal(server.calls.filter((c) => c.url === URL_OF('r1', 'dwight-m1')).length, server.calls.filter((c, i) => i < before && c.url === URL_OF('r1', 'dwight-m1')).length, 'an ended stream is not read again');

  // a dropped connection without end: read again from the start, the tail rebuilt
  server.open.delete(URL_OF('r1', 'angela-m2'));
  timers.run(5000);
  await flush();
  const a = server.open.get(URL_OF('r1', 'angela-m2'));
  a.write(frame(mark('llm:0', 1)) + frame(chunk('llm:0', 1, 'thinking', 'first'), 1));
  await flush();
  a.close();
  await flush();
  assert.equal(streams.states()['angela-m2'], 'failed');
  server.open.delete(URL_OF('r1', 'angela-m2'));
  timers.run(5000);
  await flush();
  const again = server.open.get(URL_OF('r1', 'angela-m2'));
  again.write(frame(mark('llm:0', 1)) + frame(chunk('llm:0', 1, 'thinking', 'first'), 1));
  await flush();
  assert.equal(streams.get().doc.instances['angela-m2'].thinking.body, 'first', 'replayed once, not twice');
});

test('a chat switch closes every stream, and a late chunk of the old one paints nothing', async () => {
  const server = sseServer({ keepOnAbort: true });
  let changes = 0;
  const streams = createAgentStreams({ url: URL_OF, fetch: server.ask, timers: manualTimers(), onChange: () => { changes += 1; } });
  streams.sync({ runId: 'r1', targets: [{ id: 'dwight-m1', agent: 'dwight' }], on: true });
  await flush();
  const d = server.open.get(URL_OF('r1', 'dwight-m1'));
  streams.reset();
  assert.equal(d.signal.aborted, true);
  const seen = changes;
  d.write(frame(mark('llm:0', 1)) + frame(chunk('llm:0', 1, 'text', 'late'), 1));
  await flush();
  assert.equal(changes, seen, 'the old chat\'s chunk is read but dropped');
  assert.equal(streams.get(), null);
  // another run on screen starts over too
  streams.sync({ runId: 'r1', targets: [{ id: 'dwight-m1', agent: 'dwight' }], on: true });
  await flush();
  const first = server.open.get(URL_OF('r1', 'dwight-m1'));
  streams.sync({ runId: 'r2', targets: [{ id: 'dwight-m1', agent: 'dwight' }], on: true });
  assert.equal(first.signal.aborted, true);
});

test('fallback: the /live poll runs only for agents without an open stream, unchanged, and its tails fill in for them', async () => {
  const server = sseServer();
  const timers = manualTimers();
  const streams = createAgentStreams({ url: URL_OF, fetch: server.ask, timers });
  const polls = [];
  let liveDoc = { v: 1, runId: 'r1', updatedAt: null, instances: {
    'dwight-m1': { agent: 'dwight', phase: 'thinking', thinking: 'from the poll', text: null },
    'angela-m2': { agent: 'angela', phase: 'text', thinking: null, text: 'Angela via poll' },
  } };
  const pollTimers = manualTimers();
  const poll = createLivePoll({
    url: () => '/api/projects/p/chats/c/live',
    wanted: () => streams.fallback(),
    fetch: async (url) => { polls.push(url); return { ok: true, status: 200, json: async () => liveDoc }; },
    timers: pollTimers, doc: null,
  });
  server.refuse(URL_OF('r1', 'angela-m2'), 404);
  streams.sync({ runId: 'r1', targets: liveTargets(parallelState()), on: true });
  await flush();
  poll.sync();
  await flush();
  assert.equal(polls.length, 1, 'Angela has no stream: the poll asks');
  const d = server.open.get(URL_OF('r1', 'dwight-m1'));
  d.write(frame(mark('llm:0', 1)) + frame(chunk('llm:0', 1, 'thinking', 'from the stream'), 1));
  await flush();
  const now = Date.now();
  const merged = mergeLive(poll, streams, now);
  assert.equal(merged.doc.instances['dwight-m1'].thinking.body, 'from the stream', 'a streamed agent never takes the poll\'s tail');
  assert.equal(merged.doc.instances['angela-m2'].text.body, 'Angela via poll');
  assert.equal(mergeLive(poll, streams, now + 60000).doc.instances['angela-m2'], undefined, 'a stale poll answer is not shown');
  liveDoc = { ...liveDoc, runId: 'other' };
  pollTimers.run(1000);
  await flush();
  assert.equal(mergeLive(poll, streams).doc.instances['angela-m2'], undefined, 'nor one about another run');

  // Angela's stream opens: nobody needs the poll any more
  server.open.delete(URL_OF('r1', 'angela-m2'));
  timers.run(5000);
  await flush();
  assert.equal(streams.fallback(), false);
  const asked = polls.length;
  pollTimers.run(1000);
  await flush();
  assert.equal(polls.length, asked, 'the poll stops once every working agent is streamed');
  assert.equal(poll.get(), null);

  // no stream at all (an older server): the poll alone, as before
  const old = createAgentStreams({ url: () => null, fetch: server.ask, timers: manualTimers() });
  assert.equal(mergeLive({ get: () => ({ doc: parseLive(liveDoc), at: now }) }, old, now).doc.runId, 'other');
});
