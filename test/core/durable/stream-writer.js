import { createDurableRuntime } from '../../../src/core/durable/index.js';

const runtime = await createDurableRuntime({ hiveDir: process.argv[2], env: {} });
try {
  runtime.registerWorkflow('stream', async wf => {
    await wf.writeStream('output', 'first');
    await wf.writeStream('output', 'last');
    await wf.closeStream('output');
  });
  await runtime.launch();
  await (await runtime.startWorkflow('stream', { workflowId: 'process-stream' })).getResult();
} finally { await runtime.shutdown(); }
