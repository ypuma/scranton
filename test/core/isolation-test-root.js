import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const base = path.resolve('.scratch/gitdir-fix3');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'iso-'));
const previous = process.env.SCRANTON_ISOLATION_ROOT;
const credentialRoot = fs.mkdtempSync(path.join(base, 'credentials-'));
const importRoot = path.join(credentialRoot, 'empty-import');
fs.mkdirSync(importRoot);
const previousCredentials = process.env.SCRANTON_CREDENTIALS_DIR;
const previousImport = process.env.PI_CODING_AGENT_DIR;
process.env.SCRANTON_CREDENTIALS_DIR = credentialRoot;
process.env.PI_CODING_AGENT_DIR = importRoot;
export const profileIsolationRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Scranton', 'iso');
const inside = (parent, file) => {
  const rel = path.relative(parent, file);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

export function isolationEntries(directory = profileIsolationRoot) {
  try { return fs.readdirSync(directory); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

export function newTestIsolationEntries(before, directory = profileIsolationRoot) {
  return isolationEntries(directory).filter((name) => {
    if (before.includes(name)) return false;
    try {
      const storage = path.join(directory, name);
      if (!fs.lstatSync(storage).isDirectory() || fs.lstatSync(storage).isSymbolicLink()) return false;
      const marker = path.join(storage, '.scranton-isolation.json');
      if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink()) return false;
      const { workspace } = JSON.parse(fs.readFileSync(marker, 'utf8'));
      return typeof workspace === 'string' && path.isAbsolute(workspace) &&
        [os.tmpdir(), path.resolve('.scratch')].some((parent) => inside(parent, workspace));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) return false;
      throw err;
    }
  });
}

const before = isolationEntries();
process.env.SCRANTON_ISOLATION_ROOT = root;
export const isolationTestEnv = (extra = {}) => ({ ...process.env, SCRANTON_CREDENTIALS_DIR: credentialRoot, PI_CODING_AGENT_DIR: importRoot, ...extra, SCRANTON_ISOLATION_ROOT: root });
after(() => {
  try {
    assert.deepEqual(newTestIsolationEntries(before), [], 'Tests polluted the real profile isolation root');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(credentialRoot, { recursive: true, force: true });
    if (previousCredentials === undefined) delete process.env.SCRANTON_CREDENTIALS_DIR;
    else process.env.SCRANTON_CREDENTIALS_DIR = previousCredentials;
    if (previousImport === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousImport;
    if (previous === undefined) delete process.env.SCRANTON_ISOLATION_ROOT;
    else process.env.SCRANTON_ISOLATION_ROOT = previous;
  }
});
