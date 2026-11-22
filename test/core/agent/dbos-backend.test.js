import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDurableRuntime, createDurableClient } from '../../../src/core/durable/index.js';
import { createScriptedProvider, getModel } from '../../../src/core/llm/index.js';
import { startAgent, readAgentHistory, readAgentOutput } from '../../../src/core/agent/index.js';

async function runAgent(directory) {
  const config = {
    systemDatabaseUrl: process.env.SCRANTON_TEST_DBOS_URL,
    name: 'scranton-agent-test', executorId: path.basename(directory), appVersion: 'dbos-agent-v1',
    markerDir: path.join(directory, 'markers'),
  };
  const runtime = await createDurableRuntime(config);
  let client;
  try {
    const llm = createScriptedProvider([
      { toolCalls: [{ id: 'write-1', name: 'write', arguments: { path: 'result.txt', content: 'DBOS tool executed' } }] },
      { text: 'Verified\nTASK_COMPLETE' },
    ]);
    const options = {
      runtime, llm, model: getModel('openai', 'gpt-4o'), cwd: directory, hiveDir: directory,
      runId: 'dbos-test', instanceId: 'dwight-test', agentId: 'dwight', invocationKey: 'tool-and-keyword',
      message: 'Write result.txt and finish.', agentConfig: { tools: ['write'], keywords: ['TASK_COMPLETE'] },
    };
    const runner = startAgent(options);
    const result = await runner.done;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.keyword, 'TASK_COMPLETE');
    assert.equal(await fs.readFile(path.join(directory, 'result.txt'), 'utf8'), 'DBOS tool executed');
    assert.equal(llm.calls.length, 2);
    client = await createDurableClient(config);
    assert.equal((await client.retrieveWorkflow(runner.workflowId).getStatus()).status, 'SUCCESS');
    assert.equal((await client.getEvent(runner.workflowId, 'agent_state')).phase, 'done');
    const history = await readAgentHistory(client, runner.workflowId);
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(history[2].isError, false);
    assert.equal((await readAgentOutput(client, runner.workflowId)).map(record => record.delta ?? '').join(''), result.text);
    assert.deepEqual(await startAgent(options).done, result);
    assert.equal(llm.calls.length, 2);
  } finally {
    try { await client?.shutdown(); } finally { await runtime.shutdown(); }
  }
}

if (process.argv[2] === '--dbos-agent-child') {
  await runAgent(process.argv[3]);
} else {
  test('DBOS agent executes a tool, streams history and output, and replays its final keyword', {
    skip: !process.env.SCRANTON_TEST_DBOS_URL && 'SCRANTON_TEST_DBOS_URL not set; disposable PostgreSQL required',
    timeout: 70000,
  }, async t => {
    const root = path.resolve('.scratch/agent-tests');
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'dbos-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    // Isolate the SDK singleton and never initialize credentials from a real profile.
    await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--dbos-agent-child', directory], {
      timeout: 60000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SCRANTON_CREDENTIALS_DIR: path.join(directory, 'credentials'), PI_CODING_AGENT_DIR: path.join(directory, 'pi') },
    });
  });
}
