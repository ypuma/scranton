// Pure logic of the Pipeline engine (.enma/pipeline-contract.md sections 6, 9, 10): the documents of the pipeline
// routes, status and phase mapping, the stepper, poll timing, unified diff lines and the request bodies. No DOM.
import { stripBidi, formatTokens, formatCost } from './format.js';
import { clip } from './control.js';

export const TASK_MAX_BYTES = 32768;
export const CHECKS_MAX = 12;
export const SETUP_MAX = 4;
export const COMMENT_MAX = 4000;
export const EVENTS_KEPT = 1000;
// the run route sends at most this many events per answer; a full page means there is more to ask for
export const EVENTS_PAGE = 500;
// what the Chat view keeps of a run: only the events its adapter reads, so a long run keeps its whole conversation
export const CHAT_EVENTS_KEPT = 5000;
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
// section 19: the engine's demo scenarios, the first is the default
export const DEMO_SCENARIOS = [
  { id: 'basic', label: 'Basic fix', hint: 'One bug, one step, both approvals.' },
  { id: 'replan', label: 'Re-planning', hint: 'The first plan gets stuck; you approve a revised plan.' },
  { id: 'parallel', label: 'Parallel steps', hint: 'Two independent fixes run side by side and are merged.' },
  // section 25b: the server refuses this scenario with observe
  { id: 'evidence', label: 'Evidence checks', hint: 'Ungrounded output is rejected and repaired; at delivery one criterion is shown by checks, one passed before the change too.', enforce: true },
  // chat-view-pipeline-contract section 3: a question, answered from the code without a plan
  { id: 'answer', label: 'Direct answer', hint: 'A question about the sample project: the planner reads the code and answers. Nothing is changed and no approval is asked.' },
];
export const demoScenario = (id) => DEMO_SCENARIOS.find((s) => s.id === id) ?? DEMO_SCENARIOS[0];
// sections 16 and 18: the server takes replans 0..3 and parallelSteps 1..4; the form starts at 1 and 2
export const REPLANS_MAX = 3;
export const REPLANS_DEFAULT = 1;
export const PARALLEL_MAX = 4;
export const PARALLEL_DEFAULT = 2;
export const SANDBOX_POLL_MS = 1000;
export const BUILD_URL = '/api/pipeline/sandbox/build';

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
  replan: 'plan', run_lane: 'implement', merge_wave: 'implement',
  review: 'review', ground: 'review', package: 'deliver', approve_delivery: 'deliver', apply_to_source: 'deliver', finalize: 'done',
};

const str = (v) => (typeof v === 'string' ? stripBidi(v) : '');
const raw = (v) => (typeof v === 'string' ? v : '');
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const enc = encodeURIComponent;
// a word for a key from the engine, never one inherited from Object.prototype
const own = (map, key) => (typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined);

// Node names shown as words; every other node keeps its name
const NODE_LABEL = { ground: 'Check evidence' };
export const nodeLabel = (node) => own(NODE_LABEL, node) ?? node ?? '';

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
  const none = (reason) => ({ available: false, reason, version: null, dockerImage: null, sandbox: parseSandbox(null), providers: [] });
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
    sandbox: parseSandbox(d.sandbox),
    providers,
  };
}

const BUILD_STATES = ['idle', 'running', 'succeeded', 'failed'];

// GET /api/pipeline sandbox (section 18). known: false for a server that only names the default image.
export function parseSandbox(v) {
  const o = obj(v);
  const docker = obj(o?.docker);
  const image = obj(o?.image);
  if (!docker || typeof docker.available !== 'boolean') return { known: false, docker: null, image: null, build: null };
  const b = obj(o.build);
  return {
    known: true,
    docker: { available: docker.available, version: str(docker.version) || null, reason: str(docker.reason) || null },
    image: image ? { name: str(image.name) || str(o.dockerImage) || null, present: image.present === true } : null,
    build: b && BUILD_STATES.includes(b.state) ? { state: b.state, startedAt: str(b.startedAt) || null, finishedAt: str(b.finishedAt) || null, tail: raw(b.tail) } : null,
  };
}

// What the Sandbox part of the form says about Docker, in one line. ready: Docker can be preselected (null = unknown).
// buildError: the answer to this page's own build request, if it failed.
// -> { line, tone, ready, build: hidden | idle | running, tail }
export function sandboxView(sb, { buildError = '' } = {}) {
  if (!sb?.known) return { line: '', tone: '', ready: null, build: 'hidden', tail: '' };
  const name = sb.image?.name || 'the sandbox image';
  const state = sb.build?.state ?? 'idle';
  const tail = state === 'running' || state === 'failed' ? sb.build.tail : '';
  if (state === 'running') return { line: `Building the sandbox image ${name}...`, tone: 'busy', ready: false, build: 'running', tail };
  if (!sb.docker.available) return { line: `Docker is not running: ${sb.docker.reason || 'no reason given'}`, tone: 'error', ready: false, build: 'hidden', tail };
  if (sb.image && !sb.image.present) {
    if (buildError) return { line: `The sandbox image could not be built: ${clip(buildError, 300)}`, tone: 'error', ready: false, build: 'idle', tail };
    if (state === 'failed') return { line: `The sandbox image ${name} could not be built. Its output is below.`, tone: 'error', ready: false, build: 'idle', tail };
    return { line: `The sandbox image ${name} has not been built yet.`, tone: '', ready: false, build: 'idle', tail };
  }
  return { line: `Docker${sb.docker.version ? ` ${sb.docker.version}` : ''} is running; the image ${name} is present.`, tone: '', ready: true, build: 'hidden', tail: '' };
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

const REPLY_KINDS = ['answer', 'result'];

// A run's return message (chat-view-pipeline-contract section 11.4), as status.json and the run list carry it.
// -> { kind, text, truncated, citations } or null for a run without one
export function parseReply(r) {
  const o = obj(r);
  if (!o || typeof o.text !== 'string' || !REPLY_KINDS.includes(o.kind)) return null;
  return { kind: o.kind, text: str(o.text), truncated: o.truncated === true, citations: list(o.citations).filter((x) => typeof x === 'string' && x).map(str) };
}

// GET .../pipeline -> { active, runs } (runs oldest first, as sent); a run carries `reply` and `usage` only when
// it has one
export function parseRunList(doc) {
  const d = obj(doc);
  if (!d || !Array.isArray(d.runs)) return null;
  const seen = new Set();
  const runs = [];
  for (const r of d.runs) {
    const o = obj(r);
    if (!o || !RUN_ID_RE.test(o.runId ?? '') || seen.has(o.runId)) continue;
    seen.add(o.runId);
    const reply = parseReply(o.reply);
    // what the run used (live-activity-contract section 4); a server from before it sends none
    const u = obj(o.usage);
    runs.push({
      runId: o.runId, status: Object.hasOwn(RUN_STATUS, o.status) ? o.status : null, phase: str(o.phase) || null,
      task: str(o.task), createdAt: str(o.createdAt) || null, updatedAt: str(o.updatedAt) || null, ...(reply ? { reply } : {}),
      ...(u ? { usage: { tokens: num(u.tokens) ?? 0, cost: num(u.cost), ...(u.estimated === true ? { estimated: true } : {}) } } : {}),
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
  const base = { gate: o.gate, digest: o.digest, path: str(o.path) || null, riskFlags: list(o.risk_flags).filter((x) => typeof x === 'string' && x).map(str) };
  if (o.gate === 'plan') {
    // the engine says "code: message"; a {code, message} object reads the same
    const why = obj(o.replan_reason) ? [str(o.replan_reason.code), str(o.replan_reason.message)].filter(Boolean).join(': ') : str(o.replan_reason);
    return { ...base, revision: int(o.revision), replanReason: why };
  }
  return {
    ...base, grounding: parseGrounding(o.grounding),
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
      planRevision: int(pr.plan_revision), replansLeft: Number.isInteger(pr.replans_left) && pr.replans_left >= 0 ? pr.replans_left : null,
      stepsDone: Number.isInteger(pr.steps_done) && pr.steps_done >= 0 ? pr.steps_done : null,
      lanes: list(pr.lanes).map((l) => (obj(l) && typeof l.step_id === 'string' && l.step_id
        ? { stepId: str(l.step_id), title: str(l.title), state: str(l.state) || 'running', attempt: int(l.attempt) } : null)).filter(Boolean),
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
    sandbox: {
      mode: obj(o.sandbox)?.mode === 'docker' ? 'docker' : obj(o.sandbox)?.mode === 'host' ? 'host' : null, isolated: obj(o.sandbox)?.isolated === true,
      isolation: str(obj(o.sandbox)?.isolation).replace(/\s+/g, ' ').trim() || null,
      image: str(obj(o.sandbox)?.image).trim() || null, setupNetwork: obj(o.sandbox)?.setup_network === true,
    },
    grounding: parseGrounding(o.grounding),
    procedure: {
      enabled: obj(o.procedure)?.enabled === true, name: str(obj(o.procedure)?.name) || null,
      situation: str(obj(o.procedure)?.situation).trim() || null,
    },
    reply: parseReply(o.reply),
    createdAt: str(o.created_at) || null, updatedAt: str(o.updated_at) || null,
  };
}

function parseEvent(e) {
  const o = obj(e);
  if (!o || !Number.isInteger(o.seq) || typeof o.type !== 'string') return null;
  const data = obj(o.data) ?? {};
  // section 17: events from a parallel lane carry the lane's step id
  const lane = str(data.lane) || str(o.lane) || null;
  return { seq: o.seq, ts: str(o.ts), type: str(o.type), node: str(o.node) || null, lane, data };
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
  if (status && !status.reply) status.reply = parseReply(d.reply);
  return {
    status, launchError, live: status ? d.live === true : false,
    events: list(d.events).map(parseEvent).filter(Boolean),
    lastSeq: Number.isInteger(d.lastSeq) ? d.lastSeq : null,
    plan: parsePlan(d.plan), review: parseReview(d.review), stderrTail: raw(d.stderrTail),
    // live-activity-contract section 4: the ids of the implemented steps, and whether the engine stored them or
    // the server derived them; the usage and the live text as sent (activity-model.js reads them)
    stepsDone: Array.isArray(d.stepsDone) ? d.stepsDone.filter((x) => typeof x === 'string' && x).map(str) : null,
    stepsDoneExact: d.stepsDoneExact !== false,
    usage: obj(d.usage), liveText: obj(d.liveText),
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

// ------------------------------------------------------------ evidence grounding (sections 21 and 24)

const TIERS = ['clean', 'minor', 'major', 'failing'];
const PROBE_STATES = ['not_needed', 'demonstrated', 'not_demonstrated', 'inconclusive', 'off'];
const DECIDED_BY = ['baseline', 'probe', 'review', 'none'];
export const CRITERION_STATES = {
  demonstrated: 'shown by checks',
  met_not_demonstrated: 'passes, but passed before the change too',
  attested: "reviewer's judgement, with cited evidence",
  not_met: 'not met',
  unclear: 'unclear',
  undecided: 'not decided yet',
};
const DEMONSTRATED_BY = { baseline: 'failed before the change, passes now', probe: 'the new tests fail without the change' };
export const VIOLATION_TEXT = {
  unknown_citation: 'cited evidence that was never shown',
  unsupported_assessment: 'criterion marked met without evidence',
  unsupported_finding: 'finding without evidence',
  unseen_target: 'planned a change to a file it had not read',
  unseen_edit: 'edited a file it had not been shown',
  false_absence: 'claimed something was missing that exists',
  protected_request: 'asked for a protected path',
  out_of_scope_edit: "edited outside the step's files",
};
const PROBE_TEXT = { demonstrated: 'the new tests fail without the change', not_demonstrated: 'the tests pass even without the change', inconclusive: 'could not be run' };
export const RISK_FLAG_TEXT = {
  criteria_not_demonstrated: "A criterion's checks passed before the change too",
  // section 21.7: set only for accepted output, so only in observe mode
  grounding_violations: 'Output that was not backed by evidence was accepted (observe only)',
};
export const riskFlagText = (flag) => own(RISK_FLAG_TEXT, flag) ?? str(flag).replace(/_/g, ' ');
const violationText = (kind) => own(VIOLATION_TEXT, kind) ?? str(kind);
const stateText = (state) => own(CRITERION_STATES, state) ?? (str(state).replace(/_/g, ' ') || 'unknown');

// status.grounding / pending.grounding. null: an engine without grounding
export function parseGrounding(v) {
  const o = obj(v);
  if (!o) return null;
  const score = (x) => (num(x) !== null && x >= 0 ? x : null);
  return {
    mode: o.mode === 'observe' ? 'observe' : 'enforce',
    answer: score(o.answer), trajectory: score(o.trajectory), violationRate: num(o.violation_rate) !== null && o.violation_rate >= 0 && o.violation_rate <= 1 ? o.violation_rate : null,
    adjusted: score(o.adjusted), tier: TIERS.includes(o.tier) ? o.tier : null, outputs: int(o.outputs),
    violations: Object.entries(obj(o.violations) ?? {}).filter(([k, n]) => str(k) && Number.isInteger(n) && n > 0).map(([kind, count]) => ({ kind: str(kind), count })),
    criteria: list(o.criteria).map((c) => (obj(c) && typeof c.id === 'string' && c.id ? {
      id: str(c.id), verifiedBy: str(c.verified_by), state: str(c.state) || 'undecided', by: DECIDED_BY.includes(c.by) ? c.by : 'none',
      checks: list(c.checks).filter((x) => typeof x === 'string' && x).map(str),
    } : null)).filter(Boolean),
    probe: PROBE_STATES.includes(obj(o.probe)?.status) ? o.probe.status : null,
  };
}

// What the delivery gate and the result say about the evidence. plan: for the criterion texts; review: the
// reviewer's own words for the criteria it decided. null: nothing was evaluated yet.
// -> { criteria: [{ id, text, state, label, detail, checks, note, loud }], score, parts, rating, violations: [{ kind, label, count }], violationsLead, probe, observe, observeNote }
export function evidenceView(g, plan = null, review = null) {
  if (!g || (!g.outputs && !g.criteria.length)) return null;
  const texts = new Map(list(plan?.criteria).map((c) => [c.id, c.text]));
  const said = new Map(list(review?.criteria).map((c) => [c.id, c.evidence]));
  const criteria = g.criteria.map((c) => ({
    id: c.id, text: texts.get(c.id) || c.id, state: own(CRITERION_STATES, c.state) ? c.state : 'other', label: stateText(c.state),
    detail: c.state === 'demonstrated' ? own(DEMONSTRATED_BY, c.by) ?? '' : '',
    checks: c.verifiedBy === 'checks' ? (c.checks.length ? `checks: ${c.checks.join(', ')}` : 'all required checks') : '',
    note: c.by === 'review' ? said.get(c.id) ?? '' : '',
    loud: c.state === 'not_met',
  }));
  const parts = [
    g.answer !== null ? `answer ${g.answer.toFixed(2)}` : '',
    g.trajectory !== null ? `trajectory ${g.trajectory.toFixed(2)}` : '',
    g.violationRate !== null ? `${Math.round(g.violationRate * 100)}% of outputs with a violation` : '',
  ].filter(Boolean).join(' · ');
  const observe = g.mode === 'observe';
  // the tier rates the models' discipline, not the change: with few outputs two rejected ones already make it failing
  const flagged = g.outputs > 0 && g.violationRate !== null ? Math.round(g.violationRate * g.outputs) : null;
  const rating = !g.tier || g.tier === 'clean' ? '' : `The score rates how the models worked, not the change itself${flagged === null ? '.'
    : `: ${flagged} of ${g.outputs} output${g.outputs === 1 ? '' : 's'} ${flagged === 1 ? 'was' : 'were'} ${observe ? 'accepted without evidence' : 'rejected and repaired'}.`}`;
  return {
    criteria,
    score: g.adjusted !== null ? `Evidence score ${g.adjusted.toFixed(2)}${g.tier ? ` · ${g.tier}` : ''}` : '',
    parts,
    rating,
    violations: g.violations.map((v) => ({ kind: v.kind, label: violationText(v.kind), count: v.count })),
    // enforce repairs every violating output before it is accepted; observe accepts it
    violationsLead: !g.violations.length ? '' : g.mode === 'observe' ? 'Accepted without evidence:' : 'Rejected and repaired:',
    probe: own(PROBE_TEXT, g.probe) ? `Counterfactual probe: ${PROBE_TEXT[g.probe]}` : '',
    observe,
    // "N outputs were accepted without evidence" already says nothing was rejected
    observeNote: observe && !(rating && flagged),
  };
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

// The first clause of the engine's isolation sentence (up to the first ';', else the whole sentence), at most max
// characters and cut only between words.
const TRAILING = /[\s.,:;]+$/;
function firstClause(sentence, max = 80) {
  const c = sentence.split(';')[0].replace(TRAILING, '');
  if (c.length <= max) return c;
  // the space found is at most at max - 3, so the ellipsis still fits
  const at = c.slice(0, max - 2).lastIndexOf(' ');
  return `${c.slice(0, at > 0 ? at : max - 3).replace(TRAILING, '')}...`;
}

// The sandbox fragment of the run line. -> { text, full, more }
// full: the engine's sentence ('' from an older engine); more: it says more than the fragment does.
function sandboxFragment(sb) {
  const clause = sb.isolation ? firstClause(sb.isolation) : '';
  if (!clause) return { text: sb.mode === 'host' ? 'host, no OS isolation' : 'Docker (isolated, no network)', full: '', more: false };
  const label = sb.mode === 'host' ? 'host' : 'Docker';
  return {
    text: new RegExp(`^${label}\\b`, 'i').test(clause) ? clause : `${label} · ${clause}`,
    full: sb.isolation, more: clause !== sb.isolation.replace(TRAILING, ''),
  };
}

// The run line: the status once, then the figures. -> { status, label, glyph, loud, parts: [text], sandbox }
// sandbox: { at, full, more } for the fragment at parts[at]; more: the full sentence says more than the fragment.
export function runLine(s) {
  if (!s) return { status: 'idle', label: 'No run', glyph: '○', loud: false, parts: [], sandbox: null };
  const v = RUN_STATUS[s.status];
  const parts = [];
  const phase = PHASES.find((p) => p.id === s.phase);
  if (phase && !TERMINAL.has(s.status)) parts.push(phase.label);
  if (s.progress.lanes.length) {
    // the lanes list names the steps; the run line only counts
    if (s.progress.stepCount > 0 && s.progress.stepsDone !== null) parts.push(`${Math.min(s.progress.stepsDone, s.progress.stepCount)} of ${s.progress.stepCount} steps done`);
  } else if (s.progress.stepCount > 0 && s.progress.stepIndex >= 0) {
    parts.push(`step ${Math.min(s.progress.stepIndex + 1, s.progress.stepCount)}/${s.progress.stepCount}${s.progress.stepTitle ? ` ${clip(s.progress.stepTitle, 60)}` : ''}`);
  }
  if (s.progress.attempt > 1 && !s.progress.lanes.length) parts.push(`attempt ${s.progress.attempt}`);
  const revision = Math.max(s.progress.planRevision, s.pending?.revision ?? 0);
  if (revision > 0) {
    parts.push(`plan revision ${revision}`);
    if (s.progress.replansLeft !== null) parts.push(`${s.progress.replansLeft} replan${s.progress.replansLeft === 1 ? '' : 's'} left`);
  }
  if (s.progress.reviewRound > 0) parts.push(`review round ${s.progress.reviewRound}`);
  // section 23: one fragment for the procedure events, which get no activity entry of their own
  if (s.procedure.enabled && s.procedure.situation) parts.push(`guidance: ${clip(s.procedure.situation, 60)}`);
  if (s.usage.calls > 0) {
    parts.push(`${s.usage.calls} model call${s.usage.calls === 1 ? '' : 's'} · ${formatTokens(s.usage.inputTokens)} in · ${formatTokens(s.usage.outputTokens)} out`);
  }
  if (s.usage.cost !== null) parts.push(`~${formatCost(s.usage.cost)}`);
  // the engine's own isolation sentence is the truth; the line keeps its first clause, an older engine sends none
  let sandbox = null;
  if (s.sandbox.mode) {
    const f = sandboxFragment(s.sandbox);
    sandbox = { at: parts.length, full: f.full, more: f.more };
    parts.push(f.text);
  }
  if (s.sandbox.setupNetwork) parts.push('setup had network access');
  return { status: s.status, label: v.label, glyph: v.glyph, loud: LOUD.has(s.status), parts, sandbox };
}

// What the screen-reader status line says when it changes; the figures are left out on purpose.
export function announcement(s) {
  if (!s) return '';
  if (s.status === 'awaiting_approval' && s.pending) {
    if (s.pending.gate !== 'plan') return 'Pipeline: the changes wait for your decision';
    return s.pending.revision > 0 ? `Pipeline: the revised plan (revision ${s.pending.revision}) waits for your approval` : 'Pipeline: the plan waits for your approval';
  }
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

const COMPOSER_BLOCK = {
  awaiting_approval: 'This run waits for your decision. Follow up once it has finished.',
  suspended: 'This run is suspended. Resume or cancel it under Details, then follow up.',
};

// What the run composer of a pipeline chat does. It belongs to Chat mode (Details starts runs from its own
// controls) and is off while a run of the chat is still going. loaded: the chat's run list is in. active: the
// status of the run that is still going, or true for one that was just started. -> { hidden, disabled, reason, label }
export function pipelineComposerGate({ enabled, mode, view, loaded = false, active = null, runs = 0, submitting = false }) {
  const label = runs > 0 ? 'Follow up' : 'Start run';
  if (!enabled || mode === 'demo' || view !== 'chat' || !loaded) return { hidden: true, disabled: true, reason: '', label };
  if (active) return { hidden: false, disabled: true, label, reason: own(COMPOSER_BLOCK, active) ?? 'A run is in progress. Follow up once it has finished.' };
  return { hidden: false, disabled: submitting, reason: '', label };
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
  replan_requested: (d) => `${str(d.code) || 'replan'}${str(d.message) ? `: ${str(d.message)}` : ''}`,
  replanned: (d) => (int(d.revision) ? `plan revision ${int(d.revision)}` : 'plan revised'),
  wave_started: (d) => `wave ${waveOf(d.wave)}: ${ids(d.steps) || 'no steps'}`,
  lane_started: () => 'started',
  lane_finished: (d) => str(d.status) || 'finished',
  wave_merged: (d) => `wave ${waveOf(d.wave)}: merged ${ids(d.merged) || 'none'}${ids(d.failed) ? ` · not merged ${ids(d.failed)}` : ''}`,
  // listed only when not accepted (activityEvents); observe mode records instead of rejecting
  grounding: (d, ctx) => `${own(ROLE_LABEL, d.role) ?? (str(d.role) || 'Model')} output ${ctx.observe ? 'recorded' : 'rejected'}: ${
    [...new Set(list(d.violations).filter((k) => typeof k === 'string' && k).map(violationText))].join(', ') || 'no violation named'}`,
  // protected files are outside the search space (section 25), so the claim is never "not in the project"
  absence_verified: (d) => `Verified: ${clip(str(d.subject), 120) || 'it'} was not found in the ${
    Number.isInteger(d.files_searched) && d.files_searched >= 0 ? `${d.files_searched} file${d.files_searched === 1 ? '' : 's'}` : 'files'} models may read`,
  criteria_decided: (d) => {
    const n = Object.entries(obj(d.states) ?? {}).filter(([, v]) => Number.isInteger(v) && v > 0).map(([k, v]) => `${v} ${stateText(k)}`);
    return `criteria decided${n.length ? `: ${n.join('; ')}` : ''}`;
  },
  absence_refuted: (d) => {
    const subject = clip(str(d.subject), 120);
    if (!subject) return 'Refuted: the claimed absence';
    const hits = list(d.hits).map(obj).filter((h) => h && str(h.path)).map((h) => `${clip(str(h.path), 120)}${int(h.line) ? `:${h.line}` : ''}`);
    if (!hits.length) return `Refuted: ${subject} exists in the project`;
    const more = hits.length - 1;
    return `Refuted: ${subject} exists at ${hits[0]}${more ? ` and ${more} more place${more === 1 ? '' : 's'}` : ''}`;
  },
  probe_finished: (d) => `counterfactual probe: ${own(PROBE_TEXT, d.status) ?? own({ not_needed: 'not needed', off: 'off' }, d.status) ?? (str(d.status).replace(/_/g, ' ') || 'finished')}${
    ids(d.checks) ? ` (${ids(d.checks)})` : ''}`,
};

const waveOf = (v) => (Number.isInteger(v) ? String(v) : str(v) || '?');

function ids(v) {
  return list(v).filter((x) => typeof x === 'string').map(str).join(', ');
}

// unknown types (an engine newer than this page) read as an empty text, never as an error
// ctx: { observe } - the run's grounding mode
export function eventText(e, ctx = {}) {
  const fn = Object.hasOwn(EVENT_TEXT, e.type) ? EVENT_TEXT[e.type] : null;
  try {
    return clip(fn ? fn(e.data ?? {}, ctx) : '', 300);
  } catch {
    return '';
  }
}

export const LOUD_EVENTS = new Set(['failure', 'gate_waiting', 'edits_rejected', 'warning', 'replan_requested']);
export const eventLoud = (e, ctx = {}) => LOUD_EVENTS.has(e.type) || (e.type === 'grounding' && !ctx.observe);

// The events the activity list shows: an accepted output and the per-call procedure event say nothing new.
export const activityEvents = (events) => list(events).filter((e) => e.type !== 'procedure' && (e.type !== 'grounding' || e.data?.accepted === false));

// The lanes of a parallel wave (section 17), in the order the engine lists them.
export const LANE_STATES = {
  running: { glyph: '●', label: 'running' },
  passed: { glyph: '✓', label: 'passed' },
  failed: { glyph: '✕', label: 'failed' },
  merged: { glyph: '✓', label: 'merged' },
};
export function laneRows(lanes) {
  return list(lanes).map((l) => {
    const st = LANE_STATES[l.state];
    return {
      stepId: l.stepId, title: l.title || l.stepId, state: st ? l.state : 'other', glyph: st?.glyph ?? '·', label: st?.label ?? (l.state.replace(/_/g, ' ') || 'unknown'),
      attempt: l.attempt > 0 ? `attempt ${l.attempt}` : '', loud: l.state === 'failed',
    };
  });
}

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

const choice = (v, lo, hi, fallback) => {
  const n = typeof v === 'number' ? v : /^\d+$/.test(raw(v).trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

// The sandbox of a run. The demo runs only its bundled sample, so the host needs no acknowledgement there.
// -> { sandbox } or { error, field }
function sandboxOf(form, demo) {
  if (form.sandbox !== 'host' && form.sandbox !== 'docker') return { error: 'Choose where the checks run: Docker container or Trusted host.', field: 'sandbox' };
  if (form.sandbox === 'host') {
    if (demo) return { sandbox: { mode: 'host' } };
    if (form.trustHost !== true) return { error: 'Confirm that the checks may run on this computer without OS isolation, or use Docker.', field: 'trustHost' };
    return { sandbox: { mode: 'host', trustHost: true } };
  }
  const image = raw(form.image).trim();
  if (image.length > 256 || /\s/.test(image)) return { error: 'The image is a name or id without spaces (at most 256 characters).', field: 'image' };
  return { sandbox: image ? { mode: 'docker', image } : { mode: 'docker' } };
}

// sections 21.4 and 23.4, sent explicitly for every run: enforce and no guidance unless chosen
const evidenceOf = (form) => ({ grounding: form.grounding === 'observe' ? 'observe' : 'enforce', guidance: form.guidance === true });

// POST .../pipeline/runs. form: { task, demo, demoScenario, delivery, sandbox: 'docker' | 'host' | '' (none chosen), image,
// trustHost, replans, parallelSteps, grounding: 'enforce' | 'observe', guidance,
// setup: [{ id, command, network }], checks: [{ id, kind, command, required }],
// models: { role: { provider, model } | null }, approvals } -> { body } or { error, field }
// Every run this page starts is a conversation run (chat-view-pipeline-contract section 11.1): role messages,
// direct answers and the reply.
export function buildRunBody(form = {}) {
  const task = raw(form.task).trim();
  const delivery = form.delivery === 'patch' ? 'patch' : 'apply';
  if (task && byteLength(task) > TASK_MAX_BYTES) return { error: `The task is ${byteLength(task)} bytes; the limit is ${TASK_MAX_BYTES}.`, field: 'task' };
  // the engine's demo brings its own project and models; the scenario, delivery mode and sandbox are honoured
  if (form.demo === true) {
    const sb = sandboxOf(form, true);
    if (sb.error) return sb;
    const scenario = demoScenario(form.demoScenario);
    const evidence = evidenceOf(form);
    if (scenario.enforce) evidence.grounding = 'enforce';
    return { body: { task: task || DEMO_TASK, demo: true, demoScenario: scenario.id, delivery, sandbox: sb.sandbox, ...evidence, conversation: true } };
  }
  if (!task) return { error: 'Describe the task for the pipeline.', field: 'task' };

  const setup = commandRows(form.setup, { name: 'setup command', field: 'setup', max: SETUP_MAX, extra: (c, command) => ({ command, network: c.network === true }) });
  if (setup.error) return setup;
  const checks = commandRows(form.checks, {
    name: 'check', field: 'checks', max: CHECKS_MAX,
    extra: (c, command) => ({ kind: CHECK_KINDS.includes(c.kind) ? c.kind : 'other', command, required: c.required !== false }),
  });
  if (checks.error) return checks;

  const sb = sandboxOf(form, false);
  if (sb.error) return sb;
  const { sandbox } = sb;

  const models = {};
  for (const role of ROLES) {
    const m = form.models?.[role];
    if (!m?.provider || !m?.model) return { error: `Pick a model for the ${ROLE_LABEL[role].toLowerCase()}.`, field: `models.${role}` };
    models[role] = { provider: m.provider, model: m.model };
  }
  const approvals = { plan: form.approvals === 'auto_low_risk' ? 'auto_low_risk' : 'always' };
  const replans = choice(form.replans, 0, REPLANS_MAX, REPLANS_DEFAULT);
  const parallelSteps = choice(form.parallelSteps, 1, PARALLEL_MAX, PARALLEL_DEFAULT);
  return { body: { task, delivery, sandbox, setup: setup.rows, checks: checks.rows, models, approvals, replans, parallelSteps, ...evidenceOf(form), conversation: true } };
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
