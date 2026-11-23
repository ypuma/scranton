import fs from 'node:fs';
import path from 'node:path';

export function plainDirectory(directory, create = false) {
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  if (parent !== root && !plainDirectory(parent, create)) return false;
  let stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat && create) {
    try { fs.mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(root, { throwIfNoEntry: false });
  }
  return stat?.isDirectory() && !stat.isSymbolicLink();
}

export function artifactIsActive(pid, name, active) {
  if (active.has(name)) return true;
  const owner = Number(pid);
  if (!owner || owner > 0x7fffffff || owner === process.pid) return false;
  // When a PID cannot be checked (or has been reused), err on the side of keeping it.
  try { process.kill(owner, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  return true;
}

export function sweepArtifacts(root, shouldRemove, recursive = false) {
  // An inaccessible or temporarily locked artifact should not block other voice operations.
  const unavailable = error => ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'EROFS'].includes(error.code);
  let names;
  try {
    if (!plainDirectory(root)) return;
    names = fs.readdirSync(root);
  } catch (error) {
    if (unavailable(error)) return;
    throw error;
  }
  for (const name of names) {
    if (!shouldRemove(name)) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() || !(recursive ? stat?.isDirectory() : stat?.isFile())) continue;
      // Recursive rm unlinks nested symlinks/junctions rather than traversing them.
      fs.rmSync(file, { force: true, recursive });
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
  }
}
