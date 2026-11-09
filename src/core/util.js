import fs from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function clip(text, max) {
  const s = oneLine(text);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}

/** Last `n` non-empty lines of a text. */
export function tailLines(text, n = 8) {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
}

/** First `maxLines` lines, cut at `maxChars`, with a marker when shortened. */
export function excerpt(text, maxLines = 20, maxChars = 1500) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  let out = lines.slice(0, maxLines).join('\n');
  let cut = lines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    cut = true;
  }
  return cut ? `${out}\n[...]` : out;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Run a sync fs operation, retrying briefly on Windows lock errors (readers may hold the file). */
export function withFsRetry(fn, attempts = 12, delayMs = 15) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts || !RETRYABLE.has(err?.code)) throw err;
      sleepSync(delayMs);
    }
  }
}

export function writeFileAtomicSync(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data);
  try {
    withFsRetry(() => fs.renameSync(tmp, file));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
