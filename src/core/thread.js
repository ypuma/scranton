import fs from 'node:fs';
import path from 'node:path';

const text = (value) => typeof value === 'string' ? value : '';
const line = (value) => text(value).replace(/<\/?earlier-runs\s*>/gi, '[earlier-runs]').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
const cache = new Map();
function boundedRead(file, max = MAX_HISTORY_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize > max) throw Error('History exceeds read limit');
    const bytes = Buffer.allocUnsafe(Math.min(fileSize, max));
    let size = 0, count;
    while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (fs.fstatSync(fd).size > max) throw Error('History exceeds read limit');
    return bytes.toString('utf8', 0, size);
  } finally { fs.closeSync(fd); }
}
const json = (file) => { try { return JSON.parse(boundedRead(file, 1024 * 1024)); } catch { return null; } };
const stamp = (file) => { try { const s = fs.statSync(file); return [s.ino, s.size, s.mtimeMs, s.ctimeMs]; } catch { return null; } };
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

function readRun(dir, fallbackId = null) {
  const signature = JSON.stringify(['state.json', 'events.jsonl', 'michael/plan.json'].map((name) => stamp(path.join(dir, name))));
  const prior = cache.get(dir);
  if (prior?.signature === signature) return prior.run;
  const remember = (run) => {
    cache.delete(dir); cache.set(dir, { signature, run });
    if (cache.size > 512) cache.delete(cache.keys().next().value);
    return run;
  };
  const state = json(path.join(dir, 'state.json'));
  const planFile = json(path.join(dir, 'michael', 'plan.json'));
  let events = [];
  try {
    events = boundedRead(path.join(dir, 'events.jsonl')).split('\n').flatMap((raw) => {
      try { const event = JSON.parse(raw); return event && typeof event === 'object' ? [event] : []; } catch { return []; }
    });
  } catch {}
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
  return remember({ runId, goal, status, reply, startedAt: text(start?.ts) || null,
    endedAt: text(finish?.ts) || (['finished', 'failed', 'aborted'].includes(status) ? text(snapshot?.updatedAt) || null : null), summary });
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
