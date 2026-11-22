import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../../src/core/config.js';
import { saveAgent } from '../../src/core/agents-config.js';
import { fakeConfig, tempDir } from './helpers.js';

for (const id of ['oscar', 'hank', 'angela', 'seclint']) test(`${id}: gates cannot receive write/edit or Pi arguments`, t => {
  const config = fakeConfig(tempDir(t));
  saveAgent(config, 'seclint', {name: 'Lint', title: 'Auditor', instruction: 'Review boundaries.'}, {create: true});
  const load = agents => loadConfig({cwd: config.cwd, env: {}, fileConfig: {hiveDir: config.hiveDir, agents}});
  for (const tool of ['write', 'edit']) assert.throws(() => load({[id]: {tools: [tool]}}), /read-only tools/);
  for (const extraArgs of [[], ['--tools', 'write'], ['--model', 'fake'], null]) assert.throws(() => load({[id]: {extraArgs}}), err => err instanceof ConfigError && err.message.includes(`agents.${id}.extraArgs`));
  const effective = load({}).agents[id];
  assert.ok(!effective.tools.includes('write') && !effective.tools.includes('edit'));
});

test('persistent settings reject extraArgs with an actionable diagnostic', t => {
  const config = fakeConfig(tempDir(t));
  assert.throws(() => saveAgent(config, 'angela', {extraArgs: []}), /agents.angela.extraArgs is no longer supported/);
});
