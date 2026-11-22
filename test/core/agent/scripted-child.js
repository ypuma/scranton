import { startAgent, shutdownAgentRuntimes } from '../../../src/core/agent/index.js';

const cwd = process.argv[2];
const runner = startAgent({ cwd, hiveDir: cwd, agentId: 'michael', runId: 'child-script', message: '## Request\nChild process demo',
  agentConfig: { tools: ['ls'], keywords: ['PLAN_READY', 'ANSWER_READY'] } });
try {
  const result = await runner.done;
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally { await shutdownAgentRuntimes(); }
