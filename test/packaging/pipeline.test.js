import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fingerprint } from '../../scripts/prepare-desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'src-tauri/staged/app');
const runtime = path.join(app, 'engine-runtime');
const python = path.join(runtime, 'python/python.exe');
const staged = existsSync(path.join(app, 'packaging-manifest.json'));
const scratch = path.join(root, '.scratch/pipeline/lane-k');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (content) => createHash('sha256').update(content).digest('hex');

async function pipeline(t) {
  const manifest = await readJson(path.join(app, 'packaging-manifest.json'));
  assert.ok(Object.hasOwn(manifest, 'pipeline'), 'Prepare again: manifest predates Pipeline packaging');
  if (manifest.pipeline === null) {
    await assert.rejects(fs.access(runtime));
    t.skip('Preparation deliberately omitted Pipeline (SCRANTON_SKIP_PIPELINE=1)');
  }
  return manifest.pipeline;
}

const skip = !staged && 'Run npm.cmd run app:prepare first';

test('staged Pipeline is isolated, runtime-only and matches its manifest and source data', { skip }, async (t) => {
  const entry = await pipeline(t);
  if (!entry) return;
  await fs.access(python);
  const actual = await fingerprint(runtime);
  assert.deepEqual(actual, { sha256: entry.sha256, files: entry.files, bytes: entry.bytes });
  assert.equal(entry.requirementsSha256, hash(await fs.readFile(path.join(root, 'engine/requirements.lock'))));
  assert.equal(entry.pythonVersion, (await readJson(path.join(root, 'engine/runtime-lock.json'))).version);
  assert.equal(await fs.readFile(path.join(runtime, 'python/python314._pth'), 'utf8'), 'python314.zip\n.\n..\\site-packages\n');
  const forbidden = /^(?:node_modules|hive|sessions|\.git|\.pi|\.scratch|\.env(?:\..*)?|auth\.json|credentials\.json|.*\.(?:pem|key|p12|pfx|pyc|pyo)|__pycache__|\.(?:pytest|ruff|mypy)_cache|tests?|(?:_?pytest|ruff|mypy|pip|setuptools|wheel)(?:[-_.].*)?)$/i;
  async function walk(dir) {
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      assert.equal(file.isSymbolicLink(), false, file.name);
      assert.equal(forbidden.test(file.name), false, path.join(dir, file.name));
      if (file.isDirectory()) await walk(path.join(dir, file.name));
    }
  }
  await walk(runtime);
  async function compare(dir, target) {
    for (const file of await fs.readdir(dir, { withFileTypes: true })) {
      if (forbidden.test(file.name)) continue;
      if (file.isDirectory()) await compare(path.join(dir, file.name), path.join(target, file.name));
      else assert.deepEqual(await fs.readFile(path.join(target, file.name)), await fs.readFile(path.join(dir, file.name)), file.name);
    }
  }
  await compare(path.join(root, 'engine/src/scranton_pipeline'), path.join(runtime, 'site-packages/scranton_pipeline'));
  const pins = (await fs.readFile(path.join(root, 'engine/requirements.lock'), 'utf8')).split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  const metadata = (await fs.readdir(path.join(runtime, 'site-packages'))).filter((name) => name.endsWith('.dist-info'));
  assert.equal(metadata.length, pins.length);
  for (const pin of pins) {
    assert.match(pin, /^[\w-]+==\S+ --hash=sha256:[a-f0-9]{64}$/);
    const [name, version] = pin.split(' ')[0].split('==');
    assert.ok(metadata.includes(`${name.replaceAll('-', '_')}-${version}.dist-info`), pin);
  }
});

test('staged Pipeline version and graph work with empty PATH and no developer Python environment', { skip }, async (t) => {
  const entry = await pipeline(t);
  if (!entry) return;
  const profile = path.join(scratch, 'test-profile');
  const tmp = path.join(root, '.scratch/pipeline/tmp');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  for (const args of [['version'], ['graph', '--format', 'mermaid']]) {
    const run = spawnSync(python, ['-B', '-m', 'scranton_pipeline', ...args], { cwd: profile, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message);
    if (args[0] === 'version') {
      const version = JSON.parse(run.stdout);
      assert.equal(version.version, entry.engineVersion);
      assert.equal(version.python, entry.pythonVersion);
    } else assert.match(run.stdout, /approve_plan/);
  }
});

test('staged Pipeline demo reaches the plan gate using bundled data and the staged Node resolver', { skip }, async (t) => {
  if (!await pipeline(t)) return;
  const { resolvePipelineCommand } = await import(pathToFileURL(path.join(app, 'src/core/pipeline-command.js')));
  const resolved = resolvePipelineCommand({ env: {} });
  assert.deepEqual(resolved, { source: 'bundled', argv: [python, '-m', 'scranton_pipeline'] });
  await fs.mkdir(scratch, { recursive: true });
  const runs = await fs.mkdtemp(path.join(scratch, 'packaged-demo-'));
  try {
    const tmp = path.join(root, '.scratch/pipeline/tmp');
    const run = spawnSync(python, ['-B', '-m', 'scranton_pipeline', 'demo', '--run-root', runs, '--delivery', 'patch'], {
      cwd: scratch, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp }, encoding: 'utf8', windowsHide: true, timeout: 90000
    });
    assert.equal(run.status, 3, run.stderr || run.stdout || run.error?.message);
    assert.equal(run.stdout.trim().split(/\r?\n/).length, 1, run.stdout);
    const status = JSON.parse(run.stdout);
    assert.equal(status.status, 'awaiting_approval');
    assert.equal(status.pending.gate, 'plan');
    console.log(`Packaged Pipeline demo: exit ${run.status}, status ${status.status}, gate ${status.pending.gate}`);
  } finally {
    await fs.rm(runs, { recursive: true, force: true });
  }
});

test('staged Pipeline includes the packaged sandbox Dockerfile', { skip }, async (t) => {
  const source = path.join(root, 'engine/src/scranton_pipeline/sandbox_image/Dockerfile');
  if (!existsSync(source)) { t.skip('Sandbox engine lane has not created its package Dockerfile yet'); return; }
  if (!await pipeline(t)) return;
  assert.deepEqual(await fs.readFile(path.join(runtime, 'site-packages/scranton_pipeline/sandbox_image/Dockerfile')), await fs.readFile(source), 'Sandbox Dockerfile must survive the recursive package-data copy');
});
