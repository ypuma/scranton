import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safePath, withWorkspaceLock } from './worktree.js';
import { acquireRunLease, readRunLease, runOwnerStatus, releaseRunLease, startRunHeartbeat, cliRecoveryStatus } from './run-lease.js';
import { sameFileIdentity } from './context/file-identity.js';

export const MAX_PREIMAGE_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const validId = (value) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error('Invalid restore point identifier'); return value; };
const stamp = (value) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const fingerprint = (entry) => entry ? { sha256: hash(entry.data), size: entry.data.length, mode: entry.mode } : null;
const equal = (a, b) => a === null && b === null || Boolean(a && b && a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode);
const descriptor = (value) => value === null || value && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0 && ['100644', '100755'].includes(value.mode);
const contains = (root, file) => { const rel = path.relative(root, file); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const pointDir = (hive, runId) => safePath(hive, 'restore-points/' + validId(runId));
const openFile = (e) => e.restorable && !e.undoneAt && !e.undoUnrestorable;
const settled = (point) => Boolean(point.undoneAt) || !point.files.some(openFile);

// Listing must validate names even when the workspace no longer exists.
function target(workspace, hive, name, inspect = true, reading = false) {
  const file = safePath(workspace, name, !inspect ? { fs: { lstatSync() { throw Object.assign(Error(), { code: 'ENOENT' }); } } } : reading ? { fs: { ...fs, lstatSync(...args) {
    try { return fs.lstatSync(...args); } catch (error) { if (error.code === 'ENOTDIR') error.code = 'ENOENT'; throw error; }
  } } } : {});
  if (!name || name.split('/').some((part) => part.toLowerCase() === '.git') || contains(hive, file) || contains(file, hive)) throw Error('Unsafe restore target');
  if (inspect) for (let parent = path.dirname(file); parent !== workspace; parent = path.dirname(parent)) {
    try { const stat = fs.lstatSync(parent); if (!stat.isDirectory() && !(reading && stat.isFile())) throw Error('Unsafe restore parent: not a directory'); }
    catch (error) { if (error.code !== 'ENOENT' && !(reading && error.code === 'ENOTDIR')) throw error; }
  }
  return file;
}

function regular(root, name, max, consume) {
  const file = safePath(root, name), before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile()) throw Error('Restore path is not a regular file');
  if (before.nlink !== 1n) throw Error('Restore file has hardlinks');
  if (before.size > BigInt(max)) throw Error('Restore artifact exceeds size limit');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(stat, before)) throw Error('Restore artifact changed');
    const result = consume(fd, Number(stat.size), stat);
    safePath(root, name);
    if (!sameFileIdentity(stat, fs.fstatSync(fd, { bigint: true })) || !sameFileIdentity(stat, fs.lstatSync(file, { bigint: true }))) throw Error('Restore artifact changed');
    return result;
  } finally { fs.closeSync(fd); }
}
const bytes = (root, name, max) => regular(root, name, max, (fd, size) => {
  const data = Buffer.alloc(size); let offset = 0, n;
  while (offset < size && (n = fs.readSync(fd, data, offset, size - offset, null))) offset += n;
  if (offset !== size) throw Error('Restore artifact changed');
  return data;
});
function atomicTarget(root, name) {
  const file = safePath(root, name);
  try { const s = fs.lstatSync(file); if (!s.isFile()) throw Error('Restore path is not a regular file'); if (s.nlink !== 1) throw Error('Restore file has hardlinks'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
function atomic(root, name, data, mode = 0o600) {
  const verify = () => atomicTarget(root, name);
  const file = verify(), directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); verify();
  const temp = path.join(directory, '.scranton-' + randomUUID() + '.tmp'); let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
    fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    verify(); fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(safePath(root, path.relative(root, temp).split(path.sep).join('/')), { force: true }); }
}
const yieldTurn = () => new Promise(setImmediate);
// Undo uses the same lexical rules as safePath, but never waits for metadata on the event loop.
const io = (method, ...args) => new Promise((resolve, reject) => (method === 'realpath' ? fs.realpath.native : fs[method])(...args, (error, value) => error ? reject(error) : resolve(value)));
async function pathUndo(root, name = '', reading = false) {
  const file = safePath(root, name, { fs: { lstatSync() { throw Object.assign(Error(), { code: 'ENOENT' }); } } });
  let current = path.parse(root).root;
  for (const component of path.relative(current, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await io('lstat', current); }
    catch (error) { if (error.code === 'ENOENT' || reading && error.code === 'ENOTDIR') continue; throw error; }
    if (process.platform === 'darwin' && (current === '/var' || current === '/tmp') && stat.isSymbolicLink()) {
      const canonical = '/private' + current;
      if (path.resolve(path.dirname(current), await io('readlink', current)) !== canonical || await io('realpath', current) !== canonical) throw Error('Link/reparse path rejected: ' + current);
      current = await pathUndo(canonical); continue;
    }
    if (stat.isSymbolicLink() || (await io('realpath', current)).toLowerCase() !== path.resolve(current).toLowerCase()) throw Error('Link/reparse path rejected: ' + current);
  }
  await yieldTurn();
  return file;
}
const pointDirUndo = async (hive, runId) => pathUndo(hive, 'restore-points/' + validId(runId));
async function targetUndo(workspace, hive, name, reading = false) {
  target(workspace, hive, name, false);
  const file = await pathUndo(workspace, name, reading);
  for (let parent = path.dirname(file); parent !== workspace; parent = path.dirname(parent)) {
    try { const stat = await io('lstat', parent); if (!stat.isDirectory() && !(reading && stat.isFile())) throw Error('Unsafe restore parent: not a directory'); }
    catch (error) { if (error.code !== 'ENOENT' && !(reading && error.code === 'ENOTDIR')) throw error; }
  }
  return file;
}
async function regularUndo(root, name, max, consume) {
  const file = await pathUndo(root, name), before = await io('lstat', file, { bigint: true });
  if (!before.isFile()) throw Error('Restore path is not a regular file');
  if (before.nlink !== 1n) throw Error('Restore file has hardlinks');
  if (before.size > BigInt(max)) throw Error('Restore artifact exceeds size limit');
  const fd = await io('open', file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await io('fstat', fd, { bigint: true });
    if (!sameFileIdentity(stat, before)) throw Error('Restore artifact changed');
    const result = await consume(fd, Number(stat.size), stat);
    await pathUndo(root, name);
    if (!sameFileIdentity(stat, await io('fstat', fd, { bigint: true })) || !sameFileIdentity(stat, await io('lstat', file, { bigint: true }))) throw Error('Restore artifact changed');
    return result;
  // Do not yield between the final identity check and the caller's rename/unlink.
  } finally { fs.closeSync(fd); }
}
const bytesUndo = (root, name, max) => regularUndo(root, name, max, async (fd, size) => {
  const data = Buffer.alloc(size); let offset = 0, n;
  while (offset < size && (n = await io('read', fd, data, offset, Math.min(size - offset, 64 * 1024), null))) { offset += n; await yieldTurn(); }
  if (offset !== size) throw Error('Restore artifact changed');
  return data;
});
async function currentUndo(workspace, hive, name) {
  await targetUndo(workspace, hive, name, true);
  try {
    return await regularUndo(workspace, name, Number.MAX_SAFE_INTEGER, async (fd, size, stat) => {
      const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let total = 0, n;
      while ((n = await io('read', fd, chunk, 0, chunk.length, null))) { total += n; digest.update(chunk.subarray(0, n)); await yieldTurn(); }
      if (total !== size) throw Error('Restore target changed');
      return { sha256: digest.digest('hex'), size, mode: Number(stat.mode) & 0o111 ? '100755' : '100644' };
    });
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
async function atomicTargetUndo(root, name) {
  const file = await pathUndo(root, name);
  try { const stat = await io('lstat', file); if (!stat.isFile()) throw Error('Restore path is not a regular file'); if (stat.nlink !== 1) throw Error('Restore file has hardlinks'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
async function atomicUndo(root, name, data, mode = 0o600, beforeRename = () => {}) {
  const file = await atomicTargetUndo(root, name), directory = path.dirname(file);
  await yieldTurn();
  await io('mkdir', directory, { recursive: true, mode: 0o700 }); await atomicTargetUndo(root, name);
  const temp = path.join(directory, '.scranton-' + randomUUID() + '.tmp'); let fd;
  try {
    fd = await io('open', temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
    await new Promise((resolve, reject) => fs.writeFile(fd, data, (error) => error ? reject(error) : resolve()));
    // Keep both journal barriers durable without blocking heartbeats on a disk flush.
    await new Promise((resolve, reject) => fs.fsync(fd, (error) => error ? reject(error) : resolve()));
    await io('close', fd); fd = undefined;
    await atomicTargetUndo(root, name); await beforeRename(); fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) await io('close', fd);
    await yieldTurn();
    await io('rm', await pathUndo(root, path.relative(root, temp).split(path.sep).join('/')), { force: true });
  }
  await yieldTurn();
}
async function saveUndo(hive, point) {
  const data = JSON.stringify(point) + '\n';
  if (Buffer.byteLength(data) > MAX_MANIFEST_BYTES) throw Error('Restore manifest limit exceeded');
  await atomicUndo(await pointDirUndo(hive, point.runId), 'manifest.json', data);
}
function save(hive, point) {
  const data = JSON.stringify(point) + '\n';
  if (Buffer.byteLength(data) > MAX_MANIFEST_BYTES) throw Error('Restore manifest limit exceeded');
  atomic(pointDir(hive, point.runId), 'manifest.json', data);
}
function* loadSteps(hive, runId, loaded) {
  let point;
  try { point = JSON.parse((loaded ?? bytes(pointDir(hive, runId), 'manifest.json', MAX_MANIFEST_BYTES)).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw Error('Cannot read restore manifest'); }
  if (point?.v !== 1 || point.runId !== runId || typeof point.workspace !== 'string' || !path.isAbsolute(point.workspace) ||
      !stamp(point.createdAt) || point.createdAt === null || !stamp(point.undoneAt) || !Array.isArray(point.files) || !Array.isArray(point.createdDirs)) throw Error('Invalid restore manifest');
  const paths = new Set();
  for (const e of point.files) {
    if (typeof e?.path !== 'string') throw Error('Invalid restore manifest');
    target(point.workspace, hive, e.path, false);
    if (paths.has(e.path) || !descriptor(e.original) || !descriptor(e.lastWritten) || typeof e.restorable !== 'boolean' || !stamp(e.undoneAt) ||
        e.pending !== undefined && !descriptor(e.pending) || e.undoPending !== undefined && typeof e.undoPending !== 'boolean' ||
        e.undoUnrestorable !== undefined && (typeof e.undoUnrestorable !== 'string' || !e.undoUnrestorable || e.undoUnrestorable.length > 256) ||
        !Number.isInteger(e.permissions) || e.permissions < 0 || e.permissions > 0o777 ||
        (e.original && e.restorable ? e.original.size > MAX_PREIMAGE_BYTES || e.preimage !== 'preimages/' + e.original.sha256 : e.preimage !== null) ||
        (!e.restorable && (typeof e.reason !== 'string' || e.reason !== `Pre-image exceeds ${MAX_PREIMAGE_BYTES} bytes` || !e.original || e.original.size <= MAX_PREIMAGE_BYTES))) throw Error('Invalid restore manifest');
    paths.add(e.path);
    yield;
  }
  for (const name of point.createdDirs) { if (typeof name !== 'string') throw Error('Invalid restore manifest'); target(point.workspace, hive, name, false); yield; }
  return point;
}
function load(hive, runId) {
  const steps = loadSteps(hive, runId); let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}
async function loadUndo(hive, runId) {
  let data;
  try { data = await bytesUndo(await pointDirUndo(hive, runId), 'manifest.json', MAX_MANIFEST_BYTES); }
  catch (error) { if (error.code === 'ENOENT') return null; throw Error('Cannot read restore manifest'); }
  const steps = loadSteps(hive, runId, data); let step;
  do { step = steps.next(); if (!step.done) await yieldTurn(); } while (!step.done);
  return step.value;
}
async function allPointsUndo(hive) {
  const root = await pathUndo(hive, 'restore-points');
  let names;
  try { names = await io('readdir', root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const points = [];
  for (const runId of names.filter((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name))) {
    try { const point = await loadUndo(hive, runId); if (point) { points.push(point); continue; } } catch {}
    points.push({ runId, unreadable: true, createdAt: null, workspace: null, files: null, undoneAt: null, remaining: null });
    await yieldTurn();
  }
  return sortPoints(points);
}
const sortPoints = (points) => points.sort((a, b) => Number(Boolean(a.unreadable)) - Number(Boolean(b.unreadable)) || (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.runId.localeCompare(a.runId));
function allPoints(hive) {
  const root = safePath(hive, 'restore-points');
  let names;
  try { names = fs.readdirSync(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return sortPoints(names.filter((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name)).map((runId) => {
    try { const point = load(hive, runId); if (point) return point; } catch {}
    return { runId, unreadable: true, createdAt: null, workspace: null, files: null, undoneAt: null, remaining: null };
  }));
}

export function listRestorePoints(hiveDir) {
  return allPoints(path.resolve(hiveDir)).map((point) => {
    if (point.unreadable) return point;
    const { runId, createdAt, workspace, files, undoneAt } = point;
    return { runId, createdAt, workspace, files: files.length, undoneAt, remaining: files.filter(openFile).length,
      undone: files.filter((e) => e.undoneAt).length, unrestorable: files.filter((e) => !e.restorable || e.undoUnrestorable).length };
  });
}

// Persist both sides before workspace writes; pending also makes an interrupted integration undoable.
export function prepareRestorePoint({ hiveDir, runId, workspace, changes, before, initial, after }) {
  if (!changes.length) return { notRestorable: [], commit() {}, rollback() {} };
  const hive = path.resolve(hiveDir), dir = pointDir(hive, runId);
  workspace = path.resolve(workspace); safePath(workspace);
  let point = load(hive, runId);
  if (point && (point.workspace !== workspace || point.undoneAt || point.files.some((e) => e.undoneAt || e.pending !== undefined))) throw Error('Restore point is not writable');
  const previous = point ? structuredClone(point) : null;
  point ??= { v: 1, runId, createdAt: new Date().toISOString(), workspace, files: [], createdDirs: [], undoneAt: null };
  for (const name of changes) {
    const file = target(workspace, hive, name, true, true);
    let e = point.files.find((e) => e.path === name);
    if (!e) {
      const original = initial.get(name), restorable = !original || original.data.length <= MAX_PREIMAGE_BYTES;
      const originalHash = fingerprint(original);
      const preimage = original && restorable ? 'preimages/' + originalHash.sha256 : null;
      if (preimage) atomic(dir, preimage, original.data);
      e = { path: name, original: originalHash, permissions: original?.permissions ?? (original?.mode === '100755' ? 0o755 : 0o644), preimage, restorable,
        reason: restorable ? null : `Pre-image exceeds ${MAX_PREIMAGE_BYTES} bytes`, lastWritten: fingerprint(before.get(name)), undoneAt: null };
      point.files.push(e);
    }
    e.pending = fingerprint(after.get(name));
    for (let parent = path.dirname(file); parent !== workspace; parent = path.dirname(parent)) {
      const relative = path.relative(workspace, parent).split(path.sep).join('/');
      if (fs.existsSync(parent) && !(before.get(relative) && !after.get(relative))) break;
      if (!point.createdDirs.includes(relative)) point.createdDirs.push(relative);
    }
  }
  point.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  save(hive, point);
  return {
    notRestorable: point.files.filter((e) => changes.includes(e.path) && !e.restorable).map(({ path, reason }) => ({ path, reason })),
    commit() {
      for (const e of point.files) if (e.pending !== undefined) { e.lastWritten = e.pending; delete e.pending; }
      save(hive, point);
      // A rolled-back integration must not evict committed backups.
      try {
        if (!previous) for (const old of allPoints(hive).filter((p) => !p.unreadable && p.runId !== runId).slice(9)) {
          try { removePoint(hive, old.runId); } catch { /* Leave unreadable artifacts alone. */ }
        }
      } catch { /* Pruning must not roll back a committed integration. */ }
    },
    rollback() {
      if (previous) save(hive, previous);
      else removePoint(hive, runId);
    }
  };
}

function removePoint(hive, runId) {
  const dir = pointDir(hive, runId);
  const check = (root) => { for (const e of fs.readdirSync(root, { withFileTypes: true })) { const full = safePath(root, e.name); if (e.isDirectory()) check(full); else if (!e.isFile() || fs.lstatSync(full).nlink !== 1) throw Error('Invalid restore artifact'); } };
  check(dir); fs.rmSync(dir, { recursive: true });
}

function blockedReason(error) {
  const safe = ['Restore path is not a regular file', 'Restore file has hardlinks', 'Restore artifact exceeds size limit', 'Restore artifact changed', 'Unsafe restore target', 'Unsafe restore parent: not a directory', 'Restore manifest limit exceeded'];
  const cause = safe.includes(error.message) ? error.message : error.message?.startsWith('Link/reparse path rejected:') ? 'Link/reparse path rejected' : /^(Unsafe path:|Path escapes workspace:)/.test(error.message) ? 'Unsafe restore path' : null;
  const code = /^[A-Z][A-Z0-9_]{1,30}$/.test(error.code) ? error.code : null;
  return `Could not restore the file${code ? ` (${code})` : cause ? `: ${cause}` : ''}; check the path and permissions, close programs using it and undo again`;
}

const refusal = (message) => Object.assign(Error(message), { status: 409 });
function owned(hive) {
  const lease = readRunLease(hive);
  return refusal(runOwnerStatus(hive, lease) === 'alive' ? lease?.mode === 'undo' ? 'An undo is already running in this chat.' : 'A run is active in this chat; stop it before undo.' : 'This chat needs recovery before undo.');
}

export async function undoRun({ hiveDir, runId, force = false, siblings = [] }) {
  if (typeof force !== 'boolean') throw Error('Invalid force option');
  const hive = path.resolve(hiveDir);
  if (runId !== undefined) validId(runId);
  if (!Array.isArray(siblings) || siblings.some((p) => typeof p !== 'string')) throw Error('Invalid siblings option');
  let lease, stopHeartbeat;
  try {
    try { lease = acquireRunLease(hive, { runId: 'undo-' + randomUUID(), mode: 'undo', startedAt: new Date().toISOString() }); }
    catch (error) { if (error.code === 'EEXIST') throw owned(hive); throw error; }
    stopHeartbeat = startRunHeartbeat(hive, lease.token);
    const checkSiblings = () => {
      if (siblings.some((other) => path.resolve(other) !== hive && readRunLease(other) && !cliRecoveryStatus(other).automatic)) throw refusal('A run is active in another chat of this project; stop or recover it before undo.');
    };
    checkSiblings();
    const entries = await allPointsUndo(hive), points = entries.filter((p) => !p.unreadable);
    const selected = runId === undefined ? (points.find((p) => !settled(p)) ?? points.find((p) => !p.undoneAt)) : points.find((p) => p.runId === runId);
    if (!selected) {
      if (runId !== undefined && entries.some((p) => p.runId === runId && p.unreadable)) throw refusal(`Restore point ${runId} is unreadable.`);
      throw Error('No restore point available');
    }
    const newer = points.slice(0, points.indexOf(selected)).filter((p) => !settled(p)).map((p) => p.runId);
    if (newer.length) throw refusal(`Newer runs must be undone first: ${newer.join(', ')}. A run stays open while files changed after it are kept; undo it with --force or leave both.`);
    let unreadable;
    if (force) for (const p of entries.filter((p) => p.unreadable)) {
      if ((await io('lstat', await pointDirUndo(hive, p.runId))).mtimeMs > Date.parse(selected.createdAt)) { unreadable = p; break; }
    }
    if (unreadable) throw refusal(`Cannot force undo while newer restore point ${unreadable.runId} is unreadable.`);
    return await withWorkspaceLock(selected.workspace, async () => {
      checkSiblings();
      if (readRunLease(hive)?.token !== lease.token) throw refusal('This chat needs recovery before undo.');
      const point = await loadUndo(hive, selected.runId);
      if (!point || point.workspace !== selected.workspace) throw Error('Restore point changed');
      const result = { runId: point.runId, restored: [], removed: [], conflicts: [], warnings: [] };
      if (settled(point)) {
        if (!point.undoneAt) { point.undoneAt = new Date().toISOString(); await saveUndo(hive, point); }
        result.conflicts = point.files.filter((e) => e.undoUnrestorable || !e.restorable).map((e) => ({ path: e.path, reason: e.undoUnrestorable ?? e.reason, code: 'unrestorable' }));
        return result;
      }
      // Vacate created paths and directories before putting original files back.
      for (const restoring of [false, true]) {
        for (const e of point.files.filter((e) => Boolean(e.original) === restoring)) {
          try {
            if (e.undoneAt) continue;
            if (!e.restorable || e.undoUnrestorable) {
              e.undoUnrestorable ??= e.reason;
              result.conflicts.push({ path: e.path, reason: e.undoUnrestorable, code: 'unrestorable' }); continue;
            }
            try {
              let data;
              if (e.original) {
                try { data = await bytesUndo(await pointDirUndo(hive, point.runId), e.preimage, MAX_PREIMAGE_BYTES); }
                catch (error) {
                  if (['ENOENT', 'ENOTDIR'].includes(error.code) || error.message?.startsWith('Link/reparse path rejected:') || ['Restore path is not a regular file', 'Restore file has hardlinks', 'Restore artifact exceeds size limit'].includes(error.message)) throw Error('Invalid pre-image');
                  throw error;
                }
                if (data.length !== e.original.size || hash(data) !== e.original.sha256) throw Error('Invalid pre-image');
              }
              const actual = await currentUndo(point.workspace, hive, e.path);
              if (!force && !equal(actual, e.lastWritten) && !(e.pending !== undefined && equal(actual, e.pending)) && !(e.undoPending && equal(actual, e.original))) {
                result.conflicts.push({ path: e.path, reason: 'File no longer matches what the run wrote', code: 'changed' }); continue;
              }
              e.undoPending = true; await saveUndo(hive, point);
              const file = await targetUndo(point.workspace, hive, e.path);
              if (!equal(await currentUndo(point.workspace, hive, e.path), actual)) throw Error('Restore target changed');
              if (!equal(actual, e.original)) {
                if (e.original) { await atomicUndo(point.workspace, e.path, data, e.permissions, async () => {
                  if (!equal(await currentUndo(point.workspace, hive, e.path), actual)) throw Error('Restore target changed');
                }); result.restored.push(e.path); }
                else if (actual) { fs.unlinkSync(file); result.removed.push(e.path); }
              }
              e.undoneAt = new Date().toISOString(); delete e.undoPending; await saveUndo(hive, point);
            } catch (error) {
              const code = error.message === 'Invalid pre-image' ? 'unrestorable' : error.message === 'Restore target changed' ? 'changed' : 'blocked';
              const reason = code === 'blocked' ? error.message === 'Restore path is not a regular file' && result.conflicts.some((c) => c.code === 'changed' && c.path.startsWith(e.path + '/')) ? 'Could not restore the file; resolve the changed conflict below this directory first' : blockedReason(error) : error.message;
              if (e.undoneAt) { e.undoneAt = null; e.undoPending = true; }
              if (code === 'unrestorable') e.undoUnrestorable = reason;
              result.conflicts.push({ path: e.path, reason, code });
            }
          } finally { await new Promise(setImmediate); }
        }
        if (restoring) break;
        for (const name of [...point.createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
          try {
            if (point.files.some((e) => openFile(e) && e.path.startsWith(name + '/'))) continue;
            try { fs.rmdirSync(await targetUndo(point.workspace, hive, name)); }
            catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) result.warnings.push(`Cannot safely remove directory: ${name} (${error.code ?? 'unsafe path'}).`); }
          } finally { await new Promise(setImmediate); }
        }
      }
      if (!point.undoneAt && settled(point)) point.undoneAt = new Date().toISOString();
      await saveUndo(hive, point);
      return result;
    });
  } finally {
    stopHeartbeat?.();
    if (lease) releaseRunLease(hive, lease.token);
  }
}

export async function workspaceState(workspace) {
  const unknown = { git: false, dirty: null, untracked: null };
  try {
    for (let dir = path.resolve(workspace);;) {
      try { const stat = fs.lstatSync(path.join(dir, '.git')); if (stat.isDirectory() || stat.isFile()) return { ...unknown, git: true }; }
      catch (error) { if (error.code !== 'ENOENT') return unknown; }
      const parent = path.dirname(dir);
      if (parent === dir) return unknown;
      dir = parent;
    }
  } catch { return unknown; }
}
