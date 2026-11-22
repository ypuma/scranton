import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const encode = serialize;
export const decode = deserialize;
export const terminal = status => status && status !== 'PENDING' && status !== 'ENQUEUED';
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const interrupted = Object.freeze({ status: 'interrupted' });
export function redact(value) {
  return String(value).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, url => {
    // Avoid URL parsing: diagnostics can contain invalid, raw slashes in userinfo.
    const query = url.indexOf('?');
    const at = url.lastIndexOf('@', query < 0 ? url.length : query);
    if (at >= 0) url = `postgresql://***@${url.slice(at + 1)}`;
    url = url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator, key) => {
      let decoded;
      try { decoded = decodeURIComponent(key.replace(/\+/g, ' ')); }
      catch { return `${separator}${key}=***`; }
      return /user|pass|pwd|secret|token|key|credential|auth|cert/i.test(decoded)
        ? `${separator}${key}=***` : match;
    });
    return url.replace(/^postgres(?:ql)?:\/\/[^\s/]+/i, match => {
      const at = match.lastIndexOf('@');
      return at < 0 ? 'postgresql://***' : `postgresql://***@${match.slice(at + 1)}`;
    });
  });
}
export function errorData(error) {
  return { name: error?.name || 'Error', message: redact(error?.message || error) };
}
export function revive(error) {
  return Object.assign(new Error(error.message), { name: error.name });
}
export function retryOptions(retries = {}) {
  const result = { maxAttempts: 1, intervalSeconds: 1, backoffRate: 2, ...retries };
  if (!Number.isInteger(result.maxAttempts) || result.maxAttempts < 1 ||
      !Number.isFinite(result.intervalSeconds) || result.intervalSeconds < 0 ||
      !Number.isFinite(result.backoffRate) || result.backoffRate < 1) throw new Error('Invalid step retry options');
  return result;
}
export function timeoutMS(options = {}) {
  const seconds = options.timeoutSeconds ?? 60;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid timeoutSeconds');
  return seconds * 1000;
}
export function offsetValue(options = {}) {
  const offset = options.fromOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid fromOffset');
  return offset;
}

export function retentionOptions({ olderThanMs, keepLastWorkflows = 0 } = {}) {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0 ||
      !Number.isSafeInteger(keepLastWorkflows) || keepLastWorkflows < 0) throw new Error('Invalid retention options');
  return { cutoff: Date.now() - olderThanMs, keepLastWorkflows };
}

const workflowPrefix = id => `${createHash('sha256').update(id).digest('hex')}-`;
const stepKey = (id, position) => createHash('sha256').update(JSON.stringify([id, position])).digest('hex');
export function removeStepMarker(directory, id, position) {
  if (!directory) return;
  const key = stepKey(id, position);
  for (const file of [key, `${workflowPrefix(id)}${key}`]) {
    rmSync(join(directory, file), { force: true });
    rmSync(join(directory, `${file}.done`), { force: true });
  }
}
export function removeWorkflowMarkers(directory, id, positions = []) {
  if (!directory || !existsSync(directory)) return;
  for (const position of positions) removeStepMarker(directory, id, position);
  for (const file of readdirSync(directory)) if (file.startsWith(workflowPrefix(id))) rmSync(join(directory, file), { force: true });
}

// A completed marker bridges the gap between body completion and the backend checkpoint.
export async function guardedStep(directory, workflowId, position, name, body) {
  if (!directory) throw new Error('atMostOnce requires markerDir');
  mkdirSync(directory, { recursive: true });
  const key = stepKey(workflowId, position);
  const legacy = join(directory, key);
  const path = existsSync(legacy) ? legacy : join(directory, `${workflowPrefix(workflowId)}${key}`);
  let fd;
  try { fd = openSync(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const bytes = readFileSync(path);
    if (!bytes.length) return interrupted;
    let saved;
    try { saved = decode(bytes); } catch { return interrupted; }
    if (saved.name !== name) throw new Error(`Non-determinism at step ${position}: ${saved.name} != ${name}`);
    if (saved.error) throw revive(saved.error);
    return saved.value;
  }
  try {
    writeFileSync(fd, encode({ name, value: interrupted }));
    fsyncSync(fd);
    let saved;
    try { saved = { name, value: await body() }; }
    catch (error) { saved = { name, error: errorData(error) }; }
    // Keep the original marker intact if the process dies during the replacement.
    const bytes = encode(saved);
    const { renameSync } = await import('node:fs');
    writeFileSync(`${path}.done`, bytes);
    const done = openSync(`${path}.done`, 'r+');
    try { fsyncSync(done); } finally { closeSync(done); }
    closeSync(fd); fd = undefined;
    renameSync(`${path}.done`, path);
    if (saved.error) throw revive(saved.error);
    return saved.value;
  } finally { if (fd !== undefined) closeSync(fd); }
}
