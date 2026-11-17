import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from './context/limits.js';
import { canonicalDirectory } from './context/paths.js';
import { sameFileIdentity } from './context/file-identity.js';

import { PIPELINE_TERMINAL, maskHistoricalText } from './context/shared.js';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const array = (v) => Array.isArray(v) ? v : [];
const string = (v) => typeof v === 'string' ? v : '';
const strings = (v) => array(v).filter((s) => typeof s === 'string').slice(0, 32);
const MAX_ARTIFACT = 1024 * 1024;

// Reject even in-root links: history must never acquire authority through a redirected artifact.
function regularPath(base, rel, directory = false) {
  let current = path.resolve(base);
  if (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync(current) !== current) throw Error('Linked history root');
  for (const part of rel.split('/')) {
    if (!part || part === '.' || part === '..' || part.includes('\\')) throw Error('Invalid history path');
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw Error('Linked history artifact');
    if (fs.realpathSync(current) !== current) throw Error('Redirected history artifact');
  }
  const stat = fs.lstatSync(current);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('Invalid history artifact');
  return current;
}

export function readPipelineHistoryJson(base, rel, { budget, cache = budget?.cache, diagnostics = budget } = {}) {
  const key = path.resolve(base, rel);
  if (cache?.has(key)) return cache.get(key);
  const invalid = () => { if (diagnostics) diagnostics.degraded = true; return null; };
  let fd;
  try {
    base = canonicalDirectory(path.resolve(base));
    const file = regularPath(base, rel);
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > MAX_ARTIFACT) return invalid();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(stat, before) || stat.size > MAX_ARTIFACT) return invalid();
    if (budget && stat.size > budget.bytes) { budget.exhausted = true; return null; }
    const buffer = Buffer.alloc(budget ? Number(stat.size) : MAX_ARTIFACT + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (budget) { budget.bytes -= length; if (budget.bytes < 0) { budget.exhausted = true; return null; } }
    regularPath(base, rel);
    if (length > MAX_ARTIFACT || BigInt(length) !== stat.size || !sameFileIdentity(fs.fstatSync(fd, { bigint: true }), stat) || !sameFileIdentity(fs.lstatSync(file, { bigint: true }), stat)) return invalid();
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    const result = object(value) ? value : invalid();
    cache?.set(key, result);
    return result;
  } catch (error) { if (error.code !== 'ENOENT') invalid(); if (!budget?.exhausted) cache?.set(key, null); return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function planProjection(plan, revision) {
  if (!object(plan) || typeof plan.summary !== 'string' || !Array.isArray(plan.steps) || !plan.steps.length) return '';
  const filePath = (v) => typeof v === 'string' && !/^(?:[A-Za-z]:|\/|\\)|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v) ? v : '[unavailable path]';
  return { revision: Number.isSafeInteger(revision) ? revision : 'unknown', summary: plan.summary,
    steps: plan.steps.slice(0, 32).filter(object).map((s) => ({ id: string(s.id), title: string(s.title), description: string(s.description),
      files: array(s.files).slice(0, 100).filter(object).map((f) => ({ path: filePath(f.path), action: string(f.action) })),
      depends_on: s.depends_on == null ? null : strings(s.depends_on), criteria: array(s.criteria).filter((v) => typeof v === 'string').slice(0, 100) })),
    acceptance_criteria: array(plan.acceptance_criteria).slice(0, 100).filter(object).map((c) => ({ id: string(c.id), text: string(c.text), verified_by: string(c.verified_by) })) };
}

function outcomeProjection(status, report, reply, hasPlan) {
  const failure = report?.failure ?? status.failure;
  const delivery = report?.delivery ?? status.delivery;
  const records = array(report?.steps).filter(object);
  const steps = records.map((s) => s.step_id).filter((v) => typeof v === 'string' && v.startsWith('step:') && v.length > 5);
  const checks = (v) => array(v).slice(0, 12).filter(object).map((c) => ({ id: string(c.id), status: string(c.status), diagnostic: typeof c.output_tail === 'string' ? c.output_tail.slice(-512) : '' }));
  return { plan_availability: hasPlan ? 'available' : 'Plan unavailable (missing, malformed, oversized or unreadable artifact).',
    failure: object(failure) ? { code: string(failure.code), message: string(failure.message), node: string(failure.node) } : null,
    verified_steps: report && Array.isArray(report.steps) ? steps.slice(0, 32) : 'unavailable',
    verified_step_count: report && Array.isArray(report.steps) ? steps.length : Number.isSafeInteger(status.progress?.steps_done) ? status.progress.steps_done : 'unknown',
    other_verified_work: records.map((s) => s.step_id).filter((v) => typeof v === 'string' && !v.startsWith('step:')).slice(0, 32),
    delivery_applied: typeof delivery?.applied === 'boolean' ? delivery.applied : 'unknown',
    baseline: report ? checks(report.baseline) : 'unavailable', final_checks: checks(report?.checks ?? status.checks),
    assistant_reply: typeof reply?.text === 'string' ? reply.text : typeof status.reply?.text === 'string' ? status.reply.text : 'unavailable',
    note: 'Historical observations only. Other verified work is repair/integration, not plan steps. Unverified attempts are not counted; failed attempted edits are not delivered changes.' };
}

export function buildPipelineHistory({ dataDir, projectId, chatId, redact = (text) => text, projectMemory = [], context, since, budget, excludedRunId, allowance }) {
  if (!idPattern.test(projectId) || !idPattern.test(chatId)) return null;
  // The pack's allowance must never narrow the pre-existing §26 selection.
  const cache = budget?.cache ?? new Map();
  const scope = `projects/${projectId}/chats/${chatId}/pipeline`;
  const read = (rel) => readPipelineHistoryJson(dataDir, `${scope}/${rel}`, { cache, diagnostics: budget });
  let ids;
  try { dataDir = canonicalDirectory(path.resolve(dataDir)); ids = fs.readdirSync(regularPath(dataDir, `${scope}/runs`, true)).filter((id) => idPattern.test(id)); }
  catch { ids = []; }
  let truncated = false;
  const text = (value, cap) => {
    const input = redact(typeof value === 'string' ? value : '').toWellFormed();
    const clean = maskHistoricalText((context === undefined ? input : input.replace(/<\/?(?:earlier-runs|conversation-context)\s*>/gi, (tag) => '[' + tag.replace(/[<>/\s]/g, '') + ']')), true);
    const chars = Array.from(clean);
    if (chars.length > cap) truncated = true;
    const result = chars.slice(0, cap).join('');
    return context === undefined && since === undefined || result.trim() ? result : '';
  };
  const fitProjection = (value, cap) => {
    const leaves = [], lists = [];
    const clean = (v) => {
      if (typeof v === 'string') return text(v, 256 * 1024);
      if (Array.isArray(v)) return v.map(clean);
      if (!object(v)) return v;
      return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, clean(v)]));
    };
    const projection = clean(value);
    const visit = (v) => { for (const key of Object.keys(v)) {
      if (typeof v[key] === 'string') leaves.push({ row: v, key });
      else if (v[key] && typeof v[key] === 'object') {
        if (Array.isArray(v[key])) lists.push({ row: v, key });
        visit(v[key]);
      }
    } };
    visit(projection);
    let encoded = JSON.stringify(projection);
    while (Array.from(encoded).length > cap) {
      const minimum = cap < 2000 ? 16 : 64;
      let shortened = false;
      projection.truncated = true;
      for (const { row, key } of leaves) {
        const chars = Array.from(row[key]);
        if (chars.length <= minimum) continue;
        row[key] = chars.slice(0, Math.max(minimum - 1, Math.floor(chars.length / 2))).join('') + '…';
        shortened = true;
      }
      if (!shortened) {
        // Bulk-reduce details before dependencies, and whole steps only as a last resort.
        const priority = (key) => key === 'steps' ? 2 : key === 'depends_on' ? 1 : 0;
        const eligible = lists.filter(({ row, key }) => row[key].length > (priority(key) ? 1 : 0));
        if (!eligible.length) return encoded;
        const level = Math.min(...eligible.map(({ key }) => priority(key)));
        for (const { row, key } of eligible.filter(({ key }) => priority(key) === level)) {
          const length = row[key].length;
          row[key].length = Math.max(priority(key) ? 1 : 0, Math.floor(length / 2));
          row.omitted ??= {};
          row.omitted[key] = (row.omitted[key] ?? 0) + length - row[key].length;
        }
        leaves.length = 0; lists.length = 0; visit(projection);
      }
      encoded = JSON.stringify(projection); truncated = true;
    }
    return encoded;
  };
  const candidates = ids.flatMap((id) => {
    const s = read(`runs/${id}/status.json`);
    if (id === excludedRunId || !s || !PIPELINE_TERMINAL.includes(s.status) || since && Number.isFinite(Date.parse(since)) && !(Date.parse(s.created_at) > Date.parse(since))) return [];
    return [{ id, date: typeof s.created_at === 'string' ? s.created_at : '', status: s }];
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const projectPlan = (c) => {
    const plan = planProjection(read(`runs/${c.id}/artifacts/plan.json`), c.status.progress?.plan_revision);
    return plan ? fitProjection(plan, 8000) : '';
  };
  let anchor;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]; c.plan = projectPlan(c);
    if (c.plan) { anchor = c; break; }
  }
  const selected = candidates.slice(-3);
  if (anchor && !selected.includes(anchor)) selected.unshift(anchor);
  const project_memory = [];
  for (const item of Array.isArray(projectMemory) ? projectMemory.slice(0, 16) : []) {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(item.id) || typeof item.text !== 'string' || !Array.isArray(item.sources) || !item.sources.length || item.sources.some((s) => typeof s !== 'string' || s.length > 240 || !/^projects\//.test(s))) continue;
    const entry = { id: item.id, text: text(item.text, 400), sources: item.sources.slice(0, 3).map((s) => text(s, 240)) };
    if (JSON.stringify([...project_memory, entry]).length <= 2000) project_memory.push(entry);
  }
  const wireBytes = allowance ? Math.max(LIMITS.pipelineBytes, allowance.historyBytes + allowance.contextBytes) : LIMITS.pipelineBytes;
  const contextBytes = allowance ? Math.max(LIMITS.pipelineContextBytes, allowance.contextBytes) : LIMITS.pipelineContextBytes;
  const earlierMax = allowance ? LIMITS.pipelineEarlierMax : LIMITS.pipelineEarlier;
  const rawNotes = object(context) ? text(context.notes, allowance ? LIMITS.pipelineNotesMax : LIMITS.pipelineNotes) : '';
  const rawLines = array(context?.lines).filter((v) => object(v) && idPattern.test(v.run_id) && typeof v.line === 'string').map((v) => ({ run_id: v.run_id, line: text(v.line, LIMITS.pipelineLine) })).filter((v) => v.line);
  const rawOther = array(context?.other_chats).slice(0, LIMITS.otherChats).filter((v) => object(v) && ['team', 'pipeline'].includes(v.engine)).map((v) => ({ title: text(v.title, 120), engine: v.engine,
    turns: array(v.turns).slice(-LIMITS.otherTurns).filter((s) => typeof s === 'string').map((s) => text(s, LIMITS.pipelineLine)).filter(Boolean) })).filter((v) => v.turns.length);
  if (array(context?.other_chats).length > LIMITS.otherChats || array(context?.other_chats).some((c) => array(c?.turns).length > LIMITS.otherTurns)) truncated = true;
  function deriveContext(runs) {
    const extra = {}, ids = new Set(runs.map((r) => r.run_id)), lines = rawLines.filter((v) => !ids.has(v.run_id));
    if (rawNotes) extra.notes = rawNotes;
    if (lines.length) extra.earlier = lines.slice(-earlierMax).map((v) => v.line);
    if (lines.length > earlierMax) { extra.omitted = Math.min(100000, lines.length - earlierMax); truncated = true; }
    if (rawOther.length) extra.other_chats = [...rawOther];
    while (Buffer.byteLength(JSON.stringify(extra)) > contextBytes) {
      truncated = true;
      if (extra.other_chats?.length) { extra.other_chats.pop(); if (!extra.other_chats.length) delete extra.other_chats; }
      else if (extra.earlier?.length) { extra.earlier.shift(); extra.omitted = Math.min(100000, (extra.omitted ?? 0) + 1); if (!extra.earlier.length) { delete extra.earlier; delete extra.omitted; } }
      else if (extra.notes) { const chars = Array.from(extra.notes); extra.notes = chars.slice(0, Math.floor(chars.length / 2)).join('') + '…'; if (chars.length < 2) delete extra.notes; }
      else break;
    }
    return Object.keys(extra).length ? extra : undefined;
  }
  const runs = selected.map((c) => {
    const meta = read(`runs/${c.id}/run.json`), report = read(`runs/${c.id}/delivery/report.json`);
    const launch = !meta && read(`requests/${c.id}.json.launch.json`);
    const plan = c.plan ?? projectPlan(c);
    return { run_id: c.id, status: c.status.status,
      task: text(meta?.task ?? launch?.task ?? report?.task ?? c.status.task ?? 'Task unavailable', 4000), plan,
      outcome: fitProjection(outcomeProjection(c.status, report, read(`runs/${c.id}/delivery/reply.json`), Boolean(plan)), 4000) };
  });
  const result = { schema: 1, runs, truncated, ...(project_memory.length ? { project_memory } : {}) };
  function refresh() { const extra = deriveContext(runs); if (extra) result.context = extra; else delete result.context; result.truncated ||= truncated; }
  refresh();
  if (allowance) result.budget = { history_bytes: allowance.historyBytes, context_bytes: allowance.contextBytes };
  if (!runs.length && !project_memory.length && !result.context) return null;
  const size = () => Buffer.byteLength(JSON.stringify(result));
  while (size() > wireBytes && project_memory.length) { project_memory.pop(); result.truncated = true; }
  if (!project_memory.length) delete result.project_memory;
  // Recompute condensed history after shedding so an ordinary run cannot vanish.
  while (size() > wireBytes && runs.length > 1) {
    const index = runs.findIndex((r, i) => r.run_id !== anchor?.id && i !== runs.length - 1);
    if (index < 0) break;
    runs.splice(index, 1); result.truncated = true; refresh();
  }
  const blocked = new Set();
  while (size() > wireBytes) {
    const fields = runs.flatMap((r) => ['task', 'plan', 'outcome'].map((key) => ({ r, key })))
      .filter(({ r, key }) => !blocked.has(r.run_id + key) && Array.from(r[key]).length > (key === 'task' ? 256 : 1024));
    fields.sort((a, b) => Buffer.byteLength(b.r[b.key]) - Buffer.byteLength(a.r[a.key]));
    if (!fields.length) return null;
    const { r, key } = fields[0], previous = r[key];
    const cap = Math.max(key === 'task' ? 256 : 1024, Array.from(r[key]).length - 256);
    r[key] = key === 'task' ? Array.from(r[key]).slice(0, cap).join('') : fitProjection(JSON.parse(r[key]), cap);
    if (r[key] === previous) blocked.add(r.run_id + key);
    result.truncated = true;
  }
  return result;
}

export function listPipelineHistoryRuns(dataDir, projectId, chatId, { maxRuns = LIMITS.runs } = {}) {
  if (!idPattern.test(projectId) || !idPattern.test(chatId)) return { ids: [], unread: 0, truncated: false };
  try {
    dataDir = canonicalDirectory(path.resolve(dataDir));
    const root = regularPath(dataDir, `projects/${projectId}/chats/${chatId}/pipeline/runs`, true);
    const ids = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && idPattern.test(e.name)).map((e) => ({ name: e.name, mtime: fs.lstatSync(path.join(root, e.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    return { ids: ids.slice(0, maxRuns).map((e) => e.name), unread: Math.max(0, ids.length - maxRuns), truncated: ids.length > maxRuns };
  } catch (error) { return { ids: [], unread: 0, truncated: false, degraded: error.code !== 'ENOENT' }; }
}
