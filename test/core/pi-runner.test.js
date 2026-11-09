import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';
import { Hive } from '../../src/core/hive.js';
import { startPi } from '../../src/core/pi-runner.js';
import { FAKE_PI, fakeConfig, tempDir } from './helpers.js';

test('kill() never leaves a ref-held 5 s fallback timer behind', async (t) => {
  const dir = tempDir(t);
  const hive = new Hive(path.join(dir, 'hive'));
  hive.init();
  hive.deliver({ to: 'dwight', from: 'human', kind: 'task', runId: 'r1', body: 'x' });
  const config = fakeConfig(dir);
  const realSetTimeout = globalThis.setTimeout;
  const fallbacks = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = realSetTimeout(fn, ms, ...rest);
    if (ms === 5000) fallbacks.push(timer);
    return timer;
  };
  t.after(() => (globalThis.setTimeout = realSetTimeout));
  for (const delay of [700, 0]) {
    const runner = startPi({
      spec: { argv: [process.execPath, FAKE_PI], shell: false },
      agentId: 'dwight',
      agentConfig: config.agents.dwight,
      pi: config.pi,
      cwd: dir,
      hive,
      runId: 'r1',
      extraEnv: { FAKE_PI_FAIL: 'hang' }
    });
    await new Promise((r) => realSetTimeout(r, delay));
    await runner.kill('user');
    const result = await runner.done;
    assert.equal(result.failure.kind, 'interrupted');
    await runner.kill('user'); // after finish: must be a no-op
  }
  globalThis.setTimeout = realSetTimeout;
  for (const timer of fallbacks) assert.equal(timer.hasRef(), false, 'a pending fallback timer must not keep the process alive');
});

test('RPC preparation and both child transports exclude parent lease env after every merge', async (t) => {
  const root = path.resolve('.scratch/fix-final-runtime');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'env.mjs');
  const keys = ['SCRANTON_RUN_LEASE', 'SCRANTON_PARENT_GUARD', 'SCRANTON_ENV_PROVIDER_TEST', 'SCRANTON_ENV_CHAT_TEST'];
  fs.writeFileSync(fixture, `
    import { createInterface } from 'node:readline';
    const report = () => {
      const text = JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter(k => k in process.env).map(k => [k, process.env[k]])));
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:text,stopReason:'stop'}}));
      console.log(JSON.stringify({type:'agent_settled',aborted:false}));
    };
    if (process.argv.includes('rpc')) {
      createInterface({input:process.stdin}).on('line', line => {
        const r = JSON.parse(line);
        console.log(JSON.stringify({type:'response',id:r.id,command:r.type,success:true}));
        report();
      }).on('close', () => process.exit(0));
    } else report();
  `);
  const parent = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (parent[k] === undefined) delete process.env[k]; else process.env[k] = parent[k]; } });
  for (const k of keys) process.env[k] = 'parent-test';
  const config = fakeConfig(dir);
  const extraEnv = { SCRANTON_RUN_LEASE: 'extra-lease', SCRANTON_PARENT_GUARD: 'extra-guard',
    SCRANTON_ENV_PROVIDER_TEST: 'provider-test', SCRANTON_ENV_CHAT_TEST: 'chat-test' };
  for (const transport of ['json', 'rpc']) {
    const result = await startPi({ transport, spec: { argv: [process.execPath, fixture], shell: false },
      agentId: 'dwight', agentConfig: config.agents.dwight, pi: config.pi, cwd: dir,
      hive: { dir, inboxPath: () => path.join(dir, 'inbox.md'), sessionDir: () => dir },
      message: 'env probe', extraEnv, timeoutMs: 5000,
      execution: async ({ env }) => {
        assert.equal(Object.hasOwn(env, 'SCRANTON_RUN_LEASE'), false);
        assert.equal(Object.hasOwn(env, 'SCRANTON_PARENT_GUARD'), false);
        assert.equal(env.SCRANTON_ENV_PROVIDER_TEST, 'provider-test');
        assert.equal(env.SCRANTON_ENV_CHAT_TEST, 'chat-test');
        return { env: { SCRANTON_RUN_LEASE: 'execution-lease', SCRANTON_PARENT_GUARD: 'execution-guard' } };
      }
    }).done;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.text), { SCRANTON_ENV_PROVIDER_TEST: 'provider-test', SCRANTON_ENV_CHAT_TEST: 'chat-test' });
    for (const k of keys) assert.equal(process.env[k], 'parent-test');
    assert.equal(extraEnv.SCRANTON_RUN_LEASE, 'extra-lease');
  }
});
