import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { cargoMetadata, licenseStager, stageCrateLicenses } from '../../scripts/desktop-licenses.mjs';
import { desktopPlatform } from '../../scripts/desktop-platform.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const app = path.join(root, 'src-tauri/staged/app');
const host = desktopPlatform();
const options = { skip: !existsSync(path.join(app, 'packaging-manifest.json')) && 'Run npm.cmd run app:prepare first' };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function index() {
  const manifest = await json(path.join(app, 'packaging-manifest.json'));
  assert.equal(manifest.licenseIndex, 'licenses/index.json');
  const licenses = await json(path.join(app, manifest.licenseIndex));
  assert.equal(licenses.target, host.target);
  return { manifest, licenses };
}

async function assertTexts(records) {
  assert.ok(records.length > 0);
  for (const { file, bytes, sha256 } of records) {
    assert.match(file, /^(?:licenses|engine-runtime)\//);
    assert.ok(!file.split('/').includes('..'), file);
    const full = path.join(app, file);
    assert.ok((await fs.lstat(full)).isFile(), file);
    const text = await fs.readFile(full);
    assert.ok(text.toString('utf8').trim(), file);
    assert.equal(text.length, bytes, file);
    assert.equal(hash(text), sha256, file);
  }
}

test('installer maps the whole app resource and stages the Node, tool and Pipeline license inventories', options, async () => {
  const { manifest, licenses } = await index();
  const conf = await json(path.join(root, 'src-tauri/tauri.conf.json'));
  assert.equal(conf.bundle.resources['staged/app/'], 'app/');
  assert.equal(licenses.node.version, manifest.node);
  assert.equal(licenses.node.file, 'licenses/node/LICENSE');
  await assertTexts([licenses.node]);
  assert.match(await fs.readFile(path.join(app, licenses.node.file), 'utf8'), /Node\.js/);
  for (const [name, files] of Object.entries({ rg: ['COPYING', 'LICENSE-MIT', 'UNLICENSE'], fd: ['LICENSE-APACHE', 'LICENSE-MIT'] })) {
    const tool = licenses.tools[name];
    assert.equal(tool.version, manifest.tools[name].version);
    assert.deepEqual(tool.files.map(record => record.file).sort(), files.map(file => `licenses/tools/${name}/${file}`));
    await assertTexts(tool.files);
  }
  if (!manifest.pipeline) {
    assert.equal(licenses.pipeline, null);
    return;
  }
  const { python, wheels } = licenses.pipeline;
  assert.equal(python.version, manifest.pipeline.pythonVersion);
  await assertTexts(python.files);
  assert.match(await fs.readFile(path.join(app, python.files[0].file), 'utf8'), /PYTHON SOFTWARE FOUNDATION LICENSE/);
  const installed = (await fs.readdir(path.join(app, 'engine-runtime/site-packages'))).filter(name => name.endsWith('.dist-info')).sort();
  assert.ok(installed.length > 0);
  assert.deepEqual(wheels.map(wheel => wheel.distribution).sort(), installed);
  for (const wheel of wheels) await assertTexts(wheel.files);
});

test('staged Rust texts cover every target normal dependency in both locked graphs', options, async () => {
  const { licenses } = await index();
  const cargo = host.platform === 'win32' ? path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe') : 'cargo';
  const manifests = ['src-tauri/Cargo.toml', 'native/sandbox-helper/Cargo.toml'];
  assert.deepEqual(Object.keys(licenses.rust).sort(), [...manifests].sort());
  const identity = ({ name, version, source }) => JSON.stringify([name, version, source]);
  for (const manifest of manifests) {
    const graph = cargoMetadata(cargo, root, manifest, host.target, { offline: true });
    const normal = new Map(graph.resolve.nodes.map(node => [node.id, node.deps.filter(dep => dep.dep_kinds.some(kind => kind.kind === null)).map(dep => dep.pkg)]));
    const visited = new Set();
    function visit(id) {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of normal.get(id)) visit(dep);
    }
    visit(graph.resolve.root);
    visited.delete(graph.resolve.root);
    const expected = graph.packages.filter(pkg => visited.has(pkg.id)).map(identity).sort();
    const staged = licenses.rust[manifest];
    const application = graph.packages.find(pkg => pkg.id === graph.resolve.root);
    assert.equal(staged.name, application.name);
    assert.equal(staged.version, application.version);
    assert.deepEqual(staged.crates.map(identity).sort(), expected, manifest);
    for (const crate of staged.crates) await assertTexts(crate.files);
  }
});

test('license preparation rejects missing and whitespace-only text', async t => {
  const scratch = path.join(root, '.scratch/packaging');
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, 'license-fixture-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const stage = licenseStager(fixture);
  const graph = {
    resolve: { root: 'app', nodes: [{ id: 'app', deps: [{ pkg: 'dep', dep_kinds: [{ kind: null }] }] }, { id: 'dep', deps: [] }] },
    packages: [{ id: 'app', name: 'app', version: '1.0.0' }, { id: 'dep', name: 'dep', version: '1.0.0', manifest_path: path.join(fixture, 'Cargo.toml'), license_file: 'custom.txt' }],
  };
  await assert.rejects(stageCrateLicenses(graph, stage), /Missing required license text/);
  await fs.writeFile(path.join(fixture, 'custom.txt'), ' \n');
  await assert.rejects(stageCrateLicenses(graph, stage), /Empty license text/);
  await fs.writeFile(path.join(fixture, 'custom.txt'), 'License text\n');
  assert.equal((await stageCrateLicenses(graph, stage)).crates.length, 1);
});
