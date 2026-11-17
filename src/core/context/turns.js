import { listContextRuns } from '../thread.js';
import { readRunLease } from '../run-lease.js';
import { listPipelineHistoryRuns, readPipelineHistoryJson } from '../pipeline-history.js';
import { LIMITS } from './limits.js';
import { PIPELINE_TERMINAL, isRelativeFile } from './shared.js';
import { redact as defaultRedact } from '../dreaming/reflection.js';

export const clip = (value, max) => {
  const s = typeof value === 'string' ? value.toWellFormed() : '';
  let end = Math.min(s.length, max);
  if (end && /[\uD800-\uDBFF]/.test(s[end - 1]) && /[\uDC00-\uDFFF]/.test(s[end] ?? '')) end--;
  return s.slice(0, end);
};
export const relativeFile = (value) => isRelativeFile(value) ? value.toWellFormed().replaceAll('\\', '/') : null;
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const array = (value) => Array.isArray(value) ? value : [];
export function readTurns({ dataDir, projectId, chat, activeRunId, since = null, inspect = false, sibling = false, maxRuns = LIMITS.runs, redact = defaultRedact, budget = { bytes: LIMITS.readBytes } }) {
  let rows, truncated, degraded = false, unread = 0;
  const clean = (value, cap) => clip(redact(typeof value === 'string' ? value : ''), cap);
  if (chat.engine !== 'pipeline') {
    const source = listContextRuns(chat.hiveDir, { maxRuns, activeRunId, excludeRoot: (inspect || sibling) && !activeRunId && Boolean(readRunLease(chat.hiveDir)), budget });
    rows = source.runs; truncated = source.truncated; unread = source.unread; degraded = source.degraded;
  } else {
    const source = listPipelineHistoryRuns(dataDir, projectId, chat.id, { maxRuns }); truncated = source.truncated; unread = source.unread;
    const scope = `projects/${projectId}/chats/${chat.id}/pipeline`;
    rows = []; degraded = Boolean(source.degraded);
    for (const [index, id] of source.ids.entries()) {
      if (id === activeRunId) continue;
      if (budget.exhausted) { unread += source.ids.length - index; truncated = true; break; }
      const read = (file) => readPipelineHistoryJson(dataDir, `${scope}/runs/${id}/${file}`, { budget });
      const status = read('status.json');
      if (!status && budget.exhausted) { unread += source.ids.length - index; truncated = true; break; }
      if (!PIPELINE_TERMINAL.includes(status?.status)) continue;
      const meta = read('run.json'), report = read('delivery/report.json'), plan = read('artifacts/plan.json'), reply = read('delivery/reply.json');
      const launch = !meta && readPipelineHistoryJson(dataDir, `${scope}/requests/${id}.json.launch.json`, { budget });
      if (budget.exhausted) { unread += source.ids.length - index; truncated = true; break; }
      rows.push({ id, engine: 'pipeline', startedAt: date(status.created_at), endedAt: date(status.updated_at), status: status.status,
        request: meta?.task ?? launch?.task ?? report?.task ?? status.task ?? 'Task unavailable',
        outcome: report?.failure?.message ?? status.failure?.message ?? report?.summary ?? (reply?.kind === 'answer' ? 'answered' : status.status),
        plan: array(plan?.steps).filter((s) => s && typeof s.title === 'string').map((s) => ({ title: s.title, status: 'historical' })),
        files: array(report?.changed_files).map((f) => f?.path), reply: reply && typeof reply.text === 'string' ? reply : null });
    }
  }
  const all = rows.sort((a, b) => (a.startedAt ?? a.id).localeCompare(b.startedAt ?? b.id) || a.id.localeCompare(b.id)).map((r, i) => ({
    id: r.id.toWellFormed(), engine: r.engine, index: unread + i + 1, startedAt: date(r.startedAt), endedAt: date(r.endedAt), status: r.status,
    request: clean(r.request, LIMITS.request), outcome: clean(r.outcome, LIMITS.outcome).replace(/[\r\n\u2028\u2029]+/g, ' '),
    plan: array(r.plan).slice(0, LIMITS.plan).map((s) => ({ title: clean(s.title, LIMITS.planLine), status: clean(s.status, 80) })),
    files: [...new Set(array(r.files).map((f) => relativeFile(redact(typeof f === 'string' ? f : ''))).filter(Boolean))].slice(0, LIMITS.files),
    reply: r.reply ? { kind: clean(r.reply.kind, 40), text: clean(r.reply.text, LIMITS.reply), truncated: Boolean(r.reply.truncated || r.reply.text.length > LIMITS.reply) } : null
  }));
  degraded ||= Boolean(budget.degraded);
  const total = all.length + unread;
  if (since && all[0]?.startedAt && Date.parse(all[0].startedAt) <= Date.parse(since)) unread = 0;
  const turns = since ? all.filter((r) => r.startedAt && Date.parse(r.startedAt) > Date.parse(since)) : all;
  return { turns, total, unread, truncated, degraded };
}
