#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileAtomicSync } from '../src/core/util.js';

const args = process.argv.slice(2), command = args.shift();
const opt = (name, fallback) => { const equal = args.find((a) => a.startsWith('--' + name + '=')); if (equal !== undefined) return equal.slice(name.length + 3); const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; };
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => writeFileAtomicSync(file, JSON.stringify(value) + '\n');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const exitCode = (s) => ({ succeeded: 0, awaiting_approval: 3, failed: 4, suspended: 5, rejected: 6, cancelled: 6 }[s] ?? 0);
let config, runDir, status, owned = false, suspended = false, finished = false;
function alive() {
  try { const pid = Number(fs.readFileSync(path.join(runDir, 'lock'), 'utf8')); process.kill(pid, 0); return true; } catch { return false; }
}
function event(type, data = {}) {
  const file = path.join(runDir, 'events.jsonl');
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  const seq = rows.length ? JSON.parse(rows.at(-1)).seq + 1 : 1;
  fs.appendFileSync(file, JSON.stringify({ seq, ts: new Date().toISOString(), run_id: status.run_id, type, node: status.node, data }) + '\n');
}
function save() { status.updated_at = new Date().toISOString(); write(path.join(runDir, 'status.json'), status); }
function finish(code) {
  if (finished) return;
  finished = true;
  if (owned) fs.rmSync(path.join(runDir, 'lock'), { force: true });
  if (status) { status.pid = null; save(); }
  console.log(JSON.stringify(status)); process.exit(code);
}
function terminal(state) {
  status.status = state; status.phase = 'done'; status.node = 'finalize'; status.pending = null; status.resumable = false;
  const report = { schema: 1, status: state, task: status.task, limitations: ['Fake engine; no model or checks executed'] };
  write(path.join(runDir, 'delivery/report.json'), report);
  writeFileAtomicSync(path.join(runDir, 'delivery/report.md'), `# Fake Pipeline\n\n${state}\n`);
  status.artifacts.report_md = path.join(runDir, 'delivery/report.md'); status.artifacts.report_json = path.join(runDir, 'delivery/report.json');
  event('run_finished', { status: state }); finish(state === 'succeeded' ? 0 : state === 'failed' ? 4 : 6);
}
async function delay() {
  const until = Date.now() + Number(process.env.FAKE_PIPELINE_SLOW_MS ?? 0);
  do {
    if (fs.existsSync(path.join(runDir, 'cancel.requested'))) terminal('cancelled');
    if (suspended || process.env.FAKE_PIPELINE_SUSPEND === '1') {
      status.status = 'suspended'; status.resumable = true; status.pending = null; event('warning', { code: 'suspended', message: 'Parent ended or suspension requested' }); finish(5);
    }
    await sleep(20);
  } while (Date.now() < until);
  if (process.env.FAKE_PIPELINE_FAIL === '1') { status.checks = [{ id: 'test', kind: 'test', status: 'error', required: true, duration_s: 0, output_tail: 'Unsafe shim arguments: change the command' }]; status.artifacts.diff = path.join(runDir, 'delivery/partial.diff'); writeFileAtomicSync(status.artifacts.diff, 'partial green diff'); status.failure = { failure_class: 'infrastructure', code: 'fake_failure', message: 'Forced failure', node: status.node }; terminal('failed'); }
}
function grounding(criteria = status.grounding?.criteria ?? []) {
  const rows = fs.existsSync(path.join(runDir, 'events.jsonl')) ? fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const outputs = rows.filter((e) => e.type === 'grounding').map((e) => e.data);
  const violations = {};
  for (const output of outputs) for (const kind of output.violations) violations[kind] = (violations[kind] ?? 0) + 1;
  const ratio = (a, b) => b ? a / b : 0, round = (v) => Math.round(v * 10000) / 10000;
  const met = criteria.filter((c) => ['demonstrated', 'met_not_demonstrated', 'attested'].includes(c.state)).length;
  const components = [];
  if (outputs.some((o) => o.cited)) components.push(1);
  const targets = outputs.filter((o) => o.role !== 'reviewer' && !o.violations.includes('false_absence'));
  if (targets.length) components.push(ratio(targets.filter((o) => !o.violations.includes('unseen_target')).length, targets.length));
  if (violations.false_absence) components.push(0);
  if (met) components.push(ratio(criteria.filter((c) => ['demonstrated', 'attested'].includes(c.state)).length, met));
  const answer = ratio(met, criteria.length), trajectory = components.length ? components.reduce((a, b) => a + b, 0) / components.length : 1;
  const violationRate = ratio(outputs.filter((o) => o.violations.length).length, outputs.length), unadjusted = (answer + trajectory) / 2;
  return { mode: config.grounding?.mode ?? 'enforce', answer: round(answer), trajectory: round(trajectory), unadjusted: round(unadjusted), violation_rate: round(violationRate), adjusted: round(unadjusted * (1 - violationRate) ** 2), tier: violationRate === 0 ? 'clean' : violationRate <= 0.1 ? 'minor' : violationRate <= 0.25 ? 'major' : 'failing', outputs: outputs.length, violations, criteria, probe: { status: 'not_needed' } };
}
function modelCall(role, situation, violations = [], lane) {
  const scope = role === 'planner' ? `plan:r${status.progress.plan_revision}` : role === 'reviewer' ? 'review:0' : `step:${lane ?? (status.progress.plan_revision ? 'r1-s1' : 's1')}`;
  status.node = role === 'planner' ? 'plan' : role === 'reviewer' ? 'review' : 'implement';
  status.phase = role === 'planner' ? 'plan' : role === 'reviewer' ? 'review' : 'implement';
  status.usage.calls++;
  event('llm_call', { role, model: 'fake', ok: true, input_tokens: 0, output_tokens: 0, duration_s: 0 });
  event('grounding', { role, scope, accepted: config.grounding?.mode === 'observe' || violations.length === 0, violations, cited: role === 'reviewer' ? 1 : 0, shown: 1, ...(lane ? { lane } : {}) });
  if (status.procedure.enabled) status.procedure.situation = situation;
  event('procedure', { role, scope, situation, matched: status.procedure.enabled });
  status.grounding = grounding(); save();
}
async function ground() {
  status.node = 'ground'; status.phase = 'review'; event('node_started');
  const refuted = Boolean(status.grounding.violations.false_absence);
  if (!refuted) event('absence_verified', { kind: 'missing_symbol', subject: 'genuinely_absent', files_searched: 1 });
  const criteria = config.demo_scenario === 'evidence'
    ? [{ id: 'c1', verified_by: 'checks', state: 'demonstrated', by: 'baseline', checks: ['test'] }, { id: 'c2', verified_by: 'checks', state: 'met_not_demonstrated', by: 'none', checks: ['stable'] }]
    : [{ id: 'c1', verified_by: 'checks', state: refuted ? 'met_not_demonstrated' : 'demonstrated', by: refuted ? 'none' : 'baseline', checks: ['test'] }];
  status.grounding = grounding(criteria);
  const states = {};
  for (const criterion of criteria) states[criterion.state] = (states[criterion.state] ?? 0) + 1;
  event('criteria_decided', { states });
  event('probe_finished', { status: 'not_needed', checks: [] });
  save(); await sleep(20); event('node_finished', { duration_s: 0 });
  status.node = 'package'; event('node_started'); event('node_finished', { duration_s: 0 });
}
async function gate(name) {
  status.status = 'awaiting_approval'; status.phase = name === 'plan' ? 'approve_plan' : 'deliver'; status.node = name === 'plan' ? 'approve_plan' : 'approve_delivery'; status.resumable = false;
  const rel = name === 'plan' ? 'artifacts/plan.json' : 'delivery/candidate.diff';
  const content = name === 'plan' ? JSON.stringify({ summary: status.progress.plan_revision ? 'Revised demo plan' : 'Fix the demo', acceptance_criteria: [{ id: 'c1', text: 'Tests pass', verified_by: 'checks' }], assumptions: [], risks: [], steps: [{ id: 's1', title: 'Fix', description: 'Fix fixture', files: [{ path: 'demo.txt', action: 'modify' }], criteria: ['c1'], context_files: [] }] }) : '--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-bug\n+fixed\n';
  let artifact = content;
  if (name === 'plan') {
    const plan = JSON.parse(content), revision = status.progress.plan_revision ?? 0;
    if (revision) plan.steps[0].id = 'r1-s1';
    if (config.demo_scenario === 'evidence') {
      plan.acceptance_criteria[0].checks = ['test'];
      plan.acceptance_criteria.push({ id: 'c2', text: 'Stable check stays green', verified_by: 'checks', checks: ['stable'] });
      plan.steps[0].criteria.push('c2');
    }
    if ((config.demo_scenario === 'parallel' || process.env.FAKE_PIPELINE_PARALLEL === '1') && (config.execution?.max_parallel_steps ?? 1) > 1) {
      plan.steps[0].depends_on = [];
      plan.steps.push({ ...plan.steps[0], id: 's2', files: [{ path: 'other.txt', action: 'create' }], depends_on: [] });
      status.progress.step_count = 2;
    }
    artifact = JSON.stringify(plan); writeFileAtomicSync(path.join(runDir, `artifacts/plan-r${revision}.json`), artifact);
  }
  writeFileAtomicSync(path.join(runDir, rel), artifact);
  status.artifacts[name === 'plan' ? 'plan' : 'diff'] = path.join(runDir, rel);
  status.pending = { gate: name, digest: hash(artifact), path: path.join(runDir, rel), ...(name === 'plan' ? { risk_flags: status.progress.plan_revision ? ['replan'] : [], revision: status.progress.plan_revision, replan_reason: status.progress.plan_revision ? 'step_blocked: Fake step blocked' : null } : { files: [{ path: 'demo.txt', action: 'modify', added: 1, removed: 1 }] }) };
  if (name === 'delivery') {
    status.pending.grounding = status.grounding;
    const acceptedViolation = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).some((e) => e.type === 'grounding' && e.data.accepted && e.data.violations.length > 0);
    status.pending.risk_flags = [...(status.grounding.criteria.some((c) => c.state === 'met_not_demonstrated') ? ['criteria_not_demonstrated'] : []), ...(acceptedViolation ? ['grounding_violations'] : [])];
    status.pending.digest = hash(JSON.stringify({ diff: artifact, grounding: status.pending.grounding, risk_flags: status.pending.risk_flags }));
  }
  const barrier = process.env.FAKE_PIPELINE_GATE_BARRIER;
  if (barrier && name === (process.env.FAKE_PIPELINE_GATE_BARRIER_NAME ?? 'plan')) {
    // Hold the owner after its last stop check, as the real runner publishes an interrupt.
    save(); fs.writeFileSync(barrier + '.ready', '');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(barrier + '.release')) {
      if (Date.now() >= deadline) throw Error('gate_barrier_timeout');
      await sleep(10);
    }
  }
  event('gate_waiting', { gate: name, digest: status.pending.digest }); finish(3);
}
async function main() {
  if (process.env.FAKE_PIPELINE_INVOCATIONS) fs.appendFileSync(process.env.FAKE_PIPELINE_INVOCATIONS, JSON.stringify([command, ...args]) + '\n');
  if (command === 'version') { if (process.env.FAKE_PIPELINE_UNAVAILABLE === '1') process.exit(2); console.log(JSON.stringify({ version: 'fake-1', python: 'fake', langgraph: 'fake' })); return; }
  if (command === 'sandbox') {
    if (process.env.FAKE_PIPELINE_OLD_ENGINE === '1') throw Error('unknown_command');
    const image = opt('image', 'scranton-pipeline-sandbox:fake-1');
    if (args[0] === 'check') {
      if (process.env.FAKE_PIPELINE_PROBE_FILE) fs.appendFileSync(process.env.FAKE_PIPELINE_PROBE_FILE, JSON.stringify(args) + '\n');
      await sleep(Number(process.env.FAKE_PIPELINE_PROBE_SLOW_MS ?? 0));
      const available = process.env.FAKE_PIPELINE_DOCKER_ABSENT !== '1';
      console.log(JSON.stringify({ default_image: 'scranton-pipeline-sandbox:fake-1', docker: { available, version: available ? 'fake-docker-1' : null, reason: available ? null : 'Docker daemon is not available (fake)' }, image: { name: image, present: available && (process.env.FAKE_PIPELINE_IMAGE_MISSING !== '1' || Boolean(process.env.FAKE_PIPELINE_IMAGE_FILE && fs.existsSync(process.env.FAKE_PIPELINE_IMAGE_FILE))) } })); return;
    }
    if (args[0] !== 'build') throw Error('unknown_command');
    if (process.env.FAKE_PIPELINE_BUILD_PID_FILE) fs.writeFileSync(process.env.FAKE_PIPELINE_BUILD_PID_FILE, String(process.pid));
    console.error('Building fake sandbox image');
    if (process.env.FAKE_PIPELINE_BUILD_OUTPUT) console.error(process.env.FAKE_PIPELINE_BUILD_OUTPUT);
    await sleep(Number(process.env.FAKE_PIPELINE_BUILD_SLOW_MS ?? 0));
    const built = process.env.FAKE_PIPELINE_BUILD_FAIL !== '1';
    if (built && process.env.FAKE_PIPELINE_IMAGE_FILE) fs.writeFileSync(process.env.FAKE_PIPELINE_IMAGE_FILE, 'built');
    console.log(JSON.stringify({ built, image, reason: built ? null : 'Fake build failed' })); process.exit(built ? 0 : 5);
  }
  if (command === 'detect') { console.log(JSON.stringify({ git: false, languages: { JavaScript: 1 }, setup: [{ id: 'deps', argv: ['npm', 'ci'], network: true, reason: 'Fake setup' }], checks: [{ id: 'test', kind: 'test', argv: ['node', '--test', 'a b.js'], reason: 'Fake suggestion' }] })); return; }
  if (args.includes('--comment') && args[args.indexOf('--comment') + 1]?.startsWith('-')) throw Error('invalid_comment_argument');
  if (process.env.FAKE_PIPELINE_LAUNCH_ERROR === command || command === 'run' && !fs.existsSync(opt('source'))) throw Error('unsafe_shim_arguments');
  if (['run', 'demo'].includes(command)) {
    const scenario = opt('scenario', 'basic'), mode = opt('sandbox', 'host');
    if (command === 'demo' && (!['basic', 'replan', 'parallel', 'evidence'].includes(scenario) || !['host', 'docker'].includes(mode))) throw Error('invalid_demo_arguments');
    if (command === 'demo' && scenario === 'evidence' && opt('grounding') === 'observe') throw Error('evidence_needs_enforce');
    const id = opt('run-id', randomBytes(6).toString('hex'));
    if (!/^[a-z0-9]{8,32}$/.test(id)) throw Error('invalid_run_id');
    runDir = path.join(opt('run-root'), id); fs.mkdirSync(runDir, { recursive: false });
    fs.mkdirSync(path.join(runDir, 'artifacts')); fs.mkdirSync(path.join(runDir, 'delivery'));
    const workspace = path.join(opt('workspace-root', runDir), opt('workspace-root') ? id : 'workspace'); fs.mkdirSync(workspace, { recursive: true });
    const now = new Date().toISOString();
    status = { schema: 1, run_id: id, status: 'running', phase: 'prepare', node: 'prepare_workspace', task: command === 'demo' ? 'Fix the demo' : opt('task', opt('task-file') ? fs.readFileSync(opt('task-file'), 'utf8') : ''), source_dir: opt('source', path.join(runDir, 'demo-source')), delivery_mode: opt('delivery', 'apply'), progress: { plan_revision: 0, replans_left: 1, steps_done: 0, lanes: [], step_index: 0, step_count: 1, step_title: 'Fix', attempt: 1, review_round: 0 }, pending: null, failure: null, resumable: false, usage: { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost: null }, checks: [], delivery: null, artifacts: { plan: null, diff: null, report_md: null, report_json: null }, sandbox: null, pid: process.pid, created_at: now, updated_at: now, engine_version: 'fake-1' };
    write(path.join(runDir, 'argv.json'), [command, ...args]);
    const cfg = command === 'demo' ? { schema: 1, models: {}, demo_scenario: scenario, execution: { max_parallel_steps: scenario === 'parallel' ? 2 : 1 }, sandbox: { mode, docker: { image: opt('image', '') } } } : json(opt('config'));
    if (command === 'demo') {
      if (opt('grounding') !== undefined) cfg.grounding = { mode: opt('grounding') };
      if (opt('guidance') !== undefined) cfg.procedure = { enabled: opt('guidance') === 'true' };
    }
    const sandboxMode = cfg.sandbox?.mode ?? 'docker';
    status.sandbox = {
      mode: sandboxMode, isolated: sandboxMode === 'docker',
      image: sandboxMode === 'host' ? null : cfg.sandbox?.docker?.image || 'scranton-pipeline-sandbox:fake-1',
      isolation: sandboxMode === 'host' ? 'No OS isolation.' : 'Docker container with read-only root and no network for checks; shares the Docker VM kernel; workspace mounted read-write; setup commands with network can reach the internet and local services (including host.docker.internal).',
      setup_network: (cfg.setup ?? []).some((command) => command.network === true)
    };
    write(path.join(runDir, 'run.json'), { run_id: id, source_dir: status.source_dir, task: status.task, delivery_mode: status.delivery_mode, created_at: now, engine_version: 'fake-1', config_digest: '' });
    write(path.join(runDir, 'config.json'), cfg);
  } else { runDir = opt('run-dir'); status = json(path.join(runDir, 'status.json')); }
  config = fs.existsSync(path.join(runDir, 'config.json')) ? json(path.join(runDir, 'config.json')) : {};
  status.grounding ??= grounding([]);
  status.procedure ??= { enabled: config.procedure?.enabled ?? false, name: config.procedure?.enabled ? 'fake-guidance' : null, digest: config.procedure?.enabled ? hash('fake-guidance') : null, situation: null };
  status.progress ??= {};
  status.progress.replans_left = Math.max(0, (config.limits?.max_replans ?? 1) - (status.progress.plan_revision ?? 0));
  if (command === 'status') {
    if (status.status === 'running' && !alive()) { status.status = 'suspended'; status.resumable = true; status.pid = null; save(); }
    console.log(JSON.stringify(status)); process.exit(exitCode(status.status));
  }
  if (command === 'cancel') {
    fs.writeFileSync(path.join(runDir, 'cancel.requested'), '');
    if (!alive() && !['succeeded', 'failed', 'rejected', 'cancelled'].includes(status.status)) terminal('cancelled');
    if (process.env.FAKE_PIPELINE_CANCEL_ACK) write(process.env.FAKE_PIPELINE_CANCEL_ACK, { status: status.status, ownerAlive: alive() });
    console.log(JSON.stringify(status)); process.exit(exitCode(status.status));
  }
  if (alive()) throw Error('run_active');
  if (command === 'resume' && status.pending && (opt('gate') !== status.pending.gate || opt('digest') !== status.pending.digest)) throw Error('stale_digest');
  fs.writeFileSync(path.join(runDir, 'lock'), String(process.pid)); owned = true;
  if (args.includes('--parent-guard')) { process.stdin.resume(); process.stdin.on('end', () => { suspended = true; }); process.stdin.on('data', (d) => { if (String(d).includes('stop')) suspended = true; }); }
  status.pid = process.pid; const pending = status.pending;
  status.status = 'running'; save(); event(command === 'resume' ? 'run_resumed' : 'run_started');
  await delay();
  if (pending) {
    event('gate_decided', { gate: pending.gate, decision: opt('decision'), by: 'human' });
    if (pending.gate === 'plan' && opt('decision') === 'reject') terminal('rejected');
    if (pending.gate === 'delivery') { status.delivery = { applied: opt('decision') === 'approve', diff_sha256: pending.digest, files: 1, conflicts: [] }; terminal('succeeded'); }
    status.pending = null;
    if ((config.demo_scenario === 'replan' || process.env.FAKE_PIPELINE_REPLAN === '1') && !status.progress.plan_revision) {
      modelCall('implementer', 'implement.start', ['false_absence']);
      event('check_finished', { id: 'test', status: 'failed', duration_s: 0 });
      if (!(config.limits?.max_replans ?? 1)) { status.failure = { failure_class: 'implementation', code: 'step_blocked', message: 'Fake step blocked', node: 'implement' }; terminal('failed'); }
      event('replan_requested', { code: 'step_blocked', message: 'Fake step blocked', scope: 's1' });
      status.progress.plan_revision = 1; status.progress.replans_left--;
      event('replanned', { revision: 1 }); modelCall('planner', 'plan.replan'); await gate('plan');
    }
    if ((config.demo_scenario === 'parallel' || process.env.FAKE_PIPELINE_PARALLEL === '1') && (config.execution?.max_parallel_steps ?? 1) > 1) {
      status.phase = 'implement'; status.node = 'run_lane';
      status.progress.step_count = 2;
      status.progress.lanes = ['s1', 's2'].map((step_id) => ({ step_id, title: `Fix ${step_id}`, state: 'running', attempt: 1 }));
      event('wave_started', { wave: 1, steps: ['s1', 's2'] });
      for (const lane of status.progress.lanes) { event('lane_started', { lane: lane.step_id }); modelCall('implementer', 'implement.start', [], lane.step_id); }
      status.phase = 'implement'; status.node = 'run_lane';
      save(); await sleep(Number(process.env.FAKE_PIPELINE_LANE_MS ?? 100));
      for (const lane of status.progress.lanes) { lane.state = 'passed'; event('lane_finished', { lane: lane.step_id, status: 'passed' }); }
      save(); await sleep(Number(process.env.FAKE_PIPELINE_LANE_MS ?? 100));
      for (const lane of status.progress.lanes) lane.state = 'merged';
      status.progress.steps_done = 2; save(); await sleep(Number(process.env.FAKE_PIPELINE_LANE_MS ?? 100));
      event('wave_merged', { wave: 1, merged: ['s1', 's2'], failed: [] });
      status.progress.lanes = [];
    } else {
      if (config.demo_scenario === 'evidence') modelCall('implementer', 'implement.start', ['false_absence']);
      modelCall('implementer', config.demo_scenario === 'evidence' ? 'implement.repair' : 'implement.start'); status.progress.steps_done = 1;
    }
    modelCall('reviewer', 'review.start');
    event('node_finished', { duration_s: 0 });
    await ground();
    write(path.join(runDir, 'artifacts/review-0.json'), { verdict: 'approve', summary: 'Fake review', criteria: [], findings: [] });
    if (status.delivery_mode === 'patch') terminal('succeeded');
    await gate('delivery');
  }
  if (config.demo_scenario === 'evidence') modelCall('planner', 'plan.start', ['unseen_target']);
  modelCall('planner', config.demo_scenario === 'evidence' ? 'plan.repair' : 'plan.start'); await gate('plan');
}
main().catch((e) => { if (owned) fs.rmSync(path.join(runDir, 'lock'), { force: true }); console.log(JSON.stringify({ status: 'error', failure: { failure_class: 'invalid_input', code: e.message, message: 'Unsafe shim arguments: change the command' } })); process.exit(2); });
