import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { child } from './helpers.js';
import { createDurableRuntime, createDurableClient } from '../../../src/core/durable/index.js';
import { redact } from '../../../src/core/durable/shared.js';

const root = resolve('.scratch/durable-tests');
mkdirSync(root, { recursive: true });


for (const backend of ['sqlite', 'dbos']) {
  test(`${backend} durable contract`, { skip: backend === 'dbos' && !process.env.SCRANTON_TEST_DBOS_URL ? 'SCRANTON_TEST_DBOS_URL not set; PostgreSQL not provisioned' : false, timeout: backend === 'dbos' ? 180000 : 60000 }, async t => {
    const directory = mkdtempSync(join(root, `${backend}-`));
    const config = {
      hiveDir: directory, markerDir: join(directory, 'markers'), executorId: 'run:contract', appVersion: 'v1',
      env: backend === 'dbos' ? { DBOS_SYSTEM_DATABASE_URL: process.env.SCRANTON_TEST_DBOS_URL } : { DATABASE_URL: 'postgresql://ignored:secret@invalid/project' },
    };
    const runtime = await createDurableRuntime(config);
    const id = name => `${directory.split(/[\\/]/).at(-1)}-${name}`;
    const start = (name, ...args) => runtime.startWorkflow(name, { workflowId: id(name) }, ...args);
    let calls = 0;
    runtime.registerWorkflow('basic', async (wf, number) => {
      const time = await wf.now(), uuid = await wf.randomUUID();
      const value = await wf.runStep(async attempt => { calls++; return { number, attempt }; }, { name: 'value' });
      await wf.sleep(0);
      return { time, uuid, value };
    });
    runtime.registerWorkflow('messages', async wf => {
      await wf.setEvent('ready', true);
      return [await wf.recv('topic', { timeoutSeconds: 5 }), await wf.recv('topic', { timeoutSeconds: 0.02 })];
    });
    runtime.registerWorkflow('events', async wf => {
      await wf.setEvent('value', 1); await wf.setEvent('value', 2);
      return await wf.recv('none', { timeoutSeconds: 0.01 });
    });
    runtime.registerWorkflow('stream', async wf => {
      await wf.writeStream('output', 'workflow');
      await wf.runStep(async attempt => {
        await wf.writeStream('output', `attempt-${attempt}`);
        if (attempt === 1) throw new Error('retry me');
      }, { name: 'retry', retries: { maxAttempts: 2, intervalSeconds: 0 } });
      await wf.closeStream('output');
      await wf.recv('finish', { timeoutSeconds: 5 });
      return 'done';
    });
    runtime.registerWorkflow('terminal', async wf => { await wf.writeStream('output', 'last'); });
    runtime.registerWorkflow('cancel', async wf => { await wf.setEvent('ready', true); await wf.recv('blocked', { timeoutSeconds: backend === 'dbos' ? 120 : 5 }); return 'not reached'; });
    runtime.registerWorkflow('failure', async wf => wf.runStep(async () => { throw new Error('expected'); }, { name: 'fail', retries: { maxAttempts: 5, intervalSeconds: 0, shouldRetry: () => false } }));
    runtime.registerWorkflow('at-most-once', async wf => wf.runStep(async () => 'once', { name: 'once', atMostOnce: true }));
    await runtime.launch();
    const client = await createDurableClient(config);
    t.after(async () => { await client.shutdown(); await runtime.shutdown(); rmSync(directory, { recursive: true, force: true }); });

    await t.test('checkpoint helpers, attempts, workflow ID reuse and client handles', async () => {
      const handle = await start('basic', 42);
      const result = await handle.getResult();
      assert.equal(typeof result.time, 'number'); assert.match(result.uuid, /^[0-9a-f-]{36}$/);
      assert.deepEqual(result.value, { number: 42, attempt: 1 });
      assert.deepEqual(await (await start('basic', 999)).getResult(), result);
      assert.equal(calls, 1);
      assert.equal((await client.retrieveWorkflow(handle.workflowId).getStatus()).status, 'SUCCESS');
      assert.ok((await client.listWorkflows({ status: 'SUCCESS' })).some(row => row.workflowId === handle.workflowId));
    });
    await t.test('send idempotency and recv timeout', async () => {
      const handle = await start('messages');
      await client.getEvent(handle.workflowId, 'ready', { timeoutSeconds: 5 });
      await client.send(handle.workflowId, 'hello', 'topic', 'dedupe');
      await client.send(handle.workflowId, 'duplicate', 'topic', 'dedupe');
      assert.deepEqual(await handle.getResult(), ['hello', null]);
    });
    await t.test('event last-write-wins and getEvent timeout', async () => {
      const handle = await start('events'); assert.equal(await handle.getResult(), null);
      assert.equal(await client.getEvent(handle.workflowId, 'value'), 2);
      assert.equal(await client.getEvent(handle.workflowId, 'absent', { timeoutSeconds: 0.01 }), null);
    });
    await t.test('step stream retries persist, offsets resume and explicit close ends while pending', async () => {
      const handle = await start('stream');
      const values = [];
      for await (const chunk of client.readStream(handle.workflowId, 'output')) values.push(chunk);
      assert.deepEqual(values, [{ offset: 0, value: 'workflow' }, { offset: 1, value: 'attempt-1' }, { offset: 2, value: 'attempt-2' }]);
      assert.equal((await handle.getStatus()).status, 'PENDING');
      const tail = [];
      for await (const chunk of client.readStream(handle.workflowId, 'output', { fromOffset: 2 })) tail.push(chunk);
      assert.deepEqual(tail, values.slice(2));
      await client.send(handle.workflowId, true, 'finish'); assert.equal(await handle.getResult(), 'done');
    });
    await t.test('terminal workflow ends an unclosed stream', async () => {
      const handle = await start('terminal'); await handle.getResult();
      const values = [];
      for await (const chunk of client.readStream(handle.workflowId, 'output')) values.push(chunk);
      assert.deepEqual(values, [{ offset: 0, value: 'last' }]);
    });
    await t.test('cancellation takes effect at the next checkpoint', async () => {
      const handle = await start('cancel'); await client.getEvent(handle.workflowId, 'ready');
      await runtime.cancelWorkflow(handle.workflowId);
      await assert.rejects(handle.getResult(), /cancel/i);
      assert.equal((await handle.getStatus()).status, 'CANCELLED');
    });
    await t.test('errors and shouldRetry predicate', async () => {
      const handle = await start('failure'); await assert.rejects(handle.getResult(), /expected/);
      assert.equal((await handle.getStatus()).status, 'ERROR');
    });
    await t.test('at-most-once completed result', async () => assert.equal(await (await start('at-most-once')).getResult(), 'once'));
  });
}

test('SQLite live events, streams, messages and handles in a second process', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(root, 'process-'));
  const runtime = await createDurableRuntime({ hiveDir: directory, env: {} });
  runtime.registerWorkflow('live', async wf => {
    await wf.setEvent('ready', { approval: true });
    await wf.writeStream('output', 'waiting');
    const answer = await wf.recv('approval', { timeoutSeconds: 10 });
    await wf.closeStream('output');
    return answer;
  });
  await runtime.launch();
  t.after(async () => { await runtime.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  await runtime.startWorkflow('live', { workflowId: 'live' });
  const result = await child(['watch', directory]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { event: { approval: true }, values: [{ offset: 0, value: 'waiting' }], result: 'approved', count: 1 });
});

test('database URL redaction masks username and password', () => {
  const result = redact('failed postgresql://alice:password@host/db and postgres://bob:p%40ss@host/db');
  assert.equal(result, 'failed postgresql://***@host/db and postgresql://***@host/db');
});
