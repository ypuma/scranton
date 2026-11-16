// What a run that is over says about itself: one status per agent that matches the outcome, every thing once in the
// conversation, and an event log that leaves the status ticks out until they are asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduceAll, settledStatus, roleView } from '../../visualizer/public/js/state.js';
import { teamRunView } from '../../visualizer/public/js/activity-model.js';
import { teamChatAdapter } from '../../visualizer/public/js/chat-adapter-team.js';
import { typeLabel, rowCategory } from '../../visualizer/public/js/log.js';

const read = (file) => readFileSync(new URL(`../../visualizer/public/${file}`, import.meta.url), 'utf8');

const SAID = 'I will build the site at the workspace root.';
// a run stopped by the human while its developer was in its first turn
function abortedRun() {
  let seq = 0;
  const ev = (type, rest = {}) => ({ v: 1, seq: ++seq, ts: `2026-11-16T01:10:${String(seq).padStart(2, '0')}Z`, runId: 'r1', type, ...rest });
  return [
    ev('run_started', { request: 'Create a website.' }),
    ev('instance_started', { agent: 'michael', instanceId: 'michael', milestoneId: 'plan' }),
    ev('agent_status', { agent: 'michael', instanceId: 'michael', status: 'thinking', activity: 'Thinking...' }),
    ev('agent_finished', { agent: 'michael', instanceId: 'michael', keyword: 'PLAN_READY', exitCode: 0, durationMs: 1000 }),
    ev('plan_ready', { milestones: [{ id: 'm1', title: 'Site' }] }),
    ev('milestone_started', { milestoneId: 'm1', title: 'Site', index: 0, total: 1 }),
    ev('instance_started', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1' }),
    ev('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'thinking', activity: 'Thinking...' }),
    ev('agent_message', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, text: SAID, final: false }),
    ev('agent_tool', { agent: 'dwight', instanceId: 'dwight-m1', tool: 'write', detail: 'index.html' }),
    ev('agent_message', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, text: SAID, final: true }),
    ev('agent_finished', { agent: 'dwight', instanceId: 'dwight-m1', milestoneId: 'm1', cycle: 1, keyword: null, exitCode: 1, durationMs: 9000 }),
    ev('agent_status', { agent: 'dwight', instanceId: 'dwight-m1', status: 'error', activity: 'Failed: Pi run interrupted' }),
    ev('milestone_finished', { milestoneId: 'm1', status: 'aborted' }),
    ev('agent_status', { agent: 'dwight', status: 'idle', activity: 'Idle' }),
    ev('run_reply', { from: 'system', kind: 'summary', text: 'Run finished with status "aborted": Interrupted by stop request\n- m1 Site: aborted (cycle 1)\nRequest: Create a website.' }),
    ev('run_finished', { status: 'aborted', summary: 'Interrupted by stop request' }),
  ];
}

test('status: a lane that is over says how it ended, and a role the run never called says so', () => {
  const state = reduceAll(abortedRun());
  assert.equal(state.instances['dwight-m1'].status, 'done', 'the reducer keeps its word, as state.json does');
  assert.equal(settledStatus(state, state.instances['dwight-m1']), 'stopped');
  assert.equal(settledStatus(state, state.instances.michael), 'done');
  assert.deepEqual(['michael', 'dwight', 'oscar', 'angela'].map((id) => settledStatus(state, roleView(state, id), { role: true })), ['done', 'stopped', 'unused', 'unused']);

  const agents = teamRunView({ state }).agents;
  assert.deepEqual(agents.map((a) => [a.id, a.status, a.line]), [['michael', 'done', 'Finished: PLAN_READY'], ['dwight-m1', 'stopped', 'Pi run interrupted']],
    'never a check mark and "Done" above a failure');

  // the same failure in a run that went on is a failure, not a stop; a run that is going keeps its words
  const failed = reduceAll(abortedRun().slice(0, 14).map((e) => (e.type === 'milestone_finished' ? { ...e, status: 'failed' } : e)));
  assert.equal(settledStatus(failed, failed.instances['dwight-m1']), 'failed');
  assert.equal(settledStatus(failed, roleView(failed, 'oscar'), { role: true }), 'idle', 'a gate that still waits is not unused');
  const going = reduceAll(abortedRun().slice(0, 9));
  assert.equal(settledStatus(going, going.instances['dwight-m1']), 'thinking');

  assert.match(read('js/dashboard.js'), /live: 'Connected'/, 'the connection is not called Live beside a run that ended');
  assert.match(read('js/run-rail.js'), /say\(e\.agentsTitle, view\.live \? 'Agents now' : 'Agents'\);/);
  const css = read('styles.css');
  assert.match(css, /\.agent\[data-status="failed"\] \.status \{ color: var\(--bad\); font-weight: 600; \}/);
  assert.match(css, /\.act\[data-status="stopped"\] :is\(\.act-glyph, \.act-status\) \{ color: var\(--warn\); \}/);
});

test('chat: a repeated final message, the request and the status are each said once', () => {
  const events = abortedRun();
  const entries = teamChatAdapter({ events, state: reduceAll(events) });
  const said = entries.filter((x) => x.kind === 'agent' && x.text === SAID);
  assert.equal(said.length, 1, 'the final message that repeats the turn\'s words is not a second message');
  assert.equal(said[0].final, true);
  assert.equal(entries.some((x) => x.kind === 'activity' && /^m1 aborted/.test(x.text)), false, 'the reply names the aborted milestone');
  const reply = entries.at(-1);
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.text, 'Interrupted by stop request\n- m1 Site: aborted (cycle 1)');
  assert.match(reply.context, /^Aborted · 0\/1 milestones/);

  // different words, another cycle, or a reason of its own: nothing is dropped
  const other = events.map((e) => (e.type === 'agent_message' && e.final ? { ...e, text: 'Done.' } : e.type === 'milestone_finished' ? { ...e, reason: 'tests never ran' } : e));
  const kept = teamChatAdapter({ events: other, state: reduceAll(other) });
  assert.equal(kept.filter((x) => x.kind === 'agent').length, 2);
  assert.ok(kept.some((x) => x.kind === 'activity' && x.text === 'm1 aborted: tests never ran'));
  // an agent's own reply is never rewritten, and a summary that is only the status line stays as it is
  const own = events.map((e) => (e.type === 'run_reply' ? { ...e, from: 'michael', kind: 'report' } : e));
  assert.match(teamChatAdapter({ events: own, state: reduceAll(own) }).at(-1).text, /^Run finished with status/);
  const bare = events.map((e) => (e.type === 'run_reply' ? { ...e, text: 'Run finished with status "aborted": ' } : e));
  assert.equal(teamChatAdapter({ events: bare, state: reduceAll(bare) }).at(-1).text, 'Run finished with status "aborted": ');
});

test('event log: plain words for the types, and Key events leaves the status ticks out', () => {
  assert.deepEqual(['agent_status', 'milestone_finished', 'agent_finished', 'hive_write', 'something_new'].map(typeLabel), ['Status', 'Milestone', 'Turn ended', 'Handoff', 'something new']);
  const log = reduceAll(abortedRun()).log;
  const cats = log.map(rowCategory);
  assert.ok(cats.includes('ticks'));
  for (const [i, e] of log.entries()) {
    if (e.type === 'agent_status') assert.equal(cats[i], e.tone === 'muted' ? 'ticks' : e.category, 'an error or a block is no tick');
    else assert.equal(cats[i], e.category);
  }
  const html = read('index.html');
  assert.match(html, /<button type="button" class="seg" data-filter="main" aria-pressed="true"[^>]*>Key events<\/button>\s*<button type="button" class="seg" data-filter="all" aria-pressed="false">All <span class="seg-count" data-count="all">0<\/span><\/button>/);
  assert.match(read('styles.css'), /\.log\[data-filter="main"\] tbody tr\[data-cat="ticks"\],/);
  assert.match(read('js/log.js'), /f === 'main' \? tr\.dataset\.cat !== 'ticks' : tr\.dataset\.cat === f/, 'the keyboard skips what the filter hides');
});
