import './runtime-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { emptyLive } from '../../src/core/live-activity.js';

test('live routes mirror state guards and return empty for absent, stale and terminal runs', async t => {
  const root = path.resolve('.scratch/live-activity'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'http-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), registry = createProjectRegistry({ dataDir });
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const project = registry.addProject({ name: 'Live', workspace }); const chat = registry.createChat(project.id);
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0 }); t.after(() => server.close());
  const route = `/api/projects/${project.id}/chats/${chat.id}/live`;
  const get = (suffix, headers = { 'X-Scranton-Client': '1' }) => fetch(server.url + suffix, { headers });
  for (const suffix of [route, '/api/live']) {
    assert.equal((await get(suffix, {})).status, 403);
    assert.equal((await get(suffix, { 'X-Scranton-Client': '1', Origin: 'https://evil.test' })).status, 403);
    const { request } = await import('node:http');
    const forbidden = await new Promise((resolve, reject) => {
      const req = request(server.url + suffix, { headers: { 'X-Scranton-Client': '1', Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(forbidden, 403);
  }
  assert.deepEqual(await (await get(route)).json(), emptyLive());
  fs.mkdirSync(chat.hiveDir, { recursive: true });
  const live = { v: 1, runId: 'r', updatedAt: 'now', instances: { a: { agent: 'dwight', phase: 'thinking', thinking: 'hello', thinkingCut: false, text: null, textCut: false, updatedAt: 'now' } } };
  fs.writeFileSync(path.join(chat.hiveDir, 'live.json'), JSON.stringify(live));
  const state = status => fs.writeFileSync(path.join(chat.hiveDir, 'state.json'), JSON.stringify({ runId: 'r', status }));
  state('running'); const r = await get(route); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.deepEqual(await r.json(), live);
  state('finished'); assert.deepEqual(await (await get(route)).json(), emptyLive());
  fs.writeFileSync(path.join(chat.hiveDir, 'state.json'), JSON.stringify({ runId: 'other', status: 'running' }));
  assert.deepEqual(await (await get(route)).json(), emptyLive());
});

test('Pipeline inspection skips oversized history with diagnostics and derives activity beyond the event page', async t => {
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const base = path.resolve('.scratch/live-backend-fix'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'inspect-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), registry = createProjectRegistry({ dataDir });
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const project = registry.addProject({ name: 'Fixture', workspace }), chat = registry.createChat(project.id, { engine: 'pipeline' });
  const runId = 'abcdefgh', runDir = path.join(dataDir, 'projects', project.id, 'chats', chat.id, 'pipeline/runs', runId);
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ schema: 1, run_id: runId, status: 'suspended', progress: { steps_done: 1 }, usage: { calls: 1, input_tokens: 10, output_tokens: 2, estimated_cost: null } }));
  fs.writeFileSync(path.join(runDir, 'artifacts/plan.json'), JSON.stringify({ steps: [{ id: 'a' }, { id: 'b' }] }));
  const events = Array.from({ length: 501 }, (_, i) => ({ seq: i + 1, type: 'warning', data: {} }));
  events.push({ seq: 502, type: 'procedure', data: { role: 'implementer', scope: 'step:a', matched: false } },
    { seq: 503, type: 'llm_call', ts: 'completion', data: { role: 'implementer', input_tokens: 10, output_tokens: 2, estimated: false } },
    { seq: 504, type: 'route', data: { from: 'verify', to: 'select_step', reason: 'checks_passed' } });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), 'x'.repeat(1024 * 1024 + 100) + '\n{bad}\n' + events.map(e => JSON.stringify(e) + '\n').join(''));
  const supervisor = createPipelineSupervisor({ dataDir, auth: {} }); t.after(() => supervisor.close());
  const view = await supervisor.inspect(chat, runId);
  assert.equal(view.events.length, 500); assert.equal(view.lastSeq, 500);
  assert.deepEqual(view.stepsDone, ['a']); assert.equal(view.stepsDoneExact, true);
  assert.equal(view.usage.tokens, 12); assert.equal(view.usage.series[0].ts, 'completion');
  assert.match(view.stderrTail, /Skipped 2 malformed or oversized/);
  const next = await supervisor.inspect(chat, runId, 500); assert.equal(next.events.length, 4); assert.equal(next.lastSeq, 504);
});
