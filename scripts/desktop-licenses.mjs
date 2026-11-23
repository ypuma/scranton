import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { archiveMember } from './desktop-tools.mjs';
import { crateLicenseSources, wheelLicenseSources } from './desktop-license-sources.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const licenseName = /^(?:licen[sc]e|copying|unlicense|copyright)(?:$|[._-])/i;
const noticeName = /^(?:notice|authors)(?:$|[._-])/i;
export const rustManifests = ['src-tauri/Cargo.toml', 'native/sandbox-helper/Cargo.toml'];

function relative(file) {
  if (/[:\\\x00-\x1f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid license path: ${file}`);
  }
  return file;
}

function receipt(file, bytes) {
  if (!bytes.toString('utf8').trim()) throw new Error(`Empty license text: ${file}`);
  return { file, bytes: bytes.length, sha256: sha256(bytes) };
}

async function readLicense(file) {
  const stat = await fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`Missing required license text: ${file}`);
    throw error;
  });
  if (!stat.isFile()) throw new Error(`License must be a regular file: ${file}`);
  return fs.readFile(file);
}

export function licenseStager(app) {
  return async (name, bytes) => {
    const file = `licenses/${relative(name)}`;
    const record = receipt(file, bytes);
    const destination = path.join(app, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
    return record;
  };
}

async function download(url, timeout = 30000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`License source ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function stageWhisperLicense(cache, pin, stage) {
  if (!/^https:\/\/raw\.githubusercontent\.com\/ggml-org\/whisper\.cpp\/b\d+\/LICENSE$/.test(pin.url) ||
      !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Invalid Whisper license pin');
  const archive = path.join(cache, `whisper-license-${pin.sha256.slice(0, 16)}`);
  const verify = (bytes) => {
    if (sha256(bytes) !== pin.sha256) throw new Error('Whisper license SHA-256 mismatch');
  };
  let bytes = await fs.readFile(archive).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!bytes) {
    bytes = await download(pin.url);
    verify(bytes);
    const temp = `${archive}.${randomUUID()}.part`;
    try { await fs.writeFile(temp, bytes); await fs.rename(temp, archive); }
    finally { await fs.rm(temp, { force: true }); }
  }
  verify(bytes);
  return { ...await stage('tools/whisper/LICENSE', bytes), source: pin.url };
}

async function stageSupplement(stage, prefix, sources) {
  return Promise.all(sources.map(async ([name, url, expected]) => {
    const bytes = await download(url);
    if (sha256(bytes) !== expected) throw new Error(`License source SHA-256 mismatch: ${url}`);
    return { ...await stage(`${prefix}/${name}`, bytes), source: url };
  }));
}

export async function stageNodeLicense(root, host, version, binarySha256, stage) {
  if (!/^v24\.\d+\.\d+$/.test(version)) throw new Error('Node license staging requires a published Node 24 release.');
  const dist = `https://nodejs.org/dist/${version}`;
  const checksums = (await download(`${dist}/SHASUMS256.txt`)).toString('utf8');
  const distribution = `node-${version}-${host.platform}-${host.arch}`;
  const asset = host.platform === 'win32' ? `win-${host.arch}/node.exe` : `${distribution}.tar.gz`;
  const expected = checksums.split(/\r?\n/).map(line => line.split(/\s+/)).find(([, name]) => name === asset)?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error(`Missing Node.js release checksum: ${asset}`);
  const mismatch = () => new Error(`Bundled Node does not match the official ${version} binary (${asset}).`);
  if (host.platform === 'win32') {
    if (binarySha256 !== expected) throw mismatch();
    const source = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
    return { version, ...await stage('node/LICENSE', await download(source)), source };
  }
  const cache = path.join(root, '.scratch/packaging/node-license-cache', asset);
  let bytes = await fs.readFile(cache).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!bytes) {
    bytes = await download(`${dist}/${asset}`, 120000);
    if (sha256(bytes) !== expected) throw mismatch();
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, bytes);
  } else if (sha256(bytes) !== expected) throw mismatch();
  if (sha256(archiveMember(cache, `${distribution}/bin/node`, 256 * 1024 * 1024)) !== binarySha256) throw mismatch();
  return { version, ...await stage('node/LICENSE', archiveMember(cache, `${distribution}/LICENSE`)), source: `${dist}/${asset}` };
}

export function cargoMetadata(cargo, root, manifest, target, { offline = false } = {}) {
  return JSON.parse(execFileSync(cargo, ['metadata', '--format-version', '1', '--locked', '--filter-platform', target,
    '--manifest-path', manifest, ...(offline ? ['--offline'] : [])], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000, windowsHide: true,
  }));
}

export async function stageCrateLicenses(metadata, stage) {
  const root = metadata.resolve.root;
  if (!root) throw new Error('Cargo metadata has no application root.');
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  const closure = new Set([root]);
  for (const id of closure) {
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some(({ kind }) => kind === null)) closure.add(dep.pkg);
    }
  }
  closure.delete(root);
  const application = packages.get(root);
  const crates = [];
  for (const id of [...closure].sort()) {
    const pkg = packages.get(id);
    const key = `${pkg.name}@${pkg.version}`;
    const dir = path.dirname(pkg.manifest_path);
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries.filter(entry => !entry.isDirectory() && (licenseName.test(entry.name) || noticeName.test(entry.name)))
      .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
    if (pkg.license_file) files.push(pkg.license_file.split(path.sep).join('/'));
    const prefix = `rust/${application.name}/${key}-${sha256(pkg.source ?? id).slice(0, 16)}`;
    const licenses = [];
    for (const file of [...new Set(files)].sort()) {
      licenses.push(await stage(`${prefix}/${file}`, await readLicense(path.join(dir, relative(file)))));
    }
    if (!pkg.license_file && !files.some(file => licenseName.test(file))) {
      const sources = crateLicenseSources[key];
      if (!sources || pkg.source !== 'registry+https://github.com/rust-lang/crates.io-index') {
        throw new Error(`Missing required license text for Rust crate ${key}.`);
      }
      licenses.push(...await stageSupplement(stage, prefix, sources));
    }
    crates.push({ name: pkg.name, version: pkg.version, source: pkg.source, repository: pkg.repository, license: pkg.license, files: licenses });
  }
  return { name: application.name, version: application.version, crates };
}

export async function pipelineLicenses(app, host, version, stage) {
  const runtime = 'engine-runtime';
  const cpython = host.platform === 'win32' ? `${runtime}/python/LICENSE.txt` : `${runtime}/python/lib/python${version.split('.').slice(0, 2).join('.')}/LICENSE.txt`;
  const existing = async file => receipt(file, await readLicense(path.join(app, file)));
  const python = { version, files: [await existing(cpython)] };
  const site = `${runtime}/site-packages`;
  const distributions = (await fs.readdir(path.join(app, site))).filter(name => name.endsWith('.dist-info')).sort();
  const wheels = [];
  for (const distribution of distributions) {
    const base = `${site}/${distribution}`;
    const dir = path.join(app, base);
    const metadata = (await fs.readFile(path.join(dir, 'METADATA'), 'utf8')).split(/\r?\n\r?\n/, 1)[0];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = new Set(entries.filter(entry => !entry.isDirectory() && (licenseName.test(entry.name) || noticeName.test(entry.name))).map(entry => entry.name));
    const hasLicensesFolder = entries.some(entry => entry.name === 'licenses' && entry.isDirectory());
    if (hasLicensesFolder) {
      const children = await fs.readdir(path.join(dir, 'licenses'), { recursive: true, withFileTypes: true });
      for (const child of children.filter(entry => !entry.isDirectory())) {
        files.add(path.relative(dir, path.join(child.parentPath, child.name)).split(path.sep).join('/'));
      }
    }
    for (const [, file] of metadata.matchAll(/^License-File: ([^\r\n]+)\r?$/gm)) {
      relative(file);
      files.add(files.has(`licenses/${file}`) || (hasLicensesFolder && !files.has(file)) ? `licenses/${file}` : file);
    }
    const records = await Promise.all([...files].sort().map(file => existing(`${base}/${relative(file)}`)));
    if (!hasLicensesFolder && ![...files].some(file => licenseName.test(file))) {
      const sources = wheelLicenseSources[distribution];
      if (!sources) throw new Error(`Missing required license text for Pipeline wheel ${distribution}.`);
      records.push(...await stageSupplement(stage, `python-wheels/${distribution}`, sources));
    }
    if (!records.length) throw new Error(`Missing required license text for Pipeline wheel ${distribution}.`);
    wheels.push({ distribution, files: records });
  }
  if (!wheels.length) throw new Error('Pipeline license inventory found no installed wheels.');
  return { python, wheels };
}
