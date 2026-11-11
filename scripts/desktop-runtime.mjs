import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { launchManifest } from './desktop-platform.mjs';

export const digest = (content) => createHash('sha256').update(content).digest('hex');
export const bootstrap = `import runpy
import sys
from pathlib import Path

if not sys.flags.isolated:
    raise RuntimeError("Bundled engine requires isolated Python (-I)")
runtime = Path(__file__).resolve().parent
sys.path[:] = [str(runtime / "site-packages")] + [p for p in sys.path if p and "site-packages" not in Path(p).parts]
runpy.run_module("scranton_pipeline", run_name="__main__", alter_sys=True)
`;

export function runtimeFiles(host) {
  const suffix = host.platform === 'win32' ? '' : `-${host.platform}-${host.arch}`;
  return { archive: `runtime-lock${suffix}.json`, requirements: `requirements${suffix}.lock` };
}

export function validateRuntimeLock(lock, host) {
  if (!/^3\.14\.\d+$/.test(lock.version) || !/^[a-f0-9]{64}$/.test(lock.sha256)) throw new Error('Invalid CPython runtime lock version/hash.');
  const expected = host.platform === 'win32'
    ? `https://www.python.org/ftp/python/${lock.version}/python-${lock.version}-embed-amd64.zip`
    : `https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-${lock.version}%2B20261110-${host.arch === 'x64' ? 'x86_64' : 'aarch64'}-${host.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}-install_only.tar.gz`;
  if (lock.url !== expected || (host.platform !== 'win32' && (lock.platform !== host.platform || lock.arch !== host.arch || lock.format !== 'tar.gz'))) throw new Error('Runtime lock does not match the trusted native CPython archive.');
  return lock;
}

export function runtimeCacheKey(host, archiveLock, requirements, filter) {
  return digest(JSON.stringify({ schema: 2, platform: host.platform, arch: host.arch, target: host.target,
    archiveLock, requirementsSha256: digest(requirements), filter, launch: launchManifest(host), bootstrap }));
}

export async function runtimeFingerprint(directory) {
  const root = await fs.realpath(directory);
  const hash = createHash('sha256');
  let bytes = 0, files = 0;
  async function visit(dir, prefix = '') {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = prefix + entry.name;
      const stat = await fs.lstat(file);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(file), rel = path.relative(root, target);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Escaping runtime link: ${relative}`);
        if ((await fs.stat(file)).isDirectory()) throw new Error(`Directory runtime link cannot be packaged safely: ${relative}`);
        const link = await fs.readlink(file);
        hash.update(relative).update('\0link\0').update(link).update('\0');
        bytes += Buffer.byteLength(link); files++;
      } else if (entry.isDirectory()) await visit(file, `${relative}/`);
      else if (entry.isFile()) {
        const content = await fs.readFile(file);
        hash.update(relative).update('\0file\0').update(String(stat.mode & 0o777)).update('\0').update(String(content.length)).update('\0').update(content);
        bytes += content.length; files++;
      } else throw new Error(`Unsupported runtime entry: ${relative}`);
    }
  }
  await visit(directory);
  return { sha256: hash.digest('hex'), bytes, files };
}

export async function runtimeCacheValid(runtime, receipt, key, host) {
  if (receipt?.key !== key) return false;
  try {
    if (JSON.stringify(JSON.parse(await fs.readFile(path.join(runtime, 'launch.json'), 'utf8'))) !== JSON.stringify(launchManifest(host))) return false;
    return (await runtimeFingerprint(runtime)).sha256 === receipt.sha256;
  } catch { return false; }
}

export function lockedWheels(lock, hashes) {
  if (!Array.isArray(lock.wheels) || lock.wheels.length !== hashes.size) throw new Error('Incomplete locked wheel inventory.');
  const seen = new Set(), names = new Set();
  for (const wheel of lock.wheels) {
    const url = new URL(wheel.url);
    if (!/^[\w.+-]+\.whl$/.test(wheel.file) || url.origin !== 'https://files.pythonhosted.org' || url.username || url.password || url.search || url.hash ||
        path.posix.basename(url.pathname) !== wheel.file || !hashes.has(wheel.sha256) || seen.has(wheel.sha256) || names.has(wheel.file)) throw new Error('Invalid locked wheel URL, filename or hash.');
    seen.add(wheel.sha256); names.add(wheel.file);
  }
  return lock.wheels;
}
