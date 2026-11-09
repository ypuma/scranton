// Pure logic of the Pipeline engine (.enma/pipeline-contract.md sections 6, 9, 10): the documents of the pipeline
// routes, status and phase mapping, the stepper, poll timing, unified diff lines and the request bodies. No DOM.
import { stripBidi, formatTokens, formatCost } from './format.js';
import { clip } from './control.js';

export const TASK_MAX_BYTES = 32768;
export const CHECKS_MAX = 12;
export const SETUP_MAX = 4;
export const COMMENT_MAX = 4000;
export const EVENTS_KEPT = 1000;
export const DIFF_LINES_SHOWN = 4000;
export const POLL_LIVE_MS = 1000;
export const POLL_IDLE_MS = 5000;
export const ROLES = ['planner', 'implementer', 'reviewer'];
export const ROLE_LABEL = { planner: 'Planner', implementer: 'Implementer', reviewer: 'Reviewer' };
export const CHECK_KINDS = ['syntax', 'lint', 'typecheck', 'test', 'security', 'other'];
// check and setup ids: exactly COMMAND_ID_PATTERN in engine/src/scranton_pipeline/config.py
export const COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const COMMAND_ID_MAX = 64;
export const RUN_ID_RE = /^[a-z0-9]{8,32}$/;
export const DEMO_TASK = 'Demo run: fix the bug in the bundled sample project.';

// status -> what the run line says and the chat status the sidebar shows for it (section 9)
export const RUN_STATUS = {
  running: { label: 'Running', glyph: '●', chat: 'running' },
  awaiting_approval: { label: 'Waiting for you', glyph: '■', chat: 'needs_human' },
  suspended: { label: 'Suspended', glyph: '–', chat: 'stopped' },
  succeeded: { label: 'Succeeded', glyph: '✓', chat: 'done' },
  failed: { label: 'Failed', glyph: '✕', chat: 'failed' },
  rejected: { label: 'Rejected', glyph: '–', chat: 'stopped' },
  cancelled: { label: 'Cancelled', glyph: '–', chat: 'stopped' },
};
export const TERMINAL = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);
// critical states are drawn inverted
export const LOUD = new Set(['awaiting_approval', 'failed', 'suspended']);

export const PHASES = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'plan', label: 'Plan' },
  { id: 'approve_plan', label: 'Approval' },
  { id: 'implement', label: 'Implement' },
  { id: 'review', label: 'Review' },
  { id: 'deliver', label: 'Deliver' },
];
const PHASE_IDS = [...PHASES.map((p) => p.id), 'done'];
const NODE_PHASE = {
  prepare_workspace: 'prepare', index_repo: 'prepare', baseline_checks: 'prepare',
  plan: 'plan', plan_context: 'plan', approve_plan: 'approve_plan',
  select_step: 'implement', implement: 'implement', implement_context: 'implement', apply_edits: 'implement', verify: 'implement',
  review: 'review', package: 'deliver', approve_delivery: 'deliver', apply_to_source: 'deliver', finalize: 'done',
};

const str = (v) => (typeof v === 'string' ? stripBidi(v) : '');
const raw = (v) => (typeof v === 'string' ? v : '');
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const enc = encodeURIComponent;

// Diffs and reports quote the repository verbatim. Bidi controls there are shown, never applied or dropped, so a
// reordered line (trojan source) cannot read as something else.
export function revealBidi(text) {
  return raw(text).replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

export function byteLength(text) {
  return new TextEncoder().encode(raw(text)).length;
}

// ------------------------------------------------------------ urls

// suffix '' = GET .../pipeline (the chat's runs), 'runs', 'runs/<id>', ...
export function pipelineUrl(scope, suffix = '') {
  if (!scope?.project || !scope?.chat) return null;
  return `/api/projects/${enc(scope.project)}/chats/${enc(scope.chat)}/pipeline${suffix ? `/${suffix}` : ''}`;
}

export function runUrl(scope, runId, suffix = '') {
  if (!RUN_ID_RE.test(runId ?? '')) return null;
  return pipelineUrl(scope, `runs/${enc(runId)}${suffix ? `/${suffix}` : ''}`);
}

export function detectUrl(project) {
  return project ? `/api/projects/${enc(project)}/pipeline/detect` : null;
}

// ------------------------------------------------------------ GET /api/pipeline

// httpStatus: of the answer (404 = a server older than this page); doc: its body
export function parseEngineInfo(doc, httpStatus = 200) {
  const none = (reason) => ({ available: false, reason, version: null, dockerImage: null, providers: [] });
  if (httpStatus === 0) return none('The server did not answer.');
  if (httpStatus === 404) return none('This server does not offer the Pipeline engine yet.');
  const d = obj(doc);
  if (!d) return none(`The Pipeline engine could not be checked (HTTP ${httpStatus}).`);
  const providers = list(d.models).map((p) => {
    const o = obj(p);
    if (!o || typeof o.provider !== 'string' || !o.provider) return null;
    const models = list(o.models).map((m) => (obj(m) && typeof m.id === 'string' && m.id ? { id: m.id, label: str(m.label) || str(m.id) } : null)).filter(Boolean);
    return {
      provider: o.provider, label: str(o.label) || str(o.provider), supported: o.supported === true,
      reason: str(o.reason) || null, via: o.via === 'pi' || o.via === 'direct' ? o.via : null, models,
    };
  }).filter(Boolean);
  return {
    available: d.available === true,
    reason: d.available === true ? null : str(d.reason) || 'The Pipeline engine is not available on this server.',
    version: str(d.version) || null,
    dockerImage: str(obj(d.sandbox)?.dockerImage) || null,
    providers,
  };
}

// The option groups of a role's model select. value = JSON [provider, model]; unsupported providers are listed, disabled.
export function modelGroups(providers) {
  return list(providers).map((p) => ({
    label: p.supported ? `${p.label}${p.via === 'pi' ? ' · via pi' : ''}` : `${p.label} - ${p.reason || 'not supported by the Pipeline engine'}`,
    disabled: !p.supported,
    // an empty group still shows its provider and reason
    options: p.models.length
      ? p.models.map((m) => ({ value: JSON.stringify([p.provider, m.id]), text: m.label, disabled: !p.supported }))
      : [{ value: JSON.stringify([p.provider, '']), text: 'no models listed', disabled: true }],
  }));
}

export function parseModelValue(value, providers = null) {
  try {
    const v = JSON.parse(raw(value));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string' || !v[0] || !v[1]) return null;
    const pair = { provider: v[0], model: v[1] };
    if (providers) {
      const p = providers.find((x) => x.provider === pair.provider);
      if (!p?.supported || !p.models.some((m) => m.id === pair.model)) return null;
    }
    return pair;
  } catch {
    return null;
  }
}

export const hasSupportedModel = (providers) => list(providers).some((p) => p.supported && p.models.length > 0);

// POST .../pipeline/detect -> rows for the setup and checks editors
export function parseDetect(doc) {
  const d = obj(doc);
  if (!d) return null;
  return {
    git: d.git === true,
    setup: list(d.setup).map((c) => {
      const o = obj(c);
      if (!o || typeof o.command !== 'string' || !o.command.trim()) return null;
      return { id: raw(o.id), command: raw(o.command), network: o.network === true, reason: str(o.reason) };
    }).filter(Boolean).slice(0, SETUP_MAX),
    checks: list(d.checks).map((c) => {
      const o = obj(c);
      if (!o || typeof o.command !== 'string' || !o.command.trim()) return null;
      return {
        id: raw(o.id), kind: CHECK_KINDS.includes(o.kind) ? o.kind : 'other', command: raw(o.command),
        required: true, reason: str(o.reason),
      };
    }).filter(Boolean).slice(0, CHECKS_MAX),
  };
}

// ------------------------------------------------------------ run documents

// GET .../pipeline -> { active, runs } (runs oldest first, as sent)
export function parseRunList(doc) {
  const d = obj(doc);
  if (!d || !Array.isArray(d.runs)) return null;
  const seen = new Set();
  const runs = [];
  for (const r of d.runs) {
    const o = obj(r);
    if (!o || !RUN_ID_RE.test(o.runId ?? '') || seen.has(o.runId)) continue;
    seen.add(o.runId);
    runs.push({
      runId: o.runId, status: Object.hasOwn(RUN_STATUS, o.status) ? o.status : null, phase: str(o.phase) || null,
      task: str(o.task), createdAt: str(o.createdAt) || null, updatedAt: str(o.updatedAt) || null,
    });
  }
  const active = typeof d.active === 'string' && seen.has(d.active) ? d.active : null;
  return { active, runs };
}

function shortDate(ts) {
  const d = new Date(ts ?? '');
  if (Number.isNaN(d.getTime())) return '';
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The run selector: newest first. -> [{ value, text, title }]
export function runChoices(runs) {
  return list(runs).map((r, i) => ({
    value: r.runId,
    text: [`Run ${i + 1}`, clip(r.task, 40) || r.runId, RUN_STATUS[r.status]?.label.toLowerCase() ?? '', shortDate(r.createdAt)].filter(Boolean).join(' · '),
    title: `${r.runId}${r.task ? `\n${r.task}` : ''}`,
  })).reverse();
}

// Which run to show: the one the human picked while it exists, else the active one, else the newest.
export function pickRun(parsed, picked = null) {
  if (!parsed?.runs.length) return null;
  if (picked && parsed.runs.some((r) => r.runId === picked)) return picked;
  return parsed.active ?? parsed.runs.at(-1).runId;
}

function parsePending(p) {
  const o = obj(p);
  if (!o || (o.gate !== 'plan' && o.gate !== 'delivery') || typeof o.digest !== 'string' || !o.digest) return null;
  const base = { gate: o.gate, digest: o.digest, path: str(o.path) || null };
  if (o.gate === 'plan') return { ...base, riskFlags: list(o.risk_flags).filter((x) => typeof x === 'string').map(str) };
  return {
    ...base,
    files: list(o.files).map((f) => (obj(f) && typeof f.path === 'string'
      ? { path: str(f.path), action: str(f.action), added: int(f.added), removed: int(f.removed) } : null)).filter(Boolean),
  };
}

// RunStatus (section 6), every field checked; anything missing reads as "not there"
export function parseStatus(s) {
  const o = obj(s);
  if (!o || !Object.hasOwn(RUN_STATUS, o.status)) return null;
  const pr = obj(o.progress) ?? {};
  const u = obj(o.usage) ?? {};
  const f = obj(o.failure);
  const dl = obj(o.delivery);
  const art = obj(o.artifacts) ?? {};
  return {
    runId: str(o.run_id), status: o.status, phase: PHASE_IDS.includes(o.phase) ? o.phase : null, node: str(o.node) || null,
    task: str(o.task), sourceDir: str(o.source_dir), deliveryMode: o.delivery_mode === 'patch' ? 'patch' : 'apply',
    progress: {
      stepIndex: Number.isInteger(pr.step_index) ? pr.step_index : -1, stepCount: int(pr.step_count),
      stepTitle: str(pr.step_title), attempt: int(pr.attempt), reviewRound: int(pr.review_round),
    },
    pending: parsePending(o.pending),
    failure: f ? { failureClass: str(f.failure_class), code: str(f.code), message: str(f.message), node: str(f.node) } : null,
    resumable: o.resumable === true,
    usage: { calls: int(u.calls), inputTokens: int(u.input_tokens), outputTokens: int(u.output_tokens), cost: num(u.estimated_cost) },
    checks: list(o.checks).map((c) => (obj(c) && typeof c.id === 'string' ? {
      id: str(c.id), kind: str(c.kind), status: str(c.status), required: c.required !== false, durationS: num(c.duration_s),
      outputTail: c.status === 'passed' ? '' : raw(c.output_tail),
    } : null)).filter(Boolean),
    delivery: dl ? {
      applied: typeof dl.applied === 'boolean' ? dl.applied : null, diffSha256: str(dl.diff_sha256) || null, files: int(dl.files),
      conflicts: list(dl.conflicts).map((c) => (typeof c === 'string' ? str(c) : obj(c) ? [str(c.path), str(c.reason ?? c.message)].filter(Boolean).join(': ') : '')).filter(Boolean),
    } : null,
    artifacts: {
      plan: Boolean(art.plan), diff: Boolean(art.diff), reportMd: Boolean(art.report_md), reportJson: Boolean(art.report_json),
    },
    sandbox: { mode: obj(o.sandbox)?.mode === 'docker' ? 'docker' : obj(o.sandbox)?.mode === 'host' ? 'host' : null, isolated: obj(o.sandbox)?.isolated === true },
    createdAt: str(o.created_at) || null, updatedAt: str(o.updated_at) || null,
  };
}

function parseEvent(e) {
  const o = obj(e);
  if (!o || !Number.isInteger(o.seq) || typeof o.type !== 'string') return null;
  return { seq: o.seq, ts: str(o.ts), type: str(o.type), node: str(o.node) || null, data: obj(o.data) ?? {} };
}

function parseLaunchError(v) {
  const o = obj(v);
  if (!o || typeof o.message !== 'string') return null;
  return { code: Number.isInteger(o.code) ? o.code : null, message: str(o.message) || 'The engine gave no reason.' };
}

// GET .../runs/:id?after=n. status null: a run that never started; launchError then says why (section 15 c).
export function parseRunDoc(doc) {
  const d = obj(doc);
  const status = parseStatus(d?.status);
  const launchError = parseLaunchError(d?.launchError);
  if (!status && !(launchError && d.status === null)) return null;
  return {
    status, launchError, live: status ? d.live === true : false,
    events: list(d.events).map(parseEvent).filter(Boolean),
    lastSeq: Number.isInteger(d.lastSeq) ? d.lastSeq : null,
    plan: parsePlan(d.plan), review: parseReview(d.review), stderrTail: raw(d.stderrTail),
  };
}

// New events after the ones kept, in seq order, the oldest dropped beyond the cap.
export function mergeEvents(kept, incoming, cap = EVENTS_KEPT) {
  const last = kept.at(-1)?.seq ?? -Infinity;
  const fresh = incoming.filter((e) => e.seq > last).sort((a, b) => a.seq - b.seq);
  if (!fresh.length) return kept;
  const all = [...kept, ...fresh];
  return all.length > cap ? all.slice(all.length - cap) : all;
}

export function parsePlan(p) {
  const o = obj(p);
  if (!o) return null;
  return {
    summary: str(o.summary),
    assumptions: list(o.assumptions).filter((x) => typeof x === 'string').map(str),
    risks: list(o.risks).map((r) => (obj(r) ? { description: str(r.description), severity: str(r.severity), mitigation: str(r.mitigation) } : null)).filter(Boolean),
    criteria: list(o.acceptance_criteria).map((c) => (obj(c) ? { id: str(c.id), text: str(c.text), verifiedBy: str(c.verified_by) } : null)).filter(Boolean),
    steps: list(o.steps).map((s) => (obj(s) ? {
      id: str(s.id), title: str(s.title), description: str(s.description),
      files: list(s.files).map((f) => (obj(f) ? { path: str(f.path), action: str(f.action) } : null)).filter(Boolean),
      criteria: list(s.criteria).filter((x) => typeof x === 'string').map(str),
    } : null)).filter(Boolean),
  };
}

export function parseReview(r) {
  const o = obj(r);
  if (!o || (o.verdict !== 'approve' && o.verdict !== 'request_changes')) return null;
  return {
    verdict: o.verdict, summary: str(o.summary),
    criteria: list(o.criteria).map((c) => (obj(c) ? { id: str(c.id), status: str(c.status), evidence: str(c.evidence) } : null)).filter(Boolean),
    findings: list(o.findings).map((f) => (obj(f) ? {
      severity: str(f.severity), category: str(f.category), path: str(f.path), description: str(f.description), suggestion: str(f.suggestion),
    } : null)).filter(Boolean),
  };
}

// report.json: only the deterministic limitations list is read from it
export function reportLimitations(text) {
  try {
    const d = JSON.parse(raw(text));
    return list(d?.limitations).map((l) => (typeof l === 'string' ? str(l) : obj(l) ? str(l.message ?? l.text ?? l.code) : '')).filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ status, phase, stepper

export function chatStatusOf(status) {
  return status ? RUN_STATUS[status]?.chat ?? 'idle' : 'idle';
}

export function phaseOfNode(node) {
  return NODE_PHASE[node] ?? null;
}

// The last node that did work, from the event list (finalize runs for every outcome, so it says nothing).
export function lastWorkNode(events) {
  for (let i = list(events).length - 1; i >= 0; i -= 1) {
    const n = events[i].node;
    const p = phaseOfNode(n);
    if (p && p !== 'done') return n;
  }
  return null;
}

// Where a run stopped: its phase, or for a finished one the node it failed in or last worked in.
function stopPhase(s, lastNode) {
  if (s.status === 'rejected') return 'approve_plan';
  if (s.phase && s.phase !== 'done') return s.phase;
  for (const n of [s.failure?.node, lastNode, s.node]) {
    const p = phaseOfNode(n);
    if (p && p !== 'done') return p;
  }
  return null;
}

// -> [{ id, label, state }]; state: done | current | waiting | stopped | failed | pending
// lastNode: lastWorkNode(events), for a run that finished outside a phase
export function stepper(s, lastNode = null) {
  if (!s) return PHASES.map((p) => ({ ...p, state: 'pending' }));
  const succeeded = s.status === 'succeeded';
  let at = succeeded ? PHASES.length : PHASES.findIndex((p) => p.id === (TERMINAL.has(s.status) || s.status === 'suspended' ? stopPhase(s, lastNode) : s.phase));
  if (at < 0) at = 0;
  // a gate decides where the run waits, whatever phase the last finished node had
  if (s.status === 'awaiting_approval' && s.pending) at = PHASES.findIndex((p) => p.id === (s.pending.gate === 'plan' ? 'approve_plan' : 'deliver'));
  const here = {
    running: 'current', awaiting_approval: 'waiting', suspended: 'stopped', failed: 'failed', rejected: 'stopped', cancelled: 'stopped',
  }[s.status] ?? 'current';
  return PHASES.map((p, i) => ({ ...p, state: i < at ? 'done' : i === at ? here : 'pending' }));
}

// The run line: the status once, then the figures. -> { status, label, glyph, loud, parts: [text] }
export function runLine(s) {
  if (!s) return { status: 'idle', label: 'No run', glyph: '○', loud: false, parts: [] };
  const v = RUN_STATUS[s.status];
  const parts = [];
  const phase = PHASES.find((p) => p.id === s.phase);
  if (phase && !TERMINAL.has(s.status)) parts.push(phase.label);
  if (s.progress.stepCount > 0 && s.progress.stepIndex >= 0) {
    parts.push(`step ${Math.min(s.progress.stepIndex + 1, s.progress.stepCount)}/${s.progress.stepCount}${s.progress.stepTitle ? ` ${clip(s.progress.stepTitle, 60)}` : ''}`);
  }
  if (s.progress.attempt > 1) parts.push(`attempt ${s.progress.attempt}`);
  if (s.progress.reviewRound > 0) parts.push(`review round ${s.progress.reviewRound}`);
  if (s.usage.calls > 0) {
    parts.push(`${s.usage.calls} model call${s.usage.calls === 1 ? '' : 's'} · ${formatTokens(s.usage.inputTokens)} in · ${formatTokens(s.usage.outputTokens)} out`);
  }
  if (s.usage.cost !== null) parts.push(`~${formatCost(s.usage.cost)}`);
  if (s.sandbox.mode === 'host') parts.push('host, no OS isolation');
  else if (s.sandbox.mode === 'docker') parts.push('Docker sandbox');
  return { status: s.status, label: v.label, glyph: v.glyph, loud: LOUD.has(s.status), parts };
}

// What the screen-reader status line says when it changes; the figures are left out on purpose.
export function announcement(s) {
  if (!s) return '';
  if (s.status === 'awaiting_approval' && s.pending) return s.pending.gate === 'plan' ? 'Pipeline: the plan waits for your approval' : 'Pipeline: the changes wait for your decision';
  return `Pipeline run ${RUN_STATUS[s.status].label.toLowerCase()}`;
}

// The run line text for the failure of the last engine call. action: what this page sent last, if anything.
export function launchText(launchError, { started = true, action = '' } = {}) {
  if (!launchError) return '';
  const what = !started ? 'The run could not start'
    : action === 'decision' ? 'The decision could not be carried out'
      : action === 'resume' ? 'The run could not be resumed'
        : action === 'cancel' ? 'The run could not be cancelled'
          : 'The last engine call failed';
  return `${what}: ${clip(launchError.message, 600)}`;
}

export function canCancel(s) {
  return Boolean(s) && !TERMINAL.has(s.status);
}

export function canResume(s) {
  return s?.status === 'suspended';
}

// ------------------------------------------------------------ polling

// null = do not poll (the chat is not on screen)
export function pollDelay({ shown = true, live = false, status = null } = {}) {
  if (!shown) return null;
  return live || status === 'running' ? POLL_LIVE_MS : POLL_IDLE_MS;
}

// load() -> Promise<{ live, status } | null>. One request at a time; now() asks again right away.
export function createPoller({ load, timers = globalThis }) {
  let on = false;
  let timer = 0;
  let gen = 0;
  let inflight = null;
  let again = false;
  let last = null;
  async function tick() {
    if (!on) return;
    if (inflight) {
      again = true;
      return;
    }
    timers.clearTimeout(timer);
    const mine = gen;
    inflight = Promise.resolve().then(load).catch(() => null);
    const r = await inflight;
    inflight = null;
    if (mine !== gen || !on) return;
    if (r) last = r;
    if (again) {
      again = false;
      tick();
      return;
    }
    timer = timers.setTimeout(tick, pollDelay({ shown: on, live: last?.live, status: last?.status }));
  }
  return {
    start() {
      on = true;
      gen += 1;
      last = null;
      again = false;
      inflight = null;
      tick();
    },
    stop() {
      on = false;
      gen += 1;
      timers.clearTimeout(timer);
    },
    now: tick,
    running: () => on,
  };
}

// ------------------------------------------------------------ unified diff

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const META_RE = /^(index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;

// -> [{ kind, text }]; kind: file | meta | hunk | add | del | ctx | note. Hunk headers say how many lines follow,
// so a removed line "--- x" inside a hunk is a removal, not a file header.
export function classifyDiff(text) {
  const lines = raw(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) { newLeft -= 1; out.push({ kind: 'add', text: line }); continue; }
      if (line.startsWith('-')) { oldLeft -= 1; out.push({ kind: 'del', text: line }); continue; }
      if (line.startsWith(' ') || line === '') { oldLeft -= 1; newLeft -= 1; out.push({ kind: 'ctx', text: line }); continue; }
      if (line.startsWith('\\')) { out.push({ kind: 'note', text: line }); continue; }
      oldLeft = 0;
      newLeft = 0;
    }
    const h = HUNK_RE.exec(line);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLeft = h[2] === undefined ? 1 : Number(h[2]);
      out.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('diff --git ')) out.push({ kind: 'file', text: line });
    else if (line.startsWith('--- ') || line.startsWith('+++ ') || META_RE.test(line)) out.push({ kind: 'meta', text: line });
    else if (line.startsWith('\\')) out.push({ kind: 'note', text: line });
    else out.push({ kind: 'ctx', text: line });
  }
  return out;
}

function diffPath(line) {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return m ? m[2] : line.slice('diff --git '.length);
}

// The changed files of a classified diff. -> [{ path, action: A | M | D, added, removed }]
export function diffFiles(lines) {
  const files = [];
  let cur = null;
  for (const l of lines) {
    if (l.kind === 'file') {
      cur = { path: diffPath(l.text), action: 'M', added: 0, removed: 0 };
      files.push(cur);
    } else if (!cur) continue;
    else if (l.kind === 'meta' && l.text.startsWith('new file mode')) cur.action = 'A';
    else if (l.kind === 'meta' && l.text.startsWith('deleted file mode')) cur.action = 'D';
    else if (l.kind === 'add') cur.added += 1;
    else if (l.kind === 'del') cur.removed += 1;
  }
  return files;
}

const ACTION = { A: 'added', M: 'modified', D: 'deleted', create: 'added', modify: 'modified', delete: 'deleted', added: 'added', modified: 'modified', deleted: 'deleted' };
export const actionLabel = (a) => ACTION[a] ?? (a || 'changed');

// ------------------------------------------------------------ events

const EVENT_TEXT = {
  run_started: () => 'run started',
  run_resumed: () => 'run resumed',
  node_started: () => 'started',
  node_finished: (d) => (num(d.duration_s) !== null ? `finished in ${d.duration_s.toFixed(1)} s` : 'finished'),
  // a fan-out names several targets
  route: (d) => `${str(d.from)} -> ${Array.isArray(d.to) ? d.to.map(str).join(' + ') : str(d.to)}${d.reason ? ` (${str(d.reason)})` : ''}`,
  llm_call: (d) => `${str(d.role)} ${str(d.model)} ${d.ok === false ? 'failed' : 'ok'} · ${formatTokens(d.input_tokens)} in · ${formatTokens(d.output_tokens)} out`,
  context: (d) => `${int(d.fulfilled)} of ${int(d.requests)} context requests fulfilled`,
  edits_applied: (d) => `edits applied${Array.isArray(d.files) ? `: ${d.files.filter((x) => typeof x === 'string').map(str).join(', ')}` : ''}`,
  edits_rejected: (d) => `edits rejected${d.reason ? `: ${str(d.reason)}` : ''}`,
  check_finished: (d) => `${str(d.id)} ${str(d.status)}${num(d.duration_s) !== null ? ` in ${d.duration_s.toFixed(1)} s` : ''}`,
  gate_waiting: (d) => `${str(d.gate)} gate waiting`,
  gate_decided: (d) => `${str(d.gate)} gate: ${str(d.decision)}${d.by ? ` by ${str(d.by)}` : ''}`,
  warning: (d) => `${str(d.code)}${d.message ? `: ${str(d.message)}` : ''}`,
  failure: (d) => `${str(d.failure_class)}/${str(d.code)}${d.message ? `: ${str(d.message)}` : ''}`,
  run_finished: (d) => `run finished: ${str(d.status)}`,
};

export function eventText(e) {
  const fn = EVENT_TEXT[e.type];
  return clip(fn ? fn(e.data) : '', 300);
}

export const LOUD_EVENTS = new Set(['failure', 'gate_waiting', 'edits_rejected', 'warning']);

// ------------------------------------------------------------ request bodies

// The setup or check rows as sent; blank rows are skipped. -> { rows } or { error, field }
function commandRows(rows, { name, field, max, extra }) {
  const out = [];
  const ids = new Set();
  for (const [i, c] of list(rows).entries()) {
    const id = raw(c?.id).trim();
    const command = raw(c?.command).trim();
    if (!id && !command) continue;
    const what = `${name[0].toUpperCase()}${name.slice(1)}`;
    if (!id) return { error: `${what} ${i + 1} needs an id.`, field: `${field}.${i}.id` };
    if (!COMMAND_ID_RE.test(id)) return { error: `${what} id "${clip(id, 40)}": letters, digits, "_" and "-", up to ${COMMAND_ID_MAX} characters.`, field: `${field}.${i}.id` };
    if (ids.has(id)) return { error: `Two ${name}s are called "${id}".`, field: `${field}.${i}.id` };
    if (!command) return { error: `${what} ${id} needs a command.`, field: `${field}.${i}.command` };
    ids.add(id);
    out.push({ id, ...extra(c, command) });
  }
  if (out.length > max) return { error: `At most ${max} ${name}s.`, field: `${field}.${max}.id` };
  return { rows: out };
}

// POST .../pipeline/runs. form: { task, demo, delivery, sandbox: 'docker' | 'host', image, trustHost,
// setup: [{ id, command, network }], checks: [{ id, kind, command, required }],
// models: { role: { provider, model } | null }, approvals } -> { body } or { error, field }
export function buildRunBody(form = {}) {
  const task = raw(form.task).trim();
  const delivery = form.delivery === 'patch' ? 'patch' : 'apply';
  if (task && byteLength(task) > TASK_MAX_BYTES) return { error: `The task is ${byteLength(task)} bytes; the limit is ${TASK_MAX_BYTES}.`, field: 'task' };
  // the engine's demo brings its own project, models and sandbox; only the delivery mode is honoured
  if (form.demo === true) return { body: { task: task || DEMO_TASK, demo: true, delivery } };
  if (!task) return { error: 'Describe the task for the pipeline.', field: 'task' };

  const setup = commandRows(form.setup, { name: 'setup command', field: 'setup', max: SETUP_MAX, extra: (c, command) => ({ command, network: c.network === true }) });
  if (setup.error) return setup;
  const checks = commandRows(form.checks, {
    name: 'check', field: 'checks', max: CHECKS_MAX,
    extra: (c, command) => ({ kind: CHECK_KINDS.includes(c.kind) ? c.kind : 'other', command, required: c.required !== false }),
  });
  if (checks.error) return checks;

  let sandbox;
  if (form.sandbox === 'host') {
    if (form.trustHost !== true) return { error: 'Confirm that the checks may run on this computer without OS isolation, or use Docker.', field: 'trustHost' };
    sandbox = { mode: 'host', trustHost: true };
  } else {
    const image = raw(form.image).trim();
    if (image.length > 256 || /\s/.test(image)) return { error: 'The image is a name or id without spaces (at most 256 characters).', field: 'image' };
    sandbox = image ? { mode: 'docker', image } : { mode: 'docker' };
  }

  const models = {};
  for (const role of ROLES) {
    const m = form.models?.[role];
    if (!m?.provider || !m?.model) return { error: `Pick a model for the ${ROLE_LABEL[role].toLowerCase()}.`, field: `models.${role}` };
    models[role] = { provider: m.provider, model: m.model };
  }
  const approvals = { plan: form.approvals === 'auto_low_risk' ? 'auto_low_risk' : 'always' };
  return { body: { task, delivery, sandbox, setup: setup.rows, checks: checks.rows, models, approvals } };
}

// Which form field a 400 from the runs route is about: a named row field (checks.1.id, setup[0].command), else a guess.
export function runErrorField(message) {
  const t = raw(message);
  const row = /\b(checks|setup)(?:\[(\d+)\]|\.(\d+))(?:\.(id|command))?/.exec(t);
  if (row) return `${row[1]}.${row[2] ?? row[3]}.${row[4] ?? (/command|argv/i.test(t) ? 'command' : 'id')}`;
  if (/\btask\b/i.test(t)) return 'task';
  if (/trust/i.test(t)) return 'trustHost';
  if (/\bimage\b/i.test(t)) return 'image';
  const role = ROLES.find((r) => new RegExp(`\\b${r}\\b`, 'i').test(t));
  if (role) return `models.${role}`;
  return null;
}

// POST .../decision: the digest is the pending gate's, never one the page made up.
export function buildDecision({ gate, decision, comment } = {}, pending) {
  if (!pending || pending.gate !== gate) return { error: 'This decision is no longer pending.' };
  if (decision !== 'approve' && decision !== 'reject') return { error: 'Unknown decision.' };
  const body = { gate, decision, digest: pending.digest };
  const c = raw(comment).trim();
  if (c.length > COMMENT_MAX) return { error: `The comment is ${c.length} characters; the limit is ${COMMENT_MAX}.`, field: 'comment' };
  if (c) body.comment = c;
  return { body };
}

// The last folder name of a path, for the Apply button.
export function folderName(path) {
  const parts = raw(path).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}
