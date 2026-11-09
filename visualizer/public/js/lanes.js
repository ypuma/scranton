// Instance lanes under the role overview: one row per planner / milestone instance (dwight-m1, angela-m1, ...)
// with its own status, worktree, sandbox and session, and a shortcut into the message composer.
import { lanesOf, isLive, isBusy, laneGate, displayName, roleTitle, own } from './state.js';
import { STATUS_GLYPH, GATE_GLYPH } from './pipeline.js';
import { plural } from './format.js';

const ROLE = { michael: 'Planner', dwight: 'Developer', oscar: 'Reviewer', hank: 'Security', angela: 'QA' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function badge(text, title = '', tone = '') {
  const b = el('span', 'badge', text);
  if (title) b.title = title;
  if (tone) b.dataset.tone = tone;
  return b;
}

const short = (id) => (id && id.length > 8 ? id.slice(0, 8) : id);

// The run-wide execution line: what the engine reported in run_started, never what the form asked for.
export function executionBadges(execution, { simulated = false } = {}) {
  const out = [];
  if (simulated || execution?.simulated) out.push(['simulated', 'Demo run with the scripted fake pi; no model and no sandbox boundary', 'quiet']);
  if (!execution) return out;
  if (execution.maxParallel) out.push([`max ${execution.maxParallel} parallel`, 'Milestone pipelines that may run at the same time', '']);
  if (execution.isolation) out.push([execution.isolation === 'worktree' ? 'worktrees' : execution.isolation, 'Isolation of each instance', '']);
  const sb = execution.sandbox;
  if (execution.trustedHost) {
    out.push(['trusted host', 'No sandbox: agent commands run directly on this computer', 'loud']);
  } else if (sb?.mode && !(simulated || execution.simulated)) {
    out.push([sb.mode, [sb.image && `image ${sb.image}`, sb.network && `network ${sb.network}`].filter(Boolean).join(' · ') || `sandbox ${sb.mode}`, '']);
  }
  return out;
}

// Badges of one lane, as the instance reported them.
export function laneBadges(inst, { simulated = false } = {}) {
  const out = [];
  const wt = inst.worktree;
  if (wt?.mode === 'worktree') out.push(['worktree', [wt.dir, wt.ref && `@ ${wt.ref}`].filter(Boolean).join(' ') || 'Isolated worktree', '']);
  else if (wt?.mode === 'shared') out.push(['shared', 'Works directly in the shared workspace', 'quiet']);
  const sb = inst.sandbox;
  if (simulated) {
    out.push(['simulated', 'Demo instance: scripted fake pi, no sandbox boundary', 'quiet']);
  } else if (sb?.mode === 'host') {
    out.push(['host', 'Trusted host: no sandbox boundary', 'loud']);
  } else if (sb?.mode) {
    out.push([sb.mode, [sb.image && `image ${sb.image}`, sb.network && `network ${sb.network}`].filter(Boolean).join(' · ') || `sandbox ${sb.mode}`, '']);
  }
  if (inst.sessionId) out.push([`session ${short(inst.sessionId)}`, `Session ${inst.sessionId} (kept across retries)`, '']);
  return out;
}

export function createLanes({ block, list, exec, onMessage }) {
  let key = '';
  let runMode = null;
  let canMessage = () => false;

  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-message]');
    if (b) onMessage?.(b.dataset.message);
  });

  function row(inst, simulated, s) {
    const li = el('li', 'lane');
    li.dataset.status = inst.status;
    li.dataset.agent = inst.agent ?? '';
    li.dataset.live = String(isLive(inst));
    const glyph = el('span', 'lane-glyph', STATUS_GLYPH[inst.status] ?? '○');
    glyph.setAttribute('aria-hidden', 'true');
    const id = el('div', 'lane-id');
    const name = el('span', 'lane-name mono', inst.id);
    name.title = inst.id;
    const where = inst.milestoneId && inst.milestoneId !== 'plan' ? ` · ${inst.milestoneId}` : '';
    // a custom gate is called by the title the run gave it
    id.append(name, el('span', 'lane-role', `${own(ROLE, inst.agent) ?? (roleTitle(inst.agent, s) || displayName(inst.agent, s))}${where}`));
    // a settled gate lane says its own result for the cycle instead of the keyword it finished with
    const gate = isBusy(inst) || ['starting', 'error', 'blocked'].includes(inst.status) ? null : laneGate(s, inst);
    const act = inst.tool ? `${inst.activity} · ${inst.tool.tool} ${inst.tool.detail}` : inst.activity;
    let activity;
    if (gate) {
      li.dataset.gate = gate.result;
      activity = el('p', 'lane-activity lane-verdict', `${GATE_GLYPH[gate.result] ?? ''} ${gate.label}${gate.cycle ? ` · cycle ${gate.cycle}` : ''}`);
      activity.title = [gate.label, gate.keyword].filter(Boolean).join(' · ');
    } else {
      activity = el('p', 'lane-activity mono', act || '-');
      activity.title = act || '';
    }
    const badges = el('div', 'lane-badges');
    badges.append(...laneBadges(inst, { simulated }).map(([t, title, tone]) => badge(t, title, tone)));
    li.append(glyph, id, el('span', 'lane-state', inst.status), activity, badges);
    if (canMessage(inst.id)) {
      const b = el('button', 'btn btn-small', 'Message');
      b.type = 'button';
      b.dataset.message = inst.id;
      b.setAttribute('aria-label', `Message ${inst.id}`);
      li.append(b);
    } else {
      li.append(el('span'));
    }
    return li;
  }

  function render(s) {
    const lanes = s?.runId ? lanesOf(s) : [];
    const simulated = runMode === 'demo' || Boolean(s?.execution?.simulated);
    const messageable = lanes.filter((i) => canMessage(i.id)).map((i) => i.id);
    const next = JSON.stringify([s?.runId, lanes, s?.execution, simulated, messageable, s?.activeMilestoneIds, s?.milestones?.map((m) => m.cycles)]);
    if (next === key) return;
    key = next;
    block.hidden = !lanes.length && !s?.execution;
    if (block.hidden) {
      list.replaceChildren();
      return;
    }
    const busy = lanes.filter((i) => i.status === 'working' || i.status === 'thinking').length;
    const slots = s.execution?.maxParallel ? `${s.activeMilestoneIds.length}/${s.execution.maxParallel} milestone slots` : `${s.activeMilestoneIds.length} active milestones`;
    exec.replaceChildren(
      el('span', '', `${plural(lanes.length, 'instance')} · ${busy} busy · ${slots}`),
      ...executionBadges(s.execution, { simulated }).map(([t, title, tone]) => badge(t, title, tone)),
    );
    // a rebuilt row must not drop the focus of a Message button the human is on
    const focused = document.activeElement?.closest?.('button[data-message]')?.dataset.message ?? null;
    if (!lanes.length) {
      list.replaceChildren(el('li', 'placeholder', 'No instance has started yet'));
      return;
    }
    list.replaceChildren(...lanes.map((i) => row(i, simulated, s)));
    if (focused) list.querySelector(`button[data-message="${CSS.escape(focused)}"]`)?.focus();
  }

  function setRunMode(next) {
    runMode = next;
  }

  function setMessageable(fn) {
    canMessage = fn;
  }

  return { render, setRunMode, setMessageable };
}
