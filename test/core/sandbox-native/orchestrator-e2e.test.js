import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveSandboxHelper } from '../../../src/core/sandbox-native/index.js';

const quote = value => `'${value.replaceAll("'", "''")}'`;
const text = result => typeof result.content === 'string' ? result.content : result.content.map(block => block.text ?? '').join('\n');

test('default orchestrator sandbox enforces Windows writes through integration', { timeout: 120000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Requires the Windows native sandbox helper and mandatory integrity labels');
  const helper = resolveSandboxHelper();
  if (!helper) return t.skip('Native sandbox helper missing: checked src-tauri/binaries and cargo release output; run app:prepare separately');

  const base = path.resolve('.scratch/native-e2e');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'r-'));
  const workspace = path.join(dir, 'workspace');
  const credentials = path.join(dir, 'credentials');
  const outside = path.join(dir, 'outside.txt');
  const appdataCredentials = path.join(process.env.APPDATA, 'dev.scranton.desktop', 'credentials');
  const env = {
    SCRANTON_CREDENTIALS_DIR: credentials,
    PI_CODING_AGENT_DIR: path.join(dir, 'empty-import'),
    SCRANTON_ISOLATION_ROOT: path.join(dir, 'iso'),
    SCRANTON_SANDBOX_HELPER: helper,
    // Inject per-role scripted LLMs, not the canned scenario's simulated shell.
    SCRANTON_FAKE_MODE: '0', SCRANTON_FAKE_SCENARIO: '',
    DBOS_SYSTEM_DATABASE_URL: '', DBOS_DATABASE_URL: '',
    TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp'),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const folder of [workspace, credentials, env.PI_CODING_AGENT_DIR, env.TEMP]) fs.mkdirSync(folder);
  Object.assign(process.env, env);
  assert.equal(fs.existsSync(appdataCredentials), false, 'Precondition: real APPDATA credentials must be absent; never alter an existing user store');
  t.after(() => assert.equal(fs.existsSync(appdataCredentials), false, 'Orchestration must not create the real APPDATA credential directory'));

  const [{ loadConfig }, { Orchestrator }, { startAgent }, { createScriptedProvider, getModel }] = await Promise.all([
    import('../../../src/core/config.js'), import('../../../src/core/orchestrator.js'),
    import('../../../src/core/agent/index.js'), import('../../../src/core/llm/index.js'),
  ]);
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
  for (const key of Object.keys(gitEnv)) if (/^GIT_/i.test(key) && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete gitEnv[key];
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, env: gitEnv, windowsHide: true });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Sandbox end-to-end fixture\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Scranton Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Seed fixture']);

  const config = loadConfig({ cwd: dir, env: {}, fileConfig: {
    workspace, hiveDir: path.join(dir, 'hive'),
    execution: { sandbox: { mode: 'scranton' } },
  } });
  assert.equal(config.execution.isolation, 'worktree', 'Default native execution requires private worktrees');
  assert.ok(config.agents.dwight.tools.includes('powershell'), 'Windows native default must expose PowerShell');
  assert.ok(!config.agents.dwight.tools.includes('bash'), 'Windows Low must not select Git Bash');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'inside.txt'), 'native sandbox wrote this')",
    `try { [System.IO.File]::WriteAllText(${quote(outside)}, 'escape'); Write-Output 'OUTSIDE_WRITE_SUCCEEDED'; exit 91 }`,
    "catch { Write-Output ('OUTSIDE_WRITE_DENIED: ' + $_.Exception.ToString()); exit 23 }",
  ].join('\n');
  const providers = new Map();
  const orchestrator = new Orchestrator({ config, noPlan: true, onBreaker: 'abort',
    startRunner: options => {
      const turns = options.agentId === 'dwight' ? [
        { toolCalls: [{ id: 'boundary', name: 'powershell', arguments: { command } }] },
        { text: 'Boundary probe complete.\n[TASK_COMPLETE]' },
      ] : [
        { toolCalls: [{ id: 'verify', name: 'read', arguments: { path: 'inside.txt' } }] },
        { text: 'Checked the sandbox artifact.\n[TEST_PASSED]' },
      ];
      const llm = createScriptedProvider(turns);
      providers.set(options.agentId, llm);
      return startAgent({ ...options, llm, model: getModel('openai', 'gpt-4o') });
    },
  });
  const started = performance.now();
  const result = await orchestrator.run('Write an inside artifact and verify the native sandbox denies an outside write');
  t.diagnostic(`Real orchestrator run: ${(performance.now() - started).toFixed(0)} ms`);
  const toolResult = providers.get('dwight')?.calls[1]?.context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'boundary');
  t.diagnostic(`PowerShell result: ${toolResult ? text(toolResult) : 'No tool result returned'}`);
  assert.equal(result.status, 'success', `Real native orchestration failed: ${result.summary}`);
  assert.equal(result.cleanupComplete, true, 'Native sandbox disposal must complete');
  assert.equal(fs.existsSync(path.join(workspace, 'inside.txt')), true, `Shell-created artifact must reach the integration target; tool result: ${toolResult ? text(toolResult) : 'missing'}`);
  assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'native sandbox wrote this');
  assert.equal(fs.existsSync(outside), false, 'Native sandbox escape: PowerShell wrote outside its private worktree');
  assert.ok(toolResult, 'The real PowerShell result must return to the scripted model');
  assert.equal(toolResult.isError, true, 'The denied write must produce an agent-visible tool error');
  assert.match(text(toolResult), /OUTSIDE_WRITE_DENIED:/, 'PowerShell must attempt the outside write and report denial');
  assert.match(text(toolResult), /UnauthorizedAccessException|access.*denied|Zugriff.*verweigert/i, 'Denial must be an OS permission error, not a missing tool or syntax error');
  const qaResult = providers.get('angela').calls[1]?.context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'verify');
  assert.ok(qaResult && !qaResult.isError, 'QA must read the artifact in its real private checkout');
  assert.match(text(qaResult), /native sandbox wrote this/);
  assert.equal(fs.existsSync(path.join(workspace, '.scranton-sandbox-owned')), false, 'Ownership marker must not leak into the integration target');
  assert.ok(!orchestrator.worktrees.changedFiles({ milestoneId: 'm1' }).includes('.scranton-sandbox-owned'), 'Ownership marker must not enter the integrated snapshot');
  assert.equal(fs.existsSync(appdataCredentials), false, 'Real APPDATA credentials must remain absent');
});
