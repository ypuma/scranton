import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentWorkflow } from '../../../src/core/agent/workflow.js';
import { createScriptedProvider, getModel } from '../../../src/core/llm/index.js';

// Replay checkpointed clocks and steps while observing the reconstructed event payloads.
test('approval state exposes its checkpointed timeout and ISO deadline unchanged on replay', async () => {
  const times = [], steps = new Map(), waiting = [];
  let replay = false, position = 0, clock = Date.parse('2026-01-01T00:00:00.000Z');
  const wf = {
    workflowId: 'approval-state',
    async now() {
      if (replay) return times[position++];
      const value = clock;
      clock += 10;
      times.push(value);
      position++;
      return value;
    },
    async runStep(body, { name }) {
      if (replay) {
        assert.ok(steps.has(name), `missing checkpoint: ${name}`);
        return structuredClone(steps.get(name));
      }
      const result = await body(1);
      steps.set(name, structuredClone(result));
      return result;
    },
    async setEvent(key, value) {
      assert.equal(key, 'agent_state');
      if (value.phase === 'waiting_approval') waiting.push(value);
    },
    async recv(topic, options) {
      if (topic === 'steer') return null;
      assert.ok(options.timeoutSeconds > 0 && options.timeoutSeconds <= 60);
      return { workflowId: wf.workflowId, step: 'tool:0:0', callId: 'c1', approved: false };
    },
    async writeStream() {},
    async closeStream() {},
  };
  const input = {
    sessionId: 'stable', messages: [], model: getModel('openai', 'gpt-4o'),
    definitions: [], allow: [], maxTurns: 2, keywords: ['TASK_COMPLETE'],
    approvals: { tools: ['write'], timeoutSeconds: 60 },
  };
  const llm = createScriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'unused.txt', content: 'denied' } }] },
    { text: '[TASK_COMPLETE]' },
  ]);
  const deps = { controller: new AbortController(), llm };
  assert.equal((await runAgentWorkflow(wf, input, deps)).ok, true);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].detail.timeoutSeconds, 60);
  assert.equal(waiting[0].detail.deadline, '2026-01-01T00:01:00.020Z');
  assert.equal(Date.parse(waiting[0].detail.deadline) - Date.parse(waiting[0].ts), 59990);
  const checkpointCount = times.length;
  replay = true; position = 0; clock += 86400000;
  assert.equal((await runAgentWorkflow(wf, input, deps)).ok, true);
  assert.equal(position, checkpointCount);
  assert.equal(waiting.length, 2);
  assert.deepEqual(waiting[1], waiting[0]);
  assert.equal(llm.calls.length, 2, 'completed model steps are not rerun');
});
