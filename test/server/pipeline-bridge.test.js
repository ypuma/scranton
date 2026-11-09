import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRegistry } from '../../src/core/projects.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const key = 'bridge-key-never-in-config';
async function fixture(t, real = false, ambient = false) {
  const base = path.resolve('.scratch/pipeline/lane-b/server'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'http-'));
  const python = path.resolve('.scratch/pipeline/venv/Scripts/python.exe');
  const pi = path.join(dir, 'pi.mjs');
  fs.writeFileSync(pi, `import fs from 'node:fs';
const args = process.argv.slice(2), system = fs.readFileSync(args[args.indexOf('--append-system-prompt')+1], 'utf8');
if (${ambient} && process.env.ANTHROPIC_API_KEY !== ${JSON.stringify(key)}) process.exit(1);
const planner = {kind:'plan',plan:{summary:'Fix addition',acceptance_criteria:[{id:'sum',text:'Addition works',verified_by:'checks'}],steps:[{id:'fix',title:'Fix addition',description:'Use addition',files:[{path:'calculator.py',action:'modify'}],criteria:['sum']}]}};
const implementer = {kind:'edits',summary:'Fixed',edits:[{path:'calculator.py',action:'modify',content:'def add(a, b):\\n    return a + b\\n'}]};
const reviewer = {verdict:'approve',summary:'Correct',criteria:[{id:'sum',status:'met',evidence:'Tests pass'}]};
const answer = system.includes('PlannerTurn') ? planner : system.includes('ImplementerTurn') ? implementer : reviewer;
fs.appendFileSync(process.env.BRIDGE_CALLS, JSON.stringify({env:Object.keys(process.env),argv:args,cwd:process.cwd()})+'\\n');
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(answer)}],stopReason:'stop',usage:{input:20,output:30}}}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));
`);
  const changes = { SCRANTON_PIPELINE_COMMAND: JSON.stringify(real ? [python, '-m', 'scranton_pipeline'] : [process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PI_COMMAND: JSON.stringify([process.execPath, pi]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(dir, 'workspaces'), BRIDGE_CALLS: path.join(dir, 'calls.jsonl'), TEMP: path.resolve('.scratch/pipeline/tmp'), TMP: path.resolve('.scratch/pipeline/tmp'), TMPDIR: path.resolve('.scratch/pipeline/tmp'), PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode') };
  if (ambient) Object.assign(changes, { ANTHROPIC_API_KEY: key, GEMINI_API_KEY: 'unrelated-provider-key' });
  fs.mkdirSync(changes.TEMP, { recursive: true });
  const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]])); Object.assign(process.env, changes);
  const dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'source'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'calculator.py'), 'def add(a, b):\n    return a - b\n');
  fs.writeFileSync(path.join(workspace, 'test_calculator.py'), 'import unittest\nfrom calculator import add\nclass Check(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n');
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Bridge', workspace }), chat = registry.createChat(project.id, { engine: 'pipeline' });
  let credentialCalls = 0;
  const auth = { listAccounts: () => [{ id: 'openai', label: 'API', kind: 'api_key', status: 'signed_in' }, { id: 'anthropic', label: 'Subscription', kind: ambient ? 'api_key' : 'oauth', status: 'signed_in' }], listModels: async () => ({ providers: ['openai', 'anthropic', 'google-vertex'].map((id) => ({ id, models: [{ id: 'test', name: 'Test' }, { id: '--tools', name: 'Unsafe' }] })) }), resolveDockerCredential: async () => { credentialCalls++; return { value: key }; }, close() {} };
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, control: { auth } });
  t.after(async () => { await server.close(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(dir, { recursive: true, force: true }); });
  const route = `/api/projects/${project.id}/chats/${chat.id}/pipeline/runs`;
  async function req(url, body) {
    const r = await fetch(server.url + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); assert.equal(text.includes(key), false); return { code: r.status, value: JSON.parse(text) };
  }
  async function wait(id, status) {
    const deadline = Date.now() + 60000; let r;
    do { r = await req(`${route}/${id}`); if (r.code === 200 && !r.value.live && r.value.status.status === status) return r.value.status; await sleep(40); } while (Date.now() < deadline);
    assert.fail(`Expected ${status}: ${JSON.stringify(r)}`);
  }
  async function start(provider) {
    const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider, model: 'test' }]));
    const r = await req(route, { task: 'Fix addition', models, sandbox: { mode: 'host', trustHost: true }, checks: real ? [{ id: 'test', kind: 'test', command: ambient ? `"${python}" -c "import os; assert 'ANTHROPIC_API_KEY' not in os.environ; assert 'GEMINI_API_KEY' not in os.environ"` : `"${python}" -m unittest -q` }] : [] });
    assert.equal(r.code, 202, JSON.stringify(r)); return r.value.runId;
  }
  const config = (id) => fs.readFileSync(path.join(dataDir, 'projects', project.id, 'chats', chat.id, 'pipeline/requests', id + '.json'), 'utf8');
  const decide = (id, s, decision = 'approve') => req(`${route}/${id}/decision`, { decision, gate: s.pending.gate, digest: s.pending.digest });
  return { dir, workspace, route, req, wait, start, config, decide, credentialCalls: () => credentialCalls };
}

test('Pipeline subscription and available-only model use pi; API-key OpenAI stays direct', async (t) => {
  const f = await fixture(t);
  const catalog = (await f.req('/api/pipeline')).value.models;
  assert.equal(catalog.find((p) => p.provider === 'anthropic').via, 'pi');
  assert.equal(catalog.find((p) => p.provider === 'google-vertex').supported, true);
  assert.equal(catalog.find((p) => p.provider === 'openai').via, 'direct');
  const injected = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'anthropic', model: '--tools' }]));
  const refused = await f.req(f.route, { task: 'x', models: injected });
  assert.equal(refused.code, 400); assert.match(refused.value.error, /models.planner/);
  const id = await f.start('anthropic'), gate = await f.wait(id, 'awaiting_approval');
  assert.equal(f.credentialCalls(), 0);
  const cfg = JSON.parse(f.config(id));
  for (const m of Object.values(cfg.models)) {
    assert.equal(m.provider, 'command'); assert.equal(m.structured_output, 'json_text');
    assert.deepEqual(m.command, [process.execPath, path.resolve('tools/pipeline-pi-complete.js'), '--provider', 'anthropic', '--model', 'test']);
    assert.equal(m.api_key_env, undefined);
  }
  assert.equal(f.config(id).includes(key), false);
  assert.equal((await f.decide(id, gate, 'reject')).code, 202); await f.wait(id, 'rejected');
  const direct = await f.start('openai'); await f.wait(direct, 'awaiting_approval');
  assert.equal(f.credentialCalls(), 3);
  assert.equal(JSON.parse(f.config(direct)).models.planner.provider, 'openai_compatible');
  assert.equal(f.config(direct).includes(key), false);
});

test('real engine + fake pi over HTTP traverses both gates and applies verified edits', async (t) => {
  if (!fs.existsSync('.scratch/pipeline/venv/Scripts/python.exe')) { t.skip('Development Python runtime is missing'); return; }
  const f = await fixture(t, true), id = await f.start('anthropic');
  const plan = await f.wait(id, 'awaiting_approval'); assert.equal(plan.pending.gate, 'plan');
  assert.equal((await f.decide(id, plan)).code, 202);
  const delivery = await f.wait(id, 'awaiting_approval'); assert.equal(delivery.pending.gate, 'delivery');
  assert.equal((await f.decide(id, delivery)).code, 202);
  const done = await f.wait(id, 'succeeded'); assert.equal(done.delivery.applied, true);
  assert.match(fs.readFileSync(path.join(f.workspace, 'calculator.py'), 'utf8'), /return a \+ b/);
  assert.equal(f.credentialCalls(), 0);
  const calls = fs.readFileSync(path.join(f.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.equal(call.env.some((k) => k.startsWith('SCRANTON_PIPELINE_KEY_')), false); assert.equal(fs.existsSync(call.cwd), false); }
});

// Guard: credentials() copies only PROVIDER_ENV_NAMES for the selected pi provider into extra.
test('environment-only pi account reaches provider but not checks, including gate resumes', async (t) => {
  if (!fs.existsSync('.scratch/pipeline/venv/Scripts/python.exe')) { t.skip('Development Python runtime is missing'); return; }
  const f = await fixture(t, true, true), id = await f.start('anthropic');
  const plan = await f.wait(id, 'awaiting_approval');
  assert.equal(plan.checks[0].status, 'passed');
  await f.decide(id, plan);
  const delivery = await f.wait(id, 'awaiting_approval');
  assert.equal(delivery.checks[0].status, 'passed');
  await f.decide(id, delivery); await f.wait(id, 'succeeded');
  const calls = fs.readFileSync(path.join(f.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.env.includes('ANTHROPIC_API_KEY'), true);
    assert.equal(call.env.includes('GEMINI_API_KEY'), false);
  }
  assert.equal(f.config(id).includes(key), false);
  assert.equal(f.credentialCalls(), 0);
});
