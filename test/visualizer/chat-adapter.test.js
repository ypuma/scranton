// The team adapter of the Chat view (.enma/chat-view-contract.md sections 7 and 13.7): Contract v1 events and
// the run list -> engine-neutral entries. Pure, so every case is events in, entries out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { teamChatAdapter, CHAT_EVENT_TYPES } from '../../visualizer/public/js/chat-adapter-team.js';
import {
  ENTRY_KINDS, TEXT_MAX, cleanText, cleanLine, splitKeyword, isLong, groupRuns, runDigest, entryKey, entryLabel, announcement,
} from '../../visualizer/public/js/chat-entries.js';
import { reduceAll, parseJsonl } from '../../visualizer/public/js/state.js';
import { parseRuns } from '../../visualizer/public/js/scope.js';

const RUN = 'run-a';
// [type, fields] -> events of one run with rising seq and time
function events(list, runId = RUN) {
  return list.map(([type, fields], i) => ({ v: 1, seq: i + 1, ts: new Date(Date.UTC(2026, 10, 11, 9, 0, i)).toISOString(), runId, type, ...fields }));
}
const adapt = (list, extra = {}) => {
  const ev = events(list);
  return teamChatAdapter({ events: ev, state: reduceAll(ev), runs: [], ...extra });
};
const START = ['run_started', { request: 'How does the CLI parse flags?', workspace: 'C:\\ws', maxFailedCycles: 3 }];
const msg = (agent, text, fields = {}) => ['agent_message', { agent, instanceId: agent, milestoneId: null, cycle: null, text, final: false, ...fields }];
const tool = (agent, name, detail, instanceId = agent) => ['agent_tool', { agent, instanceId, tool: name, detail }];
const pick = (entry, keys) => Object.fromEntries(keys.map((k) => [k, entry[k]]));

test('every event type becomes its entry, in order, with a unique id and a known kind', () => {
  const out = adapt([
    START,
    ['plan_ready', { milestones: [{ id: 'm1', title: 'Parser' }, { id: 'm2', title: 'Docs' }] }],
    ['milestone_started', { milestoneId: 'm1', index: 0, total: 2, title: 'Parser' }],
    ['instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }],
    msg('dwight', 'Reading the parser first.', { instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1 }),
    tool('dwight', 'read', 'src/cli.js', 'dwight-m1'),
    msg('dwight', 'Done.\n\n[TASK_COMPLETE]', { instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, final: true }),
    ['gate_result', { agent: 'oscar', instanceId: 'oscar-m1', milestoneId: 'm1', cycle: 1, stage: 0, result: 'passed', keyword: 'REVIEW_APPROVED' }],
    ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'passed', failedCycles: 0, reason: 'All gates passed' }],
    ['milestone_finished', { milestoneId: 'm1', status: 'passed' }],
    ['chat_message', { id: 'c1', from: 'human', to: 'dwight-m1', text: 'Keep it short.', delivery: 'queued' }],
    ['chat_delivery', { id: 'c1', delivery: 'delivered' }],
    ['run_reply', { from: 'michael', kind: 'report', text: 'The parser is done.' }],
    ['run_finished', { status: 'success', summary: 'All 1 milestones passed' }],
  ]);
  assert.deepEqual(out.map((x) => x.kind), ['request', 'activity', 'activity', 'agent', 'activity', 'agent', 'activity', 'activity', 'activity', 'human', 'reply']);
  assert.equal(new Set(out.map((x) => x.id)).size, out.length, 'ids are unique');
  for (const x of out) {
    assert.ok(ENTRY_KINDS.includes(x.kind), x.kind);
    assert.equal(x.runId, RUN);
    assert.match(x.ts, /^2026-11-11T09:00:\d\d\.000Z$/);
  }
  assert.deepEqual(pick(out[0], ['id', 'kind', 'text', 'who']), { id: `req-${RUN}`, kind: 'request', text: 'How does the CLI parse flags?', who: { id: 'human', name: 'You', title: '' } });
  assert.equal(out[1].text, 'Plan ready: 2 milestones');
  assert.equal(out[2].text, 'm1 started: Parser');
  assert.deepEqual(pick(out[3], ['who', 'context', 'text', 'final', 'truncated']),
    { who: { id: 'dwight', name: 'Dwight', title: 'Developer' }, context: 'm1 · cycle 1', text: 'Reading the parser first.', final: false, truncated: false });
  assert.deepEqual(pick(out[4], ['who', 'context', 'text', 'tone']), { who: { id: 'dwight', name: 'Dwight', title: 'Developer' }, context: 'm1', text: 'read src/cli.js', tone: null });
  assert.equal(out[5].final, true);
  assert.deepEqual(pick(out[6], ['who', 'context', 'text', 'tone']), { who: { id: 'oscar', name: 'Oscar', title: 'Reviewer' }, context: 'm1 · cycle 1', text: 'gate passed [REVIEW_APPROVED]', tone: 'ok' });
  assert.deepEqual(pick(out[7], ['text', 'tone']), { text: 'm1 cycle 1 passed: All gates passed', tone: 'ok' });
  assert.deepEqual(pick(out[8], ['text', 'tone']), { text: 'm1 passed', tone: 'ok' });
  assert.deepEqual(pick(out[9], ['kind', 'who', 'context', 'text', 'tone']), { kind: 'human', who: { id: 'human', name: 'You', title: '' }, context: 'to dwight-m1', text: 'Keep it short.', tone: null });
});

test('exactly one reply: the run_reply, with the outcome and the totals of the run line under it', () => {
  const out = adapt([
    START,
    ['plan_ready', { milestones: [{ id: 'm1', title: 'Parser' }] }],
    ['milestone_started', { milestoneId: 'm1', index: 0, total: 1, title: 'Parser' }],
    ['agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 900, usage: { input: 1200, output: 300, cost: 0.02 } }],
    ['milestone_finished', { milestoneId: 'm1', status: 'passed' }],
    ['run_reply', { from: 'michael', kind: 'report', text: 'Done.' }],
    ['run_reply', { from: 'michael', kind: 'report', text: 'A second one is ignored.' }],
    ['run_finished', { status: 'success', summary: 'All 1 milestones passed' }],
  ]);
  const replies = out.filter((x) => x.kind === 'reply');
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], {
    id: `rep-${RUN}`, runId: RUN, kind: 'reply', ts: '2026-11-11T09:00:05.000Z', who: { id: 'michael', name: 'Michael', title: 'Orchestrator' },
    context: 'Success · 1/1 milestones · 1.5k tokens · $0.020 · 7s', text: 'Done.', truncated: false, tone: 'ok', replyKind: 'report',
  });
  assert.equal(out.at(-1).kind, 'reply', 'the summary of run_finished adds no second reply');

  const failed = adapt([START, ['run_reply', { from: 'system', kind: 'summary', text: 'Run finished with status "partial".' }], ['run_finished', { status: 'partial', summary: 'x' }]]).at(-1);
  assert.deepEqual(pick(failed, ['who', 'replyKind', 'tone', 'context']), { who: { id: 'system', name: 'Scranton', title: '' }, replyKind: 'summary', tone: 'fail', context: 'Partial · 2s' });
  const open = adapt([START, ['run_reply', { from: 'michael', kind: 'answer', text: 'It uses parseArgs.' }]]).at(-1);
  assert.deepEqual(pick(open, ['replyKind', 'tone', 'context']), { replyKind: 'answer', tone: null, context: '' }, 'no outcome before run_finished');
  assert.equal(adapt([START, ['run_reply', { from: 'michael', kind: 'poem', text: 'x' }]]).at(-1).replyKind, 'summary', 'an unknown kind never names itself');
});

test('the trailing keyword line is taken off the shown text and becomes a chip', () => {
  assert.deepEqual(splitKeyword('Implemented m1.\n\n[TASK_COMPLETE]\n'), { text: 'Implemented m1.', keyword: 'TASK_COMPLETE' });
  assert.deepEqual(splitKeyword('  [SECLINT_FAILED]  '.trim()), { text: '', keyword: 'SECLINT_FAILED' });
  assert.deepEqual(splitKeyword('See [docs] for more'), { text: 'See [docs] for more', keyword: null });
  assert.deepEqual(splitKeyword('[TASK_COMPLETE] is what I will say'), { text: '[TASK_COMPLETE] is what I will say', keyword: null }, 'only on a line of its own');
  assert.deepEqual(splitKeyword('First\n[lowercase]'), { text: 'First\n[lowercase]', keyword: null });
  assert.deepEqual(splitKeyword(undefined), { text: '', keyword: null });
  // the adapter keeps the text verbatim, as the contract pins agent_message.text; the view asks splitKeyword
  const [, entry] = adapt([START, msg('dwight', 'Implemented m1.\n\n[TASK_COMPLETE]', { final: true })]);
  assert.equal(entry.text, 'Implemented m1.\n\n[TASK_COMPLETE]');
  assert.deepEqual(splitKeyword(entry.text), { text: 'Implemented m1.', keyword: 'TASK_COMPLETE' });
});

test('the tools of one instance between two of its messages are one line: the count and the last tool', () => {
  const out = adapt([
    START,
    ['instance_started', { instanceId: 'dwight-m1', agent: 'dwight', milestoneId: 'm1' }],
    ['instance_started', { instanceId: 'dwight-m2', agent: 'dwight', milestoneId: 'm2' }],
    tool('dwight', 'read', 'a.js', 'dwight-m1'),
    tool('dwight', 'ls', '.', 'dwight-m2'),
    tool('dwight', 'edit', 'a.js', 'dwight-m1'),
    tool('dwight', 'bash', 'npm test', 'dwight-m1'),
    msg('dwight', 'Tests pass.', { instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1 }),
    tool('dwight', 'write', 'README.md', 'dwight-m1'),
    ['agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: 'TASK_COMPLETE', exitCode: 0, durationMs: 1 }],
    tool('dwight', 'read', 'b.js', 'dwight-m1'),
  ]);
  assert.deepEqual(out.slice(1).map((x) => [x.kind, x.context, x.text]), [
    ['activity', 'm1', '3 tools, last: bash npm test'],
    ['activity', 'm2', 'ls .'],
    ['agent', 'm1 · cycle 1', 'Tests pass.'],
    ['activity', 'm1', 'write README.md'],
    ['activity', 'm1', 'read b.js'],
  ], 'another lane in between does not split a group; a message or the end of a launch does');
  assert.equal(out[1].id, `tool-${RUN}-4`, 'the line keeps the id of its first tool while it grows');
  assert.equal(out[1].ts, '2026-11-11T09:00:06.000Z', 'and carries the time of the last one');
});

test('a human question, then the answer; steering messages with their delivery', () => {
  const asked = adapt([START, ['hitl_request', { milestoneId: 'm2', reason: '2 consecutive failed cycles on m2.', options: ['feedback', 'retry'] }]]).at(-1);
  assert.deepEqual(pick(asked, ['kind', 'who', 'context', 'text', 'tone']),
    { kind: 'question', who: { id: 'michael', name: 'Michael', title: 'Orchestrator' }, context: 'm2', text: '2 consecutive failed cycles on m2.', tone: 'warn' });
  const out = adapt([
    START,
    ['hitl_request', { milestoneId: 'm2', reason: 'Stuck.', options: ['feedback', 'retry'] }],
    ['hitl_response', { milestoneId: 'm2', decision: 'feedback', feedback: 'Treat a missing file as empty.' }],
    ['hitl_request', { milestoneId: null, reason: 'Stuck again.', options: ['retry', 'abort'] }],
    ['hitl_response', { milestoneId: null, decision: 'retry' }],
    ['chat_message', { id: 'c1', from: 'human', to: 'dwight-m2', text: 'One', delivery: 'queued' }],
    ['chat_message', { id: 'c2', from: 'human', to: 'gone-m9', text: 'Two', delivery: 'rejected', reason: 'unknown recipient' }],
    ['chat_message', { id: 'c3', from: 'human', to: 'dwight-m2', text: 'Three', delivery: 'queued' }],
    ['chat_delivery', { id: 'c3', delivery: 'unknown', reason: 'ack timed out' }],
    ['chat_delivery', { id: 'c3', delivery: 'queued' }],
    ['chat_message', { id: 'c4', from: 'dwight-m2', to: 'angela-m2', text: 'Ready for QA.', delivery: 'delivered' }],
  ]);
  assert.deepEqual(out.slice(1).map((x) => [x.kind, x.context, x.text, x.tone]), [
    ['question', 'm2', 'Stuck.', null],
    ['human', 'm2', 'You chose Feedback for Dwight\n\nTreat a missing file as empty.', null],
    ['question', '', 'Stuck again.', null],
    ['human', '', 'You chose Retry', null],
    ['human', 'to dwight-m2 · queued', 'One', null],
    ['human', 'to gone-m9 · rejected: unknown recipient', 'Two', 'fail'],
    ['human', 'to dwight-m2 · delivery unknown', 'Three', 'warn'],
    ['agent', 'to angela-m2', 'Ready for QA.', null],
  ], 'an answered question is no longer waiting; a late queued echo does not undo an unknown delivery');
  assert.deepEqual(pick(out.at(-1), ['who', 'final']), { who: { id: 'dwight', name: 'Dwight', title: 'Developer' }, final: false });
  const over = adapt([START, ['hitl_request', { milestoneId: null, reason: 'Stuck.', options: ['abort'] }], ['run_finished', { status: 'aborted', summary: 'Stopped' }]]);
  assert.equal(over[1].tone, null, 'nobody answers a run that is over');
});

test('a message sent from this page shows as queued until the stream echoes it', () => {
  const outbox = [{ id: 'c9', runId: RUN, to: 'dwight-m1', text: 'Use todos.json', delivery: 'queued', ts: '2026-11-11T09:01:00.000Z', stale: false }];
  const local = adapt([START], { outbox }).at(-1);
  assert.deepEqual(pick(local, ['id', 'kind', 'context', 'text']), { id: `chat-${RUN}-c9`, kind: 'human', context: 'to dwight-m1 · queued', text: 'Use todos.json' });
  assert.equal(adapt([START], { outbox: [{ ...outbox[0], stale: true }] }).at(-1).context, 'to dwight-m1 · queued, not picked up yet');
  const echoed = adapt([START, ['chat_message', { id: 'c9', from: 'human', to: 'dwight-m1', text: 'Use todos.json', delivery: 'delivered' }]], { outbox });
  assert.deepEqual(echoed.filter((x) => x.kind === 'human').map((x) => [x.id, x.context]), [[`chat-${RUN}-c9`, 'to dwight-m1']], 'once, under the same id');
  assert.equal(adapt([START], { outbox: [{ ...outbox[0], runId: 'another-run' }] }).length, 1, 'a message of another run is not shown here');
});

test('a run without agent messages still reads as a conversation: mailbox summaries, verdicts, the summary', () => {
  const out = adapt([
    START,
    ['hive_write', { from: 'human', to: 'michael', kind: 'plan_request', summary: 'Plan: Build it', file: 'michael/inbox.md' }],
    ['hive_write', { from: 'michael', to: 'dwight', kind: 'task', summary: 'm1: Todo storage', file: 'dwight-m1/inbox.md', milestoneId: 'm1', cycle: 1 }],
    ['hive_write', { from: 'dwight', to: 'angela', kind: 'handoff', summary: 'Dwight finished m1: Implemented m1.', milestoneId: 'm1', cycle: 1 }],
    ['cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1, reason: 'Angela reported [TEST_FAILED]' }],
    ['hive_write', { from: 'angela', to: 'dwight', kind: 'bug_report', summary: 'QA failed: done 1 crashes.', milestoneId: 'm1', cycle: 2 }],
    ['hive_write', { from: 'michael', to: 'human', kind: 'hitl', summary: '2 consecutive failed cycles', milestoneId: null }],
    ['milestone_finished', { milestoneId: 'm1', status: 'skipped' }],
    ['run_finished', { status: 'partial', summary: '0 of 1 milestones passed' }],
  ]);
  assert.deepEqual(out.slice(1).map((x) => [x.kind, x.who?.name ?? null, x.context ?? null, x.text, x.tone ?? null]), [
    ['agent', 'Michael', 'm1 · task to Dwight', 'm1: Todo storage', null],
    ['agent', 'Dwight', 'm1 · handoff to Angela', 'Dwight finished m1: Implemented m1.', null],
    ['activity', null, null, 'm1 cycle 1 failed: Angela reported [TEST_FAILED]', 'fail'],
    ['agent', 'Angela', 'm1 · bug report to Dwight', 'QA failed: done 1 crashes.', null],
    ['activity', null, null, 'm1 skipped', 'warn'],
    ['reply', 'Scranton', 'Partial · 0/1 milestones · 8s', '0 of 1 milestones passed', 'fail'],
  ], 'the request to the planner and the question to the human are not repeated as agent messages');
  assert.equal(out.at(-1).replyKind, 'summary');
  assert.equal(out.filter((x) => x.kind === 'agent').every((x) => x.final === true), true);

  // a conversation run never doubles its messages with their mailbox summaries
  const talk = adapt([START, msg('dwight', 'Implemented m1.', { final: true }), ['hive_write', { from: 'dwight', to: 'angela', kind: 'handoff', summary: 'Dwight finished m1: Implemented m1.' }]]);
  assert.deepEqual(talk.map((x) => x.kind), ['request', 'agent']);
});

test('the bundled demo recording reads as a conversation with one reply', () => {
  const sample = parseJsonl(readFileSync(new URL('../../visualizer/public/demo/sample-events.jsonl', import.meta.url), 'utf8'));
  const out = teamChatAdapter({ events: sample, state: reduceAll(sample), runs: [] });
  assert.equal(out[0].kind, 'request');
  assert.match(out[0].text, /^Build a tiny todo CLI/);
  assert.equal(out.filter((x) => x.kind === 'reply').length, 1);
  assert.deepEqual(pick(out.at(-1), ['kind', 'replyKind', 'text', 'tone']), { kind: 'reply', replyKind: 'summary', text: 'All 3 milestones passed', tone: 'ok' });
  assert.match(out.at(-1).context, /^Success · 3\/3 milestones · [\d.]+k tokens · \$\d+\.\d+ · \dm \d\ds$/);
  assert.ok(out.filter((x) => x.kind === 'agent').length >= 8, 'tasks, handoffs and bug reports');
  assert.deepEqual(out.filter((x) => x.kind === 'question').map((x) => x.tone), [null], 'the question of the recording was answered');
  assert.ok(out.some((x) => x.kind === 'human' && /^You chose Feedback for Dwight\n\nTreat a missing todos\.json/.test(x.text)));
  assert.ok(out.some((x) => x.kind === 'human' && x.context === 'to dwight-m2' && x.text === 'Keep the commands short: add, list and done.'));
  assert.ok(out.length < sample.length / 2, `${out.length} entries for ${sample.length} events`);
});

test('unknown events, events without a run and other shapes are ignored', () => {
  const ev = events([START, ['agent_status', { agent: 'dwight', status: 'working', activity: 'x' }], ['telemetry', { text: 'x' }], ['log', { level: 'error', message: 'x' }], ['milestone_integrated', { milestoneId: 'm1' }]]);
  const out = teamChatAdapter({ events: [null, 'x', 7, { type: 'agent_message', text: 'no run id' }, { runId: RUN }, ...ev], state: reduceAll(ev) });
  assert.deepEqual(out.map((x) => x.kind), ['request']);
  assert.deepEqual(teamChatAdapter(), []);
  assert.deepEqual(teamChatAdapter({ events: null, runs: null, outbox: null }), []);
  for (const type of ['agent_status', 'log', 'milestone_integrated', 'circuit_breaker']) assert.equal(CHAT_EVENT_TYPES.has(type), false, `${type} is not kept for the Chat view`);
  for (const type of ['run_started', 'agent_message', 'run_reply', 'run_finished', 'agent_tool', 'hive_write']) assert.equal(CHAT_EVENT_TYPES.has(type), true, type);
});

test('hostile model text: bidi and control characters go, the 16000 cap holds, truncated is kept', () => {
  const nasty = 'safe\u202Etxt.exe\u2066 \u001B[31mred\u0007\u0000 tab\there\r\nnext\u0085line';
  assert.deepEqual(cleanText(nasty), { text: 'safetxt.exe [31mred tab\there\nnextline', truncated: false });
  assert.equal(cleanLine('  a\n\n b\t c  '), 'a b c');
  assert.equal(cleanLine('x'.repeat(300), 20), `${'x'.repeat(17)}...`);
  assert.deepEqual(cleanText(42), { text: '', truncated: false });

  const out = adapt([
    START,
    msg('dwight', nasty, { final: true }),
    msg('dwight', 'y'.repeat(TEXT_MAX), { truncated: true }),
    msg('dwight', 'z'.repeat(TEXT_MAX + 500)),
    ['run_reply', { from: 'michael\u202E', kind: 'answer', text: `\u202E${'r'.repeat(TEXT_MAX + 1)}` }],
    ['run_finished', { status: 'success\u0007', summary: 's' }],
  ]);
  assert.equal(out[1].text, 'safetxt.exe [31mred tab\there\nnextline');
  assert.deepEqual([out[2].text.length, out[2].truncated], [TEXT_MAX, true], 'the event already said it was clipped');
  assert.deepEqual([out[3].text.length, out[3].truncated], [TEXT_MAX, true], 'a longer text than the contract allows is clipped here');
  assert.deepEqual([out[4].text.length, out[4].truncated, out[4].who.name], [TEXT_MAX, true, 'michael']);
  for (const x of out) assert.doesNotMatch(JSON.stringify(x), /[\u202A-\u202E\u2066-\u2069]|\\u00(0[0-8bcef]|1[0-9a-f]|7f|[89][0-9a-f])/i, x.id);

  // a role from the run's own list is cleaned too
  const named = teamChatAdapter({ events: events([
    ['run_started', { request: 'x', roles: [{ id: 'seclint', name: 'Sec\u202Elint', title: 'Li\u0007nt', kind: 'gate' }] }],
    msg('seclint', 'Checked.', { final: true }),
  ]) });
  assert.deepEqual(named[1].who, { id: 'seclint', name: 'Seclint', title: 'Lint' });
});

test('earlier runs: the request and the reply straight from the run list, the detail once its events are there', () => {
  const runs = parseRuns({ runs: [
    { runId: 'r1', goal: 'What does the CLI do?', status: 'success', startedAt: '2026-11-10T10:00:00.000Z', endedAt: '2026-11-10T10:01:00.000Z', current: false, summary: 'Answered by Michael', reply: { kind: 'answer', text: 'It runs agents.', truncated: true } },
    { runId: 'r2', goal: 'Add a flag', status: 'partial', startedAt: '2026-11-10T11:00:00.000Z', endedAt: '2026-11-10T11:05:00.000Z', current: false, summary: 'm1 passed, m2 failed', reply: null },
    { runId: 'r3', goal: 'Old run', status: 'aborted', startedAt: '2026-11-10T12:00:00.000Z', endedAt: null, current: false, summary: '' },
    { runId: RUN, goal: 'How does the CLI parse flags?', status: 'running', startedAt: '2026-11-11T09:00:00.000Z', endedAt: null, current: true, summary: '', reply: null },
  ] });
  assert.deepEqual(runs[0].reply, { kind: 'answer', text: 'It runs agents.', truncated: true });
  assert.deepEqual([runs[1].reply, runs[1].summary, runs[2].reply], [null, 'm1 passed, m2 failed', null], 'a missing reply reads as null');
  assert.equal(parseRuns({ runs: [{ runId: 'r9', reply: { kind: 'poem', text: 'x' } }] })[0].reply, null, 'an unknown kind is no reply');

  const live = events([START, msg('michael', 'Looking.')]);
  const out = teamChatAdapter({ events: live, state: reduceAll(live), runs });
  assert.deepEqual(out.map((x) => [x.runId, x.kind]), [
    ['r1', 'request'], ['r1', 'reply'], ['r2', 'request'], ['r2', 'reply'], ['r3', 'request'], ['r3', 'reply'], [RUN, 'request'], [RUN, 'agent'],
  ]);
  assert.deepEqual(pick(out[1], ['id', 'who', 'replyKind', 'text', 'truncated', 'tone', 'context', 'ts']), {
    id: 'rep-r1', who: { id: 'michael', name: 'Michael', title: 'Orchestrator' }, replyKind: 'answer', text: 'It runs agents.', truncated: true, tone: 'ok', context: 'Success', ts: '2026-11-10T10:01:00.000Z',
  });
  assert.deepEqual(pick(out[3], ['who', 'replyKind', 'text', 'tone', 'context']), { who: { id: 'system', name: 'Scranton', title: '' }, replyKind: 'summary', text: 'm1 passed, m2 failed', tone: 'fail', context: 'Partial' },
    'a run without a stored reply shows its summary and status');
  assert.deepEqual(pick(out[5], ['text', 'context']), { text: 'Run aborted', context: 'Aborted' });

  // opened: the same ids for the request and the reply, the agent messages in between
  const r1 = events([['run_started', { request: 'What does the CLI do?' }], msg('michael', 'Reading bin/.'), ['run_reply', { from: 'michael', kind: 'answer', text: 'It runs agents, in full.' }], ['run_finished', { status: 'success', summary: 'Answered by Michael' }]], 'r1');
  const opened = teamChatAdapter({ events: [...r1, ...live], state: reduceAll(live), runs });
  assert.deepEqual(opened.filter((x) => x.runId === 'r1').map((x) => [x.id, x.kind]), [['req-r1', 'request'], ['msg-r1-2', 'agent'], ['rep-r1', 'reply']]);
  assert.equal(opened.find((x) => x.id === 'rep-r1').text, 'It runs agents, in full.');
  assert.deepEqual(groupRuns(opened).map((g) => [g.runId, g.entries.length]), [['r1', 3], ['r2', 2], ['r3', 2], [RUN, 2]]);
  assert.deepEqual(runDigest(groupRuns(opened)[0].entries).map((x) => x.kind), ['request', 'reply']);

  // a run on the stream that the list does not know yet comes last; events without their request take it from the list
  assert.deepEqual(groupRuns(teamChatAdapter({ events: live, runs: runs.slice(0, 1) })).map((g) => g.runId), ['r1', RUN]);
  const tail = teamChatAdapter({ events: live.slice(1), runs });
  assert.deepEqual(tail.filter((x) => x.runId === RUN).map((x) => [x.kind, x.text]), [['request', 'How does the CLI parse flags?'], ['agent', 'Looking.']]);
});

test('long messages, redraw keys, labels and what is announced', () => {
  assert.equal(isLong('short'), false);
  assert.equal(isLong(Array.from({ length: 12 }, () => 'line').join('\n')), false);
  assert.equal(isLong(Array.from({ length: 13 }, () => 'line').join('\n')), true);
  assert.equal(isLong('x'.repeat(1201)), true);

  const now = Date.parse('2026-11-11T12:00:00.000Z');
  const out = adapt([START, msg('dwight', 'Hello', { milestoneId: 'm2', cycle: 1 }), tool('dwight', 'ls', '.'),
    ['hitl_request', { milestoneId: 'm2', reason: 'Stuck on m2.', options: ['retry'] }], ['run_reply', { from: 'michael', kind: 'answer', text: 'It is parseArgs.\n\n[ANSWER_READY]' }]]);
  const [request, agent, activity, question, reply] = out;
  assert.match(entryLabel(request, now), /^You, \d\d:\d\d:\d\d$/);
  assert.match(entryLabel(agent, now), /^Dwight, Developer, m2 · cycle 1, \d\d:\d\d:\d\d$/);
  assert.match(entryLabel(question, now), /^Question from Michael, m2, waiting for an answer, \d\d:\d\d:\d\d$/);
  assert.match(entryLabel(reply, now), /^Answer from Michael, \d\d:\d\d:\d\d$/);
  assert.deepEqual([request, agent, activity].map(announcement), ['', '', ''], 'only a reply and a waiting question are announced');
  assert.equal(announcement(question), 'Michael asks: Stuck on m2.');
  assert.equal(announcement({ ...question, tone: null }), '', 'an answered question is not');
  assert.equal(announcement(reply), 'Answer from Michael: It is parseArgs.');

  assert.equal(entryKey(agent), entryKey({ ...agent }));
  assert.notEqual(entryKey(agent), entryKey(agent, true), 'opened and closed are drawn differently');
  assert.notEqual(entryKey(activity), entryKey({ ...activity, text: '2 tools, last: ls .' }));
  assert.notEqual(entryKey(question), entryKey({ ...question, tone: null }));
  const long = { ...agent, text: 'a'.repeat(5000) };
  assert.notEqual(entryKey(long), entryKey({ ...long, text: `${'a'.repeat(4999)}b` }));
  assert.ok(entryKey(long).length < 400, 'a long text is not copied into its key');
});
