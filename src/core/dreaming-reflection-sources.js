import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { redact, boundedRedact } from './dreaming/reflection.js';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const unavailable = 'Some reflection sources were missing, unsafe, malformed or over limit; they were excluded.';
const fail = () => { throw Error('Unavailable reflection source'); };

export function createDreamingReflectionSources({ dataDir, projectId, env = process.env }) {
  if (!id(projectId)) fail();
  const base = path.resolve(dataDir), scope = `projects/${projectId}`;
  function safe(rel) {
    let p = base;
    for (const part of ['', ...rel.split('/')]) {
      if (part) { if (!id(part.replace(/\.[a-z]+$/, '')) && !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..') fail(); p = path.join(p, part); }
      const s = fs.lstatSync(p);
      if (s.isSymbolicLink() || fs.realpathSync(p) !== p) fail();
    }
    return p;
  }
  function entries(rel) {
    try {
      const dir = fs.opendirSync(safe(rel)), names = [];
      try { let e; while ((e = dir.readSync())) { if (names.length === 128) fail(); names.push(e.name); } }
      finally { dir.closeSync(); }
      return names.filter(id).sort();
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  function read(rel, budget, json = true) {
    const p = safe(rel), fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const s = fs.fstatSync(fd), max = json ? 262144 : 2097152;
      if (!s.isFile() || s.nlink !== 1 || s.size > max || s.size > budget.bytes) fail();
      const b = Buffer.alloc(s.size + 1); let n = 0, count;
      while (n < b.length && (count = fs.readSync(fd, b, n, b.length - n, null))) n += count;
      if (n !== s.size || fs.fstatSync(fd).size !== n) fail();
      budget.bytes -= n;
      const raw = b.subarray(0, n), text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const value = json ? JSON.parse(text) : text;
      if (json && !object(value)) fail();
      return { value, source: { path: rel, sha256: hash(raw) } };
    } finally { fs.closeSync(fd); }
  }
  function clean(value) {
    if (typeof value !== 'string') return '';
    let text = value;
    for (const [name, v] of Object.entries(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && typeof v === 'string' && v.length >= 4) text = text.split(v).join('[redacted]');
    return redact(text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\bBearer\s+\S+|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, '[redacted]')
      .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
      .replace(/\b[A-Za-z]:[\\/][^\s"<>]+|\\\\[^\s"<>]+|(^|[\s"'(=])\/[^\s"<>]+/g, ' [private path]')
      .replace(/https?:\/\/[^\s]+/gi, (url) => { try { const u = new URL(url); return u.username || u.password || u.search || u.hash ? '[private URL]' : url; } catch { return '[private URL]'; } }).trim());
  }
  function collectReflection() {
    const runs = [], limitations = new Set(), budget = { bytes: 16 * 1024 * 1024 };
    const excluded = () => limitations.add(unavailable);
    function journal(rel, engine, runId) {
      const r = read(rel, budget, false);
      if (!r.value.endsWith('\n')) fail();
      const rows = r.value.trimEnd().split('\n').map((s) => JSON.parse(s));
      if (!rows.length || rows.length > 10000 || rows.some((e, i) => !object(e) || e.seq !== i + 1 || (engine === 'team' ? e.v !== 1 || e.runId !== runId : e.run_id !== runId))) fail();
      if (rows[0].type !== 'run_started' || rows.at(-1).type !== 'run_finished') fail();
      return { rows, source: r.source };
    }
    function team(hive, archiveId = null) {
      const root = archiveId === null ? hive : `${hive}/runs/${archiveId}`;
      const first = read(`${root}/events.jsonl`, budget, false);
      const start = JSON.parse(first.value.split('\n')[0]);
      if (!id(start.runId) || (archiveId !== null && archiveId !== start.runId)) fail();
      const r = journal(`${root}/events.jsonl`, 'team', start.runId), end = r.rows.at(-1);
      if (start.execution?.simulated || start.demo || start.internal || !['success', 'partial', 'failed', 'aborted'].includes(end.status)) return;
      const parts = [];
      for (const e of r.rows.toReversed()) {
        if (parts.length >= 3) break;
        if (e.type === 'hitl_response' && e.decision === 'feedback') parts.push({ role: 'user', text: e.feedback, at: e.ts });
        if (e.type === 'chat_message' && e.from === 'human' && e.delivery !== 'rejected') parts.push({ role: 'user', text: e.text, at: e.ts });
      }
      parts.push({ role: 'user', text: start.request, at: start.ts });
      const reply = r.rows.findLast((e) => e.type === 'run_reply' && !e.truncated);
      if (reply) parts.push({ role: 'assistant', text: reply.text, at: reply.ts });
      parts.push({ role: 'outcome', text: `Recorded Team terminal status: ${end.status}.`, at: end.ts });
      for (const e of r.rows.filter((e) => e.type === 'agent_finished' && Number.isInteger(e.exitCode)).slice(-3)) parts.push({ role: 'outcome', text: `Recorded agent process exit code: ${e.exitCode}. This alone does not prove task correctness.`, at: e.ts });
      // The canonical archive locator also names the still-live original journal.
      const source = { ...r.source, path: `${hive}/runs/${start.runId}/events.jsonl` };
      runs.push({ key: `team:${start.runId}:${hive}`, at: end.ts, parts, sources: [source] });
    }
    function pipeline(root, runId) {
      const s = read(`${root}/status.json`, budget), m = read(`${root}/run.json`, budget);
      if (s.value.run_id !== runId || m.value.run_id !== runId || m.value.demo || m.value.internal || !['succeeded', 'failed', 'cancelled', 'rejected'].includes(s.value.status)) return;
      const r = journal(`${root}/events.jsonl`, 'pipeline', runId), parts = [];
      if (r.rows.at(-1).data?.status !== s.value.status) fail();
      parts.push({ role: 'user', text: m.value.task, at: m.value.created_at });
      parts.push({ role: 'outcome', text: `Recorded Pipeline terminal status: ${s.value.status}.`, at: s.value.updated_at });
      const sources = [s.source, m.source, r.source];
      try {
        const reply = read(`${root}/delivery/reply.json`, budget);
        parts.push({ role: 'assistant', text: reply.value.text, at: s.value.updated_at, sources: [s.source, m.source, reply.source] });
      } catch (e) { if (e.code !== 'ENOENT') excluded(); }
      for (const c of Array.isArray(s.value.checks) ? s.value.checks.slice(-3) : []) if (['passed', 'failed', 'timed_out', 'error'].includes(c?.status)) parts.push({ role: 'outcome', text: `Recorded check status: ${c.status}.`, at: s.value.updated_at });
      runs.push({ key: `pipeline:${runId}:${root}`, at: s.value.updated_at, parts, sources });
    }
    let chats = [];
    try { chats = entries(`${scope}/chats`); } catch { excluded(); }
    for (const chatId of chats) try {
      const root = `${scope}/chats/${chatId}`, meta = read(`${root}/chat.json`, budget).value;
      if (meta.id !== chatId || meta.projectId !== projectId || meta.demo || meta.internal) fail();
      if (meta.engine === 'pipeline') for (const run of entries(`${root}/pipeline/runs`)) { try { pipeline(`${root}/pipeline/runs/${run}`, run); } catch { excluded(); } }
      else {
        if (path.resolve(meta.hiveDir ?? '') !== path.join(base, root, 'hive')) fail();
        for (const run of entries(`${root}/hive/runs`)) { try { team(`${root}/hive`, run); } catch { excluded(); } }
        try { team(`${root}/hive`); } catch (e) { if (e.code !== 'ENOENT') excluded(); }
      }
    } catch { excluded(); }
    const signals = [];
    const selected = [...new Map(runs.map((r) => [r.key, r])).values()].filter((r) => Number.isFinite(Date.parse(r.at))).sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)).slice(0, 4);
    for (const run of selected) {
      let remaining = 1000;
      const parts = run.parts.slice(0, 8), cap = Math.min(400, Math.floor(1000 / Math.max(1, parts.length)));
      for (const [i, part] of parts.entries()) {
        const text = boundedRedact(clean(part.text), Math.min(cap, remaining));
        if (!text || !Number.isFinite(Date.parse(part.at))) continue;
        remaining -= text.length;
        const sources = part.sources ?? run.sources;
        signals.push({ runId: hash(`${scope}:${run.key}`), id: hash(`${run.key}:${i}:${text}:${JSON.stringify(sources)}`).slice(0, 24), role: part.role, text, at: new Date(part.at).toISOString(), sources });
      }
    }
    return { signals, limitations: [...limitations] };
  }
  return { collectReflection };
}

export async function resolveReflectionModel(auth, selection) {
  if (typeof selection !== 'string' || selection.length > 240 || /[\s\x00-\x1f]/.test(selection) || !selection.includes('/')) throw Object.assign(Error('Select an authenticated reflection model'), { status: 400 });
  const slash = selection.indexOf('/'), provider = selection.slice(0, slash), model = selection.slice(slash + 1);
  let catalog, accounts;
  try { catalog = await auth.listModels(); accounts = await auth.listAccounts(); } catch { throw Object.assign(Error('Reflection model catalog unavailable'), { status: 409 }); }
  if (!accounts.some((a) => a.id === provider && a.status === 'signed_in') || !catalog.providers?.some((p) => p.id === provider && p.models?.some((m) => m.id === model))) throw Object.assign(Error('Selected reflection model is not authenticated or available'), { status: 400 });
  return selection;
}
