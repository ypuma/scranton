import '../isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture } from './helpers.js';
import { startAgent, agentWorkflowId } from '../../../src/core/agent/index.js';
import { createScriptedProvider } from '../../../src/core/llm/index.js';
import { Orchestrator } from '../../../src/core/orchestrator.js';
import { fakeConfig, readEvents } from '../helpers.js';
import { createAgentRoutes } from '../../../src/server/agent-routes.js';

const secret = 'fixture-env-value-9382';
const diagnostic = `Authorization: Bearer sk-test-123456789\nhttps://user:pass@example.test/error\nremote said ${secret}`;
const env = { FIXTURE_API_KEY: secret, SCRANTON_FAKE_MODE: '0' };
function masked(value) {
  const text = JSON.stringify(value);
  for (const raw of ['sk-test-123456789', 'user:pass', secret]) assert.equal(text.includes(raw), false, 'leaked ' + raw);
  assert.match(text, /redacted/);
}
function failingProvider() {
  return { stream() {
    const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: diagnostic, error: { message: diagnostic } };
    return { async *[Symbol.asyncIterator]() { yield { type: 'error', error: message }; }, result: async () => message };
  } };
}

test('provider failure is masked before journaling and in live/output views and terminal state', async t => {
  const f = await fixture(t), live = [];
  const config = fakeConfig(f.dir); delete config.scripted;
  let runner;
  const o = new Orchestrator({ config, noPlan: true, onBreaker: 'abort', startRunner: options => {
    runner = startAgent({ ...options, runtime: f.runtime, model: f.options.model, llm: failingProvider(),
      extraEnv: { ...options.extraEnv, ...env }, onLive: record => { live.push(record); options.onLive?.(record); } });
    return runner;
  } });
  await o.run('Exercise provider failure');
  masked((await runner.done).failure);
  const errors = readEvents(config.hiveDir).filter(e => e.type === 'log' && e.level === 'error');
  assert.ok(errors.length); masked(errors);
  masked(live.filter(r => r.type === 'message_end' || r.failure));
  const rows = []; for await (const row of f.runtime.readStream(runner.workflowId, 'output')) rows.push(row.value);
  assert.ok(rows.some(r => r.type === 'error')); masked(rows);
  masked((await f.runtime.getEvent(runner.workflowId, 'agent_state')).detail);
});

test('initialization errors are masked; normal answers remain literal in callbacks, results and streams', async t => {
  const f = await fixture(t);
  masked((await f.start({ runtime: { registerWorkflow() {}, launch() { throw new Error(diagnostic); } }, extraEnv: env }).done).failure);
  const live = [], answers = [];
  const runner = f.start({ llm: createScriptedProvider([{ text: diagnostic }]), extraEnv: env,
    onLive: r => live.push(r), onAssistantMessage: text => answers.push(text) });
  assert.equal((await runner.done).text, diagnostic);
  assert.deepEqual(answers, [diagnostic]);
  assert.equal(live.findLast(r => r.type === 'message_end').message.content[0].text, diagnostic);
  const rows = []; for await (const row of f.runtime.readStream(runner.workflowId, 'output')) rows.push(row.value);
  assert.equal(rows.map(r => r.delta ?? '').join(''), diagnostic);
});

test('tool-launch errors are masked only in live records, not model-facing results/history', async t => {
  const f = await fixture(t), live = [];
  const tool = process.platform === 'win32' ? 'powershell' : 'bash';
  const llm = createScriptedProvider([{ toolCalls: [{ name: tool, arguments: { command: 'echo test' } }] }, { text: 'Done' }]);
  const runner = f.start({ llm, extraEnv: env, spawn() { throw new Error(diagnostic); }, onLive: r => live.push(r) });
  assert.equal((await runner.done).ok, true);
  masked(live.find(r => r.type === 'tool_execution_end').result);
  assert.equal(llm.calls[1].context.messages.find(m => m.role === 'toolResult').content, diagnostic);
});

test('SSE projects old raw error records without changing normal chunks or storage', async t => {
  const f = await fixture(t);
  const workflowId = agentWorkflowId({ hiveDir: f.dir, runId: 'r1', instanceId: 'dwight-m1' });
  const values = [{ type: 'error', message: diagnostic }, { v: 1, kind: 'text', delta: diagnostic }];
  const routes = createAgentRoutes({ createClient: async () => ({
    listWorkflows: async () => [{ workflowId, name: 'scranton.agent.v1', status: 'SUCCESS' }],
    async *readStream() { for (const [offset, value] of values.entries()) yield { offset, value }; },
    retrieveWorkflow: () => ({ getStatus: async () => ({ status: 'SUCCESS' }) }), shutdown: async () => {},
  }) });
  const previous = process.env.FIXTURE_API_KEY; process.env.FIXTURE_API_KEY = secret;
  t.after(() => { if (previous === undefined) delete process.env.FIXTURE_API_KEY; else process.env.FIXTURE_API_KEY = previous; });
  const res = new EventEmitter(); let output = '';
  Object.assign(res, { writeHead() { this.headersSent = true; }, flushHeaders() {}, write(text) { output += text; return true; }, end() {} });
  await routes.stream({ url: '/', headers: {} }, res, f.dir, 'r1', 'dwight-m1');
  const chunks = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  masked(chunks[0]); assert.deepEqual(chunks[1], values[1]); assert.equal(values[0].message, diagnostic);
});
