// Pure logic of the Dreams drawer (.enma/dreaming-contract.md): the project's dreaming status document, what each
// part of it says, the settings request and its checks. No DOM, so Node can test it. Preview, sweep and the retry
// replay are a deterministic offline consolidation of recorded, verified run outcomes and never call a model. Model
// reflection (the claude-code-dreaming plan) is separate: one explicit provider request whose answer is only a
// proposal until the human applies it.
import { stripBidi } from './format.js';
import { clip, responseError } from './control.js';
import { PROJECT_ID_RE } from './scope.js';
import { modelKey, parseModelKey } from './accounts.js';

export const INTERVAL_MIN = 15;
export const INTERVAL_MAX = 10080;
export const INTERVAL_DEFAULT = 360;
// the poll of an open drawer while the server reports the project busy
export const BUSY_POLL_MS = 3000;
// the replay needs this many complete recorded chains before it recommends anything
export const MIN_WORLDS = 3;
export const ACTIONS = ['preview', 'sweep', 'settings', 'rollback', 'propose', 'proposal', 'proposal/apply', 'proposal/reject', 'cancel'];
// model reflection: the settings ranges and the fixed request bounds the server enforces
export const TOKENS_MIN = 256;
export const TOKENS_MAX = 4096;
export const TOKENS_DEFAULT = 2048;
export const TIMEOUT_MIN = 10;
export const TIMEOUT_MAX = 60;
export const TIMEOUT_DEFAULT = 60;
export const INPUT_MAX_CHARS = 12000;
export const RUNS_MAX = 4;
export const RUN_EXCERPT_MAX = 1000;
export const COMPLETION_MAX_CHARS = 4096;
// while a reflection job runs, the open drawer reads the status this often
export const REFLECT_POLL_MS = 1500;
export const REFLECT_STATES = ['idle', 'running', 'ready', 'failed', 'cancelled'];
export const OP_ACTIONS = ['add', 'replace', 'remove'];
export const OP_LABEL = { add: 'Add', replace: 'Replace', remove: 'Remove' };
export const NOTE_TYPES = ['user', 'feedback', 'project', 'reference'];
export const NOTE_LABEL = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };
// who a quote comes from: only an outcome is something the recorded run verified
export const EVIDENCE_LABEL = { user: 'User said', assistant: 'Assistant reported, not verified', outcome: 'Recorded outcome' };
export const PHASES = ['light', 'rem', 'deep'];
export const PHASE_LABEL = { light: 'Light', rem: 'REM', deep: 'Deep' };
export const PHASE_NOTE = {
  light: 'Deduplicates verified run outcomes by their source',
  rem: 'Groups outcomes that recur',
  deep: 'Scores each group and promotes the ones that pass every gate',
};
// the Deep phase weights; any other signal is a count and shown as one
export const SIGNALS = [
  ['relevance', 'Relevance', 0.30], ['frequency', 'Frequency', 0.24], ['taskDiversity', 'Task diversity', 0.15],
  ['recency', 'Recency', 0.15], ['multiDayRecurrence', 'Multi-day recurrence', 0.10], ['richness', 'Richness', 0.06],
];
export const COUNT_LABEL = { recallCount: 'Observations', uniqueQueries: 'Distinct tasks' };
export const ENGINE_LABEL = { team: 'Team', pipeline: 'Pipeline' };
export const SINGLE_NOTE = 'Dreams need the project registry. This server serves a single project, so it has no Dreams.';
export const DEMO_NOTE = 'The demo has no project, so it has no Dreams.';

const LIST_MAX = 200;
const SOURCES_MAX = 24;
const TEXT_MAX = 1000;
const LINE_MAX = 300;
const HASH_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const str = (v, max = LINE_MAX) => (typeof v === 'string' ? clip(stripBidi(v), max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const arr = (v, max = LIST_MAX) => (Array.isArray(v) ? v.slice(0, max) : []);
const lines = (v, max = 64) => arr(v, max).map((x) => str(x)).filter(Boolean);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// the evaluator recipe (gates and checks) a replay cohort was recorded under; two recipes never share a policy
const cohortOf = (v) => (typeof v === 'string' && HASH_RE.test(v) ? v : '');
export const cohortLabel = (c) => (c ? `cohort ${c.slice(0, 8)}` : 'cohort unknown');
export const sameCohort = (a, b) => a.engine === b.engine && a.cohort === b.cohort;

export function dreamingUrl(projectId, action = '') {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return null;
  if (action && !ACTIONS.includes(action)) return null;
  return `/api/projects/${projectId}/dreaming${action ? `/${action}` : ''}`;
}

function parseSources(v) {
  return arr(v, SOURCES_MAX).map((s) => {
    const o = obj(s);
    const path = str(o?.path, 240);
    if (!path) return null;
    return { path, sha256: typeof o.sha256 === 'string' && HASH_RE.test(o.sha256) ? o.sha256 : '' };
  }).filter(Boolean);
}

function parseSignals(v) {
  const o = obj(v) ?? {};
  const out = {};
  for (const [k, value] of Object.entries(o).slice(0, 16)) if (KEY_RE.test(k) && num(value) !== null) out[k] = value;
  return out;
}

// -> the status document as the drawer shows it, or null for anything that is not a v1 document of this project
// (a reply for another project included)
export function parseDreaming(doc, projectId) {
  const d = obj(doc);
  if (!d || d.v !== 1 || d.projectId !== projectId) return null;
  const c = obj(d.counts) ?? {};
  const byName = new Map(arr(d.phases, 8).map(obj).filter((p) => p && PHASES.includes(p.name)).map((p) => [p.name, p]));
  const replay = obj(d.replay) ?? {};
  const interval = Number.isInteger(d.intervalMinutes) && d.intervalMinutes >= INTERVAL_MIN && d.intervalMinutes <= INTERVAL_MAX ? d.intervalMinutes : INTERVAL_DEFAULT;
  return {
    projectId,
    enabled: d.enabled === true,
    applyPolicy: d.applyPolicy === true,
    intervalMinutes: interval,
    state: ['idle', 'busy', 'error'].includes(d.state) ? d.state : 'error',
    lastSweepAt: iso(d.lastSweepAt),
    nextSweepAt: iso(d.nextSweepAt),
    canRollback: d.canRollback === true,
    counts: { episodes: count(c.episodes), candidates: count(c.candidates), promoted: count(c.promoted), worlds: count(c.worlds) },
    phases: PHASES.map((name) => {
      const p = byName.get(name);
      return { name, status: p ? str(p.status, 80) : '', count: p ? count(p.count) : 0, known: Boolean(p) };
    }),
    memory: arr(d.memory).map(obj).filter((m) => m && str(m.text)).map((m) => ({
      id: str(m.id, 64), text: str(m.text, TEXT_MAX), score: num(m.score), sources: parseSources(m.sources), promotedAt: iso(m.promotedAt),
    })),
    candidates: arr(d.candidates).map(obj).filter((m) => m && str(m.text)).map((m) => ({
      id: str(m.id, 64), text: str(m.text, TEXT_MAX), score: num(m.score), eligible: m.eligible === true,
      reasons: lines(m.reasons, 16), signals: parseSignals(m.signals), sources: parseSources(m.sources),
    })),
    replay: {
      objective: str(replay.objective, 160),
      worlds: count(replay.worlds),
      evaluations: arr(replay.evaluations).map(obj).filter((e) => e && ENGINE_LABEL[e.engine] && Number.isInteger(e.cap)).map((e) => ({
        engine: e.engine, cohort: cohortOf(e.cohort), cap: e.cap, baselineCap: Number.isInteger(e.baselineCap) ? e.baselineCap : null,
        score: num(e.score), quality: num(e.quality), attempts: count(e.attempts), rounds: count(e.rounds),
        eligible: e.eligible === true, reasons: lines(e.reasons, 16),
      })),
      recommendations: arr(replay.recommendations, 16).map(obj).filter((r) => r && ENGINE_LABEL[r.engine] && Number.isInteger(r.cap) && Number.isInteger(r.baselineCap)).map((r) => ({
        engine: r.engine, cohort: cohortOf(r.cohort), cap: r.cap, baselineCap: r.baselineCap, rationale: str(r.rationale),
      })),
      limitations: lines(replay.limitations),
    },
    diary: arr(d.diary, 64).map(obj).filter((x) => x && str(x.text)).map((x) => ({
      id: str(x.id, 64), at: iso(x.at), text: str(x.text, TEXT_MAX), promoted: count(x.promoted),
    })),
    limitations: lines(d.limitations),
    preview: d.preview === true,
    // an older server has no reflection: its section and settings stay hidden and nothing of it is sent
    reflectionSupported: obj(d.reflection) !== null,
    reflectionEnabled: d.reflectionEnabled === true,
    reflectionModel: modelRef(d.reflectionModel) ? d.reflectionModel : null,
    reflectionMaxOutputTokens: inRange(d.reflectionMaxOutputTokens, TOKENS_MIN, TOKENS_MAX) ? d.reflectionMaxOutputTokens : TOKENS_DEFAULT,
    reflectionTimeoutSeconds: inRange(d.reflectionTimeoutSeconds, TIMEOUT_MIN, TIMEOUT_MAX) ? d.reflectionTimeoutSeconds : TIMEOUT_DEFAULT,
    reflection: parseReflection(d.reflection),
  };
}

const inRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// 'provider/model' (the settings' reflectionModel) -> { provider, model } or null; a model id may hold slashes
export function modelRef(v) {
  if (typeof v !== 'string' || v.length > 300) return null;
  const i = v.indexOf('/');
  const provider = v.slice(0, i), model = v.slice(i + 1);
  return i > 0 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider) && model.trim() ? { provider, model } : null;
}

export const refKey = (ref) => (ref ? modelKey(ref.provider, ref.model) : '');
export const refText = (ref) => (ref ? `${stripBidi(ref.provider)}/${stripBidi(ref.model)}` : '');

// a provider of GET /api/models that lists the model and is signed in
export function modelAvailable(catalog, choice) {
  const p = catalog?.providers?.find((q) => q.id === choice?.provider);
  return Boolean(p?.signedIn && p.models.some((m) => m.id === choice.model));
}

// Model text is shown in full or not applied at all: a string over its bound marks the proposal incomplete rather
// than being cut, so what Apply sends is always what the drawer showed.
function full(v, max, missing) {
  if (typeof v !== 'string') return '';
  if (v.length > max) missing.cut = true;
  return stripBidi(v).slice(0, max);
}

function parseEvidence(v, missing) {
  if (v !== undefined && !Array.isArray(v)) missing.cut = true;
  if (Array.isArray(v) && v.length > 8) missing.cut = true;
  return arr(v, 8).map((x) => {
    const o = obj(x);
    if (!o || !EVIDENCE_LABEL[o.role] || typeof o.quote !== 'string' || !o.quote) {
      missing.cut = true;
      return null;
    }
    return {
      signalId: str(o.signalId, 128), quote: full(o.quote, RUN_EXCERPT_MAX, missing), role: o.role, at: iso(o.at),
      path: str(o.path, 240), sha256: typeof o.sha256 === 'string' && HASH_RE.test(o.sha256) ? o.sha256 : '',
    };
  }).filter(Boolean);
}

// a generated note: in an operation's before/after and in the accepted list
function parseNote(v, missing) {
  const o = obj(v);
  if (!o || (typeof o.text !== 'string' && typeof o.title !== 'string')) {
    missing.cut = true;
    return null;
  }
  return {
    id: str(o.id, 128), type: NOTE_TYPES.includes(o.type) ? o.type : '', title: full(o.title, 200, missing), text: full(o.text, TEXT_MAX, missing),
    // the server stamps a note when the model proposes it and records no apply time
    createdAt: iso(o.createdAt), evidence: parseEvidence(o.evidence, missing), sources: parseSources(o.sources),
  };
}

function parseUsage(v) {
  const o = obj(v);
  if (!o) return null;
  const tokens = (x) => (Number.isInteger(x) && x >= 0 ? x : null);
  const u = { inputTokens: tokens(o.inputTokens), outputTokens: tokens(o.outputTokens), costUsd: num(o.costUsd) !== null && o.costUsd >= 0 ? o.costUsd : null };
  return u.inputTokens === null && u.outputTokens === null && u.costUsd === null ? null : u;
}

function parseOperation(v, missing) {
  const o = obj(v);
  if (!o || !OP_ACTIONS.includes(o.action)) {
    missing.cut = true;
    return null;
  }
  if (Array.isArray(o.before) && o.before.length > 16) missing.cut = true;
  const after = o.after === null || o.after === undefined ? null : parseNote(o.after, missing);
  if (o.action !== 'remove' && !after) missing.cut = true;
  return {
    action: o.action, targetIds: lines(o.targetIds, 16), type: NOTE_TYPES.includes(o.type) ? o.type : '',
    title: full(o.title, 200, missing), text: full(o.text, TEXT_MAX, missing), reason: full(o.reason, TEXT_MAX, missing),
    evidence: parseEvidence(o.evidence, missing), before: arr(o.before, 16).map((n) => parseNote(n, missing)).filter(Boolean), after,
  };
}

function parseProposal(v) {
  const o = obj(v);
  if (!o || typeof o.id !== 'string' || !o.id || o.id.length > 128) return null;
  const missing = { cut: false };
  if (!Array.isArray(o.operations) || o.operations.length > 12) missing.cut = true;
  const model = typeof o.model === 'string' ? stripBidi(o.model).slice(0, 300) : obj(o.model) ? refText({ provider: str(o.model.provider, 64), model: str(o.model.model, 200) }) : '';
  const operations = arr(o.operations, 12).map((x) => parseOperation(x, missing)).filter(Boolean);
  return {
    id: o.id, createdAt: iso(o.createdAt), model, summary: full(o.summary, 2000, missing), operations, usage: parseUsage(o.usage),
    complete: !missing.cut,
  };
}

// status.reflection -> what the drawer shows, or null when the server has none (an older server)
export function parseReflection(v) {
  const r = obj(v);
  if (!r) return null;
  const missing = { cut: false };
  return {
    // a state this page does not know reads as failed, never as idle or ready
    state: REFLECT_STATES.includes(r.state) ? r.state : 'failed',
    jobId: str(r.jobId, 128), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt),
    error: str(r.error, 600) || (REFLECT_STATES.includes(r.state) ? '' : 'The server reported a reflection state this page does not know.'),
    usage: parseUsage(r.usage), proposal: parseProposal(r.proposal),
    memory: arr(r.memory, 64).map((n) => parseNote(n, missing)).filter(Boolean),
    limitations: lines(r.limitations),
  };
}

export const score = (v) => (v === null ? '-' : v.toFixed(2));
export const shortHash = (h) => (h ? h.slice(0, 12) : 'no digest');

// the incumbent of an engine's cohort: the cap its runs were configured with
export function isIncumbent(e, recommendations = []) {
  if (e.baselineCap !== null) return e.cap === e.baselineCap;
  return recommendations.some((r) => sameCohort(r, e) && r.baselineCap === e.cap);
}

export function isRecommended(e, recommendations = []) {
  return recommendations.some((r) => sameCohort(r, e) && r.cap === e.cap && (e.baselineCap === null || r.baselineCap === e.baselineCap));
}

// -> how many distinct engine + recipe cohorts the comparisons cover
export function cohortCount(evaluations) {
  return new Set(evaluations.map((e) => `${e.engine}:${e.cohort}`)).size;
}

export function countsText(c) {
  return [
    `${c.episodes} recorded ${c.episodes === 1 ? 'chain' : 'chains'}`, `${c.candidates} ${c.candidates === 1 ? 'candidate' : 'candidates'}`,
    `${c.promoted} promoted`, `${c.worlds} replay ${c.worlds === 1 ? 'world' : 'worlds'}`,
  ].join(' · ');
}

// sweeping: this window posted a sweep that has not answered yet. A busy status names no cause (a running chat, one
// that needs recovery and a closing server read the same), so it never claims a sweep. -> [label, tone]
export function stateBadge(d, { preview = false, sweeping = false } = {}) {
  if (sweeping) return ['Sweeping', 'on'];
  if (preview) return ['Preview', 'loud'];
  if (d.state === 'busy' && d.reflection?.state === 'running') return ['Generating', 'on'];
  if (d.state === 'busy') return ['Project busy', 'on'];
  if (d.state === 'error') return ['Error', 'loud'];
  return ['Idle', 'quiet'];
}

// a running reflection job is itself reported as busy; the server still lets the read-only Preview through then
export function stateText(d) {
  if (d.state === 'busy' && d.reflection?.state === 'running') return 'The server reports this project as busy while a reflection proposal is generated. Preview still works because it saves nothing; everything that saves waits until generation ends.';
  if (d.state === 'busy') return 'The server reports this project as busy and gave no reason. A running chat, or one that needs recovery, keeps a project busy. Preview, Run sweep, Roll back, Save settings and model reflection wait until it is idle again.';
  if (d.state === 'error') return 'The server reports dreaming for this project in an error state. Saved memory is shown as stored.';
  return '';
}

export function scheduleText(d, fmt) {
  if (!d.enabled) return 'Automatic sweeps are off.';
  const every = `every ${intervalText(d.intervalMinutes)} while the project is idle`;
  return d.nextSweepAt ? `Automatic sweeps ${every}; next one ${fmt(d.nextSweepAt)}.` : `Automatic sweeps ${every}; the first one waits for an idle project.`;
}

export function intervalText(min) {
  if (min % 1440 === 0) return `${min / 1440} ${min === 1440 ? 'day' : 'days'}`;
  if (min % 60 === 0) return `${min / 60} ${min === 60 ? 'hour' : 'hours'}`;
  return `${min} minutes`;
}

export function replaySummary(r) {
  if (!r.worlds) return 'No complete recorded attempt chain to replay yet.';
  const n = cohortCount(r.evaluations);
  const split = n > 1 ? ` They form ${n} separate cohorts (engine and check recipe); each is compared only with itself.` : '';
  const base = `${r.worlds} recorded ${r.worlds === 1 ? 'world' : 'worlds'} replayed without running anything.${split}`;
  return r.worlds < MIN_WORLDS ? `${base} A recommendation needs at least ${MIN_WORLDS} complete chains of one engine, check recipe and retry limit.` : base;
}

export function recommendationText(r, applyPolicy) {
  const what = `${ENGINE_LABEL[r.engine]}, ${cohortLabel(r.cohort)}: retry limit ${r.baselineCap} could be ${r.cap}.`;
  if (!applyPolicy) return `${what} Not applied: applying recommendations is off.`;
  if (!r.cohort) return `${what} Not applied: no check recipe cohort was reported, so no run can match it.`;
  // the server applies it only to an exact engine + configured limit + cohort match whose sources still verify
  return `${what} Applying recommendations is on, so a new ${ENGINE_LABEL[r.engine]} run may start with ${r.cap}, but only if its configured limit is ${r.baselineCap}, its check recipe matches this cohort and the recorded sources still verify; otherwise it keeps its own limit. It never raises a limit.`;
}

const whole = (v, digits, min, max) => {
  const raw = String(v ?? '').trim();
  return new RegExp(`^\\d{1,${digits}}$`).test(raw) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : null;
};

// form: { enabled, applyPolicy, interval (the text typed), and with a reflection server reflectionEnabled, model (a
// select value), tokens, timeout } -> { body } with what changed, or { error, field }. catalog: GET /api/models, to
// refuse a newly picked model that is not signed in.
export function buildSettings(form, saved, catalog = null) {
  const interval = whole(form.interval, 5, INTERVAL_MIN, INTERVAL_MAX);
  if (interval === null) return { error: `The interval is a whole number of minutes from ${INTERVAL_MIN} to ${INTERVAL_MAX}.`, field: 'interval' };
  const next = { enabled: form.enabled === true, intervalMinutes: interval, applyPolicy: form.applyPolicy === true };
  if (saved?.reflectionSupported) {
    const tokens = whole(form.tokens ?? saved.reflectionMaxOutputTokens, 4, TOKENS_MIN, TOKENS_MAX);
    if (tokens === null) return { error: `Output tokens are a whole number from ${TOKENS_MIN} to ${TOKENS_MAX}.`, field: 'tokens' };
    const timeout = whole(form.timeout ?? saved.reflectionTimeoutSeconds, 2, TIMEOUT_MIN, TIMEOUT_MAX);
    if (timeout === null) return { error: `The time limit is a whole number of seconds from ${TIMEOUT_MIN} to ${TIMEOUT_MAX}.`, field: 'timeout' };
    const choice = form.model === undefined ? modelRef(saved.reflectionModel) : parseModelKey(form.model);
    const model = choice ? `${choice.provider}/${choice.model}` : null;
    if (model !== saved.reflectionModel && choice && catalog && !modelAvailable(catalog, choice)) {
      return { error: 'That model is not signed in or not offered any more. Pick another one.', field: 'model' };
    }
    const auto = form.reflectionEnabled === undefined ? saved.reflectionEnabled : form.reflectionEnabled === true;
    if (auto && !model) return { error: 'Automatic reflection needs a model. Pick one, or turn automatic reflection off.', field: 'model' };
    Object.assign(next, { reflectionEnabled: auto, reflectionModel: model, reflectionMaxOutputTokens: tokens, reflectionTimeoutSeconds: timeout });
  }
  const body = {};
  for (const k of Object.keys(next)) if (!saved || next[k] !== saved[k]) body[k] = next[k];
  return { body };
}

export function reflectBadge(r) {
  if (r.state === 'running') return ['Generating', 'on'];
  if (r.state === 'ready') return ['Proposal ready', 'loud'];
  if (r.state === 'failed') return ['Failed', 'loud'];
  if (r.state === 'cancelled') return ['Cancelled', 'quiet'];
  return ['No proposal', 'quiet'];
}

export function reflectNote(r) {
  if (r.state === 'running') return 'A provider request is on its way. Run sweep, Roll back, Save settings and Apply wait until it ends. Cancel stops it and saves nothing.';
  if (r.state === 'failed') return `Generation failed: ${r.error || 'the server gave no reason'}. Nothing was saved.`;
  if (r.state === 'cancelled') return 'Generation was cancelled. Nothing was saved.';
  return '';
}

const n = (v) => v.toLocaleString('en-US');

// the provider's own numbers or nothing; a cost is never estimated here
export function usageText(u) {
  if (!u) return 'Usage: not reported.';
  const parts = [u.inputTokens !== null && `${n(u.inputTokens)} input tokens`, u.outputTokens !== null && `${n(u.outputTokens)} output tokens`, u.costUsd !== null && `$${u.costUsd} reported cost`];
  return `Usage: ${parts.filter(Boolean).join(' · ')}.`;
}

// -> why Generate cannot start, or '' when it can
export function proposeBlock(d, { catalog, choice, generating = false } = {}) {
  const r = d.reflection;
  if (generating || r?.state === 'running') return 'A proposal is being generated.';
  if (r?.proposal) return 'Apply or reject the pending proposal first.';
  if (d.state === 'busy') return 'Waits until the project is idle.';
  if (catalog === undefined) return 'Loading the model list...';
  if (!catalog) return 'The model list is not available, so no model can be chosen. It needs the control API.';
  if (!choice) return 'Choose a model under Settings first. There is no default model.';
  if (!modelAvailable(catalog, choice)) return `${refText(choice)} is not signed in or not offered any more. Choose another model under Settings.`;
  return '';
}

// The server keeps a fingerprint of each input it sent and does not report it, so this page cannot tell whether
// another attempt would be refused; it can only say what happens if so.
export const ATTEMPTED_NOTE = 'If the recent runs have not changed since the last attempt, the server refuses a new one before contacting the provider, so nothing is charged.';
export const ATTEMPTED_ERROR = 'Refused before sending: these recent runs were already sent once. A new proposal needs new run activity in this project. Nothing was sent or charged.';

export function disclosure({ tokens = TOKENS_DEFAULT, timeout = TIMEOUT_DEFAULT } = {}) {
  return `Sends redacted excerpts of up to ${RUNS_MAX} recent runs (at most ${n(RUN_EXCERPT_MAX)} characters per run, ${n(INPUT_MAX_CHARS)} characters of input including the instructions) to the chosen provider in one request with no tools. The provider may charge for it under your account or API key. The answer is capped at ${n(tokens)} output tokens and ${n(COMPLETION_MAX_CHARS)} characters and stops after ${timeout} seconds. It is only a proposal: nothing is saved to memory until you apply it.`;
}

export const proposeConfirm = (name, choice, limits) => ({
  title: 'Send excerpts to a model?',
  detail: `Generates a reflection proposal for ${name} with ${refText(choice)}. ${disclosure(limits)}`,
  ok: 'Generate',
});

export const applyConfirm = (name, count) => ({
  title: 'Apply this proposal?',
  detail: `Applies ${count} ${count === 1 ? 'change' : 'changes'} to the accepted notes of ${name}. New Team and Pipeline runs get accepted notes in their starting context as advisory history, not as instructions or evidence. A quote shows where a note came from; it does not prove the note is true.`,
  ok: 'Apply',
});

export const rejectConfirm = (name) => ({
  title: 'Reject this proposal?',
  detail: `Deletes the pending proposal of ${name}; no note changes. Another proposal is a new provider request and may be charged again.`,
  ok: 'Reject',
});

export const rollbackConfirm = (name) => ({
  title: 'Roll back the last change?',
  detail: `Restores the promoted memory, retry recommendations, settings and accepted notes of ${name} as they were before the latest saved sweep, settings change or applied proposal, and discards a pending proposal. Only that one change is undone. The diary keeps a record of it. Runs already going keep their limits and notes.`,
  ok: 'Roll back',
});

// status: HTTP code (0 = no answer); data: the server's JSON error body
export function dreamingError(status, data, fallback = '') {
  const msg = typeof data?.error === 'string' ? clip(stripBidi(data.error), LINE_MAX) : '';
  if (status === 0) return fallback || 'The server did not answer. Is it still running?';
  if (/single/i.test(msg)) return SINGLE_NOTE;
  if (status === 409 && /already attempted/i.test(msg)) return ATTEMPTED_ERROR;
  if (status === 404) return msg && msg !== 'Not found' ? msg : 'This server does not offer Dreams for this project, or the project is gone.';
  if (status === 409) return /busy/i.test(msg) || !msg ? 'Refused: the server reports this project as busy and gave no reason. Try again once it is idle.' : msg;
  return responseError(status, data);
}
