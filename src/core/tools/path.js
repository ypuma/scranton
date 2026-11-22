import fs from 'node:fs';
import path from 'node:path';

const fold = (s) => ['win32', 'darwin'].includes(process.platform) ? s.toLowerCase() : s;
const inside = (root, file) => { const rel = path.relative(fold(root), fold(file)); return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

export function resolveToolPath(root, input = '.', { mutation = false } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Tool root must be an absolute directory');
  if (typeof input !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(input) || /^~/.test(input) || /^[\\/]{2}/.test(input) || process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(input)) throw new Error(`Unsafe path: ${JSON.stringify(input)}`);
  const normalized = input.replaceAll('\\', '/');
  if (process.platform !== 'win32' && /^[a-z]:\//i.test(normalized)) throw new Error(`Path escapes tool root: ${input}`);
  const parts = normalized.replace(/^[a-z]:\//i, '').split('/').filter(Boolean);
  if (process.platform === 'win32' && parts.some((part) => part !== '.' && part !== '..' && (/[. ]$/.test(part) || part.includes(':') || /^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)))) throw new Error(`Unsafe path component: ${input}`);
  if (mutation && parts.some((part) => part.toLowerCase() === '.git')) throw new Error('Writing paths containing .git is not allowed');
  const base = path.resolve(root);
  const full = path.resolve(base, normalized);
  if (!inside(base, full)) throw new Error(`Path escapes tool root: ${input}`);
  // Reject reparse points, including ancestors of root. Only the two OS aliases are exempt.
  let current = path.parse(full).root;
  for (const part of path.relative(current, full).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (process.platform === 'darwin' && ['/var', '/tmp'].includes(current) && stat.isSymbolicLink()) {
      const target = `/private${current}`;
      if (path.resolve(path.dirname(current), fs.readlinkSync(current)) !== target || fs.realpathSync.native(current) !== target) throw new Error(`Link/reparse path rejected: ${current}`);
      resolveToolPath(target);
      current = target;
      continue;
    }
    if (stat.isSymbolicLink() || fold(fs.realpathSync.native(current)) !== fold(path.resolve(current))) throw new Error(`Link/reparse path rejected: ${current}`);
  }
  return full;
}

export const relativePath = (base, full) => path.relative(base, full).split(path.sep).join('/');
