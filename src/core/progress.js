import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { excludedSnapshotName } from './worktree.js';

export const normalizeFailure = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim();

export function snapshotFingerprint(entries) {
  const hash = createHash('sha256');
  for (const [name, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, entry.mode, entry.data.length]) + '\n');
    hash.update(entry.data);
  }
  return hash.digest('hex');
}

// Unknown is not evidence of no change. Never let this advisory scan stop the run.
export async function sharedFingerprint(root, hive, { fs: io = fs, maxBytes = 32 * 1024 * 1024, maxEntries = 10000, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = performance.now() + timeoutMs;
  let timer, scratch, bytes = 0, count = 0;
  const check = () => { signal.throwIfAborted(); if (performance.now() >= deadline) throw new Error('Fingerprint budget exceeded'); };
  const read = async (file) => {
    check();
    const handle = await io.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes - bytes) throw new Error('Fingerprint size budget exceeded');
      const chunks = [];
      for (;;) {
        check();
        const buffer = Buffer.alloc(Math.min(65536, maxBytes - bytes + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > maxBytes) throw new Error('Fingerprint size budget exceeded');
        chunks.push(buffer.subarray(0, bytesRead));
        await setImmediate();
      }
      return { data: Buffer.concat(chunks), mode: stat.mode & 0o111 ? '100755' : '100644' };
    } finally { await handle.close(); }
  };
  const scan = async () => {
    try {
      root = path.resolve(root); hive = path.resolve(hive);
      scratch = await fs.mkdtemp(path.join(hive, 'fingerprint-'));
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
      // Only our private repository/config is used, never the workspace's Git config.
      const git = (args, input, extraEnv = {}) => {
        check();
        return new Promise((resolve, reject) => {
          const child = execFile('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=', '-C', scratch, ...args], { env: { ...env, ...extraEnv }, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            if (error && !(args[0] === 'check-ignore' && error.code === 1)) reject(error); else resolve(stdout);
          });
          child.stdin.on('error', () => {});
          child.stdin.end(input);
        });
      };
      await git(['init', '--quiet']);
      const tracked = new Set(), trackedDirs = new Set();
      for (let dir = root; ; dir = path.dirname(dir)) {
        check();
        const marker = path.join(dir, '.git');
        let stat;
        try { stat = await fs.lstat(marker); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat) {
          let metadata = marker;
          if (stat.isFile()) {
            const pointer = (await read(marker)).data.toString('utf8').trim();
            if (!pointer.startsWith('gitdir: ')) throw new Error('Invalid Git directory pointer');
            metadata = path.resolve(dir, pointer.slice(8));
          } else if (!stat.isDirectory()) throw new Error('Invalid Git directory');
          // Read the index with private config so workspace hooks/config cannot run.
          const names = await git(['ls-files', '--cached', '-z'], undefined, { GIT_INDEX_FILE: path.join(metadata, 'index') });
          const prefix = path.relative(dir, root).split(path.sep).join('/');
          for (const name of names.split('\0').filter(Boolean)) {
            if (prefix && !name.startsWith(prefix + '/')) continue;
            const relative = prefix ? name.slice(prefix.length + 1) : name;
            tracked.add(relative);
            const parts = relative.split('/');
            while (parts.length > 1) { parts.pop(); trackedDirs.add(parts.join('/')); }
          }
          break;
        }
        if (path.dirname(dir) === dir) break;
      }
      const entries = new Map();
      const walk = async (dir, prefix = '') => {
        check();
        const candidates = [];
        const directory = await io.opendir(dir);
        for await (const ent of directory) {
          check();
          if (++count > maxEntries) throw new Error('Fingerprint entry budget exceeded');
          const file = path.join(dir, ent.name);
          if (excludedSnapshotName(ent.name) || file === hive || ent.isSymbolicLink()) continue;
          candidates.push(ent);
          if (count % 32 === 0) await setImmediate();
        }
        if (candidates.some(ent => ent.name === '.gitignore' && ent.isFile())) {
          const entry = await read(path.join(dir, '.gitignore'));
          const destination = path.join(scratch, prefix, '.gitignore');
          check();
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, entry.data);
        }
        const names = candidates.map(ent => prefix + ent.name + (ent.isDirectory() ? '/' : ''));
        const ignored = names.length ? new Set((await git(['check-ignore', '--no-index', '-z', '--stdin'], names.join('\0') + '\0')).split('\0').filter(Boolean)) : new Set();
        for (const ent of candidates) {
          check();
          const name = prefix + ent.name, file = path.join(dir, ent.name);
          if (!tracked.has(name) && !trackedDirs.has(name) && ignored.has(name + (ent.isDirectory() ? '/' : ''))) continue;
          if (ent.isDirectory()) await walk(file, name + '/');
          else if (ent.isFile()) {
            const entry = await read(file);
            entries.set(name, [entry.mode, entry.data.length, createHash('sha256').update(entry.data).digest('hex')]);
          }
          await setImmediate();
        }
      };
      await walk(root);
      check();
      return createHash('sha256').update(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    } catch { return null; }
    finally { if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  };
  try {
    return await Promise.race([scan(), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
