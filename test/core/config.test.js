import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, defaultTools, loadConfig, loadDotEnv, parseCommandSpec } from '../../src/core/config.js';
import { tempDir } from './helpers.js';

const base = { cwd: path.resolve('some', 'project'), platform: 'linux', hasBash: true };

test('defaults', () => {
  const c = loadConfig({ ...base, env: {}, fileConfig: {} });
  assert.equal(c.maxFailedCycles, 3);
  assert.equal(c.agentTimeoutMinutes, 20);
  assert.equal(c.workspace, path.join(base.cwd, 'workspace'));
  assert.equal(c.hiveDir, path.join(base.cwd, 'hive'));
  assert.equal(c.pi, undefined);
  assert.equal(c.execution.sandbox.mode, 'scranton');
  assert.equal(c.execution.sandbox.network, 'allow');
  assert.equal(c.agents.dwight.model, null);
  assert.ok(c.agents.michael.skill.endsWith(path.join('agents', 'michael', 'SKILL.md')));
});

test('precedence: flags > env > file > defaults', () => {
  const fileConfig = { maxFailedCycles: 5, workspace: './from-file', agents: { dwight: { model: 'file-model', thinking: 'low' } } };
  let c = loadConfig({ ...base, env: {}, fileConfig });
  assert.equal(c.maxFailedCycles, 5);
  assert.equal(c.workspace, path.join(base.cwd, 'from-file'));
  assert.equal(c.agents.dwight.model, 'file-model');

  const env = { SCRANTON_MAX_FAILED_CYCLES: '4', SCRANTON_WORKSPACE: 'from-env', SCRANTON_DWIGHT_MODEL: 'env-model', SCRANTON_HIVE: 'hive-env' };
  c = loadConfig({ ...base, env, fileConfig });
  assert.equal(c.maxFailedCycles, 4);
  assert.equal(c.workspace, path.join(base.cwd, 'from-env'));
  assert.equal(c.hiveDir, path.join(base.cwd, 'hive-env'));
  assert.equal(c.agents.dwight.model, 'env-model');
  assert.equal(c.agents.dwight.thinking, 'low');

  c = loadConfig({ ...base, env, fileConfig, flags: { maxCycles: '2', workspace: 'from-flag', hive: 'hive-flag', timeoutMin: '7' } });
  assert.equal(c.maxFailedCycles, 2);
  assert.equal(c.workspace, path.join(base.cwd, 'from-flag'));
  assert.equal(c.hiveDir, path.join(base.cwd, 'hive-flag'));
  assert.equal(c.agentTimeoutMinutes, 7);
});

test('per-agent env variables: provider, model, thinking', () => {
  const env = { SCRANTON_ANGELA_PROVIDER: 'ollama', SCRANTON_ANGELA_MODEL: 'qwen2.5-coder:7b', SCRANTON_ANGELA_THINKING: 'high' };
  const c = loadConfig({ ...base, env, fileConfig: {} });
  assert.deepEqual([c.agents.angela.provider, c.agents.angela.model, c.agents.angela.thinking], ['ollama', 'qwen2.5-coder:7b', 'high']);
  assert.equal(c.agents.dwight.model, null);
});

test('empty env values count as unset', () => {
  const c = loadConfig({ ...base, env: { SCRANTON_MAX_FAILED_CYCLES: '', SCRANTON_DWIGHT_MODEL: '' }, fileConfig: { maxFailedCycles: 6 } });
  assert.equal(c.maxFailedCycles, 6);
  assert.equal(c.agents.dwight.model, null);
});

test('invalid values are rejected with a clear message', () => {
  assert.throws(() => loadConfig({ ...base, env: { SCRANTON_MAX_FAILED_CYCLES: 'abc' }, fileConfig: {} }), ConfigError);
  assert.throws(() => loadConfig({ ...base, env: {}, fileConfig: {}, flags: { maxCycles: '0' } }), /positive integer/);
  assert.throws(() => loadConfig({ ...base, env: { SCRANTON_DWIGHT_THINKING: 'ultra' }, fileConfig: {} }), /thinking level/);
});

test('a provider without a model is dropped with a warning', () => {
  const c = loadConfig({ ...base, env: { SCRANTON_DWIGHT_PROVIDER: 'openai' }, fileConfig: {} });
  assert.equal(c.agents.dwight.provider, null);
  assert.match(c.warnings.join('\n'), /dwight.*provider "openai".*without a model/);
});

test('default tools: Angela is read-only by allowlist, Michael plans only', () => {
  const c = loadConfig({ ...base, env: {}, fileConfig: {} });
  for (const forbidden of ['write', 'edit']) {
    assert.ok(!c.agents.angela.tools.includes(forbidden));
    assert.ok(!c.agents.michael.tools.includes(forbidden));
  }
  assert.ok(!c.agents.michael.tools.includes('bash'));
  assert.ok(c.agents.angela.tools.includes('bash'));
  assert.ok(['edit', 'write', 'bash'].every((t) => c.agents.dwight.tools.includes(t)));
});

test('tools can be overridden; windows without bash falls back to powershell only for defaults', () => {
  assert.ok(defaultTools('dwight', { platform: 'win32', hasBash: false }).includes('powershell'));
  assert.ok(!defaultTools('dwight', { platform: 'win32', hasBash: false }).includes('bash'));
  assert.ok(defaultTools('dwight', { platform: 'win32', hasBash: true }).includes('bash'));
  const c = loadConfig({ ...base, platform: 'win32', hasBash: false, env: {}, fileConfig: { execution: {sandbox: {mode: 'host'}}, agents: { angela: { tools: 'read,bash' } } } });
  assert.deepEqual(c.agents.angela.tools, ['read', 'bash']);
  assert.ok(c.agents.dwight.tools.includes('powershell'));
});

test('legacy Pi keys and command env are rejected even when empty', () => {
  for (const pi of [null, {}, {command: null}, {extraArgs: []}, {transport: 'rpc'}, {minimalContext: false}]) assert.throws(() => loadConfig({...base, env: {}, fileConfig: {pi}}), /key "pi" is no longer supported/);
  for (const value of ['', 'node fake.js']) assert.throws(() => loadConfig({...base, env: {SCRANTON_PI_COMMAND: value}, fileConfig: {}}), /SCRANTON_PI_COMMAND is no longer supported/);
  for (const id of ['michael', 'dwight', 'angela', 'unknown']) assert.throws(() => loadConfig({...base, env: {}, fileConfig: {agents: {[id]: {extraArgs: []}}}}), /extraArgs is no longer supported/);
  assert.doesNotThrow(() => loadConfig({...base, env: {PI_CODING_AGENT_DIR: 'import-only'}, fileConfig: {}}));
});

test('network and approvals validate strictly', () => {
  const load = fileConfig => loadConfig({...base, env: {}, fileConfig});
  assert.equal(load({execution: {sandbox: {network: 'bridge'}}}).execution.sandbox.network, 'allow');
  for (const network of [false, 'bad', 1]) assert.throws(() => load({execution: {sandbox: {network}}}), /network/);
  for (const approvals of [{tools: ['unknown']}, {tools: 'write'}, {tools: [], timeoutSeconds: 0}, {tools: [], timeoutSeconds: '60'}]) assert.throws(() => load({approvals}), /approvals/);
  assert.deepEqual(load({approvals: {tools: ['write']}}).approvals, {tools: ['write'], timeoutSeconds: 600});
});

test('reads scranton.config.json from cwd; relative paths resolve against the file', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'conf'));
  fs.writeFileSync(path.join(dir, 'conf', 'my.json'), JSON.stringify({ workspace: 'ws', maxFailedCycles: 9 }));
  const c = loadConfig({ cwd: dir, env: {}, flags: { config: 'conf/my.json' }, hasBash: true });
  assert.equal(c.workspace, path.join(dir, 'conf', 'ws'));
  assert.equal(c.maxFailedCycles, 9);
  fs.writeFileSync(path.join(dir, 'scranton.config.json'), JSON.stringify({ maxFailedCycles: 8 }));
  assert.equal(loadConfig({ cwd: dir, env: {}, hasBash: true }).maxFailedCycles, 8);
  assert.throws(() => loadConfig({ cwd: dir, env: {}, flags: { config: 'missing.json' } }), /not found/);
});

test('loadDotEnv loads ./.env when present and returns null otherwise', (t) => {
  const dir = tempDir(t);
  assert.equal(loadDotEnv(dir, () => assert.fail('must not load')), null);
  fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
  let loaded = null;
  assert.equal(loadDotEnv(dir, (f) => (loaded = f)), path.join(dir, '.env'));
  assert.equal(loaded, path.join(dir, '.env'));
});

test('dynamic replanning is disabled and a configured budget warns instead of claiming support', () => {
  const c = loadConfig({ ...base, env: {}, fileConfig: { execution: { maxReplans: 2 } } });
  assert.equal(c.execution.maxReplans, 0);
  assert.match(c.warnings.join(' '), /maxReplans is unsupported and ignored/);
});

test('legacy shared execution cannot claim Docker isolation', () => {
  assert.throws(() => loadConfig({ ...base, env: {}, fileConfig: { execution: {
    maxParallel: 1, isolation: 'shared', sandbox: { mode: 'docker' }
  } } }), /Docker requires worktree isolation/);
  const c = loadConfig({ ...base, env: {}, flags: { trustedHost: true }, fileConfig: { execution: { maxParallel: 1, isolation: 'shared' } } });
  assert.equal(c.execution.sandbox.mode, 'host');
});

test('registry data and maxConcurrentRuns follow flags, environment, file and defaults', () => {
  assert.equal(loadConfig({ ...base, env: {}, fileConfig: {} }).maxConcurrentRuns, 4);
  const fileConfig = { dataDir: 'file-data', maxConcurrentRuns: 7 };
  let c = loadConfig({ ...base, env: {}, fileConfig });
  assert.equal(c.dataDir, path.join(base.cwd, 'file-data')); assert.equal(c.maxConcurrentRuns, 7);
  c = loadConfig({ ...base, env: { SCRANTON_DATA: 'env-data', SCRANTON_MAX_RUNS: '2' }, fileConfig, flags: { data: 'flag-data' } });
  assert.equal(c.dataDir, path.join(base.cwd, 'flag-data')); assert.equal(c.maxConcurrentRuns, 2);
  assert.throws(() => loadConfig({ ...base, env: { SCRANTON_MAX_RUNS: '0' }, fileConfig: {} }), /maxConcurrentRuns/);
});

test('sandbox defaults to scranton while explicit Docker and host acknowledgements remain enforced', () => {
  const config = (fileConfig = {}, flags = {}) => loadConfig({ ...base, env: {}, fileConfig, flags });
  assert.equal(config().execution.sandbox.mode, 'scranton');
  assert.equal(config().execution.isolation, 'worktree');
  assert.equal(config({ execution: { sandbox: { mode: 'docker' } } }).execution.sandbox.mode, 'docker');
  assert.equal(config({}, { sandbox: 'docker' }).execution.sandbox.mode, 'docker');
  assert.equal(config({ execution: { sandbox: { mode: 'docker' } } }, { trustedHost: true }).execution.sandbox.mode, 'host');
  assert.throws(() => config({}, {trustedHost: true, sandbox: 'docker'}), /--trusted-host conflicts with --sandbox docker/);
  assert.throws(() => config({}, { sandbox: 'host' }), /requires --trusted-host/);
  assert.equal(config({}, { sandbox: 'host', trustedHost: true }).execution.sandbox.mode, 'host');
  assert.throws(() => config({ execution: { isolation: 'shared', maxParallel: 1 } }), /requires explicit trusted-host/);
});

for (const hasBash of [true, false]) test('Windows native sandbox defaults to PowerShell with Git Bash ' + hasBash, () => {
  const config = loadConfig({...base, env: {}, platform: 'win32', hasBash, fileConfig: {}});
  for (const id of ['dwight', 'angela', 'oscar', 'hank']) {
    assert.deepEqual(config.agents[id].tools, defaultTools(id, {platform: 'win32', hasBash: false}));
    assert.ok(config.agents[id].tools.includes('powershell'));
    assert.ok(!config.agents[id].tools.includes('bash'));
  }
  assert.deepEqual(config.agents.michael.tools, ['read', 'grep', 'find', 'ls']);
});
test('explicit Windows native bash is refused with role and alternatives, never silently rewritten', () => {
  for (const id of ['dwight', 'angela', 'oscar', 'hank']) {
    const fileConfig = {agents: {[id]: {tools: ['read', 'bash']}}};
    assert.throws(() => loadConfig({...base, env: {}, platform: 'win32', fileConfig}), new RegExp('agents.' + id + '.tools: bash.*powershell.*--sandbox docker.*--sandbox host'));
    for (const mode of ['host', 'docker']) {
      const c = loadConfig({...base, env: {}, platform: 'win32', fileConfig: {...fileConfig, execution: {sandbox: {mode}}}});
      assert.deepEqual(c.agents[id].tools, ['read', 'bash']);
    }
  }
  const c = loadConfig({...base, env: {}, platform: 'win32', fileConfig: {agents: {dwight: {tools: ['write', 'powershell']}, angela: {tools: ['read']}}}});
  assert.deepEqual(c.agents.dwight.tools, ['write', 'powershell']); assert.deepEqual(c.agents.angela.tools, ['read']);
});
test('approval timeouts are bounded integer seconds, preventing timer overflow', () => {
  for (const timeoutSeconds of [0, -1, 1.5, 86401, 2147483647, Infinity, NaN, '600']) assert.throws(() => loadConfig({...base, env: {}, fileConfig: {approvals: {tools: [], timeoutSeconds}}}), /integer from 1 to 86400/);
  for (const timeoutSeconds of [1, 600, 86400]) assert.equal(loadConfig({...base, env: {}, fileConfig: {approvals: {tools: [], timeoutSeconds}}}).approvals.timeoutSeconds, timeoutSeconds);
});

for (const hasBash of [false, true]) test(`Docker defaults use container bash on Windows with host Bash ${hasBash}`, t => {
  const config = loadConfig({cwd: tempDir(t), env: {}, platform: 'win32', hasBash, fileConfig: {execution: {sandbox: {mode: 'docker'}}}});
  for (const id of ['dwight', 'angela', 'oscar', 'hank']) {
    assert.ok(config.agents[id].tools.includes('bash'));
    assert.ok(!config.agents[id].tools.includes('powershell'));
  }
});

test('Docker rejects explicitly configured PowerShell with the role name', t => {
  const cwd = tempDir(t);
  for (const platform of ['win32', 'linux']) for (const id of ['michael', 'dwight', 'angela', 'oscar', 'hank']) {
    assert.throws(() => loadConfig({cwd, env: {}, platform, hasBash: false, fileConfig: {
      execution: {sandbox: {mode: 'docker'}}, agents: {[id]: {tools: ['read', 'powershell']}}
    }}), new RegExp(`agents.${id}.tools: powershell.*Docker.*bash`));
  }
});

test('Windows native network none fails at config load for file and flag options', t => {
  const options = {cwd: tempDir(t), env: {}, hasBash: false, platform: 'win32'};
  assert.throws(() => loadConfig({...options, fileConfig: {execution: {sandbox: {network: 'none'}}}}), /Windows Scranton sandbox cannot block network.*--sandbox docker/);
  assert.throws(() => loadConfig({...options, fileConfig: {}, flags: {sandbox: 'scranton', sandboxNetwork: 'none'}}), /Windows Scranton sandbox cannot block network.*--sandbox docker/);
  for (const mode of ['docker', 'host']) assert.doesNotThrow(() => loadConfig({...options, fileConfig: {execution: {sandbox: {mode, network: 'none'}}}}));
  for (const platform of ['linux', 'darwin']) assert.doesNotThrow(() => loadConfig({...options, platform, fileConfig: {execution: {sandbox: {mode: 'scranton', network: 'none'}}}}));
});

test('generic command parsing no longer names a retired Pi setting', () => {
  assert.throws(() => parseCommandSpec('[broken'), /command is not valid JSON/);
});

test('custom Docker gate defaults retain bash and PowerShell overrides are rejected', t => {
  const cwd = tempDir(t), settingsDir = path.join(cwd, 'settings');
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(path.join(settingsDir, 'agents.json'), JSON.stringify({v: 1, agents: {reviewer: {
    name: 'Reviewer', title: 'Review', instruction: 'Review without edits.', tools: ['read', 'bash']
  }}}));
  const options = {cwd, env: {SCRANTON_SETTINGS_DIR: settingsDir}, platform: 'win32', hasBash: false};
  const fileConfig = {execution: {sandbox: {mode: 'docker'}}};
  assert.deepEqual(loadConfig({...options, fileConfig}).agents.reviewer.tools, ['read', 'bash']);
  assert.throws(() => loadConfig({...options, fileConfig: {...fileConfig, agents: {reviewer: {tools: ['powershell']}}}}), /agents.reviewer.tools: powershell.*Docker.*bash/);
});
