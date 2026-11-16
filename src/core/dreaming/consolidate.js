import { digest, HASH } from './storage.js';

export const OBSERVATION_TEXT = Object.freeze({
  'terminal:success': 'Recorded autonomous run completed successfully.',
  'terminal:partial': 'Recorded autonomous run completed with a partial outcome.',
  'terminal:failed': 'Recorded autonomous run ended with a failed outcome.',
  'terminal:aborted': 'Recorded autonomous run ended with an aborted outcome.',
  'attempt:passed': 'Recorded evaluated coding attempt passed required checks.',
  'attempt:failed': 'Recorded evaluated coding attempt failed required checks.'
});
export const ADAPTER_LIMITATIONS = Object.freeze({
  'legacy-attempts': 'Legacy history has no authoritative attempt replay.',
  'missing-attempts': 'Attempt metadata is unavailable.',
  'external-sources': 'External legacy sources are excluded.',
  'unavailable-sources': 'Some source artifacts are unavailable.',
  'malformed-history': 'Malformed histories are excluded.',
  'truncated-history': 'Truncated histories are excluded.',
  'ambiguous-chain': 'Ambiguous attempt chains are excluded.',
  'incomplete-chain': 'Incomplete chains are excluded.',
  'intervened-chain': 'Human-intervened chains are excluded.',
  'unverified-outcome': 'Unverified outcomes are excluded.',
  'unknown-outcome': 'Unknown terminal outcomes are excluded.'
});
export const OBJECTIVE = 'Q - 0.05*N + 0.02*N/max(1,rounds)';
export const LIMITS = 'Deterministic historical replay only; unseen continuations are unknown. Chain worlds can share a run and are not independent discovery worlds. No causal fixes, future execution, or wall-time savings inferred.';
const string = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f\x7f]/.test(s);
const sourcesKey = (sources) => JSON.stringify(sources);
const references = (episodes) => [...new Map(episodes.flatMap((e) => e.sources).map((s) => [s.path + ':' + s.sha256, s])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256));

export function freezeEpisodes(input, verify, time) {
  const episodes = [], counts = new Map(), seen = new Map();
  const exclude = (why) => counts.set(why, (counts.get(why) ?? 0) + 1);
  for (const raw of input) {
    if (!raw || !string(raw.id) || !string(raw.chatId) || !string(raw.runId) || !['team', 'pipeline'].includes(raw.engine) || !HASH.test(raw.taskHash) || typeof raw.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt)) || Date.parse(raw.observedAt) > time || !['success', 'partial', 'failed', 'aborted'].includes(raw.outcome) || typeof raw.complete !== 'boolean' || typeof raw.intervened !== 'boolean' || !Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 8 || raw.sources.some((s) => !s || typeof s.path !== 'string' || s.path.length > 240 || typeof s.sha256 !== 'string' || !HASH.test(s.sha256)) || !Array.isArray(raw.observations) || raw.observations.length > 16 || !Array.isArray(raw.attempts) || raw.attempts.length > 100) { exclude('invalid metadata or future observation'); continue; }
    if (!raw.complete || raw.intervened) { exclude(raw.intervened ? 'human intervention' : 'incomplete chain'); continue; }
    const sources = raw.sources.map((s) => ({ path: s.path, sha256: s.sha256 })).sort((a, b) => String(a.path).localeCompare(String(b.path)));
    if (!sources.every((source) => source.path.split('/')[3] === raw.chatId && verify(source))) { exclude('unavailable or changed source'); continue; }
    const observations = [...new Set(raw.observations.filter((o) => o?.verified === true && Object.hasOwn(OBSERVATION_TEXT, o.key) && (o.key.startsWith('terminal:') ? o.key === `terminal:${raw.outcome}` : raw.attempts.some((a) => a?.result === o.key.slice(8) && a.quality === (a.result === 'passed' ? 1 : 0)))).map((o) => o.key))].sort();
    const episode = { id: raw.id, engine: raw.engine, chatId: raw.chatId, runId: raw.runId, taskHash: raw.taskHash, observedAt: new Date(raw.observedAt).toISOString(), outcome: raw.outcome, complete: true, intervened: false, retryCeiling: raw.retryCeiling, ...(HASH.test(raw.cohort) ? { cohort: raw.cohort } : {}), sources, observations, attempts: raw.attempts.map((a) => ({ id: a?.id, scope: a?.scope, ordinal: a?.ordinal, result: a?.result, quality: a?.quality })) };
    const identity = `${episode.engine}:${episode.chatId}:${episode.runId}:${episode.id}`;
    const fingerprint = digest(JSON.stringify(episode));
    if (seen.has(identity)) { if (seen.get(identity) !== fingerprint) { exclude('ambiguous duplicate chain'); episodes.splice(0, episodes.length, ...episodes.filter((e) => e.identity !== identity)); seen.set(identity, null); } continue; }
    seen.set(identity, fingerprint); episodes.push({ ...episode, identity });
  }
  // Collapse aliases of the same sourced chain; different scopes remain replay chains.
  const unique = new Map();
  for (const e of recent(episodes)) {
    const key = `${e.engine}:${sourcesKey(e.sources)}:${JSON.stringify(e.attempts)}:${e.observations.join(',')}`;
    if (!unique.has(key)) unique.set(key, e);
  }
  if (unique.size > 256) counts.set('episode limit exceeded', unique.size - 256);
  return { episodes: [...unique.values()].slice(0, 256).sort((a, b) => a.identity.localeCompare(b.identity)), limitations: [...counts].map(([reason, count]) => `Excluded ${count}: ${reason}.`) };
}

const recent = (episodes) => [...episodes].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.identity.localeCompare(b.identity));
// Select whole episodes before scoring; never truncate proofs after evaluating extra worlds.
function evidenceWindow(episodes) {
  const included = [], sources = new Set();
  for (const episode of recent(episodes)) {
    const keys = episode.sources.map((s) => s.path + ':' + s.sha256);
    if (new Set([...sources, ...keys]).size > 24) continue;
    included.push(episode);
    for (const key of keys) sources.add(key);
  }
  return { included, excluded: episodes.length - included.length };
}

export function consolidate(episodes, time) {
  const groups = new Map();
  for (const e of episodes) for (const key of e.observations) {
    const group = `${e.engine}:${key}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(e);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, all]) => {
    const runs = new Set(), proofs = new Set(), independent = [];
    for (const episode of recent(all)) {
      const run = `${episode.chatId}:${episode.runId}`, proof = sourcesKey(episode.sources);
      if (runs.has(run) || proofs.has(proof)) continue;
      runs.add(run); proofs.add(proof); independent.push(episode);
    }
    const { included: items } = evidenceWindow(independent);
    const excludedEpisodes = all.length - items.length;
    const recallCount = items.length, uniqueQueries = new Set(items.map((e) => e.taskHash)).size;
    const days = new Set(items.map((e) => e.observedAt.slice(0, 10))).size;
    const signals = { relevance: 1, frequency: Math.min(1, recallCount / 3), taskDiversity: Math.min(1, uniqueQueries / 3), recency: Math.max(0, 1 - (time - Math.max(...items.map((e) => Date.parse(e.observedAt)))) / (30 * 86400000)), multiDayRecurrence: Math.min(1, days / 2), excludedEpisodes, richness: Math.min(1, items.reduce((sum, e) => sum + e.observations.length, 0) / items.length / 3), recallCount, uniqueQueries };
    const score = .30 * signals.relevance + .24 * signals.frequency + .15 * signals.taskDiversity + .15 * signals.recency + .10 * signals.multiDayRecurrence + .06 * signals.richness;
    const reasons = [];
    if (score < .65) reasons.push('score below 0.65');
    if (recallCount < 2) reasons.push('fewer than 2 distinct observations');
    if (uniqueQueries < 2) reasons.push('fewer than 2 original task digests');
    const sources = references(items);
    return { id: digest(key).slice(0, 24), text: `${key.split(':')[0] === 'team' ? 'Team' : 'Pipeline'}: ${OBSERVATION_TEXT[key.slice(key.indexOf(':') + 1)]}`, score, eligible: reasons.length === 0, reasons, signals, sources };
  });
}

// The cap policy observes only the current attempt, never a future outcome or chain length.
export function replayChain(world, cap) {
  let attempts = 0;
  for (const attempt of world.attempts) {
    attempts++;
    if (attempt.result === 'passed' || attempts >= cap) {
      const quality = attempt.quality, rounds = attempts;
      return { quality, attempts, rounds, score: quality - .05 * attempts + .02 * attempts / Math.max(1, rounds) };
    }
  }
  return null;
}

export function replay(episodes) {
  const cohorts = new Map(), limitations = [LIMITS];
  let excluded = 0;
  for (const e of episodes) {
    const a = e.attempts;
    const valid = HASH.test(e.cohort) && Number.isInteger(e.retryCeiling) && e.retryCeiling >= 1 && e.retryCeiling <= 100 && a.length > 0 && a.length <= e.retryCeiling && a.every((v, i) => string(v.id) && string(v.scope) && v.scope === a[0].scope && v.ordinal === i + 1 && ['passed', 'failed'].includes(v.result) && v.quality === (v.result === 'passed' ? 1 : 0) && (i === a.length - 1 || v.result === 'failed')) && new Set(a.map((v) => v.id)).size === a.length;
    if (!valid || (a.length < e.retryCeiling && a.at(-1).result !== 'passed')) { excluded++; continue; }
    const key = `${e.engine}:${e.retryCeiling}:${e.cohort}`;
    if (!cohorts.has(key) && cohorts.size >= 16) { excluded++; continue; }
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(e);
  }
  if (excluded) limitations.push(`Excluded ${excluded}: missing cohort, ambiguous or unknown attempt continuation, or cohort limit.`);
  const evaluations = [], recommendations = [], proofs = [];
  let worldCount = 0;
  for (const [key, all] of [...cohorts].sort(([a], [b]) => a.localeCompare(b))) {
    const { included: worlds, excluded: omitted } = evidenceWindow(all);
    worldCount += worlds.length;
    if (omitted) limitations.push(`Excluded ${omitted}: replay evidence window for ${key}.`);
    const [engine, rawCap, cohort] = key.split(':'), baselineCap = Number(rawCap);
    const baseline = worlds.map((w) => replayChain(w, baselineCap));
    const rows = [];
    for (const cap of [...new Set([baselineCap, ...Array.from({ length: Math.min(5, baselineCap) }, (_, i) => i + 1)])]) {
      const results = worlds.map((w) => replayChain(w, cap));
      const reasons = [];
      if (worlds.length < 3) reasons.push('fewer than 3 complete worlds in evidence cohort');
      if (results.some((r) => !r)) reasons.push('unknown continuation');
      if (results.some((r, i) => r && r.quality < baseline[i].quality)) reasons.push('per-world quality regression');
      const sum = (field) => results.reduce((n, r) => n + (r?.[field] ?? 0), 0);
      const row = { engine, cohort, cap, baselineCap, score: sum('score') / worlds.length, quality: sum('quality') / worlds.length, attempts: sum('attempts'), rounds: sum('rounds'), eligible: reasons.length === 0, reasons };
      rows.push(row); evaluations.push(row);
    }
    const incumbent = rows.find((r) => r.cap === baselineCap);
    const best = rows.filter((r) => r.eligible && r.cap < baselineCap && r.score > incumbent.score + 1e-12).sort((a, b) => b.score - a.score || b.cap - a.cap)[0];
    if (best) {
      const sources = references(worlds);
      recommendations.push({ engine, cohort, cap: best.cap, baselineCap, rationale: 'Same frozen cohort; strictly better objective, no per-world quality regression.' }); proofs.push({ engine, cohort, cap: best.cap, baselineCap, sources });
    }
  }
  return { replay: { objective: OBJECTIVE, worlds: worldCount, evaluations, recommendations, limitations }, proofs };
}
