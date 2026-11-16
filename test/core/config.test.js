import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, defaultTools, loadConfig, loadDotEnv, parseCommandSpec } from '../../src/core/config.js';
import { tempDir } from './helpers.js';

const base = { cwd: path.resolve('some', 'project'), hasBash: true };

test('defaults', () => {
  const c = loadConfig({ ...base, env: {}, fileConfig: {} });
  assert.equal(c.maxFailedCycles, 3);
  assert.equal(c.agentTimeoutMinutes, 20);
  assert.equal(c.workspace, path.join(base.cwd, 'workspace'));
  assert.equal(c.hiveDir, path.join(base.cwd, 'hive'));
  assert.equal(c.pi.command, null);
  assert.equal(c.pi.minimalContext, true);
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
  const c = loadConfig({ ...base, platform: 'win32', hasBash: false, env: {}, fileConfig: { agents: { angela: { tools: 'read,bash' } } } });
  assert.deepEqual(c.agents.angela.tools, ['read', 'bash']);
  assert.ok(c.agents.dwight.tools.includes('powershell'));
});

test('pi command: env wins over file; JSON array or whitespace-separated string', () => {
  assert.deepEqual(parseCommandSpec('["C:\\\\Program Files\\\\pi.exe","--x"]'), ['C:\\Program Files\\pi.exe', '--x']);
  assert.deepEqual(parseCommandSpec('node  tools/fake-pi.js'), ['node', 'tools/fake-pi.js']);
  assert.equal(parseCommandSpec('  '), null);
  assert.throws(() => parseCommandSpec('[1,2]'), ConfigError);
  assert.throws(() => parseCommandSpec('[oops'), ConfigError);
  const c = loadConfig({ ...base, env: { SCRANTON_PI_COMMAND: 'env-pi' }, fileConfig: { pi: { command: ['file-pi'] } } });
  assert.deepEqual(c.pi.command, ['env-pi']);
  assert.equal(c.pi.commandSource, 'env');
  const f = loadConfig({ ...base, env: {}, fileConfig: { pi: { command: ['file-pi'], extraArgs: ['--offline'] } } });
  assert.deepEqual(f.pi.command, ['file-pi']);
  assert.equal(f.pi.commandSource, 'config');
  assert.deepEqual(f.pi.extraArgs, ['--offline']);
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

test('sandbox defaults to host while explicit Docker and host acknowledgements remain enforced', () => {
  const config = (fileConfig = {}, flags = {}) => loadConfig({ ...base, env: {}, fileConfig, flags });
  assert.equal(config().execution.sandbox.mode, 'host');
  assert.equal(config().execution.isolation, 'worktree');
  assert.equal(config({ execution: { sandbox: { mode: 'docker' } } }).execution.sandbox.mode, 'docker');
  assert.equal(config({}, { sandbox: 'docker' }).execution.sandbox.mode, 'docker');
  assert.equal(config({ execution: { sandbox: { mode: 'docker' } } }, { trustedHost: true }).execution.sandbox.mode, 'host');
  assert.throws(() => config({}, { sandbox: 'host' }), /requires --trusted-host/);
  assert.equal(config({}, { sandbox: 'host', trustedHost: true }).execution.sandbox.mode, 'host');
  assert.throws(() => config({ execution: { isolation: 'shared', maxParallel: 1 } }), /requires explicit trusted-host/);
});
