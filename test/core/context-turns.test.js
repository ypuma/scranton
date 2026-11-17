import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readTurns } from '../../src/core/context/turns.js';
import { listRuns, listContextRuns } from '../../src/core/thread.js';

function fixture(t, engine = 'team') {
  const base = path.resolve('.scratch/context-system/lane-a'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'turns-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const chat = { id: 'chat', engine, hiveDir: path.join(dataDir, 'hive') }, scope = { dataDir, projectId: 'project', chat };
  const root = engine === 'team' ? chat.hiveDir : path.join(dataDir, 'projects/project/chats/chat/pipeline');
  const write = (name, value) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
  return { scope, root, write };
}
const journal = (id, request, finish = true) => [{ runId: id, type: 'run_started', request, ts: '2026-01-01T00:00:00Z' },
  { runId: id, type: 'plan_ready', milestones: [{ id: 'm1', title: 'Build this' }] }, { runId: id, type: 'milestone_finished', milestoneId: 'm1', status: 'passed' },
  ...['src/a.js', 'src/a.js', '/etc/private', 'C:\\private', '../escape', 'src/b.js'].map((targetFile) => ({ runId: id, type: 'agent_tool', agent: 'dwight', instanceId: 'dwight-m1', tool: 'edit', targetFile })),
  { runId: id, type: 'agent_tool', agent: 'angela', tool: 'write', targetFile: 'gate.js' },
  { runId: id, type: 'run_reply', kind: 'report', text: 'x'.repeat(17000) }, ...(finish ? [{ runId: id, type: 'run_finished', ts: '2026-01-01T01:00:00Z', status: 'success', summary: 'Delivered' }] : [])].map(JSON.stringify).join('\n') + '\n';
// Anchors: readRun's separate context projection (not listRuns), readTurns terminal filter/fallbacks,
// hardened boundedRead, live-root exclusion, mtime selection and per-pack byte charging.
test('Team structured turns preserve legacy listRuns fields while retaining plan, developer files and 16000-char reply', (t) => {
  const f = fixture(t); f.write('events.jsonl', journal('run1', 'Build')); const before = listRuns(f.root);
  const r = readTurns(f.scope).turns[0];
  assert.equal(r.reply.text.length, 16000); assert.equal(r.reply.truncated, true); assert.deepEqual(r.plan, [{ title: 'Build this', status: 'passed' }]);
  assert.deepEqual(r.files, ['src/a.js', 'src/b.js']); assert.equal(r.outcome, 'Delivered'); assert.equal(r.index, 1);
  assert.deepEqual(listRuns(f.root), before); assert.equal(before[0].reply.text.length, 4000);
  assert.deepEqual(Object.keys(before[0]), ['runId', 'goal', 'status', 'reply', 'usage', 'startedAt', 'endedAt', 'summary']);
  f.write('events.jsonl', journal('run1', 'Updated request')); assert.equal(readTurns(f.scope).turns[0].request, 'Updated request');
});
test('Team interrupted turn remains for a new start, but inspect and siblings exclude leased incomplete root only', (t) => {
  const f = fixture(t); f.write('events.jsonl', journal('unfinished', 'In progress', false)); f.write('control/owner.json', { v: 1, runId: 'new-run', token: 'token' });
  assert.equal(readTurns(f.scope).turns[0].status, 'interrupted');
  assert.deepEqual(readTurns({ ...f.scope, inspect: true }).turns, []); assert.deepEqual(readTurns({ ...f.scope, sibling: true }).turns, []);
  assert.deepEqual(readTurns({ ...f.scope, activeRunId: 'unfinished' }).turns, []);
  f.write('events.jsonl', journal('unfinished', 'Finished now')); assert.equal(readTurns({ ...f.scope, inspect: true }).turns.length, 1);
});
test('Team linked hive/ancestor/plan and hardlinked journal cannot inject context; other runs survive', (t) => {
  const f = fixture(t); f.write('runs/good/events.jsonl', journal('good', 'GOOD')); const victim = f.write('victim/events.jsonl', journal('bad', 'LINK-POISON'));
  fs.symlinkSync(path.dirname(victim), path.join(f.root, 'runs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const dir = path.join(f.root, 'runs/hard'); fs.mkdirSync(dir); fs.linkSync(victim, path.join(dir, 'events.jsonl'));
  const linkedHive = path.join(f.scope.dataDir, 'linked-hive'); fs.symlinkSync(f.root, linkedHive, process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotMatch(JSON.stringify(readTurns(f.scope)), /LINK-POISON/); assert.deepEqual(readTurns({ ...f.scope, chat: { ...f.scope.chat, hiveDir: linkedHive } }).turns, []);
  f.write('runs/good/state.json', { runId: 'good', status: 'finished' }); f.write('plans/plan.json', { runId: 'good', milestones: [{ id: 'injected', title: 'LINKED-PLAN' }] });
  fs.symlinkSync(path.join(f.root, 'plans'), path.join(f.root, 'runs/good/michael'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readTurns(f.scope).turns.some((r) => r.request === 'GOOD'), true); assert.doesNotMatch(JSON.stringify(readTurns(f.scope)), /LINKED-PLAN/);
});
test('Pipeline derives only terminal turns and independently degrades missing/corrupt/oversized/linked artifacts', (t) => {
  const f = fixture(t, 'pipeline');
  f.write('runs/run1/status.json', { status: 'succeeded', created_at: '2026-01-01', updated_at: '2026-01-02', task: 'Status fallback' });
  f.write('runs/run1/run.json', { task: 'Original task' }); f.write('runs/run1/artifacts/plan.json', { steps: [{ title: 'Repair' }] });
  f.write('runs/run1/delivery/report.json', { changed_files: [{ path: 'calculator.py' }, { path: '../secret' }, { path: '/private' }] }); f.write('runs/run1/delivery/reply.json', { from: 'planner', kind: 'answer', text: 'Done' });
  f.write('runs/busy/status.json', { status: 'suspended', created_at: '2026-01-03' });
  let r = readTurns(f.scope).turns; assert.equal(r.length, 1); assert.equal(r[0].request, 'Original task'); assert.deepEqual(r[0].files, ['calculator.py']); assert.equal(r[0].reply.text, 'Done'); assert.equal(r[0].plan[0].title, 'Repair');
  f.write('runs/run1/run.json', ' '.repeat(262145)); f.write('runs/run1/artifacts/plan.json', '{bad'); fs.rmSync(path.join(f.root, 'runs/run1/delivery/reply.json'));
  r = readTurns(f.scope).turns[0]; assert.equal(r.request, 'Status fallback'); assert.deepEqual(r.plan, []); assert.equal(r.reply, null); assert.deepEqual(r.files, ['calculator.py']);
  const target = path.join(f.root, 'outside'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'plan.json'), JSON.stringify({ steps: [{ title: 'LINKED' }] }));
  fs.rmSync(path.join(f.root, 'runs/run1/artifacts'), { recursive: true }); fs.symlinkSync(target, path.join(f.root, 'runs/run1/artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(readTurns(f.scope).turns[0].plan, []);
  f.write('runs/run2/status.json', { status: 'failed', created_at: 42, updated_at: {} }); assert.doesNotThrow(() => readTurns(f.scope));
  assert.equal(readTurns(f.scope).turns.find((r) => r.id === 'run2').startedAt, null);
  fs.rmSync(path.join(f.root, 'runs/run1/run.json')); f.write('requests/run1.json.launch.json', { task: 'Launch fallback' }); assert.equal(readTurns(f.scope).turns[0].request, 'Launch fallback');
});
test('newest directory mtime wins scan bound; cache hits charge same bytes and unread runs are counted', (t) => {
  const f = fixture(t);
  for (const [id, stamp] of [['z-old', 1], ['a-new', 3], ['m-mid', 2]]) { f.write(`runs/${id}/events.jsonl`, journal(id, id)); fs.utimesSync(path.join(f.root, 'runs', id), stamp, stamp); }
  const a = listContextRuns(f.root, { maxRuns: 2 }); assert.deepEqual(a.runs.map((r) => r.id), ['a-new', 'm-mid']); assert.equal(a.unread, 1);
  const budget = { bytes: 0 }, b = listContextRuns(f.root, { budget }); assert.equal(b.runs.length, 0); assert.equal(b.unread, 3); assert.equal(b.truncated, true);
  assert.deepEqual(listContextRuns(f.root, { maxRuns: 2 }), a);
});

test('per-pack 64 MiB budget is enforced across large Team journals, including warm-cache rebuilds', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) { const dir = `runs/run${i}`; f.write(`${dir}/events.jsonl`, ' '.repeat(17 * 1024 * 1024) + '\n' + journal(`run${i}`, `LARGE-${i}`)); fs.utimesSync(path.join(f.root, dir), i + 1, i + 1); }
  const a = readTurns(f.scope), b = readTurns(f.scope);
  assert.equal(a.turns.length, 3); assert.equal(a.unread, 1); assert.equal(a.total, 4); assert.equal(a.truncated, true); assert.deepEqual(b, a);
});
