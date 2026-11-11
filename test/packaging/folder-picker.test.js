import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const native = new URL('../../src-tauri/', import.meta.url);
const read = (file) => fs.readFile(new URL(file, native), 'utf8');
const readJson = async (file) => JSON.parse(await read(file));

test('desktop explicitly activates the narrowly scoped folder-picker capability', async () => {
  const config = await readJson('tauri.conf.json');
  assert.deepEqual(config.app.security.capabilities, ['dashboard-notifications', 'dashboard-folder-picker', 'dashboard-window-controls']);
  const capability = await readJson('capabilities/dashboard-folder-picker.json');
  assert.equal(capability.identifier, 'dashboard-folder-picker');
  assert.equal(capability.local, false);
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.webviews, undefined);
  assert.deepEqual(capability.remote, { urls: ['http://127.0.0.1:*', 'http://localhost:*'] });
  assert.deepEqual(capability.permissions, ['dialog:allow-open']);
});

test('active desktop capabilities grant no unrelated dialog or filesystem commands', async () => {
  const config = await readJson('tauri.conf.json');
  const permissions = [];
  for (const identifier of config.app.security.capabilities) {
    const capability = await readJson(`capabilities/${identifier}.json`);
    permissions.push(...capability.permissions);
  }
  assert.deepEqual(permissions.sort(), [
    'core:window:allow-close',
    'core:window:allow-is-maximized',
    'core:window:allow-minimize',
    'core:window:allow-start-dragging',
    'core:window:allow-toggle-maximize',
    'dialog:allow-open',
    'notification:allow-is-permission-granted',
    'notification:allow-notify',
    'notification:allow-request-permission',
  ]);
});

test('desktop exposes the global invoke bridge and registers the existing dialog plugin', async () => {
  const config = await readJson('tauri.conf.json');
  assert.equal(config.app.withGlobalTauri, true);
  const cargo = await read('Cargo.toml');
  assert.match(cargo, /^tauri-plugin-dialog\s*=\s*"2"\s*$/m);
  const source = await read('src/main.rs');
  assert.equal((source.match(/\.plugin\(tauri_plugin_dialog::init\(\)\)/g) ?? []).length, 1);
});
