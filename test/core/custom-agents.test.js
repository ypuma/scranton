import { isolationTestEnv } from './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, THINKING_LEVELS } from '../../src/core/config.js';
import { saveAgent, deleteAgent, loadAgentsConfig } from '../../src/core/agents-config.js';
import { agentCatalog, resolvePrompt } from '../../src/core/prompts.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startPi } from '../../src/core/pi-runner.js';
import { validateDockerModels } from '../../src/core/sandbox.js';
const exec = promisify(execFile);
const definition = { name: 'Security Lint', title: 'Static Auditor', instruction: 'Inspect input boundaries independently.' };
function fixture(t) {
  const base = path.resolve('.scratch/ca-fix-backend'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const load = (extra = {}) => loadConfig({ cwd: dir, env: {}, flags: { trustedHost: true }, fileConfig: {}, ...extra });
  return { dir, load, config: load() };
}
const events = (c) => fs.readFileSync(path.join(c.hiveDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
test('custom definitions validate IDs, keywords, read-only tools, bounds and atomic persistence', (t) => {
  const { config } = fixture(t);
  for (const id of ['human', 'dwight', 'seclint-x', 'SecLint', 'a'.repeat(21), 'con', '../escape']) assert.throws(() => saveAgent(config, id, definition, { create: true }), { status: 400 });
  for (const patch of [{ tools: ['write'] }, { tools: [] }, { passKeyword: 'bad' }, { passKeyword: 'BLOCKED' }, { passKeyword: 'TEST_PASSED' }, { passKeyword: 'SAME', failKeyword: 'SAME' }, { instruction: 'x'.repeat(1001) }]) assert.throws(() => saveAgent(config, 'seclint', { ...definition, ...patch }, { create: true }), { status: 400 });
  saveAgent(config, 'seclint', definition, { create: true });
  assert.throws(() => saveAgent(config, 'seclint', definition, { create: true }), { status: 409 });
  assert.throws(() => saveAgent(config, 'other', { ...definition, passKeyword: 'SECLINT_PASSED' }, { create: true }), { status: 400 });
  for (let i = 1; i < 12; i++) saveAgent(config, `gate${i}`, definition, { create: true });
  assert.throws(() => saveAgent(config, 'overflow', definition, { create: true }), { status: 409 });
  assert.equal(fs.readdirSync(config.settingsDir).some((name) => name.endsWith('.tmp')), false);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(config.settingsDir, 'agents.json'))).agents).length, 12);
});
test('every load skips invalid hand-edited entries and workflows cannot execute them', (t) => {
  const { config, load } = fixture(t);
  fs.mkdirSync(config.settingsDir, { recursive: true });
  fs.writeFileSync(path.join(config.settingsDir, 'agents.json'), JSON.stringify({ v: 1, agents: { broken: { ...definition, tools: ['write'] }, seclint: definition, colliding: { ...definition, passKeyword: 'SECLINT_PASSED' } } }));
  const store = loadAgentsConfig(config.settingsDir);
  assert.deepEqual(Object.keys(store.agents), ['seclint']); assert.equal(store.warnings.length, 2);
  assert.throws(() => load({ flags: { gates: 'broken' } }), /broken/);
  assert.equal(agentCatalog(load()).warnings.length, 2);
});
test('settings model and thinking precedence and independent pinning', (t) => {
  const { config, load } = fixture(t);
  saveAgent(config, 'dwight', { model: { provider: 'saved', model: 'saved-model' }, thinking: 'low' });
  const saved = load().agents.dwight;
  assert.deepEqual(saved.modelSetting, { value: { provider: 'saved', model: 'saved-model' }, source: 'settings', pinned: false });
  assert.equal(load().agents.angela.modelSetting.source, 'none');
  const configured = load({ fileConfig: { agents: { dwight: { provider: 'config', model: 'config-model', thinking: 'high' } } } });
  assert.equal(configured.agents.dwight.modelSetting.source, 'config'); assert.equal(configured.agents.dwight.modelSetting.pinned, true);
  assert.throws(() => saveAgent(configured, 'dwight', { model: null }), { status: 409 });
  const env = load({ env: { SCRANTON_DWIGHT_PROVIDER: 'env', SCRANTON_DWIGHT_MODEL: 'env-model', SCRANTON_DWIGHT_THINKING: 'max' }, fileConfig: { agents: { dwight: { provider: 'config', model: 'config-model' } } } });
  assert.equal(env.agents.dwight.model, 'env-model'); assert.equal(env.agents.dwight.thinkingSetting.source, 'env');
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});
test('deterministic starter follows the current definition and resets without writing a prompt file', (t) => {
  const { config, load } = fixture(t);
  saveAgent(config, 'seclint', definition, { create: true });
  const prompt = resolvePrompt(load(), 'seclint');
  assert.equal(prompt.source, 'builtin'); assert.deepEqual(prompt.missingKeywords, []);
  assert.equal(prompt.text, prompt.builtinText); assert.match(prompt.text, /Security Lint/);
  assert.equal(fs.existsSync(path.join(config.promptsDir, 'seclint.md')), false);
  saveAgent(load(), 'seclint', { name: 'Updated' });
  assert.match(resolvePrompt(load(), 'seclint').text, /Updated/);
  assert.throws(() => deleteAgent(load(), 'angela'), { status: 400 });
  deleteAgent(load(), 'seclint'); assert.throws(() => resolvePrompt(load(), 'seclint'), { status: 404 });
});
test('CLI custom gates pass, retry with named combined report, and saved models reach child argv', async (t) => {
  const { config, dir, load } = fixture(t);
  saveAgent(config, 'seclint', { ...definition, model: { provider: 'fake', model: 'persisted' }, thinking: 'minimal' }, { create: true });
  const log = path.join(dir, 'children.jsonl');
  await exec(process.execPath, [path.resolve('bin/scranton.js'), 'demo', '--no-plan', '--delay', '0', '--scenario', 'changes_once', '--gates', 'oscar+seclint,angela', '--workspace', config.workspace, '--hive', config.hiveDir], { cwd: dir, env: isolationTestEnv({ FAKE_PI_LOG: log }), timeout: 30000 });
  const es = events(config), started = es[0];
  assert.equal(es.at(-1).status, 'success');
  assert.deepEqual(started.roles.map((r) => r.id), ['dwight', 'oscar', 'seclint', 'angela']);
  assert.match(started.roles.find((r) => r.id === 'seclint').definitionHash, /^[a-f0-9]{64}$/); assert.ok(started.prompts.seclint);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(config.hiveDir, 'state.json'))).agents), ['michael', 'dwight', 'oscar', 'hank', 'angela', 'seclint']);
  assert.match(fs.readFileSync(path.join(config.hiveDir, 'dwight-m1', 'inbox.md'), 'utf8'), /Security Lint's Static Auditor report/);
  const child = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).find((r) => r.role === 'seclint');
  assert.equal(child.argv[child.argv.indexOf('--model') + 1], 'persisted'); assert.equal(child.argv[child.argv.indexOf('--thinking') + 1], 'minimal');
  assert.equal(child.scranton.SCRANTON_PASS_KEYWORD, 'SECLINT_PASSED');
  deleteAgent(load(), 'seclint');
  await assert.rejects(exec(process.execPath, [path.resolve('bin/scranton.js'), 'demo', '--gates', 'seclint', '--hive', config.hiveDir], { cwd: dir, env: isolationTestEnv(), timeout: 10000 }), /seclint/);
});
test('gate own-keyword extraction rejects TEST_PASSED and definitions edited mid-run apply next run', async (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const received = [];
  let current = load({ flags: { trustedHost: true, gates: 'seclint' }, fileConfig: { pi: { command: [process.execPath, path.resolve('tools/fake-pi.js')] } } });
  for (const expected of ['Security Lint', 'Later']) {
    const o = new Orchestrator({ config: current, noPlan: true, onBreaker: 'abort', startRunner: (options) => {
      if (options.agentId === 'dwight') saveAgent(load(), 'seclint', { name: 'Later' });
      if (options.agentId === 'seclint') received.push(fs.readFileSync(options.systemPromptFile, 'utf8'));
      return startPi(options);
    } });
    assert.equal((await o.run('snapshot')).status, 'success');
    assert.match(received.at(-1), new RegExp(expected));
    assert.equal(events(current)[0].roles.at(-1).name, expected);
    current = load({ flags: { trustedHost: true, gates: 'seclint' }, fileConfig: { pi: { command: [process.execPath, path.resolve('tools/fake-pi.js')] } } });
  }
  current.maxFailedCycles = 1;
  const o = new Orchestrator({ config: current, noPlan: true, onBreaker: 'abort', extraEnv: { FAKE_PI_KEYWORD_ROLE: 'seclint', FAKE_PI_KEYWORD: 'TEST_PASSED' } });
  assert.equal((await o.run('reject foreign keyword')).status, 'aborted');
  const gate = events(current).find((e) => e.type === 'gate_result');
  assert.equal(gate.result, 'failed'); assert.equal(gate.keyword, null);

});

test('custom gate tools cannot be escalated by config; Windows fallback preserves allowlist', (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  assert.throws(() => load({ fileConfig: { agents: { seclint: { tools: ['write'] } } } }), /read-only tools/);
  assert.deepEqual(load({ platform: 'win32', hasBash: false }).agents.seclint.tools, ['read', 'grep', 'find', 'ls', 'powershell']);
});
test('atomic settings failure keeps the previous valid document and removes temporary file', (t) => {
  const { config } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const file = path.join(config.settingsDir, 'agents.json'), before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('rename denied'), { code: 'EIO' }); });
  assert.throws(() => saveAgent(config, 'seclint', { name: 'Changed' }), /rename denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(config.settingsDir), ['agents.json']);
});
test('real CLI saved models and list work for custom IDs; standalone custom invocation is clearly refused', async (t) => {
  const { config, dir, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const cli = (args) => exec(process.execPath, [path.resolve('bin/scranton.js'), ...args, '--hive', config.hiveDir], { cwd: dir, env: isolationTestEnv(), timeout: 10000 });
  await cli(['agent', 'set-model', 'seclint', '--provider', 'fake', '--model', 'saved', '--thinking', 'xhigh']);
  assert.equal(load().agents.seclint.model, 'saved'); assert.equal(load().agents.seclint.thinking, 'xhigh');
  assert.match((await cli(['agents'])).stdout, /seclint \| Security Lint \| Static Auditor \| gate \| fake\/saved \| settings \| builtin/);
  await cli(['agent', 'remove-model', 'seclint']); assert.equal(load().agents.seclint.model, null);
  await assert.rejects(cli(['agent', 'seclint', 'task']), /agent must be one of/);
});
test('legacy and five-role run snapshots publish only invoked definitions but always five built-in state keys', async (t) => {
  const { dir, load } = fixture(t);
  for (const gates of ['angela', 'oscar+hank,angela']) {
    const config = load({ flags: { trustedHost: true, gates, hive: path.join(dir, gates === 'angela' ? 'legacy' : 'five') }, fileConfig: { pi: { command: [process.execPath, path.resolve('tools/fake-pi.js')] } } });
    const o = new Orchestrator({ config, extraEnv: { FAKE_PI_DELAY_MS: '0' } });
    assert.equal((await o.run('shape')).status, 'success');
    const es = events(config), invoked = ['michael', 'dwight', ...gates.split(/[+,]/)];
    assert.deepEqual(es[0].roles.map((r) => r.id), invoked);
    assert.deepEqual(Object.keys(es[0].prompts), invoked);
    const state = JSON.parse(fs.readFileSync(path.join(config.hiveDir, 'state.json')));
    assert.deepEqual(state.roles, es[0].roles); assert.deepEqual(Object.keys(state.agents), ['michael', 'dwight', 'oscar', 'hank', 'angela']);
    if (gates === 'angela') assert.equal(es.some((e) => e.type === 'gate_result'), false);
  }
});

test('custom Docker model validation and fake Docker runner preserve verdict env and selected credentials only', async (t) => {
  const { WorktreeManager } = await import('../../src/core/worktree.js');
  const { prepareSandbox } = await import('../../src/core/sandbox.js');
  const { stagePrompt } = await import('../../src/core/prompts.js');
  const { config, load } = fixture(t);
  saveAgent(config, 'seclint', definition, { create: true });
  saveAgent(config, 'dwight', { model: { provider: 'openai', model: 'developer' } });
  const flags = { gates: 'seclint' };
  assert.throws(() => validateDockerModels(load({ flags }), ['dwight', 'seclint']), /seclint/);
  saveAgent(config, 'seclint', { model: { provider: 'openai', model: 'auditor' } });
  const current = load({ flags }); validateDockerModels(current, ['dwight', 'seclint']);
  const manager = new WorktreeManager({ workspace: current.workspace, hiveDir: current.hiveDir, runId: 'custom-docker' });
  fs.mkdirSync(current.workspace, { recursive: true });
  t.after(() => manager.close()); await manager.init();
  const checkout = await manager.createWorktree({ agent: 'seclint', milestoneId: 'm1' });
  const sessionDir = path.join(current.hiveDir, 'sessions', 'seclint'); fs.mkdirSync(sessionDir, { recursive: true });
  const systemPromptFile = stagePrompt(current, { dir: current.hiveDir }, 'seclint');
  const calls = [], minted = [];
  const execution = await prepareSandbox({ workspace: checkout.dir, sessionDir, systemPromptFile,
    instanceId: 'seclint-m1', runId: 'custom-docker', provider: current.agents.seclint.provider, agentTimeoutMinutes: 1,
    env: { SCRANTON_AGENT: 'seclint', SCRANTON_ROLE_KIND: 'gate', SCRANTON_PASS_KEYWORD: 'SECLINT_PASSED', SCRANTON_FAIL_KEYWORD: 'SECLINT_FAILED', ANTHROPIC_API_KEY: 'UNRELATED', REFRESH_TOKEN: 'NEVER_FORWARD' } }, {
      executable: path.resolve('.scratch/ca-fix-backend/fake-docker.exe'),
      run: async (_exe, args) => { calls.push(args); return ['info', 'image'].includes(args[0]) ? 'linux' : ''; },
      auth: { listAccounts: async () => [{ id: 'openai', kind: 'oauth', status: 'signed_in' }], mintAccessToken: async (provider, { minExpiryMs }) => { minted.push(provider); assert.equal(minExpiryMs, 11 * 60000); return 'FAKE_SHORT_TOKEN'; } }
    });
  assert.deepEqual(minted, ['openai']); assert.equal(execution.env.OPENAI_API_KEY, 'FAKE_SHORT_TOKEN');
  for (const key of ['SCRANTON_AGENT', 'SCRANTON_ROLE_KIND', 'SCRANTON_PASS_KEYWORD', 'SCRANTON_FAIL_KEYWORD']) assert.ok(execution.argsPrefix.includes(key));
  assert.equal(execution.env.SCRANTON_PASS_KEYWORD, 'SECLINT_PASSED');
  assert.equal(execution.env.REFRESH_TOKEN, undefined); assert.equal(execution.env.ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(execution.argsPrefix), /FAKE_SHORT_TOKEN|NEVER_FORWARD|UNRELATED/);
  assert.ok(!execution.argsPrefix.some((a) => a.includes(`source=${current.settingsDir},`) || a.includes(`source=${current.promptsDir},`)));
  assert.ok(execution.argsPrefix.includes(`type=bind,source=${systemPromptFile},target=/scranton/prompt.md,readonly`));
  await execution.cleanup(); assert.deepEqual(calls.map((a) => a[0]), ['info', 'image', 'rm', 'container']);
});

// Review round 1 regressions.
import { buildPiArgs } from '../../src/core/pi-command.js';
import { initialState, reduce } from '../../src/core/state.js';
import { createTerminalLog } from '../../src/core/log.js';
import { runDoctor } from '../../src/core/doctor.js';
import { prepareSandbox } from '../../src/core/sandbox.js';

test('review: instructions preserve normalized line breaks but labels stay single-line', (t) => {
  const { config, load } = fixture(t);
  saveAgent(config, 'seclint', { ...definition, name: 'Lint\nName', instruction: 'Check A\r\nCheck B\nCheck C\t\x00\r' }, { create: true });
  const role = load().roles.find((r) => r.id === 'seclint');
  assert.equal(role.instruction, 'Check A\nCheck B\nCheck C');
  assert.equal(role.name, 'LintName');
  assert.match(resolvePrompt(load(), 'seclint').text, /Check A\nCheck B\nCheck C/);
});

test('review: every gate refuses tool-changing extraArgs at config and launch; own tools follow extraArgs', (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const flags = ['--tools', '-t', '--exclude-tools', '-xt', '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--extension', '-e', '--'];
  for (const id of ['seclint', 'oscar', 'hank', 'angela']) {
    const agent = { ...load().agents[id], id, kind: 'gate' };
    for (const flag of flags) {
      assert.throws(() => load({ fileConfig: { agents: { [id]: { extraArgs: [flag, 'read,write'] } } } }), /tool-changing extraArgs/, `${id} ${flag} config`);
      assert.throws(() => buildPiArgs({ agent: { ...agent, extraArgs: [flag, 'read,write'] }, pi: config.pi }), /tool-changing extraArgs/, `${id} ${flag} launch`);
      assert.throws(() => buildPiArgs({ agent, pi: { ...config.pi, extraArgs: [flag, 'read,write'] } }), /tool-changing extraArgs/);
    }
    assert.throws(() => buildPiArgs({ agent: { ...agent, tools: ['write'] }, pi: config.pi }), /read-only tools/);
    for (const transport of ['rpc', 'json']) {
      const args = buildPiArgs({ agent, pi: config.pi, transport, inboxFile: 'inbox', sessionId: 'session', instanceId: 'instance', extensionFile: 'extension' });
      assert.deepEqual(transport === 'rpc' ? args.slice(-2) : args.slice(-4, -2), ['--tools', agent.tools.join(',')]);
      if (transport === 'json') assert.equal(args.at(-2), '@inbox');
    }
  }
});

test('review: startup failure always publishes empty roles and reducer clears stale roles', async (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const current = load({ flags: { trustedHost: true, gates: 'seclint' } });
  current.agents.dwight.skill = path.join(current.hiveDir, 'missing.md');
  current.agents.dwight.skillSource = 'config';
  const o = new Orchestrator({ config: current, noPlan: true });
  assert.equal((await o.run('fail before launch')).status, 'failed');
  assert.deepEqual(events(current)[0].roles, []);
  let state = reduce(initialState(), { type: 'run_started', roles: [{ id: 'seclint' }], ts: 'now', seq: 1 });
  state = reduce(state, { type: 'run_started', ts: 'later', seq: 2 });
  assert.deepEqual(state.roles, []);
  assert.deepEqual(Object.keys(state.agents), ['michael', 'dwight', 'oscar', 'hank', 'angela']);
});

test('review: definitionHash uses effective custom and built-in tools including Windows fallback', async (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const hashes = [];
  for (const options of [{ platform: 'linux', hasBash: true }, { platform: 'win32', hasBash: false }, { fileConfig: { agents: { seclint: { tools: ['read'] }, oscar: { tools: ['read'] } } } }]) {
    const current = load({ ...options, flags: { trustedHost: true, gates: 'oscar+seclint' } });
    // Capture the audit before preparation without starting any model.
    const es = [];
    const o = new Orchestrator({ config: current, noPlan: true, listener: (e) => es.push(e), startRunner: () => { throw Error('stop after audit'); } });
    await o.run('audit');
    hashes.push(Object.fromEntries(es[0].roles.map((r) => [r.id, r.definitionHash])));
  }
  for (const id of ['oscar', 'seclint']) {
    assert.notEqual(hashes[0][id], hashes[1][id], `${id} fallback must affect hash`);
    assert.notEqual(hashes[0][id], hashes[2][id], `${id} override must affect hash`);
  }
});

test('review: custom JSON gate has session directory before spawn and completes with fake pi', async (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const current = load({ flags: { trustedHost: true, gates: 'seclint' }, fileConfig: { execution: { isolation: 'shared', maxParallel: 1 }, pi: { transport: 'json', command: [process.execPath, path.resolve('tools/fake-pi.js')] } } });
  let gateSpawned = false;
  const o = new Orchestrator({ config: current, noPlan: true, extraEnv: { FAKE_PI_DELAY_MS: '0' }, startRunner: (options) => startPi({ ...options, onSpawn: (child) => {
    if (options.agentId === 'seclint') {
      gateSpawned = true;
      assert.equal(fs.existsSync(options.hive.sessionDir('seclint')), true, 'custom JSON session directory exists at spawn');
    }
  } }) });
  assert.equal((await o.run('JSON gate')).status, 'success');
  assert.equal(gateSpawned, true);
  assert.equal(events(current).find((e) => e.type === 'gate_result').keyword, 'SECLINT_PASSED');
});

test('review: CLI log uses sanitized custom names and resets on the next run', () => {
  let output = ''; const log = createTerminalLog({ stream: { write: (s) => output += s }, env: { NO_COLOR: '1' } });
  const send = (type, data) => log({ type, ts: '2026-01-01T00:00:00Z', ...data });
  send('run_started', { roles: [{ id: 'seclint', name: 'Li\nnt\x1b', builtin: false }] });
  send('hive_write', { from: 'dwight', to: 'seclint', kind: 'handoff', summary: '' });
  send('agent_finished', { agent: 'seclint', exitCode: 0, keyword: 'SECLINT_PASSED', durationMs: 1 });
  assert.match(output, /Dwight -> Lint/); assert.match(output, /Lint\s+finished \[SECLINT_PASSED\]/);
  assert.doesNotMatch(output, /seclint|\x1b/);
  output = ''; send('run_started', {}); send('agent_finished', { agent: 'seclint', exitCode: 0, durationMs: 1 });
  assert.match(output, /seclint\s+finished/);
});

test('review: doctor warns about invalid configured workflow instead of refusing configuration', async (t) => {
  const { load } = fixture(t);
  const config = load({ validateWorkflow: false, fileConfig: { workflow: { gates: [['missinggate']] }, pi: { command: [process.execPath, path.resolve('tools/fake-pi.js')] } } });
  let output = '';
  await runDoctor({ config, env: isolationTestEnv(), stdout: { write: (s) => output += s }, auth: { listAccounts: async () => [] } });
  assert.match(output, /\[warn\].*missinggate/);
});

test('review: orchestrator drives custom Docker preparation, argv, verdict and cleanup via fake Docker runner', async (t) => {
  const { config, load } = fixture(t); saveAgent(config, 'seclint', definition, { create: true });
  const current = load({ flags: { gates: 'seclint' }, fileConfig: { agents: { dwight: { provider: 'openai', model: 'fake' }, seclint: { provider: 'openai', model: 'fake' } }, pi: { command: [process.execPath, path.resolve('tools/fake-pi.js')] } } });
  const launches = [], calls = [];
  const o = new Orchestrator({ config: current, noPlan: true, onBreaker: 'abort', extraEnv: { FAKE_PI_DELAY_MS: '0' },
    prepareExecution: async (options) => {
      const launch = await prepareSandbox(options, { executable: path.join(current.hiveDir, 'fake-docker.exe'), run: async (_exe, args) => { calls.push(args); return ['info', 'image'].includes(args[0]) ? 'linux' : ''; }, auth: { listAccounts: async () => [], resolveDockerCredential: async () => ({ name: 'OPENAI_API_KEY', value: 'FAKE_DOCKER_KEY' }) } });
      launches.push({ options, launch }); return launch;
    },
    startRunner: (options) => {
      // The real RPC runner stages the inbox/extension; emulate only that staging and
      // run fake pi on the host after inspecting the exact Docker boundary.
      const done = (async () => {
        assert.equal(typeof options.execution, 'function', 'orchestrator must supply Docker execution');
        const launch = await options.execution({ env: options.extraEnv });
        try {
          const args = buildPiArgs({ agent: options.agentConfig, pi: options.pi, transport: 'rpc', extensionFile: launch.extensionFile });
          if (options.agentId === 'seclint') assert.deepEqual(args.slice(-2), ['--tools', options.agentConfig.tools.join(',')]);
          return await startPi({ ...options, execution: undefined }).done;
        } finally { await launch.cleanup(); }
      })();
      return { done, kill: async () => {}, steer: async () => ({ ok: true }) };
    }
  });
  // Preparation happens before the injected runner's RPC staging.
  assert.equal((await o.run('Docker boundary')).status, 'success');
  assert.deepEqual(launches.map((l) => l.options.instanceId), ['dwight-m1', 'seclint-m1']);
  const gate = launches[1];
  assert.equal(gate.launch.env.SCRANTON_PASS_KEYWORD, 'SECLINT_PASSED');
  assert.equal(gate.launch.env.SCRANTON_ROLE_KIND, 'gate');
  assert.ok(gate.launch.argsPrefix.includes(`type=bind,source=${gate.options.workspace},target=/workspace`));
  assert.equal(calls.filter((a) => a[0] === 'rm').length, 2);
  assert.equal(events(current).find((e) => e.type === 'gate_result').result, 'passed');
});
