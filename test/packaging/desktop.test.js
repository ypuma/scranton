import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fingerprint } from '../../scripts/prepare-desktop.mjs';
import { desktopPlatform } from '../../scripts/desktop-platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'src-tauri/staged/app');
const staged = existsSync(path.join(app, 'packaging-manifest.json'));
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('staged desktop contains the actual installed Pi and only locked production dependencies', { skip: !staged && 'Run npm.cmd run app:prepare first' }, async () => {
  const lock = await readJson(path.join(root, 'package-lock.json'));
  const manifest = await readJson(path.join(app, 'packaging-manifest.json'));
  const pi = 'node_modules/@earendil-works/pi-coding-agent';
  assert.equal(manifest.pi.version, '1.5.2');
  assert.equal(manifest.platform, process.platform, 'Staging is stale or belongs to another platform');
  assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.target, desktopPlatform().target);
  assert.deepEqual(await fingerprint(path.join(app, pi)), await fingerprint(path.join(root, pi)));
  for (const [relative, pkg] of Object.entries(lock.packages)) {
    if (!relative || pkg.dev || pkg.optional) continue;
    assert.equal((await readJson(path.join(app, relative, 'package.json'))).version, pkg.version, relative);
  }
  await assert.rejects(fs.access(path.join(app, 'node_modules/@tauri-apps/cli')));
  for (const file of ['tools/pi-agent-chat.js', 'tools/pi-codex-compaction.js', 'tools/pipeline-pi-complete.js', 'tools/fake-pi-rpc.js', 'tools/fake-pi.js', 'sandbox/Dockerfile', 'sandbox/.dockerignore', 'src/core/antigravity/provider.js', 'src/core/antigravity/oauth.js', 'src/core/antigravity/stream.js', 'src/core/antigravity/extension.js', 'src/core/antigravity/broker.js', 'src/core/antigravity/docker-extension.js']) {
    assert.deepEqual(await fs.readFile(path.join(app, file)), await fs.readFile(path.join(root, file)), file);
  }
  for (const file of ['hive', '.env', '.pi', '.git', 'sessions', '.scratch']) await assert.rejects(fs.access(path.join(app, file)));
});

test('bundled Node loads Pi CLI without system Node/Pi PATH or host credentials', { skip: !staged && 'Run npm.cmd run app:prepare first' }, async () => {
  const manifest = await readJson(path.join(app, 'packaging-manifest.json'));
  const profile = path.join(root, '.scratch/packaging/test-profile');
  await fs.mkdir(profile, { recursive: true });
  const node = path.join(root, `src-tauri/binaries/${desktopPlatform().nodeFile}`);
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile };
  const run = spawnSync(node, [path.join(app, 'node_modules/@earendil-works/pi-coding-agent', manifest.pi.entrypoint), '--help'], { cwd: profile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stdout, /--mode/);
  // Negative control: an unavailable packaged entrypoint must fail under the same environment.
  const missing = spawnSync(node, [path.join(profile, 'missing-pi.js'), '--help'], { cwd: profile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(missing.status, 0);
});

test('staged dreaming helper matches source and resolves runtime dependencies offline', { skip: !staged && 'Run npm.cmd run app:prepare first' }, async (t) => {
  for (const file of ['tools/dreaming-pi-complete.js', 'src/core/dreaming-completion.js']) {
    assert.deepEqual(await fs.readFile(path.join(app, file)), await fs.readFile(path.join(root, file)), file);
  }
  const scratch = path.join(root, '.scratch/packaging'); await fs.mkdir(scratch, { recursive: true });
  const profile = await fs.mkdtemp(path.join(scratch, 'dreaming-')); t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const node = path.join(root, `src-tauri/binaries/${desktopPlatform().nodeFile}`);
  const script = `
    import assert from 'node:assert/strict';
    const helper = await import(${JSON.stringify(new URL('../../src-tauri/staged/app/tools/dreaming-pi-complete.js', import.meta.url).href)});
    assert.equal(typeof helper.runDreamingCompletion, 'function');
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    assert.equal(typeof ModelRuntime.create, 'function');
    const provider = await import(${JSON.stringify(new URL('../../src-tauri/staged/app/src/core/antigravity/provider.js', import.meta.url).href)});
    assert.equal(typeof provider.antigravityProvider, 'function');
  `;
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile };
  const run = spawnSync(node, ['--input-type=module', '--eval', script], { cwd: app, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
});

test('desktop sidecar uses registry data, legacy import and authenticated aggregate control', async () => {
  const source = await fs.readFile(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  assert.match(source, /\["app-server", "--data"\]/);
  assert.match(source, /arg\("--legacy-workspace"\)/);
  assert.doesNotMatch(source, /\["app-server", "--hive"\]/);
  assert.match(source, /X-Scranton-Client: 1/);
  assert.match(source, /pendingHuman.*as_u64/);
});

test('staged Antigravity extension loads with bundled Node and empty PATH offline', { skip: !staged && 'Run npm.cmd run app:prepare first' }, async (t) => {
  const scratch = path.join(root, '.scratch/antigravity-backend'); await fs.mkdir(scratch, { recursive: true });
  const profile = await fs.mkdtemp(path.join(scratch, 'packaged-')); t.after(() => fs.rm(profile, { recursive: true, force: true }));
  await fs.writeFile(path.join(profile, 'auth.json'), JSON.stringify({ 'google-antigravity': { type: 'oauth', access: 'FAKE_ACCESS', refresh: 'FAKE_REFRESH', projectId: 'fake-project', expires: Date.now() + 3600000 } }));
  const node = path.join(root, `src-tauri/binaries/${desktopPlatform().nodeFile}`);
  const manifest = await readJson(path.join(app, 'packaging-manifest.json'));
  const args = [path.join(app, 'node_modules/@earendil-works/pi-coding-agent', manifest.pi.entrypoint), '--no-extensions', '--no-mcp', '--no-skills', '--list-models', 'gemini-3'];
  const env = { SystemRoot: process.env.SystemRoot, PATH: '', HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile };
  const run = (extension) => spawnSync(node, [...args, ...extension], { cwd: profile, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const loaded = run(['--extension', path.join(app, 'src/core/antigravity/extension.js')]);
  assert.equal(loaded.status, 0, loaded.stderr || loaded.error?.message); assert.match(loaded.stdout, /google-antigravity/);
  assert.doesNotMatch(run([]).stdout, /google-antigravity/);
});
