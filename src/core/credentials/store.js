import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const failure = (code, message) => Object.assign(new Error(message), { code });
export const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const validId = (id) => typeof id === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(id) && !['constructor', 'prototype'].includes(id);
export function credentialsDirectory({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.SCRANTON_CREDENTIALS_DIR) return path.resolve(env.SCRANTON_CREDENTIALS_DIR.replace(/^~(?=$|[\\/])/, home));
  if (process.env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_CONTEXT !== undefined) throw failure('SCRANTON_CREDENTIAL_STORE', 'Credential directory required under node:test; set dir or SCRANTON_CREDENTIALS_DIR in the supplied env');
  const base = platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'dev.scranton.desktop', 'credentials');
}
export function validateKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim() || /^[!$]/.test(value.trim()) || /\s/.test(value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw failure('SCRANTON_CREDENTIAL_INVALID', 'Invalid API key');
  return value.trim();
}
export function validateCredential(value) {
  if (!object(value)) throw failure('SCRANTON_CREDENTIAL_INVALID', 'Invalid credential');
  if (value.type === 'api_key') return { ...value, key: validateKey(value.key) };
  if (value.type !== 'oauth' || !Number.isFinite(value.expires) || Math.abs(value.expires) > 8.64e15 ||
      ![value.access, value.refresh].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 65536 && !/[\s\x00-\x1f\x7f]/.test(v))) throw failure('SCRANTON_CREDENTIAL_INVALID', 'Invalid credential');
  try { return structuredClone(value); } catch { throw failure('SCRANTON_CREDENTIAL_INVALID', 'Invalid credential metadata'); }
}
export function validateProvider(value) {
  if (!object(value) || !validId(value.id) || value.id.length > 32 || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(value.api)) throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid provider declaration');
  let url;
  try { url = new URL(value.baseUrl); } catch { throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid provider URL'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid provider URL');
  const label = value.label ?? value.id;
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\x00-\x1f\x7f]/.test(label) || !Array.isArray(value.models) || !value.models.length || value.models.length > 256) throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid provider metadata');
  const ids = new Set();
  const models = value.models.map((m) => {
    if (!object(m) || typeof m.id !== 'string' || !m.id || m.id.length > 256 || /[\s\x00-\x1f\x7f]/.test(m.id) || ids.has(m.id)) throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid provider model');
    ids.add(m.id);
    const result = { id: m.id };
    for (const field of ['contextWindow', 'maxTokens']) if (m[field] !== undefined) {
      if (!Number.isSafeInteger(m[field]) || m[field] <= 0) throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid model token limit');
      result[field] = m[field];
    }
    if (m.reasoning !== undefined) {
      if (typeof m.reasoning !== 'boolean') throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid model reasoning');
      result.reasoning = m.reasoning;
    }
    if (m.input !== undefined) {
      if (!Array.isArray(m.input) || !m.input.length || m.input.some((v) => !['text', 'image'].includes(v))) throw failure('SCRANTON_PROVIDER_INVALID', 'Invalid model input');
      result.input = [...m.input];
    }
    return result;
  });
  return { id: value.id, label: label.trim(), baseUrl: url.href.replace(/\/+$/, ''), api: value.api, models };
}
function readJson(file, fallback, jsonc = false) {
  try {
    let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (jsonc) text = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m[0] === '"' ? m : '').replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? m);
    const value = JSON.parse(text);
    if (!object(value)) throw Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw failure('SCRANTON_CREDENTIAL_STORE', 'Cannot read credential data; refusing to overwrite');
  }
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error();
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}
async function atomic(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, file); break; }
      catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error; await sleep(20); }
    }
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(tmp, { force: true }); }
}
export function createCredentialStore({ env = process.env, dir = credentialsDirectory({ env }), lockTimeoutMs = 30000 } = {}) {
  dir = path.resolve(dir);
  const file = path.join(dir, 'store.json'), lock = path.join(dir, '.lock');
  const empty = () => ({ version: 1, credentials: {}, providers: {}, renewals: {} });
  function read() {
    try {
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error();
      const data = readJson(file, empty());
      if (data.version !== 1 || !object(data.credentials) || !object(data.providers) || !object(data.renewals)) throw Error();
      return data;
    } catch { throw failure('SCRANTON_CREDENTIAL_STORE', 'Cannot read Scranton credential store'); }
  }
  async function transaction(fn, { signal } = {}) {
    let owner;
    try {
      privateDir(dir);
      const deadline = Date.now() + lockTimeoutMs;
      for (;;) {
        signal?.throwIfAborted();
        try {
          fs.mkdirSync(lock, { mode: 0o700 });
          owner = `${process.pid}-${randomUUID()}`;
          try { fs.writeFileSync(path.join(lock, owner), '', { flag: 'wx', mode: 0o600 }); }
          catch (error) { fs.rmdirSync(lock); owner = undefined; throw error; }
          break;
        } catch (error) {
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
          // A writer may release the lock between our failed mkdir and inspection.
          if (fs.lstatSync(lock, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error();
          // Only remove the exact dead owner's claim. A competing reaper cannot remove a new claim.
          let entries;
          try { entries = fs.readdirSync(lock); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          if (entries.length === 1 && /^[1-9]\d*-[a-f0-9-]{36}$/.test(entries[0])) {
            const pid = Number(entries[0].split('-')[0]);
            let dead = false;
            try { process.kill(pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
            if (dead) {
              try { fs.unlinkSync(path.join(lock, entries[0])); fs.rmdirSync(lock); } catch {}
              continue;
            }
          }
          if (Date.now() >= deadline) throw failure('SCRANTON_CREDENTIAL_LOCKED', 'Credential store is locked; verify no writer is running before removing its .lock directory');
          await sleep(20, undefined, { signal });
        }
      }
      const data = read(), before = JSON.stringify(data);
      const result = await fn(data);
      signal?.throwIfAborted();
      if (JSON.stringify(data) !== before || !fs.existsSync(file)) await atomic(file, data);
      return result;
    } catch (error) {
      if (error.code?.startsWith('SCRANTON_')) throw error;
      throw failure(signal?.aborted ? 'SCRANTON_AUTH_ABORTED' : 'SCRANTON_CREDENTIAL_STORE', signal?.aborted ? 'Credential operation cancelled' : 'Credential operation failed');
    } finally {
      if (owner) { fs.unlinkSync(path.join(lock, owner)); fs.rmdirSync(lock); }
    }
  }
  async function initialize({ env = process.env, home = homedir(), source } = {}) {
    const current = read();
    if (!current.import && !source && !env.PI_CODING_AGENT_DIR && (process.env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_CONTEXT !== undefined)) throw failure('SCRANTON_CREDENTIAL_STORE', 'Pi import source required under node:test; set source in store.initialize() or PI_CODING_AGENT_DIR in the supplied env');
    source = path.resolve((source || env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent')).replace(/^~(?=$|[\\/])/, home));
    try {
      privateDir(dir);
      if (fs.existsSync(file)) {
        if (fs.lstatSync(file).isSymbolicLink()) throw Error();
        if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      }
    } catch { throw failure('SCRANTON_CREDENTIAL_STORE', 'Cannot initialize Scranton credential directory'); }
    if (current.import && current.deviceId) return;
    await transaction((data) => {
      data.deviceId ??= randomUUID();
      if (data.import) return;
      const auth = readJson(path.join(source, 'auth.json'), {}, true);
      const models = readJson(path.join(source, 'models.json'), { providers: {} }, true);
      if (!object(models.providers)) throw failure('SCRANTON_CREDENTIAL_STORE', 'Invalid legacy provider data');
      const imported = { credentials: [], providers: [] }, skipped = [];
      for (const [id, value] of Object.entries(auth)) {
        if (!validId(id) || Object.hasOwn(data.credentials, id)) continue;
        try { data.credentials[id] = validateCredential(value); imported.credentials.push(id); }
        catch { data.credentials[id] = null; skipped.push(id); }
      }
      for (const [id, value] of Object.entries(models.providers)) {
        if (!validId(id) || Object.hasOwn(data.providers, id)) continue;
        try {
          data.providers[id] = validateProvider({ ...value, id, label: value.name ?? id }); imported.providers.push(id);
          if (!Object.hasOwn(data.credentials, id) && value.apiKey !== undefined) {
            const key = typeof value.apiKey === 'string' && value.apiKey.startsWith('$') ? env[value.apiKey.slice(1)] : value.apiKey;
            data.credentials[id] = { type: 'api_key', key: validateKey(key) }; imported.credentials.push(id);
          }
        } catch { skipped.push(id); }
      }
      data.import = { at: new Date().toISOString(), source, imported, skipped: [...new Set(skipped)] };
    });
  }
  return { dir, file, read, transaction, initialize,
    get: (id) => read().credentials[id],
    set: (id, value) => { if (!validId(id)) throw failure('SCRANTON_CREDENTIAL_INVALID', 'Invalid provider ID'); const credential = validateCredential(value); return transaction((d) => { d.credentials[id] = credential; delete d.renewals[id]; }); },
    delete: (id) => transaction((d) => { delete d.credentials[id]; delete d.renewals[id]; }) };
}
