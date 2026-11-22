import fs from 'node:fs/promises';
import path from 'node:path';
import { createDurableRuntime } from '../../../src/core/durable/index.js';
import { getModel } from '../../../src/core/llm/index.js';
import { startAgent } from '../../../src/core/agent/index.js';

export async function fixture(t, extra = {}) {
  const base = path.resolve('.scratch/agent-tests');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'review-'));
  const runtime = await createDurableRuntime({ databasePath: path.join(dir, 'db.sqlite'), markerDir: path.join(dir, 'markers'), executorId: 'review', appVersion: 'review', env: {} });
  t.after(async () => { await runtime.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  const options = { runtime, cwd: dir, hiveDir: dir, runId: dir, agentId: 'dwight', instanceId: 'dwight-m1', message: 'task', model: getModel('openai', 'gpt-4o'), agentConfig: { tools: ['write', 'ls', 'read', 'bash', 'powershell'], keywords: ['TASK_COMPLETE', 'BLOCKED'] }, ...extra };
  return { dir, runtime, options, start: overrides => startAgent({ ...options, ...overrides }) };
}
