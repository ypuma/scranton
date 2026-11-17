import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHiveSource, parseEventLines, selectRunEvents } from '../../src/dashboard/source.js';

const ev = (runId, seq, type = 'log', extra = {}) => ({ v: 1, seq, ts: new Date(Date.UTC(2025, 5, 14, 10, 0, seq)).toISOString(), runId, type, ...extra });
const line = (e) => JSON.stringify(e) + '\n';

async function tempHive(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scranton-dash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('parseEventLines skips invalid JSON, unknown types and the unterminated last line', () => {
  const text = [
    line(ev('r1', 1, 'run_started', { request: 'x', workspace: '/w', maxFailedCycles: 3 })),
    '{not json}\n',
    line(ev('r1', 2, 'mystery_event')),
    '[1,2,3]\n',
    line({ v: 1, ts: 'x', runId: 'r1', type: 'log' }),
    '\n',
    line(ev('r1', 3, 'log', { level: 'info', message: 'ok', extraField: true })),
    '{"v":1,"seq":4,"ts":"2025',
  ].join('');
  const events = parseEventLines(text);
  assert.deepEqual(events.map((e) => e.seq), [1, 3]);
  assert.deepEqual(parseEventLines('{"v":1,"seq":9,"runId":"r1","type":"log"}\n' + line(ev('r1', 10)), { dropFirst: true }).map((e) => e.seq), [10]);
});

test('selectRunEvents keeps one run, in seq order, without replayed duplicates', () => {
  const list = [ev('old', 1, 'run_started'), ev('old', 2), ev('new', 1, 'run_started'), ev('new', 3), ev('new', 2), ev('new', 3), ev('old', 3)];
  assert.deepEqual(selectRunEvents(list, 'new').map((e) => `${e.runId}:${e.seq}`), ['new:1', 'new:2', 'new:3']);
  assert.deepEqual(selectRunEvents(list, null).map((e) => e.runId), ['new', 'new', 'new']);
  assert.deepEqual(selectRunEvents([ev('x', 5), ev('x', 6)], null).map((e) => e.seq), [5, 6]);
  assert.deepEqual(selectRunEvents([], 'r'), []);
});

test('missing hive: idle, nothing crashes', async (t) => {
  const dir = await tempHive(t);
  const source = createHiveSource(path.join(dir, 'does-not-exist'));
  await source.poll();
  assert.equal(source.state, null);
  assert.deepEqual(source.events, []);
});

test('keeps the last good state when state.json is momentarily invalid, idle once it is gone', async (t) => {
  const dir = await tempHive(t);
  const statePath = path.join(dir, 'state.json');
  const source = createHiveSource(dir);
  await writeFile(statePath, JSON.stringify({ v: 1, runId: 'r1', status: 'running' }));
  assert.equal(await source.poll(), true);
  assert.equal(source.state.status, 'running');
  await writeFile(statePath, '{"v":1,"runId":"r1","sta');
  assert.equal(await source.poll(), false);
  assert.equal(source.state.status, 'running');
  await writeFile(statePath + '.tmp', JSON.stringify({ v: 1, runId: 'r1', status: 'paused' }));
  await rename(statePath + '.tmp', statePath);
  assert.equal(await source.poll(), true);
  assert.equal(source.state.status, 'paused');
  assert.equal(await source.poll(), false, 'unchanged files must not report a change');
  await rm(statePath);
  assert.equal(await source.poll(), true);
  assert.equal(source.state, null);
});

test('reads only the tail of a large events.jsonl and follows appends', async (t) => {
  const dir = await tempHive(t);
  const file = path.join(dir, 'events.jsonl');
  let text = line(ev('r1', 1, 'run_started', { request: 'x', workspace: '/w', maxFailedCycles: 3 }));
  for (let seq = 2; seq <= 3000; seq++) text += line(ev('r1', seq, 'log', { level: 'info', message: 'padding '.repeat(4) }));
  await writeFile(file, text);
  const source = createHiveSource(dir, { tailBytes: 4096 });
  await source.poll();
  assert.ok(source.events.length > 0 && source.events.length < 60, `read ${source.events.length} events`);
  assert.equal(source.events.at(-1).seq, 3000);
  const window = source.events.slice(1);
  assert.ok(window.every((e, i) => i === 0 || e.seq === window[i - 1].seq + 1), 'tail must not contain a broken first line');

  await appendFile(file, '{"v":1,"seq":3001,"ts":"2025-06-');
  await source.poll();
  assert.equal(source.events.at(-1).seq, 3000);
  await appendFile(file, '14T10:00:00Z","runId":"r1","type":"log","level":"warn","message":"done"}\n');
  assert.equal(await source.poll(), true);
  assert.equal(source.events.at(-1).seq, 3001);
});

test('run_started stays known after it scrolled out of the tail window', async (t) => {
  const dir = await tempHive(t);
  const file = path.join(dir, 'events.jsonl');
  const started = (runId) => ev(runId, 1, 'run_started', { request: `request ${runId}`, workspace: '/w', maxFailedCycles: 3 });
  let text = line(started('r1'));
  for (let seq = 2; seq <= 400; seq++) text += line(ev('r1', seq, 'log', { level: 'info', message: 'padding '.repeat(30) }));
  await writeFile(file, text);
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ v: 1, runId: 'r1', status: 'running' }));
  const source = createHiveSource(dir, { tailBytes: 8192, maxEvents: 20 });
  await source.poll();
  assert.equal(source.events[0].type, 'run_started');
  assert.equal(source.events[0].request, 'request r1');
  assert.equal(source.events.at(-1).seq, 400);
  assert.ok(source.events.length <= 21);

  await appendFile(file, line(ev('r1', 401)));
  await source.poll();
  assert.deepEqual([source.events[0].seq, source.events.at(-1).seq], [1, 401]);

  text = line(started('r2'));
  for (let seq = 2; seq <= 300; seq++) text += line(ev('r2', seq, 'log', { level: 'info', message: 'padding '.repeat(30) }));
  await writeFile(file, text);
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ v: 1, runId: 'r2', status: 'running' }));
  await source.poll();
  assert.equal(source.events[0].request, 'request r2', 'a new run re-reads the head');
  assert.ok(source.events.every((e) => e.runId === 'r2'));
});

test('a replaced events file (new run) resets the view to the new run', async (t) => {
  const dir = await tempHive(t);
  const file = path.join(dir, 'events.jsonl');
  await writeFile(file, [ev('r1', 1, 'run_started'), ev('r1', 2), ev('r1', 3)].map(line).join(''));
  const source = createHiveSource(dir);
  await source.poll();
  assert.equal(source.events.length, 3);
  await writeFile(file, line(ev('r2', 1, 'run_started')));
  await source.poll();
  assert.deepEqual(source.events.map((e) => `${e.runId}:${e.seq}`), ['r2:1']);
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ v: 1, runId: 'r1', status: 'running' }));
  await source.poll();
  assert.deepEqual(source.events, [], 'events of other runs than state.runId are dropped');
});

test('per-call usage traffic does not evict conversation activity', async t => {
  const { mkdir } = await import('node:fs/promises');
  const root = path.resolve('.scratch/live-activity'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'dashboard-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const started = ev('usage-run', 1, 'run_started', { execution: { conversation: true } });
  const activity = ev('usage-run', 2, 'agent_tool', { agent: 'dwight', tool: 'write', detail: 'a.js' });
  const usage = Array.from({ length: 700 }, (_, i) => ev('usage-run', i + 3, 'agent_usage', { agent: 'dwight', usage: { input: 1, output: 1, cost: 0 } }));
  await writeFile(path.join(dir, 'events.jsonl'), [started, activity, ...usage].map(line).join(''));
  const source = createHiveSource(dir, { maxEvents: 5, tailBytes: 512 }); await source.poll();
  assert.ok(source.events.some(e => e.seq === 2));
  assert.equal(source.events.some(e => e.type === 'agent_usage'), false);
});

test('usage traffic consumes neither byte nor row budget outside conversation mode', async t => {
  const { mkdir } = await import('node:fs/promises');
  const root = path.resolve('.scratch/live-backend-fix'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tail-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const visible = Array.from({ length: 8 }, (_, i) => ev('r', i + 1, 'log', { message: 'visible '.repeat(4) }));
  await writeFile(file, visible.map(line).join(''));
  const source = createHiveSource(dir, { tailBytes: 2048, maxEvents: 8 }); await source.poll();
  assert.deepEqual(source.events, visible);
  for (let i = 0; i < 3; i++) {
    await appendFile(file, Array.from({ length: 400 }, (_, j) => line(ev('r', 9 + i * 400 + j, 'agent_usage', { usage: { input: 1, output: 1, cost: 0 } }))).join(''));
    await source.poll(); assert.deepEqual(source.events, visible, 'all eight visible rows survive usage-only appends');
  }
  const fresh = createHiveSource(dir, { tailBytes: 2048, maxEvents: 8 }); await fresh.poll();
  assert.deepEqual(fresh.events, visible, 'same budget on initial historical read');
});

// Regression anchor: createHiveSource's headBytes default must be 262144, not 16384.
test('run_started with a 32768-character escaped request stays pinned beyond the tail', async t => {
  const { mkdir } = await import('node:fs/promises');
  const root = path.resolve('.scratch/context-budget/a2'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'dashboard-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const request = '\u0001'.repeat(32768), started = ev('long', 1, 'run_started', { request });
  const padding = Array.from({ length: 400 }, (_, i) => ev('long', i + 2, 'log', { message: 'padding '.repeat(30) }));
  await writeFile(path.join(dir, 'events.jsonl'), [started, ...padding].map(line).join(''));
  const source = createHiveSource(dir, { tailBytes: 4096, maxEvents: 5 }); await source.poll();
  assert.deepEqual(source.events[0], started); assert.equal(source.events.at(-1).seq, 401);
  assert.ok(source.events.length <= 5);
});
