import fs from 'node:fs';
import path from 'node:path';

const terminal = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const array = (v) => Array.isArray(v) ? v : [];
const string = (v) => typeof v === 'string' ? v : '';
const strings = (v) => array(v).filter((s) => typeof s === 'string').slice(0, 32);
const MAX_ARTIFACT = 256 * 1024;

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

export function readPipelineHistoryJson(base, rel) {
  let fd;
  try {
    const file = regularPath(base, rel);
    if (fs.statSync(file).size > MAX_ARTIFACT) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT) return null;
    const buffer = Buffer.alloc(MAX_ARTIFACT + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_ARTIFACT) return null;
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    return object(value) ? value : null;
  } catch { return null; }
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

export function buildPipelineHistory({ dataDir, projectId, chatId, redact = (text) => text }) {
  if (!idPattern.test(projectId) || !idPattern.test(chatId)) return null;
  const scope = `projects/${projectId}/chats/${chatId}/pipeline`;
  const read = (rel) => readPipelineHistoryJson(dataDir, `${scope}/${rel}`);
  let ids;
  try { ids = fs.readdirSync(regularPath(dataDir, `${scope}/runs`, true)).filter((id) => idPattern.test(id)); }
  catch { return null; }
  let truncated = false;
  const text = (value, cap) => {
    const clean = redact(typeof value === 'string' ? value : '').replace(/\b[A-Za-z]:[\\/][^\s"<>]+|\\\\[^\s"<>]+|\/(?:Users|home|tmp|private|var|mnt)\/[^\s"<>]+/g, '[private path]')
      .replace(/(^|[\s"'(=])\/[^\s"<>]+/g, '$1[private path]')
      .replace(/\b[a-f0-9]{64}\b|\b[EKH]-[a-f0-9]{10}\b/gi, '[historical reference]');
    const chars = Array.from(clean);
    if (chars.length > cap) truncated = true;
    return chars.slice(0, cap).join('');
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
    if (!s || !terminal.has(s.status)) return [];
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
  if (!selected.length) return null;
  const runs = selected.map((c) => {
    const meta = read(`runs/${c.id}/run.json`), report = read(`runs/${c.id}/delivery/report.json`);
    const launch = !meta && read(`requests/${c.id}.json.launch.json`);
    const plan = c.plan ?? projectPlan(c);
    return { run_id: c.id, status: c.status.status,
      task: text(meta?.task ?? launch?.task ?? report?.task ?? c.status.task ?? 'Task unavailable', 4000), plan,
      outcome: fitProjection(outcomeProjection(c.status, report, read(`runs/${c.id}/delivery/reply.json`), Boolean(plan)), 4000) };
  });
  const result = { schema: 1, runs, truncated };
  const size = () => Buffer.byteLength(JSON.stringify(result));
  // Keep the latest plan/task and latest outcome before older conversational entries.
  while (size() > 32768 && runs.length > 1) {
    const index = runs.findIndex((r, i) => r.run_id !== anchor?.id && i !== runs.length - 1);
    if (index < 0) break;
    runs.splice(index, 1); result.truncated = true;
  }
  while (size() > 32768) {
    const fields = runs.flatMap((r) => ['task', 'plan', 'outcome'].map((key) => ({ r, key })))
      .filter(({ r, key }) => Array.from(r[key]).length > (key === 'task' ? 256 : 1024));
    fields.sort((a, b) => Buffer.byteLength(b.r[b.key]) - Buffer.byteLength(a.r[a.key]));
    const { r, key } = fields[0];
    const cap = Math.max(key === 'task' ? 256 : 1024, Array.from(r[key]).length - 256);
    r[key] = key === 'task' ? Array.from(r[key]).slice(0, cap).join('') : fitProjection(JSON.parse(r[key]), cap);
    result.truncated = true;
  }
  return result;
}
