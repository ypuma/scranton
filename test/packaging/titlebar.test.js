import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const native = new URL('../../src-tauri/', import.meta.url);
const read = (file) => fs.readFile(new URL(file, native), 'utf8');
const readJson = async (file) => JSON.parse(await read(file));
const permissions = [
  'core:window:allow-minimize',
  'core:window:allow-toggle-maximize',
  'core:window:allow-close',
  'core:window:allow-is-maximized',
  'core:window:allow-start-dragging',
];

test('desktop main window uses an undecorated, resizable, shadowed title bar', async () => {
  const config = await readJson('tauri.conf.json');
  assert.equal(config.app.withGlobalTauri, true);
  assert.equal(config.app.windows.length, 1);
  const window = config.app.windows[0];
  assert.equal(window.label, 'main');
  assert.equal(window.decorations, false, 'native decorations must explicitly be disabled');
  assert.equal(window.resizable, true);
  assert.equal(window.shadow, true);
  assert.equal(window.visible, false);
  assert.equal(window.width, 1280);
  assert.equal(window.height, 850);
  assert.equal(window.minWidth, 900);
  assert.equal(window.minHeight, 600);
});

test('desktop activates only the scoped title-bar capability with the exact window permissions', async () => {
  const config = await readJson('tauri.conf.json');
  assert.deepEqual(config.app.security.capabilities, [
    'dashboard-notifications', 'dashboard-folder-picker', 'dashboard-window-controls',
  ], 'window-controls capability must be explicitly activated');
  const capability = await readJson('capabilities/dashboard-window-controls.json');
  assert.equal(capability.identifier, 'dashboard-window-controls');
  assert.equal(capability.local, false);
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.webviews, undefined);
  assert.equal(capability.platforms, undefined);
  assert.deepEqual(capability.remote, { urls: ['http://127.0.0.1:*', 'http://localhost:*'] });
  assert.deepEqual(capability.permissions, permissions, 'only the five pinned window permissions are allowed');
  const activeWindowPermissions = [];
  for (const identifier of config.app.security.capabilities) {
    const active = await readJson(`capabilities/${identifier}.json`);
    activeWindowPermissions.push(...active.permissions.filter((permission) =>
      typeof permission !== 'string' || permission.startsWith('core:')));
  }
  assert.deepEqual(activeWindowPermissions.sort(), [...permissions].sort());
});

test('desktop keeps graceful close interception and maximized-state persistence', async () => {
  const source = await read('src/main.rs');
  assert.match(source, /WindowEvent::CloseRequested\s*\{ api, \.\. \}\s*=\s*event\s*\{\s*api\.prevent_close\(\);\s*shutdown\(window\.app_handle\(\)\);/);
  assert.match(source, /tauri_plugin_window_state::Builder::default\(\)/);
  assert.match(source, /\.with_state_flags\(tauri_plugin_window_state::StateFlags::SIZE \| tauri_plugin_window_state::StateFlags::POSITION \| tauri_plugin_window_state::StateFlags::MAXIMIZED\)/);
});
