import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startPi } from '../../src/core/pi-runner.js';
import { RPC_STARTUP_TIMEOUT_MS } from '../../src/core/pi-rpc-session.js';
import { prepareSandbox } from '../../src/core/sandbox.js';
import { ChatRouter } from '../../src/core/chat-router.js';
import { buildPiArgs } from '../../src/core/pi-command.js';
import { fakeConfig } from './helpers.js';
import { JsonlSplitter } from '../../src/core/jsonl.js';

function fixture(t, extra = {}) {
  const root = path.resolve('.scratch/rpc-startup3');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'test-'));
  const runners = [];
  t.after(async () => {
    await Promise.all(runners.map((runner) => runner.kill()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const config = fakeConfig(dir);
  const options = { transport: 'rpc', spec: { argv: [process.execPath, path.resolve('tools/fake-pi-rpc.js')], shell: false },
    cwd: dir, agentId: 'dwight', agentConfig: config.agents.dwight, pi: config.pi,
    hive: { inboxPath: () => path.join(dir, 'inbox.md'), sessionDir: () => path.join(dir, 'session') },
    message: 'startup test [TASK_COMPLETE]', timeoutMs: 0, ...extra };
  const start = (overrides = {}) => {
    const runner = startPi({ ...options, ...overrides });
    runners.push(runner);
    return runner;
  };
  return { dir, options, start };
}

function controlled(t, extra = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let child;
  const records = [];
  const f = fixture(t);
  const runner = f.start({ ...extra, onSpawn: (value) => {
    child = value;
    child.stdin.write = (line) => { records.push(JSON.parse(line)); return true; };
  } });
  const ack = (record) => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'response', id: record.id, command: record.type, success: true, data: { disposition: 'started' } })}\n`));
  return { runner, records, ack, child };
}

test('first prompt accepts an ACK after 5 s within the spawn startup budget; later steer still expires at 5 s', async (t) => {
  const { runner, records, ack } = controlled(t, { ackTimeoutMs: 999999, startupTimeoutMs: 999999 });
  assert.equal(RPC_STARTUP_TIMEOUT_MS, 60000);
  t.mock.timers.tick(5001);
  ack(records[0]);
  await new Promise((resolve) => setImmediate(resolve));
  const steer = runner.sendMessage('later');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.at(-1).type, 'steer', 'first prompt remains alive after 5 s');
  t.mock.timers.tick(4999);
  let resolved = false;
  steer.then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  t.mock.timers.tick(1);
  assert.match((await steer).error, /steer ACK timed out/);
  assert.equal((await runner.done).failure.message, 'steer ACK timed out');
});

test('no first prompt ACK fails at the spawn startup deadline with an actionable reason', async (t) => {
  const { runner, records, ack } = controlled(t);
  assert.equal(records[0].type, 'prompt');
  let resolved = false;
  runner.done.then(() => { resolved = true; });
  t.mock.timers.tick(59999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  const steer = runner.sendMessage('still starting');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1);
  const result = await runner.done;
  assert.equal((await steer).delivery, 'unknown');
  assert.equal(result.failure.kind, 'rpc_timeout');
  assert.equal(result.failure.message, 'pi did not start within 60 s (no answer to the first prompt)');
});

test('startup overrides only shorten the deadline and it is measured from spawn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t);
  const runner = f.start({ startupTimeoutMs: 200, onSpawn: (child) => {
    child.stdin.write = () => true;
    t.mock.timers.tick(150);
  } });
  t.mock.timers.tick(49);
  let resolved = false;
  runner.done.then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  t.mock.timers.tick(1);
  assert.equal((await runner.done).failure.message, 'pi did not start within 0.2 s (no answer to the first prompt)');
});

test('real subprocess tolerates delayed stdin startup independently of the normal ACK budget', async (t) => {
  const f = fixture(t);
  const result = await f.start({ ackTimeoutMs: 50, startupTimeoutMs: 10000, timeoutMs: 15000,
    extraEnv: { FAKE_RPC_STARTUP_DELAY_MS: '250' } }).done;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.keyword, 'TASK_COMPLETE');
});

test('fake Docker runner tolerates startup delay and verifies named cleanup on success, timeout and kill', async (t) => {
  for (const outcome of ['success', 'timeout', 'kill']) await t.test(outcome, async (t) => {
    const f = fixture(t);
    const workspace = path.join(f.dir, 'workspace'), sessionDir = path.join(f.dir, 'session');
    fs.mkdirSync(workspace); fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(workspace, '.git'), 'gitdir: /not-mounted\n');
    const systemPromptFile = path.join(f.dir, 'prompt.md'); fs.writeFileSync(systemPromptFile, 'test');
    const calls = [];
    const execution = await prepareSandbox({ sandbox: { mode: 'docker' }, workspace, sessionDir, systemPromptFile, env: {} }, {
      executable: 'fake-docker', run: async (_exe, args) => { calls.push(args); return ['info', 'image'].includes(args[0]) ? 'linux' : ''; }
    });
    const shim = path.join(f.dir, 'fake-docker.mjs');
    fs.writeFileSync(shim, `import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const mounts = args.filter((_, i) => args[i - 1] === '--mount');
const session = mounts.find(m => m.includes('target=/session')).slice('type=bind,source='.length).split(',target=')[0];
const piArgs = args.slice(args.indexOf('scranton-sandbox:1.5.2-r1') + 1);
piArgs[piArgs.indexOf('--session-dir') + 1] = session;
const child = spawn(process.execPath, [${JSON.stringify(path.resolve('tools/fake-pi-rpc.js'))}, ...piArgs], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
`);
    const runner = f.start({ execution: { ...execution, spec: { argv: [process.execPath, shim], shell: false } },
      ackTimeoutMs: 50, startupTimeoutMs: outcome === 'timeout' ? 150 : 10000, timeoutMs: 15000,
      extraEnv: { FAKE_RPC_STARTUP_DELAY_MS: outcome === 'success' ? '250' : '2000' } });
    if (outcome === 'kill') await runner.kill();
    const result = await runner.done;
    assert.equal(result.ok, outcome === 'success', JSON.stringify(result));
    assert.equal(result.cleanupComplete, true);
    if (outcome === 'timeout') assert.match(result.failure.message, /pi did not start within 0.15 s/);
    const name = execution.argsPrefix[execution.argsPrefix.indexOf('--name') + 1];
    assert.deepEqual(calls.slice(-2), [['rm', '-f', name], ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']]);
  });
});

test('agent JSON and RPC launches do not force offline mode', (t) => {
  const { options } = fixture(t);
  for (const transport of ['json', 'rpc']) {
    const args = buildPiArgs({ agent: options.agentConfig, pi: options.pi, transport, inboxFile: 'inbox.md' });
    assert.ok(!args.includes('--offline'));
  }
});

test('startup steer survives 5 s with prompt then steer ACKs in input order', async (t) => {
  const { runner, records, ack } = controlled(t);
  const steer = runner.sendMessage('queued during startup');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records.map((r) => r.type), ['prompt', 'steer']);
  let delivery;
  steer.then((value) => { delivery = value; });
  t.mock.timers.tick(6500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery, undefined, 'startup steer must not expire at the normal 5 s deadline');
  ack(records[0]);
  ack(records[1]);
  assert.equal((await steer).ok, true);
  assert.equal(records.filter((r) => r.type === 'steer').length, 1);
});

test('first ACK does not change a pending startup steer deadline', async (t) => {
  const { runner, records, ack } = controlled(t);
  const steer = runner.sendMessage('no steer answer');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(6500);
  ack(records[0]);
  let delivery;
  steer.then((value) => { delivery = value; });
  t.mock.timers.tick(53499);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery, undefined);
  t.mock.timers.tick(1);
  assert.match((await steer).error, /pi did not start within 60 s/);
  assert.equal((await runner.done).failure.message, 'pi did not start within 60 s (no answer to the first prompt)');
});

test('abort during startup tolerates clear_queue ACK before the prompt', async (t) => {
  const { runner, records, ack } = controlled(t);
  const aborted = runner.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(records.map((r) => r.type), ['prompt', 'clear_queue']);
  t.mock.timers.tick(6500);
  ack(records[1]); // clear_queue can ACK before prompt preflight completes.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.at(-1).type, 'abort', 'clear_queue must survive startup and allow abort');
  ack(records.at(-1));
  const result = await aborted;
  assert.deepEqual(result.failure, { kind: 'aborted', message: 'Pi run aborted' });
  assert.equal(result.exitCode, 0, 'abort must close cleanly without a prompt ACK');
  t.mock.timers.tick(60000);
  assert.strictEqual(await runner.done, result, 'startup timers must be cleaned up after abort');
});

test('real subprocess delivers pre-spawn queued chat once with steer ACK before delayed prompt ACK', async (t) => {
  const f = fixture(t);
  const events = [];
  const router = new ChatRouter({ hiveDir: f.dir, runId: 'startup', emit: (type, fields) => events.push({ type, ...fields }) });
  router.register('dwight-m1');
  const queued = await router.send('human', { to: 'dwight-m1', text: 'pre-spawn chat' });
  assert.equal(queued.delivery, 'queued');
  const responses = [], splitter = new JsonlSplitter();
  const runner = f.start({ ackTimeoutMs: 500, startupTimeoutMs: 10000, timeoutMs: 15000,
    extraEnv: { SCRANTON_FAKE_PROMPT_ACK_DELAY_MS: '2000' }, onSpawn: (child) => {
      child.stdout.on('data', (chunk) => {
        for (const line of splitter.push(chunk)) {
          const record = JSON.parse(line);
          if (record.type === 'response') responses.push(record.command);
        }
      });
    } });
  await router.attach('dwight-m1', runner);
  const result = await runner.done;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.keyword, 'TASK_COMPLETE');
  assert.deepEqual(responses, ['steer', 'prompt'], 'fake pi must ACK queued chat before prompt preflight');
  const received = JSON.parse(result.text.split('\n')[0]);
  assert.deepEqual(received.steers, [`[Message from human; id ${queued.id}]\npre-spawn chat`]);
  assert.deepEqual(events.map((e) => [e.type, e.delivery]), [['chat_message', 'queued'], ['chat_delivery', 'delivered']]);
  await router.attach('dwight-m1', runner);
  assert.equal(events.length, 2, 'reattaching must not replay delivered messages');
  await router.close();
});

test('steer ACK at 6.5 s does not shorten the first prompt deadline; prompt ACK at 12 s succeeds', async (t) => {
  const { runner, records, ack, child } = controlled(t);
  const steer = runner.sendMessage('queued before the first answer');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(6500);
  ack(records[1]);
  assert.equal((await steer).ok, true);
  let ended = false;
  runner.done.then(() => { ended = true; });
  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, 'steer ACK must not shorten the first prompt startup deadline');
  t.mock.timers.tick(500);
  ack(records[0]);
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: '[TASK_COMPLETE]', stopReason: 'stop' } })}\n${JSON.stringify({ type: 'agent_settled' })}\n`));
  assert.equal((await runner.done).ok, true);
});

test('steer ACK at 6.5 s leaves an unanswered prompt on its 60 s startup deadline', async (t) => {
  const { runner, records, ack } = controlled(t);
  const steer = runner.sendMessage('answer only the steer');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(6500);
  ack(records[1]);
  assert.equal((await steer).ok, true);
  let ended = false;
  runner.done.then(() => { ended = true; });
  t.mock.timers.tick(53499);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, 'unanswered prompt must retain its spawn + 60 s deadline');
  t.mock.timers.tick(1);
  const result = await runner.done;
  assert.equal(result.failure.kind, 'rpc_timeout');
  assert.equal(result.failure.message, 'pi did not start within 60 s (no answer to the first prompt)');
});

test('steer sent after another steer answers gets only the normal 5 s while prompt starts', async (t) => {
  const { runner, records, ack } = controlled(t);
  const first = runner.sendMessage('first steer');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(6500);
  ack(records[1]);
  await first;
  const later = runner.sendMessage('later steer');
  await new Promise((resolve) => setImmediate(resolve));
  let delivery;
  later.then((value) => { delivery = value; });
  t.mock.timers.tick(4999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery, undefined);
  t.mock.timers.tick(1);
  assert.match((await later).error, /steer ACK timed out/);
  assert.equal((await runner.done).failure.message, 'steer ACK timed out');
});
