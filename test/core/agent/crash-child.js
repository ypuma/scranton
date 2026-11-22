import fs from 'node:fs';
import path from 'node:path';
import { createDurableRuntime } from '../../../src/core/durable/index.js';
import { createScriptedProvider, getModel } from '../../../src/core/llm/index.js';
import { startAgent, readAgentHistory } from '../../../src/core/agent/index.js';

const [dir, phase, mode] = process.argv.slice(2);
const runtime = await createDurableRuntime({ databasePath: path.join(dir, 'db.sqlite'), markerDir: path.join(dir, 'markers'), executorId: 'same-executor', appVersion: 'same-version', env: {} });
const turns = phase === 'crash' ? [{ toolCalls: [{ id: 'one', name: mode === 'shell' ? 'powershell' : 'write', arguments: mode === 'shell' ? { command: 'test command' } : { path: 'target.txt', content: 'first' } }] }] : [{ text: 'Recovered [TASK_COMPLETE]' }];
const scripted = createScriptedProvider(turns);
const llm = { stream(model, context, options) {
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(context) + '\n');
  return scripted.stream(model, context, options);
} };
const runner = startAgent({ invocationKey: 'crash-test', runtime, llm, model: getModel('openai', 'gpt-4o'), cwd: dir, instanceId: 'i', runId: 'r', agentId: 'dwight', message: 'task', sessionId: 'stable',
  agentConfig: { tools: ['write', 'powershell'], keywords: ['TASK_COMPLETE'] },
  onAssistantMessage(text) { fs.appendFileSync(path.join(dir, 'assistant.jsonl'), JSON.stringify(text) + '\n'); },
  onTool(tool) { fs.appendFileSync(path.join(dir, 'tools.jsonl'), JSON.stringify(tool) + '\n'); },
  spawn() {
    fs.appendFileSync(path.join(dir, 'spawn.txt'), 'spawn\n');
    if (phase === 'crash') process.exit(77);
    throw new Error('Interrupted command was incorrectly rerun');
  },
  onToolEnd() { if (phase === 'crash') process.exit(77); },
});
const result = await runner.done;
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(await readAgentHistory(runtime, runner.workflowId)));
await runtime.shutdown();
if (!result.ok) process.exitCode = 1;
