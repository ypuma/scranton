import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeConfig, scriptedConfig, tempDir, readEvents } from './helpers.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startAgent } from '../../src/core/agent/index.js';
import { createDurableRuntime } from '../../src/core/durable/index.js';

const marker = '.scranton-sandbox-owned';

test('fakeConfig and scriptedConfig return explicit, trusted-host scripted configurations', t => {
  for (const factory of [fakeConfig, scriptedConfig]) {
    const config = factory(tempDir(t));
    assert.equal(config.scripted, 'happy');
    assert.equal(config.execution.sandbox.mode, 'host');
    assert.equal(config.pi, undefined);
  }
  assert.equal(process.env.SCRANTON_FAKE_MODE, '1');
  assert.ok(process.env.SCRANTON_CREDENTIALS_DIR.startsWith(path.resolve('.scratch')));
});

for (const failure of [false, true]) test(`one runtime per run, shutdown after ${failure ? 'failed' : 'successful'} invocation`, async t => {
  const config = fakeConfig(tempDir(t)), calls = [], options = [];
  let runtime;
  const o = new Orchestrator({config, noPlan: true, onBreaker: 'abort',
    runtimeFactory: async settings => {
      calls.push(settings); runtime = await createDurableRuntime({...settings, env: {}});
      const shutdown = runtime.shutdown.bind(runtime);
      runtime.shutdown = async () => { calls.push('shutdown'); return shutdown(); };
      return runtime;
    },
    startRunner: input => {
      options.push(input);
      assert.equal(input.runtime, runtime);
      for (const key of ['pi', 'execution', 'spec', 'transport']) assert.equal(Object.hasOwn(input, key), false, key);
      return startAgent({...input, ...(failure ? {scripted: {scenario: 'happy', fail: 'exit1'}} : {})});
    }});
  const result = await o.run('Run lifecycle');
  assert.equal(result.status, failure ? 'aborted' : 'success');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].hiveDir, config.hiveDir);
  assert.equal(calls[0].executorId, `run:${o.runId}`);
  assert.equal(calls[1], 'shutdown');
  assert.ok(fs.existsSync(path.join(config.hiveDir, 'dbos.sqlite')));
  assert.ok(options.length);
});

test('invocation keys distinguish planning retries, gate retries, cycles and closing report', async t => {
  const config = fakeConfig(tempDir(t)); config.execution.conversation = true;
  let planFailed = false, gateFailed = false;
  const keys = [];
  const o = new Orchestrator({config, hitl: async () => ({decision: 'retry'}),
    extraEnv: {SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'flaky'},
    startRunner: options => {
      assert.equal(keys.includes(options.invocationKey), false, 'every invocation has a fresh deterministic key');
      keys.push(options.invocationKey);
      const fail = options.agentId === 'michael' && !planFailed || options.agentId === 'angela' && !gateFailed;
      if (options.agentId === 'michael') planFailed = true;
      if (options.agentId === 'angela') gateFailed = true;
      return startAgent({...options, ...(fail ? {scripted: {scenario: 'flaky', fail: 'exit1'}} : {})});
    }});
  assert.equal((await o.run('Invocation identity')).status, 'success');
  assert.equal(new Set(keys).size, keys.length);
  for (const key of ['run/cycle-0/michael/plan/attempt-1', 'run/cycle-0/michael/plan/plan-retry/attempt-2', 'm1/cycle-1/angela/gate/attempt-2', 'm2/cycle-2/dwight/work/attempt-1', 'run/cycle-0/michael/report/attempt-1']) assert.ok(keys.includes(key), key);
});

for (const failPrepare of [false, true]) test(`native sandbox prepare/spawn seam/dispose (${failPrepare ? 'setup failure' : 'success'})`, async t => {
  const config = fakeConfig(tempDir(t));
  config.execution.isolation = 'worktree'; config.execution.sandbox = {mode: 'scranton', network: 'none'};
  const order = [], temps = [], sandboxes = [];
  let protectedCount = 0;
  const o = new Orchestrator({config, noPlan: true, onBreaker: 'abort',
    protectCredentials: () => {protectedCount++;},
    sandboxFactory: settings => {
      assert.equal(settings.network, false);
      assert.equal(path.dirname(settings.worktree), path.dirname(settings.tempDir));
      for (const root of [settings.worktree, settings.tempDir]) assert.equal(fs.readFileSync(path.join(root, marker), 'utf8'), 'scranton-sandbox-v1\n');
      temps.push(settings.tempDir);
      const sandbox = {prepare() {order.push('prepare'); if (failPrepare) throw Error('Native sandbox helper is missing');}, spawn() {throw Error('Unexpected tool spawn');}, async dispose() {order.push('dispose');}};
      sandboxes.push(sandbox); return sandbox;
    },
    startRunner: options => {
      order.push('start'); assert.ok(sandboxes.includes(options.sandbox));
      return {done: Promise.resolve({ok: true, text: 'Done', keyword: options.agentId === 'dwight' ? 'TASK_COMPLETE' : 'TEST_PASSED', exitCode: 0, durationMs: 0}), kill: async () => {}};
    }});
  const result = await o.run('Sandbox lifecycle');
  assert.equal(result.status, failPrepare ? 'failed' : 'success', result.summary);
  assert.deepEqual(order, failPrepare ? ['prepare', 'dispose'] : ['prepare', 'start', 'dispose', 'prepare', 'start', 'dispose']);
  assert.equal(protectedCount, process.platform === 'win32' ? 1 : 0);
  assert.ok(temps.every(dir => !fs.existsSync(dir)));
  assert.equal(fs.existsSync(path.join(config.workspace, marker)), false);
  assert.ok(!o.worktrees.changedFiles({milestoneId: 'm1'})?.includes(marker));
});

test('native credential protection failure prevents runner start', async t => {
  if (process.platform !== 'win32') return t.skip('Windows mandatory labels');
  const config = fakeConfig(tempDir(t)); config.execution.isolation = 'worktree'; config.execution.sandbox.mode = 'scranton';
  let started = false;
  const o = new Orchestrator({config, noPlan: true, protectCredentials: () => {throw Error('Credential protection failed');}, startRunner: () => {started = true;}});
  assert.match((await o.run('Fail closed')).summary, /Credential protection failed/);
  assert.equal(started, false);
});

test('Docker setup failure prevents runner launch and shuts down runtime; host does not prepare a sandbox', async t => {
  const config = fakeConfig(tempDir(t)); config.execution.sandbox.mode = 'docker'; config.execution.isolation = 'worktree';
  let preparations = 0, shutdown = false;
  const o = new Orchestrator({config, noPlan: true, extraEnv: { PATH: '', Path: '' }, sandboxFactory: () => {throw Error('native factory must not handle Docker');}, runtimeFactory: async settings => {
    const runtime = await createDurableRuntime(settings), close = runtime.shutdown.bind(runtime);
    runtime.shutdown = async () => { shutdown = true; return close(); };
    return runtime;
  }, startRunner: () => { preparations++; throw Error('must not start runner'); }});
  assert.match((await o.run('Docker')).summary, /Docker CLI not found; no host fallback/);
  assert.equal(preparations, 0); assert.equal(shutdown, true);
  const host = new Orchestrator({config: fakeConfig(tempDir(t)), noPlan: true, sandboxFactory: () => {throw Error('host must not prepare sandbox');}});
  assert.equal((await host.run('Trusted host')).status, 'success');
  assert.equal(readEvents(host.hive.dir).at(-1).type, 'run_finished');
});
