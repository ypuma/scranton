import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { writeFileAtomicSync } from './util.js';
import { readRunLease, runOwnerStatus } from './run-lease.js';

export const emptyLive = () => ({ v: 1, runId: null, updatedAt: null, instances: {} });
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
  return {
    update(instanceId, agent, record) {
      if (closed) return;
      let entry = snapshot.instances[instanceId] ??= { agent, phase: 'idle', thinking: null, thinkingCut: false, text: null, textCut: false, updatedAt: null };
      if (record.type === 'message_start' && record.message?.role === 'assistant') {
        blocks.set(instanceId, new Map());
        Object.assign(entry, { phase: 'thinking', thinking: null, thinkingCut: false, text: null, textCut: false });
      } else if (record.type === 'message_update') {
        const e = record.assistantMessageEvent;
        const kind = e?.type?.split('_')[0];
        if (!['thinking', 'text'].includes(kind)) return;
        const parts = blocks.get(instanceId) ?? new Map(); blocks.set(instanceId, parts);
        const key = `${kind}:${e.contentIndex}`;
        const prior = parts.get(key) ?? { text: '', cut: false };
        const value = e.type.endsWith('_end') ? String(e.content ?? '') : e.type.endsWith('_delta') ? prior.text + String(e.delta ?? '') : '';
        parts.set(key, { text: value.slice(-4000), cut: prior.cut || value.length > 4000 });
        const selected = [...parts.entries()].filter(([k]) => k.startsWith(kind + ':')).map(([, v]) => v);
        const raw = selected.map(v => v.text).join('');
        const clean = cleanActivity(raw);
        entry[kind] = clean.slice(-2000); entry[kind + 'Cut'] = selected.some(v => v.cut) || clean.length > 2000;
        entry.phase = kind;
      } else if (record.type === 'tool_execution_start') entry.phase = 'tool';
      else if (record.type === 'tool_execution_end' || record.type === 'message_end') entry.phase = 'idle';
      else return;
      entry.updatedAt = snapshot.updatedAt = new Date().toISOString(); schedule();
    },
    remove(instanceId) { delete snapshot.instances[instanceId]; blocks.delete(instanceId); snapshot.updatedAt = new Date().toISOString(); if (!closed) schedule(); },
    close() { closed = true; clearTimeout(timer); blocks.clear(); snapshot = emptyLive(); write(); }
  };
}
