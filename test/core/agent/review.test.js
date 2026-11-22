import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createScriptedProvider } from '../../../src/core/llm/index.js';
import { startAgent, approveToolCall, readAgentHistory } from '../../../src/core/agent/index.js';

import { fixture } from './helpers.js';
const tool = path => ({ id: 'reused', name: 'write', arguments: { path, content: 'yes' } });
async function waiting(runtime, id, step) {
  for (let i = 0; i < 400; i++) {
    const state = await runtime.getEvent(id, 'agent_state', { timeoutSeconds: 0 });
    if (state?.phase === 'waiting_approval' && state.detail.step === step) return state.detail;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Approval ${step} not reached`);
}

test('same instance has new invocations by default, explicit key replays only that invocation', async t => {
  const llm = createScriptedProvider([{ text: 'first' }, { text: 'second' }, { text: 'keyed' }]);
  const s = await fixture(t, { llm });
  const a = s.start(); assert.equal((await a.done).text, 'first');
  const b = s.start(); assert.equal((await b.done).text, 'second'); assert.notEqual(a.workflowId, b.workflowId);
  const c = s.start({ invocationKey: 'm1/cycle2/task' }); const result = await c.done;
  const d = s.start({ invocationKey: 'm1/cycle2/task' });
  assert.equal(c.workflowId, d.workflowId); assert.deepEqual(await d.done, result); assert.equal(llm.calls.length, 3);
});

test('two concurrent first launches await a single launch promise', async t => {
  const s = await fixture(t, { llm: createScriptedProvider([{ text: 'one' }, { text: 'two' }]) });
  const launch = s.runtime.launch.bind(s.runtime); let launches = 0;
  s.runtime.launch = async () => { launches++; await new Promise(resolve => setTimeout(resolve, 30)); return launch(); };
  const a = s.start(), b = s.start({ instanceId: 'other' });
  const results = await Promise.all([a.done, b.done]);
  assert.ok(results.every(r => r.ok), JSON.stringify(results)); assert.equal(launches, 1);
});

for (const final of [true, false]) test(`compaction failure is nonfatal after ${final ? 'final answer' : 'tool turn'}`, async t => {
  const warnings = [], states = [];
  const llm = createScriptedProvider([
    final ? { text: 'Done [TASK_COMPLETE]', usage: { input: 100 } } : { toolCalls: [tool('file.txt')], usage: { input: 100 } },
    { error: { status: 401 } }, ...(!final ? [{ text: 'Done [TASK_COMPLETE]' }] : []),
  ]);
  const s = await fixture(t, { llm, compactTokenLimit: 50, onLog: r => warnings.push(r) });
  // Observe the public checkpoint API via the workflow registration adapter below instead of timing a transient event.
  const register = s.runtime.registerWorkflow.bind(s.runtime);
  s.runtime.registerWorkflow = (name, body) => register(name, (wf, input) => {
    const original = wf.setEvent.bind(wf);
    wf.setEvent = async (key, value) => { states.push(value); return original(key, value); };
    return body(wf, input);
  });
  const r = s.start(); const result = await r.done;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.keyword, 'TASK_COMPLETE');
  assert.equal(warnings.length, 1); assert.ok(states.some(s => s.phase === 'compaction_failed'));
  if (!final) assert.ok(llm.calls[2].context.messages.some(m => m.role === 'toolResult'));
  assert.ok((await readAgentHistory(s.runtime, r.workflowId)).some(m => m.role === 'assistant'));
});

test('approval correlation includes workflow and durable tool position even when IDs repeat', async t => {
  const s = await fixture(t, { llm: createScriptedProvider([{ toolCalls: [tool('first.txt')] }, { toolCalls: [tool('second.txt')] }, { text: '[TASK_COMPLETE]' }]), approvals: { tools: ['write'], timeoutSeconds: 2 } });
  const r = s.start();
  const first = await waiting(s.runtime, r.workflowId, 'tool:0:0');
  await approveToolCall(s.runtime, r.workflowId, first, false, 'test');
  await approveToolCall(s.runtime, r.workflowId, first, true, 'test');
  const second = await waiting(s.runtime, r.workflowId, 'tool:1:0');
  await s.runtime.send(r.workflowId, { ...first, approved: false }, 'tool_approval', 'stale');
  await s.runtime.send(r.workflowId, { ...second, workflowId: 'foreign', approved: false }, 'tool_approval', 'foreign');
  await approveToolCall(s.runtime, r.workflowId, second, true, 'test');
  assert.equal((await r.done).ok, true);
  await assert.rejects(fs.stat(path.join(s.dir, 'first.txt')));
  assert.equal(await fs.readFile(path.join(s.dir, 'second.txt'), 'utf8'), 'yes');
});

test('kill user is interrupted, unlike abort', async t => {
  const s = await fixture(t, { llm: createScriptedProvider([{ text: 'later', delayMs: 1000 }]) });
  const r = s.start(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await r.kill('user')).failure.kind, 'interrupted');
});

test('inbox uses agent ID and includes the status-keyword instruction', async t => {
  const llm = createScriptedProvider([{ text: '[TASK_COMPLETE]' }]); const s = await fixture(t, { llm });
  const inbox = path.join(s.dir, 'inbox.md'); await fs.writeFile(inbox, 'Inbox task');
  const r = s.start({ message: undefined, hive: { inboxPath(id) { assert.equal(id, 'dwight'); return inbox; } } });
  assert.equal((await r.done).ok, true);
  assert.match(llm.calls[0].context.messages[0].content, /exactly one status keyword/);
  assert.match(llm.calls[0].context.messages[0].content, /Inbox task/);
});

test('sandbox spawn is bound and supplied to tool ctx; legacy execution is rejected', async t => {
  let launches = 0;
  const sandbox = { tag: 'sandbox', spawn() {
    assert.equal(this.tag, 'sandbox'); launches++;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); return child;
  } };
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const s = await fixture(t, { sandbox, llm: createScriptedProvider([{ toolCalls: [{ id: 'shell', name: shell, arguments: { command: 'echo test' } }] }, { text: '[TASK_COMPLETE]' }]) });
  assert.equal((await s.start().done).ok, true); assert.equal(launches, 1);
  const result = await s.start({ execution() {} }).done;
  assert.equal(result.ok, false); assert.match(result.failure.message, /Pi execution/);
});

test('exhausted compaction overflow remains nonfatal even if the warning callback throws', async t => {
  const s = await fixture(t, { llm: createScriptedProvider([
    { text: 'Final [TASK_COMPLETE]', usage: { input: 100 } },
    ...Array.from({ length: 3 }, () => ({ error: { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 } })),
  ]), compactTokenLimit: 50, onLog() { throw new Error('Display failed'); } });
  const result = await s.start().done;
  assert.equal(result.ok, true); assert.equal(result.keyword, 'TASK_COMPLETE');
});

test('invalid sandbox does not poison first launch and explicit spawn takes precedence', async t => {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash'; let launches = 0;
  const s = await fixture(t, { llm: createScriptedProvider([{ toolCalls: [{ id: 'shell', name: shell, arguments: { command: 'echo test' } }] }, { text: '[TASK_COMPLETE]' }]) });
  const invalid = await s.start({ sandbox: {} }).done;
  assert.match(invalid.failure.message, /sandbox must expose spawn/);
  const result = await s.start({ sandbox: { spawn() { assert.fail('Explicit spawn must take priority'); } }, spawn() {
    launches++; const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); return child;
  } }).done;
  assert.equal(result.ok, true); assert.equal(launches, 1);
});

test('Pi options are rejected even when an explicit invocation key already completed', async t => {
  const s = await fixture(t, { invocationKey: 'same', llm: createScriptedProvider([{ text: '[TASK_COMPLETE]' }]) });
  assert.equal((await s.start().done).ok, true);
  for (const options of [{ pi: {} }, { extraArgs: ['--legacy'] }, { execution() {} }]) {
    const result = await s.start(options).done; assert.equal(result.ok, false); assert.match(result.failure.message, /Pi/);
  }
});
