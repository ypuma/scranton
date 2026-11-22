import './docker-model-env.js';
import { modelWindows } from './model-windows-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createControl } from '../../src/server/control.js';
import { createHash } from 'node:crypto';
import { emptyReflection } from '../../src/core/dreaming/reflection.js';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRegistry, derivedChatTitle } from '../../src/core/projects.js';
import { createContext } from '../../src/core/context/index.js';
import { releaseRunLease } from '../../src/core/run-lease.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

function fixture(t, base = path.resolve('.scratch/context-system/lane-s')) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'http-')), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'source'), closers = [];
  fs.mkdirSync(workspace);
  t.after(async () => { for (const close of closers.reverse()) await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Context', workspace });
  const team = registry.createChat(project.id, { title: 'Main team' }), sibling = registry.createChat(project.id, { title: 'Sibling team' }), pipeline = registry.createChat(project.id, { title: 'Main pipeline', engine: 'pipeline' });
  const foreign = registry.addProject({ name: 'Foreign', workspace: path.join(dir, 'foreign'), create: true }), stranger = registry.createChat(foreign.id);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const teamRun = (chat, id, request, live = false) => {
    const rows = [{ type: 'run_started', request, ts: '2026-01-01T00:00:00Z' }, ...(!live ? [{ type: 'run_finished', status: 'success', summary: 'Delivered', ts: '2026-01-01T00:01:00Z' }] : [])];
    write(path.join(chat.hiveDir, live ? 'events.jsonl' : `runs/${id}/events.jsonl`), rows.map((e, i) => JSON.stringify({ v: 1, seq: i + 1, runId: id, ...e })).join('\n') + '\n');
    if (live) write(path.join(chat.hiveDir, 'state.json'), { v: 1, runId: id, status: 'running', request });
  };
  const pipeRoot = (chat = pipeline) => path.join(dataDir, 'projects', chat.projectId, 'chats', chat.id, 'pipeline');
  const pipelineRun = (id, task, day = 1) => {
    const root = path.join(pipeRoot(), 'runs', id), date = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    write(path.join(root, 'status.json'), { schema: 1, run_id: id, status: 'succeeded', task, created_at: date, updated_at: date });
    write(path.join(root, 'run.json'), { task });
  };
  const projectRoute = `/api/projects/${project.id}/context`, chatRoute = (chat = team) => `/api/projects/${chat.projectId}/chats/${chat.id}/context`;
  return { dir, dataDir, workspace, registry, project, team, sibling, pipeline, stranger, write, teamRun, pipelineRun, pipeRoot, projectRoute, chatRoute, onClose: (fn) => closers.push(fn) };
}
function seedMemory(f) {
  f.teamRun(f.sibling, 'memoryproof', 'Keep review manual.');
  const source = `projects/${f.project.id}/chats/${f.sibling.id}/hive/runs/memoryproof/events.jsonl`;
  const sha256 = createHash('sha256').update(fs.readFileSync(path.join(f.dataDir, source))).digest('hex');
  const dream = f.registry.dreaming(f.project.id); f.onClose(() => dream.close()); dream.configure({ enabled: true });
  const file = path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json'), state = JSON.parse(fs.readFileSync(file));
  state.reflection = { ...emptyReflection(), memory: [{ id: 'memory', type: 'user', title: 'Manual review', text: 'PROJECT-MEMORY keep review manual.', createdAt: '2026-01-01T00:00:00.000Z', evidence: [{ signalId: 'fixture', quote: 'Keep review manual.', role: 'user', at: '2026-01-01T00:00:00.000Z', path: source, sha256 }] }] };
  f.write(file, state);
  assert.match(dream.context(), /PROJECT-MEMORY/);
  return { text: dream.context(), structured: dream.structuredContext() };
}
async function server(t, control = {}, single = false) {
  const f = fixture(t), srv = await startVisualizerServer({ ...(single ? { hiveDir: path.join(f.dir, 'hive') } : { dataDir: f.dataDir }), publicDir: f.dir, port: 0, control: { auth: { close() {} }, modelWindows, ...control } });
  f.onClose(() => srv.close());
  const req = async (route, body, headers = {}) => {
    const res = await fetch(srv.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  };
  return { ...f, srv, req };
}

// Removing toWellFormed() from derivedChatTitle leaves a dangling high surrogate in chat.json.
test('derived chat titles remain well-formed at an emoji truncation boundary', (t) => {
  const f = fixture(t), title = derivedChatTitle('a'.repeat(59) + '😀 fix');
  assert.equal(title.length, 60); assert.equal(title.isWellFormed(), true);
  const chat = f.registry.createChat(f.project.id, { title });
  assert.equal(f.registry.getChat(f.project.id, chat.id).title.isWellFormed(), true);
  assert.equal(derivedChatTitle('a'.repeat(58) + '😀 fix'), 'a'.repeat(58) + '😀');
  assert.equal(derivedChatTitle(' \n\t '), 'New chat');
});

// Route regressions fail without the contextPath/scoped context branches in registry-router.js.
test('context routes enforce guards, strict bodies, unknown paths and unknown scopes', async (t) => {
  const f = await server(t), routes = [[f.projectRoute], [f.projectRoute + '/settings', { crossChat: true }], [f.projectRoute + '/notes', { text: '' }], [f.chatRoute()], [f.chatRoute() + '/reset', {}], [f.chatRoute() + '/restore', {}]];
  for (const [route, body] of routes) {
    assert.equal((await f.req(route, body)).status, 200, route);
    assert.equal((await f.req(route, body, { 'X-Scranton-Client': '' })).status, 403, route);
    assert.equal((await f.req(route, body, { Origin: 'https://foreign.test' })).status, 403, route);
    assert.equal((await f.req(route.replace(f.project.id, 'missing'), body)).status, 404, route);
    if (route.includes('/chats/')) assert.equal((await f.req(route.replace(f.team.id, 'missing'), body)).status, 404, route);
  }
  for (const [route, bodies] of [[f.projectRoute + '/settings', [{}, { crossChat: 1 }, { crossChat: false, extra: 1 }, []]], [f.projectRoute + '/notes', [{}, { text: false }, { text: 'x'.repeat(16001) }, { text: '😀'.repeat(8001) }, { text: '', extra: 1 }]], [f.chatRoute() + '/reset', [{ extra: 1 }, null]], [f.chatRoute() + '/restore', [{ extra: 1 }, []]]]) {
    for (const body of bodies) { const r = await f.req(route, body); assert.equal(r.status, 400, JSON.stringify({ route, body })); assert.ok(r.value.error.length > 5); }
  }
  for (const route of [f.projectRoute + '/unknown', f.projectRoute + '/settings/unknown', f.chatRoute() + '/unknown', f.chatRoute() + '/reset/unknown']) for (const body of [undefined, {}]) assert.equal((await f.req(route, body)).status, 404, route);
  assert.equal((await f.req(f.projectRoute + '/notes', { text: '' }, { 'Content-Type': 'text/plain' })).status, 415);
  const oversized = await fetch(f.srv.url + f.projectRoute + '/notes', { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: ' '.repeat(262145) }); assert.equal(oversized.status, 413);
  const host = await new Promise((resolve, reject) => { const req = http.request(f.srv.url + f.projectRoute, { headers: { Host: 'foreign.test', 'X-Scranton-Client': '1' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); }); assert.equal(host, 403);
});

test('context documents, notes round trip, crossChat setting, reset and restore use disk context', async (t) => {
  const f = await server(t);
  let project = (await f.req(f.projectRoute)).value;
  assert.deepEqual(Object.keys(project).sort(), ['chats', 'defaults', 'instructions', 'notes', 'settings', 'v']); assert.equal(project.v, 2); assert.deepEqual(project.settings, { crossChat: true, budget: { mode: 'percent', value: 10 }, models: {} });
  assert.deepEqual(project.notes, { text: '', chars: 0, tokens: 0, limit: 16000, updatedAt: null });
  assert.deepEqual(Object.keys(project.chats[0]).sort(), ['engine', 'id', 'lastActiveAt', 'reset', 'title', 'turns']);
  let doc = (await f.req(f.chatRoute())).value;
  assert.deepEqual(Object.keys(doc).sort(), ['budget', 'degraded', 'developer', 'engine', 'instructions', 'memory', 'model', 'notes', 'otherChats', 'reset', 'sections', 'settings', 'truncated', 'turns', 'v']);
  assert.deepEqual(doc.turns, { total: 0, visible: 0, detailed: 0, condensed: 0, omitted: 0 }); assert.equal(doc.developer.chars, 0); assert.equal(doc.developer.text, ''); assert.equal(doc.reset, null); assert.deepEqual(doc.sections, []); assert.equal(doc.budget.tokens, 12800);
  f.teamRun(f.team, 'ownold', 'OWN-OLD'); f.teamRun(f.sibling, 'siblingold', 'SIBLING-OLD'); f.teamRun(f.stranger, 'foreignold', 'FOREIGN-SECRET'); f.pipelineRun('pipe0001', 'PIPE-OLD');
  project = (await f.req(f.projectRoute + '/notes', { text: 'Grüße 😀\r\nkeep\u0001 tabs\t' })).value;
  assert.equal(project.notes.text, 'Grüße 😀\nkeep tabs\t'); assert.equal(project.notes.chars, project.notes.text.length); assert.ok(project.notes.updatedAt);
  assert.deepEqual((await f.req(f.projectRoute)).value.notes, project.notes);
  doc = (await f.req(f.chatRoute())).value;
  assert.equal(doc.turns.visible, 1); assert.equal(doc.otherChats.chats, 2); assert.ok(doc.sections.every((s) => s.exact && s.chars === s.text.length)); assert.doesNotMatch(JSON.stringify(doc), /FOREIGN-SECRET/);
  assert.match(doc.sections.find((s) => s.id === 'recent').text, /OWN-OLD/); assert.match(doc.sections.find((s) => s.id === 'other-chats').text, /SIBLING-OLD/);
  await f.req(f.projectRoute + '/settings', { crossChat: false });
  for (const chat of [f.team, f.sibling, f.pipeline]) { const d = (await f.req(f.chatRoute(chat))).value; assert.equal(d.otherChats.chats, 0); assert.equal(d.sections.some((s) => s.id === 'other-chats'), false); }
  await f.req(f.projectRoute + '/settings', { crossChat: true });
  for (const chat of [f.team, f.pipeline]) {
    const reset = (await f.req(f.chatRoute(chat) + '/reset', {})).value; assert.ok(Date.parse(reset.reset.at)); assert.equal(reset.turns.visible, 0); assert.ok(reset.notes.chars > 0);
    const restored = (await f.req(f.chatRoute(chat) + '/restore', {})).value; assert.equal(restored.reset, null); assert.equal(restored.turns.visible, 1);
  }
  const p = (await f.req(f.chatRoute(f.pipeline))).value; assert.equal(p.engine, 'pipeline'); assert.equal(p.developer, null); assert.equal(p.budget.tokens, 12800); assert.ok(p.sections.every((s) => !s.exact));
  await f.req(f.projectRoute + '/notes', { text: '' }); assert.equal((await f.req(f.projectRoute)).value.notes.chars, 0);
});

// Reverting threadContext provider wiring or the v3 file branch loses sibling context/developer text.
test('Team start writes the exact v3 pack; inspect excludes its live run even without a root lease heuristic', async (t) => {
  let child, args, opts;
  const f = await server(t, { runner(_exe, argv, options) { args = argv; opts = options; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; } });
  f.onClose(() => { if (child) { releaseRunLease(f.team.hiveDir, opts.env.SCRANTON_RUN_LEASE); child.emit('close', 0); } });
  f.teamRun(f.team, 'ownold', 'OWN-PREVIOUS'); f.teamRun(f.sibling, 'sibold', 'SIBLING-PREVIOUS'); f.teamRun(f.stranger, 'foreignt', 'FOREIGN-SECRET');
  const memory = seedMemory(f);
  const expected = createContext({ dataDir: f.dataDir, registry: f.registry }).forTeam(f.project.id, f.team.id, { memory: memory.text });
  const started = await f.req(`/api/projects/${f.project.id}/chats/${f.team.id}/runs`, { request: 'NEW-TASK', trustedHost: true }); assert.equal(started.status, 202, JSON.stringify(started));
  const file = args[args.indexOf('--thread-context') + 1], pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(pack.text, /PROJECT-MEMORY/);
  assert.deepEqual(pack, { v: 3, text: expected.text, developer: expected.developer }); assert.match(pack.text, /OWN-PREVIOUS/); assert.match(pack.text, /#2 \[success\] SIBLING-PREVIOUS -> Delivered/); assert.doesNotMatch(JSON.stringify(pack), /FOREIGN-SECRET/); assert.doesNotMatch(pack.developer, /SIBLING-PREVIOUS/);
  f.teamRun(f.team, opts.env.SCRANTON_RUN_ID, 'LIVE-PRIVATE', true);
  releaseRunLease(f.team.hiveDir, opts.env.SCRANTON_RUN_LEASE);
  const doc = (await f.req(f.chatRoute())).value; assert.equal(doc.turns.visible, 1); assert.doesNotMatch(JSON.stringify(doc), /LIVE-PRIVATE/);
  child.emit('close', 0); child = null;
  assert.match(JSON.stringify((await f.req(f.chatRoute())).value), /LIVE-PRIVATE/);
});

// Reverting inspectContext's Dreaming source or post-mutation re-inspect loses the memory layer.
test('context GET/reset/restore retain the project Dreaming string or structured array for both engines', async (t) => {
  const f = await server(t); seedMemory(f);
  for (const chat of [f.team, f.pipeline]) for (const [suffix, body] of [['', undefined], ['/reset', {}], ['/restore', {}]]) {
    const result = await f.req(f.chatRoute(chat) + suffix, body); assert.equal(result.status, 200); assert.ok(result.value.memory.chars > 0);
    assert.match(result.value.sections.find((s) => s.id === 'memory').text, /PROJECT-MEMORY/);
  }
});

test('optional Dreaming corruption does not fail context GET/reset/restore for either engine', async (t) => {
  const f = await server(t); f.write(path.join(f.dataDir, 'projects', f.project.id, 'dreaming/state.json'), '{PRIVATE-SECRET');
  for (const chat of [f.team, f.pipeline]) for (const [suffix, body] of [['', undefined], ['/reset', {}], ['/restore', {}]]) {
    const result = await f.req(f.chatRoute(chat) + suffix, body); assert.equal(result.status, 200); assert.equal(result.value.memory.chars, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SECRET/);
  }
});

// Removing the live-id lookup catch makes malformed Pipeline metadata fail the whole request.
test('corrupt Pipeline status degrades the item without breaking context inspection', async (t) => {
  const f = await server(t); f.pipelineRun('pipe0001', 'READABLE-TURN');
  f.write(path.join(f.pipeRoot(), 'runs/broken01/status.json'), '{corrupt');
  const r = await f.req(f.chatRoute(f.pipeline)); assert.equal(r.status, 200); assert.equal(r.value.turns.visible, 1); assert.match(JSON.stringify(r.value), /READABLE-TURN/);
});

test('single-hive context routes do not exist', async (t) => {
  const f = await server(t, {}, true);
  for (const [route, body] of [['/api/projects/default/context'], ['/api/projects/default/context/settings', { crossChat: true }], ['/api/projects/default/context/notes', { text: '' }], ['/api/projects/default/chats/default/context'], ['/api/projects/default/chats/default/context/reset', {}], ['/api/projects/default/chats/default/context/restore', {}]]) assert.equal((await f.req(route, body)).status, 404);
});

// Removing the supervisor context.forPipeline branch drops notes, earlier turns and siblings from the wire.
test('Pipeline start writes context unchanged, siblings only in other_chats, reset honoured and demo history absent', async (t) => {
  const changes = { SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.resolve('.scratch/context-system/lane-s/workspaces') };
  const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]])); Object.assign(process.env, changes);
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const auth = { listAccounts: () => [{ id: 'openai', kind: 'api_key', status: 'signed_in' }], listModels: () => ({ providers: [{ id: 'openai', models: [{ id: 'gpt-4o' }] }] }), resolveAuth: () => ({ key: 'fixture-credential' }), close() {} };
  const f = await server(t, { auth });
  f.teamRun(f.sibling, 'sibold', 'SIBLING-PREVIOUS'); f.teamRun(f.stranger, 'foreignt', 'FOREIGN-SECRET');
  for (let i = 1; i <= 5; i++) f.pipelineRun('pipe000' + i, 'OWN-TURN-' + i, i);
  await f.req(f.projectRoute + '/notes', { text: 'Project notes Grüße 😀' });
  const route = `/api/projects/${f.project.id}/chats/${f.pipeline.id}/pipeline/runs`, root = f.pipeRoot();
  const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'openai', model: 'gpt-4o' }]));
  const body = { task: 'NEW-TASK', models, sandbox: { mode: 'host', trustHost: true } };
  const memory = seedMemory(f);
  const context = createContext({ dataDir: f.dataDir, registry: f.registry }), expected = context.forPipeline(f.project.id, f.pipeline.id, { projectMemory: memory.structured });
  const started = await f.req(route, body); assert.equal(started.status, 202, JSON.stringify(started)); const id = started.value.runId;
  const file = path.join(root, 'requests', id + '.history.json'), wire = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(wire, expected); assert.ok(wire.context.earlier.length); assert.match(JSON.stringify(wire.context.other_chats), /SIBLING-PREVIOUS/); assert.doesNotMatch(JSON.stringify(wire.runs), /SIBLING-PREVIOUS/); assert.doesNotMatch(JSON.stringify(wire), /FOREIGN-SECRET/);
  const wait = async (runId, status) => { for (let i = 0; i < 500; i++) { const r = (await f.req(route + '/' + runId)).value; if (!r.live && r.status?.status === status) return r; await sleep(20); } assert.fail('Pipeline did not reach ' + status); };
  let gate = await wait(id, 'awaiting_approval');
  const doc = (await f.req(f.chatRoute(f.pipeline))).value; assert.equal(doc.turns.visible, 5); assert.doesNotMatch(JSON.stringify(doc), /NEW-TASK/);
  await f.req(route + '/' + id + '/decision', { gate: 'plan', decision: 'reject', digest: gate.status.pending.digest }); await wait(id, 'rejected');
  const reset = await f.req(f.chatRoute(f.pipeline) + '/reset', {}); assert.equal(reset.value.turns.visible, 0);
  const next = await f.req(route, body); assert.equal(next.status, 202); const fresh = JSON.parse(fs.readFileSync(path.join(root, 'requests', next.value.runId + '.history.json')));
  assert.deepEqual(fresh.runs, []); assert.equal(fresh.context.earlier, undefined); assert.match(JSON.stringify(fresh.context.other_chats), /SIBLING-PREVIOUS/); assert.equal(fresh.context.notes, 'Project notes Grüße 😀');
  gate = await wait(next.value.runId, 'awaiting_approval'); await f.req(route + '/' + next.value.runId + '/decision', { gate: 'plan', decision: 'reject', digest: gate.status.pending.digest }); await wait(next.value.runId, 'rejected');
  const demo = await f.req(route, { task: 'Demo', demo: true }); assert.equal(demo.status, 202); await wait(demo.value.runId, 'awaiting_approval');
  assert.equal(fs.existsSync(path.join(root, 'requests', demo.value.runId + '.history.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'runs', demo.value.runId, 'argv.json'))).includes('--history-file'), false);
});

// The real Python validator rejects extra/invalid wire keys; the fixture requires all three new layers.
test('forPipeline UTF-8 wire with notes, earlier and other_chats is accepted and rendered by Python', async (t) => {
  const python = path.resolve('.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) { t.skip('Development Python runtime is missing'); return; }
  const f = fixture(t); for (let i = 1; i <= 5; i++) f.pipelineRun('pipe000' + i, 'Own Grüße 😀 ' + i, i);
  f.registry.updateChat(f.project.id, f.sibling.id, { title: 'Sibling Grüße 😀 cut \ud83d' });
  f.teamRun(f.sibling, 'siblingt', 'Sibling Grüße 😀 cut \ud83d request');
  const context = createContext({ dataDir: f.dataDir, registry: f.registry }); await context.setNotes(f.project.id, 'Notes Grüße 😀');
  const wire = context.forPipeline(f.project.id, f.pipeline.id), file = path.join(f.dir, 'history.json');
  assert.ok(wire.context.earlier.length); assert.ok(wire.context.other_chats.length); f.write(file, wire);
  f.pipelineRun('pipe0005', '😀'.repeat(4000), 5);
  f.write(path.join(f.pipeRoot(), 'runs/pipe0005/artifacts/plan.json'), { summary: 'P'.repeat(7600), steps: [{ id: 'fresh', title: 'Fresh work', files: [], depends_on: [] }] });
  f.write(path.join(f.pipeRoot(), 'runs/pipe0005/delivery/reply.json'), { kind: 'answer', text: 'R'.repeat(3500) });
  await context.setNotes(f.project.id, '😀'.repeat(1000) + 'N'.repeat(1000));
  const large = context.forPipeline(f.project.id, f.pipeline.id), largeFile = path.join(f.dir, 'history-large.json'), bytes = Buffer.byteLength(JSON.stringify(large));
  assert.ok(bytes >= 32000 && bytes <= Math.max(32768, large.budget.history_bytes + large.budget.context_bytes), `Near-limit wire: ${bytes} bytes; runs ${JSON.stringify(large.runs.map((r) => ({ task: Buffer.byteLength(r.task), plan: Buffer.byteLength(r.plan), outcome: Buffer.byteLength(r.outcome) })))}; context ${Buffer.byteLength(JSON.stringify(large.context))}`); assert.ok(Buffer.byteLength(JSON.stringify(large.context)) <= Math.max(8000, large.budget.context_bytes)); f.write(largeFile, large);
  const script = path.join(f.dir, 'validate.py');
  f.write(script, `import json, sys\nfrom pathlib import Path\nfrom scranton_pipeline.history import load_history, validate_context, conversation_context_block\nfrom scranton_pipeline.tools.secrets import Redactor\nh = load_history(Path(sys.argv[1]), Redactor())\nassert validate_context(h['context'], Redactor(), budget=True) == h['context']\nassert all(h['context'].get(k) for k in ('notes', 'earlier', 'other_chats'))\nblock = conversation_context_block(h, 4000)\npayload = json.loads(block.split('\\n')[2])\nassert len(block.encode('utf-8')) <= 4000\nif Path(sys.argv[1]).name == 'history.json':\n    assert payload['notes'] == h['context']['notes']\n    assert payload['earlier'] == h['context']['earlier']\n    assert payload['other_chats'] == h['context']['other_chats']\nassert 'Advisory context' in payload['authority']\nprint('PASS: load_history + validate_context + conversation_context_block; UTF-8 notes, earlier, other_chats')\n`);
  const tmp = path.resolve('.scratch/pipeline/tmp'); fs.mkdirSync(tmp, { recursive: true });
  for (const input of [file, largeFile]) {
    const result = spawnSync(python, [script, input], { encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode'), PYTHONPATH: path.resolve('engine/src'), PYTHONIOENCODING: 'utf-8' } });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr); assert.match(result.stdout, /^PASS: load_history/); t.diagnostic(result.stdout.trim());
  }
  t.diagnostic(`Lone-surrogate sibling title/request accepted; near-limit compact wire: ${bytes} bytes`);
});

// Demo planners use a fixed request and never consume the Team pack.
test('C1.5 Team demo neither builds nor writes nor passes a context pack', async (t) => {
  let child, args, opts, builds = 0;
  const f = fixture(t, path.resolve('.scratch/context-system/lane-c1')), control = createControl({ hive: f.team.hiveDir, workspace: f.workspace, auth: { close() {} }, prepareThread: true,
    runner(_exe, argv, options) { args = argv; opts = options; child = Object.assign(new EventEmitter(), { pid: 123 }); return child; },
    threadContext() { builds++; return { text: 'unused', developer: '' }; } });
  f.onClose(async () => { if (child) { releaseRunLease(f.team.hiveDir, opts.env.SCRANTON_RUN_LEASE); child.emit('close', 0); } await control.close(); });
  const req = Object.assign(new PassThrough(), { method: 'POST', headers: { 'x-scranton-client': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1', localPort: 1 } });
  let status;
  const handled = control.handle(req, { writeHead(value) { status = value; }, end() {} }, '/api/runs');
  req.end(JSON.stringify({ demo: { scenario: 'question', delayMs: 0 } })); await handled;
  assert.equal(status, 202);
  assert.equal(args.includes('--thread-context'), false);
  assert.equal(fs.existsSync(path.join(f.team.hiveDir, 'control/thread-context.json')), false);
  assert.equal(builds, 0);
});


test('context routes expose repository instructions separately and respect the environment opt-out', async t => {
  const f = await server(t);
  f.write(path.join(f.workspace, 'AGENTS.md'), 'Use project tests.');
  f.write(path.join(f.workspace, 'src/AGENTS.md'), 'Use subtree tests.');
  const before = process.env.SCRANTON_AGENTS_MD;
  t.after(() => { if (before === undefined) delete process.env.SCRANTON_AGENTS_MD; else process.env.SCRANTON_AGENTS_MD = before; });
  process.env.SCRANTON_AGENTS_MD = '1';
  const project = (await f.req(f.projectRoute)).value;
  const chat = (await f.req(f.chatRoute())).value;
  assert.deepEqual(project.instructions, chat.instructions);
  assert.equal(project.instructions.file, 'AGENTS.md');
  assert.equal(project.instructions.bytes, 18);
  assert.ok(project.instructions.tokens > 0);
  assert.deepEqual(project.instructions.nested, ['src/AGENTS.md']);
  assert.equal(project.instructions.nestedCount, 1);
  assert.equal(chat.budget.used, 0);
  process.env.SCRANTON_AGENTS_MD = '0';
  assert.equal((await f.req(f.projectRoute)).value.instructions, null);
  assert.equal((await f.req(f.chatRoute())).value.instructions, null);
});
