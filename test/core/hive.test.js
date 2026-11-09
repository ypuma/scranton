import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EventRecorder } from '../../src/core/events.js';
import { Hive, formatMessage, parseMessage } from '../../src/core/hive.js';
import { initialState, reduce } from '../../src/core/state.js';
import { tempDir } from './helpers.js';

test('messages round-trip through the front-matter header', () => {
  const text = formatMessage({ from: 'dwight', to: 'angela', kind: 'handoff', runId: 'r1', milestone: 'm1', cycle: 2, date: 'D', skipped: null }, '  # Body\n\ntext  ');
  assert.match(text, /^---\nfrom: dwight\nto: angela\nkind: handoff\nrunId: r1\nmilestone: m1\ncycle: 2\ndate: D\n---\n\n# Body/);
  assert.ok(!text.includes('skipped'));
  const parsed = parseMessage(text);
  assert.equal(parsed.header.kind, 'handoff');
  assert.equal(parsed.header.cycle, '2');
  assert.equal(parsed.body, '# Body\n\ntext');
  assert.deepEqual(parseMessage('no header').header, {});
});

test('deliver writes <to>/inbox.md and archives the previous inbox', (t) => {
  const hive = new Hive(tempDir(t));
  hive.init();
  const rel = hive.deliver({ to: 'dwight', from: 'michael', kind: 'task', runId: 'r', milestone: 'm1', cycle: 1, body: 'first' });
  assert.equal(rel, 'dwight/inbox.md');
  hive.deliver({ to: 'dwight', from: 'angela', kind: 'bug_report', runId: 'r', milestone: 'm1', cycle: 1, body: 'second' });
  const inbox = parseMessage(fs.readFileSync(hive.inboxPath('dwight'), 'utf8'));
  assert.equal(inbox.body, 'second');
  assert.equal(inbox.header.from, 'angela');
  const archived = fs.readdirSync(path.join(hive.dir, 'dwight', 'archive'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /michael-task\.md$/);
  assert.equal(parseMessage(fs.readFileSync(path.join(hive.dir, 'dwight', 'archive', archived[0]), 'utf8')).body, 'first');
  hive.deliver({ to: 'dwight', from: 'human', kind: 'feedback', runId: 'r', body: 'third' });
  assert.equal(fs.readdirSync(path.join(hive.dir, 'dwight', 'archive')).length, 2, 'no archive name collisions');
});

test('init creates the mailboxes, session dirs and runs/', (t) => {
  const hive = new Hive(tempDir(t));
  hive.init();
  for (const d of ['michael', 'dwight', 'angela', 'human', 'sessions/michael', 'sessions/dwight', 'sessions/angela', 'runs']) {
    assert.ok(fs.statSync(path.join(hive.dir, d)).isDirectory(), d);
  }
});

test('the reducer follows milestones, cycles, breaker and totals', () => {
  const ev = (seq, type, fields) => ({ v: 1, seq, ts: `2026-01-01T00:00:0${seq}.000Z`, runId: 'r', type, ...fields });
  const events = [
    ev(1, 'run_started', { request: 'q', workspace: '/w', maxFailedCycles: 2 }),
    ev(2, 'plan_ready', { milestones: [{ id: 'm1', title: 'A' }, { id: 'm2', title: 'B' }] }),
    ev(3, 'milestone_started', { milestoneId: 'm1', index: 0, total: 2, title: 'A' }),
    ev(4, 'hive_write', { from: 'michael', to: 'dwight', kind: 'task' }),
    ev(5, 'hive_write', { from: 'dwight', to: 'angela', kind: 'handoff' }),
    ev(6, 'agent_finished', { agent: 'dwight', keyword: 'TASK_COMPLETE', usage: { input: 10, output: 5, cost: 0.5 } }),
    ev(7, 'cycle_result', { milestoneId: 'm1', cycle: 1, result: 'failed', failedCycles: 1 }),
    ev(8, 'hive_write', { from: 'angela', to: 'dwight', kind: 'bug_report' }),
    ev(9, 'cycle_result', { milestoneId: 'm1', cycle: 2, result: 'failed', failedCycles: 2 }),
    ev(10, 'circuit_breaker', { milestoneId: 'm1', state: 'tripped', failedCycles: 2, maxFailedCycles: 2 })
  ];
  let s = events.reduce(reduce, initialState());
  assert.deepEqual([s.status, s.cycle, s.failedCycles, s.breaker, s.currentMilestoneId, s.lastSeq], ['paused', 2, 2, 'tripped', 'm1', 10]);
  assert.deepEqual(s.milestones.map((m) => m.status), ['active', 'pending']);
  assert.deepEqual(s.agents.dwight.totals, { runs: 1, input: 10, output: 5, cost: 0.5 });
  assert.equal(s.agents.dwight.lastKeyword, 'TASK_COMPLETE');
  s = reduce(s, ev(11, 'hitl_response', { decision: 'skip' }));
  s = reduce(s, ev(12, 'milestone_finished', { milestoneId: 'm1', status: 'skipped' }));
  s = reduce(s, ev(13, 'milestone_started', { milestoneId: 'm2', index: 1, total: 2, title: 'B' }));
  assert.deepEqual([s.status, s.cycle, s.failedCycles, s.breaker], ['running', 0, 0, 'closed']);
  assert.deepEqual(s.milestones.map((m) => m.status), ['skipped', 'active']);
  s = reduce(s, ev(14, 'run_finished', { status: 'partial', summary: '' }));
  assert.equal(s.status, 'finished');
  assert.equal(reduce(s, ev(15, 'unknown_future_event', { x: 1 })).lastSeq, 15, 'unknown event types are tolerated');
});

test('EventRecorder: LF-terminated JSONL, escaped U+2028, clipped summaries, atomic state', (t) => {
  const dir = tempDir(t);
  const rec = new EventRecorder({ hiveDir: dir, runId: 'r-test' });
  rec.start();
  rec.emit('run_started', { request: 'a\u2028b', workspace: dir, maxFailedCycles: 3 });
  rec.emit('hive_write', { from: 'human', to: 'michael', file: 'michael/inbox.md', kind: 'plan_request', summary: 'x'.repeat(300) });
  const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(!raw.includes('\u2028'), 'U+2028 is escaped so naive line readers cannot split a record');
  const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.seq), [1, 2]);
  assert.equal(lines[0].request, 'a\u2028b');
  assert.equal(lines[1].summary.length, 140);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.lastSeq, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
});

test('reduce: milestone_finished and run_finished close the breaker and zero failedCycles', () => {
  const ev = (seq, type, fields) => ({ v: 1, seq, ts: `2026-01-01T00:00:0${seq}.000Z`, runId: 'r', type, ...fields });
  const tripped = [
    ev(1, 'run_started', { runId: 'r', request: 'x', workspace: '/w', maxFailedCycles: 2 }),
    ev(2, 'plan_ready', { milestones: [{ id: 'm1', title: 'T' }] }),
    ev(3, 'milestone_started', { milestoneId: 'm1', index: 0, total: 1, title: 'T' }),
    ev(4, 'circuit_breaker', { milestoneId: 'm1', state: 'tripped', failedCycles: 2, maxFailedCycles: 2 })
  ].reduce(reduce, initialState());
  assert.deepEqual([tripped.breaker, tripped.failedCycles], ['tripped', 2]);
  const afterMilestone = reduce(tripped, ev(5, 'milestone_finished', { milestoneId: 'm1', status: 'aborted' }));
  assert.deepEqual([afterMilestone.breaker, afterMilestone.failedCycles], ['closed', 0]);
  const afterRun = reduce(tripped, ev(5, 'run_finished', { status: 'aborted', summary: 's' }));
  assert.deepEqual([afterRun.status, afterRun.breaker, afterRun.failedCycles], ['aborted', 'closed', 0]);
});


test('instance restart clears stale failure activity and tools', () => {
  const started = { type: 'instance_started', instanceId: 'angela-m1', agent: 'angela', milestoneId: 'm1', sessionId: 'session', worktree: '/qa', sandbox: 'host' };
  let state = reduce(initialState(), started);
  state = reduce(state, { type: 'agent_tool', instanceId: 'angela-m1', tool: 'bash' });
  state = reduce(state, { type: 'agent_status', instanceId: 'angela-m1', agent: 'angela', status: 'error', activity: 'Failed: previous attempt' });
  const restarted = reduce(state, started).instances['angela-m1'];
  assert.equal(restarted.status, 'thinking');
  assert.equal(restarted.activity, 'Thinking...');
  assert.equal(restarted.tool, null);
  assert.equal(restarted.sessionId, 'session');
});
