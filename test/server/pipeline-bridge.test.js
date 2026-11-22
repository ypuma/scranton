import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRegistry } from '../../src/core/projects.js';
import { bridgeFixture } from '../core/bridges-fixture.js';
import { createCredentials } from '../../src/core/credentials/index.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const key = 'bridge-key-never-in-config';
async function fixture(t, real = false, ambient = false) {
  const f = await bridgeFixture(t, (body, res) => {
    const system = body.system.map((b) => b.text).join('\n');
    const planner = {kind:'plan',plan:{summary:'Fix addition',acceptance_criteria:[{id:'sum',text:'Addition works',verified_by:'checks'}],steps:[{id:'fix',title:'Fix addition',description:'Use addition',files:[{path:'calculator.py',action:'modify'}],criteria:['sum']}]}};
const implementer = {kind:'edits',summary:'Fixed',edits:[{path:'calculator.py',action:'modify',content:'def add(a, b):\n    return a + b\n'}]};
const reviewer = {verdict:'approve',summary:'Correct',criteria:[{id:'sum',status:'met',evidence:'Tests pass'}]};

    const answer = system.includes('PlannerTurn') ? planner : system.includes('ImplementerTurn') ? implementer : reviewer;
    const events = [ {type:'message_start',message:{usage:{input_tokens:20}}}, {type:'content_block_start',index:0,content_block:{type:'text',text:JSON.stringify(answer)}}, {type:'content_block_stop',index:0}, {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:30}}, {type:'message_stop'} ];
    res.setHeader('Content-Type','text/event-stream');
    res.end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  });
  const dir = f.dir, python = path.resolve('.scratch/pipeline/venv/Scripts/python.exe');
  f.store.providers.offline.api = 'anthropic-messages';
  fs.writeFileSync(path.join(f.credentialDir, 'store.json'), JSON.stringify(f.store));
  const credentials = await createCredentials({ env: f.env });
  const changes = { SCRANTON_PIPELINE_COMMAND: JSON.stringify(real ? [python, '-m', 'scranton_pipeline'] : [process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_CREDENTIALS_DIR: f.credentialDir, SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(dir, 'workspaces'), BRIDGE_CALLS: path.join(dir, 'calls.jsonl'), TEMP: path.resolve('.scratch/pipeline/tmp'), TMP: path.resolve('.scratch/pipeline/tmp'), TMPDIR: path.resolve('.scratch/pipeline/tmp'), PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode') };
  if (ambient) Object.assign(changes, { ANTHROPIC_API_KEY: key, GEMINI_API_KEY: 'unrelated-provider-key' });
  fs.mkdirSync(changes.TEMP, { recursive: true });
  const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]])); Object.assign(process.env, changes);
  const dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'source'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'calculator.py'), 'def add(a, b):\n    return a - b\n');
  fs.writeFileSync(path.join(workspace, 'test_calculator.py'), 'import unittest\nfrom calculator import add\nclass Check(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n');
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Bridge', workspace }), chat = registry.createChat(project.id, { engine: 'pipeline' });
  let credentialCalls = 0;
  const auth = { store: credentials.store, listAccounts: () => [{ id: 'openai', label: 'API', kind: 'api_key', status: 'signed_in' }, { id: 'offline', label: 'Offline', kind: 'api_key', status: 'signed_in' }], resolveAuth: async () => { credentialCalls++; return { type: 'api_key', key }; }, close() {} };
  const server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, control: { auth } });
  t.after(async () => { await server.close(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await credentials.close(); });
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
    const models = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider, model: provider === 'openai' ? 'gpt-4o' : 'test' }]));
    const r = await req(route, { task: 'Fix addition', models, sandbox: { mode: 'host', trustHost: true }, checks: real ? [{ id: 'test', kind: 'test', command: ambient ? `"${python}" -c "import os; assert 'ANTHROPIC_API_KEY' not in os.environ; assert 'GEMINI_API_KEY' not in os.environ"` : `"${python}" -m unittest -q` }] : [] });
    assert.equal(r.code, 202, JSON.stringify(r)); return r.value.runId;
  }
  const config = (id) => fs.readFileSync(path.join(dataDir, 'projects', project.id, 'chats', chat.id, 'pipeline/requests', id + '.json'), 'utf8');
  const decide = (id, s, decision = 'approve') => req(`${route}/${id}/decision`, { decision, gate: s.pending.gate, digest: s.pending.digest });
  return { calls: f.calls, dir, workspace, route, req, wait, start, config, decide, credentialCalls: () => credentialCalls };
}

test('Pipeline subscription and available-only model use the own bridge; API-key OpenAI stays direct', async (t) => {
  const f = await fixture(t);
  const catalog = (await f.req('/api/pipeline')).value.models;
  assert.equal(catalog.find((p) => p.provider === 'offline').via, 'bridge');
  assert.equal(catalog.some((p) => p.provider === 'google-vertex'), false);
  assert.equal(catalog.find((p) => p.provider === 'openai').via, 'direct');
  const injected = Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'anthropic', model: '--tools' }]));
  const refused = await f.req(f.route, { task: 'x', models: injected });
  assert.equal(refused.code, 400); assert.match(refused.value.error, /models.planner/);
  const id = await f.start('offline'), gate = await f.wait(id, 'awaiting_approval');
  assert.equal(f.credentialCalls(), 0);
  const cfg = JSON.parse(f.config(id));
  for (const m of Object.values(cfg.models)) {
    assert.equal(m.provider, 'command'); assert.equal(m.structured_output, 'json_text');
    assert.deepEqual(m.command, [process.execPath, path.resolve('tools/pipeline-complete.js'), '--provider', 'offline', '--model', 'test']);
    assert.equal(m.api_key_env, undefined);
  }
  assert.equal(f.config(id).includes(key), false);
  assert.equal((await f.decide(id, gate, 'reject')).code, 202); await f.wait(id, 'rejected');
  const direct = await f.start('openai'); await f.wait(direct, 'awaiting_approval');
  assert.equal(f.credentialCalls(), 3);
  assert.equal(JSON.parse(f.config(direct)).models.planner.provider, 'openai_compatible');
  assert.equal(f.config(direct).includes(key), false);
});

test('real engine + loopback LLM over HTTP traverses both gates and applies verified edits', async (t) => {
  if (!fs.existsSync('.scratch/pipeline/venv/Scripts/python.exe')) { t.skip('Development Python runtime is missing'); return; }
  const f = await fixture(t, true), id = await f.start('offline');
  const plan = await f.wait(id, 'awaiting_approval'); assert.equal(plan.pending.gate, 'plan');
  assert.equal((await f.decide(id, plan)).code, 202);
  const delivery = await f.wait(id, 'awaiting_approval'); assert.equal(delivery.pending.gate, 'delivery');
  assert.equal((await f.decide(id, delivery)).code, 202);
  const done = await f.wait(id, 'succeeded'); assert.equal(done.delivery.applied, true);
  t.diagnostic(JSON.stringify({ status: done.status, grounding: done.grounding }));
  assert.deepEqual(done.grounding.criteria, [{ id: 'sum', verified_by: 'checks', state: 'demonstrated', by: 'baseline', checks: ['test'] }]);
  assert.match(fs.readFileSync(path.join(f.workspace, 'calculator.py'), 'utf8'), /return a \+ b/);
  assert.equal(f.credentialCalls(), 0);
  assert.equal(f.calls.length, 4);
  for (const call of f.calls) assert.equal(call.tools, undefined);
});

