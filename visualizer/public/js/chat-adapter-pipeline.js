// A pipeline chat as a conversation (.enma/chat-view-pipeline-contract.md sections 6 and 11): the chat's run list
// and the run documents of the pipeline routes -> the engine-neutral entries of the Chat view (chat-entries.js).
// Pure: no DOM, no fetch. Events are read in seq order; nothing depends on which node emitted what, or when.
import { formatTokens, formatCost, formatDuration } from './format.js';
import { cleanText, cleanLine, REQUEST_TEXT_MAX } from './chat-entries.js';
import { RUN_STATUS, TERMINAL, eventText } from './pipeline-model.js';

const TYPES = new Set([
  'agent_message', 'check_finished', 'edits_applied', 'edits_rejected', 'grounding', 'replan_requested', 'replanned',
  'wave_started', 'wave_merged', 'gate_waiting', 'gate_decided', 'warning', 'run_resumed', 'run_reply', 'run_finished',
]);

// What the adapter reads of a run's events. A page keeps these and drops the rest: node and route events are most
// of a run and say nothing here, an accepted output and any warning but a suspension neither.
export function pipelineChatEvent(e) {
  if (!TYPES.has(e?.type)) return false;
  if (e.type === 'grounding') return e.data?.accepted === false;
  if (e.type === 'warning') return e.data?.code === 'suspended';
  return true;
}

const YOU = Object.freeze({ id: 'human', name: 'You', title: '' });
const PIPELINE = Object.freeze({ id: 'pipeline', name: 'Pipeline', title: 'Assistant' });
const GATE = Object.freeze({ id: 'pipeline', name: 'Pipeline', title: 'Gate' });
const ROLE = {
  planner: Object.freeze({ id: 'planner', name: 'Planner', title: 'Planning & Architecture' }),
  implementer: Object.freeze({ id: 'implementer', name: 'Implementer', title: 'Code & Implementation' }),
  reviewer: Object.freeze({ id: 'reviewer', name: 'Reviewer', title: 'Code & Quality Review' }),
};
const DECIDED = {
  plan: { approve: 'You approved the plan', reject: 'You rejected the plan' },
  delivery: { approve: 'You chose Apply to the project folder', reject: 'You chose Keep as patch only' },
};
const CITATIONS_SHOWN = 4;

const ts = (e) => (typeof e.ts === 'string' ? e.ts : '');
const names = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x).map((x) => cleanLine(x, 80));
const role = (id) => (Object.hasOwn(ROLE, id) ? ROLE[id] : { id: cleanLine(id, 64) || 'agent', name: cleanLine(id, 60) || 'Agent', title: '' });
const gateOf = (v) => (v === 'delivery' ? 'delivery' : 'plan');
const digestOf = (v) => (typeof v === 'string' ? v : '');

function prompt(gate, revision) {
  if (gate === 'delivery') return 'The changes are ready. Apply them to the project folder, or keep them as a patch?';
  return revision > 0 ? `The revised plan (revision ${revision}) waits for your approval.` : 'The plan waits for your approval.';
}

// The line under a reply: the outcome, the totals the run line shows, and quietly what the reply cites.
function outcome(status, s, citations) {
  const took = Date.parse(s?.updatedAt ?? '') - Date.parse(s?.createdAt ?? '');
  const p = s?.progress;
  const u = s?.usage;
  const cited = names(citations);
  const more = cited.length - CITATIONS_SHOWN;
  return [
    RUN_STATUS[status]?.label ?? '',
    p?.stepCount && p.stepsDone !== null && p.stepsDone !== undefined ? `${Math.min(p.stepsDone, p.stepCount)}/${p.stepCount} steps` : '',
    u?.calls ? `${formatTokens(u.inputTokens + u.outputTokens)} tokens` : '',
    typeof u?.cost === 'number' ? formatCost(u.cost) : '',
    Number.isFinite(took) && took >= 0 ? formatDuration(took) : '',
    cited.length ? `cites ${cited.slice(0, CITATIONS_SHOWN).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '',
  ].filter(Boolean).join(' · ');
}

// r: { kind, text, truncated, citations } of a run_reply event, status.reply or the run list
function replyEntry(runId, r, at) {
  const body = cleanText(r.text);
  return {
    id: `${runId}:rep`, runId, kind: 'reply', ts: at, who: PIPELINE, context: '', text: body.text, final: true,
    truncated: body.truncated || r.truncated === true, tone: null, replyKind: r.kind === 'answer' ? 'answer' : 'result',
  };
}

// A finished run without a stored reply (one from before conversation mode) says how it ended.
function endText(status, s) {
  const lines = [`Pipeline ${RUN_STATUS[status].label.toLowerCase()}.`];
  if (s?.failure?.message) lines.push(`Reason: ${s.failure.message}`);
  if (s?.checks?.length) lines.push(`Checks: ${s.checks.map((c) => `${c.id} ${c.status.replace(/_/g, ' ')}`).join(', ')}.`);
  if (s?.delivery?.applied === true) lines.push('Delivery: applied to the project folder.');
  else if (s?.delivery?.applied === false) lines.push(s.deliveryMode === 'patch' ? 'Delivery: patch only.' : 'Delivery: not applied.');
  return lines.join('\n');
}

function finish(reply, status, s, citations) {
  reply.tone = TERMINAL.has(status) ? (status === 'succeeded' ? 'ok' : 'fail') : null;
  reply.context = outcome(TERMINAL.has(status) ? status : null, s, citations);
}

const request = (runId, task, at) => {
  const body = cleanText(task, REQUEST_TEXT_MAX);
  return body.text.trim() ? [{ id: `${runId}:req`, runId, kind: 'request', ts: at ?? '', who: YOU, ...body }] : [];
};

// One run from its run document, in the order things happened.
function detail(run, row) {
  const { runId } = run;
  const s = run.status ?? null;
  const all = Array.isArray(run.events) ? run.events.filter(pipelineChatEvent) : [];
  const events = all.every((e, i) => !i || all[i - 1].seq <= e.seq) ? all : [...all].sort((a, b) => a.seq - b.seq);
  const out = request(runId, s?.task || row?.task, s?.createdAt ?? row?.createdAt);
  const line = (e, name, text, tone = null, context = '') => {
    const entry = { id: `${runId}:act:${name}:${e.seq}`, runId, kind: 'activity', ts: ts(e), ...(context ? { context } : {}), text, tone };
    out.push(entry);
    return entry;
  };
  // lane ('' outside a parallel wave) -> the step its implementer last spoke about
  const steps = new Map();
  const step = (lane) => steps.get(lane ?? '') ?? (lane ? `Step ${cleanLine(lane, 64)}` : '');
  const questions = new Map();
  let asked = null;
  let checks = null;
  let reply = null;
  let cited = [];
  let finished = null;
  let revision = 0;
  let suspended = false;
  let spoke = false;
  // where a run without messages gets its plan and its review said: before what followed the planning, before the delivery
  let planned = -1;
  let delivering = -1;
  let last = '';

  for (const e of events) {
    const d = e.data ?? {};
    const lane = e.lane ?? (typeof d.lane === 'string' && d.lane ? d.lane : null);
    if (e.type !== 'check_finished') checks = null;
    // everything but a check and the reason a run stopped comes after the planning began
    if (planned < 0 && !['check_finished', 'warning', 'run_resumed', 'run_reply', 'run_finished'].includes(e.type)) planned = out.length;

    switch (e.type) {
      case 'agent_message': {
        const body = cleanText(d.text);
        if (!body.text.trim()) break;
        spoke = true;
        const context = cleanLine(d.context, 120);
        if (d.role === 'implementer') steps.set(lane ?? '', context);
        out.push({
          id: `${runId}:msg:${e.seq}`, runId, kind: 'agent', ts: ts(e), who: role(d.role), context, text: body.text,
          final: d.final !== false, truncated: body.truncated || d.truncated === true, tone: null,
        });
        break;
      }

      // the checks of one verification are one line; before the planning they are the baseline, and no verdict
      case 'check_finished': {
        const passed = d.status === 'passed';
        const part = cleanLine(`${d.id ?? 'check'} ${String(d.status ?? '').replace(/_/g, ' ')}`, 80);
        if (!checks || checks.lane !== lane) checks = { lane, parts: [], failed: false, baseline: planned < 0, entry: line(e, 'checks', '', null, lane ? step(lane) : '') };
        checks.parts.push(part);
        checks.failed ||= !passed;
        const word = `${checks.baseline ? 'Baseline check' : 'Check'}${checks.parts.length === 1 ? '' : 's'}`;
        Object.assign(checks.entry, { ts: ts(e), text: `${word}: ${checks.parts.join(', ')}`, tone: checks.baseline ? null : checks.failed ? 'fail' : 'ok' });
        break;
      }

      case 'edits_applied':
        line(e, 'edits', cleanLine(`Edits applied: ${names(d.files).join(', ') || 'no file named'}`, 240), null, step(lane));
        break;

      case 'edits_rejected':
        line(e, 'edits', Number.isInteger(d.count) ? `${d.count} edit${d.count === 1 ? '' : 's'} rejected` : 'Edits rejected', 'warn', step(lane));
        break;

      case 'grounding':
        line(e, 'output', eventText(e), 'warn');
        break;

      case 'replan_requested':
        line(e, 'replan', cleanLine(`Re-plan requested: ${d.message || d.code || 'no reason given'}`, 240), 'warn', step(lane));
        break;

      case 'replanned':
        revision = Number.isInteger(d.revision) && d.revision > 0 ? d.revision : revision + 1;
        line(e, 'replan', `Plan revision ${revision}`);
        break;

      case 'wave_started':
        line(e, 'wave', cleanLine(`Wave ${Number.isInteger(d.wave) ? d.wave : '?'}: ${names(d.steps).join(', ') || 'no steps'} in parallel`, 240));
        break;

      case 'wave_merged': {
        const failed = names(d.failed);
        line(e, 'wave', cleanLine(`Wave ${Number.isInteger(d.wave) ? d.wave : '?'} merged: ${names(d.merged).join(', ') || 'none'}${failed.length ? ` · not merged: ${failed.join(', ')}` : ''}`, 240),
          failed.length ? 'fail' : 'ok');
        break;
      }

      case 'warning':
        suspended = true;
        line(e, 'suspended', cleanLine(`Suspended: ${d.message || 'the run stopped before it finished'}`, 240), 'warn');
        break;

      // every gate decision resumes the run too; only a resume that follows something else was a suspension
      case 'run_resumed':
        if (suspended || last !== 'gate_waiting') line(e, 'resumed', 'Resumed');
        suspended = false;
        break;

      case 'gate_waiting': {
        const gate = gateOf(d.gate);
        const digest = digestOf(d.digest);
        const id = `${runId}:gate:${gate}:${digest.slice(0, 12) || e.seq}`;
        if (gate === 'delivery' && delivering < 0) delivering = out.length;
        if (asked) asked.entry.tone = null;
        // a run resumed at a gate asks the same thing again: one question, not two
        asked = questions.get(id) ?? null;
        if (!asked) {
          asked = { digest, entry: { id, runId, kind: 'question', ts: ts(e), who: GATE, context: digest ? `digest ${digest.slice(0, 12)}` : '', text: prompt(gate, revision), tone: 'warn' } };
          questions.set(id, asked);
          out.push(asked.entry);
        }
        asked.entry.tone = 'warn';
        break;
      }

      case 'gate_decided': {
        const gate = gateOf(d.gate);
        const approve = d.decision === 'approve';
        if (gate === 'delivery' && delivering < 0) delivering = out.length;
        if (asked) asked.entry.tone = null;
        asked = null;
        // a policy can decide the plan gate; that is no human turn
        if (d.by && d.by !== 'human') line(e, 'gate', cleanLine(`${gate === 'plan' ? 'Plan' : 'Delivery'} ${approve ? 'approved' : 'rejected'} by ${d.by}`, 120), approve ? 'ok' : 'warn');
        else out.push({ id: `${runId}:dec:${gate}:${e.seq}`, runId, kind: 'human', ts: ts(e), who: YOU, text: DECIDED[gate][approve ? 'approve' : 'reject'], tone: approve ? 'ok' : 'warn' });
        break;
      }

      case 'run_reply':
        if (reply || typeof d.text !== 'string') break;
        reply = replyEntry(runId, d, ts(e));
        cited = d.citations;
        out.push(reply);
        break;

      case 'run_finished':
        finished = Object.hasOwn(RUN_STATUS, d.status) ? d.status : null;
        break;

      default:
        break;
    }
    last = e.type;
  }

  // the status is newer than any event the page holds: it says whether a gate still waits, and for what
  const pending = s?.status === 'awaiting_approval' ? s.pending : null;
  const status = s?.status ?? finished ?? row?.status ?? null;
  if (asked && (s || finished) && asked.digest !== pending?.digest) asked.entry.tone = null;
  if (pending && asked?.digest !== pending.digest) {
    const id = `${runId}:gate:${pending.gate}:${pending.digest.slice(0, 12)}`;
    if (pending.gate === 'delivery' && delivering < 0) delivering = out.length;
    if (questions.has(id)) questions.get(id).entry.tone = 'warn';
    else {
      out.push({
        id, runId, kind: 'question', ts: s.updatedAt ?? '', who: GATE, context: `digest ${pending.digest.slice(0, 12)}`,
        text: prompt(pending.gate, pending.revision ?? revision), tone: 'warn',
      });
    }
  }
  if (status === 'suspended' && !suspended) {
    out.push({
      id: `${runId}:act:suspended`, runId, kind: 'activity', ts: s?.updatedAt ?? '', tone: 'warn',
      text: s?.resumable ? 'Suspended: the run stopped before it finished. Resume it under Details.' : 'Suspended: the run stopped before it finished.',
    });
  }

  // a run from before conversation mode has no messages: its plan and its review speak for the roles
  if (!spoke) {
    const at = (i) => (i < 0 || (reply && i > out.indexOf(reply)) ? (reply ? out.indexOf(reply) : out.length) : i);
    const said = [];
    const plan = cleanText(run.plan?.summary);
    const n = run.plan?.steps?.length ?? 0;
    if (plan.text.trim()) said.push([at(planned), { id: `${runId}:msg:plan`, who: ROLE.planner, context: n ? `Plan · ${n} step${n === 1 ? '' : 's'}` : 'Plan', ...plan, tone: null }]);
    const review = cleanText(run.review?.summary);
    const approved = run.review?.verdict === 'approve';
    if (review.text.trim()) said.push([at(delivering), { id: `${runId}:msg:review`, who: ROLE.reviewer, context: approved ? 'Approved' : 'Changes requested', ...review, tone: approved ? 'ok' : 'warn' }]);
    // the later one first, so the earlier index still holds
    for (const [i, entry] of said.reverse().sort((a, b) => b[0] - a[0])) out.splice(i, 0, { runId, kind: 'agent', ts: out[i]?.ts ?? '', final: true, ...entry });
  }

  const storedReply = run.reply ?? s?.reply ?? row?.reply;
  if (!reply && storedReply) {
    reply = replyEntry(runId, storedReply, s?.updatedAt ?? row?.updatedAt ?? '');
    cited = storedReply.citations;
    out.push(reply);
  }
  if (!reply && TERMINAL.has(status)) {
    reply = replyEntry(runId, { kind: 'result', text: endText(status, s) }, s?.updatedAt ?? row?.updatedAt ?? '');
    out.push(reply);
  }
  if (reply) finish(reply, status, s ?? row, cited);
  return out;
}

// One run of the run list as it reads before its run document is loaded: what was asked and what came back.
function digest(row) {
  const out = request(row.runId, row.task, row.createdAt);
  const stored = row.reply ?? (TERMINAL.has(row.status) ? { kind: 'result', text: endText(row.status, null) } : null);
  if (!stored) return out;
  const reply = replyEntry(row.runId, stored, row.updatedAt ?? '');
  finish(reply, row.status, row, stored.citations);
  out.push(reply);
  return out;
}

// list: the chat's run list (pipeline-model.js parseRunList), oldest first.
// run: the run on screen as the pipeline view polls it: { runId, status, events, plan, review } (parseRunDoc).
// details: earlier runs whose documents were loaded, in the same shape.
// -> Entry[] of the whole conversation, oldest first. A listed run without a document is its task and its reply.
export function pipelineChatAdapter({ list = null, run = null, details = [] } = {}) {
  const rows = new Map((Array.isArray(list?.runs) ? list.runs : []).filter((r) => r && typeof r.runId === 'string').map((r) => [r.runId, r]));
  const loaded = new Map([...(Array.isArray(details) ? details : []), run].filter((r) => r && typeof r.runId === 'string' && r.runId).map((r) => [r.runId, r]));
  const order = [...rows.keys(), ...[...loaded.keys()].filter((id) => !rows.has(id))];
  return order.flatMap((runId) => (loaded.has(runId) ? detail(loaded.get(runId), rows.get(runId) ?? null) : digest(rows.get(runId))));
}
