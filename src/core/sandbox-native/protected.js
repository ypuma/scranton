import fs from 'node:fs/promises';
import path from 'node:path';
import { credential } from '../worktree.js';

const names = new Set(['.ssh', '.aws', '.azure', '.config', '.pi', '.git-credentials', '.netrc', '.npmrc']);
const credentialName = name => names.has(name.toLowerCase()) || credential(name);
export const hasCredentialName = file => file.split(path.sep).some(credentialName);

// Only inspect directory entries, never read credentials or descend through links.
export async function credentialEntries(root, skip = () => false) {
  const pending = [root], masks = [];
  let budget = 50000, maskBytes = 0;
  while (pending.length) {
    const dir = pending.pop();
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw Error('Unsafe shell grant path');
    if (!stat.isDirectory() || skip(dir)) continue;
    const entries = await fs.opendir(dir);
    for await (const entry of entries) {
      if (--budget < 0) throw Error('Too many entries to verify credential exclusions');
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      if (credentialName(entry.name)) {
        // Keep generated Seatbelt profiles and bwrap argv bounded as well as the walk.
        maskBytes += Buffer.byteLength(JSON.stringify(target)) + 64;
        if (maskBytes > 32768) throw Error('Too many credential exclusions for shell policy');
        masks.push({ path: target, directory: entry.isDirectory() });
      } else if (entry.isDirectory()) pending.push(target);
    }
  }
  return masks;
}
