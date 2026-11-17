import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { planRequestBody } from '../../src/core/messages.js';
import { parseMessage } from '../../src/core/hive.js';
import { fakeConfig } from './helpers.js';

async function planning(t, { threadContext, runContext, retry = false } = {}) {
  const scratch = path.resolve('.scratch/multiproject-thread'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'planning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = fakeConfig(dir);
  const inputs = [];
  const orchestrator = new Orchestrator({ config, threadContext, hitl: async () => ({ decision: 'feedback', feedback: 'Try again' }),
    startRunner: ({ agentId, hive }) => {
      if (agentId === 'michael') inputs.push(parseMessage(fs.readFileSync(hive.inboxPath('michael'), 'utf8')).body);
      const failed = retry && agentId === 'michael' && inputs.length === 1;
      const keyword = { michael: 'PLAN_READY', dwight: 'TASK_COMPLETE', angela: 'TEST_PASSED' }[agentId];
      return { done: Promise.resolve({ ok: !failed, failure: failed ? { message: 'Retry planning' } : null,
        keyword, text: agentId === 'michael' ? '```json\n{"milestones":[{"title":"One"}]}\n```\n[PLAN_READY]' : `[${keyword}]`, exitCode: 0, durationMs: 0 }), kill: async () => {} };
    } });
  assert.equal((await orchestrator.run('New goal', runContext === undefined ? {} : { threadContext: runContext })).status, 'success');
  return inputs;
}

test('Michael gets bounded delimited thread context before the new goal, including planning feedback retries', async (t) => {
  const inputs = await planning(t, { threadContext: 'Goal: Prior goal\nOutcome: success', retry: true });
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.match(input, /Earlier turns and project context - context only; the new goal below takes precedence/);
    assert.match(input, /<earlier-runs>\nGoal: Prior goal\nOutcome: success\n<\/earlier-runs>/);
    assert.ok(input.indexOf('</earlier-runs>') < input.indexOf('## Request\n\nNew goal'));
  }
  assert.match(inputs[1], /Human feedback\n\nTry again/);
});

test('omitted, empty and non-string context preserve the original planning prompt exactly', async (t) => {
  for (const threadContext of [undefined, '', '   ', 123]) {
    const inputs = await planning(t, { threadContext });
    assert.equal(inputs[0], planRequestBody('New goal'));
  }
});

test('run options override constructor context and oversized context is bounded at line boundaries', async (t) => {
  const inputs = await planning(t, { threadContext: 'Wrong context', runContext: 'Recent history\n' + 'x'.repeat(25000) });
  assert.ok(!inputs[0].includes('Wrong context'));
  assert.match(inputs[0], /Recent history/);
  assert.ok(inputs[0].length < 24000);
  assert.ok(!inputs[0].includes('xxx'));
});
