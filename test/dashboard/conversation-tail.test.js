import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHiveSource } from '../../src/dashboard/source.js';
import { renderDashboard } from '../../src/dashboard/render.js';

const root = path.resolve('.scratch/chat-backend-fix/dashboard');
test('large assistant lines never evict visible events, including cold load, incremental append and replacement', async (t) => {
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  const state = { v: 1, runId: 'conversation', status: 'running', execution: { conversation: true }, agents: {}, milestones: [] };
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  let seq = 0;
  const event = (type, fields = {}) => JSON.stringify({ v: 1, runId: state.runId, seq: ++seq, ts: '2026-01-01T00:00:00Z', type, ...fields }) + '\n';
  const start = event('run_started', { execution: state.execution });
  const visible = event('log', { level: 'info', message: 'VISIBLE_BEFORE_MESSAGES' });
  const messages = Array.from({ length: 9 }, () => event('agent_message', { agent: 'dwight', text: 'x'.repeat(16000), final: false })).join('');
  const ending = event('log', { level: 'info', message: 'VISIBLE_AFTER_MESSAGES' });
  await writeFile(file, start + visible + messages + ending);
  const source = createHiveSource(dir); await source.poll();
  assert.ok(source.events.some(e => e.message === 'VISIBLE_BEFORE_MESSAGES'), 'large assistant bodies do not evict earlier visible log events');
  assert.ok(source.events.some(e => e.message === 'VISIBLE_AFTER_MESSAGES'));
  const frame = renderDashboard(source.state, source.events, { width: 120, height: 40, color: false, ascii: true });
  assert.match(frame, /VISIBLE_BEFORE_MESSAGES/); assert.match(frame, /VISIBLE_AFTER_MESSAGES/);
  await appendFile(file, messages + event('log', { level: 'info', message: 'APPENDED' })); await source.poll();
  assert.ok(source.events.some(e => e.message === 'VISIBLE_BEFORE_MESSAGES'), 'incremental message traffic preserves visible tail');
  assert.ok(source.events.some(e => e.message === 'APPENDED'));
  state.runId = 'replacement'; seq = 0;
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(file, event('run_started', { execution: state.execution }) + event('log', { level: 'info', message: 'NEW_RUN' })); await source.poll();
  assert.deepEqual(source.events.map(e => e.runId), ['replacement', 'replacement']);
  assert.equal(source.events.some(e => e.message === 'VISIBLE_BEFORE_MESSAGES'), false);
});

test('off-mode source renders the exact original byte-tail selection', async (t) => {
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'off-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = Array.from({ length: 100 }, (_, i) => ({ v: 1, runId: 'off', seq: i + 1, ts: '2026-01-01T00:00:00Z', type: i ? 'log' : 'run_started', level: 'info', message: String(i).repeat(100) }));
  await writeFile(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
  const source = createHiveSource(dir, { tailBytes: 1000 }); await source.poll();
  const text = events.map(e => JSON.stringify(e) + '\n').join('');
  const tail = text.slice(-(1001)).split('\n').slice(1, -1).map(JSON.parse);
  assert.deepEqual(source.events, [events[0], ...tail], 'off-mode keeps original head plus byte-tail events');
});
