import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDurableRuntime } from '../../../src/core/durable/index.js';
import { createScriptedProvider, getModel } from '../../../src/core/llm/index.js';
import { startAgent, approveToolCall, readAgentHistory, readAgentOutput, selectModel, AUTOMATIC_MODELS, agentWorkflowId, agentAppVersion, shutdownAgentRuntimes } from '../../../src/core/agent/index.js';
import { createLiveActivity } from '../../../src/core/live-activity.js';
import { compactHistory, SUMMARY_PREFIX } from '../../../src/core/agent/compaction.js';

const base = path.resolve('.scratch/agent-tests');
const model = getModel('openai', 'gpt-4o');
async function setup(t, turns, extra = {}) {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'run-'));
  const runtime = await createDurableRuntime({ databasePath: path.join(dir, 'db.sqlite'), markerDir: path.join(dir, 'markers'), executorId: 'test', appVersion: 'test', env: {} });
  t.after(async () => { await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  const llm = createScriptedProvider(turns);
  const options = { runtime, llm, model, cwd: dir, hiveDir: dir, instanceId: 'dwight-m1', agentId: 'dwight', runId: 'r1', message: 'Do the task', agentConfig: { tools: ['read', 'edit', 'write', 'powershell', 'agent_chat'], keywords: ['TASK_COMPLETE'] }, ...extra };
  return { dir, runtime, llm, options, start: overrides => startAgent({ ...options, ...overrides }) };
}
const call = (name, args, id = 'c1') => ({ name, arguments: args, id });
const text = message => typeof message.content === 'string' ? message.content : message.content.map(b => b.text ?? '').join('');

test('full read/edit/write run, callback payloads, history and duplicate-free completed replay', async t => {
  const events = [];
  const s = await setup(t, [
    { text: 'Inspect', toolCalls: [call('read', { path: 'a.txt' })] },
    { toolCalls: [call('edit', { path: 'a.txt', edits: [{ oldText: 'old', newText: 'new' }] }, 'c2'), call('write', { path: 'b.txt', content: 'written' }, 'c3')] },
    { text: 'Done [TASK_COMPLETE]', usage: { input: 10, output: 4 } },
  ], { onAssistantMessage: (...v) => events.push(['assistant', ...v]), onTool: v => events.push(['tool', v]), onToolEnd: v => events.push(['end', v]), onUsage: v => events.push(['usage', v]) });
  await fs.writeFile(path.join(s.dir, 'a.txt'), 'old');
  const runner = s.start({ invocationKey: 'task' }); const result = await runner.done;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.keyword, 'TASK_COMPLETE');
  assert.equal(result.text, 'Done [TASK_COMPLETE]'); assert.equal(result.exitCode, 0); assert.ok(result.durationMs >= 0); assert.equal(result.sessionId, runner.sessionId);
  assert.equal(result.usage.input, 10); assert.equal(result.usage.output, 4); assert.ok(Math.abs(result.usage.cost - 0.000065) < 1e-12);
  assert.equal(await fs.readFile(path.join(s.dir, 'a.txt'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(s.dir, 'b.txt'), 'utf8'), 'written');
  assert.equal(events.filter(e => e[0] === 'tool').length, 3);
  assert.deepEqual(events.find(e => e[0] === 'tool')[1], { tool: 'read', activity: 'Reading a.txt', detail: 'a.txt', targetFile: 'a.txt', command: null });
  const history = await readAgentHistory(s.runtime, runner.workflowId);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant', 'toolResult', 'toolResult', 'assistant']);
  assert.deepEqual(s.llm.calls[2].context.messages, history.slice(0, -1));
  const count = events.length;
  const replay = s.start({ invocationKey: 'task' });
  assert.deepEqual(await replay.done, result); assert.equal(replay.sessionId, runner.sessionId);
  assert.equal(events.length, count); assert.equal(s.llm.calls.length, 3);
  assert.equal((await s.runtime.getEvent(runner.workflowId, 'agent_state')).phase, 'done');
});

test('legacy-format live records drive the existing live activity writer', async t => {
  const s = await setup(t, [{ thinking: 'Reasoning', text: 'Answer [TASK_COMPLETE]' }]);
  const live = createLiveActivity(s.dir, 'r1'); t.after(() => live.close());
  const runner = s.start({ onLive: r => live.update('i', 'dwight', r) }); await runner.done;
  await new Promise(resolve => setTimeout(resolve, 430));
  const snapshot = JSON.parse(await fs.readFile(path.join(s.dir, 'live.json')));
  assert.equal(snapshot.instances.i.thinking, 'Reasoning'); assert.equal(snapshot.instances.i.text, 'Answer [TASK_COMPLETE]'); assert.equal(snapshot.instances.i.phase, 'idle');
});

test('transient mid-stream failure marks attempts and clean output excludes failed text', async t => {
  const s = await setup(t, [{ text: 'bad partial', error: { status: 503 } }, { text: 'clean [TASK_COMPLETE]' }], { retrySeconds: 0.001 });
  const r = s.start(); assert.equal((await r.done).ok, true);
  const records = []; for await (const row of s.runtime.readStream(r.workflowId, 'output')) records.push(row.value);
  assert.deepEqual(records.filter(v => v.type === 'attempt_start').map(v => v.attempt), [1, 2]);
  assert.equal((await readAgentOutput(s.runtime, r.workflowId)).map(v => v.delta).join(''), 'clean [TASK_COMPLETE]');
  assert.equal(s.llm.calls.length, 2);
});

test('permanent errors do not retry', async t => {
  const s = await setup(t, [{ error: { status: 401 } }]);
  const r = s.start(); assert.equal((await r.done).ok, false); assert.equal(s.llm.calls.length, 1);
  const rows = []; for await (const row of s.runtime.readStream(r.workflowId, 'output')) rows.push(row);
  assert.ok(rows.length);
});

for (const verdict of ['approve', 'deny', 'timeout', 'stale']) test(`approval ${verdict}`, async t => {
  const s = await setup(t, [{ toolCalls: [call('write', { path: 'approved.txt', content: 'yes' })] }, { text: '[TASK_COMPLETE]' }], { approvals: { tools: ['write'], timeoutSeconds: verdict === 'timeout' ? 0.03 : 2 } });
  const r = s.start();
  // Poll the public event until the workflow reaches its approval checkpoint.
  for (let i = 0; i < 200; i++) {
    const state = await s.runtime.getEvent(r.workflowId, 'agent_state', { timeoutSeconds: 0 });
    if (state?.phase === 'waiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (verdict === 'stale') await approveToolCall(s.runtime, r.workflowId, { step: 'tool:0:0', callId: 'foreign' }, false, 'test');
  if (verdict !== 'timeout') await approveToolCall(s.runtime, r.workflowId, { step: 'tool:0:0', callId: 'c1' }, verdict !== 'deny', 'test');
  assert.equal((await r.done).ok, true);
  const exists = await fs.stat(path.join(s.dir, 'approved.txt')).then(() => true, () => false);
  assert.equal(exists, verdict === 'approve' || verdict === 'stale');
  const result = (await readAgentHistory(s.runtime, r.workflowId)).find(m => m.role === 'toolResult');
  assert.equal(result.isError, !exists);
});

test('steering is drained before the next LLM call; chat preserves negative ACK', async t => {
  let runner;
  const s = await setup(t, [{ toolCalls: [call('agent_chat', { to: 'other', text: 'hello' })] }, { text: '[TASK_COMPLETE]' }], {
    onMessage: async message => { assert.deepEqual(message, { to: 'other', text: 'hello' }); return { ok: false, delivery: 'rejected', error: 'Unknown recipient' }; },
    onToolEnd: async () => { assert.equal((await runner.sendMessage('Please verify')).ok, true); },
  });
  runner = s.start(); assert.equal((await runner.done).ok, true);
  assert.equal(text(s.llm.calls[1].context.messages.at(-1)), 'Please verify');
  const tool = s.llm.calls[1].context.messages.find(m => m.role === 'toolResult'); assert.equal(tool.isError, true); assert.equal(JSON.parse(tool.content).delivery, 'rejected');
});

test('abort cancels an active request, resolves done, and terminal status ends readers', async t => {
  const s = await setup(t, [{ text: 'late', delayMs: 1000 }]); const r = s.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  const result = await r.abort(); assert.equal(result.ok, false); assert.equal(result.failure.kind, 'aborted');
  assert.equal((await s.runtime.retrieveWorkflow(r.workflowId).getStatus()).status, 'CANCELLED');
  await readAgentOutput(s.runtime, r.workflowId);
});

test('timeout cancels an active request', async t => {
  const s = await setup(t, [{ text: 'late', delayMs: 1000 }], { timeoutMs: 30 });
  assert.equal((await s.start().done).failure.kind, 'timeout');
});

test('max-turns guard prevents unbounded tool loops', async t => {
  const s = await setup(t, [{ toolCalls: [call('read', { path: 'absent' })] }], { maxTurns: 1 });
  const result = await s.start().done; assert.equal(result.ok, false); assert.match(result.failure.message, /max-turns/); assert.equal(s.llm.calls.length, 1);
});

test('path, schema and allowlist failures are model-visible tool results', async t => {
  const s = await setup(t, [{ toolCalls: [call('read', { path: '../escape' }), call('write', { path: 'x' }, 'bad'), call('ls', {}, 'denied')] }, { text: '[TASK_COMPLETE]' }]);
  assert.equal((await s.start().done).ok, true);
  const results = s.llm.calls[1].context.messages.filter(m => m.role === 'toolResult');
  assert.equal(results.length, 3); assert.ok(results.every(m => m.isError));
});

test('compaction trigger replaces history, preserving task and summary', async t => {
  const s = await setup(t, [
    { toolCalls: [call('read', { path: 'absent' })], usage: { input: 100, output: 10 } },
    { text: 'Summary: finish next' }, { text: '[TASK_COMPLETE]' },
  ], { compactTokenLimit: 100 });
  const r = s.start(); assert.equal((await r.done).ok, true);
  assert.equal(s.llm.calls.length, 3);
  assert.match(text(s.llm.calls[1].context.messages.at(-1)), /CONTEXT CHECKPOINT COMPACTION/);
  assert.deepEqual(s.llm.calls[2].context.messages.map(m => m.role), ['user', 'user']);
  assert.match(text(s.llm.calls[2].context.messages[1]), new RegExp('^' + SUMMARY_PREFIX.slice(0, 30)));
  assert.equal((await readAgentHistory(s.runtime, r.workflowId)).length, 3);
});

test('compaction retains newest users with UTF-8-safe middle truncation', () => {
  const history = compactHistory([{ role: 'user', content: 'old' }, { role: 'user', content: 'é'.repeat(50000) }, { role: 'user', content: 'new' }], 'summary');
  assert.equal(history.length, 3); assert.equal(history[1].content, 'new'); assert.match(history[0].content, /tokens truncated/); assert.ok(!history[0].content.includes('\ufffd'));
});

test('Automatic uses fixed provider order, pinned catalogue entries and no Pi settings', () => {
  for (const ref of AUTOMATIC_MODELS) assert.ok(getModel(ref.provider, ref.model), JSON.stringify(ref));
  const credentials = { listAccounts: () => [{ id: 'google', status: 'signed_in' }, { id: 'anthropic', status: 'signed_in' }] };
  assert.equal(selectModel({}, credentials).provider, 'anthropic');
  assert.throws(() => selectModel({}, { listAccounts: () => [] }), /signed-in/);
  assert.throws(() => selectModel({ provider: 'openai' }, credentials), /Both/);
});

test('workflow identity escapes separators and app version fingerprints sources', async () => {
  assert.equal(agentWorkflowId({ projectId: 'a/b', instanceId: 'i' }), 'scr:a%2Fb/hive/single/i/default');
  assert.match(await agentAppVersion(), /^0\.5\.0-[a-f0-9]{16}$/);
});

test('custom providers resolve only their declared models from credentials', () => {
  const credentials = { store: { read: () => ({ providers: { local: { id: 'local', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000', models: [{ id: 'custom', contextWindow: 12345 }] } } }) } };
  const custom = selectModel({ provider: 'local', model: 'custom' }, credentials);
  assert.equal(custom.provider, 'local'); assert.equal(custom.contextWindow, 12345); assert.equal(custom.maxTokens, 8192);
  assert.throws(() => selectModel({ provider: 'local', model: 'missing' }, credentials), /Unknown custom/);
});

test('Automatic selection is checkpointed in a real workflow', async t => {
  const s = await setup(t, [{ text: '[TASK_COMPLETE]' }]);
  const r = s.start({ model: undefined, credentials: { listAccounts: () => [{ id: 'google', status: 'signed_in' }] } });
  assert.equal((await r.done).ok, true); assert.equal(s.llm.calls[0].model.id, 'gemini-2.5-pro');
});

test('compaction overflow removes oldest history and retries as a new durable step', async t => {
  const s = await setup(t, [
    { text: '[TASK_COMPLETE]', usage: { input: 100 } },
    { error: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 } },
    { text: 'summary' },
  ], { compactTokenLimit: 50 });
  assert.equal((await s.start().done).ok, true);
  assert.equal(s.llm.calls[1].context.messages.length - 1, s.llm.calls[2].context.messages.length);
});

test('invalid chat ACK becomes unknown, never an implicit success', async t => {
  const s = await setup(t, [{ toolCalls: [call('agent_chat', { to: 'other', text: 'hello' })] }, { text: '[TASK_COMPLETE]' }], { onMessage: async () => ({ delivery: 'delivered' }) });
  assert.equal((await s.start().done).ok, true);
  const tool = s.llm.calls[1].context.messages.find(m => m.role === 'toolResult');
  assert.equal(tool.isError, true); assert.equal(JSON.parse(tool.content).delivery, 'unknown');
});

test('Pi options and legacy execution callbacks fail explicitly without launching a model', async t => {
  const s = await setup(t, []);
  const result = await s.start({ pi: { transport: 'rpc' } }).done;
  assert.equal(result.ok, false); assert.match(result.failure.message, /Pi settings/); assert.equal(s.llm.calls.length, 0);
});

test('shell spawn receives the workspace and sanitized environment', async t => {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  let launches = 0;
  const s = await setup(t, [{ toolCalls: [call(shell, { command: 'echo test' })] }, { text: '[TASK_COMPLETE]' }], {
    agentConfig: { tools: [shell] },
    extraEnv: { SCRANTON_RUN_LEASE: 'do-not-pass', OPENAI_API_KEY: 'fake-test-value', AUTHORIZATION: 'fake-auth', SAFE_FIXTURE: 'yes' },
    spawn(_file, _argv, options) {
      launches++;
      assert.equal(options.cwd, s.dir); assert.equal(options.env.SAFE_FIXTURE, 'yes');
      for (const name of ['SCRANTON_RUN_LEASE', 'OPENAI_API_KEY', 'AUTHORIZATION']) assert.equal(options.env[name], undefined);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.end('test'); child.stderr.end(); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal((await s.start().done).ok, true); assert.equal(launches, 1);
});

test('default process runtime stores workflows under the Hive and supports multiple instances', async t => {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'owned-'));
  t.after(async () => { await shutdownAgentRuntimes(); await fs.rm(dir, { recursive: true, force: true }); });
  const common = { llm: createScriptedProvider([{ text: '[TASK_COMPLETE]' }, { text: '[TASK_COMPLETE]' }]), model, cwd: dir, hiveDir: dir,
    message: 'task', runId: 'owned', agentConfig: { tools: [], keywords: ['TASK_COMPLETE'] } };
  const one = startAgent({ ...common, instanceId: 'one' }); assert.equal((await one.done).ok, true);
  const two = startAgent({ ...common, instanceId: 'two' }); assert.equal((await two.done).ok, true);
  assert.ok((await fs.stat(path.join(dir, 'dbos.sqlite'))).size > 0);
  assert.equal(common.llm.calls.length, 2);
});
