import { isolationTestEnv } from './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePipelineCommand, pipelineChildEnv, execPipeline } from '../../src/core/pipeline-command.js';

const base = path.resolve('.scratch/pipeline/runtime-portability');
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, rel, text = '') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  return file;
}
function bundle(root, platform, arch) {
  const launch = { schema: 1, platform, arch, executable: platform === 'win32' ? 'python/python.exe' : 'python/bin/python3', args: ['-I', '-B', 'bootstrap.py'] };
  put(root, `engine-runtime/${launch.executable}`);
  put(root, 'engine-runtime/bootstrap.py');
  put(root, 'engine-runtime/launch.json', JSON.stringify(launch));
  return launch;
}
for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
  test(`Pipeline manifest resolves absolute bootstrap and executable for ${platform}/${arch}`, (t) => {
    const root = fixture(t), launch = bundle(root, platform, arch);
    assert.deepEqual(resolvePipelineCommand({ root: path.relative('.', root), env: {}, platform, arch }), {
      source: 'bundled', argv: [path.join(root, 'engine-runtime', launch.executable), '-I', '-B', path.join(root, 'engine-runtime/bootstrap.py')]
    });
    assert.throws(() => resolvePipelineCommand({ root, env: {}, platform, arch: arch === 'x64' ? 'arm64' : 'x64' }), /target mismatch/);
    assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: platform === 'linux' ? 'darwin' : 'linux', arch }), /target mismatch/);
  });
}
for (const platform of ['win32', 'darwin', 'linux']) {
  test(`Pipeline local venv order for ${platform}, no global Python fallback`, (t) => {
    const root = fixture(t), options = { root, platform, arch: 'x64', env: { PATH: process.env.PATH } };
    assert.throws(() => resolvePipelineCommand(options), /No bundled/);
    const suffix = platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
    const second = put(root, `engine/.venv/${suffix}`);
    assert.deepEqual(resolvePipelineCommand(options), { source: 'dev', argv: [second, '-m', 'scranton_pipeline'] });
    const first = put(root, `.scratch/pipeline/venv/${suffix}`);
    assert.equal(resolvePipelineCommand(options).argv[0], first);
    fs.mkdirSync(path.join(root, 'engine-runtime'));
    assert.throws(() => resolvePipelineCommand(options), /launch.json is missing/);
  });
}
test('Pipeline invalid manifests fail closed despite legacy and dev Python', (t) => {
  const root = fixture(t), valid = bundle(root, 'win32', 'x64');
  put(root, '.scratch/pipeline/venv/Scripts/python.exe');
  const bad = [null, [], {}, { ...valid, schema: 2 }, { ...valid, extra: true }, { ...valid, platform: 'other' }, { ...valid, arch: 'ia32' }];
  for (const executable of ['../python.exe', '/bin/python3', 'C:/python.exe', 'C:\\python.exe', '\\\\server\\python.exe', 'python/../python.exe', 'python//python.exe', 'python/python.exe\0']) bad.push({ ...valid, executable });
  for (const args of [null, [], ['-m', 'scranton_pipeline'], ['-I', '-B', '../bootstrap.py'], ['-I', '-B', '/bootstrap.py'], ['-I', '-B', 'bootstrap.py', 'extra']]) bad.push({ ...valid, args });
  for (const value of bad) {
    put(root, 'engine-runtime/launch.json', JSON.stringify(value));
    assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'win32', arch: 'x64' }), /Invalid Pipeline launch.json/);
  }
  put(root, 'engine-runtime/launch.json', '{bad');
  assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'win32', arch: 'x64' }), /launch.json/);
});
test('Pipeline runtime files must exist and must be files', (t) => {
  const root = fixture(t); bundle(root, 'linux', 'x64');
  for (const rel of ['bootstrap.py', 'python/bin/python3']) {
    const file = path.join(root, 'engine-runtime', rel);
    fs.unlinkSync(file);
    assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'linux', arch: 'x64' }), /runtime file missing/);
    fs.mkdirSync(file);
    assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'linux', arch: 'x64' }), /runtime file missing/);
    fs.rmdirSync(file); put(root, `engine-runtime/${rel}`);
  }
});
test('Pipeline Windows legacy bundle remains supported only without a manifest', (t) => {
  const root = fixture(t), exe = put(root, 'engine-runtime/python/python.exe');
  assert.deepEqual(resolvePipelineCommand({ root, env: {}, platform: 'win32', arch: 'x64' }), { source: 'bundled', argv: [exe, '-m', 'scranton_pipeline'] });
  assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'linux', arch: 'x64' }), /launch.json is missing/);
  assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'win32', arch: 'arm64' }), /launch.json is missing/);
});
test('Pipeline override remains highest priority and rejects malformed argv', (t) => {
  const root = fixture(t); put(root, 'engine-runtime/launch.json', 'broken');
  for (const value of ['', ' ', '[]', '[1]', '["python", ""]', '["python", "\\u0000"]', [1], ['python', ' '], null]) {
    assert.throws(() => resolvePipelineCommand({ root, env: { SCRANTON_PIPELINE_COMMAND: value } }), /SCRANTON_PIPELINE_COMMAND/);
  }
  assert.deepEqual(resolvePipelineCommand({ root, env: { SCRANTON_PIPELINE_COMMAND: '["custom python","-m","custom"]' }, platform: 'other', arch: 'other' }), { source: 'env', argv: ['custom python', '-m', 'custom'] });
});
test('Pipeline spawn preserves argv boundaries and credential filtering', async (t) => {
  const root = fixture(t), script = put(root, 'fake engine.cjs', 'console.log(JSON.stringify({argv:process.argv.slice(2), secret:process.env.SOME_TOKEN ?? null}));');
  const result = await execPipeline({ argv: [process.execPath, script, 'bootstrap with spaces'] }, ['version', 'argument with spaces'], { env: isolationTestEnv({ SOME_TOKEN: 'do-not-forward' }) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.value, { argv: ['bootstrap with spaces', 'version', 'argument with spaces'], secret: null });
  assert.deepEqual(pipelineChildEnv({ PATH: 'ok', API_KEY: 'bad', SCRANTON_PIPELINE_KEY_PLANNER: 'bad' }), { PATH: 'ok' });
});

test('Pipeline packaged roots cannot use a development runtime when engine-runtime is absent', (t) => {
  const root = fixture(t);
  put(root, 'packaging-manifest.json', '{}');
  put(root, '.scratch/pipeline/venv/Scripts/python.exe');
  put(root, '.scratch/pipeline/venv/bin/python');
  for (const platform of ['win32', 'darwin', 'linux']) assert.throws(() => resolvePipelineCommand({ root, env: {}, platform, arch: 'x64' }), /launch.json is missing/);
});
test('Pipeline bundled executable cannot escape engine-runtime through a directory link', (t) => {
  const root = fixture(t); bundle(root, 'win32', 'x64');
  fs.rmSync(path.join(root, 'engine-runtime/python'), { recursive: true });
  put(root, 'outside/python.exe');
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'engine-runtime/python'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolvePipelineCommand({ root, env: {}, platform: 'win32', arch: 'x64' }), /outside engine-runtime/);
});

test('Every Pipeline child binds native and completion to this installation, preserving Team helper override', async (t) => {
  const root = fixture(t), helper = path.join(root, 'scranton-sandbox-helper.exe');
  const script = put(root, 'binding-env.cjs', `console.log(JSON.stringify({
    completion: JSON.parse(process.env.SCRANTON_PIPELINE_COMPLETION_COMMAND),
    native: JSON.parse(process.env.SCRANTON_PIPELINE_NATIVE_COMMAND),
    helper: process.env.SCRANTON_SANDBOX_HELPER,
    isolation: process.env.SCRANTON_ISOLATION_ROOT,
  }));`);
  const env = isolationTestEnv({ SCRANTON_PIPELINE_COMPLETION_COMMAND: '["stale-completion"]', SCRANTON_PIPELINE_NATIVE_COMMAND: '["stale-native"]', SCRANTON_SANDBOX_HELPER: helper });
  for (const args of [['version'], ['sandbox', 'check', '--mode', 'scranton'], ['run'], ['resume', '--run-dir', root], ['cancel']]) {
    const result = await execPipeline({ argv: [process.execPath, script] }, args, { env });
    assert.equal(result.code, 0);
    assert.deepEqual(result.value, {
      completion: [process.execPath, path.resolve('tools/pipeline-complete.js')],
      native: [process.execPath, path.resolve('tools/pipeline-sandbox.js')],
      helper, isolation: env.SCRANTON_ISOLATION_ROOT,
    });
  }
  assert.ok(fs.statSync(path.resolve('tools/pipeline-complete.js')).isFile());
});
