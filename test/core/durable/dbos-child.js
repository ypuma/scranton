import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createDurableRuntime, createDurableClient } from '../../../src/core/durable/index.js';

const [action, directory, kind = 'normal'] = process.argv.slice(2);
const id = name => `${basename(directory)}:${name}`;
const config = {
  systemDatabaseUrl: process.env.SCRANTON_TEST_DBOS_URL,
  name: `scranton-${basename(directory)}`, executorId: basename(directory), appVersion: `${basename(directory)}-v1`,
  markerDir: join(directory, 'markers'),
};
if (action === 'watch') {
  const client = await createDurableClient(config);
  try {
    assert.equal(await client.getEvent(id('live'), 'ready'), true);
    const values = [];
    for await (const chunk of client.readStream(id('live'), 'output')) {
      values.push(chunk);
      await client.send(id('live'), 'approved', 'approval', 'once');
    }
    assert.deepEqual(values, [{ offset: 0, value: 'waiting' }]);
    assert.equal(await client.retrieveWorkflow(id('live')).getResult(), 'approved');
  } finally { await client.shutdown(); }
} else {
  const runtime = await createDurableRuntime(config);
  runtime.registerWorkflow('crash', async wf => {
    const one = await wf.runStep(async () => {
      const file = join(directory, 'counter');
      let count = 0;
      try { count = Number(readFileSync(file, 'utf8')); } catch {}
      writeFileSync(file, String(count + 1));
      if (kind === 'guarded' && action === 'crash') process.exit(71);
      return 1;
    }, { name: 'one', atMostOnce: kind === 'guarded' });
    if (action === 'crash') process.exit(71);
    return { one, two: await wf.runStep(async () => 2, { name: 'two' }) };
  });
  runtime.registerWorkflow('live', async wf => {
    await wf.setEvent('ready', true);
    await wf.writeStream('output', 'waiting');
    const answer = await wf.recv('approval', { timeoutSeconds: 120 });
    await wf.closeStream('output');
    return answer;
  });
  runtime.registerWorkflow('terminal', async wf => {
    await wf.setEvent('value', true);
    await wf.writeStream('output', 'retained');
    return 'done';
  });
  runtime.registerWorkflow('pending', wf => wf.recv('never', { timeoutSeconds: 120 }));
  try {
    await runtime.launch();
    if (action === 'crash') await (await runtime.startWorkflow('crash', { workflowId: id('crash') })).getResult();
    if (action === 'recover') {
      assert.deepEqual(await runtime.retrieveWorkflow(id('crash')).getResult(), { one: kind === 'guarded' ? { status: 'interrupted' } : 1, two: 2 });
      assert.equal(readFileSync(join(directory, 'counter'), 'utf8'), '1');
      assert.equal((await runtime.retrieveWorkflow(id('crash')).getStatus()).status, 'SUCCESS');
    }
    if (action === 'live') {
      const handle = await runtime.startWorkflow('live', { workflowId: id('live') });
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(process.execPath, [process.argv[1], 'watch', directory], { timeout: 120000 });
      assert.equal(await handle.getResult(), 'approved');
    }
    if (action === 'prune') {
      for (const workflowId of ['old', 'new']) assert.equal(await (await runtime.startWorkflow('terminal', { workflowId: id(workflowId) })).getResult(), 'done');
      await runtime.startWorkflow('pending', { workflowId: id('pending') });
      assert.deepEqual(await runtime.prune({ olderThanMs: 86400000 }), { deletedWorkflows: 0 });
      assert.deepEqual(await runtime.prune({ olderThanMs: 0, keepLastWorkflows: 1 }), { deletedWorkflows: 1 });
      assert.equal(await runtime.retrieveWorkflow(id('old')).getStatus(), null);
      assert.equal((await runtime.retrieveWorkflow(id('new')).getStatus()).status, 'SUCCESS');
      assert.equal((await runtime.retrieveWorkflow(id('pending')).getStatus()).status, 'PENDING');
      assert.deepEqual(await runtime.prune({ olderThanMs: 0 }), { deletedWorkflows: 1 });
      assert.equal((await runtime.listWorkflows()).length, 1);
      assert.equal(await (await runtime.startWorkflow('terminal', { workflowId: id('old') })).getResult(), 'done');
      await runtime.cancelWorkflow(id('pending'));
    }
  } finally { await runtime.shutdown(); }
}
