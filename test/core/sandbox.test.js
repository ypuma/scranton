import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareSandbox, checkSandbox, CREDENTIAL_ENV_NAMES } from '../../src/core/sandbox.js';
import { WorktreeManager } from '../../src/core/worktree.js';

const scratch = path.resolve('.scratch/docker-e2e/sandbox-tests');
fs.mkdirSync(scratch, { recursive: true });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'docker-'));
  const workspace = path.join(root, 'source'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'source.js'), 'export const x = 1;');
  const manager = new WorktreeManager({ workspace, hiveDir: path.join(root, 'hive'), runId: 'sandbox' });
  await manager.init();
  const tree = await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  const sessionDir = path.join(root, 'session'); fs.mkdirSync(sessionDir);
  const systemPromptFile = path.join(root, 'prompt.md'); fs.writeFileSync(systemPromptFile, 'prompt');
  const extensionFile = path.join(root, 'extension.js'); fs.writeFileSync(extensionFile, 'export default () => {};');
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { workspace: tree.dir, sessionDir, systemPromptFile, extensionFile, instanceId: 'dwight-m1', runId: 'r1' };
}
function docker() {
  const calls = [];
  const run = async (exe, args, env) => { calls.push({ exe, args, env }); if (args[0] === 'info' || args[0] === 'image') return 'linux'; return ''; };
  return { calls, run, executable: path.resolve('docker-mock.exe') };
}

test('default docker fails closed with no CLI; host mode is explicit identity override', async () => {
  const availability = await checkSandbox({}, { executable: null });
  assert.equal(availability.available, false); assert.match(availability.reason, /Docker CLI not found/);
  await assert.rejects(prepareSandbox({ workspace: 'not-used' }, { executable: '' }), /Docker CLI not found/);
  assert.equal((await checkSandbox({ mode: 'host' })).available, true);
  const env = { CUSTOM: 'value' };
  assert.deepEqual(await prepareSandbox({ sandbox: { mode: 'host' }, workspace: '/work', sessionDir: '/session', env }), {
    cwd: '/work', sessionDir: '/session', env, systemPromptFile: undefined, extensionFile: undefined
  });
});

test('engine and local Linux image preflight never pull/build or fallback', async () => {
  const deps = docker();
  assert.equal((await checkSandbox({}, deps)).available, true);
  assert.deepEqual(deps.calls.map((c) => c.args[0]), ['info', 'image']);
  assert.equal((await checkSandbox({}, { ...deps, run: async () => 'windows' })).available, false);
  assert.equal((await checkSandbox({}, { ...deps, run: async (_exe, args) => args[0] === 'info' ? 'linux' : 'windows' })).available, false);
  const failure = await checkSandbox({}, { ...deps, run: async () => { throw new Error('private diagnostic must not leak'); } });
  assert.equal(failure.available, false); assert.doesNotMatch(failure.reason, /private diagnostic/);
});

test('hardened shell-free launch mounts only checkout/session and exact readonly files; credential names only', async (t) => {
  const options = await fixture(t); const deps = docker();
  const execution = await prepareSandbox({ ...options, cwd: 'ignored-host-cwd', inboxFile: 'host-only-inbox', sandbox: { network: 'none', credentialEnvNames: ['OPENAI_API_KEY'] }, env: { OPENAI_API_KEY: 'secret-value-never-in-argv', UNRELATED_SECRET: 'must-not-copy', ANTHROPIC_API_KEY: 'not-selected' } }, deps);
  assert.deepEqual(execution.spec.argv, [deps.executable]); assert.equal(execution.spec.shell, false);
  const args = execution.argsPrefix;
  assert.ok(args.includes('--interactive'), 'RPC stdin must remain attached');
  assert.ok(!args.includes('--tty') && !args.includes('-t') && !args.includes('-it'), 'RPC must not allocate a TTY');
  for (const flag of ['--read-only', '--cap-drop=ALL', '--pull=never', '--init']) assert.ok(args.includes(flag));
  for (const [flag, value] of [['--security-opt', 'no-new-privileges'], ['--user', `${process.getuid?.() || 10001}:${process.getgid?.() || process.getuid?.() || 10001}`], ['--pids-limit', '256'], ['--memory', '2g'], ['--cpus', '2'], ['--network', 'none']]) assert.equal(args[args.indexOf(flag) + 1], value);
  const mounts = args.filter((_v, i) => args[i - 1] === '--mount');
  assert.equal(mounts.length, 5);
  assert.ok(mounts.some((m) => m === `type=bind,source=${options.workspace},target=/workspace`));
  assert.ok(mounts.some((m) => m.endsWith('target=/workspace/.git,readonly')));
  assert.ok(mounts.some((m) => m === `type=bind,source=${options.systemPromptFile},target=/scranton/prompt.md,readonly`));
  assert.ok(mounts.some((m) => m === `type=bind,source=${options.extensionFile},target=/scranton/extension.js,readonly`));
  assert.ok(mounts.every((m) => !m.includes('docker.sock') && !m.includes('target=/hive') && !m.includes('target=/host')));
  assert.equal(execution.systemPromptFile, '/scranton/prompt.md'); assert.equal(execution.sessionDir, '/session');
  assert.equal(execution.extensionFile, '/scranton/extension.js');
  assert.equal(execution.env.OPENAI_API_KEY, 'secret-value-never-in-argv');
  assert.equal(execution.env.UNRELATED_SECRET, undefined); assert.equal(execution.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(args.includes('OPENAI_API_KEY')); assert.doesNotMatch(args.join(' '), /secret-value|must-not-copy|not-selected|host-only-inbox|ignored-host-cwd/);
  await execution.cleanup();
  assert.equal(deps.calls.filter((c) => c.args[0] === 'rm').length, 1);
  assert.equal(deps.calls.at(-1).args[0], 'container');
});

test('cancellation cleanup forcibly removes the named container, waits, verifies, and is idempotent', async (t) => {
  const options = await fixture(t); const deps = docker();
  let finishRemoval;
  const removed = new Promise((resolve) => { finishRemoval = resolve; });
  const realRun = deps.run;
  deps.run = async (exe, args, env) => { if (args[0] === 'rm') await removed; return realRun(exe, args, env); };
  const execution = await prepareSandbox(options, deps);
  let settled = false; const pending = execution.cleanup().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  finishRemoval(); await pending; await execution.cleanup();
  const name = execution.argsPrefix[execution.argsPrefix.indexOf('--name') + 1];
  assert.deepEqual(deps.calls.find((c) => c.args[0] === 'rm').args, ['rm', '-f', name]);
  assert.equal(deps.calls.filter((c) => c.args[0] === 'rm').length, 1);
});

test('cleanup fails closed if container still exists or daemon cannot verify removal', async (t) => {
  for (const state of ['still-running', 'daemon-down']) {
    const options = await fixture(t); const deps = docker();
    deps.run = async (_exe, args) => {
      if (args[0] === 'info' || args[0] === 'image') return 'linux';
      if (args[0] === 'container') { if (state === 'daemon-down') throw new Error('daemon unavailable'); return 'container-id'; }
      return '';
    };
    const execution = await prepareSandbox(options, deps);
    await assert.rejects(execution.cleanup(), state === 'daemon-down' ? /daemon unavailable/ : /could not be verified/);
  }
});

test('dangerous settings, credential overrides and mount injection rejected', async (t) => {
  const options = await fixture(t); const deps = docker();
  for (const settings of [
    { mounts: ['/var/run/docker.sock'] }, { args: ['--privileged'] }, { extraArgs: ['--user', '0'] },
    { network: 'host' }, { image: 'image --privileged' }, { credentialEnvNames: ['PATH'] }, { mode: 'automatic' }
  ]) await assert.rejects(prepareSandbox({ ...options, sandbox: settings }, deps), /Unsupported|must be|Invalid/);
  await assert.rejects(prepareSandbox({ ...options, extraArgs: ['--privileged'] }, deps), /Unsupported sandbox launch setting/);
  const unsafe = path.join(path.dirname(options.sessionDir), 'comma,dir'); fs.mkdirSync(unsafe);
  await assert.rejects(prepareSandbox({ ...options, sessionDir: unsafe }, deps), /commas/);
  const linked = path.join(path.dirname(options.sessionDir), 'linked'); fs.symlinkSync(options.sessionDir, linked, 'junction');
  await assert.rejects(prepareSandbox({ ...options, sessionDir: linked }, deps), /link\/reparse/);
  await assert.rejects(prepareSandbox({ ...options, sessionDir: options.workspace }, deps), /must be separate/);
  assert.ok(!CREDENTIAL_ENV_NAMES.includes('PATH'));
});

test('reproducible image recipe includes pinned Pi and basic developer tools; no host context copied', () => {
  const recipe = fs.readFileSync(new URL('../../sandbox/Dockerfile', import.meta.url), 'utf8');
  assert.match(recipe, /FROM node:24-bookworm-slim/); assert.match(recipe, /pi-coding-agent@1\.5\.0/);
  assert.match(recipe, /git bash ripgrep/); assert.match(recipe, /USER 10001:10001/);
  assert.doesNotMatch(recipe, /^COPY |^ADD /m);
  assert.match(fs.readFileSync(new URL('../../sandbox/.dockerignore', import.meta.url), 'utf8'), /^\*\*/);
});

test('subscription tokens minted per launch, forwarded by name only, never persisted (regression)', async (t) => {
  const options = await fixture(t); const deps = docker(); let minted = 0;
  deps.auth = {
    listAccounts: async () => [{ id: 'anthropic', kind: 'oauth', status: 'signed_in' }, { id: 'openai', kind: 'oauth', status: 'signed_in' }],
    mintAccessToken: async (provider, { minExpiryMs }) => { assert.equal(minExpiryMs, 31 * 60000); return `FAKE_ACCESS_${provider}_${++minted}`; }
  };
  for (const provider of ['anthropic', 'anthropic', 'openai']) {
    const launch = await prepareSandbox({ ...options, provider, agentTimeoutMinutes: 21, env: { ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_AUTH_TOKEN: 'old-bearer', PI_CODING_AGENT_DIR: 'host-private', REFRESH_TOKEN: 'FAKE_REFRESH' } }, deps);
    const name = provider === 'anthropic' ? 'ANTHROPIC_OAUTH_TOKEN' : 'OPENAI_API_KEY';
    assert.equal(launch.env[name], `FAKE_ACCESS_${provider}_${minted}`);
    assert.ok(launch.argsPrefix.includes(name));
    assert.doesNotMatch(JSON.stringify({ args: launch.argsPrefix, spec: launch.spec, calls: deps.calls }), /FAKE_ACCESS|FAKE_REFRESH|old-key|old-bearer|host-private/);
    assert.equal(launch.env.REFRESH_TOKEN, undefined);
    if (provider === 'anthropic') { assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(launch.env.ANTHROPIC_API_KEY, undefined); }
    for (const file of fs.readdirSync(path.dirname(options.systemPromptFile))) {
      const full = path.join(path.dirname(options.systemPromptFile), file);
      if (fs.statSync(full).isFile()) assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /FAKE_ACCESS|FAKE_REFRESH/);
    }
    await launch.cleanup();
  }
  assert.equal(minted, 3);
});

test('subscription mint failure or unreadable store fails closed with sanitized sign-in error', async (t) => {
  const options = await fixture(t); const deps = docker();
  for (const kind of ['oauth', null]) {
    deps.auth = { listAccounts: async () => [{ id: 'openai', kind, status: kind ? 'expired' : 'error' }], mintAccessToken: async () => { throw Error('FAKE_REFRESH FAKE_ACCESS'); } };
    await assert.rejects(prepareSandbox({ ...options, provider: 'openai' }, deps), (error) => {
      assert.match(error.message, /sign in again/); assert.doesNotMatch(error.message, /FAKE_/); return true;
    });
  }
  assert.ok(deps.calls.every((c) => ['info', 'image'].includes(c.args[0])));
});


test('review 4: pi default does not inspect or mint unrelated subscriptions', async (t) => {
  const options = await fixture(t); const deps = docker(); let inspected = false;
  deps.auth = { listAccounts: async () => { inspected = true; return [{ id: 'openai', kind: 'oauth', status: 'expired' }]; }, mintAccessToken: async () => { throw Error('Unused expired subscription'); } };
  const launch = await prepareSandbox({ ...options, provider: null }, deps);
  await launch.cleanup(); assert.equal(inspected, false);
  assert.equal(launch.env.OPENAI_API_KEY, undefined); assert.equal(launch.env.ANTHROPIC_OAUTH_TOKEN, undefined);
});

test('review 5: excluded subscription token environment fails closed before minting', async (t) => {
  const options = await fixture(t); const deps = docker(); let minted = false;
  deps.auth = { listAccounts: async () => [{ id: 'openai', kind: 'oauth', status: 'signed_in' }], mintAccessToken: async () => { minted = true; return 'FAKE_MINTED'; } };
  await assert.rejects(prepareSandbox({ ...options, provider: 'openai', sandbox: { credentialEnvNames: [] } }, deps), /credentialEnvNames.*OPENAI_API_KEY/);
  assert.equal(minted, false);
});

test('API key Docker launch forwards only selected name; custom models mount is readonly and key-free', async (t) => {
  const { createAuthService } = await import('../../src/core/auth.js');
  const options = await fixture(t), deps = docker();
  const agentDir = path.join(path.dirname(options.sessionDir), 'agent');
  fs.mkdirSync(agentDir);
  const auth = createAuthService({ env: { PI_CODING_AGENT_DIR: agentDir } });
  t.after(() => auth.close());
  const key = 'FAKE_DOCKER_KEY_NEVER_PERSIST';
  await auth.setApiKey('google', key);
  await auth.addProvider({ id: 'custom-docker', label: 'Custom', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'custom-model' }], key });
  deps.auth = auth;
  for (const provider of ['google', 'custom-docker']) {
    const launch = await prepareSandbox({ ...options, provider, env: { PI_CODING_AGENT_DIR: agentDir, OPENAI_API_KEY: 'UNRELATED_KEY' } }, deps);
    const name = provider === 'google' ? 'GEMINI_API_KEY' : 'SCRANTON_PROVIDER_CUSTOM_DOCKER_KEY';
    assert.equal(launch.env[name], key);
    assert.equal(launch.env.OPENAI_API_KEY, undefined);
    assert.ok(launch.argsPrefix.includes(name));
    assert.doesNotMatch(JSON.stringify({ args: launch.argsPrefix, calls: deps.calls }), /FAKE_DOCKER_KEY|UNRELATED_KEY/);
    const mounts = launch.argsPrefix.filter((_v, i, a) => a[i - 1] === '--mount');
    const modelMount = mounts.find((m) => m.includes('target=/home/pi/.pi/agent/models.json'));
    if (provider === 'google') assert.equal(modelMount, undefined);
    else {
      assert.ok(modelMount.endsWith(',readonly'));
      const file = modelMount.slice('type=bind,source='.length).split(',target=')[0];
      const text = fs.readFileSync(file, 'utf8'); assert.ok(!text.includes(key));
      const models = JSON.parse(text); assert.deepEqual(Object.keys(models.providers), [provider]);
      assert.equal(models.providers[provider].apiKey, '$' + name);
    }
    await launch.cleanup();
  }
  await auth.logout('google');
  await assert.rejects(prepareSandbox({ ...options, provider: 'google', env: { PI_CODING_AGENT_DIR: agentDir } }, deps), /sign in again/);
});

test('Docker diagnostics distinguish engine timeout and missing image with installation-local build command', async () => {
  const deps = docker();
  const engine = await checkSandbox({}, { ...deps, run: async () => { throw Object.assign(Error('private'), { code: 'ETIMEDOUT' }); } });
  assert.match(engine.reason, /installed.*engine is not responding.*start Docker Desktop/);
  const image = await checkSandbox({ image: 'custom-sandbox:1' }, { ...deps, run: async (_exe, args) => {
    if (args[0] === 'info') return 'linux';
    throw Error('private image inspect error');
  } });
  assert.equal(image.available, false);
  assert.ok(image.reason.endsWith(`docker build -t custom-sandbox:1 "${fileURLToPath(new URL('../../sandbox', import.meta.url))}"`));
  assert.doesNotMatch(image.reason, /private image/);
  assert.match(image.reason, /docker|sandbox|container engine|\bwsl\b|image .*not (found|available)|pull access denied/i);
});

test('Docker default models are refused before run events; host defaults remain supported', async (t) => {
  const { validateDockerModels } = await import('../../src/core/sandbox.js');
  const { runCli } = await import('../../src/core/cli.js');
  const root = fs.mkdtempSync(path.join(scratch, 'default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let text = ''; const stream = { write(s) { text += s; } };
  assert.equal(await runCli(['run', '--hive', path.join(root, 'hive'), 'goal'], { cwd: root, env: {}, stdout: stream, stderr: stream }), 2);
  assert.match(text, /Docker requires an explicit provider and model.*pi default cannot/);
  assert.equal(fs.existsSync(path.join(root, 'hive', 'events.jsonl')), false);
  const config = { execution: { sandbox: { mode: 'docker' } }, agents: { dwight: { provider: 'openai', model: 'chosen-model' } } };
  assert.doesNotThrow(() => validateDockerModels(config, ['dwight']));
  assert.throws(() => validateDockerModels(config), /michael, angela/);
  config.execution.sandbox.mode = 'host';
  assert.doesNotThrow(() => validateDockerModels(config));
});

test('error and blocked activities retain a full actionable first line in events and state', async () => {
  const { Orchestrator } = await import('../../src/core/orchestrator.js');
  const { initialState, reduce } = await import('../../src/core/state.js');
  const line = `Failed: Docker sandbox image scranton-sandbox:1.5.0-r2 is not available locally; build it once: docker build -t scranton-sandbox:1.5.0-r2 "${fileURLToPath(new URL('../../sandbox', import.meta.url))}"`;
  for (const status of ['error', 'blocked']) {
    let event;
    Orchestrator.prototype.setStatus.call({ emit: (type, fields) => { event = { type, ...fields }; } }, 'michael', status, `${line}\nAdditional detail`);
    assert.equal(event.activity, line);
    const state = reduce(initialState(), { ...event, runId: 'r', seq: 1, ts: new Date().toISOString() });
    assert.equal(state.agents.michael.activity, line);
  }
});
