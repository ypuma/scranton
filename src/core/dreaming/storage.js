import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const HASH = /^[a-f0-9]{64}$/;
export const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const validId = (id) => typeof id === 'string' && ID.test(id) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id);
const MAX_BYTES = 524288;

// Check every ancestor, including ancestors of dataDir; realpath alone would accept links inside the root.
export function checkPath(target, missing = true) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (missing && error.code === 'ENOENT') return; fail(409, 'Dreaming path unavailable'); }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== absolute)) fail(409, 'Unsafe dreaming path');
    const real = fs.realpathSync.native(current);
    const key = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
    if (key(real) !== key(current)) fail(409, 'Unsafe dreaming path');
  }
}

export function createStorage(dataDir, projectId) {
  if (typeof dataDir !== 'string' || !dataDir || !validId(projectId)) fail(400, 'Invalid dreaming scope');
  const root = path.resolve(dataDir), project = path.join(root, 'projects', projectId);
  const directory = path.join(project, 'dreaming'), file = path.join(directory, 'state.json');
  checkPath(directory);
  function readBytes(target, max = MAX_BYTES) {
    checkPath(target, false);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > max || stat.nlink !== 1) fail(409, 'Invalid dreaming artifact');
      const bytes = fs.readFileSync(fd);
      if (bytes.length > max) fail(409, 'Dreaming artifact too large');
      checkPath(target, false);
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  function read(name = 'state.json') {
    const file = path.join(directory, name);
    checkPath(file);
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(file))); }
    catch (error) { if (error.status) throw error; fail(409, 'Invalid dreaming state'); }
  }
  function verify(source, cache) {
    if (!source || typeof source.path !== 'string' || source.path.length > 240 || !HASH.test(source.sha256)) return false;
    const parts = source.path.split('/');
    if (parts.length < 6 || parts[0] !== 'projects' || parts[1] !== projectId || parts[2] !== 'chats' || !validId(parts[3]) || parts.some((p) => !p || p === '.' || p === '..' || /[\\:\x00-\x1f\x7f]/.test(p) || /[. ]$/.test(p))) return false;
    try {
      if (!cache?.has(source.path)) {
        let target = path.join(root, ...parts);
        const team = parts.length === 8 && parts[4] === 'hive' && parts[5] === 'runs' && /^[A-Za-z0-9_-]{1,128}$/.test(parts[6]) && parts[7] === 'events.jsonl';
        if (team) {
          checkPath(target);
          // Only an absent canonical archive permits the matching live journal.
          try { fs.lstatSync(target); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            target = path.join(root, ...parts.slice(0, 5), 'events.jsonl');
          }
        }
        const bytes = readBytes(target, 16777216);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (team) {
          if (!text.endsWith('\n')) return false;
          const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line));
          if (!rows.length || rows.length > 10000 || rows.some((e, i) => e?.v !== 1 || e.runId !== parts[6] || e.seq !== i + 1) || rows[0].type !== 'run_started' || rows.at(-1).type !== 'run_finished') return false;
        }
        const actual = digest(bytes);
        cache?.set(source.path, actual);
        return actual === source.sha256;
      }
      return cache.get(source.path) === source.sha256;
    } catch { return false; }
  }
  function atomic(name, text) {
    const target = path.join(directory, name), temporary = path.join(directory, `.${randomUUID()}.tmp`);
    if (Buffer.byteLength(text) > MAX_BYTES) fail(409, 'Dreaming state limit exceeded');
    checkPath(target);
    if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).nlink !== 1)) fail(409, 'Invalid dreaming artifact');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      checkPath(target); fs.renameSync(temporary, target);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function locked(fn) {
    checkPath(directory); fs.mkdirSync(directory, { recursive: true }); checkPath(directory, false);
    const lock = path.join(directory, '.owner-lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail(409, 'Dreaming is busy'); throw error; }
    const token = randomUUID(), owner = JSON.stringify({ pid: process.pid, token });
    const opened = fs.fstatSync(fd);
    let written = false;
    try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); written = true; return fn(); }
    finally {
      fs.closeSync(fd);
      checkPath(lock, false);
      const current = fs.lstatSync(lock);
      if (current.isFile() && current.nlink === 1 && current.dev === opened.dev && current.ino === opened.ino) {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(readBytes(lock));
        if (content === owner || (!written && owner.startsWith(content))) fs.unlinkSync(lock);
      }
    }
  }
  function remove(name) {
    const target = path.join(directory, name);
    checkPath(target);
    if (!fs.existsSync(target)) return;
    readBytes(target);
    fs.unlinkSync(target);
  }
  function lease() {
    checkPath(directory); fs.mkdirSync(directory, { recursive: true }); checkPath(directory, false);
    const target = path.join(directory, '.reflection-job');
    checkPath(target);
    let fd;
    try { fd = fs.openSync(target, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail(409, 'Reflection job already owned'); throw error; }
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() }), stat = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return () => {
      checkPath(target, false);
      const current = fs.lstatSync(target);
      if (current.dev !== stat.dev || current.ino !== stat.ino || readBytes(target).toString('utf8') !== owner) fail(409, 'Reflection ownership changed');
      fs.unlinkSync(target);
    };
  }
  function isLocked(name = '.owner-lock') {
    const lock = path.join(directory, name);
    checkPath(lock);
    try { fs.lstatSync(lock); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return { read, remove, lease, verify, verification: () => { const cache = new Map(); return (source) => verify(source, cache); }, atomic, locked, isLocked, isReflecting: () => isLocked('.reflection-job') };
}
