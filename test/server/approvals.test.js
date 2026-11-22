import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentHiveScopePrefix } from '../../src/core/agent/index.js';
import { fixture, until } from './agent-fixture.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

for (const scoped of [false, true]) for (const approved of [false, true]) test(`approvals ${scoped ? 'scoped' : 'single'}: ${approved ? 'approve' : 'deny'} real write, guards and foreign refusal`, async t => {
  const f = await fixture(t, scoped), route = f.prefix + '/approvals';
  const runner = f.start([{ toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'approved.txt', content: 'accepted' } }] }, { text: '[TASK_COMPLETE]' }], { approvals: { tools: ['write'], timeoutSeconds: 60 } });
  const payload = await until(async () => (await f.request(route)).json(), value => value.approvals.length);
  const item = payload.approvals[0];
  assert.equal(item.workflowId, runner.workflowId); assert.equal(item.runId, 'r1'); assert.equal(item.instanceId, 'dwight-m1'); assert.equal(item.agent, 'dwight');
  assert.equal(item.step, 'tool:0:0'); assert.equal(item.callId, 'c1'); assert.equal(item.tool, 'write'); assert.equal(item.timeoutSeconds, 60); assert.ok(Date.parse(item.deadline) > Date.now());
  const body = { workflowId: runner.workflowId, callId: 'c1', approved };
  assert.equal((await f.request(route, body, { 'x-scranton-client': '' })).status, 403);
  assert.equal((await f.request(route, body, { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await f.request(route, body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request(route, { ...body, approved: 'yes' })).status, 400);
  assert.equal((await f.request(route, { ...body, callId: 'unknown' })).status, 404);
  assert.equal((await f.request(route, { ...body, workflowId: 'foreign' })).status, 404);
  if (scoped) {
    assert.deepEqual(await (await f.request(f.foreign + '/approvals')).json(), { approvals: [] });
    assert.equal((await f.request(f.foreign + '/approvals', body)).status, 404);
  }
  const response = await f.request(route, body); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await runner.done).ok, true);
  assert.equal(fs.existsSync(path.join(f.dir, 'workspace/approved.txt')), approved);
  assert.deepEqual(await (await f.request(route)).json(), { approvals: [] });
  assert.equal((await f.request(route, body)).status, 404);
});

test('approvals: read-only single-hive server refuses approval writes', async t => {
  const f = await fixture(t);
  const runner = f.start([{ toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'forbidden.txt', content: 'no' } }] }], { approvals: { tools: ['write'], timeoutSeconds: 60 } });
  await until(() => f.runtime.getEvent(runner.workflowId, 'agent_state', { timeoutSeconds: 0 }), state => state?.phase === 'waiting_approval');
  const readOnly = await startVisualizerServer({ hiveDir: f.hive, publicDir: f.dir, port: 0 });
  t.after(() => readOnly.close());
  const response = await fetch(readOnly.url + '/api/approvals', { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: runner.workflowId, callId: 'c1', approved: true }) });
  assert.equal(response.status, 404);
});

test('approvals: expired waiting checkpoint is 409, terminal stale checkpoint is not pending', async t => {
  const f = await fixture(t);
  // Deliberately retain an expired waiting snapshot to exercise the HTTP race with timeout consumption.
  f.runtime.registerWorkflow('unused', async () => {});
  const id = agentHiveScopePrefix(f.hive) + 'expired/dwight-m1/test';
  const { serialize } = await import('node:v8');
  f.runtime.db.prepare('INSERT INTO workflows(id,name,args,executor,version,status) VALUES(?,?,?,?,?,?)').run(id, 'scranton.agent.v1', serialize([]), 'test', '1', 'PENDING');
  f.runtime.db.prepare('INSERT INTO events(workflow,key,value) VALUES(?,?,?)').run(id, 'agent_state', serialize({ phase: 'waiting_approval', detail: { workflowId: id, callId: 'old', step: 'tool:0:0', tool: 'write', args: {}, timeoutSeconds: 1, deadline: new Date(Date.now() - 1000).toISOString() } }));
  assert.deepEqual(await (await f.request('/api/approvals')).json(), { approvals: [] });
  assert.equal((await f.request('/api/approvals', { workflowId: id, callId: 'old', approved: true })).status, 409);
  await f.runtime.cancelWorkflow(id);
  assert.equal((await f.request('/api/approvals', { workflowId: id, callId: 'old', approved: true })).status, 404);
});

test('shared database approval listings and verdicts refuse the other hive and legacy unscoped IDs', async t => {
  const { sharedFixture } = await import('./agent-fixture.js');
  const f = await sharedFixture(t);
  const turns = [{ toolCalls: [{ id: 'same-call', name: 'write', arguments: { path: 'result.txt', content: 'yes' } }] }, { text: '[TASK_COMPLETE]' }];
  const approvals = { tools: ['write'], timeoutSeconds: 60 };
  const a = f.start('a', turns, { approvals });
  const b = f.start('b', turns, { approvals });
  const legacy = f.start('a', turns, { approvals, workflowId: 'scr:single/hive/r1/dwight-m1/legacy' });
  for (const runner of [a, b, legacy]) await until(() => f.runtime.getEvent(runner.workflowId, 'agent_state', { timeoutSeconds: 0 }), value => value?.phase === 'waiting_approval');
  for (const [chat, own, foreign] of [['a', a, b], ['b', b, a]]) {
    const listing = await (await f.request(`/${chat}/approvals`)).json();
    assert.deepEqual(listing.approvals.map(item => item.workflowId), [own.workflowId]);
    for (const runner of [foreign, legacy]) assert.equal((await f.request(`/${chat}/approvals`, { workflowId: runner.workflowId, callId: 'same-call', approved: true })).status, 404);
    assert.equal((await f.runtime.getEvent(foreign.workflowId, 'agent_state', { timeoutSeconds: 0 })).phase, 'waiting_approval');
  }
  for (const [chat, own] of [['a', a], ['b', b]]) {
    assert.equal((await f.request(`/${chat}/approvals`, { workflowId: own.workflowId, callId: 'same-call', approved: false })).status, 202);
    assert.equal((await own.done).ok, true);
  }
});
