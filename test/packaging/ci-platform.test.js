import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { desktopPlatform } from '../../scripts/desktop-platform.mjs';

const workflow = await fs.readFile(new URL('../../.github/workflows/desktop-native.yml', import.meta.url), 'utf8');
const hosts = [
  ['windows-2022', 'win32', 'x64', 'x86_64-pc-windows-msvc'],
  ['macos-15', 'darwin', 'arm64', 'aarch64-apple-darwin'],
  ['macos-15-intel', 'darwin', 'x64', 'x86_64-apple-darwin'],
  ['ubuntu-22.04', 'linux', 'x64', 'x86_64-unknown-linux-gnu'],
  ['ubuntu-22.04-arm', 'linux', 'arm64', 'aarch64-unknown-linux-gnu']
];

function checkMatrix(source) {
  const rows = [...source.matchAll(/- \{ runner: ([\w.-]+), platform: (\w+), arch: (\w+), target: ([\w-]+) \}/g)].map(match => match.slice(1));
  assert.deepEqual(rows, hosts, 'Native runner architecture must match its target (macos-15 is arm64)');
  for (const [, platform, arch, target] of rows) assert.equal(desktopPlatform(platform, arch).target, target);
}

function checkGates(source) {
  const gates = ['npm ci', 'test/core/pipeline-command.test.js', 'npm run app:prepare', 'assert.ok(manifest.pipeline', '"test/packaging/*.test.js"', 'cargo test --manifest-path src-tauri/Cargo.toml', 'npm run app:build'];
  let previous = -1;
  for (const gate of gates) {
    const index = source.indexOf(gate);
    assert.ok(index > previous, `Missing or reordered gate: ${gate}`);
    previous = index;
  }
  for (const gate of ['test/core/sandbox-posix.test.js', 'test/core/worktree-platform.test.js', 'test/core/pipeline-bridge.test.js', 'test/server/desktop-csp.test.js', 'engine/tests/unit/test_fs_modes.py', 'engine/tests/unit/test_snapshot_modes.py', 'engine/tests/unit/test_sandbox_user.py']) assert.ok(source.includes(gate), `Missing portable gate: ${gate}`);
  assert.match(source, /node --test --test-concurrency=1 "test\/packaging\/\*\.test\.js"/);
  assert.match(source, /assert\.equal\(process\.platform, process\.env\.EXPECTED_PLATFORM\)/);
  assert.match(source, /assert\.equal\(process\.arch, process\.env\.EXPECTED_ARCH\)/);
  assert.match(source, /host: .*EXPECTED_TARGET/);
  assert.match(source, /assert\.deepEqual\(launch, launchManifest\(host\)\)/);
  assert.doesNotMatch(source, /continue-on-error|SCRANTON_SKIP_PIPELINE: ['"]?1|--target\s|pull_request_target/);
}

function checkTriggers(source) {
  const triggers = source.match(/^on:\r?\n([\s\S]*?)\r?\npermissions:/m)?.[1];
  assert.equal(triggers?.trim(), 'workflow_dispatch:', 'Native builds must allow only explicit workflow_dispatch');
}

test('native CI allows only manual workflow_dispatch', () => checkTriggers(workflow));

test('trigger contract rejects added automatic or callable triggers', () => {
  const manual = workflow.replace(/^on:\r?\n[\s\S]*?\r?\npermissions:/m, 'on:\n  workflow_dispatch:\n\npermissions:');
  checkTriggers(manual);
  for (const trigger of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch']) {
    assert.throws(() => checkTriggers(manual.replace('  workflow_dispatch:', `  workflow_dispatch:\n  ${trigger}:`)), /Native builds must allow only explicit workflow_dispatch/);
  }
});

test('native CI pins all five real host runner/target pairs', () => checkMatrix(workflow));

test('native CI gates fail closed and run serially before bundling', () => checkGates(workflow));

test('CI contracts reject wrong Intel runner and omitted runtime/package gates', () => {
  assert.throws(() => checkMatrix(workflow.replace('runner: macos-15-intel', 'runner: macos-15')));
  assert.throws(() => checkGates(workflow.replace('assert.ok(manifest.pipeline', 'assert.ok(true')));
  for (const gate of ['engine/tests/unit/test_fs_modes.py', 'engine/tests/unit/test_snapshot_modes.py', 'test/core/worktree-platform.test.js']) {
    assert.throws(() => checkGates(workflow.replace(gate, 'missing.test')));
  }
  assert.throws(() => checkGates(workflow.replace('"test/packaging/*.test.js"', '"test/packaging/missing.test.js"')));
  assert.throws(() => checkGates(workflow.replace('npm run app:build', 'npm run app:build\n        continue-on-error: true')));
});

test('unsigned CI only uploads explicitly separated expected bundle formats', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n  contents: read/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|gh release|release create|git push|git commit|docker build|npm run app:dev/);
  for (const dependency of ['libwebkit2gtk-4.1-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev', 'patchelf', 'libfuse2']) assert.ok(workflow.includes(dependency));
  assert.match(workflow, /APPIMAGE_EXTRACT_AND_RUN: '1'/);
  assert.match(workflow, /tar -czf .*\.app\.tar\.gz/);
  const uploads = workflow.split('      - uses: actions/upload-artifact@v4').slice(1);
  assert.equal(uploads.length, 5);
  for (const upload of uploads) {
    assert.match(upload, /name: Scranton-(?:windows|macos|linux)-\$\{\{ matrix\.arch \}\}-unsigned-/);
    assert.match(upload, /if-no-files-found: error/);
    assert.match(upload, /retention-days: 14/);
  }
  for (const format of ['nsis/*.exe', 'dmg/*.dmg', 'deb/*.deb', 'appimage/*.AppImage', '*.app.tar.gz']) assert.ok(workflow.includes(format));
});
