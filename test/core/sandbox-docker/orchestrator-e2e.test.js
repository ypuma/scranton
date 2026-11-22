import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { available, createSandbox } from '../../../src/core/sandbox-docker/index.js';

const text = result => typeof result.content === 'string' ? result.content : result.content.map(block => block.text ?? '').join('\n');

test('real Docker orchestrator isolates tools and survives command timeout', { timeout: 180000 }, async t => {
  const status = await available();
  if (!status.available) return t.skip(status.reason);
  const base = path.resolve('.scratch/docker-verification/e2e');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'r-'));
  const workspace = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside.txt');
  const env = {
    SCRANTON_CREDENTIALS_DIR: path.join(dir, 'credentials'),
    PI_CODING_AGENT_DIR: path.join(dir, 'empty-import'),
    SCRANTON_ISOLATION_ROOT: path.join(dir, 'iso'),
    SCRANTON_FAKE_MODE: '0', SCRANTON_FAKE_SCENARIO: '',
    DBOS_SYSTEM_DATABASE_URL: '', DBOS_DATABASE_URL: '',
    OPENAI_API_KEY: 'docker-e2e-secret-sentinel',
    SCRANTON_E2E_PRIVATE: 'docker-e2e-private-sentinel',
    TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp'),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const sandboxes = [];
  t.after(async () => {
    try { await Promise.all(sandboxes.map(sandbox => sandbox.dispose())); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const folder of [workspace, env.SCRANTON_CREDENTIALS_DIR, env.PI_CODING_AGENT_DIR, env.TEMP]) fs.mkdirSync(folder);
  Object.assign(process.env, env);
  const [{ loadConfig }, { Orchestrator }, { startAgent }, { createScriptedProvider, getModel }] = await Promise.all([
    import('../../../src/core/config.js'), import('../../../src/core/orchestrator.js'),
    import('../../../src/core/agent/index.js'), import('../../../src/core/llm/index.js'),
  ]);
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  for (const key of Object.keys(gitEnv)) if (/^GIT_/i.test(key) && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete gitEnv[key];
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, env: gitEnv, windowsHide: true });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Docker end-to-end fixture\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Scranton Test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'Seed fixture']);
  if (process.platform !== 'win32') fs.chmodSync(workspace, 0o777);

  const config = loadConfig({ cwd: dir, env: {}, fileConfig: {
    workspace, hiveDir: path.join(dir, 'hive'),
    execution: { maxParallel: 1, sandbox: { mode: 'docker', network: 'none' } },
  } });
  const probes = [
    { id: 'boundary', command: 'set -eu; printf "docker wrote this" > inside.txt; if touch /outside.txt; then exit 91; fi; if echo escape > /workspace/.git; then exit 92; fi; echo OUTSIDE_WRITE_DENIED' },
    { id: 'timeout', command: 'sleep 30 & pid=$!; echo "$pid" > /tmp/timed-out.pid; wait "$pid"; touch timeout-escaped.txt', timeout: 2 },
    { id: 'after-timeout', command: `set -eu; test -f /tmp/timed-out.pid; node -e 'const fs=require("fs"); const pid=fs.readFileSync("/tmp/timed-out.pid","utf8").trim(); try { const stat=fs.readFileSync("/proc/"+pid+"/stat","utf8"); if(stat.split(") ").pop()[0]!=="Z") process.exit(93); } catch(e) { if(e.code!=="ENOENT") throw e; }'; echo CONTAINER_STILL_USABLE` },
    { id: 'network', command: `node -e 'const os=require("os"),net=require("net"); if(Object.keys(os.networkInterfaces()).some(n=>n!=="lo")) process.exit(94); const socket=net.connect({host:"1.1.1.1",port:443}); socket.setTimeout(3000,()=>{socket.destroy();process.exit(95)}); socket.on("connect",()=>process.exit(96)); socket.on("error",e=>{if(e.code!=="ENETUNREACH") process.exit(97); else console.log("NETWORK_UNREACHABLE")});'` },
    { id: 'env', command: 'env' },
  ];
  const providers = new Map();
  const orchestrator = new Orchestrator({ config, noPlan: true, onBreaker: 'abort',
    dockerSandboxFactory(settings) {
      const sandbox = createSandbox(settings);
      sandboxes.push(sandbox);
      return sandbox;
    },
    startRunner(options) {
      const turns = options.agentId === 'dwight' ? [
        ...probes.map(({ id, ...args }) => ({ toolCalls: [{ id, name: 'bash', arguments: args }] })),
        { text: 'Docker boundary probes complete.\n[TASK_COMPLETE]' },
      ] : [
        { toolCalls: [{ id: 'verify', name: 'read', arguments: { path: 'inside.txt' } }] },
        { text: 'Checked the Docker artifact.\n[TEST_PASSED]' },
      ];
      const llm = createScriptedProvider(turns);
      providers.set(options.agentId, llm);
      return startAgent({ ...options, llm, model: getModel('openai', 'gpt-4o') });
    },
  });
  const result = await orchestrator.run('Write an artifact and verify Docker tool isolation, cancellation and cleanup');
  assert.equal(result.status, 'success', result.summary);
  assert.equal(result.cleanupComplete, true);
  const messages = providers.get('dwight').calls.at(-1).context.messages;
  const output = id => {
    const message = messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
    assert.ok(message, `Missing real tool result: ${id}`);
    return message;
  };
  assert.equal(output('boundary').isError, false, text(output('boundary')));
  assert.match(text(output('boundary')), /OUTSIDE_WRITE_DENIED/);
  assert.equal(output('timeout').isError, true);
  assert.match(text(output('timeout')), /timed out/);
  assert.equal(output('after-timeout').isError, false, text(output('after-timeout')));
  assert.match(text(output('after-timeout')), /CONTAINER_STILL_USABLE/);
  assert.equal(output('network').isError, false, text(output('network')));
  assert.match(text(output('network')), /NETWORK_UNREACHABLE/);
  assert.equal(output('env').isError, false);
  const containerEnv = text(output('env'));
  assert.doesNotMatch(containerEnv, /docker-e2e-(?:secret|private)-sentinel|API_?KEY|TOKEN|SECRET|PASSWORD|SCRANTON_|PI_CODING_AGENT_DIR|DBOS_|DATABASE_URL/i);
  assert.match(containerEnv, /^HOME=\/tmp$/m);
  assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'docker wrote this');
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.existsSync(path.join(workspace, 'timeout-escaped.txt')), false);
  const qa = providers.get('angela').calls.at(-1).context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'verify');
  assert.ok(qa && !qa.isError);
  assert.match(text(qa), /docker wrote this/);
  assert.equal(sandboxes.length, 2, 'Developer and QA each use a real container');
  const remaining = execFileSync('docker', ['ps', '-a', '--filter', `label=scranton.run=${orchestrator.runId}`, '--format', '{{.Names}}'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(remaining, '', 'dispose must leave no run-labelled containers');
  for (const sandbox of sandboxes) {
    assert.equal(execFileSync('docker', ['ps', '-a', '--filter', `name=^/${sandbox.containerName}$`, '--format', '{{.ID}}'], { encoding: 'utf8', windowsHide: true }).trim(), '');
    await sandbox.dispose();
  }
});
