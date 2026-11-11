// Pure run-control logic for the Control API (docs/CONTROL.md): request building and validation,
// the human-answer phase, notification and title decisions. No DOM, so Node can test it.
import { stripBidi, formatWhen } from './format.js';
import {
  normalizeExecution, normalizeWorkflow, workflowText, displayName, AGENT_IDS, GATE_ROLES, LEGACY_GATES, ROLE_ID_RE, ROLE_TITLES,
} from './state.js';

// Every control route answers 403 without it, GETs included (/api/auth carries the PKCE sign-in address).
export const CLIENT_HEADERS = Object.freeze({ 'X-Scranton-Client': '1' });
export const CONTROL_HEADERS = Object.freeze({ 'Content-Type': 'application/json', ...CLIENT_HEADERS });
export const DECISIONS = ['feedback', 'retry', 'skip', 'abort'];
export const DECISION_LABEL = { feedback: 'Feedback for Dwight', retry: 'Retry', skip: 'Skip milestone', abort: 'Abort run' };
export const CONFIRM_DECISIONS = new Set(['skip', 'abort']);
export const REQUEST_MAX = 4000;
export const FEEDBACK_MAX = 8000;
export const BASE_TITLE = 'Scranton - Agent Orchestration';
export const HUMAN_TITLE = '● Human needed - Scranton';
// An answer the orchestrator has not taken up by then was probably rejected (see hive/human/archive).
export const SENT_STALE_MS = 15000;
// A run_finished written this long before the child exited belongs to an earlier run.
export const EXIT_MATCH_MS = 10000;
// The control poll can see the exit before the event stream delivers the run's own run_finished.
export const EXIT_SETTLE_MS = 1500;
// Events older than this are history even when they arrive outside the replay window.
export const NOTIFY_MAX_AGE_MS = 60000;
export const PARALLEL_MAX = 32;
export const SANDBOX_NETWORKS = ['bridge', 'none'];
// Same pattern the server applies to sandboxImage.
export const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/;
// The engine defaults (contract) for a server that does not report defaults.execution yet.
export const EXECUTION_DEFAULTS = Object.freeze({
  maxParallel: 3, isolation: 'worktree', sandbox: Object.freeze({ mode: 'docker', image: 'scranton-sandbox:1.5.0-r2', network: 'bridge' }),
  persistentSessions: true, simulated: false, trustedHost: false,
});

const DISABLED = Object.freeze({
  enabled: false, workspace: '', scenarios: [], run: null, lastExit: null, pendingHuman: null,
  execution: null, configurationError: null, models: null, workflow: null, agents: null, thinkingLevels: null, instances: {}, recoveryRequired: false,
  orphan: null,
});
const MODEL_ROLES = AGENT_IDS;

// The Workflow section of the New run drawer: every gate the server knows, each on or off with a stage number.
// Gates with the same number run side by side; the stages run in ascending order after each developer turn.
export const WORKFLOW_KEY = 'scranton.workflow';
// a new user gets review and security side by side, then the tests; a custom gate starts off
export const WORKFLOW_DEFAULT = Object.freeze({ stages: Object.freeze({ oscar: 1, hank: 1, angela: 2 }) });
export const WORKFLOW_ERROR = 'Turn on at least one gate.';
// 3 built-in gates and at most 12 custom ones
export const STAGE_MAX = 15;
// what the drawer kept before the stage editor: three boxes and the parallel toggle
const LEGACY_CHOICE = ['review', 'security', 'tests', 'parallel'];
const BUILTIN_GATES = GATE_ROLES.map((id) => Object.freeze({ id, name: displayName(id), title: ROLE_TITLES[id], builtin: true }));

function stageNumber(v) {
  const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^\d{1,3}$/.test(t) ? Number(t) : NaN;
}

// [['oscar', 'hank'], ['angela']] -> { oscar: 1, hank: 1, angela: 2 }
export function stagesOf(gates) {
  return Object.fromEntries((gates ?? []).flatMap((stage, i) => stage.map((id) => [id, i + 1])));
}

function legacyGates(c) {
  const first = [c.review && 'oscar', c.security && 'hank'].filter(Boolean);
  const gates = first.length > 1 && c.parallel ? [first] : first.map((r) => [r]);
  if (c.tests) gates.push(['angela']);
  return gates;
}

// localStorage text -> { stages } or null when nothing usable is stored. known: the gate ids the server has; any
// other id (a deleted agent) is dropped, and a choice left without a gate is no choice. The three-box choice of
// before is read as the stages it meant.
export function parseStoredWorkflow(text, known = null) {
  let v = null;
  try {
    v = JSON.parse(text ?? 'null');
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let stages;
  if (v.stages && typeof v.stages === 'object' && !Array.isArray(v.stages)) {
    stages = Object.fromEntries(Object.entries(v.stages)
      .filter(([id, n]) => ROLE_ID_RE.test(id) && Number.isInteger(n) && n >= 1 && n <= STAGE_MAX));
  } else if (LEGACY_CHOICE.every((k) => typeof v[k] === 'boolean')) {
    stages = stagesOf(legacyGates(v));
  } else {
    return null;
  }
  if (known) stages = Object.fromEntries(Object.entries(stages).filter(([id]) => known.includes(id)));
  return Object.keys(stages).length ? { stages } : null;
}

// { stages: { id: number } } -> stages in order, e.g. [['oscar', 'hank'], ['angela']] (may be empty). order: the
// gate ids in catalog order, which is also the order inside a stage. A choice taken from the server's configuration
// carries its exact gates when the numbers cannot say them (an order inside a stage the catalog does not have).
export function workflowGates(choice = WORKFLOW_DEFAULT, order = GATE_ROLES) {
  if (Array.isArray(choice.gates)) return choice.gates.map((stage) => stage.filter((id) => order.includes(id))).filter((stage) => stage.length);
  const by = new Map();
  for (const id of order) {
    const n = stageNumber(choice.stages?.[id]);
    if (!Number.isInteger(n) || n < 1) continue;
    by.set(n, [...(by.get(n) ?? []), id]);
  }
  return [...by.keys()].sort((a, b) => a - b).map((n) => by.get(n));
}

export function sameGates(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// GET /api/control defaults.workflow -> the drawer's choice for it, or null when it is the engine default (what a
// server reports when nothing is configured), which leaves WORKFLOW_DEFAULT in charge.
export function configuredChoice(workflow, order = GATE_ROLES) {
  const gates = workflow?.gates;
  if (!gates?.length || sameGates(gates, LEGACY_GATES)) return null;
  const choice = { stages: stagesOf(gates) };
  return sameGates(workflowGates(choice, order), gates) ? choice : { ...choice, gates: gates.map((stage) => [...stage]) };
}

// The quiet note under the gates when the server's configuration would run other gates than the drawer.
export function workflowNote(configured, gates, names = null) {
  const c = configured?.gates;
  if (!c?.length || sameGates(c, LEGACY_GATES) || sameGates(c, gates)) return '';
  return `The server's configuration sets ${workflowText(c, names)}. A run started here uses the gates above.`;
}

// choice: { stages: { id: number or the typed text } } with an entry for every gate that is on.
// -> { gates } or { error, field } (field 'workflow', or 'stage.<id>' for a stage number out of range)
export function buildWorkflow(choice, order = GATE_ROLES, names = null) {
  if (!Array.isArray(choice.gates)) {
    const max = Math.min(STAGE_MAX, Math.max(1, order.length));
    for (const id of order) {
      if (!Object.hasOwn(choice.stages ?? {}, id)) continue;
      const n = stageNumber(choice.stages[id]);
      if (!Number.isInteger(n) || n < 1 || n > max) {
        return { error: `${names?.[id] ?? displayName(id)}'s stage must be a whole number from 1 to ${max}.`, field: `stage.${id}` };
      }
    }
  }
  const gates = workflowGates(choice, order);
  return gates.length ? { gates } : { error: WORKFLOW_ERROR, field: 'workflow' };
}

// GET /api/control defaults.agents -> [{ id, name, title, kind, builtin, gate, passKeyword, failKeyword }] in catalog
// order, or null when not reported (an older server: the built-in roles only).
function parseAgentList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const a of v) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ROLE_ID_RE.test(a.id) || out.some((x) => x.id === a.id)) continue;
    const builtin = AGENT_IDS.includes(a.id);
    out.push({
      id: a.id,
      name: str(a.name) || displayName(a.id),
      title: str(a.title) || ROLE_TITLES[a.id] || '',
      kind: ['planner', 'developer', 'gate'].includes(a.kind) ? a.kind : GATE_ROLES.includes(a.id) || !builtin ? 'gate' : a.id === 'michael' ? 'planner' : 'developer',
      builtin,
      gate: builtin ? GATE_ROLES.includes(a.id) : a.gate !== false,
      passKeyword: str(a.passKeyword) || null,
      failKeyword: str(a.failKeyword) || null,
    });
  }
  return out;
}

// The gates a run started here can use: [{ id, name, title, builtin }] in catalog order. Without a catalog, the
// built-in ones.
export function gateCatalog(control) {
  const list = control?.agents;
  if (!list) return BUILTIN_GATES;
  return list.filter((a) => a.gate).map(({ id, name, title, builtin }) => ({ id, name, title, builtin }));
}

// Every role a run may give a model: the built-ins, then the custom agents of the catalog.
export function roleIds(control) {
  return [...AGENT_IDS, ...(control?.agents ?? []).filter((a) => !AGENT_IDS.includes(a.id)).map((a) => a.id)];
}

// { id: name } of the custom agents, for the workflow summary and the model messages
export function customNames(control) {
  return Object.fromEntries((control?.agents ?? []).filter((a) => !a.builtin).map((a) => [a.id, a.name]));
}

// server data is shown, so it is scrubbed like events; form input is sent as typed
const str = (v) => (typeof v === 'string' ? stripBidi(v) : '');
const raw = (v) => (typeof v === 'string' ? v : '');

// defaults.models: the model a role left on its default uses (env, scranton.config.json or the agent settings).
// null = not reported. roles: every role of the catalog.
function parseConfiguredModels(v, roles = MODEL_ROLES) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const pair = (c) => (c && typeof c.provider === 'string' && c.provider && typeof c.model === 'string' && c.model
    ? { provider: stripBidi(c.provider), model: stripBidi(c.model) } : null);
  return Object.fromEntries(roles.map((r) => [r, Object.hasOwn(v, r) ? pair(v[r]) : null]));
}

function thinkingList(v) {
  const list = [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && /^[a-z]{1,16}$/.test(x)))];
  return list.length ? list : null;
}

export function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

// Any answer that is not an enabled v1 control document reads as disabled (plain `scranton visualize`).
export function parseControl(doc) {
  if (!doc || typeof doc !== 'object' || doc.enabled !== true) return DISABLED;
  const agents = parseAgentList(doc.defaults?.agents);
  const run = doc.run && typeof doc.run === 'object' ? {
    pid: Number(doc.run.pid) || null,
    mode: doc.run.mode === 'demo' ? 'demo' : 'run',
    request: str(doc.run.request),
    workspace: str(doc.run.workspace),
    startedAt: str(doc.run.startedAt) || null,
    runId: str(doc.run.runId) || null,
  } : null;
  const le = doc.lastExit;
  const lastExit = le && typeof le === 'object' && Number.isInteger(le.exitCode) ? {
    mode: le.mode === 'demo' ? 'demo' : 'run',
    request: str(le.request),
    exitCode: le.exitCode,
    finishedAt: str(le.finishedAt) || null,
    outputTail: str(le.outputTail),
    // not in Control API v1 yet: used when the server sends them
    runId: str(le.runId) || null,
    startedAt: str(le.startedAt) || null,
  } : null;
  const ph = doc.pendingHuman;
  const pendingHuman = run && ph && typeof ph === 'object' && Number.isInteger(ph.requestSeq) ? {
    runId: str(ph.runId),
    requestSeq: ph.requestSeq,
    milestoneId: str(ph.milestoneId) || null,
    reason: str(ph.reason),
    options: (Array.isArray(ph.options) ? ph.options : []).filter((o) => DECISIONS.includes(o)),
  } : null;
  const instances = {};
  if (doc.instances && typeof doc.instances === 'object' && !Array.isArray(doc.instances)) {
    for (const [key, v] of Object.entries(doc.instances)) {
      if (!v || typeof v !== 'object') continue;
      const id = str(v.id) || stripBidi(key);
      instances[id] = { id, agent: str(v.agent) || null, milestoneId: str(v.milestoneId) || null, status: str(v.status) || 'idle', sessionId: str(v.sessionId) || null };
    }
  }
  const recoveryRequired = doc.recoveryRequired === true && !run;
  const orphan = recoveryRequired ? parseOrphan(doc.orphan) : null;
  return {
    enabled: true,
    workspace: str(doc.workspace),
    scenarios: (Array.isArray(doc.scenarios) ? doc.scenarios : []).filter((s) => typeof s === 'string'),
    run,
    lastExit,
    pendingHuman,
    execution: normalizeExecution(doc.defaults?.execution),
    // the server could not load scranton.config.json for its workspace; runs there fail until it is fixed
    configurationError: str(doc.defaults?.configurationError) || null,
    models: parseConfiguredModels(doc.defaults?.models, roleIds({ agents })),
    // the gates scranton.config.json (or --gates) gives a run that sends none
    workflow: normalizeWorkflow(doc.defaults?.workflow, gateCatalog({ agents }).map((g) => g.id)),
    agents,
    // the thinking levels the engine accepts; null = not reported
    thinkingLevels: thinkingList(doc.defaults?.thinkingLevels),
    instances,
    recoveryRequired,
    orphan,
  };
}

// The owner statuses of GET /api/control orphan.owner (.enma/orphan-recovery-contract.md section 2).
export const OWNER_STATUSES = ['alive', 'gone', 'unknown'];
export const RECOVERY_ERROR_MAX = 600;

// owner null = a server from before the owner fields, which has no release route; a value it does not know is
// 'unknown', which never claims the run is dead.
function parseOrphan(o) {
  const v = o && typeof o === 'object' ? o : {};
  return {
    runId: str(v.runId) || null,
    startedAt: str(v.startedAt) || null,
    owner: v.owner == null ? null : OWNER_STATUSES.includes(v.owner) ? v.owner : 'unknown',
    heartbeatAt: str(v.heartbeatAt) || null,
    stopRequestedAt: str(v.stopRequestedAt) || null,
    recoveryError: clip(str(v.recoveryError), RECOVERY_ERROR_MAX) || null,
  };
}

// Release is for a run whose process is gone or cannot be checked; a run seen alive is stopped instead,
// and an old server (no owner) has nothing to release with.
export function releaseOffered(orphan) {
  return Boolean(orphan?.runId) && (orphan.owner === 'gone' || orphan.owner === 'unknown');
}

export function canReleaseOrphan(gates, control, releasing = false) {
  return Boolean(gates?.recovery) && releaseOffered(control?.orphan) && !releasing;
}

// What the recovery panel says about the orphan, by its owner status. -> { title, detail, stopConfirm, releaseConfirm }
export function recoveryText(orphan) {
  const id = orphan?.runId;
  if (!id) {
    return {
      title: 'Recovery required',
      detail: 'A run that Scranton cannot identify still holds this chat, so new runs stay disabled. Nothing is stopped or released automatically. docs/CONTROL.md describes how to free the chat by hand.',
      stopConfirm: '', releaseConfirm: '',
    };
  }
  const stop = `Scranton asks run ${id} to stop. It stops only if its process is still running and reads the request; Scranton never kills a process it did not start.`;
  if (orphan.owner == null) {
    return {
      title: 'Recovery required',
      detail: `Run ${id} was not started by this server, or the server lost track of it after a restart, and it still holds this chat. New runs stay disabled so two runs never share it. Request a stop and wait for the run to finish as aborted.`,
      stopConfirm: stop, releaseConfirm: '',
    };
  }
  if (orphan.owner === 'alive') {
    return {
      title: 'Chat in use by another run',
      detail: `Run ${id} is still running in another Scranton process, for example a terminal or a second window. New runs in this chat wait until it ends. Request a stop to finish it as aborted.`,
      stopConfirm: stop, releaseConfirm: '',
    };
  }
  if (orphan.owner === 'gone') {
    const releaseConfirm = `The process of run ${id} has ended. Releasing the chat records the run as aborted, and new runs can start here again.`;
    return orphan.recoveryError
      ? { title: 'Chat could not be released', detail: `The process of run ${id} has ended, but Scranton could not release the chat on its own. Release it here; the run is recorded as aborted.`, stopConfirm: '', releaseConfirm }
      : { title: 'Releasing the chat', detail: `The process of run ${id} has ended. Scranton is releasing the chat and records the run as aborted.`, stopConfirm: '', releaseConfirm };
  }
  return {
    title: 'Chat held by an unfinished run',
    detail: `Run ${id} never finished, and Scranton cannot tell whether its process is still running. This usually means the app was closed or the computer restarted during the run. If it may still be running, request a stop. If you are sure it has stopped, release the chat.`,
    stopConfirm: `${stop} If nothing happens, release the chat instead.`,
    releaseConfirm: `Scranton cannot tell whether run ${id} is still running. Release the chat only when you are sure it has stopped, for example after the app was closed or the computer restarted. Releasing a run that is still running lets two runs share this chat. The run will be recorded as aborted.`,
  };
}

// The orphan's times: "run x · since 22:56:04" and "stop requested 17:29:59 · last seen running 17:29:40".
export function recoveryTimes(orphan, now = Date.now()) {
  const o = orphan ?? {};
  return {
    meta: [o.runId && `run ${o.runId}`, o.startedAt && `since ${formatWhen(o.startedAt, now)}`].filter(Boolean).join(' · '),
    times: [
      o.stopRequestedAt && `stop requested ${formatWhen(o.stopRequestedAt, now)}`,
      o.heartbeatAt && `last seen running ${formatWhen(o.heartbeatAt, now)}`,
    ].filter(Boolean).join(' · '),
  };
}

// What a new run starts with when the form is left alone.
export function executionDefaults(control) {
  const x = control?.execution;
  return {
    maxParallel: x?.maxParallel ?? EXECUTION_DEFAULTS.maxParallel,
    sandbox: x?.sandbox?.mode === 'host' ? 'host' : 'docker',
    image: x?.sandbox?.image || EXECUTION_DEFAULTS.sandbox.image,
    network: SANDBOX_NETWORKS.includes(x?.sandbox?.network) ? x.sandbox.network : EXECUTION_DEFAULTS.sandbox.network,
  };
}

export function isAbsolutePath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p) || p.startsWith('/');
}

function intIn(raw, min, max) {
  const t = String(raw ?? '').trim();
  if (!t) return { empty: true };
  if (!/^\d+$/.test(t)) return { bad: true };
  const n = Number(t);
  return n >= min && n <= max ? { value: n } : { bad: true };
}

// form: { request, workspace, maxCycles, noPlan, demo, scenario, delayMs,
//         maxParallel, sandbox: 'docker' | 'host', trustedHost, sandboxImage, sandboxNetwork } as read from the inputs,
//         models: { role: { provider, model } } already checked against the catalog (accounts.js buildModels),
//         workflow: { stages } (none: an older form, the engine default stays in charge).
// Host execution is only ever sent with the explicit confirmation; a demo sends no sandbox fields because the
// fake pi runs on the host and must not look sandboxed. Every run this page starts is a conversation run
// (.enma/chat-view-contract.md section 1), a demo too. -> { body } or { error, field }
export function buildRunRequest(form, control = DISABLED) {
  const request = raw(form.request).trim();
  const demo = Boolean(form.demo);
  if (!demo && !request) return { error: 'Describe what the agents should build.', field: 'request' };
  if (request.length > REQUEST_MAX) return { error: `The request is ${request.length} characters; the limit is ${REQUEST_MAX}.`, field: 'request' };
  const body = {};
  if (request) body.request = request;

  const workspace = raw(form.workspace).trim();
  if (workspace) {
    if (!isAbsolutePath(workspace)) return { error: 'The workspace must be an absolute path.', field: 'workspace' };
    body.workspace = workspace;
  }

  const cycles = intIn(form.maxCycles, 1, 10);
  if (cycles.bad) return { error: 'Max failed cycles must be a whole number from 1 to 10.', field: 'maxCycles' };
  if (!cycles.empty) body.maxCycles = cycles.value;
  if (form.noPlan) body.noPlan = true;

  const parallel = intIn(form.maxParallel, 1, PARALLEL_MAX);
  if (parallel.bad) return { error: `Parallel milestones must be a whole number from 1 to ${PARALLEL_MAX}.`, field: 'maxParallel' };
  if (!parallel.empty) body.maxParallel = parallel.value;

  // no sandbox choice at all (an older form) leaves the engine default in charge
  if (!demo && form.sandbox !== undefined) {
    const sandbox = form.sandbox;
    if (sandbox === 'host') {
      if (form.trustedHost !== true) {
        return { error: 'Confirm that the agents may run commands directly on this computer, or pick the Docker sandbox.', field: 'trustedHost' };
      }
      body.sandbox = 'host';
      body.trustedHost = true;
    } else if (sandbox === 'docker') {
      body.sandbox = 'docker';
      const image = raw(form.sandboxImage).trim();
      if (image) {
        if (!IMAGE_RE.test(image)) return { error: 'The sandbox image must be a Docker image reference such as scranton-sandbox:1.5.0-r2.', field: 'sandboxImage' };
        body.sandboxImage = image;
      }
      const network = raw(form.sandboxNetwork);
      if (network) {
        if (!SANDBOX_NETWORKS.includes(network)) return { error: 'The sandbox network must be bridge or none.', field: 'sandboxNetwork' };
        if (network !== executionDefaults(control).network) body.sandboxNetwork = network;
      }
    } else {
      return { error: 'Pick the Docker sandbox or trusted host execution.', field: 'sandbox' };
    }
  }

  // a demo replays its scripted agents, whatever gates are picked
  if (!demo && form.workflow) {
    const w = buildWorkflow(form.workflow, gateCatalog(control).map((g) => g.id), customNames(control));
    if (w.error) return w;
    body.workflow = { gates: w.gates };
  }

  // the fake pi of a demo uses no model
  if (!demo && form.models && typeof form.models === 'object' && Object.keys(form.models).length) body.models = form.models;

  if (demo) {
    const scenario = raw(form.scenario);
    if (!control.scenarios.includes(scenario)) return { error: 'Pick a demo scenario.', field: 'scenario' };
    body.demo = { scenario };
    const delay = intIn(form.delayMs, 0, 5000);
    if (delay.bad) return { error: 'The step delay must be a whole number of milliseconds from 0 to 5000.', field: 'delayMs' };
    if (!delay.empty) body.demo.delayMs = delay.value;
  }
  body.conversation = true;
  return { body };
}

// -> { body } or { error, field }
export function buildHitlRequest({ decision, feedback } = {}, pending = null) {
  if (!pending) return { error: 'Nothing is waiting for an answer any more.' };
  if (!pending.options.includes(decision)) return { error: `"${decision}" is not offered for this pause.` };
  if (decision !== 'feedback') return { body: { decision } };
  const text = raw(feedback).trim();
  if (!text) return { error: 'Write the feedback Dwight should get.', field: 'feedback' };
  if (text.length > FEEDBACK_MAX) return { error: `The feedback is ${text.length} characters; the limit is ${FEEDBACK_MAX}.`, field: 'feedback' };
  return { body: { decision, feedback: text } };
}

// Error text for a failed control POST: the server's { error } when it sent one.
export function responseError(status, body) {
  const msg = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  if (status === 409) return msg || 'Conflict - the run state changed. Try again.';
  if (status === 400) return msg || 'The server rejected the input.';
  if (status === 403 || status === 415) return msg || `The server refused the request (HTTP ${status}).`;
  return msg || `Request failed (HTTP ${status}).`;
}

export function sameRequest(a, b) {
  return Boolean(a && b) && a.runId === b.runId && a.requestSeq === b.requestSeq;
}

// The event stream already shows the hitl_response for the request we answered.
export function answeredInState(state, sent) {
  return Boolean(sent) && state?.runId === sent.runId && state.lastSeq >= sent.requestSeq && !state.hitl;
}

// pendingHuman unless the event stream already shows its hitl_response (the poll clearing it lags behind).
export function openPending(control, state) {
  const p = control?.pendingHuman ?? null;
  return p && answeredInState(state, p) ? null : p;
}

// Why a posted answer settled: the hitl_response arrived, the run is gone or another request opened.
// While the server already reports nothing pending but the event has not arrived, it is still unsettled.
// -> 'answered' | 'gone' | 'superseded' | null
export function sentOutcome({ sent, pending, answered, alive }) {
  if (!sent) return null;
  if (answered) return 'answered';
  if (!alive) return 'gone';
  return pending && !sameRequest(pending, sent) ? 'superseded' : null;
}

export function sentSettled(args) {
  return !args.sent || sentOutcome(args) !== null;
}

const ANSWERED = { skip: 'Answer received - skipping the milestone', abort: 'Answer received - the run is aborting' };

function settledText(outcome, decision, result) {
  if (outcome === 'answered') return ANSWERED[decision] ?? 'Answer received - the run continues';
  if (result) return `Run ${result}`;
  return decision === 'abort' ? 'The run process exited after the abort' : 'The run process exited before the answer was applied';
}

// What the live region says when the answer panel changes. prev/next = hitlPhase values, fresh = the panel
// shows a request it did not show before, outcome = sentOutcome of the answer that just settled (null when
// the human cleared it with "Answer again", which moves focus itself). -> { text, focus } or null
export function hitlAnnouncement({ prev, next, fresh = false, pending = null, outcome = null, decision = '', result = null }) {
  if (next === 'answer' && fresh && (prev === 'none' || prev === 'answer' || outcome)) {
    const ask = `Human input required: ${clip(pending?.reason, 140)}`;
    return { text: outcome === 'answered' ? `Answer received. ${ask}` : ask, focus: true };
  }
  if (next === 'none' && outcome) return { text: settledText(outcome, decision, result), focus: false };
  return null;
}

// What the human-answer panel shows. sent = { runId, requestSeq, decision, at } of the answer we
// posted and that is not settled yet, or null. -> 'none' | 'answer' | 'sent' | 'stale'
export function hitlPhase({ pending, sent = null, now = Date.now() }) {
  if (sent && (!pending || sameRequest(pending, sent))) {
    return pending && now - sent.at >= SENT_STALE_MS ? 'stale' : 'sent';
  }
  return pending ? 'answer' : 'none';
}

// Whose exit lastExit is, seen from the run on screen: 'run' (that run's process), 'earlier' (the run on
// screen started after it, e.g. from a terminal in the same hive), 'later' (a process spawned after the run on
// screen started that never published a run of its own) or 'none' (no run on screen).
export function exitOwner(le, state) {
  if (!le || !state?.runId) return 'none';
  if (le.runId) return le.runId === state.runId ? 'run' : 'earlier';
  const started = Date.parse(state.startedAt ?? '');
  const exited = Date.parse(le.finishedAt ?? '');
  // no clock to compare: as before, the exit counts as the run's own
  if (!Number.isFinite(started) || !Number.isFinite(exited)) return 'run';
  if (started > exited) return 'earlier';
  return Date.parse(le.startedAt ?? '') > started ? 'later' : 'run';
}

// The run on screen was started by this server and its process is gone, so nobody can answer it any more.
// Independent of the exit panel (dismissed, settling, empty output).
export function runGone(control, state) {
  if (!control?.enabled || !state?.runId || state.result) return false;
  if (control.run?.runId === state.runId) return false;
  return exitOwner(control.lastExit, state) === 'run';
}

// runGone once a run_finished still on its way over the event stream has had time to arrive, so the
// header only says "exited" for a run that really ended without one.
export function runInterrupted(control, state, now = Date.now()) {
  return runGone(control, state) && exitSettleLeft(control.lastExit, now) === 0;
}

// The child exited non-zero without a run_finished of its own: its output tail explains why.
export function exitToShow(control, state, dismissedKey = null, now = Date.now()) {
  const le = control?.lastExit;
  if (!control?.enabled || control.run || !le || le.exitCode === 0 || !le.outputTail.trim()) return null;
  if (exitKey(le) === dismissedKey) return null;
  if (exitSettleLeft(le, now) > 0) return null;
  const owner = exitOwner(le, state);
  if (owner === 'earlier') return null;
  if (owner === 'run' && state.result) {
    if (le.runId) return null;
    // without a runId, a run_finished shortly before the exit is taken as the child's own
    const gap = Date.parse(le.finishedAt ?? '') - Date.parse(state.finishedAt ?? '');
    if (!Number.isFinite(gap) || gap <= EXIT_MATCH_MS) return null;
  }
  return le;
}

// ms until a fresh exit may be shown (0 when it may be shown now)
export function exitSettleLeft(le, now = Date.now()) {
  const age = now - Date.parse(le?.finishedAt ?? '');
  return Number.isFinite(age) ? Math.max(0, EXIT_SETTLE_MS - age) : 0;
}

export function exitKey(le) {
  return le ? `${le.finishedAt}|${le.exitCode}` : null;
}

// What the human can do about an exit whose output names a missing prerequisite. Only a hint: the output
// tail stays the evidence, and nothing here claims an engine exists.
export function exitHint(le) {
  const t = le?.outputTail ?? '';
  if (/owned by another run|run lease|lease|ownership/i.test(t)) {
    return 'Another run still owns this hive. Stop that run, or recover ownership as described in docs/CONTROL.md, before starting a new one.';
  }
  if (/docker|sandbox|container engine|\bwsl\b|image .*not (found|available)|pull access denied/i.test(t)) {
    return 'The Docker sandbox is not usable here. Run "scranton doctor", install and start Docker and build the sandbox image, or start the run again with trusted host execution.';
  }
  return '';
}

// Mode of the run on screen when this server started it: 'demo' | 'run' | null (unknown, e.g. a terminal run).
export function runModeOf(control, state) {
  if (!state?.runId || !control?.enabled) return null;
  if (control.run?.runId === state.runId) return control.run.mode;
  if (control.lastExit?.runId === state.runId) return control.lastExit.mode;
  return null;
}

// -> { title, body, tag } or null. Only for events that happen now in live mode, never for a replay.
export function notificationFor(event, { live, instant, now = Date.now() }) {
  if (!live || instant || !event || typeof event !== 'object') return null;
  const ts = Date.parse(event.ts ?? '');
  if (Number.isFinite(ts) && now - ts > NOTIFY_MAX_AGE_MS) return null;
  const tag = `${event.runId}:${event.seq}`;
  if (event.type === 'hitl_request') {
    const reason = str(event.reason).split('\n')[0].trim();
    return { title: 'Human needed', body: reason || 'The orchestrator is waiting for a decision.', tag };
  }
  if (event.type === 'run_finished') {
    return { title: `Run finished - ${str(event.status) || 'done'}`, body: str(event.summary).split('\n')[0].trim() || 'The run is over.', tag };
  }
  return null;
}

// Where the alert bar sends the human: the answer panel, the terminal, or nowhere (gone = runGone).
export function humanWhere({ enabled, alive, gone }) {
  if (!enabled) return 'terminal';
  if (gone) return 'exited';
  return alive ? 'here' : 'terminal';
}

export function documentTitle({ enabled, pending, live, hitl, gone = false }) {
  return enabled && !gone && (pending || (live && hitl)) ? HUMAN_TITLE : BASE_TITLE;
}

// Server 400 messages name the field in their own case ("Workspace must be absolute").
const ERROR_FIELDS = {
  request: 'request', workspace: 'workspace', maxcycles: 'maxCycles', scenario: 'scenario', delayms: 'delayMs',
  maxparallel: 'maxParallel', trustedhost: 'trustedHost', sandboximage: 'sandboxImage', sandboxnetwork: 'sandboxNetwork', sandbox: 'sandbox',
  models: 'models', workflow: 'workflow', gates: 'workflow',
};

// "Docker requires an explicit provider and model for dwight, angela; ..." -> ['dwight', 'angela'].
// roles: the roles that have a select (roleIds), in their order.
export function modelErrorRoles(message, roles = MODEL_ROLES) {
  const m = /\bprovider and model for ([a-z0-9, ]+)/i.exec(typeof message === 'string' ? message : '');
  return m ? roles.filter((r) => new RegExp(`\\b${r}\\b`, 'i').test(m[1])) : [];
}

export function errorField(message, roles = MODEL_ROLES) {
  const text = typeof message === 'string' ? message : '';
  const named = modelErrorRoles(text, roles);
  if (named.length) return `models.${named[0]}`;
  const role = /\bmodels\.([a-z][a-z0-9]{1,19})\b/i.exec(text);
  if (role && roles.includes(role[1].toLowerCase())) return `models.${role[1].toLowerCase()}`;
  const m = /\b(request|workspace|maxcycles|scenario|delayms|maxparallel|trustedhost|sandboximage|sandboxnetwork|sandbox|models|workflow|gates)\b/i.exec(text);
  return m ? ERROR_FIELDS[m[1].toLowerCase()] : null;
}

// What the controls may do now; the busy flags guard against double submits while a POST is out.
export function controlGates({ control, mode, submitting = false, sending = false, stopping = false, releasing = false }) {
  const on = Boolean(control?.enabled) && mode !== 'demo';
  const alive = on && Boolean(control.run);
  // an orphaned owner of the hive: starting another run against the same mailboxes is refused
  const recovery = on && !alive && Boolean(control.recoveryRequired);
  return {
    on,
    alive,
    recovery,
    canStart: on && !alive && !recovery && !submitting,
    canStop: alive && !stopping,
    // a process known to be gone reads no stop request
    canStopOrphan: recovery && Boolean(control.orphan?.runId) && control.orphan.owner !== 'gone' && !stopping && !releasing,
    canAnswer: alive && Boolean(control.pendingHuman) && !sending,
  };
}
