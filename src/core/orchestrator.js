import { auditRole, BUILTIN_ROLES } from './agents-config.js';
import { activeRoles, normalizeWorkflow, PASS_KEYWORDS, ROLE_NAMES, GATE_ROLES } from './workflow.js';
import { stagePrompt, promptAudit, resolvePrompt } from './prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDag } from './scheduler.js';
import { ChatRouter } from './chat-router.js';
import { createDurableRuntime } from './durable/index.js';
import { createSandbox, createOwnedDirectory, credentialLocations, hardenCredentials } from './sandbox-native/index.js';
import { createSandbox as createDockerSandbox } from './sandbox-docker/index.js';
import { pollStop, rejectResponse, waitForResponse } from './file-control.js';
import { EventRecorder } from './events.js';
import { HITL_OPTIONS, createTerminalHitl, isInteractive } from './hitl.js';
import { Hive } from './hive.js';
import { dwightMessage, gateBugReport, handoffBody, humanNote, planRequestBody, summaryLine } from './messages.js';
import { startAgent, agentAppVersion } from './agent/index.js';
import { fallbackPlan, parsePlan, planToMarkdown } from './plan.js';
import { clip, excerpt, oneLine } from './util.js';
import { safePath } from './worktree.js';

/** Thrown to unwind the run on a human abort or Ctrl+C. */
class RunAborted extends Error {
  constructor(message, { signaled = false } = {}) {
    super(message);
    this.signaled = signaled;
  }
}

/**
 * Michael: the orchestrator. Plans, hands work between Dwight and Angela through the Hive,
 * counts failed cycles, trips the circuit breaker and asks the human.
 *
 * Options: config, request handling flags (noPlan, onBreaker 'ask'|'abort'|'skip'), `hitl(ctx, {signal})`
 * to inject decisions, `listener(event)` for live output, `extraEnv` for the agent invocations, stdin/stdout.
 */
export class Orchestrator {
  constructor({ config, noPlan = false, onBreaker = config.onBreaker ?? 'ask', hitl = null, listener = null, extraEnv = {}, stdin = process.stdin, stdout = process.stdout, startRunner = startAgent, sandboxFactory = createSandbox, dockerSandboxFactory = createDockerSandbox, runtimeFactory = createDurableRuntime, protectCredentials = hardenCredentials, threadContext = '', developerContext = '' }) {
    this.config = config;
    this.conversation = config.execution?.conversation === true;
    this.roles = structuredClone(config.roles ?? BUILTIN_ROLES);
    if (this.conversation) this.roles.find((r) => r.id === 'michael').keywords = ['PLAN_READY', 'ANSWER_READY', 'REPORT_READY'];
    this.reports = new Map();
    this.milestoneReasons = new Map();
    this.roleMap = Object.fromEntries(this.roles.map((r) => [r.id, r]));
    this.names = Object.fromEntries(this.roles.map((r) => [r.id, r.name]));
    this.passes = Object.fromEntries(this.roles.map((r) => [r.id, r.passKeyword]));
    this.gates = this.roles.filter((r) => r.kind === 'gate').map((r) => r.id);
    this.workflow = normalizeWorkflow(config.workflow, this.gates);
    this.legacyGates = JSON.stringify(this.workflow.gates) === '[["angela"]]';
    this.threadContext = threadContext;
    this.developerContext = developerContext;
    this.startRunner = startRunner;
    this.sandboxFactory = sandboxFactory;
    this.dockerSandboxFactory = dockerSandboxFactory;
    this.runtimeFactory = runtimeFactory;
    this.protectCredentials = protectCredentials;
    this.invocations = new Map();
    this.noPlan = noPlan;
    this.onBreaker = onBreaker;
    this.hitl = hitl;
    this.extraEnv = extraEnv;
    this.stdin = stdin;
    this.stdout = stdout;
    this.hive = new Hive(config.hiveDir);
    this.rec = new EventRecorder({ hiveDir: this.hive.dir, ...(extraEnv.SCRANTON_RUN_ID ? { runId: extraEnv.SCRANTON_RUN_ID } : {}) });
    if (listener) this.rec.subscribe(listener);
    this.aborting = null;
    this.active = new Map();
    this.instances = new Map();
    this.humanTail = Promise.resolve();
    this.abortController = new AbortController();
    this.prompts = {};
    this.cleanupComplete = true;
  }

  get runId() {
    return this.rec.runId;
  }

  /** Ctrl+C: kill the active agent and unwind; run() then emits run_finished(aborted). */
  abort(reason = 'Interrupted by the user (Ctrl+C)') {
    this.aborting ??= reason;
    this.rec.live?.close();
    this.abortController.abort();
    for (const runner of this.active.values()) void runner.kill('user');
  }

  emit(type, fields) {
    if (this.conversation && fields?.milestoneId && fields.reason && ['cycle_result', 'hitl_request', 'milestone_finished'].includes(type)) this.milestoneReasons.set(fields.milestoneId, String(fields.reason).slice(0, 1000));
    if (type === 'run_started' && !this.conversation) {
      fields = { ...fields, execution: { ...fields.execution } };
      delete fields.execution.conversation;
    }
    return this.rec.emit(type, fields);
  }

  log(level, message) {
    this.emit('log', { level, message });
  }

  #checkAbort() {
    if (this.aborting) throw new RunAborted(this.aborting, { signaled: true });
  }

  setStatus(agent, status, activity, instanceId) {
    this.emit('agent_status', { agent, status, activity: ['error', 'blocked'].includes(status) ? clip(String(activity ?? '').split(/\r?\n/)[0], 300) : clip(activity, 80), ...(instanceId ? { instanceId } : {}) });
  }

  async run(request, { threadContext = this.threadContext, developerContext = this.developerContext } = {}) {
    const { config } = this;
    let result = { status: 'failed', summary: '', signaled: false };
    this.request = String(request).trim();
    this.threadContext = typeof threadContext === 'string' ? threadContext : '';
    this.developerContext = '';
    for (const line of (typeof developerContext === 'string' ? developerContext.trim() : '').split(/\r?\n/)) {
      if (this.developerContext.length + line.length + 1 > 8100) break;
      this.developerContext += `${line}\n`;
    }
    this.developerContext = this.developerContext.trimEnd();
    try {
      fs.mkdirSync(config.workspace, { recursive: true });
      this.hive.init();
      this.rec.start();
    } catch (err) {
      return { runId: this.runId, status: 'failed', summary: `cannot prepare workspace/hive: ${err.message}`, signaled: false };
    }
    let started = false, stopTimer;
    try {
    try {
      const roles = this.standaloneAgent ? [this.standaloneAgent] : activeRoles(config, this.noPlan);
      this.promptSnapshot = Object.fromEntries(roles.map((id) => [id, resolvePrompt(config, id)]));
      if (this.conversation && this.promptSnapshot.michael) this.promptSnapshot.michael.text += '\n\n## Conversation mode\n\nThe "Required answer" section of each request decides between a plan ([PLAN_READY]), a direct answer ([ANSWER_READY]) and a report ([REPORT_READY]). This overrides any earlier rule to always reply with a plan.';
      this.emit('run_started', { request: this.request, workspace: config.workspace, maxFailedCycles: config.maxFailedCycles, execution: { ...config.execution, workflow: this.workflow }, roles: roles.map((id) => auditRole({ ...this.roleMap[id], tools: config.agents[id].tools })), prompts: promptAudit(config, this.promptSnapshot) });
      started = true;
      stopTimer = pollStop(this.hive.dir, this.runId, (reason) => this.abort(reason), (level, message) => this.log(level, message));
      for (const w of config.warnings ?? []) this.log('warn', w);
      this.#prepare();
      this.runtime = await this.runtimeFactory({ hiveDir: this.hive.dir, markerDir: path.join(this.hive.dir, 'agent-step-markers'), executorId: `run:${this.runId}`, appVersion: await agentAppVersion() });
      if (config.execution?.isolation === 'worktree') {
        const { WorktreeManager } = await import('./worktree.js');
        this.worktrees = new WorktreeManager({ workspace: config.workspace, hiveDir: this.hive.dir, runId: this.runId });
        await this.worktrees.init();
      }
      this.chat = new ChatRouter({ hiveDir: this.hive.dir, runId: this.runId, emit: (type, fields) => this.emit(type, fields) });
      this.chat.register('michael');
      this.chatTimer = setInterval(() => void this.chat.consume().catch((err) => this.log('error', err.message)), 100);
      if (this.standaloneAgent) {
        const role = this.standaloneAgent;
        this.chat.register(role);
        this.#deliver({ to: role, from: 'human', kind: 'task', body: this.request, summary: oneLine(this.request) });
        const agentResult = await this.#runAgent(role, { milestone: null, cycle: null });
        result = { status: agentResult.ok ? 'success' : 'failed', summary: agentResult.failure?.message ?? 'Standalone isolated invocation complete; changes retained in private worktree, not integrated', text: agentResult.text, keyword: agentResult.keyword };
      } else {
      const plan = this.noPlan ? this.#planWithoutMichael() : await this.#plan();
      this.chat.finish('michael');
      this.setStatus('michael', 'done', 'Planning complete', this.instances.has('michael') ? 'michael' : undefined);
      if (plan.answer !== undefined) {
        this.reply = this.#reply('michael', 'answer', plan.answer);
        result = { status: 'success', summary: 'Answered by Michael' };
      } else {
      for (const m of plan.milestones) for (const role of ['dwight', ...this.workflow.gates.flat()]) this.chat.register(`${role}-${m.id}`);
      const outcomes = await runDag(plan.milestones, {
        maxParallel: config.execution?.maxParallel ?? 1,
        signal: this.abortController.signal,
        run: async (m, index, completed) => {
          try { return await this.#runMilestone(m, index, plan.milestones.length, completed); }
          catch (err) { this.abort(err.message); throw err; }
          finally { for (const role of ['dwight', ...this.workflow.gates.flat()]) this.chat.finish(`${role}-${m.id}`); }
        },
        blocked: async (m, dependencies) => {
          this.emit('milestone_finished', { milestoneId: m.id, status: 'blocked', reason: `Prerequisites did not pass: ${dependencies.join(', ')}` });
          for (const role of ['dwight', ...this.workflow.gates.flat()]) this.chat.finish(`${role}-${m.id}`);
        }
      });
      this.#checkAbort();
      const passed = outcomes.filter((s) => s === 'passed').length;
      const incomplete = outcomes.length - passed;
      const counts = ['passed', 'skipped', 'blocked', 'failed', 'aborted']
        .map((status) => [status, outcomes.filter((s) => s === status).length])
        .filter(([, count]) => count > 0);
      result = {
        status: incomplete === 0 ? 'success' : 'partial',
        summary: incomplete === 0 ? `All ${passed} milestone${passed === 1 ? '' : 's'} passed` : counts.map(([status, count]) => `${count} ${status}`).join(', ')
      };
      }
      }
    } catch (err) {
      if (!started) this.emit('run_started', { roles: [], request: this.request, workspace: config.workspace, maxFailedCycles: config.maxFailedCycles, execution: { ...config.execution, workflow: this.workflow } });
      if (err instanceof RunAborted) {
        result = { status: 'aborted', summary: err.message, signaled: err.signaled };
      } else {
        this.log('error', err.message);
        result = { status: 'failed', summary: err.message, signaled: false };
      }
    }
    if (this.conversation && !this.reply && !this.noPlan && !this.standaloneAgent && !this.aborting && ['success', 'partial'].includes(result.status) && this.rec.state.milestones.some((m) => m.cycle > 0)) {
      try { await this.#report(result); }
      catch (err) { this.log('warn', `Report unavailable: ${err.message}`); }
    }
    clearInterval(stopTimer);
    clearInterval(this.chatTimer);
    await Promise.allSettled([...this.active.values()].map(async (runner) => { await runner.kill('user'); await runner.done; }));
    await this.chat?.close();
    await this.worktrees?.close();
    const idle = result.status === 'success' || result.status === 'partial' ? ['done', 'Done for this run'] : ['idle', 'Idle'];
    for (const id of activeRoles(this.config)) this.setStatus(id, ...idle);
    if (this.conversation && this.rec.state.execution?.conversation === true) this.emit('run_reply', this.reply ?? this.#reply('system', 'summary', this.#digest(result)));
    this.emit('run_finished', { status: result.status, summary: result.summary });
    return { runId: this.runId, signaled: false, ...result, cleanupComplete: this.cleanupComplete };
    } finally {
      clearInterval(stopTimer); clearInterval(this.chatTimer);
      await Promise.allSettled([...this.active.values()].map(async runner => { await runner.kill('user'); await runner.done; }));
      try { await this.chat?.close(); }
      finally { try { await this.worktrees?.close(); } finally { await this.runtime?.shutdown(); } }
    }
  }

  #prepare() {
    const mode = this.config.execution?.sandbox?.mode ?? 'scranton';
    if (!['scranton', 'docker', 'host'].includes(mode)) throw new Error('Unsupported execution sandbox mode');
    if (mode === 'scranton' && this.config.execution?.isolation !== 'worktree') throw new Error('Scranton sandbox requires private worktree isolation');
    for (const id of Object.keys(this.promptSnapshot)) {
      this.prompts[id] = stagePrompt(this.config, this.hive, id, id, this.promptSnapshot[id]);
    }
  }

  // ---- planning -------------------------------------------------------------------------

  #planWithoutMichael() {
    const plan = fallbackPlan(this.request);
    this.#publishPlan(plan);
    return plan;
  }

  #publishPlan(plan) {
    this.hive.writePlan({ runId: this.runId, request: this.request, plan, markdown: planToMarkdown(this.request, plan) });
    this.emit('plan_ready', { milestones: plan.milestones });
  }

  async #plan() {
    const contextLines = this.threadContext.trim().split(/\r?\n/);
    let context = '';
    for (const line of contextLines) {
      if (context.length + line.length + 1 > 800100) break;
      context += `${line}\n`;
    }
    const planningInput = (context.trim() ? `## Earlier turns and project context - context only; the new goal below takes precedence\n\n<earlier-runs>\n${context.replace(/<\s*\/?\s*earlier-runs\s*>/gi, '[earlier-runs]')}</earlier-runs>\n\n` : '') + planRequestBody(this.request, this.conversation);
    let body = planningInput;
    let kind = 'plan_request';
    let from = 'human';
    for (;;) {
      this.setStatus('michael', 'thinking', 'Planning milestones...');
      this.#deliver({ to: 'michael', from, kind, body, summary: `Plan: ${oneLine(this.request)}` });
      const result = await this.#runAgent('michael', { milestone: null, cycle: null });
      if (!result.ok) {
        const reason = `Michael could not plan: ${result.failure.message}`;
        const choice = await this.#askHuman({ milestoneId: null, title: 'Planning failed', reason, feedbackTarget: 'Michael', skipLabel: 'skip planning (one milestone)' });
        if (choice.decision === 'abort') throw new RunAborted('Aborted by the human during planning');
        if (choice.decision === 'skip') {
          this.log('warn', 'Planning skipped by the human; using one milestone for the whole request');
          return this.#planWithoutMichael();
        }
        if (choice.decision === 'feedback') {
          body = `${planningInput}\n\n## Human feedback\n\n${choice.feedback}`;
          kind = 'feedback';
          from = 'human';
        } else {
          kind = 'plan_request';
        }
        continue;
      }
      if (this.conversation && result.keyword === 'ANSWER_READY') return { answer: result.text };
      if (result.keyword !== 'PLAN_READY') this.log('warn', "Michael's answer did not end with [PLAN_READY]; using the plan it contains");
      const parsed = parsePlan(result.text);
      if (parsed.error) {
        this.log('warn', `Michael's plan is unusable (${parsed.error}); falling back to one milestone for the whole request`);
        return this.#planWithoutMichael();
      }
      this.#publishPlan(parsed);
      return parsed;
    }
  }

  #reply(from, kind, text) {
    const clean = String(text).replace(/\[(?:ANSWER_READY|REPORT_READY)\]\s*$/, '').trim();
    return { from, kind, text: clean.slice(0, 16000), ...(clean.length > 16000 ? { truncated: true } : {}) };
  }

  #digest(result) {
    const statuses = this.rec.state.milestones.map((m) => `- ${m.id} ${m.title}: ${m.status} (cycle ${m.cycle})${this.milestoneReasons.has(m.id) ? `: ${this.milestoneReasons.get(m.id)}` : ''}`);
    return `Run finished with status "${result.status}": ${result.summary}\n${statuses.join('\n')}\nRequest: ${this.request}`.slice(0, 8000);
  }

  async #report(result) {
    try {
      const instruction = '\n\nWrite the closing report from this digest only. Do not inspect or change files. End with [REPORT_READY] on its own last line.';
      const reports = [...this.reports].map(([id, text]) => `${id}: ${text.slice(0, 1000)}`).join('\n');
      const body = (this.#digest(result) + '\nLast agent reports:\n' + reports).slice(0, 8000 - instruction.length) + instruction;
      this.setStatus('michael', 'thinking', 'Writing the report...');
      this.#deliver({ to: 'michael', from: 'human', kind: 'report_request', body, summary: 'Closing report' });
      this.chat.register('michael');
      if (this.instances.has('michael')) this.instances.get('michael').sessionId = randomUUID();
      const report = await this.#runAgent('michael', { milestone: null, cycle: null, report: true });
      if (!this.aborting && report.ok && report.keyword === 'REPORT_READY') this.reply = this.#reply('michael', 'report', report.text);
    } finally { this.chat.finish('michael'); }
  }

  // ---- milestones -----------------------------------------------------------------------

  async #runMilestone(m, index, total, completed) {
    const { maxFailedCycles } = this.config;
    this.emit('milestone_started', { milestoneId: m.id, index, total, title: m.title });
    this.setStatus('michael', 'waiting', `Overseeing ${m.id}: ${m.title}`);
    const ctx = { milestone: m, request: this.request, completed, chatContext: this.developerContext };
    let stage = 0;
    let cycle = 0;
    let failed = 0;
    let phase = 'dwight';
    let needDeliver = true;
    let inbox = { kind: 'task', from: 'michael', body: dwightMessage({ kind: 'task', ...ctx }), summary: `${m.id}: ${m.title}` };
    let gateFailureInbox = null;
    let angelaReport = null;
    let gateReports = null;
    let dwightReport = null;

    const feedbackInbox = (text, note = null) => ({
      kind: 'feedback',
      from: 'human',
      body: dwightMessage({ kind: 'feedback', ...ctx, humanFeedback: text, angelaReport, gateReports, note }),
      summary: `Human feedback: ${text}`
    });
    const retryInbox = () =>
      gateFailureInbox ?? (angelaReport
        ? { kind: 'bug_report', from: 'angela', body: dwightMessage({ kind: 'bug_report', ...ctx, angelaReport }), summary: `QA failed: ${summaryLine(angelaReport)}` }
        : { kind: 'task', from: 'michael', body: dwightMessage({ kind: 'task', ...ctx }), summary: `${m.id}: ${m.title}` });

    // Counts a failed cycle; returns 'skipped' when the human skips the milestone after a trip.
    const failCycle = async (reason, next) => {
      failed += 1;
      this.emit('cycle_result', { milestoneId: m.id, cycle, result: 'failed', failedCycles: failed, reason });
      phase = 'dwight';
      needDeliver = true;
      inbox = next;
      if (failed < maxFailedCycles) return null;
      this.emit('circuit_breaker', { milestoneId: m.id, state: 'tripped', failedCycles: failed, maxFailedCycles });
      const choice = await this.#askHuman({
        milestoneId: m.id,
        title: `Circuit breaker: ${m.id} failed ${failed} cycles in a row`,
        reason: `${failed} consecutive failed cycles on ${m.id} "${m.title}". Last: ${reason}`,
        excerpt: gateReports ? excerpt(gateFailureInbox.body) : angelaReport ? excerpt(angelaReport) : null,
        ...(gateReports ? { excerptLabel: 'Gate reports' } : {})
      });
      if (choice.decision === 'abort') throw new RunAborted(`Aborted by the human at ${m.id}`);
      failed = 0;
      this.emit('circuit_breaker', { milestoneId: m.id, state: 'reset', failedCycles: 0, maxFailedCycles });
      if (choice.decision === 'skip') return 'skipped';
      if (choice.decision === 'feedback') inbox = feedbackInbox(choice.feedback);
      else inbox = retryInbox();
      return null;
    };

    // Handles a Dwight/Angela pause (infrastructure failure or [BLOCKED]); returns 'skipped' to skip.
    const pause = async (agent, reason, text) => {
      const choice = await this.#askHuman({
        milestoneId: m.id,
        title: `${this.names[agent]} needs a human on ${m.id}`,
        reason,
        excerpt: text ? excerpt(text) : null,
        excerptLabel: `${this.names[agent]}'s output`
      });
      if (choice.decision === 'abort') throw new RunAborted(`Aborted by the human at ${m.id}`);
      if (choice.decision === 'skip') return 'skipped';
      if (choice.decision === 'feedback') {
        inbox = feedbackInbox(choice.feedback, agent === 'dwight' && text ? `Your previous attempt ended with:\n\n${excerpt(text, 40, 3000)}` : null);
        phase = 'dwight';
        needDeliver = true;
      }
      return null;
    };

    try {
      for (;;) {
        this.#checkAbort();
        if (phase === 'dwight') {
          if (needDeliver) {
            cycle += 1;
            this.#deliver({ to: 'dwight', milestone: m.id, cycle, ...inbox });
            needDeliver = false;
          }
          const r = await this.#runAgent('dwight', { milestone: m.id, cycle });
          if (!r.ok) {
            if ((await pause('dwight', `Dwight could not run: ${r.failure.message}`, null)) === 'skipped') break;
          } else if (r.keyword === 'BLOCKED') {
            if ((await pause('dwight', `Dwight reported [BLOCKED]: ${summaryLine(r.text)}`, r.text)) === 'skipped') break;
          } else if (r.keyword === 'TASK_COMPLETE') {
            if (this.worktrees) {
              try {
                await this.worktrees.snapshotWorktree({ agent: 'dwight', milestoneId: m.id });
                const qa = this.legacyGates ? await this.worktrees.createQaWorktree({ milestoneId: m.id }) : null;
                if (qa) {
                this.instances.get(`angela-${m.id}`) && (this.instances.get(`angela-${m.id}`).worktree = qa.dir);
                this.qaDirs ??= new Map(); this.qaDirs.set(m.id, qa.dir);
                }
              } catch (err) {
                if ((await pause('dwight', `Developer snapshot / QA preparation failed: ${err.message}`, r.text)) === 'skipped') break;
                continue;
              }
            }
            dwightReport = r.text;
            stage = 0;
            phase = 'angela';
            needDeliver = true;
            inbox = { kind: 'handoff', from: 'dwight', body: handoffBody({ milestone: m, request: this.request, cycle, dwightReport, role: 'angela', definition: this.roleMap.angela }), summary: `Dwight finished ${m.id}: ${summaryLine(r.text)}` };
          } else {
            const next = { kind: 'task', from: 'michael', body: dwightMessage({ kind: 'task', ...ctx, angelaReport, gateReports, note: `Your previous attempt ended without the [TASK_COMPLETE] keyword. Finish the work and end your final message with [TASK_COMPLETE] (or [BLOCKED] if you cannot continue).\n\nIts last output:\n\n${excerpt(r.text, 30, 2000)}` }), summary: `${m.id}: previous attempt had no [TASK_COMPLETE]` };
            if ((await failCycle('Dwight finished without [TASK_COMPLETE]', next)) === 'skipped') break;
          }
        } else {
          if (!this.legacyGates) {
            const roles = this.workflow.gates[stage];
            const preparations = await Promise.allSettled(roles.map(async (agent) => {
              try {
                if (this.worktrees) {
                  const checkout = await this.worktrees.createGateWorktree({ agent, milestoneId: m.id });
                  this.gateDirs ??= new Map(); this.gateDirs.set(`${agent}-${m.id}`, checkout.dir);
                  if (this.instances.has(`${agent}-${m.id}`)) this.instances.get(`${agent}-${m.id}`).worktree = checkout.dir;
                }
                this.#checkAbort();
                return null;
              } catch (error) { return error; }
            }));
            this.#checkAbort();
            const settled = await Promise.allSettled(roles.map(async (agent, i) => {
              try {
                const preparation = preparations[i];
                if (preparation.status === 'rejected') throw preparation.reason;
                if (preparation.value) throw preparation.value;
                this.#deliver({ to: agent, milestone: m.id, cycle, ...inbox, body: handoffBody({ milestone: m, request: this.request, cycle, dwightReport, role: agent, definition: this.roleMap[agent], isolation: this.config.execution.isolation, docker: this.config.execution.sandbox?.mode === 'docker', changedFiles: this.worktrees?.changedFiles({ milestoneId: m.id }) }) });
                const result = await this.#runAgent(agent, { milestone: m.id, cycle });
                this.emit('gate_result', { milestoneId: m.id, cycle, stage, agent, instanceId: `${agent}-${m.id}`, result: !result.ok ? 'error' : result.keyword === 'BLOCKED' ? 'blocked' : result.keyword === this.passes[agent] ? 'passed' : 'failed', keyword: result.keyword ?? null });
                return result;
              } catch (error) {
                if (this.aborting) throw error;
                this.emit('gate_result', { milestoneId: m.id, cycle, stage, agent, instanceId: `${agent}-${m.id}`, result: 'error', keyword: null });
                return { ok: false, failure: { message: error.message }, text: '', keyword: null };
              }
            }));
            this.#checkAbort();
            const rejected = settled.find((r) => r.status === 'rejected');
            if (rejected) throw rejected.reason;
            const results = settled.map((r) => r.value);
            const blocked = results.findIndex((r) => !r.ok || r.keyword === 'BLOCKED');
            if (blocked >= 0) {
              const r = results[blocked], agent = roles[blocked];
              if ((await pause(agent, `${this.names[agent]}: ${r.failure?.message ?? summaryLine(r.text)}`, r.text)) === 'skipped') break;
              continue;
            }
            const failures = results.flatMap((r, i) => r.keyword === this.passes[roles[i]] ? [] : [{ agent: roles[i], name: this.roleMap[roles[i]].name, title: this.roleMap[roles[i]].builtin ? undefined : this.roleMap[roles[i]].title, ...r }]);
            if (failures.length) {
              gateReports = failures;
              const reason = failures.length === 1 ? `${this.names[failures[0].agent]} reported [${failures[0].keyword ?? 'MISSING_KEYWORD'}]: ${summaryLine(failures[0].text)}` : `Stage ${stage + 1} failed: ${failures.map((r) => `${this.names[r.agent]} [${r.keyword ?? 'MISSING_KEYWORD'}]`).join(', ')}`;
              const body = gateBugReport({ failures, ...ctx });
              gateFailureInbox = { kind: 'bug_report', from: failures[0].agent, body, summary: reason };
              if ((await failCycle(reason, gateFailureInbox)) === 'skipped') break;
              continue;
            }
            stage += 1;
            if (stage < this.workflow.gates.length) continue;
            if (this.worktrees) {
              try {
                const integration = await this.worktrees.integrateToTarget({ milestoneId: m.id });
                if (integration?.ok === false || integration?.conflicts?.length) throw new Error(integration.reason ?? 'Integration conflict');
                for (const file of integration?.notRestorable ?? []) this.log('warn', `Not restorable: ${file.path} (${file.reason})`);
                this.emit('milestone_integrated', { milestoneId: m.id });
              } catch (error) {
                stage -= 1;
                if ((await pause('dwight', `Integration failed: ${error.message}`, null)) === 'skipped') break;
                continue;
              }
            }
            this.emit('cycle_result', { milestoneId: m.id, cycle, result: 'passed', failedCycles: 0, reason: `All gates passed: ${this.workflow.gates.flat().map((id) => `${this.names[id]} [${this.passes[id]}]`).join(', ')}` });
            this.emit('milestone_finished', { milestoneId: m.id, status: 'passed' });
            return 'passed';
          }
          if (needDeliver) {
            this.#deliver({ to: 'angela', milestone: m.id, cycle, ...inbox });
            needDeliver = false;
          }
          const r = await this.#runAgent('angela', { milestone: m.id, cycle });
          if (!r.ok) {
            if ((await pause('angela', `Angela could not run: ${r.failure.message}`, null)) === 'skipped') break;
          } else if (r.keyword === 'BLOCKED') {
            if ((await pause('angela', `Angela reported [BLOCKED]: ${summaryLine(r.text)}`, r.text)) === 'skipped') break;
          } else if (r.keyword === 'TEST_PASSED') {
            if (this.worktrees) {
              try {
                const integration = await this.worktrees.integrateToTarget({ milestoneId: m.id });
                if (integration?.ok === false || integration?.conflicts?.length) throw new Error(integration.reason ?? 'Integration conflict');
                for (const file of integration?.notRestorable ?? []) this.log('warn', `Not restorable: ${file.path} (${file.reason})`);
                this.emit('milestone_integrated', { milestoneId: m.id });
              } catch (err) {
                const choice = await this.#askHuman({ milestoneId: m.id, title: 'Integration failed', reason: err.message });
                if (choice.decision === 'abort') throw new RunAborted('Aborted after integration conflict');
                if (choice.decision === 'skip') break;
                if (choice.decision === 'feedback') { inbox = feedbackInbox(choice.feedback); phase = 'dwight'; needDeliver = true; }
                continue;
              }
            }
            this.emit('cycle_result', { milestoneId: m.id, cycle, result: 'passed', failedCycles: 0, reason: summaryLine(r.text) || 'Angela reported [TEST_PASSED]' });
            this.emit('milestone_finished', { milestoneId: m.id, status: 'passed' });
            return 'passed';
          } else {
            angelaReport = r.text;
            const reason = r.keyword ? `Angela reported [TEST_FAILED]: ${summaryLine(r.text)}` : 'Angela finished without a status keyword';
            const next = { kind: 'bug_report', from: 'angela', body: dwightMessage({ kind: 'bug_report', ...ctx, angelaReport }), summary: `QA failed: ${summaryLine(r.text)}` };
            if ((await failCycle(reason, next)) === 'skipped') break;
          }
        }
      }
    } catch (err) {
      if (err instanceof RunAborted) this.emit('milestone_finished', { milestoneId: m.id, status: 'aborted' });
      throw err;
    }
    this.emit('milestone_finished', { milestoneId: m.id, status: 'skipped' });
    return 'skipped';
  }

  // ---- agents and mail ------------------------------------------------------------------

  #deliver({ to, from, kind, body, summary, milestone = null, cycle = null }) {
    this.#checkAbort();
    const instanceId = milestone && ['dwight', ...this.workflow.gates.flat()].includes(to) ? `${to}-${milestone}` : to;
    if (to !== 'human' && kind !== 'report_request') body += `\n\n## Instance coordination\n\nYou are ${instanceId}. Exact recipient IDs: ${[...(this.chat?.instances.keys() ?? [])].join(', ')}. Use agent_chat for short coordination; queued is not delivered.\n`;
    const file = this.hive.deliver({ to: instanceId, from, kind, runId: this.runId, milestone, cycle, body });
    this.emit('hive_write', { from, to, file, kind, summary, instanceId, milestoneId: milestone, cycle });
  }

  /** Runs one agent invocation; always emits agent_finished and a final agent_status. */
  async #runAgent(agentId, { milestone, cycle, report = false }) {
    this.#checkAbort();

    const instanceId = milestone ? `${agentId}-${milestone}` : agentId;
    let instance = this.instances.get(instanceId);
    if (!instance) {
      const worktree = this.worktrees
        ? !this.standaloneAgent && this.gates.includes(agentId) && milestone ? { dir: this.legacyGates ? this.qaDirs.get(milestone) : this.gateDirs.get(instanceId) } : await this.worktrees.createWorktree({ agent: agentId, milestoneId: milestone ?? 'plan' })
        : { dir: this.config.workspace };
      instance = { id: instanceId, agent: agentId, milestoneId: milestone, sessionId: randomUUID(), worktree: worktree.dir, sandbox: this.config.execution?.sandbox?.mode ?? 'scranton' };
      this.instances.set(instanceId, instance);
    }
    this.prompts[instanceId] = stagePrompt(this.config, this.hive, agentId, instanceId, this.promptSnapshot[agentId]);
    const purpose = report ? 'report' : this.standaloneAgent ? 'conversation' : agentId === 'michael' ? 'plan' : this.gates.includes(agentId) ? 'gate' : 'work';
    const baseKey = `${milestone ?? 'run'}/cycle-${cycle ?? 0}/${agentId}/${purpose}`;
    const attempt = (this.invocations.get(baseKey) ?? 0) + 1;
    this.invocations.set(baseKey, attempt);
    const invocationKey = `${baseKey}/${attempt > 1 && purpose === 'plan' ? 'plan-retry/' : ''}attempt-${attempt}`;
    this.emit('instance_started', { ...instance, instanceId, invocationKey, worktree: this.worktrees ? instance.worktree : null });
    let sandbox, tempDir;
    try {
    if (instance.sandbox === 'scranton') {
      if (process.platform === 'win32' && !this.credentialsProtected) {
        const credentialsDir = credentialLocations({ env: { ...process.env, ...this.extraEnv } })[0];
        fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
        const backups = path.join(this.hive.dir, 'credential-label-backups');
        fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
        this.credentialProtection ??= Promise.resolve().then(() => this.protectCredentials(credentialsDir, { backup: path.join(backups, `${this.runId}-${randomUUID()}.json`), env: { ...process.env, ...this.extraEnv } }));
        await this.credentialProtection;
        this.credentialsProtected = true;
      }
      tempDir = createOwnedDirectory(path.join(path.dirname(instance.worktree), `temp-${randomUUID()}`));
      sandbox = this.sandboxFactory({ worktree: instance.worktree, tempDir, network: this.config.execution.sandbox.network !== 'none', env: { ...process.env, ...this.extraEnv } });
      await sandbox.prepare();
    } else if (instance.sandbox === 'docker') {
      tempDir = createOwnedDirectory(path.join(path.dirname(instance.worktree), `temp-${randomUUID()}`));
      sandbox = this.dockerSandboxFactory({ ...this.config.execution.sandbox, worktree: instance.worktree, tempDir, runId: this.runId, env: { ...process.env, ...this.extraEnv } });
      await sandbox.prepare();
    }
    let pending = '';
    const message = (text, final) => {
      if (!this.conversation || !text.trim()) return;
      this.emit('agent_message', { agent: agentId, instanceId, milestoneId: milestone, cycle, text: text.slice(0, 16000), final, ...(text.length > 16000 ? { truncated: true } : {}) });
    };
    const runner = this.startRunner({
      onAssistantMessage: this.conversation ? (text, tools) => {
        if (pending) message(pending, false);
        pending = text;
        if (tools) { message(pending, false); pending = ''; }
      } : undefined,
      instanceId, sessionId: instance.sessionId, invocationKey, runtime: this.runtime, sandbox,
      approvals: this.config.approvals, scripted: this.extraEnv.SCRANTON_FAKE_SCENARIO ? undefined : this.config.scripted,
      message: fs.readFileSync(this.hive.inboxPath(instanceId), 'utf8'),
      onMessage: (message) => this.chat.send(instanceId, message),
      agentId,
      agentConfig: { ...this.config.agents[agentId], id: agentId, kind: this.roleMap[agentId].kind, keywords: this.roleMap[agentId].keywords },
      cwd: instance.worktree,
      hive: this.hive,
      runId: this.runId,
      milestone,
      cycle,
      systemPromptFile: this.prompts[instanceId],
      extraEnv: { ...this.extraEnv, SCRANTON_CONVERSATION: this.conversation ? '1' : '0', SCRANTON_AGENT: agentId, SCRANTON_ROLE_KIND: this.roleMap[agentId].kind, SCRANTON_PASS_KEYWORD: this.roleMap[agentId].passKeyword ?? '', SCRANTON_FAIL_KEYWORD: this.roleMap[agentId].failKeyword ?? '', SCRANTON_INSTANCE_ID: instanceId, SCRANTON_RUN_ID: this.runId, SCRANTON_MILESTONE: milestone ?? '', SCRANTON_CYCLE: cycle == null ? '' : String(cycle) },
      timeoutMs: report ? 120000 : Math.round(this.config.agentTimeoutMinutes * 60000),
      onLive: (record) => this.rec.live?.update(instanceId, agentId, record),
      onUsage: (fields) => this.emit('agent_usage', { agent: agentId, instanceId, ...fields }),
      onTool: ({ tool, activity, detail, targetFile = null, command = null }) => {
        if (pending) { message(pending, false); pending = ''; }
        this.emit('agent_tool', { agent: agentId, instanceId, tool, detail, targetFile, command });
        this.setStatus(agentId, 'working', activity, instanceId);
      },
      onToolEnd: () => this.setStatus(agentId, 'thinking', 'Thinking...', instanceId)
    });
    this.active.set(instanceId, runner);
    void this.chat.attach(instanceId, runner).catch((err) => this.log('warn', err.message));
    if (this.aborting) void runner.kill('user');
    if (agentId !== 'michael') this.setStatus(agentId, 'thinking', 'Thinking...', instanceId);
    const settled = await runner.done;
    const result = this.conversation && !settled.text && pending ? { ...settled, text: pending } : settled;
    if (result.cleanupComplete === false || result.failure?.kind === 'cleanup') {
      this.cleanupComplete = false;
      this.cleanupReason = result.failure?.message ?? 'Container cleanup could not be verified';
    }
    this.active.delete(instanceId);
    this.chat.detach(instanceId);

    const publishedReply = this.conversation && agentId === 'michael' && !this.aborting && result.ok
      && result.keyword === (report ? 'REPORT_READY' : 'ANSWER_READY');
    if (result.text && !publishedReply) message(result.text, true);
    if (result.text && milestone) this.reports.set(`${agentId}-${milestone}`, result.text);
    if (result.text) {
      const to = { michael: 'dwight', dwight: 'angela', oscar: 'dwight', hank: 'dwight', angela: 'dwight' }[agentId] ?? 'dwight';
      this.hive.writeOutbox({ agent: instanceId, to, runId: this.runId, milestone, cycle, keyword: result.keyword, body: result.text });
    }
    this.rec.live?.remove(instanceId);
    const finished = { agent: agentId, instanceId, milestoneId: milestone, cycle, keyword: result.keyword, exitCode: result.exitCode, durationMs: result.durationMs };
    if (result.usage) finished.usage = { input: result.usage.input, output: result.usage.output, cost: result.usage.cost };
    this.emit('agent_finished', finished);

    if (result.failure) {
      this.setStatus(agentId, 'error', `Failed: ${result.failure.message.split('\n')[0]}`, instanceId);
      this.log('error', `${agentId}: ${result.failure.message}`);
      if (!report && result.failure.kind === 'interrupted') this.#checkAbort();
    } else if (result.keyword === 'BLOCKED') {
      this.setStatus(agentId, 'blocked', `Blocked: ${summaryLine(result.text, 300)}`, instanceId);
    } else {
      this.setStatus(agentId, 'idle', 'Idle', instanceId);
    }
    if (!report) this.#checkAbort();
    return result;
    } finally {
      this.active.delete(instanceId); this.chat.detach(instanceId);
      try {
        await sandbox?.dispose();
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (error) { this.cleanupComplete = false; this.cleanupReason = error.message; throw error; }
    }
  }

  // ---- human in the loop ----------------------------------------------------------------

  /** Pause for a decision. Applies --on-breaker, then the injected hitl, then a TTY prompt, else aborts. */
  #askHuman(context) {
    const question = this.humanTail.then(() => { this.#checkAbort(); return this.#askHumanNow(context); });
    this.humanTail = question.catch(() => {});
    return question;
  }

  async #askHumanNow({ milestoneId, title, reason, excerpt: shown = null, excerptLabel, feedbackTarget = 'Dwight', skipLabel }) {
    this.setStatus('michael', 'blocked', 'Needs a human!');
    this.#deliver({ to: 'human', from: 'michael', kind: 'hitl', body: humanNote({ title, reason, excerpt: shown, excerptLabel }), summary: reason.split('\n')[0] });
    if (this.onBreaker === 'hive') rejectResponse(this.hive.dir, (level, message) => this.log(level, message));
    const request = this.emit('hitl_request', { milestoneId, reason, options: HITL_OPTIONS });

    let choice;
    if (this.onBreaker === 'abort' || this.onBreaker === 'skip') {
      choice = { decision: this.onBreaker };
      this.log('warn', `--on-breaker ${this.onBreaker}: deciding automatically`);
    } else if (this.onBreaker === 'hive') {
      const file = safePath(this.hive.dir, 'human/request.json');
      const temp = safePath(this.hive.dir, `human/.request-${randomUUID()}.tmp`);
      let fd;
      try {
        try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe human request file'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        fs.writeFileSync(fd, JSON.stringify({ v: 1, runId: request.runId, requestSeq: request.seq, milestoneId, title, reason, options: request.options, ts: request.ts }) + '\n');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        safePath(this.hive.dir, 'human/request.json'); fs.renameSync(temp, file);
        choice = await waitForResponse(this.hive.dir, request, { signal: this.abortController.signal, log: (level, message) => this.log(level, message) });
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(safePath(this.hive.dir, `human/${path.basename(temp)}`), { force: true });
        fs.rmSync(safePath(this.hive.dir, 'human/request.json'), { force: true });
      }
    } else if (this.hitl) {
      choice = await this.hitl({ title, reason, excerpt: shown, excerptLabel, feedbackTarget, skipLabel, milestoneId }, { signal: this.abortController.signal });
    } else if (isInteractive(this.stdin, this.stdout)) {
      const ask = createTerminalHitl({ stdin: this.stdin, stdout: this.stdout });
      choice = await ask({ title, reason, excerpt: shown, excerptLabel, feedbackTarget, skipLabel }, { signal: this.abortController.signal });
    } else {
      choice = { decision: 'abort' };
      this.log('warn', 'No terminal attached to ask a human - aborting (use --on-breaker skip to continue past failures)');
    }
    if (choice?.interrupted) this.abort();
    this.#checkAbort();
    if (!HITL_OPTIONS.includes(choice?.decision)) choice = { decision: 'abort' };
    const response = { milestoneId, decision: choice.decision };
    if (choice.decision === 'feedback') response.feedback = choice.feedback ?? '';
    this.emit('hitl_response', response);
    if (choice.decision === 'abort') this.abort('Aborted by the human');
    if (choice.decision !== 'abort') this.setStatus('michael', 'waiting', 'Overseeing the run');
    return choice;
  }
}
