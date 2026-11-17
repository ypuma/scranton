import '../core/isolation-test-root.js';
import { modelWindows } from './model-windows-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { releaseRunLease } from '../../src/core/run-lease.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createContext } from '../../src/core/context/index.js';

async function setup(t, runner) {
  const root = path.resolve('.scratch/chat-backend/server'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'run-')), hive = path.join(dir, 'hive'), workspace = path.join(dir, 'ws');
  let lastChild;
  const server = await startVisualizerServer({ hiveDir: hive, publicDir: dir, port: 0, control: { modelWindows, workspace, runner: runner ? (...args) => (lastChild = runner(...args)) : undefined, auth: { close() {} } } });
  t.after(async () => { lastChild?.emit('close', 0); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const req = async (route, body) => {
    const res = await fetch(server.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  return { dir, hive, workspace, server, req };
}
const scoped = '/api/projects/default/chats/default';

test('both run routes validate conversation and forward explicit true/false; omission has no flag', async (t) => {
  let args, child, hive, env;
  const f = await setup(t, (_exe, argv, options) => { args = argv; env = options.env; hive = argv[argv.indexOf('--hive') + 1]; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; });
  for (const route of ['/api/runs', scoped + '/runs']) {
    for (const conversation of ['true', 1, null, {}]) assert.equal((await f.req(route, { request: 'test', trustedHost: true, conversation })).status, 400);
    for (const conversation of [true, false, undefined]) {
      assert.equal((await f.req(route, { request: 'test', trustedHost: true, conversation })).status, 202);
      assert.equal(args.includes('--conversation'), conversation === true);
      assert.equal(args.includes('--no-conversation'), conversation === false);
      releaseRunLease(hive, env.SCRANTON_RUN_LEASE); child.emit('close', 0);
    }
  }
  assert.ok((await f.req('/api/control')).value.scenarios.includes('question'));
});

test('GET aliases expose current/archived bounded reply and summary, with event-only archive fallback', async (t) => {
  const f = await setup(t);
  const archive = path.join(f.hive, 'runs', 'first'); fs.mkdirSync(archive, { recursive: true });
  const events = [
    { type: 'run_started', runId: 'first', seq: 1, ts: '2026-01-01T00:00:00Z', request: 'earlier question' },
    { type: 'run_reply', runId: 'first', seq: 2, from: 'michael', kind: 'answer', text: 'a'.repeat(5000) },
    { type: 'run_finished', runId: 'first', seq: 3, ts: '2026-01-01T00:01:00Z', status: 'success', summary: 'Answered by Michael' }
  ];
  fs.writeFileSync(path.join(archive, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(f.hive, 'state.json'), JSON.stringify({ runId: 'second', request: 'follow up', status: 'finished', updatedAt: '2026-01-02T00:01:00Z', reply: { from: 'system', kind: 'summary', text: 'summary body' } }));
  const runs = (await f.req(scoped + '/runs')).value.runs;
  assert.equal(runs.length, 2); assert.equal(runs[0].reply.text.length, 4000); assert.equal(runs[0].reply.truncated, true);
  assert.match(runs[0].summary, /Answered by Michael/); assert.equal(runs[0].current, false);
  assert.deepEqual(runs[1].reply, { kind: 'summary', text: 'summary body' }); assert.equal(runs[1].current, true);
  assert.deepEqual((await f.req('/api/runs')).value, { runs });
});

test('real question demo followed by a new run archives reply and supplies it to Michael', { timeout: 40000 }, async (t) => {
  const f = await setup(t);
  const wait = async () => {
    for (let i = 0; i < 300; i++) { const c = (await f.req('/api/control')).value; if (!c.run && c.lastExit) return c; await sleep(40); }
    throw Error('Run did not finish');
  };
  for (const route of ['/api/runs', scoped + '/runs']) {
    assert.equal((await f.req(route, { demo: { scenario: 'question', delayMs: 0 }, conversation: true })).status, 202);
    const c = await wait(); assert.equal(c.lastExit.exitCode, 0, c.lastExit.outputTail);
  }
  const { runs } = (await f.req('/api/runs')).value;
  assert.equal(runs.length, 2); assert.ok(runs.every((r) => r.reply.kind === 'answer' && r.status === 'success'));
  assert.deepEqual(runs.map((r) => r.current), [false, true]);
  const archive = fs.readFileSync(path.join(f.hive, 'runs', runs[0].runId, 'events.jsonl'), 'utf8'); assert.match(archive, /run_reply/);
});

test('registry follow-up passes the v3 context pack with the latest earlier reply', async (t) => {
  const { createProjectRegistry } = await import('../../src/core/projects.js');
  const root = path.resolve('.scratch/chat-backend/server'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'registry-')), workspace = path.join(dir, 'ws'); fs.mkdirSync(workspace);
  const dataDir = path.join(dir, 'data'), registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Conversation', workspace }), chat = registry.createChat(project.id);
  fs.mkdirSync(chat.hiveDir, { recursive: true });
  fs.writeFileSync(path.join(chat.hiveDir, 'state.json'), JSON.stringify({ runId: 'earlier', request: 'old goal', status: 'finished', reply: { from: 'michael', kind: 'answer', text: 'a'.repeat(5000) } }));
  let child, args, env;
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, control: { modelWindows, workspace, auth: { close() {} }, runner(_exe, argv, options) { args = argv; env = options.env; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; } } });
  t.after(async () => { if (child) { releaseRunLease(chat.hiveDir, env.SCRANTON_RUN_LEASE); child.emit('close', 0); } await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const res = await fetch(server.url + `/api/projects/${project.id}/chats/${chat.id}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' }, body: JSON.stringify({ request: 'follow-up', trustedHost: true, conversation: true }) });
  assert.equal(res.status, 202, await res.text());
  const context = JSON.parse(fs.readFileSync(args[args.indexOf('--thread-context') + 1], 'utf8'));
  const pack = createContext({ dataDir, registry }).forTeam(project.id, chat.id);
  assert.deepEqual(context, { v: 3, text: pack.text, developer: pack.developer });
  assert.match(context.text, /Reply \(answer\):\na{5000}/); assert.ok(context.text.length <= 24000);
});
