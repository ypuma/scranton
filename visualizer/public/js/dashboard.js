// Run line (status, elapsed, connection, key figures), alert bar and mailboxes. The milestones are the cards of
// the board (board.js).
import {
  PARTICIPANTS, displayName, theName, totals, humanNeeded, lanesOf, isBusy, workflowOf, workflowText, stepNames, customRoles,
  breakerTitle, checkView, stalledText, TRIP_WORD,
} from './state.js';
import { formatTokens, formatCost, formatDuration, formatWhen, runElapsed, plural } from './format.js';
import { countUp } from './motion.js';
import { statusTone, setTone } from './status-tone.js';

const STATUS_PILL = {
  idle: ['○', 'Idle'], planning: ['◐', 'Planning'], running: ['●', 'Running'], paused: ['■', 'Paused'],
  finished: ['✓', 'Finished'], aborted: ['✕', 'Aborted'], failed: ['✕', 'Failed'], exited: ['✕', 'Exited'],
};
// 'Connected', not 'Live': the word sits beside the run's status and must not read as the run being alive
const MODE_LABEL = { connecting: 'Connecting', live: 'Connected', reconnecting: 'Reconnecting', unavailable: 'Unavailable', demo: 'Demo' };
// a quiet stream needs no run line until a run exists
const QUIET_MODES = new Set(['live', 'demo']);

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// The breaker tile. A run with the progress check shows the last check of the milestone that tripped or is current:
// its cycle, verdict and reason, the cycles without progress against the limit and the tokens against the budget.
// An older run keeps the failed-cycle meter. -> { label, value, sub, reason, filled, of, tripped, progress }
export function breakerTile(s) {
  const tripped = s?.breaker === 'tripped';
  const ms = s?.milestones ?? [];
  const find = (id) => ms.find((x) => x.id === id);
  // the one that tripped, else the current one, else the parallel lane that was checked last
  const latest = (s?.activeMilestoneIds ?? []).map(find).filter((x) => x?.progressCheck).sort((a, b) => b.progressCheck.seq - a.progressCheck.seq)[0];
  const current = find(s?.currentMilestoneId);
  const m = find(s?.trip?.milestoneId) ?? (current?.progressCheck ? current : latest ?? current);
  const check = checkView(m);
  const cause = tripped ? s.trip?.cause : null;
  if (check) {
    const c = m.progressCheck;
    const parallel = (s.activeMilestoneIds?.length ?? 0) > 1;
    return {
      label: 'Progress', value: cause ? TRIP_WORD[cause] : tripped ? 'Tripped' : check.word,
      sub: [`${parallel ? `${m.id} ` : ''}cycle ${check.cycle ?? s.cycle}`, check.meter].filter(Boolean).join(' · '),
      reason: [check.how && `${check.word}, ${check.how}`, check.reason].filter(Boolean).join(': '),
      filled: c.stalledCycles ?? 0, of: c.maxStalledCycles ?? s.maxStalledCycles ?? 0, tripped, progress: true,
    };
  }
  if (s?.maxStalledCycles) {
    return {
      label: 'Progress', value: cause ? TRIP_WORD[cause] : tripped ? 'Tripped' : 'Closed',
      sub: stalledText({ stalledCycles: 0, maxStalledCycles: s.maxStalledCycles }), reason: '', filled: 0, of: s.maxStalledCycles, tripped, progress: false,
    };
  }
  const max = Math.max(1, s?.maxFailedCycles ?? 3);
  const failed = s?.failedCycles ?? 0;
  return { label: 'Breaker', value: tripped ? 'Tripped' : 'Closed', sub: `${failed}/${max} failed`, reason: '', filled: failed, of: max, tripped, progress: false };
}

function segments(container, fills) {
  container.replaceChildren(...fills.map((f) => {
    const i = document.createElement('i');
    i.dataset.fill = f;
    return i;
  }));
}

// hasRun(): whether the chat on screen has a run, for a chat whose runs the reducer state does not hold (a
// pipeline chat); null: the state says.
export function createDashboard({ hasRun = () => null } = {}) {
  const e = {
    runline: $('runline'), more: $('run-more'), moreToggle: $('run-more-toggle'), request: $('run-request'),
    runId: $('run-id'), pill: $('run-status'), elapsed: $('elapsed'), conn: $('conn'), connLabel: $('conn-label'),
    alert: $('alert'), alertTitle: $('alert-title'), alertDetail: $('alert-detail'), empty: $('empty'),
    kMs: $('kpi-milestones'), kMsBar: $('kpi-milestone-bar'), kMsSub: $('kpi-milestones-sub'),
    kCur: $('kpi-current'), kCurSub: $('kpi-current-sub'), kCurFig: $('kpi-current-fig'),
    kBrTile: $('kpi-breaker-tile'), kBrLabel: $('kpi-breaker-label'), kBr: $('kpi-breaker'), kBrMeter: $('kpi-breaker-meter'),
    kBrSub: $('kpi-breaker-sub'), kBrReason: $('kpi-breaker-reason'),
    kTok: $('kpi-tokens'), kTokSub: $('kpi-tokens-sub'), kCost: $('kpi-cost'), kCostSub: $('kpi-cost-sub'),
    kDur: $('kpi-duration'), kDurSub: $('kpi-duration-sub'), workflow: $('run-workflow'),
    pipeAside: $('pipeline-aside'),
    mail: $('mailboxes'), mailCount: $('inbox-count'), inboxes: $('inboxes'), announcer: $('announcer'),
  };
  e.moreToggle.addEventListener('click', () => {
    const open = e.more.hidden;
    e.more.hidden = !open;
    e.moreToggle.setAttribute('aria-expanded', String(open));
  });
  let mode = 'connecting';
  let modeInfo = {};
  let state = null;
  let mailKey = '';
  let announced = '';
  // where a human answers: 'terminal' | 'here' (control API answer panel) | 'exited' (the run process died)
  let humanWhere = 'terminal';

  function setMode(next, info = {}) {
    mode = next;
    modeInfo = info;
    e.conn.dataset.mode = next;
    e.connLabel.textContent = MODE_LABEL[next] ?? String(next);
    e.conn.title = info.error ?? info.reason ?? (next === 'live' ? 'Connected: streaming GET /events' : MODE_LABEL[next] ?? '');
    render(state);
  }

  function tick() {
    if (!state) return;
    const ms = runElapsed(state, { ticking: mode === 'live' && ['planning', 'running', 'paused'].includes(state.status) });
    const text = ms === null ? '-' : formatDuration(ms);
    e.elapsed.textContent = text;
    e.kDur.textContent = text;
  }

  function renderAlert(s) {
    let a = null;
    const where = humanWhere === 'here' ? '' : ' in the orchestrator terminal';
    if (humanNeeded(s) && humanWhere === 'exited') {
      a = { tone: 'critical', title: 'Run process exited while waiting for a human', detail: s.hitl?.reason ?? '' };
    } else if (humanNeeded(s) && breakerTitle(s)) {
      a = { tone: 'critical', kind: 'human', title: breakerTitle(s),
        detail: [`Human input required${where}.`, s.hitl?.reason].filter(Boolean).join(' ') };
    } else if (humanNeeded(s) && s.breaker === 'tripped') {
      a = { tone: 'critical', kind: 'human', title: `Circuit breaker tripped - human input required${where}`,
        detail: s.hitl?.reason ?? `${s.failedCycles}/${s.maxFailedCycles} consecutive failed cycles` };
    } else if (humanNeeded(s)) {
      a = { tone: 'critical', kind: 'human', title: `Paused - human input required${where}`, detail: s.hitl?.reason ?? '' };
    } else if (s?.status === 'exited') {
      const code = s.exit?.exitCode;
      a = { tone: 'critical', title: `Run process exited${code === null || code === undefined ? '' : ` with code ${code}`} before the run finished`,
        detail: 'No run_finished was recorded. The last state the run reported is shown; nothing is running any more.' };
    } else if (s?.result === 'aborted' || s?.result === 'failed') {
      // the Chat view leaves this one out as well: the reply and its outcome line say it
      a = { tone: 'critical', kind: 'ended', title: `Run ${s.result}`, detail: s.summary ?? '' };
    } else if (s?.result) {
      // the Chat view leaves this one out: its reply and the run line already say it
      a = { tone: 'info', kind: s.result === 'success' ? 'finished' : 'attention', title: `Run finished - ${s.result}`, detail: s.summary ?? '' };
    } else if (s?.breaker === 'tripped') {
      a = { tone: 'info', title: `${breakerTitle(s) ?? 'Circuit breaker tripped'} - resuming`, detail: s.lastDecision ? `Decision: ${s.lastDecision.decision}` : '' };
    } else if (modeInfo.error) {
      a = { tone: 'info', title: mode === 'unavailable' ? 'Chat stream unavailable' : 'Demo unavailable', detail: modeInfo.error };
    }
    e.alert.hidden = !a;
    if (!a) return;
    e.alert.dataset.tone = a.tone;
    e.alert.dataset.kind = a.kind ?? 'attention';
    e.alert.setAttribute('role', a.tone === 'critical' ? 'alert' : 'status');
    e.alertTitle.textContent = a.title;
    e.alertDetail.textContent = a.detail;
    e.alertDetail.title = a.detail;
  }

  function renderKpis(s) {
    const ms = s?.milestones ?? [];
    const passed = ms.filter((m) => m.status === 'passed').length;
    const skipped = ms.filter((m) => m.status === 'skipped').length;
    e.kMs.textContent = ms.length ? `${passed}/${ms.length}` : '-';
    e.kMsSub.textContent = ms.length ? (skipped ? `passed · ${skipped} skipped` : 'passed') : (s?.runId ? 'planning' : 'no plan');
    segments(e.kMsBar, ms.slice(0, 12).map((m) => (m.status === 'passed' ? 'full' : m.status === 'active' ? 'half' : ['skipped', 'blocked', 'interrupted'].includes(m.status) ? 'skip' : 'none')));

    const active = (s?.activeMilestoneIds ?? []).map((id) => ms.find((m) => m.id === id)).filter(Boolean);
    const cur = ms.find((m) => m.id === s?.currentMilestoneId);
    if (active.length > 1) {
      // parallel pipelines: one scalar "current" milestone would hide the others
      e.kCur.textContent = `${active.length} in parallel`;
      e.kCur.title = active.map((m) => `${m.id}: ${m.title}`).join('\n');
      e.kCurSub.textContent = `${active.map((m) => m.id).join(', ')}${s.execution?.maxParallel ? ` · max ${s.execution.maxParallel}` : ''}`;
    } else {
      e.kCur.textContent = cur ? `${cur.id} · ${cur.title}` : '-';
      e.kCur.title = cur ? cur.title : '';
      e.kCurSub.textContent = cur ? `cycle ${s.cycle} · ${s.milestoneIndex + 1} of ${s.milestoneTotal || ms.length}` : '-';
    }
    // between milestones, or after the last one, there is nothing current to show
    e.kCurFig.hidden = active.length <= 1 && !cur;

    const br = breakerTile(s);
    e.kBrLabel.textContent = br.label;
    e.kBr.textContent = br.value;
    e.kBrTile.dataset.critical = String(br.tripped);
    e.kBrTile.dataset.progress = String(br.progress);
    segments(e.kBrMeter, Array.from({ length: Math.min(br.of, 10) }, (_, i) => (i < br.filled ? 'full' : 'none')));
    e.kBrSub.textContent = br.sub;
    e.kBrReason.textContent = br.reason;
    e.kBrReason.title = br.reason;
    e.kBrReason.hidden = !br.reason;

    const t = s ? totals(s) : { runs: 0, durationMs: 0 };
    // the usage counts every model call as it is reported; the agents' totals only move when a turn has ended
    const u = s?.usage ?? { tokens: 0, input: 0, output: 0, cost: 0, calls: 0 };
    e.kTok.textContent = formatTokens(u.tokens);
    countUp(e.kTok, u.tokens, formatTokens);
    e.kTokSub.textContent = `in ${formatTokens(u.input)} · out ${formatTokens(u.output)}`;
    e.kCost.textContent = formatCost(u.cost);
    countUp(e.kCost, u.cost, formatCost);
    e.kCostSub.textContent = `${plural(t.runs, 'agent run')} · ${plural(u.calls, 'model call')}`;
    e.kDurSub.textContent = `agent time ${t.durationMs ? formatDuration(t.durationMs) : '-'}`;
    // the gates the engine reported for the run (an older run: the tests alone)
    e.workflow.textContent = s?.runId ? workflowText(workflowOf(s), stepNames(s)) : '-';
    e.workflow.title = s?.runId ? `Gates after each developer turn${s.workflow ? '' : ' (not reported: an older run)'}` : '';
  }

  function renderMail(s) {
    const ids = [...PARTICIPANTS.slice(0, -1), ...customRoles(s).map((r) => r.id), 'human'];
    // an inbox nobody wrote to says nothing: only the ones that hold a message are listed
    const boxes = s?.runId ? ids.filter((id) => s.mailboxes?.[id]) : [];
    const key = JSON.stringify([s?.runId, s?.mailboxes, boxes]);
    if (key === mailKey) return;
    mailKey = key;
    e.mailCount.textContent = String(boxes.length);
    e.inboxes.hidden = boxes.length === 0;
    e.mail.replaceChildren(...boxes.map((id) => {
      const m = s.mailboxes[id];
      const li = el('li', 'mailbox');
      li.dataset.read = String(Boolean(m.read));
      const head = el('div', 'mb-head');
      const dot = el('span', 'mb-unread', m.read ? '' : '●');
      dot.setAttribute('aria-label', m.read ? '' : 'unread');
      const time = el('span', 'mb-time mono', formatWhen(m.ts));
      time.title = m.ts ?? '';
      // the file is the hive's business: it is the title of the name, not a column
      const to = el('span', 'mb-to', displayName(id, s));
      to.title = m.file || `${id}/inbox.md`;
      head.append(dot, to, time);
      const meta = el('div', 'mb-meta');
      const kind = el('span', 'mb-kind', String(m.kind ?? 'note').replace('_', ' '));
      kind.dataset.kind = m.kind;
      // "from the Planner to the Developer (m2)"
      const inst = m.instance && m.instance !== id ? ` to ${theName(m.instance, s)}` : '';
      meta.append(kind, `from ${theName(m.from, s)}${inst}${m.read ? ' · read' : ' · unread'}`);
      const sum = el('p', 'mb-summary', m.summary);
      sum.title = m.summary;
      li.append(head, meta, sum);
      return li;
    }));
  }

  function announce(s) {
    const parts = [
      s?.status && `Run status ${s.status}`,
      s?.breaker === 'tripped' && (s.trip?.cause ? `circuit breaker tripped: ${TRIP_WORD[s.trip.cause].toLowerCase()}` : 'circuit breaker tripped'),
      (s?.activeMilestoneIds?.length ?? 0) > 1 ? `${s.activeMilestoneIds.length} milestones in parallel` : s?.currentMilestoneId && `milestone ${s.currentMilestoneId}`,
      s?.result && `result ${s.result}`,
    ].filter(Boolean);
    const text = parts.join(', ');
    if (text !== announced) {
      announced = text;
      e.announcer.textContent = text;
    }
  }

  function render(s) {
    state = s;
    const [glyph, label] = STATUS_PILL[s?.status ?? 'idle'] ?? STATUS_PILL.idle;
    e.pill.dataset.status = s?.status ?? 'idle';
    setTone(e.pill, statusTone(s?.status ?? 'idle'));
    e.pill.querySelector('.pill-glyph').textContent = glyph;
    e.pill.querySelector('.pill-text').textContent = label;
    e.runId.textContent = s?.runId ?? 'no run';
    e.runId.title = s?.runId ? `Run ${s.runId}${s.workspace ? ` in ${s.workspace}` : ''}` : 'No run yet';
    e.pill.title = e.runId.title;
    e.request.textContent = s?.request || '-';
    e.runline.hidden = !s?.runId && QUIET_MODES.has(mode);
    e.runline.dataset.run = String(Boolean(s?.runId));
    document.body.dataset.run = (hasRun() ?? Boolean(s?.runId)) ? 'yes' : 'none';
    e.empty.hidden = Boolean(s?.runId) || mode === 'demo';
    const lanes = s?.runId ? lanesOf(s) : [];
    const activeAgents = !s?.runId ? 0 : lanes.length ? lanes.filter(isBusy).length
      : Object.values(s.agents).filter((a) => a.status === 'working' || a.status === 'thinking').length;
    // the folder the agents work in is the tooltip: the project in the chat header already names it
    e.pipeAside.textContent = !s?.runId ? 'idle' : s.result || s.status === 'exited' ? '' : `${activeAgents} active`;
    e.pipeAside.title = s?.workspace ?? '';
    renderAlert(s);
    renderKpis(s);
    renderMail(s);
    announce(s);
    tick();
  }

  function setHumanWhere(next) {
    if (next === humanWhere) return;
    humanWhere = next;
    render(state);
  }

  return { render, setMode, tick, setHumanWhere };
}
