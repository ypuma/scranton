import { emptyUsage, foldUsage } from './usage.js';

export function pipelineUsage(status, calls, ledger = []) {
  const u = emptyUsage(status.created_at ?? null);
  // Reservations are budgets, not usage; ledger order is not completion order.
  const rows = calls.length ? calls : ledger.filter(row => row.reserved !== true).map(row => ({ ...row, ts: null }));
  let priced = true;
  for (const row of rows) {
    const cost = typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : null;
    priced &&= cost !== null;
    foldUsage(u, row.role ?? 'unknown', { input: row.input_tokens, output: row.output_tokens, cost }, row.ts ?? null);
    if (!priced) { const point = u.series.at(-1); point.cost = null; for (const value of Object.values(point.byAgent)) value.cost = null; }
  }
  if (!rows.length || !priced) { u.cost = null; for (const a of Object.values(u.byAgent)) a.cost = null; }
  const estimate = status.usage?.estimated_cost;
  if (!ledger.some(row => row.reserved === true) && status.usage?.calls === u.calls && status.usage?.input_tokens === u.input && status.usage?.output_tokens === u.output && typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0) { u.cost = estimate; u.estimated = true; }
  return u;
}

export function pipelineSteps(status, events, plan, report) {
  const normalize = id => typeof id === 'string' && id.startsWith('step:') && !plan?.steps?.some(s => s.id === id) ? id.slice(5) : id;
  if (Array.isArray(report?.steps)) return { stepsDone: [...new Set(report.steps.map(s => s.step_id).filter(id => typeof id === 'string' && id.startsWith('step:')).map(normalize))], stepsDoneExact: true };
  const done = [], add = id => { id = normalize(id); if (typeof id === 'string' && id && !done.includes(id)) done.push(id); };
  let scope = null, merged = [];
  for (const e of events) {
    const d = e.data ?? {};
    // procedure is emitted before every implementer turn, even with guidance disabled.
    if (e.type === 'procedure' && d.role === 'implementer' && !d.lane) scope = d.scope?.startsWith('step:') ? d.scope : null;
    if (e.type === 'wave_merged') { merged = Array.isArray(d.merged) ? d.merged : []; scope = null; }
    if (e.type === 'replanned') { scope = null; merged = []; }
    if (e.type === 'route' && !d.lane && d.from === 'verify') {
      if (d.to === 'select_step') { if (merged.length) merged.forEach(add); else if (scope) add(scope); merged = []; scope = null; }
      else if (['replan', 'finalize'].includes(d.to)) { merged = []; scope = null; }
    }
  }
  return { stepsDone: done, stepsDoneExact: done.length === status.progress?.steps_done };
}
