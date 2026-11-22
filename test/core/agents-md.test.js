import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { loadConfig } from '../../src/core/config.js';
import { discoverInstructions } from '../../src/core/instructions.js';
import { startAgent } from '../../src/core/agent/index.js';
import { createAgentScript } from '../../src/core/agent/scripted.js';
import { createScriptedProvider } from '../../src/core/llm/scripted.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createContext } from '../../src/core/context/index.js';
import { runCli } from '../../src/core/cli.js';

function fixture(t) {
  const scratch = path.resolve('.scratch/agents-md'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'team-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'INITIAL instructions.');
  fs.mkdirSync(path.join(workspace, 'src')); fs.writeFileSync(path.join(workspace, 'src/AGENTS.md'), 'Nested instructions.');
  fs.writeFileSync(path.join(workspace, '.gitignore'), 'ignored/\n');
  for (const name of ['.scratch', 'node_modules', '.enma', 'ignored']) {
    fs.mkdirSync(path.join(workspace, name)); fs.writeFileSync(path.join(workspace, name, 'AGENTS.md'), 'Excluded.');
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, workspace, hiveDir: path.join(dir, 'hive') };
}
function configFor(f, agentsMd = true) {
  const config = loadConfig({ cwd: f.dir, env: {}, fileConfig: { workspace: f.workspace, hiveDir: f.hiveDir, agentsMd,
    workflow: { gates: [['oscar'], ['angela']] }, execution: { maxParallel: 1, isolation: 'worktree', sandbox: { mode: 'host' } } } });
  config.scripted = 'happy'; return config;
}
function isolation(t) {
  const before = process.env.SCRANTON_ISOLATION_ROOT;
  process.env.SCRANTON_ISOLATION_ROOT = path.resolve('.scratch/i');
  t.after(() => { if (before === undefined) delete process.env.SCRANTON_ISOLATION_ROOT; else process.env.SCRANTON_ISOLATION_ROOT = before; });
}

test('team uses one initial snapshot for Michael, Dwight, Angela and a gate despite a real model tool edit', async t => {
  isolation(t);
  const f = fixture(t), config = configFor(f), expected = discoverInstructions(f.workspace), prompts = [], events = [];
  config.roles.push({ id: 'review', name: 'Review', title: 'Custom gate', kind: 'gate', builtin: false, instruction: 'Check the change.', tools: ['read', 'ls'], keywords: ['REVIEW_PASSED', 'REVIEW_FAILED', 'BLOCKED'], passKeyword: 'REVIEW_PASSED', failKeyword: 'REVIEW_FAILED' });
  config.agents.review = { ...config.agents.oscar, tools: ['read', 'ls'] };
  config.workflow = { gates: [['oscar', 'hank', 'review'], ['angela']] };
  let edited = false;
  const o = new Orchestrator({ config, onBreaker: 'abort', listener: e => events.push(e), startRunner(options) {
    const systemPrompt = fs.readFileSync(options.systemPromptFile, 'utf8');
    prompts.push({ role: options.agentId, block: systemPrompt.slice(systemPrompt.indexOf('## Repository instructions')) });
    const ready = (async () => {
      const script = await createAgentScript('happy', { ...options, systemPrompt, env: options.extraEnv });
      const prefix = options.agentId === 'dwight' && !edited ? createScriptedProvider([{ toolCalls: [{ id: 'edit-instructions', name: 'write', arguments: { path: 'AGENTS.md', content: 'CHANGED by Dwight.' } }] }]) : null;
      if (prefix) edited = true;
      let first = true;
      const llm = { stream(...args) { if (first && prefix) { first = false; return prefix.stream(...args); } return script.llm.stream(...args); } };
      return startAgent({ ...options, scripted: undefined, extraEnv: { ...options.extraEnv, SCRANTON_FAKE_MODE: '0' }, llm, model: script.model, spawn: script.spawn });
    })();
    return { done: ready.then(r => r.done), kill: why => ready.then(r => r.kill(why)), sendMessage: text => ready.then(r => r.sendMessage(text)) };
  } });
  t.after(() => { if (o.worktrees?.storage) fs.rmSync(o.worktrees.storage, { recursive: true, force: true }); });
  const result = await o.run('Build a todo CLI');
  assert.equal(result.status, 'success', result.summary);
  assert.deepEqual([...new Set(prompts.map(p => p.role))].sort(), ['angela', 'dwight', 'hank', 'michael', 'oscar', 'review']);
  for (const prompt of prompts) assert.equal(prompt.block.trimEnd(), expected.block.trimEnd(), prompt.role);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), 'CHANGED by Dwight.');
  assert.deepEqual(events[0].instructions, expected.summary);
  assert.ok(!JSON.stringify(events[0]).includes('INITIAL instructions.'));
});

test('config opt-out means no block, no warnings and null audit', async t => {
  isolation(t);
  const f = fixture(t), config = configFor(f, false), events = [], prompts = [];
  const o = new Orchestrator({ config, noPlan: true, listener: e => events.push(e), startRunner(options) {
    prompts.push(fs.readFileSync(options.systemPromptFile, 'utf8'));
    return startAgent(options);
  } });
  t.after(() => { if (o.worktrees?.storage) fs.rmSync(o.worktrees.storage, { recursive: true, force: true }); });
  assert.equal((await o.run('Do the task')).status, 'success');
  assert.equal(events[0].instructions, null);
  assert.ok(prompts.length > 0); for (const prompt of prompts) assert.ok(!prompt.includes('Repository instructions'));
});

test('standalone scranton agent receives instructions and audits them', async t => {
  isolation(t);
  const f = fixture(t), log = path.join(f.dir, 'script.log');
  const output = { write() {}, isTTY: false };
  const code = await runCli(['agent', 'dwight', 'One task', '--workspace', f.workspace, '--hive', f.hiveDir, '--trusted-host', '--quiet'], {
    cwd: f.dir, stdout: output, stderr: output, stdin: { isTTY: false },
    env: { ...process.env, SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy', SCRANTON_FAKE_LOG: log }
  });
  assert.equal(code, 0);
  const receipt = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.match(receipt.systemPrompt, /## Repository instructions \(AGENTS.md\)/);
  assert.match(receipt.systemPrompt, /INITIAL instructions\./);
  const event = JSON.parse(fs.readFileSync(path.join(f.hiveDir, 'events.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(event.instructions, discoverInstructions(f.workspace).summary);
  const pointers = path.join(f.hiveDir, 'isolation');
  for (const file of fs.readdirSync(pointers)) fs.rmSync(JSON.parse(fs.readFileSync(path.join(pointers, file), 'utf8')).storage, { recursive: true, force: true });
});

test('warnings are warn-level log events and rejected roots do not abort snapshots', async t => {
  isolation(t);
  const f = fixture(t); fs.unlinkSync(path.join(f.workspace, 'AGENTS.md')); fs.mkdirSync(path.join(f.workspace, 'AGENTS.md'));
  const config = configFor(f), events = [];
  const o = new Orchestrator({ config, noPlan: true, listener: e => events.push(e) });
  t.after(() => { if (o.worktrees?.storage) fs.rmSync(o.worktrees.storage, { recursive: true, force: true }); });
  assert.equal((await o.run('One task')).status, 'success');
  assert.deepEqual(events[0].instructions, { file: null, nested: 1 });
  assert.ok(events.some(e => e.type === 'log' && e.level === 'warn' && e.message === 'AGENTS.md: not_regular'));
});

test('config defaults, file/env/flags precedence and invalid values', async t => {
  const f = fixture(t);
  const get = (fileConfig = {}, env = {}, flags = {}) => loadConfig({ cwd: f.dir, fileConfig, env, flags }).agentsMd;
  assert.equal(get(), true); assert.equal(get({ agentsMd: false }), false);
  assert.equal(get({ agentsMd: false }, { SCRANTON_AGENTS_MD: '1' }), true);
  assert.equal(get({ agentsMd: true }, { SCRANTON_AGENTS_MD: '0' }), false);
  assert.equal(get({ agentsMd: true }, { SCRANTON_AGENTS_MD: '1' }, { agentsMd: false }), false);
  for (const value of ['false', 0, [], {}]) assert.throws(() => get({ agentsMd: value }), /agentsMd must be boolean/);
  for (const value of ['true', 'false', '2']) assert.throws(() => get({}, { SCRANTON_AGENTS_MD: value }), /SCRANTON_AGENTS_MD/);
});

test('context status/inspect and context show include a separate non-budgeted instruction summary', async t => {
  const f = fixture(t), dataDir = path.join(f.dir, 'data'), registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Instructions', workspace: f.workspace }), chat = registry.createChat(project.id);
  const context = createContext({ dataDir, registry, agentsMd: true }), expected = discoverInstructions(f.workspace).status;
  assert.deepEqual((await context.status(project.id)).instructions, expected);
  const inspected = (await context.inspect(project.id, chat.id));
  assert.deepEqual(inspected.instructions, expected); assert.equal(inspected.budget.used, 0); assert.deepEqual(inspected.sections, []);
  assert.equal((await createContext({ dataDir, registry, agentsMd: false }).status(project.id)).instructions, null);
  for (const json of [false, true]) {
    let output = '';
    const code = await runCli(['context', 'show', '--data', dataDir, '--project', project.id, ...(json ? ['--json'] : [])], {
      cwd: f.dir, env: { ...process.env, SCRANTON_AGENTS_MD: '1' }, stdout: { write(s) { output += s; } }, stderr: { write() {} }
    });
    assert.equal(code, 0);
    if (json) assert.deepEqual(JSON.parse(output).instructions, expected);
    else assert.match(output, /Repository instructions: AGENTS.md \(21 bytes, ~\d+ tokens\); nested: 1/);
  }
  fs.writeFileSync(path.join(f.dir, 'scranton.config.json'), JSON.stringify({ agentsMd: false }));
  let output = '';
  assert.equal(await runCli(['context', 'show', '--data', dataDir, '--project', project.id, '--json'], { cwd: f.dir, env: {}, stdout: { write(s) { output += s; } }, stderr: { write() {} } }), 0);
  assert.equal(JSON.parse(output).instructions, null);
});
