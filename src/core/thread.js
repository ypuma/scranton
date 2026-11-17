import fs from 'node:fs';
import path from 'node:path';
import { canonicalDirectory, checkScopedPath } from './context/paths.js';
import { LIMITS } from './context/limits.js';
import { isRelativeFile } from './context/shared.js';
import { sameFileIdentity } from './context/file-identity.js';

const text = (value) => typeof value === 'string' ? value : '';
const line = (value) => text(value).replace(/<\/?earlier-runs\s*>/gi, '[earlier-runs]').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
const cache = new Map(), contextCache = new Map();
const checkPath = (target, root) => checkScopedPath(root, target, false);
const contextRoot = (hive) => path.join(canonicalDirectory(path.dirname(path.resolve(hive))), path.basename(path.resolve(hive)));
function boundedRead(file, max = MAX_HISTORY_BYTES, hardened = false) {
  if (hardened) checkPath(file, hardened);
  const options = hardened ? { bigint: true } : undefined;
  const before = hardened ? fs.lstatSync(file, options) : null;
  if (hardened && (!before.isFile() || before.nlink !== 1n)) throw Error('Invalid history artifact');
  const fd = fs.openSync(file, hardened ? fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) : 'r');
  try {
    const stat = fs.fstatSync(fd, options);
    if (hardened && !sameFileIdentity(stat, before)) throw Error('Invalid history artifact');
    if (stat.size > max) throw Error('History exceeds read limit');
    const fileSize = Number(stat.size);
    const bytes = Buffer.allocUnsafe(Math.min(fileSize, max));
    let size = 0, count;
    while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    const after = fs.fstatSync(fd, options);
    if (after.size > max) throw Error('History exceeds read limit');
    if (hardened) {
      checkPath(file, hardened);
      if (!sameFileIdentity(after, stat) || !sameFileIdentity(fs.lstatSync(file, options), stat) || size !== fileSize) throw Error('History artifact changed');
    }
    return bytes.toString('utf8', 0, size);
  } finally { fs.closeSync(fd); }
}
const stamp = (file, hardened) => { try { if (hardened) checkPath(file, hardened); const s = fs.statSync(file); return [s.ino, s.size, s.mtimeMs, s.ctimeMs]; } catch { return null; } };
const linesWithin = (lines, max) => {
  const result = [];
  let size = 0;
  for (const value of lines) {
    if (size + value.length + (result.length ? 1 : 0) > max) break;
    result.push(value);
    size += value.length + (result.length > 1 ? 1 : 0);
  }
  return result.join('\n');
};

function readRun(dir, fallbackId = null, hardened = false, caps = {}) {
  const key = dir, selectedCache = hardened ? contextCache : cache;
  let degraded = false;
  const failed = (error) => { if (error.code !== 'ENOENT') degraded = true; };
  const signature = JSON.stringify([hardened ? caps : null, ...['state.json', 'events.jsonl', 'michael/plan.json'].map((name) => stamp(path.join(dir, name), hardened))]);
  const readJson = (name) => { try { return JSON.parse(boundedRead(path.join(dir, name), hardened ? caps[name] ?? 0 : 1048576, hardened)); } catch (error) { failed(error); return null; } };
  const prior = selectedCache.get(key);
  if (prior?.signature === signature) return prior.run;
  const remember = (run, context = null) => {
    selectedCache.delete(key); selectedCache.set(key, { signature, run, context, degraded });
    if (selectedCache.size > (hardened ? 1024 : 512)) selectedCache.delete(selectedCache.keys().next().value);
    return run;
  };
  const state = readJson('state.json');
  const planFile = readJson('michael/plan.json');
  let events = [];
  try {
    events = boundedRead(path.join(dir, 'events.jsonl'), hardened ? caps['events.jsonl'] ?? 0 : MAX_HISTORY_BYTES, hardened).split('\n').flatMap((raw) => {
      try { const event = JSON.parse(raw); if (event && typeof event === 'object') return [event]; if (hardened) degraded = true; return []; }
      catch { if (hardened && raw.trim()) degraded = true; return []; }
    });
  } catch (error) { failed(error); }
  const runId = text(events.find((e) => e.type === 'run_started')?.runId) || text(state?.runId) || text(events.find((e) => text(e.runId))?.runId) || fallbackId || text(planFile?.runId);
  if (!runId) return remember(null);
  events = events.filter((e) => e.runId === runId);
  const snapshot = state?.runId === runId ? state : null;
  // The root plan survives archival, so never borrow it for a different run.
  const plan = planFile?.runId === runId ? planFile : null;
  const start = events.find((e) => e.type === 'run_started');
  const finish = events.findLast((e) => e.type === 'run_finished');
  const published = events.findLast((e) => e.type === 'plan_ready');
  const milestones = new Map();
  for (const source of [plan?.milestones, snapshot?.milestones, published?.milestones]) {
    if (Array.isArray(source)) for (const m of source) {
      if (m && text(m.id)) milestones.set(m.id, { ...milestones.get(m.id), ...m });
    }
  }
  for (const e of events) {
    if (e.type === 'milestone_started' || e.type === 'milestone_finished') {
      const m = milestones.get(e.milestoneId) ?? { title: e.title ?? e.milestoneId };
      milestones.set(e.milestoneId, { ...m, status: e.type === 'milestone_started' ? 'active' : e.status });
    }
  }
  const goal = text(start?.request) || text(snapshot?.request) || text(plan?.request);
  const status = text(finish?.status) || text(snapshot?.status) || 'unknown';
  const summary = linesWithin([
    `Outcome: ${line(status).slice(0, 80)}${line(finish?.summary) ? ` — ${line(finish.summary).slice(0, 600)}` : ''}`,
    ...[...milestones.values()].map((m) => `- ${line(m.title).slice(0, 180)}: ${line(m.status) || 'pending'}`)
  ], 1500);
  const stored = snapshot?.reply ?? events.findLast((e) => e.type === 'run_reply');
  const reply = stored && ['answer', 'report', 'summary'].includes(stored.kind) && typeof stored.text === 'string'
    ? { kind: stored.kind, text: stored.text.slice(0, 4000), ...(stored.truncated || stored.text.length > 4000 ? { truncated: true } : {}) } : null;
  const usage = snapshot?.usage ? { tokens: snapshot.usage.tokens, cost: snapshot.usage.cost } : snapshot?.agents ? Object.values(snapshot.agents).reduce((sum, a) => ({ tokens: sum.tokens + (a?.totals?.input ?? 0) + (a?.totals?.output ?? 0), cost: sum.cost + (a?.totals?.cost ?? 0) }), { tokens: 0, cost: 0 }) : null;
  const startedAt = text(start?.ts) || null, endedAt = text(finish?.ts) || (['finished', 'failed', 'aborted'].includes(status) ? text(snapshot?.updatedAt) || null : null);
  const files = [...new Set(events.filter((e) => e.type === 'agent_tool' && e.agent === 'dwight' && ['write', 'edit'].includes(e.tool))
    .map((e) => text(e.targetFile)).filter(isRelativeFile))].slice(0, 30);
  const context = { id: runId, engine: 'team', startedAt, endedAt, status: finish && ['success', 'partial', 'failed', 'aborted'].includes(finish.status) ? finish.status : 'interrupted',
    request: goal, outcome: text(finish?.summary) || (reply?.kind === 'answer' ? 'answered' : finish ? text(finish.status) : 'Interrupted'),
    plan: [...milestones.values()].slice(0, 32).map((m) => ({ title: text(m.title), status: text(m.status) || 'pending' })), files,
    reply: stored && ['answer', 'report', 'summary'].includes(stored.kind) && typeof stored.text === 'string' ? { kind: stored.kind, text: stored.text, truncated: Boolean(stored.truncated || stored.text.length > 16000) } : null };
  return remember({ runId, goal, status, reply, usage, startedAt, endedAt, summary }, context);
}

export function listRuns(hiveDir) {
  const runs = [];
  try {
    for (const entry of fs.readdirSync(path.join(hiveDir, 'runs'), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const run = readRun(path.join(hiveDir, 'runs', entry.name), entry.name);
      if (run) runs.push(run);
    }
  } catch {}
  const current = readRun(hiveDir);
  if (current) {
    const duplicate = runs.findIndex((r) => r.runId === current.runId);
    if (duplicate >= 0) runs.splice(duplicate, 1);
    runs.push(current);
  }
  return runs.sort((a, b) => (a.startedAt ?? a.runId).localeCompare(b.startedAt ?? b.runId));
}

export function formatThreadContext(runs, { maxChars = 8000 } = {}) {
  const max = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 8000;
  const kept = [];
  let remaining = max;
  for (const run of [...runs].reverse()) {
    const lines = [
      `Run ${line(run.runId)} | ${line(run.status)}`,
      `Goal: ${line(run.goal)}`,
      ...(run.reply ? [`Reply (${line(run.reply.kind)}): ${line(run.reply.text).slice(0, 1500)}`] : []),
      ...(run.reply ? [`Summary: ${line(run.summary)}`] : text(run.summary).split(/\r?\n/).map(line))
    ];
    const block = linesWithin(lines, remaining);
    if (!block) break;
    kept.unshift(block);
    remaining -= block.length + 2;
    if (remaining <= 0 || block !== lines.join('\n')) break;
  }
  return kept.join('\n\n');
}

export function listContextRuns(hiveDir, { maxRuns = LIMITS.runs, activeRunId, excludeRoot = false, budget = { bytes: LIMITS.readBytes } } = {}) {
  const entries = [], runs = new Map();
  let degraded = false, hive;
  const failed = (error) => { if (error.code !== 'ENOENT') degraded = true; };
  try { hive = contextRoot(hiveDir); checkPath(hive, hive); }
  catch (error) { failed(error); return { runs: [], unread: 0, truncated: false, degraded }; }
  try {
    const root = path.join(hive, 'runs'); checkPath(root, hive);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      try {
        const dir = path.join(root, entry.name); checkPath(dir, hive);
        if (entry.isDirectory()) entries.push({ dir, name: entry.name, mtime: fs.lstatSync(dir).mtimeMs });
      } catch (error) { failed(error); }
    }
  } catch (error) { failed(error); }
  let rootRun = false;
  for (const name of ['events.jsonl', 'state.json', 'michael/plan.json']) {
    try { checkPath(path.join(hive, name), hive); rootRun = true; }
    catch (error) { failed(error); }
  }
  if (rootRun) {
    try { entries.push({ dir: hive, name: null, mtime: fs.lstatSync(hive).mtimeMs }); }
    catch (error) { failed(error); }
  }
  entries.sort((a, b) => b.mtime - a.mtime || (a.name ?? '').localeCompare(b.name ?? ''));
  let unread = Math.max(0, entries.length - maxRuns);
  budget.charged ??= new Set();
  const selected = entries.slice(0, maxRuns);
  for (const [index, { dir, name }] of selected.entries()) {
    let bytes = 0; const caps = {}, charged = [];
    for (const file of ['state.json', 'events.jsonl', 'michael/plan.json']) {
      try {
        const target = path.join(dir, file); checkPath(target, hive); const s = fs.lstatSync(target);
        if (!s.isFile() || s.nlink !== 1 || s.size > (file === 'events.jsonl' ? MAX_HISTORY_BYTES : 1048576)) throw Error('Invalid history artifact');
        if (!budget.charged.has(target)) { bytes += s.size; charged.push(target); }
        caps[file] = s.size;
      } catch (error) { failed(error); }
    }
    if (budget.exhausted || bytes > budget.bytes) { unread += selected.length - index; budget.exhausted = true; break; }
    budget.bytes -= bytes; for (const file of charged) budget.charged.add(file);
    try {
      readRun(dir, name, hive, caps); const stored = contextCache.get(dir), value = stored?.context;
      degraded ||= Boolean(stored?.degraded);
      if (value && value.id !== activeRunId && !(excludeRoot && dir === hive && value.status === 'interrupted')) runs.set(value.id, value);
    } catch { unread++; degraded = true; }
  }
  return { runs: [...runs.values()].sort((a, b) => (a.startedAt ?? a.id).localeCompare(b.startedAt ?? b.id) || a.id.localeCompare(b.id)), unread, truncated: unread > 0, degraded };
}

export function countContextRuns(hiveDir) {
  let count = 0, hive;
  try { hive = contextRoot(hiveDir); checkPath(hive, hive); } catch { return 0; }
  try {
    const root = path.join(hive, 'runs'); checkPath(root, hive);
    count = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).length;
  } catch {}
  try {
    let rootRun = false;
    try { rootRun = Boolean(JSON.parse(boundedRead(path.join(hive, 'state.json'), 1048576, hive))?.runId); } catch {}
    if (!rootRun) {
      try { const file = path.join(hive, 'events.jsonl'); checkPath(file, hive); const s = fs.lstatSync(file); rootRun = s.isFile() && s.nlink === 1 && s.size > 0; } catch {}
    }
    if (rootRun) count++;
  } catch {}
  return count;
}
