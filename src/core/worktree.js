import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { readRunLease } from './run-lease.js';
import { prepareRestorePoint } from './restore-points.js';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';

const locks = new Map();
const skipped = new Set(['.git', 'node_modules', '.scratch', '.pi', '.ssh', '.aws', '.azure', '.config', 'target', 'dist', 'build', 'out', '.next', 'coverage', '.enma', '.npmrc', '.netrc', '.git-credentials']);
const credential = (name) => /^\.env(?:\.|$)/i.test(name) && name !== '.env.example' || /^(?:credentials(?:\.json)?|auth\.json|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(name);
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel); };
const same = (a, b) => !a && !b || Boolean(a && b && a.mode === b.mode && a.data.equals(b.data));
const id = (value) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid worktree identifier'); return value; };

async function processStartedAt(pid) {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`] : ['-p', String(pid), '-o', 'lstart='];
  try {
    const output = await new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 3000 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
    return Date.parse(output.trim());
  } catch { return NaN; }
}

async function lockWorkspace(root) {
  const real = fs.realpathSync.native(root);
  const key = createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), 'scranton-locks', `${key}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = `${process.pid}-${randomUUID()}.json`;
  const deadline = Date.now() + 30000;
  let backoff = 20;
  for (;;) {
    try {
      fs.mkdirSync(file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid workspace integration lock: ${file}`);
        const entries = fs.readdirSync(file);
        let removed = false;
        for (const name of entries) {
          const match = /^(\d+)-[a-f0-9-]+\.json$/.exec(name);
          if (!match) continue;
          let dead = false;
          try { process.kill(Number(match[1]), 0); } catch (error) { dead = error.code === 'ESRCH'; }
          const ownerPath = path.join(file, name);
          const raw = fs.readFileSync(ownerPath, 'utf8');
          if (!dead && Date.now() - stat.mtimeMs > 30000) {
            try {
              const holder = JSON.parse(raw);
              const started = await processStartedAt(Number(match[1]));
              dead = holder.pid === Number(match[1]) && Date.parse(holder.createdAt) + 2000 < started;
            } catch {}
          }
          if (dead && fs.readFileSync(ownerPath, 'utf8') === raw) {
            try { fs.unlinkSync(ownerPath); removed = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        // Only the reaper that removed the unique dead owner may remove its directory.
        if (removed || entries.length === 0 && Date.now() - stat.mtimeMs > 30000) {
          const current = fs.lstatSync(file);
          if (current.dev === stat.dev && current.ino === stat.ino && (removed || current.mtimeMs === stat.mtimeMs)) {
            try { fs.rmdirSync(file); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for workspace integration lock: ${real}`);
      await delay(backoff);
      backoff = Math.min(250, backoff * 2);
      continue;
    }
    try {
      fs.writeFileSync(path.join(file, owner), JSON.stringify({ pid: process.pid, token: owner, createdAt: new Date().toISOString() }), { flag: 'wx' });
    } catch (err) {
      try { fs.unlinkSync(path.join(file, owner)); } catch {}
      try { fs.rmdirSync(file); } catch {}
      throw err;
    }
    return () => {
      fs.rmSync(path.join(file, owner), { force: true });
      try { fs.rmdirSync(file); } catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
    };
  }
}

export async function withWorkspaceLock(root, operation) {
  const previous = locks.get(root) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const release = await lockWorkspace(root);
    try { return await operation(); }
    finally { release(); }
  });
  locks.set(root, task);
  try { return await task; } finally { if (locks.get(root) === task) locks.delete(root); }
}

export function safePath(root, relative = '', { platform = process.platform, fs: hostFs = fs, path: hostPath = path } = {}) {
  const fs = hostFs, path = hostPath;
  const parts = relative ? relative.split('/') : [];
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error(`Unsafe path: ${relative}`);
  const full = path.resolve(root, ...parts);
  if (!inside(root, full)) throw new Error(`Path escapes workspace: ${relative}`);
  let current = path.parse(root).root;
  for (const component of path.relative(current, full).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let st;
    try { st = fs.lstatSync(current); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    if (platform === 'darwin' && (current === '/var' || current === '/tmp') && st.isSymbolicLink()) {
      const target = `/private${current}`;
      if (path.resolve(path.dirname(current), fs.readlinkSync(current)) !== target || fs.realpathSync.native(current) !== target) throw new Error(`Link/reparse path rejected: ${current}`);
      // Check the canonical ancestors too; only the OS alias itself is exempt.
      current = safePath(target, '', { platform, fs, path });
      continue;
    }
    if (st.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== path.resolve(current).toLowerCase()) throw new Error(`Link/reparse path rejected: ${current}`);
  }
  return full;
}

function readEntry(root, relative) {
  const file = safePath(root, relative);
  let st;
  try { st = fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (!st.isFile() || st.nlink > 1) throw new Error(`Not an independent regular file: ${relative}`);
  return { data: fs.readFileSync(file), mode: st.mode & 0o111 ? '100755' : '100644', permissions: st.mode & 0o777 };
}

const activeStorage = new Set();
const metadataPath = (storage) => path.join(storage, 'shadow', '.git', 'worktrees', 'w' + '0'.repeat(32));

export function resolveIsolationRoot({ hiveDir, platform = process.platform, env = process.env, homedir = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  if (env.SCRANTON_ISOLATION_ROOT) return env.SCRANTON_ISOLATION_ROOT;
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local'), 'Scranton', 'iso');
  const local = path.join(hiveDir, 'isolation');
  if (Buffer.byteLength(metadataPath(path.join(local, '0'.repeat(32)))) <= 200) return local;
  const user = process.getuid?.() ?? createHash('sha256').update(homedir).digest('hex').slice(0, 16);
  return path.join(tmpdir, 'scranton-iso-' + user);
}

function canonicalRoot(root) {
  try { return fs.realpathSync.native(root); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return path.join(canonicalRoot(path.dirname(root)), path.basename(root));
  }
}

function privateRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(root);
  if (!stat.isDirectory() || process.getuid && stat.uid !== process.getuid()) throw new Error('Isolation root must be owned by the current user');
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  safePath(root);
}

export function cleanupIsolationStorage(hiveDir) {
  if (readRunLease(hiveDir)) throw new Error('Isolation storage is in use or requires recovery');
  const pointers = safePath(path.resolve(hiveDir), 'isolation');
  if (!fs.existsSync(pointers)) return 0;
  const root = canonicalRoot(path.resolve(resolveIsolationRoot({ hiveDir })));
  let removed = 0;
  for (const name of fs.readdirSync(pointers)) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const file = safePath(pointers, name);
    const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pointer.v !== 1 || typeof pointer.runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(pointer.runId) || typeof pointer.storage !== 'string' || !path.isAbsolute(pointer.storage)) throw new Error('Invalid isolation pointer');
    const storage = path.resolve(pointer.storage);
    try { fs.lstatSync(storage); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fs.unlinkSync(file);
      continue;
    }
    if (path.dirname(storage) !== root || path.basename(storage) !== name.slice(0, -5)) throw new Error(`Isolation pointer is outside the configured root: ${storage}`);
    safePath(root, path.basename(storage));
    const hiveLocal = root === path.join(path.resolve(hiveDir), 'isolation');
    if (typeof pointer.workspace !== 'string' || !path.isAbsolute(pointer.workspace) || inside(storage, path.resolve(hiveDir)) || inside(storage, pointer.workspace) || !hiveLocal && inside(pointer.workspace, storage)) throw new Error('Isolation pointer overlaps workspace or Hive');
    if (activeStorage.has(storage)) throw new Error('Isolation storage is in use');
    if (fs.existsSync(storage)) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(safePath(storage, '.scranton-isolation.json'), 'utf8')); }
      catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // Older storage has only a pointer; require its run's durable Hive record.
        const stateFile = safePath(path.resolve(hiveDir), 'state.json');
        const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
        const archived = safePath(path.resolve(hiveDir), 'runs/' + pointer.runId + '/state.json');
        owner = state?.runId === pointer.runId ? state : fs.existsSync(archived) ? JSON.parse(fs.readFileSync(archived, 'utf8')) : null;
      }
      if (!owner || owner.runId !== pointer.runId || owner.workspace !== pointer.workspace || owner.storage && owner.storage !== storage || owner.hiveDir && owner.hiveDir !== path.resolve(hiveDir)) throw new Error('Isolation pointer run does not match storage');
      if (readRunLease(hiveDir)) throw new Error('Isolation storage is in use or requires recovery');
      fs.rmSync(storage, { recursive: true });
      removed++;
    }
    fs.unlinkSync(file);
  }
  return removed;
}

// What a run integrated into its workspace, as a unified diff: from the snapshot the run started from (the root of
// refs/heads/integrated in its private repository) to what it integrated last. Read-only, and safe while the run
// is still going: it reads two commits and never the worktrees. null: the run kept no private repository (it ran
// without worktree isolation, or its storage was removed with its chat).
export async function readRunDiff({ hiveDir, runId, maxBytes = 1024 * 1024, timeoutMs = 15000 }) {
  const hive = path.resolve(hiveDir);
  id(runId);
  const pointers = safePath(hive, 'isolation');
  if (!fs.existsSync(pointers)) return null;
  const root = canonicalRoot(path.resolve(resolveIsolationRoot({ hiveDir: hive })));
  let storage = null;
  let createdAt = '';
  for (const name of fs.readdirSync(pointers)) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    let pointer;
    try { pointer = JSON.parse(fs.readFileSync(safePath(pointers, name), 'utf8')); } catch { continue; }
    if (pointer?.v !== 1 || pointer.runId !== runId || typeof pointer.storage !== 'string' || !path.isAbsolute(pointer.storage)) continue;
    const candidate = path.resolve(pointer.storage);
    // the same bounds the cleanup holds a pointer to: a directory of the isolation root, named like its pointer
    if (path.dirname(candidate) !== root || path.basename(candidate) !== name.slice(0, -5)) throw new Error(`Isolation pointer is outside the configured root: ${candidate}`);
    if (inside(candidate, hive) || typeof pointer.workspace === 'string' && inside(candidate, pointer.workspace)) throw new Error('Isolation pointer overlaps workspace or Hive');
    const at = typeof pointer.createdAt === 'string' ? pointer.createdAt : '';
    if (!storage || at >= createdAt) { storage = candidate; createdAt = at; }
  }
  if (!storage) return null;
  safePath(root, path.basename(storage));
  let owner;
  try { owner = JSON.parse(fs.readFileSync(safePath(storage, '.scranton-isolation.json'), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (owner?.runId !== runId || owner.hiveDir && owner.hiveDir !== hive) throw new Error('Isolation pointer run does not match storage');
  const gitDir = safePath(storage, 'shadow/.git');
  if (!fs.existsSync(gitDir)) return null;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const git = (args, maxBuffer) => new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.longpaths=true', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'core.attributesFile=', `--git-dir=${gitDir}`, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'buffer', maxBuffer, timeout: timeoutMs, windowsHide: true,
    }, (error, stdout) => {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ stdout: stdout.subarray(0, maxBuffer), truncated: true });
      else if (error) reject(error);
      else resolve({ stdout, truncated: false });
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
  let base;
  try { base = (await git(['rev-list', '--max-parents=0', 'refs/heads/integrated'], 64 * 1024)).stdout.toString('utf8').trim().split('\n')[0]; }
  catch { return null; }
  if (!/^[a-f0-9]{40,64}$/.test(base)) return null;
  // no external diff, text conversion or rename guessing: the bytes of the two snapshots, as plain hunks
  const { stdout, truncated } = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, 'refs/heads/integrated', '--'], maxBytes);
  return { content: stdout.toString('utf8'), truncated };
}

export class WorktreeManager {
  constructor({ workspace, hiveDir, runId }) {
    this.workspace = path.resolve(workspace);
    this.hiveDir = path.resolve(hiveDir);
    this.runId = id(runId);
    if (inside(this.hiveDir, this.workspace)) throw new Error('Hive must not contain the workspace');
    this.worktrees = new Map();
    this.snapshots = new Map();
    this.closed = false;
    this.queue = Promise.resolve();
  }

  git(args, input, extraEnv = {}, { gitDir = path.join(this.repo, '.git'), workTree = this.repo } = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.longpaths=true', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-C', this.repo, `--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args], {
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Scranton', GIT_AUTHOR_EMAIL: 'scranton@localhost', GIT_COMMITTER_NAME: 'Scranton', GIT_COMMITTER_EMAIL: 'scranton@localhost', ...extraEnv },
        encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, windowsHide: true
      }, (error, stdout) => {
        if (error) reject(error); else resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  assertReady() { if (!this.repo || this.closed) throw new Error('Worktree manager is not open'); }

  async init() {
    if (this.repo) throw new Error('Worktree manager already initialized');
    safePath(this.workspace);
    safePath(this.hiveDir);
    let root = resolveIsolationRoot({ hiveDir: this.hiveDir });
    if (!path.isAbsolute(root) || /[,\x00-\x1f\x7f]/.test(root)) throw new Error('SCRANTON_ISOLATION_ROOT must be an absolute path without commas or control characters');
    root = canonicalRoot(root);
    const hiveLocal = !process.env.SCRANTON_ISOLATION_ROOT && process.platform !== 'win32' && root === path.join(this.hiveDir, 'isolation');
    if (!hiveLocal && (inside(this.workspace, root) || inside(root, this.workspace))) throw new Error('Isolation root must not overlap the workspace (integration target)');
    const token = randomUUID().replaceAll('-', '');
    const storage = path.join(root, token);
    // Git for Windows rejects GIT_DIR > 220 bytes; reserve space for lock suffixes.
    const metadata = metadataPath(storage);
    if (Buffer.byteLength(metadata) > 200) throw new Error('Isolation Git path is too long (' + Buffer.byteLength(metadata) + ' bytes; maximum 200): ' + metadata + '. Set SCRANTON_ISOLATION_ROOT to a shorter absolute directory before starting a run.');
    privateRoot(root);
    const pointers = path.join(this.hiveDir, 'isolation');
    fs.mkdirSync(pointers, { recursive: true, mode: 0o700 });
    this.pointerFile = safePath(pointers, token + '.json');
    const pointer = JSON.stringify({ v: 1, runId: this.runId, storage, workspace: this.workspace, hiveDir: this.hiveDir, createdAt: new Date().toISOString() });
    const temp = this.pointerFile + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      fs.writeFileSync(temp, pointer, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, this.pointerFile);
      fs.mkdirSync(storage, { mode: 0o700 });
      created = true;
      fs.writeFileSync(path.join(storage, '.scranton-isolation.json'), pointer, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (created) fs.rmSync(storage, { recursive: true, force: true });
      fs.rmSync(temp, { force: true });
      fs.rmSync(this.pointerFile, { force: true });
      throw err;
    }
    this.storage = storage;
    activeStorage.add(storage);
    this.repo = path.join(this.storage, 'shadow');
    fs.mkdirSync(this.repo);
    await this.git(['init', '--quiet']);
    this.initial = await this.collect(this.workspace);
    this.integrated = new Map(this.initial);
    this.integratedRef = await this.commit(this.initial, null);
    await this.git(['update-ref', 'refs/heads/integrated', this.integratedRef]);
    return this;
  }

  async collect(root, tracked = new Map()) {
    safePath(root);
    const entries = new Map();
    const ignoreRoot = path.join(this.storage, `ignore-${randomUUID()}`);
    fs.mkdirSync(ignoreRoot);
    const trackedDirs = new Set();
    for (const name of tracked.keys()) {
      const parts = name.split('/');
      while (parts.length > 1) { parts.pop(); trackedDirs.add(parts.join('/')); }
    }
    const walk = async (dir, prefix = '') => {
      const ignore = path.join(dir, '.gitignore');
      if (fs.existsSync(ignore)) {
        const entry = readEntry(root, prefix + '.gitignore');
        const destination = path.join(ignoreRoot, ...prefix.split('/').filter(Boolean), '.gitignore');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, entry.data);
      }
      const candidates = fs.readdirSync(dir, { withFileTypes: true }).filter((ent) => {
        const full = path.join(dir, ent.name);
        return !skipped.has(ent.name) && !credential(ent.name) && !(root === this.workspace && (inside(this.hiveDir, full) || inside(this.storage, full)));
      });
      const paths = candidates.map((ent) => prefix + ent.name + (ent.isDirectory() ? '/' : ''));
      let ignored = new Set();
      if (paths.length) {
        try {
          const output = await this.git(['check-ignore', '--no-index', '-z', '--stdin'], Buffer.from(paths.join('\0') + '\0'), {}, { workTree: ignoreRoot });
          ignored = new Set(output.toString('utf8').split('\0').filter(Boolean));
        } catch (err) { if (err.code !== 1) throw err; }
      }
      for (const ent of candidates) {
        const rel = prefix + ent.name;
        if (!tracked.has(rel) && !trackedDirs.has(rel) && ignored.has(rel + (ent.isDirectory() ? '/' : ''))) continue;
        safePath(root, rel);
        if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel + '/');
        else {
          entries.set(rel, readEntry(root, rel));
          if (entries.size % 32 === 0) await setImmediate();
        }
      }
    };
    try { await walk(root); return entries; }
    finally { fs.rmSync(ignoreRoot, { recursive: true, force: true }); }
  }

  async commit(entries, parent) {
    const staging = path.join(this.storage, `objects-${randomUUID()}`);
    fs.mkdirSync(staging);
    const index = path.join(staging, 'index');
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(['read-tree', '--empty'], undefined, env);
      const files = [];
      for (const [name, entry] of entries) {
        safePath(this.workspace, name);
        const file = path.join(staging, String(files.length));
        fs.writeFileSync(file, entry.data, { flag: 'wx' });
        files.push(JSON.stringify(file.replaceAll('\\', '/')));
        if (files.length % 32 === 0) await setImmediate();
      }
      // Private staging bypasses agent pointers; --no-filters preserves exact bytes.
      const hashes = files.length ? (await this.git(['hash-object', '-w', '--no-filters', '--stdin-paths'], files.join('\n') + '\n')).toString().trim().split('\n') : [];
      if (hashes.length !== files.length || hashes.some((hash) => !/^[a-f0-9]{40,64}$/.test(hash))) throw new Error('Invalid snapshot object response');
      const records = [...entries].map(([name, entry], i) => `${entry.mode} ${hashes[i]}\t${name}\0`);
      if (records.length) await this.git(['update-index', '-z', '--index-info'], Buffer.from(records.join('')), env);
      const tree = (await this.git(['write-tree'], undefined, env)).toString().trim();
      return (await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Scranton isolated snapshot\n')).toString().trim();
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  async createWorktree({ agent, milestoneId, baseRef } = {}) {
    this.assertReady();
    const key = `${id(agent)}-${id(milestoneId)}`;
    if (this.worktrees.has(key)) {
      const { dir, ref } = this.worktrees.get(key);
      return { dir, ref };
    }
    const base = baseRef ?? this.integratedRef;
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Invalid private snapshot ref');
    const name = `w${randomUUID().replaceAll('-', '')}`;
    const ref = `refs/heads/${name}`;
    const dir = path.join(this.storage, name);
    await this.git(['worktree', 'add', '--quiet', '--no-checkout', '-b', ref.slice(11), dir, base]);
    const metadata = fs.readFileSync(path.join(dir, '.git'), 'utf8').trim().slice('gitdir: '.length);
    if (!inside(path.join(this.repo, '.git', 'worktrees'), path.resolve(metadata))) throw new Error('Unexpected private worktree metadata');
    await this.git(['read-tree', base], undefined, {}, { gitDir: metadata });
    const baseline = await this.readSnapshot(base);
    // Checkout filters/attributes must not change the bytes that QA is verifying.
    let written = 0;
    for (const [name, entry] of baseline) {
      const file = safePath(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.data, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      if (++written % 32 === 0) await setImmediate();
    }
    const record = { dir, ref, base, baseline };
    this.worktrees.set(key, record);
    return { dir, ref };
  }

  async readSnapshot(ref) {
    const result = new Map();
    const rows = (await this.git(['ls-tree', '-rz', ref])).toString('utf8').split('\0').filter(Boolean).map((row) => {
      const tab = row.indexOf('\t');
      const [mode, type, hash] = row.slice(0, tab).split(' ');
      const name = row.slice(tab + 1);
      safePath(this.workspace, name);
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Unsupported snapshot entry');
      return { mode, hash, name };
    });
    if (!rows.length) return result;
    const data = await this.git(['cat-file', '--batch'], rows.map((row) => row.hash).join('\n') + '\n');
    let offset = 0;
    for (const { mode, hash, name } of rows) {
      const end = data.indexOf(10, offset);
      const header = data.subarray(offset, end).toString('ascii').split(' ');
      const size = Number(header[2]);
      offset = end + 1;
      if (end < 0 || header[0] !== hash || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || offset + size >= data.length || data[offset + size] !== 10) throw new Error('Invalid snapshot blob response');
      result.set(name, { mode, data: Buffer.from(data.subarray(offset, offset + size)) });
      offset += size + 1;
    }
    if (offset !== data.length) throw new Error('Unexpected snapshot blob response');
    return result;
  }

  async snapshotWorktree({ agent, milestoneId }) {
    this.assertReady();
    const record = this.worktrees.get(`${id(agent)}-${id(milestoneId)}`);
    if (!record || agent !== 'dwight') throw new Error('Only a developer worktree can be submitted');
    const entries = await this.collect(record.dir, record.baseline);
    const ref = await this.commit(entries, record.base);
    await this.git(['update-ref', record.ref, ref]);
    this.snapshots.set(milestoneId, { ref, entries, baseline: record.baseline });
    return ref;
  }

  changedFiles({ milestoneId }) {
    const snapshot = this.snapshots.get(milestoneId);
    if (!snapshot) return null;
    return [...new Set([...snapshot.baseline.keys(), ...snapshot.entries.keys()])]
      .filter((name) => !same(snapshot.baseline.get(name), snapshot.entries.get(name))).sort();
  }

  async createQaWorktree({ milestoneId }) { return this.createGateWorktree({ agent: 'angela', milestoneId }); }

  async createGateWorktree({ agent, milestoneId }) {
    if (typeof agent !== 'string' || !/^[a-z][a-z0-9]{1,19}$/.test(agent) || ['michael', 'dwight'].includes(agent)) throw new Error('Invalid gate role');
    const priorTask = this.gateQueue ?? Promise.resolve();
    const task = priorTask.then(() => this.prepareGate({ agent, milestoneId }));
    this.gateQueue = task.catch(() => {});
    return task;
  }

  async prepareGate({ agent, milestoneId }) {
    this.assertReady();
    const snapshot = this.snapshots.get(milestoneId);
    if (!snapshot) throw new Error('Developer snapshot required before QA');
    const key = `${agent}-${id(milestoneId)}`;
    const prior = this.worktrees.get(key);
    if (prior) {
      await this.git(['worktree', 'remove', '--force', prior.dir]);
      this.worktrees.delete(key);
      await this.git(['update-ref', '-d', prior.ref]);
    }
    const result = await this.createWorktree({ agent, milestoneId, baseRef: snapshot.ref });
    this.worktrees.get(key).qaSnapshot = snapshot;
    return result;
  }

  async integrateToTarget({ milestoneId, workspace = this.workspace }) {
    this.assertReady();
    const root = path.resolve(workspace);
    if (root !== this.workspace) throw new Error('Integration target must be the original workspace');
    const task = withWorkspaceLock(root, () => this.integrate(milestoneId, root));
    this.queue = task.catch(() => {});
    return task;
  }

  async integrate(milestoneId, root) {
    const snapshot = this.snapshots.get(milestoneId);
    if (!snapshot) throw new Error('No developer snapshot to integrate');
    if (![...this.worktrees.values()].some((record) => record.qaSnapshot === snapshot)) throw new Error('Latest developer snapshot requires a matching QA checkout before integration');
    const changes = [...new Set([...snapshot.baseline.keys(), ...snapshot.entries.keys()])].filter((name) => !same(snapshot.baseline.get(name), snapshot.entries.get(name))).sort();
    const before = new Map();
    for (const name of changes) {
      const entry = readEntry(root, name);
      if (!same(entry, snapshot.baseline.get(name))) throw new Error(`Integration conflict: ${name}`);
      before.set(name, entry);
    }
    const merged = new Map(this.integrated);
    for (const name of changes) { const entry = snapshot.entries.get(name); if (entry) merged.set(name, entry); else merged.delete(name); }
    const ref = await this.commit(merged, this.integratedRef);
    const restore = prepareRestorePoint({ hiveDir: this.hiveDir, runId: this.runId, workspace: root, changes, before, initial: this.initial, after: snapshot.entries });
    const applied = [];
    const createdDirs = [];
    let refUpdated = false;
    const write = (name, entry) => {
      const file = safePath(root, name);
      if (!entry) { fs.unlinkSync(file); return; }
      const missing = [];
      for (let dir = path.dirname(file); dir !== root && !fs.existsSync(dir); dir = path.dirname(dir)) missing.unshift(dir);
      for (const dir of missing) { fs.mkdirSync(dir); createdDirs.push(dir); }
      safePath(root, name);
      const temp = path.join(path.dirname(file), `.scranton-${randomUUID()}.tmp`);
      try { fs.writeFileSync(temp, entry.data, { flag: 'wx', mode: entry.permissions ?? (entry.mode === '100755' ? 0o755 : 0o644) }); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, { force: true }); }
    };
    try {
      for (const name of changes) {
        if (!same(readEntry(root, name), before.get(name))) throw new Error(`Concurrent integration conflict: ${name}`);
        const entry = snapshot.entries.get(name);
        const previous = before.get(name);
        write(name, entry && previous ? { ...entry, permissions: (previous.permissions & 0o666) | (entry.mode === '100755' ? 0o111 : 0) } : entry);
        applied.push(name);
      }
      await this.git(['update-ref', 'refs/heads/integrated', ref]);
      refUpdated = true;
      restore.commit();
    } catch (err) {
      const failures = [];
      for (const name of applied.reverse()) {
        try {
          if (!same(readEntry(root, name), snapshot.entries.get(name))) throw new Error(`Rollback conflict: ${name}`);
          if (before.get(name)) write(name, before.get(name));
          else if (fs.existsSync(safePath(root, name))) fs.unlinkSync(safePath(root, name));
        } catch (rollback) { failures.push(rollback.message); }
      }
      for (const dir of createdDirs.reverse()) { try { fs.rmdirSync(dir); } catch {} }
      if (refUpdated) { try { await this.git(['update-ref', 'refs/heads/integrated', this.integratedRef, ref]); } catch { failures.push('Private integration ref rollback failed'); } }
      if (!failures.length) { try { restore.rollback(); } catch { failures.push('Restore point rollback could not be persisted'); } }
      if (failures.length) throw new AggregateError([err, ...failures.map((message) => new Error(message))], 'Integration failed; rollback incomplete, preserve artifacts for recovery');
      throw err;
    }
    this.integrated = merged;
    this.integratedRef = ref;
    return { ref, files: changes, ...(restore.notRestorable.length ? { notRestorable: restore.notRestorable } : {}) };
  }

  async close() { await this.gateQueue; await this.queue; this.closed = true; activeStorage.delete(this.storage); }
}
