import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { createDurableRuntime } from '../../src/core/durable/index.js';
import { agentWorkflowId } from '../../src/core/agent/index.js';
import { streamAnswer, promptApproval, startCliLive } from '../../src/core/cli-live.js';

function fixture(t) {
  const root = path.resolve('.scratch/cli-switch/tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-')), hiveDir = path.join(dir, 'hive');
  let out = '', err = '';
  const stdout = { write(s) { out += s; } }, stderr = { write(s) { err += s; } };
  const env = { SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'), PI_CODING_AGENT_DIR: path.join(dir, 'pi') };
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, hiveDir, env, stdout, stderr, cleanups, out: () => out, err: () => err,
    invoke: args => runCli([...args, '--hive', hiveDir], { cwd: dir, env, stdout, stderr }) };
}

test('CLI maps sandbox, network alias and approval flags including empty-clears on follow-ups', async t => {
  const f = fixture(t), configs = [];
  t.mock.method(Orchestrator.prototype, 'run', async function () { configs.push(this.config); return { status: 'success' }; });
  for (const mode of ['scranton', 'docker', 'host']) {
    assert.equal(await f.invoke(['run', 'goal', '--sandbox', mode, ...(mode === 'host' ? ['--trusted-host'] : []), '--sandbox-network', 'bridge', '--approve', 'write,edit', '--approval-timeout', '12']), 0, f.err());
    assert.equal(configs.at(-1).execution.sandbox.mode, mode);
    assert.equal(configs.at(-1).execution.sandbox.network, 'allow');
    assert.deepEqual(configs.at(-1).approvals, { tools: ['write', 'edit'], timeoutSeconds: 12 });
  }
  assert.equal(await f.invoke(['run', 'follow-up', '--approve', '']), 0);
  assert.deepEqual(configs.at(-1).approvals.tools, []);
  assert.equal(await f.invoke(['run', 'goal', '--approval-timeout', '86400']), 0);
  assert.equal(configs.at(-1).approvals.timeoutSeconds, 86400);
  for (const flags of [['--sandbox', 'host'], ['--approve', 'bogus'], ...['0', '86401', '2147484', '1.5', 'NaN'].map(value => ['--approval-timeout', value]), ['--sandbox-network', 'off'], ['--sandbox-image', 'image']]) assert.equal(await f.invoke(['run', 'goal', ...flags]), 2);
});

test('durable answer replay discards superseded attempts including repeated attempt numbers and reasoning', async () => {
  const rows = [
    { type: 'attempt_start', step: 'llm:0', attempt: 1 }, { v: 1, step: 'llm:0', attempt: 1, kind: 'text', delta: 'stale' },
    { type: 'attempt_start', step: 'llm:0', attempt: 1 }, { v: 1, step: 'llm:0', attempt: 1, kind: 'text', delta: 'fresh\u001b[31m' },
    { v: 1, step: 'llm:0', attempt: 2, kind: 'text', delta: 'foreign' }, { v: 1, step: 'llm:0', attempt: 1, kind: 'thinking', delta: 'private' },
  ];
  const client = { async *readStream() { for (const value of rows) yield { value }; } };
  let out = ''; const stdout = { write(s) { out += s; } };
  await streamAnswer(client, 'opaque', { stdout, agent: 'dwight' });
  assert.equal(out, '[dwight] fresh\n');
  out = ''; await streamAnswer(client, 'opaque', { stdout, quiet: true }); assert.equal(out, '');
});

test('simulated TTY prompt defaults to deny, accepts yes and times out visibly', async t => {
  for (const answer of ['y\n', '\n', null]) {
    const stdin = new PassThrough(); stdin.isTTY = true;
    let text = ''; const stderr = { isTTY: true, write(s) { text += s; } };
    const promise = promptApproval({ tool: 'write', args: { path: 'untrusted\u001b[31m' }, timeoutSeconds: 1, deadline: new Date(Date.now() + (answer === null ? 20 : 1000)).toISOString() }, { agent: 'dwight', stdin, stderr });
    if (answer !== null) stdin.write(answer);
    assert.equal(await promise, answer === 'y\n');
    assert.match(text, /dwight; tool: write/); assert.match(text, /Deadline: .*\[y\/N\]/);
    if (answer === null) assert.match(text, /Denied \(approval timed out\)/);
    stdin.destroy();
  }
});

async function runtimeFixture(t, f) {
  const runtime = await createDurableRuntime({ hiveDir: f.hiveDir, env: {}, executorId: 'run:test' });
  f.cleanups.push(() => runtime.shutdown());
  runtime.registerWorkflow('scranton.agent.v1', async (wf, input) => {
    await wf.setEvent('agent_state', { phase: 'waiting_approval', detail: { workflowId: wf.workflowId, step: 'tool:0:0', callId: 'call', tool: 'write', args: { path: 'hello' }, timeoutSeconds: 2, deadline: input.deadline } });
    const verdict = await wf.recv('tool_approval', { timeoutSeconds: 2 });
    await wf.writeStream('output', { type: 'attempt_start', step: 'llm:0', attempt: 1 });
    await wf.writeStream('output', { v: 1, step: 'llm:0', attempt: 1, kind: 'text', delta: verdict?.approved ? 'accepted' : 'denied' });
    return verdict;
  });
  await runtime.launch(); return runtime;
}

test('approve/watch use opaque workflow IDs, current step/call and clear unknown/not-pending/expired exits', async t => {
  const f = fixture(t), runtime = await runtimeFixture(t, f), id = agentWorkflowId({ hiveDir: f.hiveDir, runId: 'test', instanceId: 'dwight', invocationKey: 'opaque/with spaces' });
  const handle = await runtime.startWorkflow('scranton.agent.v1', { workflowId: id }, { deadline: new Date(Date.now() + 2000).toISOString() });
  await runtime.getEvent(id, 'agent_state');
  assert.equal(await f.invoke(['approve', id, 'call', '--yes', '--no']), 2);
  assert.equal(await f.invoke(['approve', 'unknown', 'call', '--yes']), 1); assert.match(f.err(), /Unknown workflow/);
  assert.equal(await f.invoke(['approve', id, 'other', '--yes']), 1); assert.match(f.err(), /not pending/);
  assert.equal(await f.invoke(['approve', id, 'call', '--yes']), 0, f.err());
  const verdict = await handle.getResult(); assert.deepEqual([verdict.step, verdict.callId, verdict.approved], ['tool:0:0', 'call', true]);
  assert.equal(await f.invoke(['watch', id]), 0, f.err()); assert.match(f.out(), /accepted/); assert.match(f.err(), /Workflow ended: SUCCESS/);
  assert.equal(await f.invoke(['approve', id, 'call', '--no']), 1);
  const expired = agentWorkflowId({ hiveDir: f.hiveDir, runId: 'test', invocationKey: 'expired' });
  const exp = await runtime.startWorkflow('scranton.agent.v1', { workflowId: expired }, { deadline: new Date(Date.now() - 100).toISOString() });
  await runtime.getEvent(expired, 'agent_state');
  assert.equal(await f.invoke(['approve', expired, 'call', '--no']), 1); assert.match(f.err(), /expired/);
  await runtime.cancelWorkflow(expired); await exp.getResult().catch(() => {});
});

test('live noninteractive approval prints an executable scoped command once', async t => {
  const f = fixture(t), runtime = await runtimeFixture(t, f), id = agentWorkflowId({ hiveDir: f.hiveDir, runId: 'test' });
  const handle = await runtime.startWorkflow('scranton.agent.v1', { workflowId: id }, { deadline: new Date(Date.now() + 2000).toISOString() });
  await runtime.getEvent(id, 'agent_state');
  const live = startCliLive({ openClient: async () => ({ ...runtime, listWorkflows: (...args) => runtime.listWorkflows(...args), getEvent: (...args) => runtime.getEvent(...args), retrieveWorkflow: (...args) => runtime.retrieveWorkflow(...args), readStream: (...args) => runtime.readStream(...args), shutdown: async () => {} }), workflows: () => runtime.listWorkflows(), stdout: f.stdout, stderr: f.stderr, stdin: { isTTY: false }, scope: '--data "registry dir" --project p --chat c', pollMs: 5 });
  await sleep(40); await runtime.cancelWorkflow(id); await handle.getResult().catch(() => {}); await live.stop();
  assert.match(f.err(), /scranton approve .* --yes --data "registry dir" --project p --chat c/);
  assert.equal((f.err().match(/scranton approve/g) ?? []).length, 1);
});

test('inline TTY approvals are serialized and submit verdicts for each workflow', async t => {
  const f = fixture(t), runtime = await runtimeFixture(t, f), stdin = new PassThrough(); stdin.isTTY = true;
  const ids = ['first', 'second'].map(instanceId => agentWorkflowId({ hiveDir: f.hiveDir, runId: 'test', instanceId }));
  const handles = [];
  for (const id of ids) {
    handles.push(await runtime.startWorkflow('scranton.agent.v1', { workflowId: id }, { deadline: new Date(Date.now() + 2000).toISOString() }));
    await runtime.getEvent(id, 'agent_state');
  }
  let text = '', prompts = 0;
  const stderr = { isTTY: true, write(s) { text += s; if (s.includes('[y/N]')) { prompts++; setTimeout(() => stdin.write(prompts === 1 ? 'y\n' : 'n\n'), 5); } } };
  const client = { listWorkflows: (...args) => runtime.listWorkflows(...args), getEvent: (...args) => runtime.getEvent(...args), retrieveWorkflow: (...args) => runtime.retrieveWorkflow(...args), readStream: (...args) => runtime.readStream(...args), send: (...args) => runtime.send(...args), shutdown: async () => {} };
  const live = startCliLive({ openClient: async () => client, workflows: () => runtime.listWorkflows(), stdout: f.stdout, stderr, stdin, scope: '--hive fixture', pollMs: 5 });
  const verdicts = await Promise.all(handles.map(h => h.getResult())); await live.stop(); stdin.destroy();
  assert.equal(prompts, 2, text); assert.deepEqual(verdicts.map(v => v?.approved), [true, false]);
  assert.match(text, /Approved\nApproval required:/); assert.match(text, /Denied/);
});

test('complete answer lines stream before workflow completion without cursor controls', async () => {
  let out = '', yielded = false;
  const client = { async *readStream() {
    yield { value: { type: 'attempt_start', step: 'llm:0', attempt: 1 } };
    yield { value: { v: 1, step: 'llm:0', attempt: 1, kind: 'text', delta: 'live\n' } };
    await sleep(50); assert.equal(out, '[dwight] live\n'); yielded = true;
  } };
  await streamAnswer(client, 'id', { stdout: { write(s) { out += s; } }, agent: 'dwight' });
  assert.equal(yielded, true); assert.doesNotMatch(out, /\u001b/);
});

test('live deltas at producer cadence do not fragment unfinished lines', async () => {
  let out = '';
  const client = { async *readStream() {
    yield { value: { type: 'attempt_start', step: 'llm:0', attempt: 1 } };
    for (const delta of ['A complete ', 'sentence ', 'across deltas.\nTail']) {
      yield { value: { step: 'llm:0', attempt: 1, kind: 'text', delta } };
      await sleep(110);
      assert.equal(out, delta.includes('\n') ? '[dwight] A complete sentence across deltas.\n' : '');
    }
  } };
  await streamAnswer(client, 'id', { agent: 'dwight', stdout: { write(s) { out += s; } } });
  assert.equal(out, '[dwight] A complete sentence across deltas.\n[dwight] Tail\n');
});

test('quiet-period output remains honest when an already displayed attempt is superseded', async () => {
  let out = '';
  const client = { async *readStream() {
    yield { value: { type: 'attempt_start', step: 'llm:0', attempt: 1 } };
    yield { value: { step: 'llm:0', attempt: 1, kind: 'text', delta: 'old' } };
    await sleep(1600);
    assert.equal(out, '[dwight] old\n');
    yield { value: { type: 'attempt_start', step: 'llm:0', attempt: 1 } };
    yield { value: { step: 'llm:0', attempt: 1, kind: 'text', delta: 'new' } };
  } };
  await streamAnswer(client, 'id', { agent: 'dwight', stdout: { write(s) { out += s; } } });
  assert.equal(out, '[dwight] old\n[dwight] [previous llm:0 attempt superseded]\n[dwight] new\n');
});

test('watch stops a PENDING workflow when its run owner is gone or state ended', { timeout: 5000 }, async t => {
  for (const mode of ['owner', 'finished', 'replaced']) {
    const f = fixture(t), runtime = await createDurableRuntime({ hiveDir: f.hiveDir, env: {}, executorId: 'run:dead' });
    f.cleanups.push(() => runtime.shutdown());
    runtime.registerWorkflow('scranton.agent.v1', async wf => { await wf.recv('never', { timeoutSeconds: 60 }); });
    await runtime.launch();
    const id = agentWorkflowId({ hiveDir: f.hiveDir, runId: 'dead' });
    await runtime.startWorkflow('scranton.agent.v1', { workflowId: id });
    if (mode === 'owner') {
      fs.mkdirSync(path.join(f.hiveDir, 'control'), { recursive: true });
      fs.writeFileSync(path.join(f.hiveDir, 'control/owner.json'), JSON.stringify({ v: 1, runId: 'dead', token: 'token' }));
      fs.writeFileSync(path.join(f.hiveDir, 'control/heartbeat.json'), JSON.stringify({ v: 1, runId: 'dead', pid: 2147483647, at: new Date().toISOString() }));
    } else fs.writeFileSync(path.join(f.hiveDir, 'state.json'), JSON.stringify({ runId: mode === 'replaced' ? 'next' : 'dead', status: mode === 'finished' ? 'finished' : 'running' }));
    try {
      assert.equal(await Promise.race([f.invoke(['watch', id]), sleep(1500, undefined, { ref: false }).then(() => { throw Error('watch did not end for a dead run'); })]), 1);
      assert.match(f.err(), /Workflow ended: interrupted/);
      assert.equal((await runtime.retrieveWorkflow(id).getStatus()).status, 'PENDING');
    } finally { await runtime.cancelWorkflow(id); }
  }
});

test('approval prompt clamps oversized deadlines instead of overflowing Node timers', async () => {
  const stdin = new PassThrough();
  let text = '';
  const promise = promptApproval({ deadline: new Date(Date.now() + 3e9).toISOString(), tool: 'write', args: {}, timeoutSeconds: 3e6 }, { agent: 'dwight', stdin, stderr: { write(s) { text += s; } } });
  await sleep(30);
  assert.doesNotMatch(text, /Denied/);
  stdin.write('yes\n'); assert.equal(await promise, true); stdin.destroy();
});

test('noninteractive approval sanitizes every interpolated command field', async () => {
  let text = '';
  const id = 'workflow\u001b[31m', callId = 'call\r\n\u001b[2J';
  const detail = { workflowId: id, callId, step: 'tool:0:0', tool: 'write', args: {}, deadline: new Date(Date.now() + 10000).toISOString() };
  const client = { async *readStream() {}, retrieveWorkflow: () => ({ getStatus: async () => ({ status: 'PENDING' }) }), getEvent: async () => ({ phase: 'waiting_approval', detail }), shutdown: async () => {} };
  const live = startCliLive({ openClient: async () => client, workflows: async () => [{ workflowId: id, status: 'PENDING', agent: 'agent\u001b[31m' }], stdout: { write() {} }, stderr: { write(s) { text += s; } }, stdin: { isTTY: false }, scope: '--hive "safe"', pollMs: 5 });
  await sleep(30); await live.stop();
  assert.doesNotMatch(text, /[\u001b\r]/);
  const command = text.split('\n').find(line => line.startsWith('scranton approve'));
  assert.match(command, /call\\u000d\\u000a\\u001b/);
});

test('live partial-line buffering is capped and flushes on the next turn', async () => {
  let out = '';
  const client = { async *readStream() {
    yield { value: { type: 'attempt_start', step: 'llm:0', attempt: 1 } };
    yield { value: { step: 'llm:0', attempt: 1, kind: 'text', delta: 'x'.repeat(8192) } };
    assert.equal(out.length, '[a] '.length + 8192 + 1);
    yield { value: { step: 'llm:0', attempt: 1, kind: 'text', delta: 'end of turn' } };
    yield { value: { type: 'attempt_start', step: 'llm:1', attempt: 1 } };
    assert.ok(out.endsWith('[a] end of turn\n'));
  } };
  await streamAnswer(client, 'id', { agent: 'a', stdout: { write(s) { out += s; } } });
});
