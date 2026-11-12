export const amount = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
export const emptyUsage = (startedAt = null) => ({ input: 0, output: 0, cost: 0, tokens: 0, calls: 0, startedAt, byAgent: {}, series: [] });

export function foldUsage(usage, agent, delta, ts, calls = 1) {
  const u = usage;
  const a = u.byAgent[agent] ??= { input: 0, output: 0, cost: 0, tokens: 0, calls: 0 };
  for (const key of ['input', 'output', 'cost']) { const n = amount(delta?.[key]); u[key] += n; a[key] += n; }
  u.tokens = u.input + u.output; a.tokens = a.input + a.output;
  u.calls += calls; a.calls += calls; u.startedAt ??= ts;
  u.series.push({ ts, tokens: u.tokens, cost: u.cost, byAgent: Object.fromEntries(Object.entries(u.byAgent).map(([id, x]) => [id, { tokens: x.tokens, cost: x.cost }])) });
  if (u.series.length > 120) u.series = u.series.filter((_, i, points) => i % 2 === 0 || i === points.length - 1);
  return u;
}

export function messageUsage(message) {
  if (!message?.usage) return null;
  const u = message.usage;
  return { input: amount(u.input), output: amount(u.output), cost: amount(u.cost?.total),
    ...(u.cacheRead !== undefined ? { cacheRead: amount(u.cacheRead) } : {}), ...(u.cacheWrite !== undefined ? { cacheWrite: amount(u.cacheWrite) } : {}) };
}
