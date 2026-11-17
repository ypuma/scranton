export const LIMITS = Object.freeze({
  team: 23900, teamAccepted: 24000, developer: 3900, developerAccepted: 4000, developerNotes: 1500, developerTurns: 6,
  notes: 16000, notesBytes: 65536, recent: 4, request: 32768, reply: 16000,
  latestRequest: 2000, olderRequest: 800, latestReply: 6000, olderReply: 1500,
  outcome: 300, latestPlan: 3000, olderPlan: 1200, latestFiles: 1500, olderFiles: 600, minRequest: 500,
  plan: 32, planLines: 24, planLine: 200, files: 30, condensedFiles: 6,
  condensed: 300, pipelineLine: 240, condensedRequest: 160, condensedOutcome: 200,
  earlier: 4000, otherChats: 6, otherTurns: 3, other: 3000, siblings: 12,
  memory: 2000, pipelineNotes: 2000, pipelineEarlier: 16, pipelineBytes: 32768,
  pipelineContextBytes: 8000, siblingRuns: 4, readBytes: 67108864, pipelinePromptBytes: 4000, pipelinePromptDivisor: 32, runs: 500,
  settingsBytes: 65536, window: 128000, percentMin: 1, percentMax: 50, tokensMin: 1000, tokensMax: 200000, overrides: 32, budgetMin: 256, budgetMax: 200000, briefMin: 250, briefMax: 2000,
  teamCeiling: 800000, developerCeiling: 8000, enginePromptBytes: 200000, pipelineHistoryFloor: 12000, pipelineContextFloor: 4000,
  pipelineEarlierMax: 64, pipelineNotesMax: 16000, pipelineBytesMax: 262144, pipelineContextBytesMax: 65536
});

export const DEFAULT_BUDGET = Object.freeze({ mode: 'percent', value: 10 });
export const UNKNOWN_RECIPIENT = Object.freeze({ id: null, window: LIMITS.window, known: false });
export function budgetFor(settings = {}, recipient = UNKNOWN_RECIPIENT) {
  const model = recipient.id !== null && Object.hasOwn(settings.models ?? {}, recipient.id);
  const rule = (model ? settings.models[recipient.id] : settings.budget) ?? DEFAULT_BUDGET;
  const raw = rule.mode === 'percent' ? Math.floor(recipient.window * rule.value / 100) : rule.value;
  const ceiling = Math.min(LIMITS.budgetMax, Math.floor(recipient.window / 2));
  const tokens = Math.max(LIMITS.budgetMin, Math.min(raw, ceiling));
  return { tokens, mode: rule.mode, value: rule.value, source: model ? 'model' : 'project',
    capped: tokens === raw ? null : tokens === LIMITS.budgetMin ? 'min' : ceiling === LIMITS.budgetMax ? 'max' : 'window' };
}
export function briefFor(settings, recipient) {
  const B = budgetFor(settings, recipient).tokens;
  return Math.min(B, Math.max(LIMITS.briefMin, Math.min(LIMITS.briefMax, Math.floor(B / 10))));
}
export function pipelineAllowance(settings, planner) {
  const budget = budgetFor(settings, planner), B = budget.tokens;
  const historyBytes = Math.max(LIMITS.pipelineHistoryFloor, Math.min(3 * B, Math.floor(LIMITS.enginePromptBytes / 4)));
  const contextBytes = Math.max(LIMITS.pipelineContextFloor, Math.min(B, Math.floor(LIMITS.enginePromptBytes / 8)));
  return { historyBytes, contextBytes, ...budget, tokens: Math.floor((historyBytes + contextBytes) / 4),
    capped: historyBytes + contextBytes !== 4 * B ? 'engine' : budget.capped };
}
export function scaledLimits(U = LIMITS.team, Udev = LIMITS.developer) {
  const scaled = { ...LIMITS, team: U, developer: Udev };
  for (const key of ['latestRequest', 'latestReply', 'latestPlan', 'latestFiles', 'olderRequest', 'olderReply', 'olderPlan', 'olderFiles', 'minRequest', 'earlier', 'other', 'memory']) scaled[key] = Math.floor(LIMITS[key] * U / LIMITS.team);
  scaled.recent = Math.max(1, Math.min(12, Math.floor(LIMITS.recent * U / LIMITS.team)));
  scaled.developerNotes = Math.floor(LIMITS.developerNotes * Udev / LIMITS.developer);
  scaled.developerTurns = Math.max(3, Math.min(12, Math.floor(LIMITS.developerTurns * Udev / LIMITS.developer)));
  return scaled;
}
