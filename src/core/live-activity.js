import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { writeFileAtomicSync } from './util.js';
import { readRunLease, runOwnerStatus } from './run-lease.js';

export const emptyLive = () => ({ v: 1, runId: null, updatedAt: null, instances: {} });
// What the models of a run reasoned and wrote, block by block, kept beside its journal (thoughts.jsonl) and archived
// with it: { v, n, ts, runId, instanceId, agent, kind: 'reasoning' | 'answer', text, cut }. Too bulky for the journal,
// so it has a file and bounds of its own: a block keeps its first THOUGHT_MAX characters, a run THOUGHTS_MAX_BYTES.
export const THOUGHTS_FILE = 'thoughts.jsonl';
export const THOUGHT_MAX = 20000;
export const THOUGHTS_MAX_BYTES = 8 * 1024 * 1024;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

// The saved blocks of a run with n > after, oldest first; null: the run kept none (an older run, or no such run).
// The run on screen is read from the hive itself, an earlier one from its archive.
export function readThoughts(hiveDir, runId, after = 0) {
  if (!RUN_ID.test(runId ?? '')) return null;
  let current = null;
  try { current = JSON.parse(fs.readFileSync(path.join(hiveDir, 'state.json'), 'utf8')).runId ?? null; } catch { /* no run here */ }
  const file = current === runId ? path.join(hiveDir, THOUGHTS_FILE) : path.join(hiveDir, 'runs', runId, THOUGHTS_FILE);
  let text;
  try {
    const root = fs.realpathSync(hiveDir);
    if (!fs.realpathSync(file).startsWith(root + path.sep)) return null;
    if (fs.statSync(file).size > THOUGHTS_MAX_BYTES + 1024 * 1024) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  const thoughts = text.split('\n').flatMap((line) => {
    if (!line) return [];
    try {
      const t = JSON.parse(line);
      return t && t.runId === runId && Number.isSafeInteger(t.n) && t.n > after && typeof t.text === 'string' ? [t] : [];
    } catch { return []; }
  });
  return { v: 1, runId, thoughts, next: thoughts.length ? thoughts.at(-1).n : after };
}
export function cleanActivity(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

export function readLive(hiveDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(hiveDir, 'state.json'), 'utf8'));
    if (!['planning', 'running', 'paused'].includes(state.status)) return emptyLive();
    const lease = readRunLease(hiveDir);
    if (lease && (lease.runId !== state.runId || runOwnerStatus(hiveDir, lease) === 'gone')) return emptyLive();
    const file = path.join(hiveDir, 'live.json');
    if (fs.statSync(file).size > 1024 * 1024) return emptyLive();
    const live = JSON.parse(fs.readFileSync(file, 'utf8'));
    return live.v === 1 && live.runId === state.runId && live.instances && typeof live.instances === 'object' ? live : emptyLive();
  } catch { return emptyLive(); }
}

export function createLiveActivity(hiveDir, runId) {
  let snapshot = { ...emptyLive(), runId }, timer = null, lastWrite = 0, closed = false;
  const file = path.join(hiveDir, 'live.json');
  const write = () => {
    timer = null; lastWrite = Date.now();
    try { writeFileAtomicSync(file, JSON.stringify(snapshot) + '\n'); } catch { /* Live display must not stop a run. */ }
  };
  const schedule = () => { if (!timer) { timer = setTimeout(write, Math.max(0, 400 - (Date.now() - lastWrite))); timer.unref(); } };
  const blocks = new Map();
  // the blocks that are done go to thoughts.jsonl, one line each; a write that fails never stops a run
  const thoughtsFile = path.join(hiveDir, THOUGHTS_FILE);
  let saved = 0, bytes = 0, full = false;
  const save = (instanceId, agent, kind, raw, cut = false) => {
    const clean = cleanActivity(raw);
    if (full || !clean.trim()) return;
    const line = JSON.stringify({ v: 1, n: ++saved, ts: new Date().toISOString(), runId, instanceId, agent, kind: kind === 'thinking' ? 'reasoning' : 'answer', text: clean.slice(0, THOUGHT_MAX), cut: cut || clean.length > THOUGHT_MAX }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n';
    bytes += Buffer.byteLength(line);
    if (bytes > THOUGHTS_MAX_BYTES) { full = true; return; }
    try { fs.appendFileSync(thoughtsFile, line); } catch { /* the display must not stop a run */ }
  };
  // a message that ended, or an agent that stopped, with a block still open: what was seen of it is kept
  const flush = (instanceId, agent) => {
    for (const [key, part] of blocks.get(instanceId) ?? []) {
      if (!part.saved && part.text) { part.saved = true; save(instanceId, agent, key.split(':')[0], part.text, true); }
    }
  };
  return {
    update(instanceId, agent, record) {
      if (closed) return;
      let entry = snapshot.instances[instanceId] ??= { agent, phase: 'idle', thinking: null, thinkingCut: false, text: null, textCut: false, open: null, updatedAt: null };
      if (record.type === 'message_start' && record.message?.role === 'assistant') {
        flush(instanceId, agent);
        blocks.set(instanceId, new Map());
        Object.assign(entry, { phase: 'thinking', thinking: null, thinkingCut: false, text: null, textCut: false, open: null });
      } else if (record.type === 'message_update') {
        const e = record.assistantMessageEvent;
        const kind = e?.type?.split('_')[0];
        if (!['thinking', 'text'].includes(kind)) return;
        const parts = blocks.get(instanceId) ?? new Map(); blocks.set(instanceId, parts);
        const key = `${kind}:${e.contentIndex}`;
        const prior = parts.get(key) ?? { text: '', cut: false };
        const value = e.type.endsWith('_end') ? String(e.content ?? '') : e.type.endsWith('_delta') ? prior.text + String(e.delta ?? '') : '';
        const ended = e.type.endsWith('_end');
        parts.set(key, { text: value.slice(-4000), cut: prior.cut || value.length > 4000, saved: prior.saved || ended });
        // a block that is done is saved in full; `open` says which kind is still being written, so a reader of the
        // saved blocks does not show the tail of one it already has
        if (ended && !prior.saved) save(instanceId, agent, kind, value || prior.text, !value && prior.cut);
        entry.open = ended ? null : kind;
        const selected = [...parts.entries()].filter(([k]) => k.startsWith(kind + ':')).map(([, v]) => v);
        const raw = selected.map(v => v.text).join('');
        const clean = cleanActivity(raw);
        entry[kind] = clean.slice(-2000); entry[kind + 'Cut'] = selected.some(v => v.cut) || clean.length > 2000;
        entry.phase = kind;
      } else if (record.type === 'tool_execution_start') entry.phase = 'tool';
      else if (record.type === 'tool_execution_end' || record.type === 'message_end') {
        entry.phase = 'idle';
        if (record.type === 'message_end') {
          if (record.discard) {
            blocks.delete(instanceId);
            Object.assign(entry, { thinking: null, thinkingCut: false, text: null, textCut: false });
          } else flush(instanceId, agent);
          entry.open = null;
        }
      } else return;
      entry.updatedAt = snapshot.updatedAt = new Date().toISOString(); schedule();
    },
    remove(instanceId) { flush(instanceId, snapshot.instances[instanceId]?.agent ?? null); delete snapshot.instances[instanceId]; blocks.delete(instanceId); snapshot.updatedAt = new Date().toISOString(); if (!closed) schedule(); },
    close() { for (const [id, entry] of Object.entries(snapshot.instances)) flush(id, entry.agent); closed = true; clearTimeout(timer); blocks.clear(); snapshot = emptyLive(); write(); }
  };
}
