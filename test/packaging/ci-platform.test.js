import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { desktopPlatform } from '../../scripts/desktop-platform.mjs';

const workflow = (await fs.readFile(new URL('../../.github/workflows/desktop-native.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const hosts = [
  ['windows-2022', 'win32', 'x64', 'x86_64-pc-windows-msvc'],
  ['macos-15', 'darwin', 'arm64', 'aarch64-apple-darwin'],
  ['ubuntu-22.04', 'linux', 'x64', 'x86_64-unknown-linux-gnu'],
  ['ubuntu-22.04-arm', 'linux', 'arm64', 'aarch64-unknown-linux-gnu']
];

function checkMatrix(source) {
  const rows = [...source.matchAll(/\{"runner":"([\w.-]+)","platform":"(\w+)","arch":"(\w+)","target":"([\w-]+)"\}/g)].map(match => match.slice(1));
  assert.deepEqual(rows, hosts, 'Native runner architecture must match its target (macos-15 is arm64)');
  for (const [, platform, arch, target] of rows) assert.equal(desktopPlatform(platform, arch).target, target);
}

function checkGates(source) {
  const gates = ['npm ci', 'test/core/pipeline-command.test.js', 'npm run app:prepare', 'assert.ok(manifest.pipeline', '"test/packaging/*.test.js"', 'test/core/sandbox-native/sandbox.test.js', 'cargo test --manifest-path src-tauri/Cargo.toml', 'npm run app:build', 'node scripts/desktop-artifact-receipt.mjs', 'node scripts/desktop-package-smoke.mjs', 'uses: actions/upload-artifact@'];
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
  const topLevel = [...(triggers ?? '').matchAll(/^  (\w+):[^\n]*$/gm)].map(match => match[1]);
  assert.deepEqual(topLevel, ['workflow_dispatch'], 'Native builds must allow only explicit workflow_dispatch');
}

test('native CI allows only manual workflow_dispatch', () => checkTriggers(workflow));

test('trigger contract rejects added automatic or callable triggers', () => {
  checkTriggers(workflow);
  for (const trigger of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch']) {
    assert.throws(() => checkTriggers(workflow.replace('on:\n', `on:\n  ${trigger}:\n`)), /Native builds must allow only explicit workflow_dispatch/);
  }
});

test('native CI pins the four real host runner/target pairs; Windows is opt-in', () => {
  checkMatrix(workflow);
  assert.doesNotMatch(workflow, /macos-15-intel/);
  assert.match(workflow, /targets:\s*\n\s*description:[^\n]*\n\s*type: choice\s*\n\s*required: true\s*\n\s*default: posix\s*\n\s*options:\s*\n\s*- posix\s*\n\s*- all\s*\n\s*- windows/);
  assert.match(workflow, /\$targets == "all" or \(\$targets == "posix" and \.platform != "win32"\)\s+or \(\$targets == "windows" and \.platform == "win32"\)/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.select-targets\.outputs\.matrix\) \}\}/);
});

test('native CI gates fail closed and run serially before bundling', () => checkGates(workflow));

test('CI contracts reject wrong Intel runner and omitted runtime/package gates', () => {
  assert.throws(() => checkMatrix(workflow.replace('"runner":"macos-15"', '"runner":"macos-15-intel"')));
  assert.throws(() => checkGates(workflow.replace('assert.ok(manifest.pipeline', 'assert.ok(true')));
  for (const gate of ['engine/tests/unit/test_fs_modes.py', 'engine/tests/unit/test_snapshot_modes.py', 'test/core/worktree-platform.test.js']) {
    assert.throws(() => checkGates(workflow.replace(gate, 'missing.test')));
  }
  assert.throws(() => checkGates(workflow.replace('"test/packaging/*.test.js"', '"test/packaging/missing.test.js"')));
  assert.throws(() => checkGates(workflow.replace('npm run app:build', 'npm run app:build\n        continue-on-error: true')));
});

test('keyless CI verifies macOS ad-hoc signing and uploads one receipt-bearing artifact per lane', async () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n  contents: read/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|gh release|release create|git push|git commit|docker build|npm run app:dev/);
  for (const dependency of ['libwebkit2gtk-4.1-dev', 'libayatana-appindicator3-dev', 'librsvg2-dev', 'patchelf', 'libfuse2', 'bubblewrap']) assert.ok(workflow.includes(dependency));
  assert.match(workflow, /APPIMAGE_EXTRACT_AND_RUN: '1'/);
  assert.match(workflow, /codesign --verify --deep --strict --verbose=2/);
  assert.match(workflow, /COPYFILE_DISABLE=1 tar -czf .*\.app\.tar\.gz.*Scranton\.app/);
  const mac = JSON.parse(await fs.readFile(new URL('../../src-tauri/tauri.macos.conf.json', import.meta.url), 'utf8'));
  assert.equal(mac.bundle.macOS.signingIdentity, '-');
  assert.equal(mac.bundle.macOS.hardenedRuntime, false);
  const schema = JSON.parse(await fs.readFile(new URL('../../node_modules/@tauri-apps/cli/config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.definitions.MacConfig.properties.hardenedRuntime.type, 'boolean');
  const pins = [...workflow.matchAll(/uses: ([^@\s]+)@(\S+)/g)];
  assert.equal(pins.length, 5);
  for (const [, , sha] of pins) assert.match(sha, /^[a-f0-9]{40}$/);
  const uploads = workflow.split('      - uses: actions/upload-artifact@').slice(1);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /name: scranton-\$\{\{ matrix\.target \}\}/);
  assert.match(uploads[0], /path: \$\{\{ env\.ARTIFACT_DIR \}\}\//);
  assert.match(uploads[0], /if-no-files-found: error/);
  assert.match(uploads[0], /retention-days: 14/);
  assert.match(workflow, /Native sandbox checks \(require host backend\)[\s\S]*?SCRANTON_REQUIRE_POSIX_SANDBOX: '1'[\s\S]*?exit "\$status"/);
  assert.match(workflow, /Enforce packaged POSIX sidecar and Pipeline smoke\s*\n\s*if: runner.os != 'Windows'/);
  assert.match(workflow, /xvfb-run -a dbus-run-session/);
});
