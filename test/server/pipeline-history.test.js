import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createProjectRegistry } from '../../src/core/projects.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

async function fixture(t, real = false) {
  const base = path.resolve('.scratch/pipeline/history-node'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'server-')), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'source'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'render.js'), 'export const value = 0;\n');
  const python = path.resolve('.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const pi = path.join(dir, 'pi.mjs');
  fs.writeFileSync(pi, `import fs from 'node:fs';
const args=process.argv.slice(2), system=fs.readFileSync(args[args.indexOf('--append-system-prompt')+1],'utf8');
const user=fs.readFileSync(args.find(a=>a.startsWith('@')).slice(1),'utf8');
fs.appendFileSync(process.env.HISTORY_CALLS,JSON.stringify({system,user})+'\\n');
const plan={kind:'plan',plan:{summary:'Fresh continuation plan',acceptance_criteria:[{id:'syntax',text:'Valid JS',verified_by:'checks'}],steps:[{id:'new-fix',title:'Fresh fix',description:'Implement prior request',files:[{path:'render.js',action:'modify'}],criteria:['syntax']}]}};
const answer=system.includes('PlannerTurn') ? (!user.includes('Revised task plan') ? {kind:'answer',answer:{text:'No previous task or plan was provided.'}} : !user.includes('E-') ? {kind:'need_context',context_requests:[{kind:'read',path:'render.js'}]} : plan) : {kind:'edits',summary:'Fresh edit',edits:[{path:'render.js',action:'modify',content:'export const value = 1;\\n'}]};
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(answer)}],stopReason:'stop',usage:{input:20,output:30}}}));
console.log(JSON.stringify({type:'agent_settled',aborted:false}));`);
  const changes = { SCRANTON_PIPELINE_COMMAND: JSON.stringify(real ? [python, '-m', 'scranton_pipeline'] : [process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PI_COMMAND: JSON.stringify([process.execPath, pi]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(dir, 'workspaces'), HISTORY_CALLS: path.join(dir, 'calls.jsonl'), FAKE_PIPELINE_INVOCATIONS: path.join(dir, 'invocations.jsonl'), TEMP: path.resolve('.scratch/pipeline/tmp'), TMP: path.resolve('.scratch/pipeline/tmp'), TMPDIR: path.resolve('.scratch/pipeline/tmp'), PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode') };
  fs.mkdirSync(changes.TEMP, { recursive: true });
  const previous = Object.fromEntries(Object.keys(changes).map((k) => [k, process.env[k]])); Object.assign(process.env, changes);
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Continuity', workspace }), chat = registry.createChat(project.id, { engine: 'pipeline' });
  const other = registry.createChat(project.id, { engine: 'pipeline' });
  const auth = { listAccounts: async () => [{ id: 'anthropic', kind: 'oauth', status: 'signed_in' }], listModels: async () => ({ providers: [{ id: 'anthropic', models: [{ id: 'test' }] }] }), close() {} };
  let server;
  const restart = async () => { if (server) await server.close(); server = await startVisualizerServer({ dataDir, publicDir: dir, port: 0, control: { auth } }); };
  await restart();
  t.after(async () => { await server.close(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dataDir, 'projects', project.id, 'chats', chat.id, 'pipeline');
  const route = (c = chat) => `/api/projects/${project.id}/chats/${c.id}/pipeline/runs`;
  const req = async (url, body) => { const r = await fetch(server.url + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Scranton-Client': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { code: r.status, value: await r.json() }; };
  async function wait(id, state, c = chat) {
    const until = Date.now() + 60000; let r;
    do { r = await req(route(c) + '/' + id); if (r.value.launchError) assert.fail(JSON.stringify(r.value)); if (!r.value.live && r.value.status?.status === state) return r.value.status; if (!r.value.live && ['failed', 'succeeded', 'rejected', 'cancelled', 'suspended'].includes(r.value.status?.status)) assert.fail('Unexpected outcome: ' + JSON.stringify(r.value.status)); await sleep(40); } while (Date.now() < until);
    assert.fail('Expected ' + state + ': ' + JSON.stringify(r));
  }
  const body = { task: ' continue\n', conversation: true, review: false, models: Object.fromEntries(['planner', 'implementer', 'reviewer'].map((r) => [r, { provider: 'anthropic', model: 'test' }])), sandbox: { mode: 'host', trustHost: true }, checks: [{ id: 'syntax', kind: 'syntax', command: `"${process.execPath}" --check render.js` }] };
  const start = async (c = chat, extra = {}) => { const r = await req(route(c), { ...body, ...extra }); assert.equal(r.code, 202, JSON.stringify(r)); return r.value.runId; };
  const decide = (id, s, decision) => req(`${route()}/${id}/decision`, { gate: s.pending.gate, digest: s.pending.digest, decision });
  function seed() {
    const old = path.join(root, 'runs/oldrun01'); fs.mkdirSync(path.join(old, 'artifacts'), { recursive: true }); fs.mkdirSync(path.join(old, 'delivery'));
    const write = (rel, v) => fs.writeFileSync(path.join(old, rel), JSON.stringify(v));
    write('status.json', { schema: 1, run_id: 'oldrun01', status: 'failed', task: 'Original visualization request', created_at: '2026-01-01', progress: { plan_revision: 1, steps_done: 1 }, failure: { code: 'context_budget', message: 'Unread existing test' } });
    write('run.json', { task: 'Original visualization request password=super-private-value' });
    write('artifacts/plan.json', { summary: 'Revised task plan', steps: [{ id: 'r1-old', title: 'Visualization', files: [{ path: 'render.js', action: 'modify' }] }], approval: 'NEVER-INHERIT-APPROVAL' });
    write('delivery/report.json', { steps: [{ step_id: 'step:prior' }], delivery: { applied: false } });
    return fs.readFileSync(path.join(old, 'run.json'), 'utf8');
  }
  return { dir, root, workspace, body, route, req, wait, start, decide, restart, seed, other };
}

test('HTTP fresh run receives disk history after restart, exact task and redaction; demo/resume/other chat do not', async (t) => {
  const f = await fixture(t); const original = f.seed(); await f.restart();
  const id = await f.start(), s = await f.wait(id, 'awaiting_approval');
  const argv = JSON.parse(fs.readFileSync(path.join(f.root, 'runs', id, 'argv.json')));
  const file = argv[argv.indexOf('--history-file') + 1]; assert.match(file, /\.history\.json$/);
  const text = fs.readFileSync(file, 'utf8'), h = JSON.parse(text);
  assert.match(h.runs[0].plan, /Revised task plan/); assert.doesNotMatch(text, /super-private-value|NEVER-INHERIT/);
  assert.equal(fs.readFileSync(path.join(f.root, 'requests', id + '.json.task.txt'), 'utf8'), f.body.task);
  assert.equal(s.progress.steps_done, 0);
  assert.equal((await f.req(f.route(), f.body)).code, 409);
  await f.decide(id, s, 'reject'); await f.wait(id, 'rejected');
  const demo = await f.start(undefined, { demo: true }); const d = await f.wait(demo, 'awaiting_approval');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'runs', demo, 'argv.json'))).includes('--history-file'), false);
  await f.decide(demo, d, 'reject'); await f.wait(demo, 'rejected');
  const other = await f.start(f.other); await f.wait(other, 'awaiting_approval', f.other);
  const otherRoot = path.join(path.dirname(path.dirname(f.root)), f.other.id, 'pipeline');
  assert.equal(JSON.parse(fs.readFileSync(path.join(otherRoot, 'runs', other, 'argv.json'))).includes('--history-file'), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'runs/oldrun01/run.json'), 'utf8'), original);
  assert.equal((await f.req(f.route(), { ...f.body, history: h })).code, 400);
  const invocations = fs.readFileSync(path.join(f.dir, 'invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(invocations.some((a) => a[0] === 'resume'));
  assert.ok(invocations.filter((a) => ['resume', 'demo', 'cancel'].includes(a[0])).every((a) => !a.includes('--history-file')));
});

test('real Python bridge continues a failed revised plan using fresh reads, approvals and execution', async (t) => {
  const python = path.resolve('.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) { t.skip('Development Python runtime is missing'); return; }
  const f = await fixture(t, true), original = f.seed(); await f.restart();
  const id = await f.start(), gate = await f.wait(id, 'awaiting_approval');
  assert.equal(gate.pending.gate, 'plan'); assert.equal(gate.progress.plan_revision, 0); assert.equal(gate.progress.steps_done, 0);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'render.js'), 'utf8'), 'export const value = 0;\n');
  const meta = JSON.parse(fs.readFileSync(path.join(f.root, 'runs', id, 'run.json')));
  assert.equal(meta.task, f.body.task); assert.match(meta.cross_run_history.runs[0].plan, /Revised task plan/);
  const calls = fs.readFileSync(path.join(f.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2); assert.match(calls[0].user, /Revised task plan/); assert.match(calls[1].user, /E-[a-f0-9]{10}/);
  assert.doesNotMatch(JSON.stringify(calls), /super-private-value|NEVER-INHERIT/);
  assert.equal((await f.decide(id, gate, 'approve')).code, 202);
  const delivery = await f.wait(id, 'awaiting_approval'); assert.equal(delivery.pending.gate, 'delivery');
  assert.equal(delivery.checks[0].status, 'passed'); assert.equal(delivery.progress.steps_done, 1);
  assert.equal((await f.decide(id, delivery, 'approve')).code, 202);
  const done = await f.wait(id, 'succeeded'); assert.equal(done.delivery.applied, true);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'render.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'runs/oldrun01/run.json'), 'utf8'), original);
  const allCalls = fs.readFileSync(path.join(f.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(allCalls.at(-1).user, /Revised task plan/);
});
