import fs from 'node:fs';

export function replaceDuringRead(t, file, phase, reuseIndex) {
  const replacement = file + '.replacement';
  fs.utimesSync(file, 1700000000, 1700000000);
  fs.copyFileSync(file, replacement); fs.utimesSync(replacement, 1700000010, 1700000010);
  const before = fs.lstatSync(file, { bigint: true });
  const open = fs.openSync, read = fs.readSync, lstat = fs.lstatSync, fstat = fs.fstatSync;
  let replaced = false, fd;
  const swap = () => { fs.renameSync(file, file + '.old'); fs.renameSync(replacement, file); replaced = true; };
  // Model a reused file index without relying on the filesystem's allocation policy.
  const identity = (stat) => { if (reuseIndex && replaced) stat.ino = typeof stat.ino === 'bigint' ? before.ino : Number(before.ino); return stat; };
  t.mock.method(fs, 'lstatSync', (name, ...args) => { const stat = lstat(name, ...args); return name === file ? identity(stat) : stat; });
  t.mock.method(fs, 'fstatSync', (opened, ...args) => { const stat = fstat(opened, ...args); return opened === fd ? identity(stat) : stat; });
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === file && !replaced && phase === 'open') swap();
    const opened = open(name, ...args); if (name === file) fd = opened; else if (opened === fd) fd = undefined; return opened;
  });
  t.mock.method(fs, 'readSync', (...args) => { const count = read(...args); if (args[0] === fd && !replaced && phase === 'read') swap(); return count; });
  return () => replaced;
}
