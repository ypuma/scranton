import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const native = path.join(root, 'src-tauri');
const read = (name) => fs.readFileSync(path.join(native, name), 'utf8');
const json = (name) => JSON.parse(read(name));

// Placement verified against tauri-cli-v2.12.4: settings.rs copy_binaries,
// macos/app.rs, linux/debian.rs and linux/appimage/linuxdeploy.rs.
test('native platform overlays preserve staging and least-privilege window capabilities', () => {
  const base = json('tauri.conf.json');
  assert.deepEqual(base.bundle.externalBin, ['binaries/scranton-node']);
  assert.deepEqual(base.bundle.resources, { 'staged/app/': 'app/' });
  assert.deepEqual(json('tauri.windows.conf.json').bundle.targets, ['nsis']);
  assert.deepEqual(json('tauri.macos.conf.json').bundle.targets, ['app', 'dmg']);
  assert.equal(json('tauri.macos.conf.json').bundle.macOS.minimumSystemVersion, '13.5');
  assert.equal(json('tauri.macos.conf.json').bundle.macOS.signingIdentity, null);
  assert.deepEqual(json('tauri.linux.conf.json').bundle.targets, ['deb', 'appimage']);
  assert.match(base.app.security.csp, /connect-src 'self' ipc: http:\/\/ipc\.localhost/);
  assert.equal(base.app.windows[0].decorations, false);
  for (const capability of base.app.security.capabilities) {
    const config = json(`capabilities/${capability}.json`);
    assert.equal(config.local, false);
    assert.deepEqual(config.windows, ['main']);
    assert.ok(config.permissions.every((permission) => !/^(shell|fs):/.test(permission)));
  }
  const main = read('src/main.rs');
  assert.match(main, /platform::node_path\(/);
  assert.match(main, /#\[cfg\(target_os = "macos"\)\][\s\S]*command\.env\("PATH", platform::sidecar_path\(/);
  assert.doesNotMatch(main, /std::env::set_var\(/);
  assert.doesNotMatch(main, /node-x86_64-pc-windows-msvc|with_file_name\("node.exe"\)/);
  assert.match(main, /process_group::isolate\(&mut command\)/);
  assert.match(main, /process_group::kill_owned_group\(child\)/);
  assert.match(main, /write_all\(b"quit\\n"\)/);
  assert.match(read('build.rs'), /var\("TARGET"\)/);
});

test('pure Rust path helpers cover every target; POSIX group tests run on native Unix hosts', (t) => {
  const rustc = process.platform === 'win32' ? path.join(os.homedir(), '.cargo/bin/rustc.exe') : 'rustc';
  const probe = spawnSync(rustc, ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') return t.skip('Rust compiler not installed');
  assert.equal(probe.status, 0, probe.stderr);
  const scratch = path.join(root, '.scratch/native-platform');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'rust-'));
  const env = { ...process.env, SCRANTON_RUST_TARGET: 'x86_64-pc-windows-msvc' };
  const binary = path.join(dir, process.platform === 'win32' ? 'tests.exe' : 'tests');
  const compile = (source) => {
    const harness = path.join(dir, 'harness.rs');
    fs.writeFileSync(harness, source);
    const result = spawnSync(rustc, ['--edition=2021', '--test', harness, '-o', binary], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    compile(read('src/platform.rs') + '\n#[path = ' + JSON.stringify(path.join(native, 'src/process_group.rs')) + '] mod process_group;\n');
    let result = spawnSync(binary, ['--test-threads=1'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    t.diagnostic(result.stdout.trim());
    // Negative control: the original Windows-only filename behavior must fail on Darwin/Linux.
    const bad = read('src/platform.rs').replace('=> "",', '=> ".exe",');
    assert.notEqual(bad, read('src/platform.rs'));
    compile(bad);
    result = spawnSync(binary, ['--test-threads=1'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 101, 'Windows-only regression was not rejected: ' + result.stdout + result.stderr);
    // Negative control: keep the inherited Finder PATH, as before this fix.
    const oldPath = read('src/platform.rs').replace('entries.join(":")', 'inherited.to_owned()');
    assert.notEqual(oldPath, read('src/platform.rs'));
    compile(oldPath);
    result = spawnSync(binary, ['tests::finder_path_reaches_native_tools', '--exact', '--test-threads=1'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 101, 'Unmodified Finder PATH regression was not rejected: ' + result.stdout + result.stderr);
    assert.match(result.stdout, /1 failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
