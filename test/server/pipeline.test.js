import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRegistry } from '../../src/core/projects.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const key = 'test-pipeline-key-never-expose-79cc48';
async function setup(t, { cap = 2, slow = 0, command, suspend = false, fail = false } = {}) {
  const base = path.resolve('.scratch/pipeline/lane-n/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'http-'));
  const changes = { SCRANTON_PIPELINE_COMMAND: command ?? JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(dir, 'workspaces'), FAKE_PIPELINE_SLOW_MS: String(slow), FAKE_PIPELINE_SUSPEND: suspend ? '1' : '0', FAKE_PIPELINE_FAIL: fail ? '1' : '0', PYTHONPYCACHEPREFIX: path.join(dir, 'bytecode'), TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp') };
  fs.mkdirSync(changes.TEMP);
  const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]])); Object.assign(process.env, changes);
  const dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'source'); fs.mkdirSync(workspace);
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Pipeline', workspace });
  const chats = [registry.createChat(project.id, { engine: 'pipeline' }), registry.createChat(project.id, { engine: 'pipeline' }), registry.createChat(project.id)];
  const auth = { listAccounts: () => [{ id: 'openai', label: 'OpenAI', kind: 'api_key', status: 'signed_in' }, { id: 'anthropic', label: 'Subscription', kind: 'oauth', status: 'signed_in' }], listModels: async () => ({ providers: [{ id: 'openai', models: [{ id: 'test-model', name: 'Test model' }] }] }), resolveDockerCredential: async () => ({ name: 'OPENAI_API_KEY', value: key }), close() {} };
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, maxConcurrentRuns: cap, control: { auth } });
  t.after(async () => { await server.close(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(dir, { recursive: true, force: true }); });
  const responses = [];
  async function req(url, body) {
    const r = await fetch(server.url + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); responses.push(text); return { code: r.status, value: JSON.parse(text) };
  }
  const route = (i = 0) => `/api/projects/${project.id}/chats/${chats[i].id}`;
  const runRoute = (id, i = 0) => `${route(i)}/pipeline/runs/${id}`;
  async function wait(id, status, i = 0) {
    const deadline = Date.now() + 30000; let r;
    do { r = await req(runRoute(id, i)); if (r.code === 200 && r.value.status?.status === status && !r.value.live) return r.value; await sleep(30); } while (Date.now() < deadline);
    assert.fail(`Pipeline did not reach ${status}: ${JSON.stringify(r)}`);
  }
  const start = async (body = { task: 'Demo', demo: true }, i = 0) => { const r = await req(`${route(i)}/pipeline/runs`, body); assert.equal(r.code, 202, JSON.stringify(r)); return r.value.runId; };
  const decide = (id, s, decision = 'approve') => req(`${runRoute(id)}/decision`, { gate: s.pending.gate, digest: s.pending.digest, decision });
  return { dir, dataDir, registry, project, chats, server, responses, req, route, runRoute, wait, start, decide };
}

test('Pipeline HTTP happy path, exact gates, summaries, artifacts, incremental events and removal', async (t) => {
  const f = await setup(t);
  const capability = (await f.req('/api/pipeline')).value;
  assert.equal(capability.available, true); assert.equal(capability.source, 'env'); assert.equal(capability.models[1].supported, false);
  const detect = await f.req(`/api/projects/${f.project.id}/pipeline/detect`, {});
  assert.equal(detect.code, 200); assert.equal(detect.value.checks[0].command, 'node --test "a b.js"'); assert.equal(detect.value.setup[0].command, 'npm ci'); assert.equal(detect.value.setup[0].network, true);
  assert.equal((await f.req(`/api/projects/${f.project.id}/chats`, { engine: 'bogus' })).code, 400);
  assert.equal((await f.req(`/api/projects/${f.project.id}/chats`, { title: 'New', engine: 'pipeline' })).value.chat.engine, 'pipeline');
  const id = await f.start(), first = await f.wait(id, 'awaiting_approval');
  assert.equal(first.status.pending.gate, 'plan'); assert.equal(first.plan.steps.length, 1);
  assert.equal((await f.req('/api/control')).value.pendingHuman, 1);
  assert.equal((await f.req('/api/projects')).value.projects[0].chats[0].status, 'needs_human');
  assert.equal((await f.req(`${f.route()}/pipeline/runs`, { task: 'again', demo: true })).code, 409);
  assert.equal((await f.req(`${f.runRoute(id)}/decision`, { gate: 'plan', decision: 'approve', digest: '0'.repeat(64) })).code, 409);
  assert.equal((await f.req(`${f.runRoute(id)}/decision`, { gate: 'delivery', decision: 'approve', digest: first.status.pending.digest })).code, 409);
  assert.equal((await f.req(`/api/projects/${f.project.id}/chats/remove`, { id: f.chats[0].id })).code, 409);
  assert.equal((await f.req('/api/projects/remove', { id: f.project.id, deleteHistory: true })).code, 409);
  assert.equal((await f.req(`${f.runRoute(id)}/decision`, { gate: 'plan', digest: first.status.pending.digest, decision: 'approve', comment: '-x' })).code, 202);
  const second = await f.wait(id, 'awaiting_approval'); assert.equal(second.status.pending.gate, 'delivery');
  assert.equal(second.review.verdict, 'approve');
  assert.equal((await f.req(`${f.runRoute(id)}?after=${first.lastSeq}`)).value.events.every((e) => e.seq > first.lastSeq), true);
  assert.equal((await f.req(`${f.runRoute(id)}?after=no`)).code, 400);
  assert.match((await f.req(`${f.runRoute(id)}/artifacts/diff`)).value.content, /fixed/);
  assert.equal((await f.req(`${f.runRoute(id)}/artifacts/config.json`)).code, 404);
  assert.equal((await f.req(`${f.runRoute(id)}/artifacts/%2e%2e%2fconfig.json`)).code, 404);
  assert.equal((await f.decide(id, second.status)).code, 202);
  const done = await f.wait(id, 'succeeded'); assert.equal(done.status.delivery.applied, true);
  assert.equal((await f.req('/api/control')).value.pendingHuman, 0);
  assert.equal((await f.req('/api/projects')).value.projects[0].chats[0].status, 'done');
  assert.match((await f.req(`${f.runRoute(id)}/artifacts/report`)).value.content, /succeeded/);
  assert.equal((await f.req(`/api/projects/${f.project.id}/chats/remove`, { id: f.chats[0].id })).code, 200);
  assert.equal(fs.existsSync(path.join(f.dir, 'workspaces', id)), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline')), false);
});

test('Pipeline wrong-engine guards and nested validation fail before execution', async (t) => {
  const f = await setup(t);
  for (const suffix of ['/runs', '/chat', '/hitl', '/stop', '/release', '/runs/stop', '/runs/release']) {
    const r = await f.req(f.route() + suffix, {}); assert.equal(r.code, 409); assert.equal(r.value.error, 'This chat uses the pipeline engine');
  }
  assert.equal((await f.req(f.route(2) + '/pipeline')).value.error, 'This chat does not use the pipeline engine');
  assert.equal((await f.req(f.route(2) + '/pipeline/runs', { task: 'demo', demo: true })).code, 409);
  for (const body of [{ task: '', demo: true }, { task: 'x', nope: 1 }, { task: 'x', sandbox: { mode: 'host', trustHost: false } }, { task: 'x', sandbox: { mode: 'docker', nope: true } }, { task: 'x', checks: [{ id: 't', kind: 'test', command: 'node', key }] }, { task: 'x', checks: [{ id: 't', kind: 'invalid', command: 'node' }] }]) assert.ok([400, 409].includes((await f.req(f.route() + '/pipeline/runs', body)).code));
});

test('Pipeline concurrency cap counts live invocations, not approval gates; cancel running and waiting', async (t) => {
  const f = await setup(t, { cap: 1, slow: 500 });
  const id = await f.start();
  assert.equal((await f.req(f.route(1) + '/pipeline/runs', { task: 'two', demo: true })).code, 429);
  assert.equal((await f.req('/api/control')).value.running, 1);
  await sleep(100);
  assert.equal((await f.req(f.runRoute(id) + '/cancel', {})).code, 202);
  await f.wait(id, 'cancelled');
  const other = await f.start(undefined, 1); await f.wait(other, 'awaiting_approval', 1);
  const next = await f.start(); await f.wait(next, 'awaiting_approval');
  assert.equal((await f.req(f.runRoute(next) + '/cancel', {})).code, 202); await f.wait(next, 'cancelled');
  assert.equal((await f.req(f.runRoute(other, 1) + '/cancel', {})).code, 202); await f.wait(other, 'cancelled', 1);
});

test('Pipeline credentials only reach environment; config, events and HTTP never contain the literal key', async (t) => {
  const f = await setup(t);
  const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'openai', model: 'test-model' }]));
  const id = await f.start({ task: 'Fix safely', models, sandbox: { mode: 'host', trustHost: true }, checks: [{ id: 'test', kind: 'test', command: 'node --test "test file.js"' }], setup: [{ id: 'setup', command: 'node -v', network: false }], review: false });
  const gate = await f.wait(id, 'awaiting_approval');
  const base = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline');
  const cfg = fs.readFileSync(path.join(base, 'requests', id + '.json'), 'utf8');
  assert.equal(cfg.includes(key), false); assert.match(cfg, /SCRANTON_PIPELINE_KEY_PLANNER/);
  assert.deepEqual(JSON.parse(cfg).checks[0].argv, ['node', '--test', 'test file.js']);
  assert.equal(fs.readFileSync(path.join(base, 'runs', id, 'config.json'), 'utf8').includes(key), false);
  assert.equal(fs.readFileSync(path.join(base, 'runs', id, 'events.jsonl'), 'utf8').includes(key), false);
  await f.req(f.runRoute(id) + '/artifacts/plan'); await f.req('/api/pipeline');
  assert.equal(f.responses.join('\n').includes(key), false);
  assert.equal((await f.decide(id, gate.status, 'reject')).code, 202); await f.wait(id, 'rejected');
});

test('Pipeline suspended resumes; stale running normalizes through status; project history removes workspaces', async (t) => {
  const f = await setup(t, { suspend: true });
  const id = await f.start(); await f.wait(id, 'suspended');
  const statusFile = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/runs', id, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusFile)); status.status = 'running'; fs.writeFileSync(statusFile, JSON.stringify(status));
  assert.equal((await f.req(f.runRoute(id))).value.status.status, 'suspended');
  process.env.FAKE_PIPELINE_SUSPEND = '0';
  assert.equal((await f.req(f.runRoute(id) + '/resume', {})).code, 202);
  const gate = await f.wait(id, 'awaiting_approval');
  assert.equal((await f.req(f.runRoute(id) + '/resume', {})).code, 409);
  await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
  assert.equal((await f.req('/api/projects/remove', { id: f.project.id, deleteHistory: true })).code, 200);
  assert.equal(fs.existsSync(path.join(f.dir, 'workspaces', id)), false);
});

test('Pipeline unavailable returns capability reason and start 503; optional routes still authorize', async (t) => {
  const f = await setup(t, { command: JSON.stringify([path.resolve('.scratch/pipeline/lane-n/no-python.exe')]) });
  const cap = (await f.req('/api/pipeline')).value;
  assert.equal(cap.available, false); assert.ok(cap.reason);
  assert.equal((await f.req(f.route() + '/pipeline/runs', { task: 'demo', demo: true })).code, 503);
  assert.equal((await fetch(f.server.url + '/api/pipeline')).status, 403);
});

test('Pipeline server close ends parent guard and waits for a live child to suspend', async (t) => {
  const f = await setup(t, { slow: 60000 }); const id = await f.start();
  let status;
  for (let i = 0; i < 100; i++) { const r = await f.req(f.runRoute(id)); if (r.code === 200) { status = r.value.status; break; } await sleep(20); }
  assert.equal(status.status, 'running');
  await f.server.close();
  const file = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/runs', id, 'status.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'suspended');
  assert.throws(() => process.kill(status.pid, 0));
});

test('real Pipeline demo over HTTP traverses both gates', async (t) => {
  const python = path.resolve('.scratch/pipeline/venv/Scripts/python.exe');
  if (!fs.existsSync(python) || !fs.existsSync('engine/src/scranton_pipeline/__main__.py')) { t.skip('Development Python runtime or Pipeline engine entrypoint is not present yet'); return; }
  const f = await setup(t, { command: JSON.stringify([python, '-m', 'scranton_pipeline']) });
  const id = await f.start(); const plan = await f.wait(id, 'awaiting_approval');
  assert.equal(plan.status.pending.gate, 'plan'); assert.equal((await f.decide(id, plan.status)).code, 202);
  const delivery = await f.wait(id, 'awaiting_approval'); assert.equal(delivery.status.pending.gate, 'delivery');
  assert.equal((await f.decide(id, delivery.status)).code, 202); await f.wait(id, 'succeeded');
  assert.match((await f.req(f.runRoute(id) + '/artifacts/report')).value.content, /succeeded/i);
});

test('Pipeline failure reaches terminal status; event pages and named artifacts stay bounded', async (t) => {
  const f = await setup(t, { fail: true }); const id = await f.start();
  const failed = await f.wait(id, 'failed'); assert.equal(failed.status.failure.code, 'fake_failure');
  assert.equal((await f.req('/api/projects')).value.projects[0].chats[0].status, 'failed');
  assert.match(failed.status.checks[0].output_tail, /Unsafe shim/);
  assert.equal((await f.req(f.runRoute(id) + '/artifacts/diff')).value.content, 'partial green diff');
  const runDir = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/runs', id);
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), Array.from({ length: 510 }, (_, i) => JSON.stringify({ seq: i + 1, run_id: id, type: 'warning', data: {} })).join('\n') + '\n{"seq":511');
  const page = (await f.req(f.runRoute(id))).value;
  assert.equal(page.events.length, 500); assert.equal(page.lastSeq, 500);
  const next = (await f.req(f.runRoute(id) + '?after=500')).value;
  assert.equal(next.events.length, 10); assert.equal(next.lastSeq, 510);
  fs.writeFileSync(path.join(runDir, 'delivery/report.md'), 'x'.repeat(1024 * 1024 + 10));
  const report = (await f.req(f.runRoute(id) + '/artifacts/report')).value;
  assert.equal(report.content.length, 1024 * 1024); assert.equal(report.truncated, true);
  for (const suffix of ['/artifacts/..%5cconfig.json', '/artifacts/%2fconfig.json', '/artifacts/report-json/extra']) assert.equal((await f.req(f.runRoute(id) + suffix)).code, 404);
  process.env.FAKE_PIPELINE_FAIL = '0';
  const nextId = await f.start(); assert.notEqual(nextId, id); const gate = await f.wait(nextId, 'awaiting_approval');
  await f.decide(nextId, gate.status, 'reject'); await f.wait(nextId, 'rejected');
});

test('Pipeline launch errors survive restart without a run directory and later success clears invocation errors', async (t) => {
  const f = await setup(t);
  const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'openai', model: 'test-model' }]));
  fs.rmSync(f.project.workspace, { recursive: true });
  const id = await f.start({ task: 'Deleted source', models });
  let r;
  for (let i = 0; i < 200; i++) { r = await f.req(f.runRoute(id)); if (r.value.launchError) break; await sleep(20); }
  assert.equal(r.code, 200); assert.equal(r.value.status, null); assert.equal(r.value.live, false);
  assert.equal(r.value.launchError.code, 2); assert.match(r.value.launchError.message, /Unsafe shim arguments/);
  const base = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'requests', id + '.error.json'))), r.value.launchError);
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const fresh = createPipelineSupervisor({ dataDir: f.dataDir });
  assert.equal((await fresh.inspect(f.chats[0], id)).launchError.code, 2);
  assert.equal(fresh.list(f.chats[0]).runs[0].status, 'failed');
  const next = await f.start(), gate = await f.wait(next, 'awaiting_approval');
  const old = process.env.FAKE_PIPELINE_LAUNCH_ERROR; process.env.FAKE_PIPELINE_LAUNCH_ERROR = 'resume';
  try {
    await f.decide(next, gate.status);
    for (let i = 0; i < 200; i++) { r = await f.req(f.runRoute(next)); if (r.value.launchError) break; await sleep(20); }
    assert.equal(r.value.launchError.code, 2); assert.equal(r.value.status.status, 'awaiting_approval');
  } finally { if (old === undefined) delete process.env.FAKE_PIPELINE_LAUNCH_ERROR; else process.env.FAKE_PIPELINE_LAUNCH_ERROR = old; }
  await f.decide(next, gate.status, 'reject');
  assert.equal((await f.wait(next, 'rejected')).launchError, null);
  assert.equal(fs.existsSync(path.join(base, 'requests', next + '.error.json')), false);
});

test('Pipeline untrusted diff paths and run IDs cannot escape run or workspace directories', async (t) => {
  const f = await setup(t, { fail: true }), id = await f.start(); await f.wait(id, 'failed');
  const base = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline');
  const file = path.join(base, 'runs', id, 'status.json'), status = JSON.parse(fs.readFileSync(file));
  const victim = path.join(f.dir, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'secret'), 'keep');
  status.artifacts.diff = path.join(victim, 'secret'); status.run_id = '..\\victim'; fs.writeFileSync(file, JSON.stringify(status));
  assert.equal((await f.req(f.runRoute(id) + '/artifacts/diff')).code, 403);
  const link = path.join(base, 'runs', id, 'escape'); fs.symlinkSync(victim, link, 'junction');
  status.artifacts.diff = path.join(link, 'secret'); fs.writeFileSync(file, JSON.stringify(status));
  assert.equal((await f.req(f.runRoute(id) + '/artifacts/diff')).code, 403);
  // Plant a matching malicious launch record too: removal must use the directory ID, not status content.
  fs.writeFileSync(path.join(base, 'victim.json.launch.json'), JSON.stringify({ workspaceRoot: path.join(f.dir, 'workspaces') }));
  assert.equal((await f.req(`/api/projects/${f.project.id}/chats/remove`, { id: f.chats[0].id })).code, 200);
  assert.equal(fs.readFileSync(path.join(victim, 'secret'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(f.dir, 'workspaces', id)), false);
});

test('Pipeline command validation names exact row and field using the engine ID rule', async (t) => {
  const f = await setup(t);
  const valid = { id: 'Test_1-ok', kind: 'test', command: 'node' };
  for (const [field, value] of [['id', 'test.id'], ['kind', 'bad'], ['command', 'node "'], ['timeoutSec', 0], ['required', 'yes'], ['scope', 'bad'], ['unknown', 1]]) {
    const r = await f.req(f.route() + '/pipeline/runs', { task: 'x', checks: [valid, { ...valid, id: 'other' }, { ...valid, id: 'last', [field]: value }] });
    assert.equal(r.code, 400); assert.match(r.value.error, new RegExp(`^checks\\[2\\]\\.${field}:`));
  }
  const r = await f.req(f.route() + '/pipeline/runs', { task: 'x', setup: [{ id: 'bad.id', command: 'npm ci' }] });
  assert.equal(r.code, 400); assert.match(r.value.error, /^setup\[0\]\.id:/);
});
