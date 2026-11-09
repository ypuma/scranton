import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fingerprint } from '../../scripts/prepare-desktop.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'src-tauri/staged/app');
const staged = existsSync(path.join(app, 'packaging-manifest.json'));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('staged desktop contains the actual installed Pi and only locked production dependencies', { skip: !staged && 'Run npm.cmd run app:prepare first' }, async () => {
  const lock = await readJson(path.join(root, 'package-lock.json'));
  const manifest = await readJson(path.join(app, 'packaging-manifest.json'));
  const pi = 'node_modules/@earendil-works/pi-coding-agent';
  assert.equal(manifest.pi.version, '1.5.0');
  assert.deepEqual(await fingerprint(path.join(app, pi)), await fingerprint(path.join(root, pi)));
  for (const [relative, pkg] of Object.entries(lock.packages)) {
    if (!relative || pkg.dev || pkg.optional) continue;
    assert.equal((await readJson(path.join(app, relative, 'package.json'))).version, pkg.version, relative);
  }
  await assert.rejects(fs.access(path.join(app, 'node_modules/@tauri-apps/cli')));
  for (const file of ['tools/pi-agent-chat.js', 'tools/pipeline-pi-complete.js', 'tools/fake-pi-rpc.js', 'tools/fake-pi.js', 'sandbox/Dockerfile', 'sandbox/.dockerignore']) {
    assert.deepEqual(await fs.readFile(path.join(app, file)), await fs.readFile(path.join(root, file)), file);
  }
  for (const file of ['hive', '.env', '.pi', '.git', 'sessions', '.scratch']) await assert.rejects(fs.access(path.join(app, file)));
});

test('bundled Node loads Pi CLI without system Node/Pi PATH or host credentials', { skip: !staged && 'Run npm.cmd run app:prepare first' }, async () => {
  const manifest = await readJson(path.join(app, 'packaging-manifest.json'));
  const profile = path.join(root, '.scratch/packaging/test-profile');
  await fs.mkdir(profile, { recursive: true });
  const node = path.join(root, 'src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile };
  const run = spawnSync(node, [path.join(app, 'node_modules/@earendil-works/pi-coding-agent', manifest.pi.entrypoint), '--help'], { cwd: profile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stdout, /--mode/);
  // Negative control: an unavailable packaged entrypoint must fail under the same environment.
  const missing = spawnSync(node, [path.join(profile, 'missing-pi.js'), '--help'], { cwd: profile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(missing.status, 0);
});

test('desktop sidecar uses registry data, legacy import and authenticated aggregate control', async () => {
  const source = await fs.readFile(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  assert.match(source, /\["app-server", "--data"\]/);
  assert.match(source, /arg\("--legacy-workspace"\)/);
  assert.doesNotMatch(source, /\["app-server", "--hive"\]/);
  assert.match(source, /X-Scranton-Client: 1/);
  assert.match(source, /pendingHuman.*as_u64/);
});
