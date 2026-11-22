import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDurableRuntime, createDurableClient } from '../../../src/core/durable/index.js';

const [action, directory, kind = 'normal', version = 'v1', executor = 'run:test'] = process.argv.slice(2);
const config = { databasePath: join(directory, 'dbos.sqlite'), markerDir: join(directory, 'markers'), executorId: executor, appVersion: version, env: {} };
if (action === 'watch') {
  const client = await createDurableClient(config);
  const event = await client.getEvent('live', 'ready', { timeoutSeconds: 5 });
  const values = [];
  for await (const chunk of client.readStream('live', 'output')) {
    values.push(chunk);
    await client.send('live', 'approved', 'approval', 'once');
  }
  const result = await client.retrieveWorkflow('live').getResult();
  console.log(JSON.stringify({ event, values, result, count: (await client.listWorkflows()).length }));
  await client.shutdown();
} else {
  const runtime = await createDurableRuntime(config);
  runtime.registerWorkflow('crash', async wf => {
    let helpers;
    if (kind === 'operations') {
      helpers = [await wf.now(), await wf.randomUUID()];
      await wf.setEvent('helpers', helpers);
      await wf.writeStream('output', 'before');
      const message = await wf.recv('input', { timeoutSeconds: 1 });
      if (message !== 'hello') throw new Error('Lost checkpointed message');
      await wf.sleep(0);
    }
    const one = await wf.runStep(async () => {
      const path = join(directory, 'counter');
      let value = 0;
      try { value = Number(readFileSync(path, 'utf8')); } catch {}
      writeFileSync(path, String(value + 1));
      if (kind === 'at-most-once' && action === 'crash') process.exit(71);
      return 1;
    }, { name: kind === 'changed' ? 'different' : 'one', atMostOnce: kind.startsWith('at-most-once') });
    if (action === 'crash') process.exit(71);
    const two = await wf.runStep(async () => 2, { name: 'two' });
    if (kind === 'operations') {
      await wf.writeStream('output', 'after');
      await wf.closeStream('output');
      return { one, two, helpers };
    }
    return { one, two };
  });
  await runtime.launch();
  if (action === 'crash') {
    await runtime.startWorkflow('crash', { workflowId: 'fixed' });
    if (kind === 'operations') await runtime.send('fixed', 'hello', 'input', 'input');
  }
  else if (action === 'inspect') {
    console.log(JSON.stringify(await runtime.listWorkflows()));
    await runtime.shutdown();
  } else {
    try {
      const handle = runtime.retrieveWorkflow('fixed');
      const result = await handle.getResult();
      const extra = {};
      if (kind === 'operations') {
        extra.helpers = await runtime.getEvent('fixed', 'helpers');
        extra.stream = [];
        for await (const chunk of runtime.readStream('fixed', 'output')) extra.stream.push(chunk);
      }
      console.log(JSON.stringify({ result, status: await handle.getStatus(), ...extra }));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
    await runtime.shutdown();
  }
}
