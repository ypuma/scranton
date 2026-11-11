// Run line (status, elapsed, connection, key figures), alert bar, milestones and mailboxes.
import {
  PARTICIPANTS, displayName, totals, humanNeeded, dependencyState, lanesOf, isLive, isBusy, activeRoles, workflowOf, workflowText, stepNames, customRoles,
} from './state.js';
import { formatTokens, formatCost, formatDuration, formatClock, runElapsed, plural } from './format.js';

const STATUS_PILL = {
  idle: ['○', 'Idle'], planning: ['◐', 'Planning'], running: ['●', 'Running'], paused: ['■', 'Paused'],
  finished: ['✓', 'Finished'], aborted: ['✕', 'Aborted'], failed: ['✕', 'Failed'], exited: ['✕', 'Exited'],
};
const MODE_LABEL = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', unavailable: 'Unavailable', demo: 'Demo' };
// a quiet stream needs no run line until a run exists
const QUIET_MODES = new Set(['live', 'demo']);
export const MS_GLYPH = { pending: '○', active: '●', passed: '✓', skipped: '–', failed: '✕', aborted: '✕', blocked: '■', interrupted: '✕' };
// What the badge says for a milestone that has not started, by dependencyState kind.
const DEP_BADGE = { waiting: 'waiting', queued: 'queued', blocked: 'blocked' };

// The dependency line under a milestone title, or '' when there is nothing to say.
export function dependencyText(dep, m) {
  if (dep.kind === 'blocked') return dep.on.length ? `blocked by ${dep.on.join(', ')}: a prerequisite did not pass` : 'blocked: a prerequisite did not pass';
  if (dep.kind === 'waiting') return `waiting on ${dep.on.join(', ')}`;
  if (dep.kind === 'queued') return 'prerequisites passed - waiting for a free parallel slot';
  if (dep.kind === 'met' && m.dependsOn?.length) return `after ${m.dependsOn.join(', ')}`;
  return '';
}

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
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
    kBrTile: $('kpi-breaker-tile'), kBr: $('kpi-breaker'), kBrMeter: $('kpi-breaker-meter'), kBrSub: $('kpi-breaker-sub'),
    kTok: $('kpi-tokens'), kTokSub: $('kpi-tokens-sub'), kCost: $('kpi-cost'), kCostSub: $('kpi-cost-sub'),
    kDur: $('kpi-duration'), kDurSub: $('kpi-duration-sub'), workflow: $('run-workflow'),
    milestones: $('milestones'), msAside: $('milestones-aside'), pipeAside: $('pipeline-aside'),
    mail: $('mailboxes'), mailCount: $('tab-count-mail'), announcer: $('announcer'),
  };
  e.moreToggle.addEventListener('click', () => {
    const open = e.more.hidden;
    e.more.hidden = !open;
    e.moreToggle.setAttribute('aria-expanded', String(open));
  });
  let mode = 'connecting';
  let modeInfo = {};
  let state = null;
  const openCriteria = new Set();
  let msKey = '';
  let msRun = null;
  let mailKey = '';
  let announced = '';
  // where a human answers: 'terminal' | 'here' (control API answer panel) | 'exited' (the run process died)
  let humanWhere = 'terminal';

  function setMode(next, info = {}) {
    mode = next;
    modeInfo = info;
    e.conn.dataset.mode = next;
    e.connLabel.textContent = MODE_LABEL[next] ?? String(next);
    e.conn.title = info.error ?? info.reason ?? (next === 'live' ? 'Live: streaming GET /events' : MODE_LABEL[next] ?? '');
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
      a = { tone: 'critical', title: `Run ${s.result}`, detail: s.summary ?? '' };
    } else if (s?.result) {
      // the Chat view leaves this one out: its reply and the run line already say it
      a = { tone: 'info', kind: s.result === 'success' ? 'finished' : 'attention', title: `Run finished - ${s.result}`, detail: s.summary ?? '' };
    } else if (s?.breaker === 'tripped') {
      a = { tone: 'info', title: 'Circuit breaker tripped - resuming', detail: s.lastDecision ? `Decision: ${s.lastDecision.decision}` : '' };
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

    const max = Math.max(1, s?.maxFailedCycles ?? 3);
    const failed = s?.failedCycles ?? 0;
    const tripped = s?.breaker === 'tripped';
    e.kBr.textContent = tripped ? 'Tripped' : 'Closed';
    e.kBrTile.dataset.critical = String(tripped);
    segments(e.kBrMeter, Array.from({ length: Math.min(max, 10) }, (_, i) => (i < failed ? 'full' : 'none')));
    e.kBrSub.textContent = `${failed}/${max} failed`;

    const t = s ? totals(s) : { tokens: 0, input: 0, output: 0, cost: 0, runs: 0, durationMs: 0 };
    e.kTok.textContent = formatTokens(t.tokens);
    e.kTokSub.textContent = `in ${formatTokens(t.input)} · out ${formatTokens(t.output)}`;
    e.kCost.textContent = formatCost(t.cost);
    e.kCostSub.textContent = plural(t.runs, 'agent run');
    e.kDurSub.textContent = `agent time ${t.durationMs ? formatDuration(t.durationMs) : '-'}`;
    // the gates the engine reported for the run (an older run: the tests alone)
    e.workflow.textContent = s?.runId ? workflowText(workflowOf(s), stepNames(s)) : '-';
    e.workflow.title = s?.runId ? `Gates after each developer turn${s.workflow ? '' : ' (not reported: an older run)'}` : '';
  }

  function renderMilestones(s) {
    const ms = s?.milestones ?? [];
    const lanes = s?.runId ? lanesOf(s).filter(isLive) : [];
    const key = JSON.stringify([s?.runId, ms, lanes.map((i) => [i.id, i.milestoneId, i.status])]);
    if (key === msKey) return;
    if ((s?.runId ?? null) !== msRun) openCriteria.clear();
    msRun = s?.runId ?? null;
    msKey = key;
    e.msAside.textContent = ms.length ? `${plural(ms.length, 'milestone')}` : '';
    if (!ms.length) {
      e.milestones.replaceChildren(el('li', 'placeholder', s?.runId ? 'Waiting for the plan...' : 'No milestones yet'));
      return;
    }
    e.milestones.replaceChildren(...ms.map((m, i) => {
      const li = el('li', 'ms');
      li.dataset.status = m.status;
      const dep = dependencyState(s, m);
      li.dataset.dep = dep.kind;
      const row = el('div', 'ms-row');
      const waiting = m.status === 'pending' ? DEP_BADGE[dep.kind] : null;
      row.append(
        el('span', 'ms-idx mono', String(i + 1).padStart(2, '0')),
        el('span', 'ms-glyph', waiting === 'blocked' ? MS_GLYPH.blocked : MS_GLYPH[m.status] ?? '○'),
        el('span', 'ms-title', m.title),
        el('span', 'ms-badge', waiting ?? m.status),
        el('span', 'ms-cycles mono', m.cycles ? plural(m.cycles, 'cycle') : '-'),
      );
      row.querySelector('.ms-title').title = `${m.id}: ${m.title}`;
      row.querySelector('.ms-glyph').setAttribute('aria-hidden', 'true');
      li.append(row);
      const deps = dependencyText(dep, m);
      if (deps) li.append(el('p', 'ms-deps', deps));
      const mine = lanes.filter((x) => x.milestoneId === m.id);
      if (mine.length && m.status === 'active') li.append(el('p', 'ms-lanes', mine.map((x) => `${x.id} ${x.status}`).join(' · ')));
      if (m.lastResult === 'failed' && m.status === 'active' && m.lastReason) {
        const p = el('p', 'ms-reason');
        p.append(el('b', '', 'last failure '), m.lastReason);
        li.append(p);
      }
      if (m.acceptanceCriteria.length || m.description) {
        const d = el('details');
        d.open = openCriteria.has(m.id);
        d.addEventListener('toggle', () => (d.open ? openCriteria.add(m.id) : openCriteria.delete(m.id)));
        const n = m.acceptanceCriteria.length;
        d.append(el('summary', '', n === 1 ? '1 acceptance criterion' : `${n} acceptance criteria`));
        if (m.description) d.append(el('p', 'ms-desc', m.description));
        const ul = el('ul', 'ms-criteria');
        ul.append(...m.acceptanceCriteria.map((c) => el('li', '', c)));
        d.append(ul);
        li.append(d);
      }
      return li;
    }));
  }

  function renderMail(s) {
    // only the inboxes of roles the run uses, plus anything a role outside it was sent anyway
    const roles = activeRoles(s);
    const ids = [...PARTICIPANTS.slice(0, -1), ...customRoles(s).map((r) => r.id), 'human'];
    const boxes = ids.filter((id) => id === 'human' || roles.includes(id) || (s?.runId && s.mailboxes?.[id]));
    const key = JSON.stringify([s?.runId, s?.mailboxes, boxes]);
    if (key === mailKey) return;
    mailKey = key;
    e.mailCount.textContent = String(s?.runId ? boxes.filter((id) => s.mailboxes?.[id]).length : 0);
    e.mail.replaceChildren(...boxes.map((id) => {
      const m = s?.runId ? s.mailboxes?.[id] : null;
      const li = el('li', 'mailbox');
      li.dataset.empty = String(!m);
      li.dataset.read = String(Boolean(m?.read));
      const head = el('div', 'mb-head');
      const dot = el('span', 'mb-unread', m && !m.read ? '●' : '');
      dot.setAttribute('aria-label', m && !m.read ? 'unread' : '');
      head.append(dot, el('span', 'mb-to', displayName(id, s)), el('span', 'mb-file mono', m?.file || `${id}/inbox.md`));
      if (m) {
        const time = el('span', 'mb-time mono', formatClock(m.ts));
        time.title = m.ts ?? '';
        head.append(time);
      }
      li.append(head);
      if (m) {
        const meta = el('div', 'mb-meta');
        const kind = el('span', 'mb-kind', String(m.kind ?? 'note').replace('_', ' '));
        kind.dataset.kind = m.kind;
        const to = m.instance && m.instance !== id ? ` to ${m.instance}` : '';
        meta.append(kind, `from ${displayName(m.from, s)}${to}${m.read ? ' · read' : ' · unread'}`);
        const sum = el('p', 'mb-summary', m.summary);
        sum.title = m.summary;
        li.append(meta, sum);
      } else {
        li.append(el('div', 'mb-meta', 'empty'));
      }
      return li;
    }));
  }

  function announce(s) {
    const parts = [
      s?.status && `Run status ${s.status}`,
      s?.breaker === 'tripped' && 'circuit breaker tripped',
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
    e.pipeAside.textContent = s?.runId ? `${activeAgents} active · ${s.workspace ?? ''}` : 'idle';
    e.pipeAside.title = s?.workspace ?? '';
    renderAlert(s);
    renderKpis(s);
    renderMilestones(s);
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
