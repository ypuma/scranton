import '../isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createLiveActivity } from '../../../src/core/live-activity.js';
import { createStreamTail } from '../../../visualizer/public/js/agent-stream.js';
import { streamAnswer } from '../../../src/core/cli-live.js';
import path from 'node:path';
import { deserialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { createDurableRuntime } from '../../../src/core/durable/index.js';
import { createLLM } from '../../../src/core/llm/index.js';
import { startAgent, readAgentHistory, readAgentOutput } from '../../../src/core/agent/index.js';
import { Orchestrator } from '../../../src/core/orchestrator.js';
import { fakeConfig, readEvents } from '../helpers.js';
import { model, sse, authFor } from '../llm/helpers.js';

async function setup(t, fetcher, orchestrate = false, retrySeconds = 0.001) {
  const base = path.resolve('.scratch/stream-errors'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'agent-'));
  const databasePath = path.join(dir, 'db.sqlite');
  const runtime = await createDurableRuntime({ databasePath, markerDir: path.join(dir, 'markers'), env: {} });
  t.after(async () => { await runtime.shutdown(); activity.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const live = [], discarded = [];
  const activity = createLiveActivity(dir, 'stream-test');

  const options = { runtime, llm: createLLM({ fetcher, resolveAuth: () => authFor('openai-responses') }),
    model: model('openai-responses', 'https://example.test'), cwd: dir, hiveDir: dir, runId: 'stream-test', instanceId: 'dwight-m1',
    agentId: 'dwight', message: 'Task', agentConfig: { tools: [], keywords: ['TASK_COMPLETE'] }, retrySeconds,
    onLive: r => { live.push(r); activity.update('dwight-m1', 'dwight', r);
      if (r.discard) discarded.push(readThoughts()); } };
  const readThoughts = () => { try { return readFileSync(path.join(dir, 'thoughts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  let runner, events;
  if (orchestrate) {
    const config = fakeConfig(dir); delete config.scripted;
    const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', startRunner: input => {
      runner = startAgent({ ...input, ...options }); return runner;
    } });
    await o.run('Exercise stream failure');
    events = readEvents(config.hiveDir);
  } else runner = startAgent(options);
  return { runtime, runner, live, databasePath, events, activity, readThoughts, discarded };
}
const partial = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'FAILED_THINKING' },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
  { type: 'response.output_text.delta', output_index: 1, delta: 'FAILED_TEXT' },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'bad', name: 'read' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":"FAILED_TOOL' },
];
test('failed partial attempt is superseded in durable readers and live consumers without duplicates', async t => {
  let calls = 0, flushedBeforeFailure = false;
  const f = await setup(t, async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ async start(c) {
      c.enqueue(new TextEncoder().encode(sse(partial))); await new Promise(r => setTimeout(r, 130));
      c.enqueue(new TextEncoder().encode(sse([{ type: 'response.output_text.delta', output_index: 1, delta: '_MORE' }])));
      await new Promise(r => setTimeout(r, 30));
      flushedBeforeFailure = f.runtime.db.prepare('SELECT value FROM streams WHERE workflow=? AND key=?').all(f.runner.workflowId, 'output')
        .some(r => deserialize(r.value)?.delta?.includes('FAILED_TEXT'));
      c.enqueue(new TextEncoder().encode(sse([{ type: 'error', code: 'server_error', message: 'Busy' }]))); c.close();
    } }));
    return new Response(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Clean [TASK_COMPLETE]' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]));
  });
  const result = await f.runner.done;
  assert.equal(result.ok, true); assert.equal(calls, 2);
  const output = []; for await (const row of f.runtime.readStream(f.runner.workflowId, 'output')) output.push(row.value);
  assert.deepEqual(output.filter(r => r.type === 'attempt_start').map(r => r.attempt), [1, 2]);
  assert.equal(flushedBeforeFailure, true, '100 ms flush publishes before the attempt ends');
  assert.match(output.map(r => r.delta ?? '').join(''), /FAILED_TEXT_MORE/, 'raw failed chunks remain durable');
  const firstDelta = f.live.findIndex(r => r.assistantMessageEvent?.delta === 'FAILED_TEXT');
  assert.ok(firstDelta >= 0 && firstDelta < f.live.findIndex(r => r.discard), 'live deltas precede failure');
  assert.equal(f.live.filter(r => r.assistantMessageEvent?.delta === 'Clean [TASK_COMPLETE]').length, 1);
  assert.equal((await readAgentOutput(f.runtime, f.runner.workflowId)).map(r => r.delta ?? '').join(''), 'Clean [TASK_COMPLETE]', 'durable reader supersedes partial output');
  assert.deepEqual(f.discarded, [[]], 'discard does not save failed unsaved blocks');
  assert.deepEqual(f.readThoughts().map(r => r.text), ['Clean [TASK_COMPLETE]'], 'live consumer saves only successful output');
  assert.doesNotMatch(JSON.stringify(await readAgentHistory(f.runtime, f.runner.workflowId)), /FAILED_/);
  const tail = createStreamTail(); for (const row of output) tail.push(row);
  assert.equal(tail.instance('dwight').text, 'Clean [TASK_COMPLETE]');
  assert.equal(tail.instance('dwight').thinking, null);
  let printed = ''; await streamAnswer(f.runtime, f.runner.workflowId, { stdout: { write: s => { printed += s; } } });
  assert.equal(printed, '[' + f.runner.workflowId + '] Clean [TASK_COMPLETE]\n');

});
test('provider diagnostic reaches workflow failure, terminal state, output and operations.error', async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; return new Response(sse([{ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'Plan exhausted' } } }])); }, true);
  const result = await f.runner.done;
  const expected = 'Provider stream error (insufficient_quota): Plan exhausted';
  assert.equal(result.failure.message, expected); assert.equal(calls, 1);
  assert.ok(f.events.some(e => JSON.stringify(e).includes(`Dwight could not run: ${expected}`)), JSON.stringify(f.events));
  assert.equal((await f.runtime.getEvent(f.runner.workflowId, 'agent_state')).detail.message, expected);
  const rows = []; for await (const r of f.runtime.readStream(f.runner.workflowId, 'output')) rows.push(r.value);
  assert.ok(rows.some(r => r.type === 'error' && r.message === expected));
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try { assert.match(JSON.stringify(db.prepare('SELECT error FROM operations WHERE error IS NOT NULL').all().map(row => deserialize(row.error))), /Provider stream error.*insufficient_quota.*Plan exhausted/); }
  finally { db.close(); }
});

test('caller-aborted partial thoughts are retained', async t => {
  let release;
  const ready = new Promise(r => { release = r; });
  const f = await setup(t, async (_url, options) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse(partial.slice(0, 2))));
      options.signal.addEventListener('abort', () => c.error(options.signal.reason), { once: true });
      setTimeout(release, 30);
    }
  })));
  await ready;
  await f.runner.abort();
  f.activity.remove('dwight-m1');
  assert.ok(f.live.some(r => r.assistantMessageEvent?.delta === 'FAILED_THINKING'));
  assert.ok(!f.live.some(r => r.discard));
  assert.deepEqual(f.readThoughts().map(r => [r.text, r.cut]), [['FAILED_THINKING', true]]);
});

test('cancelling during SQLite retry backoff returns promptly', async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; return new Response(sse([{ type: 'error', code: 'server_error', message: 'Busy' }])); }, false, 16);
  while (!f.live.some(r => r.discard)) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30));
  const started = Date.now();
  const result = await f.runner.abort();
  assert.ok(Date.now() - started < 1000, 'cancellation must interrupt the 16-second backoff');
  assert.equal(result.failure.kind, 'aborted');
  assert.equal(calls, 1);
});
