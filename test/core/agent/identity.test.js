import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentWorkflowId, agentHiveScopePrefix } from '../../../src/core/agent/index.js';
import { createScriptedProvider } from '../../../src/core/llm/index.js';
import { fixture } from './helpers.js';

test('hive identity is canonical, stable before creation, case-insensitive on Windows and keeps explicit IDs', async t => {
  const f = await fixture(t);
  const hiveDir = path.join(f.dir, 'new', 'hive');
  const prefix = agentHiveScopePrefix(hiveDir);
  await fs.mkdir(hiveDir, { recursive: true });
  assert.equal(agentHiveScopePrefix(hiveDir), prefix);
  assert.equal(agentHiveScopePrefix(path.join(hiveDir, '..', 'hive')), prefix);
  assert.notEqual(agentHiveScopePrefix(path.join(f.dir, 'other')), prefix);
  if (process.platform === 'win32') assert.equal(agentHiveScopePrefix(hiveDir.toUpperCase()), prefix);
  const alias = path.join(f.dir, 'alias');
  await fs.symlink(hiveDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(agentHiveScopePrefix(alias), prefix);
  assert.equal(agentWorkflowId({ hiveDir }), prefix + 'single/agent/default');
  assert.equal(agentWorkflowId({ hive: { dir: hiveDir } }), agentWorkflowId({ hiveDir }));
  assert.equal(agentWorkflowId({ hiveDir, projectId: 'p/x', chatId: 'c/y' }), 'scr:p%2Fx/c%2Fy/single/agent/default');
  assert.equal(agentWorkflowId(), 'scr:single/hive/single/agent/default');
});

test('two hives in one database replay their own deterministic invocation without new model calls', async t => {
  const f = await fixture(t);
  const runners = [], results = [];
  for (const chat of ['a', 'b']) {
    const llm = createScriptedProvider([{ text: chat + ' [TASK_COMPLETE]' }]);
    const options = { hiveDir: path.join(f.dir, chat), runId: 'same', invocationKey: 'same', llm };
    const runner = f.start(options); runners.push(runner);
    const result = await runner.done; results.push(result);
    assert.equal(result.ok, true);
    const replay = f.start({ ...options, llm: createScriptedProvider([]) });
    assert.equal(replay.workflowId, runner.workflowId);
    assert.equal(replay.sessionId, runner.sessionId);
    assert.deepEqual(await replay.done, result);
    assert.equal(llm.calls.length, 1);
  }
  assert.notEqual(runners[0].workflowId, runners[1].workflowId);
  assert.notEqual(results[0].text, results[1].text);
  assert.equal((await f.runtime.listWorkflows()).length, 2);
});

test('legacy unscoped workflows remain readable and explicitly reattachable, never implicitly reused', async t => {
  const f = await fixture(t);
  const workflowId = 'scr:single/hive/same/dwight-m1/task';
  const legacy = f.start({ workflowId, llm: createScriptedProvider([{ text: 'legacy [TASK_COMPLETE]' }]) });
  const result = await legacy.done;
  assert.equal(result.ok, true);
  const replay = f.start({ workflowId, llm: createScriptedProvider([]) });
  assert.deepEqual(await replay.done, result);
  const modern = f.start({ runId: 'same', invocationKey: 'task', llm: createScriptedProvider([{ text: 'new [TASK_COMPLETE]' }]) });
  assert.notEqual(modern.workflowId, workflowId);
  assert.equal((await modern.done).text, 'new [TASK_COMPLETE]');
  assert.equal((await f.runtime.retrieveWorkflow(workflowId).getStatus()).status, 'SUCCESS');
});
