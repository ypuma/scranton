import { createDurableRuntime } from '../../../src/core/durable/index.js';

const runtime = await createDurableRuntime({
  systemDatabaseUrl: process.env.SCRANTON_TEST_DBOS_URL,
  executorId: `cold-${process.pid}`, appVersion: 'cold-v1',
  logger: { error: message => console.error(message) },
});
runtime.registerWorkflow('cold', async () => 'ready');
process.send('ready');
await new Promise(resolve => process.once('message', resolve));
try {
  await runtime.launch();
  const handle = await runtime.startWorkflow('cold', { workflowId: `cold-${process.pid}` });
  if (await handle.getResult() !== 'ready') throw new Error('Cold workflow failed');
} finally {
  await runtime.shutdown();
  process.disconnect();
}
