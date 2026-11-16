// The pi team as a conversation: Contract v1 events (docs/EVENTS.md, conversation mode included) and the run list
// of a chat -> the engine-neutral entries of the Chat view (chat-entries.js). Pure: no DOM, no fetch.
import { displayName, roleTitle, roleOf } from './state.js';
import { formatTokens, formatCost, formatDuration } from './format.js';
import { DECISION_LABEL } from './control.js';
import { cleanText, cleanLine, REPLY_KINDS } from './chat-entries.js';
import { parsePlanText } from './plan.js';

// What the adapter reads. A page that buffers a live stream keeps these and drops the rest (agent_status is half
// of a run's events and says nothing here).
export const CHAT_EVENT_TYPES = new Set([
  'run_started', 'plan_ready', 'instance_started', 'agent_message', 'agent_tool', 'agent_finished', 'hive_write',
  'milestone_started', 'milestone_finished', 'cycle_result', 'gate_result', 'chat_message', 'chat_delivery',
  'hitl_request', 'hitl_response', 'run_reply', 'run_finished',
]);

const YOU = Object.freeze({ id: 'human', name: 'You', title: '' });
const SYSTEM = Object.freeze({ id: 'system', name: 'Scranton', title: '' });
const OUTCOME = { success: 'Success', partial: 'Partial', failed: 'Failed', aborted: 'Aborted' };
const MILESTONE_TONE = { passed: 'ok', skipped: 'warn', blocked: 'warn' };
const GATE_TONE = { passed: 'ok', failed: 'fail' };
const HIVE_KIND = { task: 'task', handoff: 'handoff', bug_report: 'bug report', feedback: 'feedback' };

const ts = (e) => (typeof e.ts === 'string' ? e.ts : '');
const where = (milestoneId, cycle) => [cleanLine(milestoneId, 40), Number.isInteger(cycle) ? `cycle ${cycle}` : ''].filter(Boolean).join(' · ');

// Names and titles come from the reducer state of the run on screen, else from the roles the run itself listed.
function namesFor(runId, events, state) {
  if (state?.runId === runId) return state;
  const started = events.find((e) => e.type === 'run_started');
  return { roles: Array.isArray(started?.roles) ? started.roles : [], instances: {} };
}

function sender(id, names) {
  if (id === 'human') return YOU;
  if (id === 'system' || typeof id !== 'string' || !id) return SYSTEM;
  const role = roleOf(id, names) ?? id;
  return { id: cleanLine(role, 64), name: cleanLine(displayName(role, names), 60), title: cleanLine(roleTitle(role, names), 60) };
}

// "to dwight-m2", and how the delivery stands unless it simply arrived
function route(to, delivery, reason, stale = false) {
  const state = delivery === 'rejected' ? `rejected${reason ? `: ${cleanLine(reason, 120)}` : ''}`
    : delivery === 'unknown' ? 'delivery unknown'
      : delivery === 'queued' ? (stale ? 'queued, not picked up yet' : 'queued') : '';
  return [`to ${cleanLine(to, 64) || '?'}`, state].filter(Boolean).join(' · ');
}
const routeTone = (delivery) => (delivery === 'rejected' ? 'fail' : delivery === 'unknown' ? 'warn' : null);
// delivered and rejected are final, and a late queued echo does not undo an unknown outcome (as the reducer)
const keeps = (was, next) => was === 'delivered' || was === 'rejected' || (was === 'unknown' && next === 'queued');

// The line under a reply: the outcome, then the totals the run line shows.
function outcome(status, t) {
  const end = Date.parse(t.finishedAt ?? '') - Date.parse(t.startedAt ?? '');
  return [
    OUTCOME[status] ?? cleanLine(status, 24),
    t.total ? `${t.passed}/${t.total} milestones` : '',
    t.turns ? `${formatTokens(t.input + t.output)} tokens` : '',
    t.turns ? formatCost(t.cost) : '',
    Number.isFinite(end) && end >= 0 ? formatDuration(end) : '',
  ].filter(Boolean).join(' · ');
}

// The engine's own summary without what the page already shows around it: the status (the outcome line under the
// reply) and the request (the message the run starts with).
function plainSummary(raw, request) {
  const text = typeof raw === 'string' ? raw : '';
  const asked = cleanLine(request ?? '', 4000);
  const lines = text.replace(/^Run finished with status "[a-z_]+": */, '').split('\n')
    .filter((l) => !(asked && l.startsWith('Request: ') && cleanLine(l.slice(9), 4000) === asked));
  return lines.join('\n').trim() || text;
}

// One run from its events, in the order they happened.
function detail(runId, events, { state, listed, outbox }) {
  const names = namesFor(runId, events, state);
  // a run without agent messages (an older run, a CLI run, a recording) speaks through its mailbox summaries
  const conversation = events.some((e) => e.type === 'agent_message');
  const out = [];
  const lanes = new Map();
  const tools = new Map();
  const chats = new Map();
  const milestones = new Set();
  // the last message of every instance, and the lines of milestones that were aborted
  const spoken = new Map();
  const aborted = [];
  const t = { input: 0, output: 0, cost: 0, turns: 0, passed: 0, total: 0, startedAt: null, finishedAt: null };
  let asked = null;
  let reply = null;
  let request = null;

  for (const e of events) {
    switch (e.type) {
      case 'run_started':
        if (request) break;
        t.startedAt = ts(e);
        request = { id: `req-${runId}`, runId, kind: 'request', ts: ts(e), who: YOU, ...cleanText(e.request) };
        out.push(request);
        break;

      case 'instance_started':
        lanes.set(e.instanceId ?? e.id, e.milestoneId ?? null);
        break;

      case 'plan_ready': {
        const n = Array.isArray(e.milestones) ? e.milestones.length : 0;
        t.total = n;
        out.push({ id: `plan-${runId}-${e.seq}`, runId, kind: 'activity', ts: ts(e), text: `Plan ready: ${n} milestone${n === 1 ? '' : 's'}`, tone: null });
        break;
      }

      case 'agent_message': {
        tools.delete(e.instanceId || e.agent);
        const body = cleanText(e.text);
        // a turn that ends on the words it already said repeats them as its final message: said once, marked final
        const last = spoken.get(e.instanceId || e.agent);
        if (e.final === true && last && !last.final && last.text === body.text && last.context === where(e.milestoneId, e.cycle)) {
          last.final = true;
          break;
        }
        const plan = parsePlanText(body.text);
        const said = {
          id: `msg-${runId}-${e.seq}`, runId, kind: 'agent', ts: ts(e), who: sender(e.agent, names), context: where(e.milestoneId, e.cycle),
          text: body.text, final: e.final === true, truncated: body.truncated || e.truncated === true,
          // the planner's message is its plan as JSON: the view shows it as a plan
          ...(plan ? { plan } : {}),
        };
        spoken.set(e.instanceId || e.agent, said);
        out.push(said);
        break;
      }

      // the tools an instance uses between two of its messages are one line: how many, and the last one
      case 'agent_tool': {
        const key = e.instanceId || e.agent;
        const call = cleanLine(`${e.tool ?? ''} ${e.detail ?? ''}`, 160);
        const open = tools.get(key);
        if (open) {
          open.count += 1;
          open.entry.ts = ts(e);
          open.entry.text = `${open.count} tools, last: ${call}`;
          break;
        }
        const entry = { id: `tool-${runId}-${e.seq}`, runId, kind: 'activity', ts: ts(e), who: sender(e.agent, names), context: where(lanes.get(e.instanceId)), text: call, tone: null };
        tools.set(key, { entry, count: 1 });
        out.push(entry);
        break;
      }

      case 'agent_finished':
        tools.delete(e.instanceId || e.agent);
        t.turns += 1;
        t.input += Number(e.usage?.input) || 0;
        t.output += Number(e.usage?.output) || 0;
        t.cost += Number(e.usage?.cost) || 0;
        break;

      case 'hive_write':
        if (conversation || e.from === 'human' || e.kind === 'hitl' || !cleanLine(e.summary)) break;
        out.push({
          id: `note-${runId}-${e.seq}`, runId, kind: 'agent', ts: ts(e), who: sender(e.from, names),
          context: [cleanLine(e.milestoneId, 40), `${HIVE_KIND[e.kind] ?? cleanLine(e.kind, 24)} to ${sender(e.to, names).name}`].filter(Boolean).join(' · '),
          ...cleanText(e.summary), final: true,
        });
        break;

      case 'milestone_started':
        milestones.add(e.milestoneId);
        t.total = Math.max(t.total, Number.isInteger(e.total) ? e.total : 0, milestones.size);
        out.push({ id: `ms-${runId}-${e.seq}`, runId, kind: 'activity', ts: ts(e), text: cleanLine(`${e.milestoneId} started: ${e.title ?? ''}`, 200), tone: null });
        break;

      case 'milestone_finished':
        // a blocked milestone finishes without ever starting
        milestones.add(e.milestoneId);
        t.total = Math.max(t.total, milestones.size);
        if (e.status === 'passed') t.passed += 1;
        out.push({
          id: `ms-${runId}-${e.seq}`, runId, kind: 'activity', ts: ts(e),
          text: cleanLine(`${e.milestoneId} ${e.status}${e.reason ? `: ${e.reason}` : ''}`, 240), tone: MILESTONE_TONE[e.status] ?? 'fail',
        });
        if (e.status === 'aborted' && !e.reason) aborted.push(out.at(-1));
        break;

      case 'cycle_result':
        out.push({
          id: `cycle-${runId}-${e.seq}`, runId, kind: 'activity', ts: ts(e),
          text: cleanLine(`${e.milestoneId} cycle ${e.cycle} ${e.result}${e.reason ? `: ${e.reason}` : ''}`, 240), tone: e.result === 'passed' ? 'ok' : 'fail',
        });
        break;

      case 'gate_result':
        out.push({
          id: `gate-${runId}-${e.seq}`, runId, kind: 'activity', ts: ts(e), who: sender(e.agent, names), context: where(e.milestoneId, e.cycle),
          text: cleanLine(`gate ${e.result}${e.keyword ? ` [${e.keyword}]` : ''}`, 120), tone: GATE_TONE[e.result] ?? 'warn',
        });
        break;

      case 'chat_message': {
        const id = typeof e.id === 'string' && e.id ? e.id : `seq-${e.seq}`;
        const known = chats.get(id);
        const delivery = known && keeps(known.delivery, e.delivery) ? known.delivery : e.delivery;
        const reason = delivery === e.delivery ? e.reason : known?.reason;
        const human = e.from === 'human';
        const entry = known?.entry ?? {};
        Object.assign(entry, {
          id: `chat-${runId}-${id}`, runId, kind: human ? 'human' : 'agent', ts: ts(e), who: sender(e.from, names),
          context: route(e.to, delivery, reason), ...cleanText(e.text, 4000), tone: routeTone(delivery),
          ...(human ? {} : { final: false }),
        });
        if (!known) out.push(entry);
        chats.set(id, { entry, to: e.to, delivery, reason });
        break;
      }

      case 'chat_delivery': {
        const c = chats.get(e.id);
        if (!c || keeps(c.delivery, e.delivery)) break;
        c.delivery = e.delivery;
        c.reason = e.reason;
        c.entry.context = route(c.to, c.delivery, c.reason);
        c.entry.tone = routeTone(c.delivery);
        break;
      }

      case 'hitl_request':
        if (asked) asked.tone = null;
        asked = { id: `ask-${runId}-${e.seq}`, runId, kind: 'question', ts: ts(e), who: sender('michael', names), context: where(e.milestoneId), ...cleanText(e.reason), tone: 'warn' };
        out.push(asked);
        break;

      case 'hitl_response': {
        if (asked) asked.tone = null;
        asked = null;
        const chose = `You chose ${DECISION_LABEL[e.decision] ?? cleanLine(e.decision, 40)}`;
        const feedback = cleanText(e.feedback);
        out.push({
          id: `ans-${runId}-${e.seq}`, runId, kind: 'human', ts: ts(e), who: YOU, context: where(e.milestoneId),
          text: feedback.text.trim() ? `${chose}\n\n${feedback.text.trim()}` : chose, truncated: feedback.truncated, tone: null,
        });
        break;
      }

      case 'run_reply': {
        if (reply) break;
        const body = cleanText(e.from === 'system' ? plainSummary(e.text, request?.text) : e.text);
        reply = {
          id: `rep-${runId}`, runId, kind: 'reply', ts: ts(e), who: sender(e.from, names), context: '',
          text: body.text, truncated: body.truncated || e.truncated === true, tone: null,
          replyKind: REPLY_KINDS.includes(e.kind) ? e.kind : 'summary',
        };
        out.push(reply);
        break;
      }

      case 'run_finished':
        t.finishedAt = ts(e);
        // nobody answers a run that is over
        if (asked) asked.tone = null;
        asked = null;
        if (!reply) {
          reply = {
            id: `rep-${runId}`, runId, kind: 'reply', ts: ts(e), who: SYSTEM, context: '',
            ...cleanText(e.summary || `Run ${e.status ?? 'finished'}`), tone: null, replyKind: 'summary',
          };
          out.push(reply);
        }
        reply.tone = e.status === 'success' ? 'ok' : 'fail';
        reply.context = outcome(e.status, t);
        // an aborted run names its aborted milestones in its reply: their own lines would say it again
        if (e.status === 'aborted') for (const x of aborted) out.splice(out.indexOf(x), 1);
        break;

      default:
        break;
    }
  }

  // events that start after the request (a trimmed buffer): the run list still knows what was asked
  if (!request && listed?.goal) out.unshift({ id: `req-${runId}`, runId, kind: 'request', ts: listed.startedAt ?? '', who: YOU, ...cleanText(listed.goal) });
  // sent from this page, not echoed by the stream yet
  for (const o of outbox) {
    if (o.runId !== runId || chats.has(o.id)) continue;
    out.push({
      id: `chat-${runId}-${o.id}`, runId, kind: 'human', ts: typeof o.ts === 'string' ? o.ts : '', who: YOU,
      context: route(o.to, o.delivery, o.reason, o.stale === true), ...cleanText(o.text, 4000), tone: routeTone(o.delivery),
    });
  }
  return out;
}

// One run of the run list as it reads before its events are loaded: what was asked and what came back.
function digest(run) {
  const out = [{ id: `req-${run.runId}`, runId: run.runId, kind: 'request', ts: run.startedAt ?? '', who: YOU, ...cleanText(run.goal) }];
  const kind = REPLY_KINDS.includes(run.reply?.kind) ? run.reply.kind : 'summary';
  const body = cleanText(run.reply ? run.reply.text : run.summary || (OUTCOME[run.status] ? `Run ${run.status}` : ''));
  if (!body.text.trim()) return out;
  out.push({
    id: `rep-${run.runId}`, runId: run.runId, kind: 'reply', ts: run.endedAt ?? run.startedAt ?? '',
    who: kind === 'summary' ? SYSTEM : sender('michael', null), context: OUTCOME[run.status] ?? '',
    text: body.text, truncated: body.truncated || run.reply?.truncated === true,
    tone: OUTCOME[run.status] ? (run.status === 'success' ? 'ok' : 'fail') : null, replyKind: kind,
  });
  return out;
}

// events: Contract v1 events of any number of runs (the run on screen, earlier runs whose events were loaded).
// state: the reducer state of the run on screen. runs: the chat's run list (scope.js parseRuns), oldest first.
// outbox: messages this page sent that the stream has not echoed yet ([{ id, runId, to, text, delivery, ts, stale }]).
// -> Entry[] of the whole conversation, oldest first. A listed run without events is its request and its reply.
export function teamChatAdapter({ events = [], state = null, runs = [], outbox = [] } = {}) {
  const byRun = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string' || typeof e.runId !== 'string' || !e.runId) continue;
    if (!byRun.has(e.runId)) byRun.set(e.runId, []);
    byRun.get(e.runId).push(e);
  }
  const listed = new Map((Array.isArray(runs) ? runs : []).filter((r) => r && typeof r.runId === 'string').map((r) => [r.runId, r]));
  const order = [...listed.keys(), ...[...byRun.keys()].filter((id) => !listed.has(id))];
  const pending = Array.isArray(outbox) ? outbox : [];
  return order.flatMap((runId) => (byRun.has(runId)
    ? detail(runId, byRun.get(runId), { state, listed: listed.get(runId) ?? null, outbox: pending })
    : digest(listed.get(runId))));
}
