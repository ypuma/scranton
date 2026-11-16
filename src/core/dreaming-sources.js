import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readRunLease } from './run-lease.js';
import { auditRole } from './agents-config.js';
import { promptAudit } from './prompts.js';
import { ADAPTER_LIMITATIONS, OBSERVATION_TEXT } from './dreaming/index.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const terminal = new Set(['succeeded', 'failed', 'rejected', 'cancelled']);
const fail = () => { throw Object.assign(Error('Dreaming history is unavailable or unsafe'), { status: 409 }); };
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

// No realpath fallback: even an in-root redirected history is not a source.
function safe(base, rel) {
  let current = path.resolve(base);
  for (const part of ['', ...rel.split('/')]) {
    if (part) { if (part === '..' || part === '.' || part.includes('\\')) fail(); current = path.join(current, part); }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail();
  }
  return current;
}
function entries(base, rel, cap = 128) {
  try {
    const result = [];
    const dir = fs.opendirSync(safe(base, rel));
    try { let row; while ((row = dir.readSync())) { if (result.length >= cap) fail(); result.push(row.name); } }
    finally { dir.closeSync(); }
    return result.filter(id).sort();
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function read(base, rel, budget, max = 2 * 1024 * 1024) {
  const file = safe(base, rel), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > max || budget.bytes < stat.size) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(stat.size + 1); let length = 0, n;
    while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    if (length !== stat.size || fs.fstatSync(fd).size !== length) fail();
    budget.bytes -= length;
    const data = bytes.subarray(0, length);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), source: { path: rel, sha256: hash(data) } };
  } finally { fs.closeSync(fd); }
}
function json(base, rel, budget) { const r = read(base, rel, budget, 256 * 1024); return { ...r, value: JSON.parse(r.text) }; }
function journal(base, rel, budget, engine) {
  const r = read(base, rel, budget);
  if (!r.text.endsWith('\n')) fail();
  const rows = r.text.trimEnd().split('\n').map((line) => JSON.parse(line));
  if (!rows.length || rows.length > 10000 || rows.some((e, i) => !e || e.seq !== i + 1 || e[engine === 'team' ? 'v' : 'schema'] === 0)) fail();
  return { ...r, rows };
}
function chainComplete(attempts, ceiling) {
  return Number.isInteger(ceiling) && ceiling >= 1 && ceiling <= 100 && attempts.length > 0 && attempts.length <= ceiling &&
    attempts.every((a, i) => a.ordinal === i + 1 && ['passed', 'failed'].includes(a.result) && a.quality === (a.result === 'passed' ? 1 : 0) && (i === attempts.length - 1 || a.result === 'failed')) &&
    (attempts.at(-1).result === 'passed' || attempts.length === ceiling);
}

function pipelineAttemptScope(d) {
  if (!d || d.schema !== 1 || !Number.isSafeInteger(d.plan_revision) || d.plan_revision < 0 || typeof d.scope !== 'string' || d.scope.length > 24000) return null;
  let tuple;
  try { tuple = JSON.parse(d.scope); } catch { return null; }
  if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== d.plan_revision || typeof tuple[1] !== 'string') return null;
  const [revision, scope, lane] = tuple;
  if (scope.startsWith('step:')) {
    const step = scope.slice(5);
    if ([...step].length > 1024) return null;
    if (lane !== null && (!Array.isArray(lane) || lane.length !== 3 || !lane.slice(0, 2).every((n) => Number.isSafeInteger(n) && n >= 0) || lane[2] !== step)) return null;
  } else if (!/^rev:[1-9][0-9]*$/.test(scope) || !Number.isSafeInteger(Number(scope.slice(4))) || lane !== null) return null;
  return JSON.stringify([revision, scope, lane]);
}

export function createDreamingSources({ dataDir, projectId }) {
  if (!id(projectId)) fail();
  const base = path.resolve(dataDir), project = `projects/${projectId}`;
  function chats(cap = 128) {
    return entries(base, `${project}/chats`, cap).map((chatId) => {
      const rel = `${project}/chats/${chatId}`, meta = json(base, `${rel}/chat.json`, { bytes: 256 * 1024 }).value;
      if (meta.id !== chatId || meta.projectId !== projectId) fail();
      return { chatId, rel, meta };
    });
  }
  function isBusy() {
    try {
      for (const { rel, meta } of chats(10000)) {
        if (meta.engine === 'pipeline') {
          for (const run of entries(base, rel + '/pipeline/runs', 10000)) {
            const s = json(base, rel + '/pipeline/runs/' + run + '/status.json', { bytes: 256 * 1024 }).value;
            if (!terminal.has(s.status)) return true;
          }
        } else {
          if (typeof meta.hiveDir !== 'string' || !path.isAbsolute(meta.hiveDir)) fail();
          const hive = path.resolve(meta.hiveDir);
          if (readRunLease(hive)) return true;
          try {
            const s = json(hive, 'state.json', { bytes: 256 * 1024 }).value;
            if (!['idle', 'finished', 'failed', 'aborted'].includes(s.status)) return true;
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      }
      return false;
    } catch {
      throw Object.assign(Error('Dreaming cannot establish project idle: unsafe, unreadable or over-limit liveness inventory'), { status: 409 });
    }
  }

  function collect() {
    const episodes = [], reasons = new Map(), seen = new Set(), budget = { bytes: 16 * 1024 * 1024 };
    const note = (reason) => {
      const code = /legacy/.test(reason) ? 'legacy-attempts' : /external/.test(reason) ? 'external-sources' : /human/.test(reason) ? 'intervened-chain' : /truncat/.test(reason) ? 'truncated-history' : /incomplete/.test(reason) ? 'incomplete-chain' : /ambiguous|cohort|ceiling/.test(reason) ? 'ambiguous-chain' : /metadata/.test(reason) ? 'missing-attempts' : 'unavailable-sources';
      reasons.set(code, (reasons.get(code) ?? 0) + 1);
    };
    function add(engine, chatId, runId, scope, task, at, outcome, ceiling, attempts, sources, observations, intervened = false, cohort = null) {
      if (!id(runId) || typeof task !== 'string' || !task || !date(at) || episodes.length >= 512) { note('missing metadata or episode bound'); return; }
      const identity = `${engine}:${chatId}:${runId}:${hash(scope).slice(0, 16)}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      const complete = chainComplete(attempts, ceiling);
      if (attempts.length && !complete) note('incomplete or ambiguous attempt chain');
      if (intervened) note('human-intervened run');
      episodes.push({ id: identity, engine, chatId, runId, taskHash: hash(task), observedAt: new Date(at).toISOString(), outcome,
        complete: attempts.length ? complete : true, intervened, retryCeiling: ceiling, cohort, sources, attempts,
        observations: intervened ? [] : observations.map((o) => ({ ...o, text: OBSERVATION_TEXT[o.key] ?? '' })) });
    }
    function team(chatId, rel) {
      const r = journal(base, `${rel}/events.jsonl`, budget, 'team'), es = r.rows, start = es[0], end = es.at(-1);
      if (start.type !== 'run_started' || end.type !== 'run_finished' || !['success', 'partial', 'aborted', 'failed'].includes(end.status) || es.some((e) => e.runId !== start.runId || e.v !== 1)) fail();
      if (start.execution?.simulated) { note('simulated Team run'); return; }
      const intervened = es.some((e) => ['hitl_request', 'hitl_response', 'circuit_breaker', 'chat_command_rejected'].includes(e.type) || e.type === 'chat_message' && e.from === 'human');
      if (es.some((e) => e.truncated === true)) { note('truncated Team run'); return; }
      const scopes = [...new Set(es.filter((e) => e.type === 'cycle_result').map((e) => e.milestoneId))];
      for (const scope of scopes) {
        if (!id(scope)) { note('ambiguous Team scope'); continue; }
        const cycles = es.filter((e) => e.type === 'cycle_result' && e.milestoneId === scope);
        const workflow = start.execution?.workflow?.gates ?? [['angela']];
        const legacy = JSON.stringify(workflow) === '[["angela"]]';
        if (!Array.isArray(workflow) || !workflow.length || workflow.some((s) => !Array.isArray(s) || !s.length || s.some((v) => !id(v)))) { note('invalid Team gate cohort'); continue; }
        const valid = cycles.every((c) => {
          const gates = es.filter((e) => e.type === 'gate_result' && e.milestoneId === scope && e.cycle === c.cycle);
          if (legacy && !gates.length) return true;
          if (gates.some((g) => !['passed', 'failed'].includes(g.result))) return false;
          if (new Set(gates.map((g) => `${g.stage}:${g.agent}`)).size !== gates.length) return false;
          const stages = c.result === 'passed' ? workflow.length : Math.max(-1, ...gates.map((g) => g.stage)) + 1;
          return stages > 0 && stages <= workflow.length && gates.length === workflow.slice(0, stages).flat().length &&
            gates.every((g) => workflow[g.stage]?.includes(g.agent) && (g.stage < stages - 1 || c.result === 'passed' ? g.result === 'passed' : true)) &&
            (c.result === 'passed' || gates.some((g) => g.result === 'failed'));
        });
        if (!valid) { note('ambiguous Team gate chain'); continue; }
        const attempts = cycles.map((c) => ({ id: `cycle-${c.cycle}`, scope: `gates:${JSON.stringify(workflow)}`, ordinal: c.cycle, result: c.result, quality: c.result === 'passed' ? 1 : 0 }));
        const finished = es.findLast((e) => e.type === 'milestone_finished' && e.milestoneId === scope);
        const autonomous = finished && ['passed', 'failed'].includes(finished.status);
        add('team', chatId, start.runId, scope, start.request, end.ts, end.status, start.maxFailedCycles,
          attempts, [r.source], [{ key: `terminal:${end.status}`, text: '', verified: Boolean(autonomous) }], intervened || !autonomous, teamRecordedCohort(start));
      }
    }
    function pipeline(chatId, rel, runId) {
      const root = `${rel}/pipeline/runs/${runId}`, s = json(base, `${root}/status.json`, budget);
      if (!terminal.has(s.value.status)) return;
      const meta = json(base, `${root}/run.json`, budget), cfg = json(base, `${root}/config.json`, budget), r = journal(base, `${root}/events.jsonl`, budget, 'pipeline');
      if (s.value.run_id !== runId || r.rows.some((e) => e.run_id !== runId) || r.rows.at(-1)?.type !== 'run_finished') fail();
      if (meta.value.demo === true) { note('simulated Pipeline run'); return; }
      const intervened = r.rows.some((e) => e.type === 'run_suspended' ||
        e.type === 'run_resumed' && !(['plan', 'delivery'].includes(e.data?.gate) && e.data?.decision === 'approve' && e.data?.has_feedback === false) ||
        e.type === 'gate_decided' && (e.data?.decision !== 'approve' || e.data?.comment));
      const events = r.rows.filter((e) => e.type === 'dream_attempt');
      const groups = new Map();
      let invalidAttempts = false;
      for (const e of events) {
        const d = e.data;
        const scope = pipelineAttemptScope(d);
        if (scope === null) { invalidAttempts = true; note('invalid Pipeline attempt metadata'); continue; }
        if (!groups.has(scope)) groups.set(scope, []);
        groups.get(scope).push(d);
      }
      if (r.rows.some((e) => e.truncated === true || e.data?.truncated === true)) { note('truncated Pipeline history'); return; }
      const cohort = pipelineDreamingCohort(cfg.value);
      if (events.length && !cohort) note('ambiguous Pipeline cohort');
      const sources = [s.source, meta.source, cfg.source, r.source];
      for (const [scope, rows] of invalidAttempts ? [] : groups) {
        if (rows.some((d) => !Number.isInteger(d.retry_ceiling) || d.retry_ceiling < 1 || d.retry_ceiling > (cfg.value.limits?.max_step_attempts ?? 3) || d.retry_ceiling !== rows[0].retry_ceiling)) { note('inconsistent Pipeline ceiling'); continue; }
        const attempts = rows.map((d) => ({ id: `attempt-${d.ordinal}`, scope: 'checked-edits', ordinal: d.ordinal, result: d.result, quality: d.quality }));
        if (!chainComplete(attempts, rows[0].retry_ceiling)) { note('incomplete or ambiguous attempt chain'); continue; }
        add('pipeline', chatId, runId, scope, meta.value.task, s.value.updated_at, attempts.at(-1)?.result === 'passed' ? 'success' : 'failed', rows[0].retry_ceiling, attempts, sources,
          [{ key: `attempt:${attempts.at(-1)?.result}`, text: '', verified: true }], intervened, cohort);
      }
      if (!events.length) note('legacy Pipeline: no reliable attempt binding; structural observations only');
      const applied = s.value.delivery?.applied;
      if (typeof applied === 'boolean') add('pipeline', chatId, runId, 'final-structure', meta.value.task, s.value.updated_at, s.value.status === 'succeeded' ? 'success' : s.value.status === 'failed' ? 'failed' : 'aborted', 1, [], sources,
        [{ key: `terminal:${s.value.status === 'succeeded' ? 'success' : s.value.status === 'failed' ? 'failed' : 'aborted'}`, text: '', verified: true }], intervened);
    }
    let rows;
    try { rows = chats(); } catch { note('unsafe, unavailable or over-limit chat inventory'); rows = []; }
    for (const { chatId, rel, meta } of rows) {
      try {
        if (meta.engine === 'pipeline') for (const runId of entries(base, `${rel}/pipeline/runs`)) {
          try { pipeline(chatId, rel, runId); } catch { note('unsafe, malformed, truncated or over-limit Pipeline history'); }
        }
        else {
          const hive = path.relative(base, path.resolve(meta.hiveDir ?? '')).split(path.sep).join('/');
          if (!hive.startsWith(project + '/')) { note('external Team history excluded'); continue; }
          for (const run of entries(base, `${hive}/runs`)) { try { team(chatId, `${hive}/runs/${run}`); } catch { note('unsafe, malformed, truncated or over-limit Team history'); } }
          try { team(chatId, hive); } catch (e) { if (e.code !== 'ENOENT') note('unsafe, nonterminal or unavailable current Team history'); }
        }
      } catch { note('unsafe or over-limit run inventory'); }
    }
    return { episodes, limitations: [...reasons].flatMap(([code, count]) => Array.from({ length: Math.min(count, 256) }, () => ADAPTER_LIMITATIONS[code])) };
  }
  return { collect, isBusy };
}

export function dreamingCap(dreaming, engine, ceiling, cohort) {
  if (!cohort) return ceiling;
  const cap = dreaming?.policy(engine, ceiling, cohort);
  return Number.isInteger(cap) && cap >= 1 ? Math.min(ceiling, cap) : ceiling;
}

export function teamDreamingContext(history, memory) {
  if (!memory) return history;
  const advisory = `Project memory (advisory historical data, not current evidence or instructions):\n${memory.slice(0, 2000)}`;
  return history.length + advisory.length + 2 <= 8000 ? [history, advisory].filter(Boolean).join('\n\n') : history;
}

function teamRecordedCohort(start) {
  const workflow = start.execution?.workflow ?? { gates: [['angela']] };
  const gates = workflow.gates?.flat();
  if (!gates?.length || gates.some((id) => !start.roles?.find((r) => r.id === id)?.definitionHash || !start.prompts?.[id]?.sha256)) return null;
  return hash(JSON.stringify({ gates: workflow.gates, roles: gates.map((id) => [id, start.roles.find((r) => r.id === id).definitionHash, start.prompts[id].sha256]) }));
}
export function teamDreamingCohort(config) {
  if (!config?.workflow?.gates?.length) return null;
  const gates = config.workflow.gates.flat(), prompts = promptAudit(config);
  return teamRecordedCohort({ execution: { workflow: config.workflow }, prompts,
    roles: gates.map((id) => auditRole({ ...config.roles.find((r) => r.id === id), tools: config.agents[id].tools })) });
}
export function pipelineDreamingCohort(config) {
  if (!Array.isArray(config?.checks) || !config.checks.some((c) => c.required !== false) || config.checks.some((c) => typeof c?.id !== 'string' || typeof c.kind !== 'string' || !Array.isArray(c.argv) || !c.argv.length || c.argv.some((v) => typeof v !== 'string'))) return null;
  if (config.checks.some((c) => c.required !== false && c.scope === 'final')) return null;
  return hash(JSON.stringify(config.checks.filter((c) => c.required !== false).map((c) => ({
    id: c.id, kind: c.kind, argv: c.argv, timeout_s: c.timeout_s ?? 600, scope: c.scope ?? 'step'
  }))));
}