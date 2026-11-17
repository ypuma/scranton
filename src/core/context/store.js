import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateId } from '../projects.js';
import { canonicalDirectory, checkScopedPath } from './paths.js';
import { DEFAULT_BUDGET, LIMITS } from './limits.js';
import { tokens } from './tokens.js';
import { sameFileIdentity } from './file-identity.js';

const fail = (message) => { throw Object.assign(Error(message), { status: 400 }); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, keys) => object(value) && Reflect.ownKeys(value).every((key) => keys.includes(key));
const rule = (value) => closed(value, ['mode', 'value']) && Object.keys(value).length === 2 && Number.isInteger(value.value) &&
  (value.mode === 'percent' ? value.value >= LIMITS.percentMin && value.value <= LIMITS.percentMax : value.mode === 'tokens' && value.value >= LIMITS.tokensMin && value.value <= LIMITS.tokensMax);
const modelKey = (key) => key.isWellFormed() && key.length >= 1 && key.length <= 513 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const models = (value, patch = false) => object(value) && Reflect.ownKeys(value).every((key) => typeof key === 'string' && modelKey(key) && (patch && value[key] === null || rule(value[key]))) && (patch || Object.keys(value).length <= LIMITS.overrides);
const defaults = () => ({ crossChat: true, budget: { ...DEFAULT_BUDGET }, models: {} });
export function normalizeNotes(value) {
  if (typeof value !== 'string') fail('Expected notes text');
  const text = value.toWellFormed().replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  if (text.length > LIMITS.notes || Buffer.byteLength(text) > LIMITS.notesBytes) fail('Context notes limit exceeded');
  return text.trim() ? text : '';
}
export function createContextStore(dataDir, projectId, chatId) {
  validateId(projectId); if (chatId !== undefined) validateId(chatId);
  let root, rootError;
  try { root = canonicalDirectory(path.resolve(dataDir)); }
  catch (error) { rootError = Object.assign(Error(`Cannot resolve context data directory (${error.code ?? 'unknown error'})`), { status: 409 }); }
  const checkPath = (target, missing) => { if (rootError) throw rootError; checkScopedPath(root, target, missing); };
  const project = root ? path.join(root, 'projects', projectId) : '', directory = root ? path.join(project, ...(chatId === undefined ? [] : ['chats', chatId]), 'context') : '';
  let degraded = Boolean(rootError);
  const invalid = () => { degraded = true; return null; };
  function read(name, max) {
    if (rootError) return invalid();
    const file = path.join(directory, name); let fd;
    try {
      checkPath(file, false);
      const before = fs.lstatSync(file, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > max) return invalid();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!sameFileIdentity(stat, before) || stat.size > max) return invalid();
      const bytes = Buffer.alloc(max + 1); let size = 0, n;
      while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += n;
      if (size > max) return invalid();
      checkPath(file, false);
      const after = fs.lstatSync(file, { bigint: true }), opened = fs.fstatSync(fd, { bigint: true });
      if (!sameFileIdentity(after, stat) || !sameFileIdentity(opened, stat) || BigInt(size) !== stat.size) return invalid();
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)), updatedAt: stat.mtime.toISOString() };
    } catch (error) { if (error.code !== 'ENOENT') invalid(); return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function atomic(name, text, max) {
    if (rootError) throw rootError;
    if (Buffer.byteLength(text) > max) fail('Context storage limit exceeded');
    const target = path.join(directory, name), temporary = path.join(directory, `.${randomUUID()}.tmp`);
    const verify = () => {
      checkPath(target);
      try { const s = fs.lstatSync(target); if (!s.isFile() || s.nlink !== 1) throw Object.assign(Error('Unsafe context artifact'), { status: 409 }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    checkPath(directory); fs.mkdirSync(directory, { recursive: true }); checkPath(directory, false); verify();
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      verify(); fs.renameSync(temporary, target);
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  const json = (name, max = 1024) => { const r = read(name, max); if (!r) return null; try { return JSON.parse(r.text); } catch { return invalid(); } };
  function settings() {
    const s = json('settings.json', LIMITS.settingsBytes);
    if (!s) return defaults();
    if (closed(s, ['v', 'crossChat']) && s.v === 1 && typeof s.crossChat === 'boolean') return { ...defaults(), crossChat: s.crossChat };
    if (closed(s, ['v', 'crossChat', 'budget', 'models']) && s.v === 2 && typeof s.crossChat === 'boolean' &&
      (!Object.hasOwn(s, 'budget') || rule(s.budget)) && (!Object.hasOwn(s, 'models') || models(s.models))) {
      return { crossChat: s.crossChat, budget: { ...(s.budget ?? DEFAULT_BUDGET) }, models: { ...(s.models ?? {}) } };
    }
    invalid(); return defaults();
  }
  function notes() {
    const r = read('notes.md', LIMITS.notesBytes);
    try { const text = r ? normalizeNotes(r.text) : ''; return { text, chars: text.length, tokens: tokens(text), limit: LIMITS.notes, updatedAt: r?.updatedAt ?? null }; }
    catch { invalid(); return { text: '', chars: 0, tokens: 0, limit: LIMITS.notes, updatedAt: null }; }
  }
  function state() { const s = json('state.json'); return { resetAt: s?.v === 1 && Object.keys(s).length === 2 && typeof s.resetAt === 'string' && Number.isFinite(Date.parse(s.resetAt)) ? new Date(s.resetAt).toISOString() : null }; }
  return { settings, notes, state, get degraded() { return degraded; },
    configure(value) {
      if (!closed(value, ['crossChat', 'budget', 'models']) || !Object.keys(value).length ||
        (Object.hasOwn(value, 'crossChat') && typeof value.crossChat !== 'boolean') ||
        (Object.hasOwn(value, 'budget') && value.budget !== null && !rule(value.budget)) ||
        (Object.hasOwn(value, 'models') && !models(value.models, true))) fail('Invalid context settings patch');
      const next = settings();
      if (Object.hasOwn(value, 'crossChat')) next.crossChat = value.crossChat;
      if (Object.hasOwn(value, 'budget')) next.budget = { ...(value.budget ?? DEFAULT_BUDGET) };
      for (const [key, entry] of Object.entries(value.models ?? {})) {
        if (entry === null) delete next.models[key]; else next.models[key] = { ...entry };
      }
      if (Object.keys(next.models).length > LIMITS.overrides) fail('Context model override limit exceeded');
      atomic('settings.json', JSON.stringify({ v: 2, ...next }) + '\n', LIMITS.settingsBytes);
    },
    setNotes(value) { atomic('notes.md', normalizeNotes(value), LIMITS.notesBytes); },
    setReset(resetAt) {
      if (resetAt !== null && (typeof resetAt !== 'string' || !Number.isFinite(Date.parse(resetAt)))) fail('Invalid context reset date');
      atomic('state.json', JSON.stringify({ v: 1, resetAt }) + '\n', 1024);
    }
  };
}
