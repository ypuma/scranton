import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function canonicalHive(hiveDir) {
  const absolute = path.resolve(hiveDir);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalHive(parent), path.basename(absolute));
  }
}

export function agentHiveScopePrefix(hiveDir) {
  let canonical = canonicalHive(hiveDir);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `scr:single/hive-${hash}/`;
}
