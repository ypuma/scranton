// The New project dialog's folder picker: the desktop app's Tauri dialog plugin fills the Folder field with the exact
// path chosen; a browser keeps typing the path by hand. Nothing is created until Create project is pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createNav } from '../../visualizer/public/js/nav.js';
import { installDom } from './fixtures/fake-dom.js';
import { fakeStorage } from './fixtures/run-drawer.js';

const PUBLIC = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));
const PROJECTS = { mode: 'registry', maxConcurrentRuns: 4, running: 0, projects: [{ id: 'core', name: 'Core', workspace: 'C:\\work\\core', chats: [] }] };
const tick = () => new Promise((r) => setTimeout(r, 10));

// picker: undefined = a browser (no Tauri); otherwise the invoke the page sees, as globalThis.__TAURI__.core.invoke.
async function harness({ picker } = {}) {
  const $ = installDom();
  Object.assign(globalThis.document, { querySelector: () => null, addEventListener() {} });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.localStorage = fakeStorage();
  if (picker) globalThis.__TAURI__ = { core: { invoke: picker } };
  else delete globalThis.__TAURI__;
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 201, json: async () => ({ project: { id: 'app' } }) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(PROJECTS) };
  };
  const nav = createNav({ getScope: () => null, navigate() {}, openRun() {}, announce() {} });
  // refresh, not start: start also polls every 3 s, which would keep the test process alive
  await nav.refresh();
  nav.newProject();
  return { $, nav, posts, browse: () => $('p-browse').fire('click') };
}

// an invoke whose answers the test hands out one by one
function heldPicker() {
  const calls = [];
  const invoke = (cmd, args) => new Promise((resolve, reject) => calls.push({ cmd, args, resolve, reject }));
  return { invoke, calls };
}

test('a chosen folder fills the field with the exact path and enables the create option; nothing is posted', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  h.$('p-name').value = 'App';
  assert.equal(h.$('p-create').disabled, true, 'no folder yet');
  const done = h.browse();
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].cmd, 'plugin:dialog|open');
  assert.deepEqual(p.calls[0].args, { options: { directory: true, multiple: false, title: 'Choose project folder' } });
  p.calls[0].resolve('D:\\code\\My App ');
  await done;
  assert.equal(h.$('p-folder').value, 'D:\\code\\My App ', 'the path as the picker gave it');
  assert.equal(h.$('p-create').disabled, false);
  assert.equal(h.$('p-create-row').dataset.disabled, 'false');
  assert.equal(h.$('p-submit').disabled, false);
  assert.equal(h.$('p-browse-status').textContent, '');
  assert.equal(globalThis.document.activeElement, h.$('p-folder'));
  assert.equal(h.$('project-dialog').open, true, 'still open: the user creates it');
  assert.deepEqual(h.posts, []);
  await h.$('project-form').fire('submit');
  assert.deepEqual(h.posts, [{ url: '/api/projects', body: { name: 'App', workspace: 'D:\\code\\My App', create: true } }]);
});

test('a typed absolute path is where the picker starts', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  h.$('p-folder').value = '  C:\\work\\old  ';
  h.browse();
  assert.equal(p.calls[0].args.options.defaultPath, 'C:\\work\\old');
  p.calls[0].resolve(null);
  await tick();
  h.$('p-folder').value = 'relative\\dir';
  h.browse();
  assert.equal('defaultPath' in p.calls[1].args.options, false, 'a relative path is no starting point');
});

test('a cancelled picker leaves every field as it was', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  h.$('p-name').value = 'Kept';
  h.$('p-folder').value = 'C:\\typed';
  h.$('p-create').checked = false;
  const done = h.browse();
  p.calls[0].resolve(null);
  await done;
  assert.equal(h.$('p-name').value, 'Kept');
  assert.equal(h.$('p-folder').value, 'C:\\typed');
  assert.equal(h.$('p-create').checked, false);
  assert.equal(h.$('p-browse-status').textContent, '');
  assert.equal(h.$('p-submit').disabled, false);
  assert.equal(h.$('p-browse').getAttribute('aria-disabled'), 'false');
  assert.equal(globalThis.document.activeElement, h.$('p-browse'));
});

test('a picker that fails says why inline, and the typed path still creates the project', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  const done = h.browse();
  p.calls[0].reject('dialog.open not allowed');
  await done;
  assert.equal(h.$('p-browse-status').dataset.tone, 'error');
  assert.match(h.$('p-browse-status').textContent, /did not open \(dialog\.open not allowed\)\. Type the absolute path instead\./);
  assert.equal(h.$('p-folder').value, '');
  assert.equal(h.$('p-submit').disabled, false);
  h.$('p-name').value = 'Typed';
  h.$('p-folder').value = 'C:\\typed\\app';
  await h.$('project-form').fire('submit');
  assert.deepEqual(h.posts.map((x) => x.body), [{ name: 'Typed', workspace: 'C:\\typed\\app', create: true }]);
});

test('in a browser the button is unavailable, explains itself, and never invents a path', async () => {
  const h = await harness();
  assert.equal(h.$('p-browse').getAttribute('aria-disabled'), 'true');
  assert.match(h.$('p-browse').title, /desktop app/);
  await h.browse();
  assert.match(h.$('p-browse-status').textContent, /needs the Scranton desktop app\. Type the absolute path instead\./);
  assert.equal(h.$('p-folder').value, '');
  h.$('p-name').value = 'Default';
  await h.$('project-form').fire('submit');
  assert.deepEqual(h.posts.map((x) => x.body), [{ name: 'Default' }], 'an empty folder still means the default projects folder');
});

test('while the picker is up a second click opens nothing and Create project waits', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  h.$('p-name').value = 'App';
  const done = h.browse();
  assert.equal(h.$('p-submit').disabled, true);
  assert.equal(h.$('p-browse').getAttribute('aria-disabled'), 'true');
  assert.equal(h.$('p-browse-status').dataset.tone, 'busy');
  await h.browse();
  assert.equal(p.calls.length, 1, 'one picker at a time');
  await h.$('project-form').fire('submit');
  assert.deepEqual(h.posts, [], 'no submit while picking');
  p.calls[0].resolve('C:\\picked');
  await done;
  assert.equal(h.$('p-submit').disabled, false);
  const again = h.browse();
  assert.equal(p.calls.length, 2, 'the picker opens again once the first one answered');
  p.calls[1].resolve(null);
  await again;
});

test('an answer that arrives after the dialog closed, or was opened again, is ignored', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  const first = h.browse();
  h.$('p-cancel').fire('click');
  assert.equal(h.$('project-dialog').open, false);
  h.nav.newProject();
  h.$('p-name').value = 'Fresh';
  h.$('p-folder').value = 'C:\\fresh';
  assert.equal(h.$('p-submit').disabled, false, 'the reopened dialog is not stuck on the old picker');
  assert.equal(h.$('p-browse').getAttribute('aria-disabled'), 'false');
  p.calls[0].resolve('C:\\stale');
  await first;
  assert.equal(h.$('p-folder').value, 'C:\\fresh');
  assert.equal(h.$('p-browse-status').textContent, '');
  const second = h.browse();
  assert.equal(p.calls.length, 2);
  p.calls[1].resolve('C:\\current');
  await second;
  assert.equal(h.$('p-folder').value, 'C:\\current');
});

test('a path longer than the field takes is refused, not cut to another folder', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  h.$('p-folder').value = 'C:\\typed';
  const long = `C:\\${'a'.repeat(1030)}`;
  const done = h.browse();
  p.calls[0].resolve(long);
  await done;
  assert.equal(h.$('p-folder').value, 'C:\\typed');
  assert.equal(h.$('p-browse-status').dataset.tone, 'error');
  assert.match(h.$('p-browse-status').textContent, /has 1033 characters; at most 1024 fit/);
  const exact = `C:\\${'b'.repeat(1021)}`;
  const ok = h.browse();
  p.calls[1].resolve(exact);
  await ok;
  assert.equal(h.$('p-folder').value, exact, '1024 characters still fit');
});

test('a chosen folder clears the folder error of the last submit', async () => {
  const p = heldPicker();
  const h = await harness({ picker: p.invoke });
  h.$('p-name').value = 'App';
  h.$('p-folder').value = 'relative';
  await h.$('project-form').fire('submit');
  assert.equal(h.$('p-folder').getAttribute('aria-invalid'), 'true');
  assert.equal(h.$('p-error').hidden, false);
  const done = h.browse();
  p.calls[0].resolve('C:\\abs');
  await done;
  assert.equal(h.$('p-folder').getAttribute('aria-invalid'), null);
  assert.equal(h.$('p-error').hidden, true);
  assert.deepEqual(h.posts, []);
});

test('the Browse button sits beside the folder field and its feedback is announced', () => {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<div class="folder-row">\s*<input id="p-folder"[^>]*maxlength="1024"[^>]*aria-describedby="p-folder-hint p-browse-status">\s*<button type="button" class="btn" id="p-browse"/);
  assert.match(html, /<span class="hint form-status" id="p-browse-status" role="status" aria-live="polite"><\/span>/);
  const js = readFileSync(path.join(PUBLIC, 'js', 'nav.js'), 'utf8');
  assert.doesNotMatch(js, /webkitdirectory/);
});
