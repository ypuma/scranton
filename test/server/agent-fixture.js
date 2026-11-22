import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDurableRuntime } from '../../src/core/durable/index.js';
import { startAgent } from '../../src/core/agent/index.js';
import { createScriptedProvider, getModel } from '../../src/core/llm/index.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createProjectRegistry } from '../../src/core/projects.js';

export async function fixture(t, registryMode = false) {
  const base = path.resolve('.scratch/server-switch'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'routes-')), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  let hive = path.join(dir, 'hive'), prefix = '/api', foreign;
  if (registryMode) {
    const registry = createProjectRegistry({ dataDir });
    const project = registry.addProject({ name: 'Routes', workspace }), chat = registry.createChat(project.id), other = registry.createChat(project.id);
    hive = chat.hiveDir; prefix = `/api/projects/${project.id}/chats/${chat.id}`; foreign = `/api/projects/${project.id}/chats/${other.id}`;
  }
  const runtime = await createDurableRuntime({ hiveDir: hive, markerDir: path.join(hive, 'agent-step-markers'), env: {} });
  const server = await startVisualizerServer({ ...(registryMode ? { dataDir } : { hiveDir: hive }), publicDir: dir, port: 0, control: { workspace, auth: { close() {} } } });
  const runners = [];
  t.after(async () => { for (const runner of runners) await runner.abort(); await server.close(); await runtime.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = (turns, overrides = {}) => {
    const runner = startAgent({ runtime, hiveDir: hive, cwd: workspace, runId: 'r1', instanceId: 'dwight-m1', agentId: 'dwight', invocationKey: String(runners.length),
      message: 'Task', model: getModel('openai', 'gpt-4o'), llm: createScriptedProvider(turns), agentConfig: { tools: ['write'], keywords: ['TASK_COMPLETE'] }, retrySeconds: 0.001, ...overrides });
    runners.push(runner); return runner;
  };
  const request = (route, body, headers = {}) => fetch(server.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { dir, hive, runtime, server, prefix, foreign, start, request };
}
export async function until(fn, predicate) {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (predicate(value)) return value; await sleep(10); }
  assert.fail('Timed out waiting for fixture');
}
export function events(text) {
  return text.split('\n\n').filter(block => block.includes('event:')).map(block => ({
    event: /^event: (.+)$/m.exec(block)[1], id: /^id: (\d+)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(block)[1])
  }));
}

export async function sharedFixture(t) {
  const { createServer } = await import('node:http');
  const { createDurableClient } = await import('../../src/core/durable/index.js');
  const { createAgentRoutes } = await import('../../src/server/agent-routes.js');
  const base = path.resolve('.scratch/server-switch'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'shared-'));
  const hives = ['a', 'b'].map(name => path.join(dir, name));
  for (const hive of hives) fs.mkdirSync(hive);
  const databasePath = path.join(dir, 'shared.sqlite');
  const runtime = await createDurableRuntime({ databasePath, markerDir: path.join(dir, 'markers'), env: {} });
  const routes = createAgentRoutes({ createClient: () => createDurableClient({ databasePath, env: {} }) });
  const server = createServer((req, res) => {
    const [, chat, kind] = req.url.split('/');
    const hive = hives[chat === 'b' ? 1 : 0];
    const scope = { projectId: 'project', chatId: chat };
    Promise.resolve(kind === 'approvals' ? routes.approvals(req, res, hive, scope)
      : routes.stream(req, res, hive, 'r1', 'dwight-m1', scope)).catch(error => {
      res.writeHead(error.status ?? 500); res.end(error.message);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.abort();
    routes.close(); await new Promise(resolve => server.close(resolve));
    await runtime.shutdown(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = (chat, turns, overrides = {}) => {
    const runner = startAgent({ runtime, hiveDir: hives[chat === 'b' ? 1 : 0], cwd: dir,
      runId: 'r1', instanceId: 'dwight-m1', agentId: 'dwight', invocationKey: 'same', message: 'Task',
      model: getModel('openai', 'gpt-4o'), llm: createScriptedProvider(turns),
      agentConfig: { tools: ['write'], keywords: ['TASK_COMPLETE'] }, ...overrides });
    runners.push(runner); return runner;
  };
  const request = (route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { start, request, runtime, hives };
}
