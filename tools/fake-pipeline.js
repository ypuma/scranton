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
let runDir, status, owned = false, suspended = false, finished = false;
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
function gate(name) {
  status.status = 'awaiting_approval'; status.phase = name === 'plan' ? 'approve_plan' : 'deliver'; status.node = name === 'plan' ? 'approve_plan' : 'approve_delivery'; status.resumable = false;
  const rel = name === 'plan' ? 'artifacts/plan.json' : 'delivery/candidate.diff';
  const content = name === 'plan' ? JSON.stringify({ summary: 'Fix the demo', acceptance_criteria: [{ id: 'c1', text: 'Tests pass', verified_by: 'checks' }], assumptions: [], risks: [], steps: [{ id: 's1', title: 'Fix', description: 'Fix fixture', files: [{ path: 'demo.txt', action: 'modify' }], criteria: ['c1'], context_files: [] }] }) : '--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-bug\n+fixed\n';
  writeFileAtomicSync(path.join(runDir, rel), content);
  status.artifacts[name === 'plan' ? 'plan' : 'diff'] = path.join(runDir, rel);
  status.pending = { gate: name, digest: hash(content), path: path.join(runDir, rel), ...(name === 'plan' ? { risk_flags: [] } : { files: [{ path: 'demo.txt', action: 'modify', added: 1, removed: 1 }] }) };
  event('gate_waiting', { gate: name, digest: status.pending.digest }); finish(3);
}
async function main() {
  if (command === 'version') { if (process.env.FAKE_PIPELINE_UNAVAILABLE === '1') process.exit(2); console.log(JSON.stringify({ version: 'fake-1', python: 'fake', langgraph: 'fake' })); return; }
  if (command === 'detect') { console.log(JSON.stringify({ git: false, languages: { JavaScript: 1 }, setup: [{ id: 'deps', argv: ['npm', 'ci'], network: true, reason: 'Fake setup' }], checks: [{ id: 'test', kind: 'test', argv: ['node', '--test', 'a b.js'], reason: 'Fake suggestion' }] })); return; }
  if (args.includes('--comment') && args[args.indexOf('--comment') + 1]?.startsWith('-')) throw Error('invalid_comment_argument');
  if (process.env.FAKE_PIPELINE_LAUNCH_ERROR === command || command === 'run' && !fs.existsSync(opt('source'))) throw Error('unsafe_shim_arguments');
  if (['run', 'demo'].includes(command)) {
    const id = opt('run-id', randomBytes(6).toString('hex'));
    if (!/^[a-z0-9]{8,32}$/.test(id)) throw Error('invalid_run_id');
    runDir = path.join(opt('run-root'), id); fs.mkdirSync(runDir, { recursive: false });
    fs.mkdirSync(path.join(runDir, 'artifacts')); fs.mkdirSync(path.join(runDir, 'delivery'));
    const workspace = path.join(opt('workspace-root', runDir), opt('workspace-root') ? id : 'workspace'); fs.mkdirSync(workspace, { recursive: true });
    const now = new Date().toISOString();
    status = { schema: 1, run_id: id, status: 'running', phase: 'prepare', node: 'prepare_workspace', task: command === 'demo' ? 'Fix the demo' : opt('task', opt('task-file') ? fs.readFileSync(opt('task-file'), 'utf8') : ''), source_dir: opt('source', path.join(runDir, 'demo-source')), delivery_mode: opt('delivery', 'apply'), progress: { step_index: 0, step_count: 1, step_title: 'Fix', attempt: 1, review_round: 0 }, pending: null, failure: null, resumable: false, usage: { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost: null }, checks: [], delivery: null, artifacts: { plan: null, diff: null, report_md: null, report_json: null }, sandbox: { mode: 'host', isolated: false }, pid: process.pid, created_at: now, updated_at: now, engine_version: 'fake-1' };
    write(path.join(runDir, 'run.json'), { run_id: id, source_dir: status.source_dir, task: status.task, delivery_mode: status.delivery_mode, created_at: now, engine_version: 'fake-1', config_digest: '' });
    write(path.join(runDir, 'config.json'), command === 'demo' ? { schema: 1, models: {} } : json(opt('config')));
  } else { runDir = opt('run-dir'); status = json(path.join(runDir, 'status.json')); }
  if (command === 'status') {
    if (status.status === 'running' && !alive()) { status.status = 'suspended'; status.resumable = true; status.pid = null; save(); }
    console.log(JSON.stringify(status)); process.exit(exitCode(status.status));
  }
  if (command === 'cancel') {
    fs.writeFileSync(path.join(runDir, 'cancel.requested'), '');
    if (!alive() && !['succeeded', 'failed', 'rejected', 'cancelled'].includes(status.status)) terminal('cancelled');
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
    write(path.join(runDir, 'artifacts/review-0.json'), { verdict: 'approve', summary: 'Fake review', criteria: [], findings: [] });
    if (status.delivery_mode === 'patch') terminal('succeeded');
    gate('delivery');
  }
  gate('plan');
}
main().catch((e) => { if (owned) fs.rmSync(path.join(runDir, 'lock'), { force: true }); console.log(JSON.stringify({ status: 'error', failure: { failure_class: 'invalid_input', code: e.message, message: 'Unsafe shim arguments: change the command' } })); process.exit(2); });
