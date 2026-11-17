import '../core/isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createContext } from '../../src/core/context/index.js';
import { createModelWindows } from '../../src/core/model-windows.js';
import { readRunLease, releaseRunLease } from '../../src/core/run-lease.js';
import { ChatRouter } from '../../src/core/chat-router.js';
import { waitForResponse } from '../../src/core/file-control.js';

const ref = (model = 'base') => ({ provider: 'budget-fixture', model });
const recipient = (model, window) => ({ id: `budget-fixture/${model}`, window, known: true });
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
async function fixture(t, { real = false, pipeline = false, runner, modelWindows } = {}) {
  const base = path.resolve('.scratch/context-budget/lane-s'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'http-')), workspace = path.join(dir, 'source'), dataDir = path.join(dir, 'data'); fs.mkdirSync(workspace);
  environment(t, Object.fromEntries(['MICHAEL', 'DWIGHT', 'ANGELA'].flatMap((role) => [[`SCRANTON_${role}_PROVIDER`, 'budget-fixture'], [`SCRANTON_${role}_MODEL`, 'base']])));
  environment(t, { FAKE_PIPELINE_INVOCATIONS: path.join(dir, 'pipeline-invocations.jsonl'), SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(dir, 'workspaces'), SCRANTON_PI_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pi.js')]), FAKE_PI_SCENARIO: 'question', SCRANTON_CONVERSATION: '1' });
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Budget', workspace }), chat = registry.createChat(project.id, pipeline ? { engine: 'pipeline' } : {});
  const models = [{ id: 'base', contextWindow: 32000 }, { id: 'pick', contextWindow: 200000 }, { id: 'dev', contextWindow: 64000 }];
  let catalogs = 0, invocation, child;
  const windows = modelWindows ?? Object.assign(createModelWindows({ providers: () => [{ id: 'budget-fixture', models }], runtime: { getModel() {} } }), { warm() {} });
  const auth = { close() {}, listAccounts: () => [{ id: 'budget-fixture', kind: 'oauth', status: 'signed_in' }], listModels: () => { catalogs++; return { providers: [{ id: 'budget-fixture', signedIn: true, models }] }; } };
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, control: { auth, modelWindows: windows, runner(exe, args, opts) { invocation = { exe, args, opts }; child = runner ? runner(exe, args, opts) : real ? spawn(exe, args, opts) : Object.assign(new EventEmitter(), { pid: 123 }); return child; } } });
  t.after(async () => { if (!real && child) { if (readRunLease(chat.hiveDir)) releaseRunLease(chat.hiveDir, readRunLease(chat.hiveDir).token); child.emit('close', 0); } await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const req = async (route, body) => { const r = await fetch(server.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, value: await r.json() }; };
  const route = `/api/projects/${project.id}/chats/${chat.id}`, contextRoute = `/api/projects/${project.id}/context`;
  return { dir, dataDir, workspace, registry, project, chat, server, req, route, contextRoute, windows, get invocation() { return invocation; }, get catalogs() { return catalogs; }, finish() { if (readRunLease(chat.hiveDir)) releaseRunLease(chat.hiveDir, readRunLease(chat.hiveDir).token); child.emit('close', 0); child = null; } };
}
async function until(fn, predicate) {
  for (let i = 0; i < 600; i++) { const value = await fn(); if (predicate(value)) return value; await sleep(25); }
  assert.fail('Timed out');
}

// Revert either 262144 check in readBody to fail the declared/chunked boundary cases.
test('budget HTTP: declared and chunked bodies accept 262144 bytes, reject 262145 in control and registry', async (t) => {
  const f = await fixture(t);
  for (const route of ['/api/runs', f.contextRoute + '/notes']) for (const chunked of [false, true]) for (const size of [262144, 262145]) {
    const body = JSON.stringify(route.endsWith('/notes') ? { text: '' } : { request: 'valid', maxCycles: 11 });
    const payload = body + ' '.repeat(size - Buffer.byteLength(body));
    const result = await new Promise((resolve, reject) => {
      const req = http.request(f.server.url + route, { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json', ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': size }) } }, (res) => { let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) })); });
      req.on('error', reject); req.write(payload.slice(0, 131072)); req.end(payload.slice(131072));
    });
    assert.equal(result.status, size > 262144 ? 413 : route.endsWith('/notes') ? 200 : 400);
    if (size === 262144 && !route.endsWith('/notes')) assert.equal(result.value.error, 'Invalid maxCycles');
  }
});

// Revert the <=4000 argv branch or option splice in control.start to fail the exact array.
test('budget request: 4000 characters retain exact argv; 4001 switches to file transport', async (t) => {
  const f = await fixture(t), text = '--' + 'x'.repeat(3998);
  assert.equal((await f.req(f.route + '/runs', { request: text, trustedHost: true })).status, 202);
  assert.deepEqual(f.invocation.args, [path.resolve('bin/scranton.js'), 'run', '--thread-context', path.join(f.chat.hiveDir, 'control/thread-context.json'), '--gates', 'angela', '--single-hive', '--hive', f.chat.hiveDir, '--workspace', f.workspace, '--on-breaker', 'hive', '--trusted-host', '--', text]);
  assert.equal(fs.existsSync(path.join(f.chat.hiveDir, 'control/request.json')), false);
  f.finish();
  assert.equal((await f.req(f.route + '/runs', { request: text + 'x', trustedHost: true })).status, 202);
  assert.equal(f.invocation.args.includes('--request-file'), true); assert.equal(f.invocation.args.includes('--'), false);
});

// Revert request-file writing/argv in control.start (or the 32768 validator) to fail.
test('budget request: 32768 quoted UTF-8 characters reach the real orchestrator intact through a file', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { real: true }), text = ('\u6771\u4eac\\"\u00e4'.repeat(7000)).slice(0, 32768);
  assert.equal(text.length, 32768);
  assert.equal((await f.req(f.route + '/runs', { request: text, trustedHost: true, conversation: true })).status, 202);
  const args = f.invocation.args, file = args[args.indexOf('--request-file') + 1];
  assert.equal(file, path.join(f.chat.hiveDir, 'control/request.json')); assert.equal(args.includes('--'), false); assert.equal(args.includes(text), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 1, request: text });
  const done = await until(() => f.req(f.route + '/control'), (r) => r.value.lastExit);
  assert.equal(done.value.lastExit.exitCode, 0, done.value.lastExit.outputTail);
  assert.equal(fs.existsSync(file), false);
  const events = fs.readFileSync(path.join(f.chat.hiveDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find((e) => e.type === 'run_started').request, text);
  assert.ok(fs.readFileSync(path.join(f.chat.hiveDir, 'michael/inbox.md'), 'utf8').includes(text));
  assert.equal((await f.req(f.route + '/runs', { request: text + 'x', trustedHost: true })).status, 400);
});

// Revert launchConfig model resolution, recipients closure, or v:3 in control.start to fail.
for (const docker of [false, true]) test(`budget Team: v3 pack uses ${docker ? 'Docker defaults, ignoring picks' : 'per-run planner and developer picks'}`, async (t) => {
  const f = await fixture(t), core = createContext({ dataDir: f.dataDir, registry: f.registry });
  core.setNotes(f.project.id, 'Standing notes\n'.repeat(1000));
  const recipients = docker ? { planner: recipient('base', 32000), developer: recipient('base', 32000) } : { planner: recipient('pick', 200000), developer: recipient('dev', 64000) };
  const expected = core.forTeam(f.project.id, f.chat.id, { recipients });
  const defaults = (await f.req(f.route + '/context')).value;
  assert.equal(defaults.budget.tokens, 3200); assert.deepEqual(defaults.model, recipient('base', 32000)); assert.equal(defaults.developer.budget.tokens, 320);
  const body = { request: 'Budgeted run', models: { michael: ref('pick'), dwight: ref('dev') }, ...(docker ? { sandbox: 'docker' } : { trustedHost: true }) };
  assert.equal((await f.req(f.route + '/runs', body)).status, 202);
  const file = f.invocation.args[f.invocation.args.indexOf('--thread-context') + 1];
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { v: 3, text: expected.text, developer: expected.developer });
  assert.equal(f.catalogs, docker ? 0 : 1);
  if (!docker) assert.ok(expected.text.length > core.forTeam(f.project.id, f.chat.id, { recipients: { planner: recipient('base', 32000) } }).text.length);
});

// Revert settings patch closed-key validation/forwarding in registry-router to fail.
test('budget settings: merge, resets, strict rules, hostile keys and 33rd model override', async (t) => {
  const f = await fixture(t), route = f.contextRoute + '/settings';
  for (const patch of [{ crossChat: false }, { budget: { mode: 'percent', value: 1 } }, { budget: { mode: 'percent', value: 50 } }, { budget: { mode: 'tokens', value: 1000 } }, { budget: { mode: 'tokens', value: 200000 } }, { models: { 'budget-fixture/base': { mode: 'tokens', value: 5000 } } }]) assert.equal((await f.req(route, patch)).status, 200, JSON.stringify(patch));
  let doc = (await f.req(f.contextRoute)).value; assert.equal(doc.settings.crossChat, false); assert.equal(doc.settings.budget.value, 200000); assert.equal(doc.settings.models['budget-fixture/base'].value, 5000);
  assert.equal((await f.req(route, { budget: null, models: { 'budget-fixture/base': null } })).status, 200);
  doc = (await f.req(f.contextRoute)).value; assert.deepEqual(doc.settings.budget, { mode: 'percent', value: 10 }); assert.deepEqual(doc.settings.models, {});
  const invalid = [{}, { v: 2 }, { extra: 1, crossChat: true }, { crossChat: 1 }, { budget: {} }, { budget: { mode: 'percent', value: 0 } }, { budget: { mode: 'percent', value: 51 } }, { budget: { mode: 'tokens', value: 999 } }, { budget: { mode: 'tokens', value: 200001 } }, { budget: { mode: 'tokens', value: 1000, extra: 1 } }, { budget: { mode: 'percent', value: 1.5 } }, { models: null }, { models: [] }, { models: { 'bad key': null } }, { models: { '': null } }, { models: { ['x'.repeat(514)]: null } }, { models: { bad: {} } }, { models: { bad: { mode: 'other', value: 10 } } }];
  for (const key of ['__proto__', 'constructor', 'prototype']) invalid.push(JSON.parse(`{"models":{"${key}":{"mode":"tokens","value":1000}}}`));
  for (const patch of invalid) assert.equal((await f.req(route, patch)).status, 400, JSON.stringify(patch));
  const models = Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['model' + i, { mode: 'tokens', value: 1000 }]));
  assert.equal((await f.req(route, { models })).status, 200);
  assert.equal((await f.req(route, { models: { model32: { mode: 'tokens', value: 1000 } } })).status, 400);
  assert.equal(Object.keys((await f.req(f.contextRoute)).value.settings.models).length, 32);
  assert.equal((await f.req(route, { models: { model0: null, model32: { mode: 'tokens', value: 1000 } } })).status, 200);
});

// Revert registry-router's text.length >16000 to fail acceptance at the boundary.
test('budget notes: 16000 UTF-8 characters round trip, 16001 refused', async (t) => {
  const f = await fixture(t), text = '\u6771'.repeat(16000), route = f.contextRoute + '/notes';
  const saved = await f.req(route, { text }); assert.equal(saved.status, 200); assert.equal(saved.value.notes.text, text); assert.equal(saved.value.notes.limit, 16000);
  assert.equal((await f.req(route, { text: text + 'x' })).status, 400);
  assert.equal((await f.req(f.contextRoute)).value.notes.text, text);
});

// Revert inspectContext query validation/resolution or Team defaults resolution to fail.
test('budget documents: Pipeline pick is optional, paired and validated; Team ignores it', async (t) => {
  const f = await fixture(t, { pipeline: true });
  const doc = (await f.req(f.route + '/context?provider=budget-fixture&model=pick')).value;
  assert.deepEqual(doc.model, recipient('pick', 200000)); assert.equal(doc.budget.tokens, 17500);
  const unknown = (await f.req(f.route + '/context')).value; assert.deepEqual(unknown.model, { id: null, window: 128000, known: false });
  for (const query of ['provider=x', 'model=x', 'provider=&model=x', 'provider=x&model=', 'provider=a%20b&model=x', 'provider=x&model=%00', 'provider=x&model=%7f', ...Array.from({ length: 32 }, (_, i) => 'provider=x&model=' + encodeURIComponent(String.fromCharCode(0x80 + i))), ...Array.from({ length: 32 }, (_, i) => 'provider=' + encodeURIComponent(String.fromCharCode(0x80 + i)) + '&model=x'), 'provider=x&model=' + 'm'.repeat(257), 'provider=x&provider=y&model=z']) assert.equal((await f.req(f.route + '/context?' + query)).status, 400, query);
  const team = f.registry.createChat(f.project.id), route = `/api/projects/${f.project.id}/chats/${team.id}/context?provider=%00`;
  const result = await f.req(route); assert.equal(result.status, 200); assert.deepEqual(result.value.model, recipient('base', 32000));
});

// Revert supervisor's recipients:{planner} forwarding to fail the small-window allowance.
test('budget Pipeline start: selected planner budgets the persisted history file; demo and decision attach none', async (t) => {
  const f = await fixture(t, { pipeline: true });
  createContext({ dataDir: f.dataDir, registry: f.registry }).setNotes(f.project.id, 'History notes');
  const route = f.route + '/pipeline/runs', models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, ref()]));
  const started = await f.req(route, { task: 'Fresh task', models }); assert.equal(started.status, 202);
  const root = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chat.id, 'pipeline'), id = started.value.runId;
  const wire = JSON.parse(fs.readFileSync(path.join(root, 'requests', id + '.history.json')));
  assert.deepEqual(wire.budget, { history_bytes: 12000, context_bytes: 4000 }); assert.equal(wire.context.notes, 'History notes');
  const gate = await until(() => f.req(route + '/' + id), (r) => !r.value.live && r.value.status?.status === 'awaiting_approval');
  assert.equal((await f.req(route + '/' + id + '/decision', { gate: 'plan', decision: 'reject', digest: gate.value.status.pending.digest })).status, 202);
  await until(() => f.req(route + '/' + id), (r) => !r.value.live && r.value.status?.status === 'rejected');
  const decision = fs.readFileSync(path.join(f.dir, 'pipeline-invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((argv) => argv[0] === 'resume' && argv.includes('--decision=reject'));
  assert.ok(decision, 'fake engine received the decision'); assert.equal(decision.includes('--history-file'), false, 'decision argv carries no history file');
  const demo = await f.req(route, { task: 'Demo', demo: true }); assert.equal(demo.status, 202);
  await until(() => f.req(route + '/' + demo.value.runId), (r) => !r.value.live && r.value.status?.status === 'awaiting_approval');
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'runs', demo.value.runId, 'argv.json')));
  assert.equal(argv.includes('--history-file'), false); assert.equal(fs.existsSync(path.join(root, 'requests', demo.value.runId + '.history.json')), false);
});

// Revert server chat length, ChatRouter maxText or spool size to fail the delivered text.
test('budget chat: 16000 multi-byte/escaped characters survive HTTP and command consumption; 16001 refused', async (t) => {
  const f = await fixture(t); assert.equal((await f.req(f.route + '/runs', { request: 'Chat', trustedHost: true })).status, 202);
  const runId = (await f.req(f.route + '/control')).value.run.runId;
  fs.writeFileSync(path.join(f.chat.hiveDir, 'state.json'), JSON.stringify({ runId, instances: { 'dwight-m1': { status: 'thinking' } } }));
  const rows = [], router = new ChatRouter({ hiveDir: f.chat.hiveDir, runId, emit: (type, fields) => rows.push({ type, ...fields }) }); t.after(() => router.close()); router.register('dwight-m1');
  for (const text of ['\u6771'.repeat(16000), '\u0001'.repeat(15999) + 'x']) {
    const body = { runId, to: 'dwight-m1', text };
    assert.equal((await f.req(f.route + '/chat', { ...body, text: text + 'x' })).status, 400);
    const result = await f.req(f.route + '/chat', body); assert.equal(result.status, 202);
    const file = path.join(f.chat.hiveDir, 'control/chat', result.value.id + '.json'); assert.ok(fs.statSync(file).size > 16384);
    await router.consume(); assert.equal(rows.find((e) => e.id === result.value.id).text, text);
    let received; await router.attach('dwight-m1', { sendMessage(value) { received = value; return { ok: true }; } }); assert.ok(received.endsWith(text)); router.detach('dwight-m1');
    assert.equal(rows.at(-1).delivery, 'delivered'); assert.equal(fs.existsSync(file), false);
  }
});

// Revert validDecision's <=16000 to fail both HTTP acceptance and file answer consumption.
test('budget feedback: 16000 characters survive HTTP and human response archive; 16001 refused', async (t) => {
  const f = await fixture(t); await f.req(f.route + '/runs', { request: 'Feedback', trustedHost: true });
  const runId = (await f.req(f.route + '/control')).value.run.runId;
  fs.writeFileSync(path.join(f.chat.hiveDir, 'events.jsonl'), JSON.stringify({ v: 1, runId, seq: 1, type: 'hitl_request', options: ['feedback'] }) + '\n');
  const feedback = '\u6771'.repeat(16000);
  assert.equal((await f.req(f.route + '/hitl', { decision: 'feedback', feedback: feedback + 'x' })).status, 400);
  assert.equal((await f.req(f.route + '/hitl', { decision: 'feedback', feedback })).status, 202);
  const answer = await waitForResponse(f.chat.hiveDir, { runId, seq: 1, options: ['feedback'] }, { signal: AbortSignal.timeout(1000), log() {} });
  assert.equal(answer.feedback, feedback); assert.equal(fs.existsSync(path.join(f.chat.hiveDir, 'human/archive', `response-${runId}-1.json`)), true);
});

// Revert the dataDir guard or warm() call in startVisualizerServer to fail.
for (const registry of [false, true]) test(`budget resolver: ${registry ? 'registry warms once without awaiting' : 'single hive never warms or resolves'}`, { timeout: 3000 }, async (t) => {
  const base = path.resolve('.scratch/context-budget/fix-s'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'warm-')), calls = [];
  const modelWindows = { warm() { calls.push('warm'); return new Promise(() => {}); }, resolve() { calls.push('resolve'); return new Promise(() => {}); } };
  const server = await startVisualizerServer({ ...(registry ? { dataDir: path.join(dir, 'data') } : { hiveDir: path.join(dir, 'hive') }), publicDir: dir, port: 0, control: { auth: { close() {} }, modelWindows } });
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(calls, registry ? ['warm'] : []);
  const response = await fetch(server.url + (registry ? '/api/projects' : '/api/state'), { headers: { 'X-Scranton-Client': '1' } }); assert.equal(response.status, 200);
});

// Revert inspectContext's configuration/resolution fallback to fail these documents.
for (const failure of ['agents', 'environment', 'resolver']) test(`budget documents: ${failure} warnings retain configured models; errors fall back for GET, reset and restore`, async (t) => {
  const modelWindows = failure === 'resolver' ? { warm() {}, resolve() { throw Error('Unavailable registry'); } } : undefined;
  const f = await fixture(t, { modelWindows });
  await f.req(f.contextRoute + '/notes', { text: 'Keep the document available' });
  if (failure === 'agents') fs.writeFileSync(path.join(f.dataDir, 'agents.json'), JSON.stringify({ v: 1, agents: { michael: { thinking: 'invalid-thinking' } } }));
  if (failure === 'environment') environment(t, { SCRANTON_MICHAEL_THINKING: 'invalid-thinking' });
  for (const [suffix, body] of [['', undefined], ['/reset', {}], ['/restore', {}]]) await t.test(suffix || 'GET', async () => {
    const result = await f.req(f.route + '/context' + suffix, body);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.deepEqual(result.value.model, failure === 'agents' ? recipient('base', 32000) : { id: null, window: 128000, known: false });
    assert.deepEqual(result.value.developer.model, result.value.model);
    assert.equal(result.value.budget.tokens, failure === 'agents' ? 3200 : 12800);
    assert.match(result.value.sections.find((s) => s.id === 'notes').text, /Keep the document available/);
    assert.equal(Boolean(result.value.reset), suffix === '/reset');
  });
});

// Revert request cleanup in stopSending or the synchronous spawn catch to fail.
for (const outcome of ['exit', 'close', 'throw', 'error']) test(`budget request cleanup: ${outcome}`, async (t) => {
  let child;
  const f = await fixture(t, { runner() {
    if (outcome === 'throw') throw Error('Spawn refused');
    child = Object.assign(new EventEmitter(), { pid: outcome === 'error' ? undefined : 123 });
    return child;
  } });
  const result = await f.req(f.route + '/runs', { request: 'x'.repeat(4001), trustedHost: true });
  const file = path.join(f.chat.hiveDir, 'control/request.json');
  if (outcome === 'throw') assert.equal(result.status, 500);
  else {
    assert.equal(result.status, 202);
    assert.equal(JSON.parse(fs.readFileSync(file)).request.length, 4001, 'available until the child finishes');
    if (outcome === 'error') child.emit('error', Error('Spawn refused'));
    else child.emit(outcome, 0);
  }
  assert.equal(fs.existsSync(file), false);
  if (child && outcome !== 'error') f.finish();
});

test('budget request cleanup: argv start removes stale request before spawn', async (t) => {
  const f = await fixture(t), file = path.join(f.chat.hiveDir, 'control/request.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'stale');
  assert.equal((await f.req(f.route + '/runs', { request: 'Short', trustedHost: true })).status, 202);
  assert.equal(fs.existsSync(file), false);
});

test('budget request cleanup: argv start tolerates an unremovable stale request', async (t) => {
  const f = await fixture(t), file = path.join(f.chat.hiveDir, 'control/request.json');
  fs.mkdirSync(file, { recursive: true }); fs.writeFileSync(path.join(file, 'stale'), 'stale');
  assert.equal((await f.req(f.route + '/runs', { request: 'Short', trustedHost: true })).status, 202);
  assert.deepEqual(f.invocation.args.slice(-2), ['--', 'Short']);
  assert.equal(f.invocation.args.includes('--request-file'), false);
  assert.equal(fs.readFileSync(path.join(file, 'stale'), 'utf8'), 'stale');
});

test('budget request cleanup: partial write fails clearly without spawning or leaving files', async (t) => {
  const f = await fixture(t), file = path.join(f.chat.hiveDir, 'control/request.json'), tmp = `${file}.${process.pid}.tmp`;
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (target, ...args) {
    if (target === tmp) { write(target, 'partial'); throw Object.assign(Error('Disk full'), { code: 'ENOSPC' }); }
    return write(target, ...args);
  });
  const result = await f.req(f.route + '/runs', { request: 'x'.repeat(4001), trustedHost: true });
  assert.equal(result.status, 500);
  assert.match(result.value.error, /Cannot write request file: Disk full/);
  assert.equal(f.invocation, undefined);
  assert.equal(fs.existsSync(tmp), false); assert.equal(fs.existsSync(file), false);
  assert.equal(readRunLease(f.chat.hiveDir), null);
});

// Cleanup is secondary to the launch/write error that stopped the run.
for (const fault of ['spawn', 'write']) test(`budget cleanup preserves the original ${fault} error`, async (t) => {
  const f = await fixture(t, { runner() { throw Object.assign(Error('Original spawn failure'), { status: 418 }); } });
  const file = path.join(f.chat.hiveDir, 'control/request.json'), tmp = `${file}.${process.pid}.tmp`;
  const rm = fs.rmSync, write = fs.writeFileSync;
  let removes = 0;
  t.mock.method(fs, 'rmSync', function (target, ...args) {
    if (fault === 'spawn' && target === file && ++removes === 2 || fault === 'write' && target === tmp) throw Object.assign(Error('Secondary cleanup failure'), { status: 503 });
    return rm(target, ...args);
  });
  if (fault === 'write') t.mock.method(fs, 'writeFileSync', function (target, ...args) {
    if (target === tmp) { write(target, 'partial'); throw Error('Original disk failure'); }
    return write(target, ...args);
  });
  const result = await f.req(f.route + '/runs', { request: 'x'.repeat(4001), trustedHost: true });
  assert.deepEqual(result, fault === 'spawn' ? { status: 418, value: { error: 'Original spawn failure' } } : { status: 500, value: { error: 'Cannot write request file: Original disk failure' } });
  assert.equal(readRunLease(f.chat.hiveDir), null);
});
