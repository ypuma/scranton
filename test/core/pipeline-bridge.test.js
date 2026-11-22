import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeFixture, invokeBridge } from './bridges-fixture.js';
import { runPipelineCompletion } from '../../tools/pipeline-complete.js';
import { createScriptedProvider } from '../../src/core/llm/index.js';

for (const helper of ['tools/pipeline-complete.js']) {
  test(helper + ' preserves private file protocol and usage', async (t) => {
    const f = await bridgeFixture(t), request = path.join(f.dir, 'request.json'), response = path.join(f.dir, 'response.json');
    fs.writeFileSync(request, JSON.stringify({ v: 1, role: 'planner', model: 'test', system: 'private system', user: 'private user', max_output_tokens: 256, temperature: 0 }));
    const result = await invokeBridge(helper, ['--provider', 'offline', '--model', 'test', '--thinking', 'off', request, response], f.env);
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(JSON.parse(fs.readFileSync(response)), { text: 'completion', usage: { input_tokens: 11, output_tokens: 4 } });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].tools, undefined);
    assert.equal(f.calls[0].max_tokens, 256); assert.equal(f.calls[0].temperature, 0);
    assert.deepEqual(f.calls[0].messages, [{ role: 'system', content: 'private system' }, { role: 'user', content: 'private user' }]);
  });
}
for (const status of [400, 401, 403, 408, 429, 500, 503]) test('Pipeline HTTP exit mapping ' + status, async (t) => {
  const f = await bridgeFixture(t, (_body, res) => { res.writeHead(status); res.end('private diagnostic'); });
  const request = path.join(f.dir, 'request.json'), response = path.join(f.dir, 'response.json');
  fs.writeFileSync(request, JSON.stringify({ v: 1, system: 'secret', user: 'secret', max_output_tokens: 256, temperature: 0 }));
  fs.writeFileSync(response, 'stale');
  const result = await invokeBridge('tools/pipeline-complete.js', ['--provider', 'offline', '--model', 'test', request, response], f.env);
  assert.deepEqual(result, { code: [408, 429, 500, 503].includes(status) ? 75 : 1, stdout: '', stderr: '' });
  assert.equal(fs.existsSync(response), false);
});
for (const code of ['SCRANTON_OAUTH_TEMPORARY', 'SCRANTON_CREDENTIAL_LOCKED', 'ECONNRESET', 'SCRANTON_AUTH_MISSING', 'SCRANTON_CREDENTIAL_INVALID']) test('Pipeline credential classification ' + code, async (t) => {
  const f = await bridgeFixture(t), request = path.join(f.dir, 'request.json'), response = path.join(f.dir, 'response.json');
  fs.writeFileSync(request, JSON.stringify({ v: 1, system: '', user: 'secret', max_output_tokens: 256, temperature: 0 }));
  const result = await runPipelineCompletion(['--provider', 'offline', '--model', 'test', request, response], { env: {}, clientFactory: async () => ({ model: {}, llm: createScriptedProvider([{ error: { code } }]), close() {} }) });
  assert.equal(result, ['SCRANTON_AUTH_MISSING', 'SCRANTON_CREDENTIAL_INVALID'].includes(code) ? 1 : 75);
});
test('Pipeline refuses tool attempts even alongside a transient failure', async (t) => {
  const f = await bridgeFixture(t), request = path.join(f.dir, 'request.json'), response = path.join(f.dir, 'response.json');
  fs.writeFileSync(request, JSON.stringify({ v: 1, system: '', user: 'secret', max_output_tokens: 256, temperature: 0 }));
  const llm = createScriptedProvider([{ toolCalls: [{ name: 'bash', arguments: {} }], error: { status: 429 } }]);
  assert.equal(await runPipelineCompletion(['--provider', 'offline', '--model', 'test', request, response], { env: {}, clientFactory: async () => ({ model: {}, llm, close() {} }) }), 1);
  assert.deepEqual(llm.calls[0].context.tools, []);
});

// Status fixtures exercise the bridge without starting an engine or model.
test('Pipeline conversation list bounds replies and inspect preserves reply/event envelopes', async (t) => {
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const base = path.resolve('.scratch/pipeline/chat-node/tests'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'list-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = createPipelineSupervisor({ dataDir, env: {} });
  const chat = { projectId: 'project1', id: 'chat0001' };
  const runs = path.join(dataDir, 'projects/project1/chats/chat0001/pipeline/runs');
  const reply = { from: 'pipeline', kind: 'answer', text: 'A'.repeat(4001), truncated: false, citations: ['E-1234567890'] };
  const status = (id, reply) => ({ schema: 1, run_id: id, status: 'succeeded', phase: 'done', task: 'Question', created_at: '2026-11-11T00:00:00Z', updated_at: '2026-11-11T00:01:00Z', ...(reply ? { reply } : {}) });
  for (const [id, value] of [['answer01', status('answer01', reply)], ['normal01', status('normal01')]]) {
    fs.mkdirSync(path.join(runs, id), { recursive: true });
    fs.writeFileSync(path.join(runs, id, 'status.json'), JSON.stringify(value));
  }
  const events = [
    { seq: 1, ts: '2026-11-11T00:00:30Z', run_id: 'answer01', type: 'agent_message', node: null, data: { role: 'planner', text: 'A valid turn', context: 'Revision 0', final: true, truncated: false } },
    { seq: 2, ts: '2026-11-11T00:00:31Z', run_id: 'answer01', type: 'run_reply', node: null, data: reply }
  ];
  fs.writeFileSync(path.join(runs, 'answer01/events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  const list = supervisor.list(chat);
  assert.deepEqual(list, { active: null, runs: [
    { runId: 'answer01', status: 'succeeded', phase: 'done', task: 'Question', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:01:00Z', usage: null, reply: { kind: 'answer', text: 'A'.repeat(4000), truncated: true, citations: ['E-1234567890'] } },
    { usage: null, runId: 'normal01', status: 'succeeded', phase: 'done', task: 'Question', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:01:00Z' }
  ] });
  assert.equal(Object.hasOwn(list.runs[1], 'reply'), false);
  const inspected = await supervisor.inspect(chat, 'answer01');
  assert.deepEqual(inspected.status.reply, reply);
  assert.deepEqual(inspected.events, events);
  assert.deepEqual((await supervisor.inspect(chat, 'answer01', 1)).events, [events[1]]);
  for (const truncated of [false, true]) {
    const short = { ...reply, kind: 'result', text: 'Done', truncated, citations: [] };
    fs.writeFileSync(path.join(runs, 'answer01/status.json'), JSON.stringify(status('answer01', short)));
    assert.deepEqual(supervisor.list(chat).runs[0].reply, { kind: 'result', text: 'Done', truncated, citations: [] });
  }
});

for (const mode of ['timeout', 'network', 'tool', 'legacy-timeout', 'legacy-command']) test('own completion transport lifecycle: ' + mode, async (t) => {
  const f = await bridgeFixture(t, (_body, res) => {
    if (mode === 'timeout') return;
    if (mode === 'network') return res.destroy();
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  });
  const request = path.join(f.dir, 'request.json'), response = path.join(f.dir, 'response.json');
  fs.writeFileSync(request, JSON.stringify({ v: 1, system: 'secret', user: 'secret', max_output_tokens: 256, temperature: 0 }));
  fs.writeFileSync(response, 'stale');
  f.env.SCRANTON_PIPELINE_COMPLETE_TIMEOUT_MS = '300';
  if (mode === 'legacy-timeout') f.env.SCRANTON_PIPELINE_PI_TIMEOUT_MS = '300';
  if (mode === 'legacy-command') f.env.SCRANTON_PI_COMMAND = 'pi';
  const started = Date.now();
  const result = await invokeBridge('tools/pipeline-complete.js', ['--provider', 'offline', '--model', 'test', request, response], f.env);
  assert.equal(result.code, ['timeout', 'network'].includes(mode) ? 75 : 1);
  assert.equal(result.stdout, '');
  if (mode.startsWith('legacy-')) assert.match(result.stderr, /no longer supported/);
  else assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(response), false);
  assert.ok(Date.now() - started < 10000);
});

test('Pipeline capability emits bridge for host completions and direct for compatible API keys', async t => {
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const f = await bridgeFixture(t);
  const supervisor = createPipelineSupervisor({ dataDir: f.dir, env: {
    SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]),
  }, auth: { store: { read: () => ({ providers: {} }) }, listAccounts: () => [
    { id: 'anthropic', label: 'Subscription', kind: 'oauth', status: 'signed_in' },
    { id: 'openai', label: 'API', kind: 'api_key', status: 'signed_in' },
  ] } });
  t.after(() => supervisor.close());
  const result = await supervisor.capability();
  assert.equal(result.models.find(p => p.provider === 'anthropic').via, 'bridge');
  assert.equal(result.models.find(p => p.provider === 'openai').via, 'direct');
});
