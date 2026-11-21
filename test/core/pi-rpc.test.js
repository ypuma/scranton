import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startPi } from '../../src/core/pi-runner.js';
import { fakeConfig } from './helpers.js';
import agentChat, { CHAT_TITLE, RPC_ACK_TIMEOUT_MS, CHAT_ACK_TIMEOUT_MS, CHAT_TIMEOUT_MS } from '../../tools/pi-agent-chat.js';

function tempDir(t) {
  const root = path.resolve('.scratch/fix-final-runtime');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'rpc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, extra = {}) {
  const dir = tempDir(t), config = fakeConfig(dir);
  const runner = startPi({ transport: 'rpc', spec: { argv: [process.execPath, path.resolve('tools/fake-pi-rpc.js')], shell: false },
    cwd: dir, agentId: 'dwight', instanceId: 'dwight-1', sessionId: randomUUID(), agentConfig: config.agents.dwight,
    pi: config.pi, hive: { inboxPath: () => path.join(dir, 'inbox.md'), sessionDir: (id) => path.join(dir, id) },
    message: 'task % "\n\u2028 [TASK_COMPLETE]', ackTimeoutMs: 1000, timeoutMs: 5000, ...extra });
  t.after(() => runner.kill());
  return runner;
}

test('RPC sends prompt via stdin, preserves flags, usage and resumes the exact persistent session', async (t) => {
  const dir = tempDir(t), sessionId = randomUUID();
  const opts = { sessionId, execution: { sessionDir: dir } };
  const first = await setup(t, opts).done;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.keyword, 'TASK_COMPLETE');
  assert.deepEqual(first.usage, { input: 2, output: 3, cost: 0.01 });
  const data = JSON.parse(first.text.split('\n')[0]);
  assert.equal(data.prompt, 'task % "\n\u2028 [TASK_COMPLETE]');
  assert.ok(!data.args.includes(data.prompt));
  assert.equal(data.args[data.args.indexOf('--mode') + 1], 'rpc');
  assert.equal(data.args[data.args.indexOf('--session-id') + 1], sessionId);
  assert.ok(data.args.includes('--extension'));
  assert.ok(!data.args.some((a) => a.startsWith('@')));
  assert.equal(JSON.parse((await setup(t, opts).done).text.split('\n')[0]).previous, 1);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('concurrent processes deliver live chat to a busy recipient with real steer ACK', async (t) => {
  let busy;
  const recipient = setup(t, { instanceId: 'dwight-recipient', extraEnv: { FAKE_RPC_MODE: 'wait-chat' }, onTool: () => busy?.() });
  await new Promise((resolve) => { busy = resolve; });
  const sender = setup(t, { instanceId: 'dwight-sender', extraEnv: { FAKE_RPC_MODE: 'chat', FAKE_RPC_TO: 'dwight-recipient' },
    onMessage: async (message) => {
      assert.deepEqual(message, { to: 'dwight-recipient', text: 'live hello' });
      return recipient.sendMessage(message.text);
    } });
  const [a, b] = await Promise.all([sender.done, recipient.done]);
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b));
  assert.match(a.text, /"ok":true/); assert.match(b.text, /Received: live hello/);
  assert.deepEqual(await recipient.sendMessage('late'), { ok: false, error: 'Pi session ended' });
});

test('broker rejection and broker timeout are honest tool ACKs', async (t) => {
  for (const onMessage of [async () => ({ ok: false, error: 'Unknown exact instance' }), () => new Promise(() => {})]) {
    const result = await setup(t, { brokerTimeoutMs: 150, extraEnv: { FAKE_RPC_MODE: 'chat', FAKE_RPC_TO: 'missing' }, onMessage }).done;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.text, /"ok":false/);
    assert.match(result.text, /Unknown exact instance|delivery unknown/);
  }
});

test('protocol errors, rejection, missing settlement and spawn failures settle without hanging', async (t) => {
  for (const [mode, kind] of [['reject', 'rpc'], ['early-exit', 'exit']]) {
    const result = await setup(t, { extraEnv: { FAKE_RPC_MODE: mode } }).done;
    assert.equal(result.failure.kind, kind);
  }
  assert.equal((await setup(t, { spec: { argv: ['nonexistent-scranton-pi-executable'], shell: false } }).done).failure.kind, 'spawn');
});

test('kill resolves pending steer ACKs and awaits execution cleanup exactly once', async (t) => {
  let cleanups = 0;
  const runner = setup(t, { extraEnv: { FAKE_RPC_MODE: 'no-ack' }, execution: { cleanup: async () => { cleanups++; } } });
  const ack = runner.sendMessage('pending');
  await runner.kill();
  assert.equal((await ack).ok, false);
  assert.equal((await runner.done).failure.kind, 'interrupted');
  await runner.kill(); assert.equal(cleanups, 1);
});

test('missing steer ACK times out; rejected steer does not claim delivery', async (t) => {
  for (const mode of ['no-ack', 'reject-steer']) {
    let busy;
    const runner = setup(t, { ackTimeoutMs: 200, extraEnv: { FAKE_RPC_MODE: mode }, onTool: () => busy?.() });
    await new Promise((resolve) => { busy = resolve; });
    const ack = await runner.sendMessage('hello');
    assert.equal(ack.ok, false);
    if (mode === 'no-ack') {
      assert.equal(ack.delivery, 'unknown');
      assert.match(ack.error, /Do not resend automatically/);
      assert.equal((await runner.done).failure.kind, 'rpc_timeout');
    }
    else await runner.kill();
  }
});

test('extension schema and execution never accept forged sender/run fields', async () => {
  let tool;
  agentChat({ registerTool: (t) => { tool = t; } });
  assert.equal(tool.parameters.additionalProperties, false);
  const result = await tool.execute('id', { to: 'exact', text: 'hello', from: 'forged' }, undefined, undefined, { mode: 'rpc' });
  assert.equal(result.isError, true);
});

test('async execution preparation receives staged host paths and overrides child paths', async (t) => {
  const dir = tempDir(t);
  let cleaned = false;
  const runner = setup(t, { systemPromptFile: path.join(dir, 'prompt.md'), execution: async (staged) => {
    assert.equal(staged.extensionFile, path.resolve('tools/pi-agent-chat.js'));
    assert.equal(staged.systemPromptFile, path.join(dir, 'prompt.md'));
    assert.ok(staged.sessionDir.endsWith('dwight-1'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sessionDir: dir, systemPromptFile: '/scranton/prompt.md', extensionFile: '/scranton/extension.js',
      argsPrefix: ['--fixture-prefix'], cleanup: async () => { cleaned = true; } };
  } });
  const result = await runner.done;
  assert.equal(result.ok, true, JSON.stringify(result));
  const args = JSON.parse(result.text.split('\n')[0]).args;
  assert.equal(args[0], '--fixture-prefix');
  assert.ok(args.includes('/scranton/extension.js'));
  assert.ok(args.includes('/scranton/prompt.md'));
  assert.equal(cleaned, true);
});

test('abort clears queues, cancels pending ACKs and closes cleanly', async (t) => {
  let busy;
  const runner = setup(t, { extraEnv: { FAKE_RPC_MODE: 'no-ack' }, onTool: () => busy?.() });
  await new Promise((resolve) => { busy = resolve; });
  const pending = runner.sendMessage('pending');
  await new Promise((resolve) => setImmediate(resolve));
  const result = await runner.abort();
  assert.equal(result.failure.kind, 'aborted');
  assert.equal(result.exitCode, 0);
  assert.equal((await pending).ok, false);
});

test('RPC broker boundary rejects forged from/run fields before invoking callback', async (t) => {
  let calls = 0;
  const result = await setup(t, { extraEnv: { FAKE_RPC_MODE: 'forge', FAKE_RPC_TO: 'exact' }, onMessage: () => { calls++; return { ok: true }; } }).done;
  assert.equal(result.ok, true);
  assert.match(result.text, /"ok":false/);
  assert.match(result.text, /only to\/text allowed/);
  assert.equal(calls, 0);
});

test('abort cancels outstanding chat dialogs and ignores late broker ACKs', async (t) => {
  let started, reply;
  const invoked = new Promise((resolve) => { started = resolve; });
  const runner = setup(t, { extraEnv: { FAKE_RPC_MODE: 'chat', FAKE_RPC_TO: 'exact' }, onMessage: () => {
    started(); return new Promise((resolve) => { reply = resolve; });
  } });
  await invoked;
  assert.equal((await runner.abort()).failure.kind, 'aborted');
  reply({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runner.done).ok, false);
});

test('near-deadline broker ACKs and timeout beat the extension deadline without replay delivery', async (t) => {
  for (const outcome of ['accepted', 'rejected', 'timeout']) await t.test(outcome, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());
    let invoked, complete, calls = 0;
    const started = new Promise((resolve) => { invoked = resolve; });
    const responses = [];
    const runner = setup(t, { ackTimeoutMs: undefined, timeoutMs: 0,
      extraEnv: { FAKE_RPC_MODE: 'chat-replay', FAKE_RPC_TO: 'dwight-exact' },
      onSpawn: (child) => {
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = (line, ...args) => {
          const record = JSON.parse(line);
          if (record.type === 'extension_ui_response') responses.push(JSON.parse(record.value));
          return write(line, ...args);
        };
      },
      onMessage: (message) => {
        assert.deepEqual(message, { to: 'dwight-exact', text: 'live hello' });
        calls++; invoked(); return new Promise((resolve) => { complete = resolve; });
      } });
    await started;
    assert.equal(RPC_ACK_TIMEOUT_MS, 5000);
    assert.equal(CHAT_ACK_TIMEOUT_MS, 10000);
    assert.equal(CHAT_TIMEOUT_MS, 15000);
    t.mock.timers.tick(CHAT_ACK_TIMEOUT_MS - 1);
    assert.equal(responses.length, 0);
    const ack = outcome === 'accepted' ? { ok: true, id: 'broker-message-id', delivery: 'queued' }
      : { ok: false, error: 'Unknown exact instance' };
    if (outcome !== 'timeout') {
      complete(ack);
      await new Promise((resolve) => setImmediate(resolve));
      // Drain promise assimilation before advancing the host clock.
    }
    t.mock.timers.tick(1);
    const atDeadline = responses.slice();
    if (outcome === 'timeout') {
      complete({ ok: true, id: 'late-accepted-message', delivery: 'queued' });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await runner.done;
    assert.ok(atDeadline.length >= 1, 'host responds at its bounded deadline, before Pi UI expires');
    if (outcome === 'timeout') {
      assert.equal(atDeadline[0].delivery, 'unknown');
      assert.match(atDeadline[0].error, /delivery unknown.*Do not resend automatically/);
    } else for (const response of atDeadline) assert.deepEqual(response, ack);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls, 1, 'pending and completed UI request IDs never invoke the broker twice');
    assert.ok(responses.length >= 2, 'completed replay receives the cached ACK');
    for (const response of responses) assert.deepEqual(response, responses[0]);
    assert.deepEqual(JSON.parse(result.text.split('\n')[0]), responses[0]);
  });
});

test('extension UI timeout reports uncertain acceptance and never resends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tool, calls = 0;
  const signal = new AbortController().signal;
  agentChat({ registerTool: (value) => { tool = value; } });
  const result = tool.execute('tool-timeout', { to: 'exact-instance', text: 'hello' }, signal, undefined, {
    mode: 'rpc', ui: { input: (title, payload, options) => {
      calls++;
      assert.equal(title, CHAT_TITLE);
      assert.deepEqual(JSON.parse(payload), { to: 'exact-instance', text: 'hello' });
      assert.equal(options.signal, signal);
      assert.equal(options.timeout, CHAT_TIMEOUT_MS);
      return new Promise((resolve) => setTimeout(() => resolve(undefined), options.timeout));
    } }
  });
  t.mock.timers.tick(CHAT_TIMEOUT_MS);
  const ack = await result;
  assert.equal(ack.isError, true);
  assert.equal(ack.details.ok, false);
  assert.equal(ack.details.delivery, 'unknown');
  assert.match(ack.details.error, /Do not resend automatically/);
  assert.equal(calls, 1);
});

test('cleanup outcome survives kill, timeout, nonzero exit and successful completion', async (t) => {
  for (const outcome of ['kill', 'timeout', 'exit', 'success']) {
    for (const rejects of [false, true]) await t.test(`${outcome}: cleanup ${rejects ? 'rejects' : 'succeeds'}`, async (t) => {
      let entered, release, cleanups = 0, resolved = false;
      const cleaning = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const runner = setup(t, {
        extraEnv: { FAKE_RPC_MODE: outcome === 'exit' ? 'nonzero-exit' : outcome === 'success' ? '' : 'hang' },
        timeoutMs: outcome === 'timeout' ? 300 : 5000,
        execution: { cleanup: async () => {
          cleanups++; entered(); await gate;
          if (rejects) throw new Error('container cleanup refused');
        } }
      });
      runner.done.then(() => { resolved = true; });
      if (outcome === 'kill') void runner.kill();
      await cleaning;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(resolved, false, 'done cannot report completion while cleanup is pending');
      release();
      const result = await runner.done;
      assert.equal(result.cleanupComplete, !rejects);
      assert.deepEqual(result.cleanupFailure, rejects ? { kind: 'cleanup', message: 'container cleanup refused' } : null);
      assert.equal(result.failure?.kind ?? null, outcome === 'success' ? rejects ? 'cleanup' : null : { kill: 'interrupted', timeout: 'timeout', exit: 'exit' }[outcome]);
      assert.equal(result.ok, outcome === 'success' && !rejects);
      if (outcome === 'exit') assert.equal(result.exitCode, 7);
      await runner.kill();
      assert.equal(cleanups, 1);
    });
  }
});
