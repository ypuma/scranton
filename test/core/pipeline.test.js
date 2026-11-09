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
