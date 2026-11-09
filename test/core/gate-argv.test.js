import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from '../../src/core/config.js';
import { buildPiArgs } from '../../src/core/pi-command.js';
import { saveAgent } from '../../src/core/agents-config.js';
import { parseArgs } from '../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js';

function fixture(t) {
  const base = path.resolve('.scratch/ca-fix2'); fs.mkdirSync(base, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(base, 'argv-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const load = (fileConfig = {}) => loadConfig({ cwd, env: {}, platform: 'linux', hasBash: true, fileConfig });
  saveAgent(load(), 'seclint', { name: 'Lint', title: 'Auditor', instruction: 'Review boundaries.' }, { create: true });
  return load;
}
const hostile = [
  ...['--append-system-prompt', '--model', '--session', '--provider', '--api-key', '--system-prompt', '--name', '-n', '--session-id', '--fork', '--session-dir', '--models', '--thinking', '--mode', '--export', '--use-theme', '--tui-mode'].map((flag) => [flag]),
  ...['--tools', '-t', '--exclude-tools', '-xt', '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--extension', '-e', '--skill', '--prompt-template', '--theme', '--mcp', '--mcp-server', '--'].flatMap((flag) => [[flag], [flag, 'write'], [`${flag}=write`]]),
  ['--model', '--append-system-prompt'], ['--append-system-prompt', '--tools', 'write'],
  ['--unknown', 'value'], ['@file'], ['message'], ['--print'], ['-p'], ['--list-models'],
  ['--model=fake'], ['--model', ''], ['--approve'], ['-a']
];

test('gate argv hostile battery: config rejects or real pi parser retains exact lockdown in JSON, RPC and Docker', (t) => {
  const load = fixture(t);
  let checked = 0;
  for (const id of ['oscar', 'hank', 'angela', 'seclint']) {
    for (const extraArgs of hostile) for (const scope of ['pi', 'agent']) for (const mode of ['json', 'rpc', 'docker']) {
      const file = { pi: { minimalContext: false, ...(scope === 'pi' ? { extraArgs } : {}) }, agents: { [id]: scope === 'agent' ? { extraArgs } : {} } };
      try {
        const config = load(file);
        const agent = { ...config.agents[id], id, kind: 'gate' };
        const argv = buildPiArgs({ agent, pi: config.pi, transport: mode === 'json' ? 'json' : 'rpc', inboxFile: mode === 'docker' ? '/scranton/inbox.md' : 'inbox.md', sessionId: 'uuid', instanceId: 'gate-m1', extensionFile: mode === 'docker' ? '/scranton/extension.js' : 'managed-chat.js' });
        const parsed = parseArgs(argv);
        assert.deepEqual(parsed.tools, agent.tools, `${mode} ${scope} ${JSON.stringify(extraArgs)} must retain allowlist`);
        assert.equal(parsed.noMcp, true, 'MCP must always be disabled');
        assert.equal(parsed.noExtensions, true, 'extension discovery must always be disabled');
        assert.deepEqual(parsed.diagnostics, []);
        assert.equal(parsed.unknownFlags.size, 0);
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        assert.match(err.message, /extraArgs/);
      }
      checked++;
    }
  }
  t.diagnostic(`${hostile.length} hostile sequences; ${checked} role/scope/transport cases`);
});

test('gate launch validates independently, including split argument lists', (t) => {
  const config = fixture(t)();
  for (const extraArgs of hostile) {
    assert.throws(() => buildPiArgs({ agent: { ...config.agents.oscar, id: 'oscar', kind: 'gate', extraArgs }, pi: config.pi }), ConfigError, JSON.stringify(extraArgs));
  }
  assert.throws(() => buildPiArgs({ agent: { ...config.agents.oscar, kind: 'gate', extraArgs: ['fake'] }, pi: { ...config.pi, extraArgs: ['--model'] } }), ConfigError);
});

test('gate minimalContext false still disables MCP and discovered extensions; safe value flags parse correctly', (t) => {
  const config = fixture(t)({ pi: { minimalContext: false, extraArgs: ['--append-system-prompt', 'Review only', '--model', 'fake', '--session', 'session.jsonl', '--verbose'] } });
  for (const transport of ['json', 'rpc']) {
    const agent = { ...config.agents.oscar, kind: 'gate' };
    const argv = buildPiArgs({ agent, pi: config.pi, transport, inboxFile: 'inbox.md', extensionFile: 'managed-chat.js' });
    const parsed = parseArgs(argv);
    assert.deepEqual(parsed.tools, agent.tools);
    assert.equal(parsed.noMcp, true, 'MCP must always be disabled');
    assert.equal(parsed.noExtensions, true, 'extension discovery must always be disabled');
    assert.deepEqual(parsed.extensions, transport === 'rpc' ? ['managed-chat.js'] : undefined);
    assert.equal(parsed.model, 'fake'); assert.equal(parsed.session, 'session.jsonl');
    assert.deepEqual(parsed.appendSystemPrompt, ['Review only']);
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(transport === 'json' ? argv.slice(-4, -2) : argv.slice(-2), ['--tools', agent.tools.join(',')]);
  }
});

test('non-gate argv retains previous extraArgs and minimalContext behavior', (t) => {
  const config = fixture(t)();
  for (const id of ['michael', 'dwight']) {
    const agent = { ...config.agents[id], kind: id === 'michael' ? 'planner' : 'developer', extraArgs: ['--extension', 'custom.js'] };
    const args = buildPiArgs({ agent, pi: { extraArgs: ['--model'], minimalContext: false }, inboxFile: 'inbox' });
    assert.deepEqual(args, ['--mode', 'json', '--tools', agent.tools.join(','), '--model', '--extension', 'custom.js', '@inbox', 'Your Hive inbox message is attached. Do the work it describes and end your final message with exactly one status keyword on its own line, as your role instructions require.']);
  }
});

test('built-in gate tool errors name the configuration key on every load', (t) => {
  const load = fixture(t);
  for (const id of ['oscar', 'hank', 'angela']) {
    assert.throws(() => load({ agents: { [id]: { tools: ['write'] } } }), (err) => err instanceof ConfigError && err.message.includes(`agents.${id}.tools`) && err.message.includes('read-only tools'));
  }
});
