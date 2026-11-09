import './docker-model-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { releaseRunLease } from '../../src/core/run-lease.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

function fixture(t) {
  const root = path.resolve('.scratch/multiproject-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
async function setup(t, cap = 2) {
  const dir = fixture(t), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'ws'); fs.mkdirSync(workspace);
  const registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Project', workspace });
  const chats = [registry.createChat(project.id), registry.createChat(project.id), registry.createChat(project.id)];
  const children = [];
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, maxConcurrentRuns: cap, control: { auth: { close() {} }, runner(_exe, args, opts) {
    const hive = args[args.indexOf('--hive') + 1];
    const context = args[args.indexOf('--thread-context') + 1];
    assert.equal(JSON.parse(fs.readFileSync(context, 'utf8')).v, 1, 'thread file exists before spawn');
    const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, args, hive, opts });
    child.finish = () => { releaseRunLease(hive, opts.env.SCRANTON_RUN_LEASE); child.emit('close', 0); };
    children.push(child); return child;
  } } });
  t.after(async () => { for (const c of children) c.finish(); await server.close(); });
  const route = (i, suffix) => `/api/projects/${project.id}/chats/${chats[i].id}${suffix}`;
  const req = async (url, body, headers = {}) => {
    const res = await fetch(server.url + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  return { dir, registry, project, chats, server, children, route, req };
}
test('two chats run concurrently; cap 429, same chat 409, running removals refused', async (t) => {
  const { project, chats, children, route, req } = await setup(t);
  assert.equal((await req(route(0, '/runs'), { request: 'first' })).status, 202);
  assert.equal((await req(route(0, '/runs'), { request: 'again' })).status, 409);
  assert.equal((await req(route(1, '/runs'), { request: 'second' })).status, 202);
  assert.equal(children.length, 2);
  assert.equal((await req(route(2, '/runs'), { request: 'over cap' })).status, 429);
  assert.equal((await req(`/api/projects/${project.id}/chats/remove`, { id: chats[0].id })).status, 409);
  assert.equal((await req('/api/projects/remove', { id: project.id })).status, 409);
  assert.equal((await req('/api/control')).value.running, 2);
  children[0].finish();
  assert.equal((await req(route(2, '/runs'), { request: 'slot released' })).status, 202);
});
test('aggregate human count, aliases, fixed workspace and registry discovery', async (t) => {
  const { chats, children, route, req } = await setup(t);
  assert.equal((await req('/api/projects', undefined, { 'X-Scranton-Client': '' })).status, 403);
  assert.equal((await req('/api/projects', undefined, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await req(route(0, '/runs'), { request: 'x', workspace: path.resolve('elsewhere') })).status, 400);
  await req(route(0, '/runs'), { request: 'human' });
  const runId = children[0].opts.env.SCRANTON_RUN_ID;
  fs.writeFileSync(path.join(chats[0].hiveDir, 'events.jsonl'), JSON.stringify({ type: 'hitl_request', runId, seq: 2, options: ['abort'], reason: 'help' }) + '\n');
  const control = (await req('/api/control')).value;
  assert.equal(control.running, 1); assert.equal(control.pendingHuman, 1);
  assert.equal(control.chats[0].pendingHuman.reason, 'help');
  assert.equal((await req('/api/state')).status, 200);
  const projects = (await req('/api/projects')).value;
  assert.equal(projects.mode, 'registry'); assert.equal(projects.projects[0].chats[0].title, 'human');
  assert.equal(projects.projects[0].chats[0].status, 'needs_human');
});
test('run list and archived replay are bounded and thread context reaches spawned argv', async (t) => {
  const { chats, children, route, req } = await setup(t);
  const hive = chats[0].hiveDir, archive = path.join(hive, 'runs', 'previous'); fs.mkdirSync(archive, { recursive: true });
  const events = [{ v: 1, type: 'run_started', runId: 'previous', seq: 1, request: 'prior goal', ts: '2026-01-01' }, { type: 'run_finished', runId: 'previous', seq: 2, status: 'success', summary: 'prior outcome', ts: '2026-01-02' }];
  fs.writeFileSync(path.join(archive, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual((await req(route(0, '/runs/previous/events'))).value.events, events);
  assert.equal((await req(route(0, '/runs'))).value.runs[0].current, false);
  await req(route(0, '/runs'), { request: 'follow up' });
  const args = children[0].args;
  const context = JSON.parse(fs.readFileSync(args[args.indexOf('--thread-context') + 1], 'utf8'));
  assert.match(context.text, /prior goal/); assert.match(context.text, /prior outcome/);
  fs.writeFileSync(path.join(archive, 'events.jsonl'), ' '.repeat(20 * 1024 * 1024 + 1));
  assert.equal((await req(route(0, '/runs/previous/events'))).status, 413);
});
test('SSE is isolated between chat hives', async (t) => {
  const { chats, route, server } = await setup(t);
  for (const [i, chat] of chats.entries()) {
    fs.mkdirSync(chat.hiveDir, { recursive: true });
    fs.writeFileSync(path.join(chat.hiveDir, 'events.jsonl'), JSON.stringify({ seq: 1, runId: `chat-${i}`, type: 'log', message: `only-${i}` }) + '\n');
  }
  const streams = [0, 1].map((i) => new Promise((resolve, reject) => {
    const request = http.get(server.url + route(i, '/events'), { headers: { 'X-Scranton-Client': '1' } }, (response) => {
      let text = ''; response.on('data', (chunk) => { text += chunk; if (text.includes('data:')) resolve({ request, response, text }); });
    }); request.on('error', reject); t.after(() => request.destroy());
  }));
  const [a, b] = await Promise.all(streams);
  assert.match(a.text, /only-0/); assert.doesNotMatch(a.text, /only-1/);
  assert.match(b.text, /only-1/); assert.doesNotMatch(b.text, /only-0/);
  a.request.destroy(); b.request.destroy();
});
test('single mode exposes default scoped routes without changing legacy routes', async (t) => {
  const dir = fixture(t), hive = path.join(dir, 'hive'); fs.mkdirSync(hive);
  fs.writeFileSync(path.join(hive, 'state.json'), '{"v":1,"status":"idle"}');
  const server = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0 }); t.after(() => server.close());
  const get = async (route) => (await fetch(server.url + route, { headers: { 'X-Scranton-Client': '1' } })).json();
  assert.deepEqual(await get('/api/state'), await get('/api/projects/default/chats/default/state'));
  assert.equal((await get('/api/projects')).mode, 'single');
  const res = await fetch(server.url + '/api/projects', { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: '{"name":"No"}' });
  assert.equal(res.status, 409); assert.equal((await res.json()).error, 'single_mode');
});
