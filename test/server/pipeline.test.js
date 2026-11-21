import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRegistry } from '../../src/core/projects.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const key = 'test-pipeline-key-never-expose-79cc48';
async function setup(t, { cap = 2, slow = 0, command, suspend = false, fail = false, env = {} } = {}) {
  const base = path.resolve('.scratch/pipeline/chat-node/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'http-'));
  const changes = { SCRANTON_PIPELINE_COMMAND: command ?? JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(dir, 'workspaces'), FAKE_PIPELINE_SLOW_MS: String(slow), FAKE_PIPELINE_SUSPEND: suspend ? '1' : '0', FAKE_PIPELINE_FAIL: fail ? '1' : '0', PYTHONPYCACHEPREFIX: path.join(dir, 'bytecode'), TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp'), ...env };
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

const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'openai', model: 'test-model' }]));
const hostRun = { task: 'Feature fixture', models, sandbox: { mode: 'host', trustHost: true } };
async function waitBuild(f, state) {
  let sandbox;
  for (let i = 0; i < 200; i++) {
    sandbox = (await f.req('/api/pipeline')).value.sandbox;
    if (sandbox.build.state === state) return sandbox;
    await sleep(20);
  }
  assert.fail(`Build did not reach ${state}: ${JSON.stringify(sandbox)}`);
}

test('Pipeline replans and parallelSteps validate named fields and generate exact config defaults and bounds', async (t) => {
  const f = await setup(t);
  for (const [field, bad] of [['replans', [-1, 4, 1.5, '1', null, true, {}, []]], ['parallelSteps', [0, 5, 1.5, '2', null, false, {}, []]]]) {
    for (const value of bad) {
      const r = await f.req(f.route() + '/pipeline/runs', { task: 'x', demo: true, [field]: value });
      assert.equal(r.code, 400); assert.match(r.value.error, new RegExp(`^${field}:`));
    }
  }
  for (const values of [{}, { replans: 0, parallelSteps: 1 }, { replans: 3, parallelSteps: 4 }]) {
    const id = await f.start({ ...hostRun, ...values }), gate = await f.wait(id, 'awaiting_approval');
    const cfg = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/requests', id + '.json')));
    assert.deepEqual(cfg.limits, { max_replans: values.replans ?? 1 });
    assert.deepEqual(cfg.execution, { max_parallel_steps: values.parallelSteps ?? 1 });
    await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
  }
});

test('Pipeline sandbox capability handles daemon absent, image missing and older engines without 500', async (t) => {
  for (const env of [{}, { FAKE_PIPELINE_DOCKER_ABSENT: '1' }, { FAKE_PIPELINE_IMAGE_MISSING: '1' }, { FAKE_PIPELINE_OLD_ENGINE: '1' }]) await t.test(JSON.stringify(env), async (t) => {
    const f = await setup(t, { env }), r = await f.req('/api/pipeline'), s = r.value.sandbox;
    assert.equal(r.code, 200); assert.equal(r.value.available, true);
    assert.deepEqual(s.build, { state: 'idle', startedAt: null, finishedAt: null, tail: '' });
    const available = !env.FAKE_PIPELINE_DOCKER_ABSENT && !env.FAKE_PIPELINE_OLD_ENGINE;
    assert.equal(s.docker.available, available); assert.equal(s.image.present, available && !env.FAKE_PIPELINE_IMAGE_MISSING);
    assert.equal(s.docker.version, available ? 'fake-docker-1' : null);
    if (env.FAKE_PIPELINE_OLD_ENGINE) assert.match(s.docker.reason, /upgrade/);
    else { assert.equal(s.dockerImage, 'scranton-pipeline-sandbox:fake-1'); assert.equal(s.image.name, s.dockerImage); }
    if (!available) { assert.ok(s.docker.reason); assert.equal((await f.req('/api/pipeline/sandbox/build', {})).code, 503); }
  });
});

test('Pipeline Docker runs re-probe cached capability and refuse missing daemon or named image up front', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_DOCKER_ABSENT: '0', FAKE_PIPELINE_IMAGE_MISSING: '0' } });
  assert.equal((await f.req('/api/pipeline')).value.sandbox.image.present, true);
  process.env.FAKE_PIPELINE_IMAGE_MISSING = '1';
  const missing = await f.req(f.route() + '/pipeline/runs', { task: 'x', models, sandbox: { mode: 'docker', image: 'custom:image' } });
  assert.equal(missing.code, 409); assert.match(missing.value.error, /image is missing: custom:image/);
  process.env.FAKE_PIPELINE_DOCKER_ABSENT = '1';
  const daemon = await f.req(f.route() + '/pipeline/runs', { task: 'x', models, sandbox: { mode: 'docker' } });
  assert.equal(daemon.code, 409); assert.match(daemon.value.error, /Docker daemon/);
  assert.equal((await f.req(f.route() + '/pipeline')).value.runs.length, 0);
  process.env.FAKE_PIPELINE_DOCKER_ABSENT = '0'; process.env.FAKE_PIPELINE_IMAGE_MISSING = '0';
  const id = await f.start({ task: 'Docker fake only', models, sandbox: { mode: 'docker' } }), gate = await f.wait(id, 'awaiting_approval');
  const cfg = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/requests', id + '.json')));
  assert.equal(cfg.sandbox.docker.image, 'scranton-pipeline-sandbox:fake-1');
  await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
});

test('Pipeline sandbox build authorizes, validates, serializes, bounds and redacts output, then succeeds', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_BUILD_SLOW_MS: '800', FAKE_PIPELINE_BUILD_OUTPUT: 'x'.repeat(9000) + '\npassword=private-value Bearer private-bearer sk-fakecredential123\n' + key, OPENAI_API_KEY: key } });
  assert.equal((await fetch(f.server.url + '/api/pipeline/sandbox/build', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await f.req('/api/pipeline/sandbox/build', { image: 'other' })).code, 400);
  const wrongOrigin = await fetch(f.server.url + '/api/pipeline/sandbox/build', { method: 'POST', headers: { 'X-Scranton-Client': '1', Origin: 'https://untrusted.test', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrongOrigin.status, 403);
  const malformed = await fetch(f.server.url + '/api/pipeline/sandbox/build', { method: 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const pair = await Promise.all([f.req('/api/pipeline/sandbox/build', {}), f.req('/api/pipeline/sandbox/build', {})]);
  assert.deepEqual(pair.map((r) => r.code).sort(), [202, 409]);
  const running = (await f.req('/api/pipeline')).value.sandbox.build;
  assert.equal(running.state, 'running'); assert.ok(running.startedAt); assert.equal(running.finishedAt, null);
  const done = (await waitBuild(f, 'succeeded')).build;
  assert.ok(done.finishedAt); assert.ok(Buffer.byteLength(done.tail) <= 8192); assert.match(done.tail, /built/);
  for (const secret of [key, 'private-value', 'private-bearer', 'sk-fakecredential123']) assert.equal(f.responses.join('\n').includes(secret), false);
  assert.match(done.tail, /REDACTED/);
});

test('Pipeline sandbox failed builds retain final diagnostics and permit retry', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_BUILD_FAIL: '1' } });
  assert.equal((await f.req('/api/pipeline/sandbox/build', {})).code, 202);
  const failed = (await waitBuild(f, 'failed')).build;
  assert.match(failed.tail, /Fake build failed/); assert.ok(failed.finishedAt);
  assert.equal((await f.req('/api/pipeline/sandbox/build', {})).code, 202);
  await waitBuild(f, 'failed');
});

test('Pipeline server close kills the sandbox build child', async (t) => {
  const base = path.resolve('.scratch/pipeline/chat-node/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'build-')), file = path.join(dir, 'build.pid');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = await setup(t, { env: { FAKE_PIPELINE_BUILD_SLOW_MS: '60000', FAKE_PIPELINE_BUILD_PID_FILE: file } });
  assert.equal((await f.req('/api/pipeline/sandbox/build', {})).code, 202);
  for (let i = 0; i < 200 && !fs.existsSync(file); i++) await sleep(20);
  const pid = Number(fs.readFileSync(file, 'utf8')); fs.rmSync(file);
  await f.server.close(); assert.throws(() => process.kill(pid, 0));
});

test('Pipeline revised plan gates use the new pending digest and preserve replan events and fields', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_REPLAN: '1' } });
  const id = await f.start({ ...hostRun, replans: 1, approvals: { plan: 'auto_low_risk' } }), first = await f.wait(id, 'awaiting_approval');
  assert.equal(first.status.progress.plan_revision, 0); assert.equal(first.status.progress.replans_left, 1);
  await f.decide(id, first.status);
  const second = await f.wait(id, 'awaiting_approval');
  assert.equal(second.status.pending.gate, 'plan'); assert.equal(second.status.pending.revision, 1);
  assert.equal(second.status.pending.replan_reason, 'step_blocked: Fake step blocked'); assert.deepEqual(second.status.pending.risk_flags, ['replan']);
  assert.equal(second.status.progress.plan_revision, 1); assert.equal(second.status.progress.replans_left, 0);
  assert.notEqual(first.status.pending.digest, second.status.pending.digest);
  assert.equal((await f.decide(id, first.status)).code, 409);
  assert.deepEqual(second.events.filter((e) => ['replan_requested', 'replanned'].includes(e.type)).map((e) => e.data), [{ code: 'step_blocked', message: 'Fake step blocked', scope: 's1' }, { revision: 1 }]);
  await f.decide(id, second.status);
  const delivery = await f.wait(id, 'awaiting_approval'); assert.equal(delivery.status.pending.gate, 'delivery');
  await f.decide(id, delivery.status); await f.wait(id, 'succeeded');
  const off = await f.start({ ...hostRun, replans: 0 }), gate = await f.wait(off, 'awaiting_approval');
  await f.decide(off, gate.status); const failed = await f.wait(off, 'failed');
  assert.equal(failed.events.some((e) => e.type === 'replanned'), false);
});

test('Pipeline parallel lane snapshots and additive wave events pass through without filtering', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_PARALLEL: '1', FAKE_PIPELINE_LANE_MS: '400' } });
  const id = await f.start({ ...hostRun, parallelSteps: 2 }), gate = await f.wait(id, 'awaiting_approval');
  assert.equal(gate.plan.steps.length, 2); await f.decide(id, gate.status);
  const seen = new Set(); let done;
  for (let i = 0; i < 200; i++) {
    const r = await f.req(f.runRoute(id));
    for (const lane of r.value.status.progress.lanes) { assert.equal(r.value.status.phase, 'implement'); seen.add(lane.state); assert.deepEqual(Object.keys(lane), ['step_id', 'title', 'state', 'attempt']); }
    if (!r.value.live && r.value.status.pending?.gate === 'delivery') { done = r.value; break; }
    await sleep(20);
  }
  assert.deepEqual([...seen], ['running', 'passed', 'merged']); assert.equal(done.status.progress.steps_done, 2); assert.deepEqual(done.status.progress.lanes, []);
  assert.deepEqual(done.events.filter((e) => /^(wave|lane)_/.test(e.type)).map((e) => [e.type, e.data]), [
    ['wave_started', { wave: 1, steps: ['s1', 's2'] }], ['lane_started', { lane: 's1' }], ['lane_started', { lane: 's2' }],
    ['lane_finished', { lane: 's1', status: 'passed' }], ['lane_finished', { lane: 's2', status: 'passed' }], ['wave_merged', { wave: 1, merged: ['s1', 's2'], failed: [] }]
  ]);
  await f.decide(id, done.status); await f.wait(id, 'succeeded');
  const sequential = await f.start(hostRun), first = await f.wait(sequential, 'awaiting_approval');
  await f.decide(sequential, first.status); const last = await f.wait(sequential, 'awaiting_approval');
  assert.equal(last.events.some((e) => e.type === 'wave_started'), false);
  await f.decide(sequential, last.status); await f.wait(sequential, 'succeeded');
});

test('Pipeline demoScenario validation names the field before launching', async (t) => {
  const f = await setup(t);
  for (const body of [
    ...['unknown', '', null, false, 1, {}, []].map((demoScenario) => ({ demo: true, demoScenario })),
    { demoScenario: 'basic' }, { demo: false, demoScenario: 'replan' }, { demoScenario: 'evidence' }, { demo: false, demoScenario: 'evidence' }
  ]) {
    const r = await f.req(f.route() + '/pipeline/runs', { task: 'Demo', ...body });
    assert.equal(r.code, 400); assert.match(r.value.error, /^demoScenario:/);
  }
  assert.deepEqual((await f.req(f.route() + '/pipeline')).value.runs, []);
});

test('Pipeline demos pass exact scenario and sandbox argv and retain scenarios across resumes', async (t) => {
  const f = await setup(t);
  for (const demoScenario of [undefined, 'basic', 'replan', 'parallel', 'evidence']) {
    for (const sandbox of [undefined, { mode: 'host' }, { mode: 'docker' }, { mode: 'docker', image: 'custom/demo:v2' }]) {
      const scenario = demoScenario ?? 'basic', mode = sandbox?.mode ?? 'host';
      const id = await f.start({ task: 'Ignored demo task', demo: true, demoScenario, sandbox, delivery: 'patch', models: null, checks: 'ignored', setup: 'ignored', approvals: null, review: 'ignored', replans: 0, parallelSteps: 1 });
      const first = await f.wait(id, 'awaiting_approval');
      const runRoot = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/runs');
      const image = mode === 'docker' ? sandbox.image ?? 'scranton-pipeline-sandbox:fake-1' : null;
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runRoot, id, 'argv.json'))), [
        'demo', '--run-root', runRoot, '--run-id', id, '--workspace-root', path.join(f.dir, 'workspaces'), '--delivery', 'patch',
        '--scenario', scenario, '--sandbox', mode, ...(image ? ['--image', image] : []), '--parent-guard'
      ]);
      assert.deepEqual(first.status.sandbox, { mode, isolated: mode === 'docker', image, isolation: mode === 'host' ? 'No OS isolation.' : 'Docker container with read-only root and no network for checks; shares the Docker VM kernel; workspace mounted read-write; setup commands with network can reach the internet and local services (including host.docker.internal).', setup_network: false });
      assert.equal(first.status.task, 'Fix the demo');
      assert.equal(first.plan.steps.length, scenario === 'parallel' ? 2 : 1);
      await f.decide(id, first.status);
      if (scenario === 'replan') {
        const revised = await f.wait(id, 'awaiting_approval');
        assert.equal(revised.status.pending.revision, 1);
        assert.ok(revised.events.some((e) => e.type === 'replanned'));
        await f.decide(id, revised.status);
      }
      const done = await f.wait(id, 'succeeded');
      assert.equal(done.events.some((e) => e.type === 'wave_started'), scenario === 'parallel');
      assert.equal(done.events.some((e) => e.type === 'replanned'), scenario === 'replan');
    }
  }
});

test('Pipeline Docker demos freshly check daemon and image while host demos need no trust', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_IMAGE_MISSING: '0', FAKE_PIPELINE_DOCKER_ABSENT: '0' } });
  assert.equal((await f.req('/api/pipeline')).value.sandbox.image.present, true);
  process.env.FAKE_PIPELINE_IMAGE_MISSING = '1';
  for (const image of [undefined, 'missing/demo:v2']) {
    const r = await f.req(f.route() + '/pipeline/runs', { task: 'Demo', demo: true, sandbox: { mode: 'docker', image } });
    assert.equal(r.code, 409); assert.match(r.value.error, /Docker image is missing/);
    assert.ok(r.value.error.includes(image ?? 'scranton-pipeline-sandbox:fake-1'));
  }
  process.env.FAKE_PIPELINE_DOCKER_ABSENT = '1';
  const r = await f.req(f.route() + '/pipeline/runs', { task: 'Demo', demo: true, sandbox: { mode: 'docker' } });
  assert.equal(r.code, 409); assert.match(r.value.error, /Docker daemon/);
  assert.deepEqual((await f.req(f.route() + '/pipeline')).value.runs, []);
  const id = await f.start({ task: 'Demo', demo: true, sandbox: { mode: 'host', trustHost: false } });
  const gate = await f.wait(id, 'awaiting_approval');
  assert.equal(gate.status.sandbox.mode, 'host');
  await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
});

test('Pipeline invalid models return 400 before any Docker preflight', async (t) => {
  const calls = path.resolve('.scratch/pipeline/n3/invalid-model-probes');
  fs.rmSync(calls, { force: true }); t.after(() => fs.rmSync(calls, { force: true }));
  const f = await setup(t, { env: { FAKE_PIPELINE_DOCKER_ABSENT: '1', FAKE_PIPELINE_PROBE_FILE: calls } });
  for (const models of [null, [], {}, { planner: { provider: 'openai', model: 'unknown' } }, { ...hostRun.models, reviewer: { provider: 'openai', model: '' } }]) {
    assert.equal((await f.req(f.route() + '/pipeline/runs', { task: 'Invalid models', models })).code, 400);
  }
  assert.equal(fs.existsSync(calls), false, 'invalid models must not invoke sandbox check');
});

for (const scenario of ['replan', 'parallel', 'evidence']) test(`real Pipeline ${scenario} demo over HTTP traverses every gate`, async (t) => {
  const python = path.resolve('.scratch/pipeline/venv/Scripts/python.exe');
  if (!fs.existsSync(python) || !fs.existsSync('engine/src/scranton_pipeline/__main__.py')) { t.skip('Development Python runtime or Pipeline engine entrypoint is not present yet'); return; }
  const f = await setup(t, { command: JSON.stringify([python, '-m', 'scranton_pipeline']) });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { pipelineChildEnv } = await import('../../src/core/pipeline-command.js');
  let text;
  try { text = (await promisify(execFile)(python, ['-m', 'scranton_pipeline', 'demo', '--help'], { env: pipelineChildEnv(), timeout: 15000, windowsHide: true })).stdout; }
  catch (e) { t.skip('Engine demo help is not runnable yet: ' + e.message); return; }
  if (!text.includes('--scenario')) { t.skip('Engine demo --help does not list --scenario yet'); return; }
  if (scenario === 'evidence' && !/\{[^}]*\bevidence\b[^}]*\}/.test(text)) { t.skip('Engine demo --help does not list evidence in scenario choices yet'); return; }
  const id = await f.start({ task: 'Scenario demo', demo: true, demoScenario: scenario });
  const gates = [], deadline = Date.now() + 60000; let last;
  while (Date.now() < deadline) {
    const r = await f.req(f.runRoute(id)); last = r;
    if (r.code === 404 || r.value.live) { await sleep(50); continue; }
    assert.equal(r.code, 200);
    const view = r.value, status = view.status;
    if (view.launchError || ['failed', 'suspended'].includes(status?.status)) assert.fail(`Engine ${scenario} scenario failed: ${JSON.stringify(view)}`);
    if (status?.status === 'awaiting_approval') {
      gates.push(status.pending.gate);
      if (scenario === 'evidence' && status.pending.gate === 'delivery') {
        assert.ok(status.pending.risk_flags.includes('criteria_not_demonstrated'));
        assert.ok(!status.pending.risk_flags.includes('grounding_violations'));
      }
      if (scenario === 'replan' && gates.length === 2) {
        assert.equal(status.pending.revision, 1); assert.equal(typeof status.pending.replan_reason, 'string'); assert.ok(status.pending.risk_flags.includes('replan'));
      }
      assert.equal((await f.decide(id, status)).code, 202); continue;
    }
    if (status?.status === 'succeeded') {
      assert.deepEqual(gates, scenario === 'replan' ? ['plan', 'plan', 'delivery'] : ['plan', 'delivery']);
      assert.deepEqual(status.sandbox, { mode: 'host', isolated: false, image: null, isolation: 'No OS isolation.', setup_network: false });
      if (scenario === 'parallel') assert.equal(view.events.find((e) => e.type === 'wave_started')?.data.wave, 1);
      else if (scenario === 'replan') assert.ok(view.events.some((e) => e.type === 'replanned'));
      else {
        assert.deepEqual(status.grounding.violations, { unseen_target: 1, false_absence: 1 });
        assert.deepEqual(status.grounding.criteria.map((c) => c.state), ['demonstrated', 'met_not_demonstrated']);
      }
      const grounding = view.events.filter((e) => e.type === 'grounding');
      t.diagnostic(`Real ${scenario} grounding scopes: ${JSON.stringify(grounding.map((e) => [e.data.role, e.data.scope]))}`);
      assert.ok(grounding.length > 0, 'finished run must contain grounding events');
      const scopes = { planner: /^plan:r\d+$/, reviewer: /^review:\d+$/, implementer: /^(step:[^\s]+|int:\d+)$/ };
      for (const { data } of grounding) {
        assert.ok(Object.hasOwn(scopes, data.role), `Unknown grounding role: ${data.role}`);
        assert.match(data.scope, /^(plan:r\d+|review:\d+|step:[^\s]+|int:\d+)$/);
        assert.match(data.scope, scopes[data.role], `${data.role} scope: ${data.scope}`);
      }
      for (const role of Object.keys(scopes)) assert.ok(grounding.some((e) => e.data.role === role), `Missing ${role} grounding`);
      if (scenario === 'replan') assert.deepEqual([...new Set(grounding.filter((e) => e.data.role === 'planner').map((e) => e.data.scope))], ['plan:r0', 'plan:r1']);
      return;
    }
    await sleep(50);
  }
  assert.fail(`Engine ${scenario} scenario did not finish: ${JSON.stringify(last)}`);
});

const pipelineDir = (f) => path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline');
const fakeGrounding = (scenario, mode = 'enforce', decided = true, outputs = scenario === 'parallel' ? 4 : scenario === 'replan' ? 5 : 3) => {
  const refuted = scenario === 'replan', violationRate = refuted ? 1 / outputs : 0;
  const answer = decided ? 1 : 0, trajectory = decided && refuted ? 0.5 : 1, unadjusted = (answer + trajectory) / 2;
  const round = (v) => Math.round(v * 10000) / 10000;
  return { mode, answer, trajectory, unadjusted, violation_rate: round(violationRate), adjusted: round(unadjusted * (1 - violationRate) ** 2), tier: refuted ? violationRate <= 0.1 ? 'minor' : violationRate <= 0.25 ? 'major' : 'failing' : 'clean', outputs, violations: refuted ? { false_absence: 1 } : {}, criteria: decided ? [{ id: 'c1', verified_by: 'checks', state: refuted ? 'met_not_demonstrated' : 'demonstrated', by: refuted ? 'none' : 'baseline', checks: ['test'] }] : [], probe: { status: 'not_needed' } };
};

test('Pipeline grounding and guidance reject wrong types and values with exact 400 bodies', async (t) => {
  const f = await setup(t);
  for (const demo of [false, true]) for (const [field, values, message] of [
    ['grounding', ['', 'off', 'ENFORCE', null, true, 1, {}, []], 'grounding: Expected enforce or observe'],
    ['guidance', ['', 'true', 'false', null, 0, 1, {}, []], 'guidance: Expected boolean']
  ]) for (const value of values) {
    assert.deepEqual(await f.req(f.route() + '/pipeline/runs', { ...hostRun, demo, [field]: value }), { code: 400, value: { error: message } });
  }
  assert.deepEqual((await f.req(f.route() + '/pipeline')).value.runs, []);
});

test('Pipeline grounding and guidance reach normal config and demo flags without absent defaults', async (t) => {
  const f = await setup(t);
  for (const demo of [false, true]) for (const settings of [{}, { grounding: 'enforce', guidance: false }, { grounding: 'observe', guidance: true }, { grounding: 'observe' }, { guidance: false }]) {
    const id = await f.start({ ...hostRun, demo, ...settings }), first = await f.wait(id, 'awaiting_approval');
    const runDir = path.join(pipelineDir(f), 'runs', id), cfg = JSON.parse(fs.readFileSync(path.join(runDir, 'config.json')));
    for (const candidate of demo ? [cfg] : [cfg, JSON.parse(fs.readFileSync(path.join(pipelineDir(f), 'requests', id + '.json')))]) {
      if (settings.grounding === undefined) assert.equal(Object.hasOwn(candidate, 'grounding'), false);
      else assert.deepEqual(candidate.grounding, { mode: settings.grounding });
      if (settings.guidance === undefined) assert.equal(Object.hasOwn(candidate, 'procedure'), false);
      else assert.deepEqual(candidate.procedure, { enabled: settings.guidance });
    }
    if (demo) {
      const argv = JSON.parse(fs.readFileSync(path.join(runDir, 'argv.json')));
      assert.equal(argv.includes('--grounding'), settings.grounding !== undefined);
      assert.equal(argv.includes('--guidance'), settings.guidance !== undefined);
      if (settings.grounding !== undefined) assert.equal(argv[argv.indexOf('--grounding') + 1], settings.grounding);
      if (settings.guidance !== undefined) assert.equal(argv[argv.indexOf('--guidance') + 1], String(settings.guidance));
    }
    await f.decide(id, first.status, 'reject'); await f.wait(id, 'rejected');
  }
});

test('Pipeline fake exposes zero-count grounding and disabled procedure before its first model call', async (t) => {
  const f = await setup(t, { slow: 800 }), id = await f.start();
  let view;
  for (let i = 0; i < 100; i++) { const r = await f.req(f.runRoute(id)); if (r.code === 200) { view = r.value; break; } await sleep(10); }
  assert.equal(view.status.status, 'running');
  assert.deepEqual(view.status.grounding, fakeGrounding('basic', 'enforce', false, 0));
  assert.deepEqual(view.status.procedure, { enabled: false, name: null, digest: null, situation: null });
  const first = await f.wait(id, 'awaiting_approval');
  await f.decide(id, first.status, 'reject'); await f.wait(id, 'rejected');
});

for (const scenario of ['basic', 'parallel', 'replan']) for (const mode of ['enforce', 'observe']) test(`Pipeline fake ${scenario} ${mode} grounding and procedure wire survives every HTTP gate`, async (t) => {
  const f = await setup(t), id = await f.start({ task: 'Grounded demo', demo: true, demoScenario: scenario, grounding: mode, guidance: true });
  const first = await f.wait(id, 'awaiting_approval');
  assert.deepEqual(first.status.grounding, fakeGrounding('basic', mode, false, 1));
  const procedure = { enabled: true, name: 'fake-guidance', digest: (await import('node:crypto')).createHash('sha256').update('fake-guidance').digest('hex'), situation: 'plan.start' };
  assert.deepEqual(first.status.procedure, procedure);
  assert.equal((await f.decide(id, first.status)).code, 202);
  if (scenario === 'replan') {
    const revised = await f.wait(id, 'awaiting_approval');
    assert.equal(revised.status.pending.gate, 'plan');
    assert.deepEqual(revised.status.grounding, { ...fakeGrounding('replan', mode, false, 3), trajectory: 0.5, unadjusted: 0.25, adjusted: 0.1111 });
    assert.deepEqual(revised.status.procedure, { ...procedure, situation: 'plan.replan' });
    const refutation = revised.events.find((e) => e.type === 'grounding' && e.data.violations.includes('false_absence'));
    assert.deepEqual(refutation.data, { role: 'implementer', scope: 'step:s1', accepted: mode === 'observe', violations: ['false_absence'], cited: 0, shown: 1 });
    assert.ok(refutation.seq < revised.events.find((e) => e.type === 'replanned').seq);
    assert.equal((await f.decide(id, revised.status)).code, 202);
  }
  const delivery = await f.wait(id, 'awaiting_approval'), expected = fakeGrounding(scenario, mode);
  assert.equal(delivery.status.pending.gate, 'delivery');
  assert.deepEqual(delivery.status.grounding, expected);
  assert.deepEqual(delivery.status.pending.grounding, expected);
  assert.deepEqual(delivery.status.pending.risk_flags, scenario === 'replan' ? ['criteria_not_demonstrated', ...(mode === 'observe' ? ['grounding_violations'] : [])] : []);
  assert.deepEqual(delivery.status.procedure, { ...procedure, situation: 'review.start' });
  const events = delivery.events, calls = events.filter((e) => e.type === 'llm_call'), grounding = events.filter((e) => e.type === 'grounding');
  assert.equal(calls.length, expected.outputs); assert.equal(grounding.length, calls.length);
  const expectedScopes = scenario === 'replan'
    ? [['planner', 'plan:r0'], ['implementer', 'step:s1'], ['planner', 'plan:r1'], ['implementer', 'step:r1-s1'], ['reviewer', 'review:0']]
    : scenario === 'parallel'
      ? [['planner', 'plan:r0'], ['implementer', 'step:s1'], ['implementer', 'step:s2'], ['reviewer', 'review:0']]
      : [['planner', 'plan:r0'], ['implementer', 'step:s1'], ['reviewer', 'review:0']];
  for (const type of ['grounding', 'procedure']) assert.deepEqual(events.filter((e) => e.type === type).map((e) => [e.data.role, e.data.scope]), expectedScopes, `${scenario} ${type} scopes`);
  assert.equal(events.filter((e) => e.type === 'procedure').length, calls.length);
  assert.deepEqual(events.filter((e) => e.type === 'procedure').map((e) => e.data), calls.map((e, i) => ({ role: e.data.role, scope: grounding[i].data.scope, situation: e.data.role === 'planner' ? i === 0 ? 'plan.start' : 'plan.replan' : e.data.role === 'implementer' ? 'implement.start' : 'review.start', matched: true })));
  assert.deepEqual(events.find((e) => e.type === 'criteria_decided').data, { states: { [expected.criteria[0].state]: 1 } });
  assert.deepEqual(events.find((e) => e.type === 'probe_finished').data, { status: 'not_needed', checks: [] });
  for (const type of ['criteria_decided', 'probe_finished']) assert.equal(events.find((e) => e.type === type).node, 'ground');
  assert.ok(events.find((e) => e.node === 'review').seq < events.find((e) => e.node === 'ground').seq);
  assert.ok(events.find((e) => e.node === 'ground').seq < events.find((e) => e.node === 'package').seq);
  if (scenario !== 'replan') assert.deepEqual(events.find((e) => e.type === 'absence_verified').data, { kind: 'missing_symbol', subject: 'genuinely_absent', files_searched: 1 });
  const runDir = path.join(pipelineDir(f), 'runs', id);
  assert.deepEqual(delivery.status, JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'))));
  assert.deepEqual(events, fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse));
  assert.deepEqual(grounding.map((e) => e.data), calls.map((e, i) => ({ role: e.data.role, scope: expectedScopes[i][1], accepted: mode === 'observe' || !(scenario === 'replan' && i === 1), violations: scenario === 'replan' && i === 1 ? ['false_absence'] : [], cited: e.data.role === 'reviewer' ? 1 : 0, shown: 1, ...(scenario === 'parallel' && e.data.role === 'implementer' ? { lane: `s${i}` } : {}) })));
  assert.deepEqual(delivery.status.pending, { gate: 'delivery', digest: delivery.status.pending.digest, path: path.join(runDir, 'delivery/candidate.diff'), files: [{ path: 'demo.txt', action: 'modify', added: 1, removed: 1 }], grounding: expected, risk_flags: scenario === 'replan' ? ['criteria_not_demonstrated', ...(mode === 'observe' ? ['grounding_violations'] : [])] : [] });
  assert.match(delivery.status.pending.digest, /^[a-f0-9]{64}$/);
  const statusFile = path.join(runDir, 'status.json'), saved = fs.readFileSync(statusFile);
  try {
    const groundStatus = { ...delivery.status, node: 'ground', phase: 'review' };
    fs.writeFileSync(statusFile, JSON.stringify(groundStatus));
    assert.deepEqual((await f.req(f.runRoute(id))).value.status, groundStatus);
  } finally { fs.writeFileSync(statusFile, saved); }
  assert.equal((await f.decide(id, delivery.status)).code, 202);
  const done = await f.wait(id, 'succeeded');
  assert.deepEqual(done.status.grounding, expected); assert.deepEqual(done.status.procedure, { ...procedure, situation: 'review.start' });
});

test('Pipeline evidence rejects observe before launching and accepts explicit enforce', async (t) => {
  const f = await setup(t);
  assert.deepEqual(await f.req(f.route() + '/pipeline/runs', { task: 'Evidence', demo: true, demoScenario: 'evidence', grounding: 'observe' }), { code: 400, value: { error: 'grounding: The evidence demo needs enforce' } });
  assert.deepEqual((await f.req(f.route() + '/pipeline')).value.runs, []);
  const id = await f.start({ task: 'Evidence', demo: true, demoScenario: 'evidence', grounding: 'enforce' });
  const first = await f.wait(id, 'awaiting_approval');
  const argv = JSON.parse(fs.readFileSync(path.join(pipelineDir(f), 'runs', id, 'argv.json')));
  assert.equal(argv[0], 'demo');
  assert.equal(argv[argv.indexOf('--scenario') + 1], 'evidence');
  assert.equal(argv[argv.indexOf('--grounding') + 1], 'enforce');
  await f.decide(id, first.status, 'reject'); await f.wait(id, 'rejected');
});

test('Pipeline fake evidence enforce grounding repairs survive both HTTP gates', async (t) => {
  const f = await setup(t), id = await f.start({ task: 'Evidence', demo: true, demoScenario: 'evidence', guidance: true });
  const first = await f.wait(id, 'awaiting_approval');
  assert.equal(first.status.pending.gate, 'plan');
  assert.deepEqual(first.plan.acceptance_criteria.map((c) => [c.id, c.checks]), [['c1', ['test']], ['c2', ['stable']]]);
  const planner = first.events.filter((e) => e.type === 'grounding');
  assert.deepEqual(planner.map((e) => e.data), [
    { role: 'planner', scope: 'plan:r0', accepted: false, violations: ['unseen_target'], cited: 0, shown: 1 },
    { role: 'planner', scope: 'plan:r0', accepted: true, violations: [], cited: 0, shown: 1 }
  ]);
  assert.ok(planner[1].seq < first.events.find((e) => e.type === 'gate_waiting').seq);
  assert.equal((await f.decide(id, first.status)).code, 202);
  const delivery = await f.wait(id, 'awaiting_approval');
  assert.equal(delivery.status.pending.gate, 'delivery');
  const expected = {
    mode: 'enforce', answer: 1, trajectory: 0.5417, unadjusted: 0.7708,
    violation_rate: 0.4, adjusted: 0.2775, tier: 'failing', outputs: 5,
    violations: { unseen_target: 1, false_absence: 1 },
    criteria: [
      { id: 'c1', verified_by: 'checks', state: 'demonstrated', by: 'baseline', checks: ['test'] },
      { id: 'c2', verified_by: 'checks', state: 'met_not_demonstrated', by: 'none', checks: ['stable'] }
    ], probe: { status: 'not_needed' }
  };
  assert.deepEqual(delivery.status.grounding, expected);
  assert.deepEqual(delivery.status.pending.grounding, expected);
  assert.deepEqual(delivery.status.pending.risk_flags, ['criteria_not_demonstrated']);
  const events = delivery.events, grounding = events.filter((e) => e.type === 'grounding');
  assert.equal(events.filter((e) => e.type === 'llm_call').length, 5);
  assert.deepEqual(grounding.map((e) => e.data), [...planner.map((e) => e.data),
    { role: 'implementer', scope: 'step:s1', accepted: false, violations: ['false_absence'], cited: 0, shown: 1 },
    { role: 'implementer', scope: 'step:s1', accepted: true, violations: [], cited: 0, shown: 1 },
    { role: 'reviewer', scope: 'review:0', accepted: true, violations: [], cited: 1, shown: 1 }
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'procedure').map((e) => [e.data.role, e.data.scope, e.data.situation]), [
    ['planner', 'plan:r0', 'plan.start'], ['planner', 'plan:r0', 'plan.repair'],
    ['implementer', 'step:s1', 'implement.start'], ['implementer', 'step:s1', 'implement.repair'], ['reviewer', 'review:0', 'review.start']
  ]);
  for (const [type, data] of [['criteria_decided', { states: { demonstrated: 1, met_not_demonstrated: 1 } }], ['probe_finished', { status: 'not_needed', checks: [] }]]) {
    const event = events.find((e) => e.type === type);
    assert.equal(event.node, 'ground'); assert.deepEqual(event.data, data);
    assert.ok(grounding.at(-1).seq < event.seq);
    assert.ok(event.seq < events.find((e) => e.node === 'package').seq);
  }
  assert.equal((await f.decide(id, delivery.status)).code, 202);
  const done = await f.wait(id, 'succeeded');
  assert.deepEqual(done.status.grounding, expected);
  assert.deepEqual(done.events.filter((e) => e.type === 'gate_waiting').map((e) => e.data.gate), ['plan', 'delivery']);
});

test('Pipeline conversation field validates strict booleans before creating a request', async (t) => {
  const f = await setup(t);
  for (const conversation of [null, 0, 1, 'true', 'false', [], {}]) {
    const r = await f.req(f.route() + '/pipeline/runs', { task: 'Question', demo: true, conversation });
    assert.equal(r.code, 400);
    assert.equal(r.value.error, 'conversation: Expected boolean');
  }
  assert.deepEqual((await f.req(f.route() + '/pipeline')).value.runs, []);
});

test('Pipeline conversation config is opt-in, byte-compatible off, and list replies use task redaction', async (t) => {
  const f = await setup(t);
  const expected = { schema: 1, models: Object.fromEntries(['planner', 'implementer', 'reviewer'].map((role) => [role, { provider: 'openai_compatible', model: 'test-model', base_url: 'https://api.openai.com/v1', api_key_env: `SCRANTON_PIPELINE_KEY_${role.toUpperCase()}` }])), limits: { max_replans: 1 }, execution: { max_parallel_steps: 1 }, sandbox: { mode: 'host' }, checks: [], setup: [], allow_no_checks: true, approvals: { plan: 'always' }, review: { enabled: true } };
  for (const fields of [{}, { conversation: false }, { conversation: true }]) {
    const id = await f.start({ ...hostRun, ...fields }), gate = await f.wait(id, 'awaiting_approval');
    const base = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline');
    const bytes = fs.readFileSync(path.join(base, 'requests', id + '.json'), 'utf8');
    const cfg = fields.conversation ? { schema: 1, conversation: true, ...Object.fromEntries(Object.entries(expected).filter(([name]) => name !== 'schema')) } : expected;
    assert.equal(bytes, JSON.stringify(cfg, null, 2) + '\n');
    await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
    const file = path.join(base, 'runs', id, 'status.json'), status = JSON.parse(fs.readFileSync(file));
    status.task = key;
    status.reply = { from: 'pipeline', kind: 'result', text: key + 'x'.repeat(4100), truncated: false, citations: ['E-1234567890'] };
    fs.writeFileSync(file, JSON.stringify(status));
    const row = (await f.req(f.route() + '/pipeline')).value.runs.find((r) => r.runId === id);
    assert.equal(row.task, '[REDACTED]');
    assert.equal(row.reply.text, ('[REDACTED]' + 'x'.repeat(4100)).slice(0, 4000));
    assert.equal(row.reply.truncated, true);
    assert.deepEqual(row.reply.citations, ['E-1234567890']);
  }
});

test('Pipeline conversation demos pass the switch only when enabled and accept answer scenario', async (t) => {
  const base = path.resolve('.scratch/pipeline/chat-node/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'demo-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The existing fake predates answer; extend only its scenario allowlist in a private copy.
  const { pathToFileURL } = await import('node:url');
  const file = path.join(dir, 'fake.mjs');
  fs.writeFileSync(file, fs.readFileSync('tools/fake-pipeline.js', 'utf8').replace("'../src/core/util.js'", JSON.stringify(pathToFileURL(path.resolve('src/core/util.js')).href)).replace("['basic', 'replan', 'parallel', 'evidence']", "['basic', 'replan', 'parallel', 'evidence', 'answer']"));
  const f = await setup(t, { command: JSON.stringify([process.execPath, file]) });
  for (const fields of [{}, { conversation: false }, { conversation: true }, { conversation: true, demoScenario: 'answer' }]) {
    const id = await f.start({ task: 'Demo question', demo: true, ...fields });
    const gate = await f.wait(id, 'awaiting_approval');
    const runRoot = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline/runs');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runRoot, id, 'argv.json'))), [
      'demo', '--run-root', runRoot, '--run-id', id, '--workspace-root', path.join(f.dir, 'workspaces'), '--delivery', 'apply',
      '--scenario', fields.demoScenario ?? 'basic', '--sandbox', 'host', ...(fields.conversation ? ['--conversation'] : []), '--parent-guard'
    ]);
    await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
  }
  for (const demo of [undefined, false]) {
    const r = await f.req(f.route() + '/pipeline/runs', { task: 'x', demo, demoScenario: 'answer', conversation: true });
    assert.equal(r.code, 400); assert.match(r.value.error, /^demoScenario:/);
  }
});

test('Pipeline omitted sandbox defaults to host even without Docker; explicit host still requires trust', async (t) => {
  const f = await setup(t, { env: { FAKE_PIPELINE_DOCKER_ABSENT: '1' } });
  for (const trustHost of [undefined, false]) {
    const r = await f.req(f.route() + '/pipeline/runs', { task: 'x', models, sandbox: { mode: 'host', trustHost } });
    assert.equal(r.code, 409); assert.match(r.value.error, /trustHost:true/);
  }
  const id = await f.start({ task: 'Default host', models }), gate = await f.wait(id, 'awaiting_approval');
  const base = path.join(f.dataDir, 'projects', f.project.id, 'chats', f.chats[0].id, 'pipeline');
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'requests', id + '.json')));
  assert.deepEqual(cfg.sandbox, { mode: 'host' });
  assert.equal(gate.status.sandbox.mode, 'host'); assert.equal(gate.status.sandbox.isolated, false);
  const argv = JSON.parse(fs.readFileSync(path.join(base, 'runs', id, 'argv.json')));
  assert.ok(argv.includes('--trust-host'));
  await f.decide(id, gate.status, 'reject'); await f.wait(id, 'rejected');
});
