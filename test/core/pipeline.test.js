import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePipelineCommand, pipelineChildEnv, probePipeline } from '../../src/core/pipeline-command.js';
import { tokenizePipelineCommand } from '../../src/core/pipeline-supervisor.js';

const base = path.resolve('.scratch/pipeline/lane-n/core-tests');
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('Pipeline command precedence, fallback and named parsing errors', (t) => {
  const root = fixture(t), dev = path.join(root, '.scratch/pipeline/venv/Scripts/python.exe'), bundled = path.join(root, 'engine-runtime/python/python.exe');
  assert.throws(() => resolvePipelineCommand({ root, env: {} }), /No bundled/);
  fs.mkdirSync(path.dirname(dev), { recursive: true }); fs.writeFileSync(dev, '');
  assert.deepEqual(resolvePipelineCommand({ root, env: {} }), { argv: [dev, '-m', 'scranton_pipeline'], source: 'dev' });
  fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, '');
  assert.equal(resolvePipelineCommand({ root, env: {} }).source, 'bundled');
  assert.deepEqual(resolvePipelineCommand({ root, env: { SCRANTON_PIPELINE_COMMAND: '["custom python","-m","custom"]' } }), { argv: ['custom python', '-m', 'custom'], source: 'env' });
  for (const value of ['[]', '[1]', '["python", ""]', '["python", "\\u0000"]']) assert.throws(() => resolvePipelineCommand({ root, env: { SCRANTON_PIPELINE_COMMAND: value } }), /SCRANTON_PIPELINE_COMMAND/);
});
test('Pipeline argv tokenization preserves Windows paths and never expands shell syntax', () => {
  assert.deepEqual(tokenizePipelineCommand('"C:\\Program Files\\Python\\python.exe" -m unittest "test file"'), ['C:\\Program Files\\Python\\python.exe', '-m', 'unittest', 'test file']);
  assert.deepEqual(tokenizePipelineCommand("node 'test file' \"\" $HOME && echo"), ['node', 'test file', '', '$HOME', '&&', 'echo']);
  for (const value of ['', ' ', 'node "unfinished', 'node\nversion', 'node\0bad', Array(66).fill('x').join(' ')]) assert.throws(() => tokenizePipelineCommand(value));
});
test('Pipeline child environment excludes unrelated credentials and team owner tokens', () => {
  const env = { PATH: 'path', SystemRoot: 'root', OPENAI_API_KEY: 'one', SOME_TOKEN: 'two', PASSWORD: 'three', SCRANTON_PIPELINE_KEY_PLANNER: 'four', SCRANTON_PROVIDER_CUSTOM_KEY: 'five', SCRANTON_RUN_LEASE: 'six', SCRANTON_PARENT_GUARD: 'seven' };
  assert.deepEqual(pipelineChildEnv(env), { PATH: 'path', SystemRoot: 'root' });
});
test('Pipeline successful capability is cached; failures are retried', async (t) => {
  const root = fixture(t), script = path.join(root, 'probe.cjs'), count = path.join(root, 'count');
  fs.writeFileSync(script, `const fs = require('fs'); const p = ${JSON.stringify(count)}; const n = fs.existsSync(p) ? Number(fs.readFileSync(p)) + 1 : 1; fs.writeFileSync(p, String(n)); if (n === 1) process.exit(2); console.log(JSON.stringify({version:'test'}));`);
  const env = { ...process.env, SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, script]) };
  assert.equal((await probePipeline({ env })).available, false);
  assert.equal((await probePipeline({ env })).version, 'test');
  assert.equal((await probePipeline({ env })).available, true);
  assert.equal(fs.readFileSync(count, 'utf8'), '2');
});

test('Pipeline detection command formatting round-trips tokenizer quoting', async () => {
  const { formatPipelineCommand } = await import('../../src/core/pipeline-supervisor.js');
  for (const argv of [['node', '', 'a b', 'a"b', "a'b", 'both\"\'quotes', 'C:\\Program Files\\node\\'], ['npm', 'ci'], ['node', '\t', '$HOME', '&']]) assert.deepEqual(tokenizePipelineCommand(formatPipelineCommand(argv)), argv);
});

test('Pipeline fake status and cancel mirror lifecycle exit codes', async (t) => {
  const { execPipeline } = await import('../../src/core/pipeline-command.js');
  const root = fixture(t), spec = { argv: [process.execPath, path.resolve('tools/fake-pipeline.js')] };
  fs.mkdirSync(path.join(root, 'delivery'));
  for (const [status, code] of [['running', 5], ['suspended', 5], ['awaiting_approval', 3], ['failed', 4], ['succeeded', 0], ['rejected', 6], ['cancelled', 6]]) {
    fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ schema: 1, run_id: 'test1234', status, artifacts: {} }));
    assert.equal((await execPipeline(spec, ['status', '--run-dir', root])).code, code);
    if (status !== 'running' && status !== 'suspended' && status !== 'awaiting_approval') assert.equal((await execPipeline(spec, ['cancel', '--run-dir', root])).code, code);
  }
});

test('Pipeline sandbox probe pins argv and degrades old or malformed commands', async (t) => {
  const { probePipelineSandbox } = await import('../../src/core/pipeline-command.js');
  const root = fixture(t), script = path.join(root, 'sandbox.cjs'), calls = path.join(root, 'calls');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(process.env.REPLY); process.exit(Number(process.env.CODE ?? 0));`);
  const spec = { argv: [process.execPath, script] };
  const expected = { default_image: 'default:v1', docker: { available: true, version: 'fake', reason: null }, image: { name: 'custom:v2', present: false } };
  assert.deepEqual(await probePipelineSandbox(spec, { env: { ...process.env, REPLY: JSON.stringify(expected) }, image: 'custom:v2' }), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8').trim()), ['sandbox', 'check', '--image', 'custom:v2']);
  for (const [REPLY, CODE] of [['usage: unknown command sandbox', '2'], ['{}', '0'], ['{"docker":{"available":true}}', '0'], [JSON.stringify(expected), '5']]) {
    const result = await probePipelineSandbox(spec, { env: { ...process.env, REPLY, CODE } });
    assert.equal(result.docker.available, false); assert.equal(result.image.present, false); assert.match(result.docker.reason, /upgrade/);
  }
});

test('Pipeline sandbox capability caches probes briefly and build invalidates the cached image result', async (t) => {
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const root = fixture(t), calls = path.join(root, 'probes'), image = path.join(root, 'image');
  const env = { ...process.env, SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(root, 'workspaces'), FAKE_PIPELINE_PROBE_FILE: calls, FAKE_PIPELINE_IMAGE_MISSING: '1', FAKE_PIPELINE_IMAGE_FILE: image };
  const auth = { listAccounts: async () => [], listModels: async () => ({ providers: [] }) };
  const supervisor = createPipelineSupervisor({ dataDir: root, env, auth }); t.after(() => supervisor.close());
  assert.equal((await supervisor.capability()).sandbox.image.present, false);
  await supervisor.capability();
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
  await supervisor.buildSandbox({});
  const { setTimeout: sleep } = await import('node:timers/promises');
  let value;
  for (let i = 0; i < 100; i++) { value = await supervisor.capability(); if (value.sandbox.build.state === 'succeeded') break; await sleep(20); }
  assert.equal(value.sandbox.build.state, 'succeeded'); assert.equal(value.sandbox.image.present, true);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse), Array(3).fill(['check']));
});

test('Pipeline sandbox slow first probe is single-flight and TTL starts at settlement; stale refresh never blocks', async (t) => {
  const { createPipelineSupervisor } = await import('../../src/core/pipeline-supervisor.js');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const root = fixture(t), calls = path.join(root, 'probes');
  const env = { ...process.env, SCRANTON_PIPELINE_COMMAND: JSON.stringify([process.execPath, path.resolve('tools/fake-pipeline.js')]), SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(root, 'workspaces'), FAKE_PIPELINE_PROBE_FILE: calls, FAKE_PIPELINE_PROBE_SLOW_MS: '3400' };
  const supervisor = createPipelineSupervisor({ dataDir: root, env, auth: { listAccounts: async () => [], listModels: async () => ({ providers: [] }) } });
  t.after(() => supervisor.close());
  const count = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  const first = supervisor.capability();
  await sleep(3100);
  await Promise.all([first, supervisor.capability(), supervisor.capability()]);
  assert.equal(count(), 1);
  await supervisor.capability(); assert.equal(count(), 1);
  await sleep(3050);
  env.FAKE_PIPELINE_DOCKER_ABSENT = '1';
  const stale = await Promise.race([supervisor.capability(), sleep(1000).then(() => null)]);
  assert.equal(stale?.sandbox.docker.available, true, 'cached capability must return while refresh is running');
  await sleep(3100);
  assert.equal((await supervisor.capability()).sandbox.docker.available, true);
  assert.equal(count(), 2);
  await sleep(600);
  assert.equal((await supervisor.capability()).sandbox.docker.available, false);
  assert.equal(count(), 2);
});

test('Pipeline sandbox check outlives the old 15s deadline and identifies Docker timeouts', async (t) => {
  const { probePipelineSandbox } = await import('../../src/core/pipeline-command.js');
  const root = fixture(t), spec = { argv: [process.execPath, path.resolve('tools/fake-pipeline.js')] };
  const env = { ...process.env, FAKE_PIPELINE_PROBE_SLOW_MS: '15200', SCRANTON_PIPELINE_WORKSPACE_ROOT: path.join(root, 'workspaces') };
  assert.equal((await probePipelineSandbox(spec, { env })).docker.available, true);
  const timed = await probePipelineSandbox(spec, { env, timeoutMs: 200 });
  assert.equal(timed.docker.available, false); assert.equal(timed.docker.reason, 'Docker did not answer in time');
});

test('Pipeline fake normal runs report exact sandbox config, image defaults and setup networking', async (t) => {
  const { execPipeline } = await import('../../src/core/pipeline-command.js');
  const root = fixture(t), spec = { argv: [process.execPath, path.resolve('tools/fake-pipeline.js')] };
  const source = path.join(root, 'source'), runs = path.join(root, 'runs'), config = path.join(root, 'config.json');
  fs.mkdirSync(source); fs.mkdirSync(runs);
  const cases = [
    { sandbox: { mode: 'host', docker: { image: 'ignored:image' } }, setup: [] },
    { sandbox: { mode: 'host' }, setup: [{ network: false }, { network: true }] },
    { sandbox: { mode: 'docker', docker: { image: 'custom:test' } }, setup: [{ network: true }] },
    { sandbox: { mode: 'docker', docker: { image: '' } }, setup: [{ network: false }] },
    { sandbox: { mode: 'docker' }, setup: [{ network: 'true' }, {}] },
    {}
  ];
  for (const [i, cfg] of cases.entries()) {
    fs.writeFileSync(config, JSON.stringify(cfg));
    const result = await execPipeline(spec, ['run', '--source', source, '--task', 'Sandbox fixture', '--config', config, '--run-root', runs, '--run-id', `sandbox${i}`]);
    assert.equal(result.code, 3);
    const status = JSON.parse(fs.readFileSync(path.join(runs, `sandbox${i}`, 'status.json')));
    const mode = cfg.sandbox?.mode ?? 'docker';
    assert.deepEqual(status.sandbox, {
      mode, isolated: mode === 'docker',
      image: mode === 'host' ? null : cfg.sandbox?.docker?.image || 'scranton-pipeline-sandbox:fake-1',
      isolation: mode === 'host' ? 'No OS isolation.' : 'Docker container with read-only root and no network for checks; shares the Docker VM kernel; workspace mounted read-write; setup commands with network can reach the internet and local services (including host.docker.internal).',
      setup_network: i === 1 || i === 2
    });
  }
});
