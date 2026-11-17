import fs from 'node:fs';
import path from 'node:path';

export function canonicalDirectory(directory) {
  try { return fs.realpathSync.native(directory); }
  catch (error) {
    const parent = path.dirname(directory);
    if (error.code !== 'ENOENT' || parent === directory) throw error;
    return path.join(canonicalDirectory(parent), path.basename(directory));
  }
}

// Ancestors above the boundary may be links; the boundary and its descendants may not.
export function checkScopedPath(base, target, missing = true) {
  const root = path.resolve(base), absolute = path.resolve(target), relative = path.relative(root, absolute);
  const fail = () => { throw Object.assign(Error('Unsafe context path'), { status: 409 }); };
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail();
  let current = root;
  const key = (s) => process.platform === 'win32' ? s.toLowerCase() : s;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== absolute) || key(fs.realpathSync.native(current)) !== key(current)) fail();
  }
}
