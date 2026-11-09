import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { listRuns, formatThreadContext } from '../../src/core/thread.js';

function fixture(t) {
  const scratch = path.resolve('.scratch/multiproject-thread');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const write = (root, name, value) => {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

test('listRuns reads archives and current events, skips corrupt lines, and keeps final milestone outcomes', (t) => {
  const root = fixture(t);
  const events = (runId, ts, request) => [
    { runId, type: 'run_started', ts, request },
    { runId, type: 'plan_ready', milestones: [{ id: 'm1', title: 'Build API' }, { id: 'm2', title: 'Test API' }] },
    { runId, type: 'milestone_finished', milestoneId: 'm1', status: 'passed' },
    { runId, type: 'milestone_finished', milestoneId: 'm2', status: 'blocked' },
    { runId, type: 'run_finished', ts: ts.replace('00:00', '01:00'), status: 'partial', summary: 'One milestone blocked' }
  ].map(JSON.stringify).join('\n') + '\n{broken\n';
  write(root, 'runs/old/events.jsonl', events('old', '2026-01-01T00:00:00Z', 'First goal'));
  write(root, 'runs/old/state.json', '{broken');
  write(root, 'events.jsonl', events('new', '2026-01-02T00:00:00Z', 'Follow up'));
  write(root, 'michael/plan.json', { runId: 'old', request: 'Wrong root plan', milestones: [{ id: 'm3', title: 'STALE' }] });
  const runs = listRuns(root);
  assert.deepEqual(runs.map((r) => r.runId), ['old', 'new']);
  assert.equal(runs[1].goal, 'Follow up');
  assert.equal(runs[0].status, 'partial');
  assert.match(runs[0].summary, /Outcome: partial — One milestone blocked/);
  assert.match(runs[0].summary, /Build API: passed\n- Test API: blocked/);
  assert.ok(!runs[1].summary.includes('STALE'));
  assert.equal(runs[0].endedAt, '2026-01-01T01:00:00Z');
});

test('listRuns tolerates missing files, bad JSON shapes and state-only histories; matching plan fills missing titles', (t) => {
  const root = fixture(t);
  assert.deepEqual(listRuns(path.join(root, 'missing')), []);
  write(root, 'runs/z/state.json', { runId: 'z', request: 'State only', status: 'failed', updatedAt: '2026-01-01' });
  write(root, 'state.json', { runId: 'current', status: 'planning', milestones: null });
  write(root, 'michael/plan.json', { runId: 'current', request: 'Plan fallback', milestones: [{ id: 'm1', title: 'Plan task' }] });
  write(root, 'events.jsonl', 'null\n42\n{}\n[]\n');
  const runs = listRuns(root);
  assert.equal(runs.length, 2);
  const current = runs.find((r) => r.runId === 'current');
  assert.equal(current.goal, 'Plan fallback');
  assert.match(current.summary, /Plan task: pending/);
  assert.equal(runs.find((r) => r.runId === 'z').endedAt, '2026-01-01');
});

test('summaries and context are bounded and trimming keeps newest complete lines', (t) => {
  const root = fixture(t);
  write(root, 'state.json', { runId: 'huge', request: 'Goal', status: 'running', milestones: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, title: 'x'.repeat(500), status: 'passed' })) });
  assert.ok(listRuns(root)[0].summary.length <= 1500);
  const runs = ['old', 'middle', 'new'].map((runId) => ({ runId, goal: runId, status: 'success', summary: 'Outcome: success\n- Done: passed' }));
  const newest = formatThreadContext(runs.slice(-1));
  assert.equal(formatThreadContext(runs, { maxChars: newest.length }), newest);
  const context = formatThreadContext(runs, { maxChars: newest.length + 10 });
  assert.equal(context, newest);
  assert.equal(formatThreadContext(runs, { maxChars: 0 }), '');
  assert.equal(formatThreadContext([], {}), '');
  assert.ok(formatThreadContext(runs).indexOf('Run old') < formatThreadContext(runs).indexOf('Run new'));
});
