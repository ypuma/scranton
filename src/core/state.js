import { emptyUsage, foldUsage, amount } from './usage.js';
export const AGENT_IDS = ['michael', 'dwight', 'oscar', 'hank', 'angela'];

export function emptyAgents(now = new Date().toISOString()) {
  return Object.fromEntries(
    AGENT_IDS.map((id) => [
      id,
      { status: 'idle', activity: 'Idle', lastKeyword: null, updatedAt: now, totals: { runs: 0, input: 0, output: 0, cost: 0 } }
    ])
  );
}

export function initialState() {
  const now = new Date().toISOString();
  return {
    v: 1,
    runId: null,
    status: 'idle',
    request: null,
    workspace: null,
    updatedAt: now,
    lastSeq: 0,
    milestones: [],
    currentMilestoneId: null,
    activeMilestoneIds: [],
    instances: {},
    usage: emptyUsage(),
    usagePending: {},
    chat: [],
    execution: null,
    cycle: 0,
    failedCycles: 0,
    maxFailedCycles: 12,
    breaker: 'closed',
    agents: emptyAgents(now)
  };
}

const FINAL_STATUS = { success: 'finished', partial: 'finished', aborted: 'aborted', failed: 'failed' };
// Mailbox writes that start a new Dwight cycle.
const DWIGHT_CYCLE_KINDS = new Set(['task', 'bug_report', 'feedback']);

/** Pure reducer: state.json is always the fold of events.jsonl. Returns a new state. */
export function reduce(state, event) {
  const s = structuredClone(state);
  s.lastSeq = event.seq;
  s.updatedAt = event.ts;
  switch (event.type) {
    case 'run_started':
      Object.assign(s, initialState(), {
        runId: event.runId,
        status: 'planning',
        request: event.request,
        execution: event.execution ?? null,
        workspace: event.workspace,
        maxFailedCycles: event.maxFailedCycles,
        maxStalledCycles: event.maxStalledCycles,
        milestoneTokenBudget: event.milestoneTokenBudget,
        lastSeq: event.seq,
        updatedAt: event.ts,
        agents: emptyAgents(event.ts)
      });
      delete s.reply;
      delete s.progress;
      s.roles = structuredClone(event.roles ?? []);
      for (const role of s.roles) if (!s.agents[role.id]) s.agents[role.id] = structuredClone(s.agents.angela);
      break;
    case 'plan_ready':
      s.milestones = event.milestones.map((m) => ({ id: m.id, title: m.title, dependsOn: m.dependsOn ?? [], status: 'pending', cycle: 0, failedCycles: 0 }));
      s.status = 'running';
      break;
    case 'milestone_started':
      setMilestone(s, event.milestoneId, 'active');
      if (!s.activeMilestoneIds.includes(event.milestoneId)) s.activeMilestoneIds.push(event.milestoneId);
      s.currentMilestoneId = s.activeMilestoneIds[0] ?? null;
      s.cycle = 0;
      s.failedCycles = 0;
      s.breaker = 'closed';
      break;
    case 'hive_write':
      if (event.to === 'dwight' && DWIGHT_CYCLE_KINDS.has(event.kind)) {
        s.cycle += 1;
        const m = s.milestones.find((m) => m.id === event.milestoneId);
        if (m) m.cycle = event.cycle;
      }
      break;
    case 'instance_started':
      s.instances[event.instanceId] = { ...s.instances[event.instanceId], id: event.instanceId, agent: event.agent, milestoneId: event.milestoneId, sessionId: event.sessionId, worktree: event.worktree, sandbox: event.sandbox, status: 'thinking', activity: 'Thinking...', tool: null };
      break;
    case 'agent_tool': {
      const inst = s.instances[event.instanceId];
      if (inst) {
        inst.tool = { tool: event.tool, detail: event.detail, targetFile: event.targetFile ?? null, command: event.command ?? null, startedAt: event.ts };
        inst.lastTool = { ...inst.tool, ts: event.ts };
        if (event.targetFile && ['read', 'write', 'edit'].includes(event.tool)) inst.touchedFiles = [{ path: event.targetFile, kind: event.tool, ts: event.ts }, ...(inst.touchedFiles ?? []).filter(f => f.path !== event.targetFile)].slice(0, 8);
      }
      break;
    }
    case 'agent_usage': {
      const milestone = s.milestones.find((m) => m.id === event.milestoneId);
      if (milestone) {
        milestone.tokens = (milestone.tokens ?? 0) + amount(event.usage?.input) + amount(event.usage?.output);
        if (milestone.progress) milestone.progress.tokens = milestone.tokens;
      }
      const id = event.instanceId ?? event.agent;
      s.usage ??= emptyUsage(); s.usagePending ??= {};
      const pending = s.usagePending[id] ??= { input: 0, output: 0, cost: 0 };
      foldUsage(s.usage, event.agent, event.usage, event.ts);
      const a = s.agents[event.agent];
      for (const key of ['input', 'output', 'cost']) {
        const n = amount(event.usage?.[key]); pending[key] += n;
        if (a) a.totals[key] += n;
      }
      break;
    }
    case 'chat_message':
      s.chat.push({ id: event.id, ts: event.ts, from: event.from, to: event.to, text: event.text, delivery: event.delivery, reason: event.reason });
      s.chat = s.chat.slice(-200);
      break;
    case 'chat_delivery': {
      const message = s.chat.find((m) => m.id === event.id);
      if (message) Object.assign(message, { delivery: event.delivery, reason: event.reason });
      break;
    }
    case 'agent_status': {
      if (s.instances[event.instanceId]) Object.assign(s.instances[event.instanceId], { status: event.status, activity: event.activity, tool: event.status === 'working' ? s.instances[event.instanceId].tool : null });
      const a = s.agents[event.agent];
      if (a) Object.assign(a, { status: event.status, activity: event.activity, updatedAt: event.ts });
      if (event.instanceId && a) {
        const active = Object.values(s.instances).find((i) => i.agent === event.agent && ['thinking', 'working'].includes(i.status));
        if (active) Object.assign(a, { status: active.status, activity: active.activity ?? 'Thinking...' });
      }
      break;
    }
    case 'agent_finished': {
      const a = s.agents[event.agent];
      if (a) {
        a.lastKeyword = event.keyword ?? null;
        a.totals.runs += 1;
        s.usage ??= emptyUsage(); s.usagePending ??= {};
        const scoped = event.milestoneId ? `${event.agent}-${event.milestoneId}` : event.agent;
        const id = event.instanceId ?? (s.usagePending[scoped] ? scoped : event.agent), pending = s.usagePending[id];
        const delta = Object.fromEntries(['input', 'output', 'cost'].map(key => [key, Math.max(0, amount(event.usage?.[key]) - (pending?.[key] ?? 0))]));
        if (Object.values(delta).some(n => n > 0)) {
          foldUsage(s.usage, event.agent, delta, event.ts, pending ? 0 : 1);
          for (const key of ['input', 'output', 'cost']) a.totals[key] += delta[key];
        }
        delete s.usagePending[id];
      }
      break;
    }
    case 'cycle_result':
      { const m = s.milestones.find((m) => m.id === event.milestoneId); if (m) Object.assign(m, { cycle: event.cycle, failedCycles: event.failedCycles }); }
      s.failedCycles = event.failedCycles;
      break;
    case 'progress_check': {
      const m = s.milestones.find((m) => m.id === event.milestoneId);
      const progress = Object.fromEntries(['cycle', 'verdict', 'source', 'rule', 'reason', 'changed', 'stalledCycles', 'maxStalledCycles', 'tokens', 'tokenBudget'].map((key) => [key, event[key]]));
      if (m) Object.assign(m, { progress, stalledCycles: event.stalledCycles, tokens: event.tokens });
      s.progress = progress;
      break;
    }
    case 'circuit_breaker':
      { const m = s.milestones.find((m) => m.id === event.milestoneId);
        if (m) {
          m.breaker = event.state === 'tripped' ? 'tripped' : 'closed';
          m.failedCycles = event.failedCycles;
          if (event.stalledCycles !== undefined) Object.assign(m, { stalledCycles: event.stalledCycles, tokens: event.tokens });
          if (event.state === 'reset') { delete m.progress; if (s.currentMilestoneId === m.id) delete s.progress; }
          else m.breakerCause = event.cause;
        }
      }
      s.failedCycles = event.failedCycles;
      s.breaker = event.state === 'tripped' ? 'tripped' : 'closed';
      if (event.state === 'tripped') s.status = 'paused';
      break;
    case 'hitl_request':
      s.status = 'paused';
      break;
    case 'hitl_response':
      if (['feedback', 'retry'].includes(event.decision)) {
        const m = s.milestones.find((m) => m.id === event.milestoneId);
        if (m) { Object.assign(m, { failedCycles: 0, stalledCycles: 0, tokens: 0 }); delete m.progress; }
        if (s.currentMilestoneId === event.milestoneId) delete s.progress;
      }
      if (event.decision !== 'abort') s.status = 'running';
      break;
    case 'milestone_finished':
      setMilestone(s, event.milestoneId, event.status);
      s.activeMilestoneIds = s.activeMilestoneIds.filter((id) => id !== event.milestoneId);
      s.currentMilestoneId = s.activeMilestoneIds[0] ?? null;
      for (const i of Object.values(s.instances)) if (i.milestoneId === event.milestoneId) { i.status = 'done'; i.tool = null; }
      s.breaker = 'closed';
      s.failedCycles = 0;
      break;
    case 'run_reply':
      s.reply = { from: event.from, kind: event.kind, text: event.text, ...(event.truncated ? { truncated: true } : {}) };
      break;
    case 'run_finished':
      s.activeMilestoneIds = [];
      s.currentMilestoneId = null;
      for (const i of Object.values(s.instances)) { i.status = 'done'; i.tool = null; }
      s.status = FINAL_STATUS[event.status] ?? 'finished';
      s.breaker = 'closed';
      s.failedCycles = 0;
      break;
    default:
      break;
  }
  return s;
}

function setMilestone(s, id, status) {
  const m = s.milestones.find((x) => x.id === id);
  if (m) m.status = status;
}
