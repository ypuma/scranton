import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { loadConfig, PACKAGE_ROOT } from '../../src/core/config.js';
import { auditRole } from '../../src/core/agents-config.js';
import { promptAudit } from '../../src/core/prompts.js';
import { createContext } from '../../src/core/context/index.js';

function fixture(t) {
  const root = path.resolve('.scratch/dreaming-cli-fix/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'CLI dreaming', workspace });
  const chat = registry.createChat(project.id);
  const config = loadConfig({ cwd: PACKAGE_ROOT, env: {}, flags: { trustedHost: true } });
  const gates = config.workflow.gates.flat();
  for (const runId of ['one', 'two', 'three']) {
    const file = path.join(chat.hiveDir, 'runs', runId, 'events.jsonl');
    const rows = [
      { type: 'run_started', request: 'Earlier task ' + runId, maxFailedCycles: 3,
        execution: { workflow: config.workflow }, prompts: promptAudit(config),
        roles: gates.map((id) => auditRole({ ...config.roles.find((r) => r.id === id), tools: config.agents[id].tools })) },
      ...[1, 2, 3].map((cycle) => ({ type: 'cycle_result', milestoneId: 'm1', cycle, result: 'failed' })),
      { type: 'milestone_finished', milestoneId: 'm1', status: 'failed' },
      { type: 'run_finished', status: 'failed', summary: 'Earlier outcome ' + runId }
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((row, i) => JSON.stringify({ v: 1, runId, seq: i + 1, ts: new Date().toISOString(), ...row })).join('\n') + '\n');
  }
  const history = createContext({ dataDir, registry }).forTeam(project.id, chat.id).text;
  const dreamDir = path.join(dataDir, 'projects', project.id, 'dreaming');
  let observed;
  t.mock.method(Orchestrator.prototype, 'run', async function (request) {
    observed = { config: this.config, threadContext: this.threadContext, request };
    return { status: 'success', cleanupComplete: true };
  });
  async function run(extra = []) {
    let output = '';
    const stream = { isTTY: false, write: (s) => output += s };
    const code = await runCli(['run', 'Current task', '--data', dataDir, '--project', project.id,
      '--trusted-host', '--chat', chat.id, ...extra], { cwd: dir, env: {}, stdout: stream, stderr: stream });
    assert.equal(code, 0, output);
    assert.equal(observed.request, 'Current task');
    return observed;
  }
  function sweep(applyPolicy = false) {
    const dream = registry.dreaming(project.id);
    try {
      assert.equal(dream.sweep().replay.worlds, 3);
      if (applyPolicy) dream.configure({ applyPolicy: true });
    } finally { dream.close(); }
  }
  return { dir, registry, project, chat, dreamDir, history, run, sweep };
}

test('CLI corrupt optional dreaming state preserves history and ceiling and still creates a new chat run', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.dreamDir, { recursive: true });
  const file = path.join(f.dreamDir, 'state.json');
  fs.writeFileSync(file, '{corrupt');
  const result = await f.run();
  assert.equal(result.config.maxFailedCycles, 3);
  assert.equal(result.threadContext, f.history);
  let started = false;
  t.mock.method(Orchestrator.prototype, 'run', async function () {
    started = true;
    assert.equal(this.config.maxFailedCycles, 3);
    const chat = f.registry.listChats(f.project.id).find((c) => c.hiveDir === this.config.hiveDir);
    assert.equal(this.threadContext, createContext({ dataDir: path.join(f.dir, 'data'), registry: f.registry }).forTeam(f.project.id, chat.id).text);
    assert.match(this.threadContext, /Other chats.*\n/s);
    return { status: 'success', cleanupComplete: true };
  });
  const stream = { write() {} };
  assert.equal(await runCli(['run', 'New task', '--data', path.join(f.dir, 'data'), '--project', f.project.id, '--trusted-host'],
    { cwd: f.dir, env: {}, stdout: stream, stderr: stream }), 0);
  assert.equal(started, true);
  assert.equal(f.registry.listChats(f.project.id).length, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt', 'no silent repair');
});

test('CLI dreaming factory path failure is optional', async (t) => {
  const f = fixture(t), target = path.join(f.dir, 'redirected');
  fs.mkdirSync(target);
  fs.symlinkSync(target, f.dreamDir, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.run();
  assert.equal(result.config.maxFailedCycles, 3);
  assert.equal(result.threadContext, f.history);
});

test('CLI dreaming policy read failure discards partial memory injection and closes opened files', async (t) => {
  const f = fixture(t); f.sweep(true);
  const open = fs.openSync, close = fs.closeSync, opened = new Set();
  let reads = 0;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    if (file === path.join(f.dreamDir, 'state.json')) {
      if (++reads === 3) throw Error('Optional policy unavailable');
      const fd = open.call(this, file, ...args); opened.add(fd); return fd;
    }
    return open.call(this, file, ...args);
  });
  t.mock.method(fs, 'closeSync', function (fd) { opened.delete(fd); return close.call(this, fd); });
  const result = await f.run();
  assert.equal(reads, 3, 'cancellation and context succeed before policy fails; close needs no authority read');
  assert.equal(result.config.maxFailedCycles, 3);
  assert.equal(result.threadContext, f.history);
  assert.equal(opened.size, 0);
});

for (const applyPolicy of [false, true]) test(`CLI dreaming adoption opt-in=${applyPolicy} preserves history`, async (t) => {
  const f = fixture(t); f.sweep(applyPolicy);
  const result = await f.run();
  assert.equal(result.config.maxFailedCycles, applyPolicy ? 1 : 3);
  const dream = f.registry.dreaming(f.project.id);
  try {
    const pack = createContext({ dataDir: path.join(f.dir, 'data'), registry: f.registry }).forTeam(f.project.id, f.chat.id, { memory: dream.context() });
    assert.equal(result.threadContext, pack.text);
  } finally { dream.close(); }
  assert.ok(result.threadContext.indexOf('Project memory') < result.threadContext.indexOf('This chat - recent turns'));
  assert.match(result.threadContext, /Project memory \(advisory historical data/);
  assert.equal((await f.run(['--max-cycles', '2'])).config.maxFailedCycles, 2, 'different ceiling abstains');
});

test('CLI does not swallow unrelated run errors', async (t) => {
  const f = fixture(t);
  const error = Error('Unrelated run failure');
  t.mock.method(Orchestrator.prototype, 'run', async () => { throw error; });
  await assert.rejects(f.run(), (e) => e === error);
});
