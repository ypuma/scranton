import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.SCRANTON_FAKE_MODE = '1';

export function tempDir(t, prefix = 'scranton-test-') {
  const root = path.resolve('.scratch/switch-core/tmp'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function readEvents(hiveDir) {
  return fs
    .readFileSync(path.join(hiveDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function readLog(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Deterministic own-runtime configuration. */
export function fakeConfig(dir, options = {}) { return scriptedConfig(dir, options); }

/** Own-runtime config for migration tests; set SCRANTON_FAKE_SCENARIO on the runner/child. */
export function scriptedConfig(dir, { maxFailedCycles = 3, timeoutMin } = {}) {
  const config = loadConfig({ cwd: dir, env: {}, hasBash: true, fileConfig: {
    workspace: path.join(dir, 'workspace'), hiveDir: path.join(dir, 'hive'), maxFailedCycles,
    ...(timeoutMin ? { agentTimeoutMinutes: timeoutMin } : {}),
    execution: { maxParallel: 1, isolation: 'shared', sandbox: { mode: 'host' } },
  } });
  config.scripted = 'happy';
  return config;
}

const NO_TTY = { isTTY: false };

/** Runs a full orchestration against the scripted runtime and returns results, events and invocation receipts. */
export async function runFake(t, { scenario = 'happy', env = {}, request = 'Build a tiny todo CLI', config = {}, beforeRun, ...options } = {}) {
  const dir = tempDir(t);
  const logFile = path.join(dir, 'scripted-agent.log');
  const cfg = fakeConfig(dir, config);
  const orchestrator = new Orchestrator({
    config: cfg,
    stdin: NO_TTY,
    stdout: { ...NO_TTY, write() {} },
    extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: scenario, SCRANTON_FAKE_LOG: logFile, ...env },
    ...options
  });
  beforeRun?.(orchestrator);
  const result = await orchestrator.run(request);
  return {
    dir,
    config: cfg,
    orchestrator,
    result,
    events: readEvents(cfg.hiveDir),
    state: JSON.parse(fs.readFileSync(path.join(cfg.hiveDir, 'state.json'), 'utf8')),
    invocations: readLog(logFile)
  };
}

// ---- Contract v1 conformance ---------------------------------------------------------------

const str = (v) => typeof v === 'string';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const oneOf = (...values) => (v) => values.includes(v);
const nullable = (check) => (v) => v === null || check(v);
const PARTICIPANT = oneOf('michael', 'dwight', 'oscar', 'hank', 'angela', 'human');
const AGENT = oneOf('michael', 'dwight', 'oscar', 'hank', 'angela');

const EVENT_FIELDS = {
  instance_started: { instanceId: str, agent: AGENT, sessionId: str, worktree: nullable(str), sandbox: str },
  milestone_integrated: { milestoneId: str },
  chat_message: { id: str, from: str, to: str, text: str, delivery: oneOf('queued', 'delivered', 'rejected') },
  chat_delivery: { id: str, delivery: oneOf('queued', 'delivered', 'rejected') },
  chat_command_rejected: { delivery: oneOf('rejected'), reason: str },
  run_started: { request: str, workspace: (v) => str(v) && path.isAbsolute(v), maxFailedCycles: num },
  plan_ready: {
    milestones: (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((m) => str(m.id) && str(m.title) && str(m.description) && Array.isArray(m.acceptanceCriteria) && m.acceptanceCriteria.every(str))
  },
  milestone_started: { milestoneId: str, index: num, total: num, title: str },
  hive_write: {
    from: (v) => PARTICIPANT(v) || /^(dwight|angela)-m[1-7]$/.test(v),
    to: (v) => PARTICIPANT(v) || /^(dwight|angela)-m[1-7]$/.test(v),
    file: (v) => str(v) && !v.includes('\\') && !path.isAbsolute(v),
    kind: oneOf('plan_request', 'task', 'handoff', 'bug_report', 'feedback', 'hitl'),
    summary: (v) => str(v) && v.length <= 140
  },
  agent_status: {
    agent: AGENT,
    status: oneOf('idle', 'thinking', 'working', 'waiting', 'blocked', 'error', 'done'),
    activity: str
  },
  agent_tool: { agent: AGENT, tool: str, detail: (v) => str(v) && v.length <= 140 },
  agent_usage: { agent: AGENT, instanceId: str, model: nullable(str), usage: (u) => u && num(u.input) && num(u.output) && num(u.cost) },
  agent_finished: {
    agent: AGENT,
    milestoneId: nullable(str),
    cycle: nullable(num),
    keyword: nullable((v) => str(v) && !v.includes('[')),
    exitCode: num,
    durationMs: num
  },
  cycle_result: { milestoneId: str, cycle: num, result: oneOf('passed', 'failed'), failedCycles: num, reason: str },
  circuit_breaker: { milestoneId: str, state: oneOf('tripped', 'reset'), failedCycles: num, maxFailedCycles: num },
  hitl_request: { milestoneId: nullable(str), reason: str, options: (v) => Array.isArray(v) && v.every(str) },
  hitl_response: { milestoneId: nullable(str), decision: oneOf('feedback', 'retry', 'skip', 'abort') },
  milestone_finished: { milestoneId: str, status: oneOf('passed', 'skipped', 'failed', 'aborted', 'blocked') },
  run_finished: { status: oneOf('success', 'partial', 'aborted', 'failed'), summary: str },
  log: { level: oneOf('info', 'warn', 'error'), message: str }
};

/** Asserts that events.jsonl and state.json follow Contract v1. */
export function assertContract(events, state) {
  assert.ok(events.length > 1, 'events were written');
  assert.equal(events[0].type, 'run_started');
  assert.equal(events.at(-1).type, 'run_finished');
  const runId = events[0].runId;
  events.forEach((e, i) => {
    assert.equal(e.v, 1);
    assert.equal(e.seq, i + 1, `seq strictly increasing from 1 (event ${i})`);
    assert.ok(!Number.isNaN(Date.parse(e.ts)) && e.ts.endsWith('Z'), 'ts is ISO-8601 UTC');
    assert.equal(e.runId, runId);
    const spec = EVENT_FIELDS[e.type];
    assert.ok(spec, `type "${e.type}" is listed in the contract`);
    for (const [field, check] of Object.entries(spec)) {
      assert.ok(check(e[field]), `${e.type}.${field} invalid: ${JSON.stringify(e[field])}`);
    }
    if (e.type === 'agent_finished' && e.usage !== undefined) {
      assert.ok(num(e.usage.input) && num(e.usage.output) && num(e.usage.cost), 'usage shape');
    }
    if (e.type === 'hitl_response' && e.decision === 'feedback') assert.ok(str(e.feedback));
  });

  assert.equal(state.v, 1);
  assert.equal(state.runId, runId);
  assert.equal(state.lastSeq, events.at(-1).seq);
  assert.ok(['idle', 'planning', 'running', 'paused', 'finished', 'aborted', 'failed'].includes(state.status));
  assert.ok(num(state.cycle) && num(state.failedCycles) && num(state.maxFailedCycles));
  assert.ok(['closed', 'tripped'].includes(state.breaker));
  assert.ok(Array.isArray(state.milestones));
  assert.deepEqual(Object.keys(state.agents).sort(), ['angela', 'dwight', 'hank', 'michael', 'oscar']);
  for (const a of Object.values(state.agents)) {
    assert.ok(str(a.status) && str(a.activity) && str(a.updatedAt));
    assert.ok(a.lastKeyword === null || str(a.lastKeyword));
    assert.ok(num(a.totals.runs) && num(a.totals.input) && num(a.totals.output) && num(a.totals.cost));
  }
  for (const id of ['michael', 'dwight', 'oscar', 'hank', 'angela']) {
    const finished = events.filter((e) => e.type === 'agent_finished' && e.agent === id);
    assert.equal(state.agents[id].totals.runs, finished.length, `${id} runs total`);
    assert.equal(state.agents[id].totals.input, finished.reduce((s, e) => s + (e.usage?.input ?? 0), 0), `${id} input total`);
  }
}

export const types = (events) => events.map((e) => e.type);
export const ofType = (events, type) => events.filter((e) => e.type === type);
