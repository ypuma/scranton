import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundled = fileURLToPath(new URL('../../../tools/bin/', import.meta.url));

export function resolveBinaries(env = process.env) {
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  return Object.fromEntries(['rg', 'fd'].flatMap((name) => {
    const filename = name + (process.platform === 'win32' ? '.exe' : '');
    const file = [bundled, ...search.split(path.delimiter).filter(Boolean)].map((dir) => path.join(dir.replace(/^"|"$/g, ''), filename)).find((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    });
    return file ? [[name, file]] : [];
  }));
}
