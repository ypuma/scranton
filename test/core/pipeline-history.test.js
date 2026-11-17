import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPipelineHistory, readPipelineHistoryJson } from '../../src/core/pipeline-history.js';

function fixture(t) {
  const base = path.resolve('.scratch/pipeline/history-node'); fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'unit-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const scope = { dataDir, projectId: 'project', chatId: 'chat' };
  function write(id, file, value, projectId = 'project', chatId = 'chat') {
    const p = path.join(dataDir, 'projects', projectId, 'chats', chatId, 'pipeline/runs', id, file);
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)); return p;
  }
  function run(id, extra = {}) {
    write(id, 'status.json', { status: 'failed', created_at: id, progress: { plan_revision: 1, steps_done: 1 }, ...extra });
    write(id, 'run.json', { task: 'Original request ' + id, cross_run_history: { task: 'NESTED-HISTORY-DO-NOT-FORWARD' } });
  }
  return { scope, write, run };
}
const plan = { summary: 'Revised task plan', steps: [{ id: 'r1-fix', title: 'Fix rendering', description: 'Read existing tests first', files: [{ path: 'src/render.js', action: 'modify' }], depends_on: [], criteria: ['c1'] }], acceptance_criteria: [{ id: 'c1', text: 'Render correctly', verified_by: 'checks' }], digest: 'a'.repeat(64), approval: 'OLD-APPROVAL' };

test('disk history retains latest three terminal answers and older latest-plan anchor without recursion or scope leaks', (t) => {
  const f = fixture(t); f.run('run00001'); f.write('run00001', 'artifacts/plan.json', plan);
  f.write('run00001', 'delivery/report.json', { steps: [{ step_id: 'step:old', commit: 'private' }], delivery: { applied: false }, failure: { code: 'budget', message: 'Read not completed' }, baseline: [{ id: 'test', status: 'failed' }], checks: [{ id: 'test', status: 'failed', output_tail: 'No context budget' }] });
  for (let i = 2; i <= 7; i++) f.run('run0000' + i, { status: 'succeeded', reply: { text: 'Answer ' + i } });
  f.run('run99998', { status: 'awaiting_approval' }); f.run('run99999', { status: 'suspended' });
  f.write('foreign1', 'status.json', { status: 'failed', task: 'CROSS-CHAT', created_at: 'z' }, 'project', 'other');
  f.write('foreign2', 'status.json', { status: 'failed', task: 'CROSS-PROJECT', created_at: 'z' }, 'other', 'chat');
  const h = buildPipelineHistory(f.scope);
  assert.deepEqual(h.runs.map((r) => r.run_id), ['run00001', 'run00005', 'run00006', 'run00007']);
  assert.match(h.runs[0].plan, /Revised task plan/); assert.match(h.runs[0].plan, /"revision":1/);
  assert.match(h.runs[0].outcome, /"verified_steps":\["step:old"\]/); assert.match(h.runs[0].outcome, /"delivery_applied":false/);
  assert.match(h.runs[0].outcome, /No context budget/);
  assert.match(h.runs.at(-1).outcome, /Answer 7/);
  assert.doesNotMatch(JSON.stringify(h), /NESTED-HISTORY|CROSS-|OLD-APPROVAL|aaaaaaaaaaaaaaaa/);
  assert.deepEqual(buildPipelineHistory(f.scope), h, 'new builder invocation recovers exclusively from disk');
});

test('malformed, oversized and redirected artifacts degrade independently; artifact pointers never control reads', (t) => {
  const f = fixture(t); f.run('run00001');
  const file = f.write('run00001', 'artifacts/plan.json', plan); fs.writeFileSync(file, '{broken');
  const metadata = f.write('run00001', 'run.json', {}); fs.writeFileSync(metadata, ' '.repeat(1024 * 1024 + 1));
  f.write('run00001', 'status.json', { status: 'failed', task: 'Fallback task', artifacts: { plan: '../../victim.json' } });
  assert.equal(buildPipelineHistory(f.scope).runs[0].task, 'Fallback task');
  assert.equal(buildPipelineHistory(f.scope).runs[0].plan, '');
  assert.match(buildPipelineHistory(f.scope).runs[0].outcome, /unavailable/);
  const victim = path.join(f.scope.dataDir, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'plan.json'), JSON.stringify(plan));
  fs.rmSync(path.dirname(file), { recursive: true }); fs.symlinkSync(victim, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(buildPipelineHistory(f.scope).runs[0].plan, '');
  assert.match(buildPipelineHistory(f.scope).runs[0].outcome, /unavailable/);
  fs.symlinkSync(path.dirname(path.dirname(file)), path.join(path.dirname(path.dirname(path.dirname(file))), 'run00002'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(buildPipelineHistory(f.scope).runs.length, 1);
  assert.equal(readPipelineHistoryJson(f.scope.dataDir, '../victim.json'), null);
  assert.equal(buildPipelineHistory({ ...f.scope, chatId: '../chat' }), null);
});

test('Unicode and escaped JSON obey character and UTF-8 budgets, with latest anchor and outcome retained', (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 4; i++) {
    const id = 'run0000' + i; f.run(id); f.write(id, 'run.json', { task: '😀"\\'.repeat(3000) });
    f.write(id, 'artifacts/plan.json', { ...plan, summary: '最新计划 ' + '😀'.repeat(9000) });
    f.write(id, 'delivery/reply.json', { text: 'Latest reply ' + '😀'.repeat(5000) });
  }
  const h = buildPipelineHistory(f.scope);
  assert.ok(Buffer.byteLength(JSON.stringify(h)) <= 32768); assert.equal(h.truncated, true);
  assert.equal(h.runs.at(-1).run_id, 'run00004'); assert.match(h.runs.at(-1).plan, /最新计划/);
  assert.match(h.runs.at(-1).outcome, /Latest reply/);
  for (const r of h.runs) for (const [key, cap] of [['task', 4000], ['plan', 8000], ['outcome', 4000]]) assert.ok(Array.from(r[key]).length <= cap);
});

test('projection excludes authority and private paths and scrubs text before truncation', (t) => {
  const f = fixture(t); f.run('run00001');
  f.write('run00001', 'run.json', { task: 'secret-value ' + 'x'.repeat(4500) });
  f.write('run00001', 'artifacts/plan.json', { ...plan, summary: 'See C:\\Users\\private\\file and /home/private/data E-0123456789 ' + 'a'.repeat(64) });
  const h = buildPipelineHistory({ ...f.scope, redact: (text) => text.replaceAll('secret-value', '[REDACTED]') });
  assert.match(h.runs[0].task, /REDACTED/); assert.doesNotMatch(JSON.stringify(h), /secret-value|Users|home\/private|E-0123456789|aaaaaaaaaaaaaaaa|OLD-APPROVAL/);
});

test('verbose answer chain survives the actual Python prompt history budget with original task and plan', (t) => {
  const python = path.resolve('.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(fs.existsSync(python), 'Development Python consumer is required for this regression');
  const f = fixture(t); f.run('run00001');
  f.write('run00001', 'run.json', { task: 'ORIGINAL-TASK: repair the visualization' });
  f.write('run00001', 'artifacts/plan.json', { ...plan, summary: 'ORIGINAL-PLAN: repair rendering' });
  for (let i = 2; i <= 7; i++) {
    const id = 'run0000' + i; f.run(id, { status: 'succeeded' });
    f.write(id, 'run.json', { task: 'Explain this answer ' + 'verbose '.repeat(600) });
    f.write(id, 'delivery/reply.json', { text: 'LATEST-ANSWER-' + i + ' ' + 'explanation '.repeat(600) });
  }
  const h = buildPipelineHistory(f.scope);
  assert.ok(Buffer.byteLength(JSON.stringify(h)) > 12000, 'Producer exceeds consumer prompt cap');
  assert.ok(Buffer.byteLength(JSON.stringify(h)) <= 32768);
  const consumed = spawnSync(python, ['-c', `import json,sys
from scranton_pipeline.history import history_block,validate_history
from scranton_pipeline.tools.secrets import Redactor
history=validate_history(json.load(sys.stdin),Redactor())
block=history_block(history,12000)
assert len(block.encode())<=12000
print(block)
`], { input: JSON.stringify(h), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONPATH: path.resolve('engine/src'), PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode') } });
  assert.equal(consumed.status, 0, consumed.stderr);
  const data = JSON.parse(consumed.stdout.trim().split(/\r?\n/).slice(1, -1).join('\n'));
  assert.match(data.runs[0].task, /ORIGINAL-TASK/);
  assert.match(data.runs[0].plan, /ORIGINAL-PLAN/);
  assert.match(data.runs.at(-1).outcome, /LATEST-ANSWER-7/);
  assert.ok(h.runs.slice(1).every((r) => r.plan === ''));
  f.write('run00007', 'artifacts/plan.json', { ...plan, summary: 'NEWEST-REAL-PLAN' });
  const newer = buildPipelineHistory(f.scope);
  assert.deepEqual(newer.runs.map((r) => r.run_id), ['run00005', 'run00006', 'run00007']);
  assert.match(newer.runs.at(-1).plan, /NEWEST-REAL-PLAN/);
});

test('nested projections stay parseable after private paths, quotes, secrets and size reduction', (t) => {
  const f = fixture(t); f.run('run00001');
  const value = 'Quoted "value", C:\\Users\\private\\file password=hidden-value';
  f.write('run00001', 'artifacts/plan.json', { ...plan, summary: value });
  f.write('run00001', 'delivery/report.json', { failure: { code: 'failed', message: value, node: 'verify' }, steps: [{ step_id: 'step:real', attempts: 3 }, { step_id: 'rev:1' }, { step_id: 'int:2' }, {}, null], delivery: { applied: false }, checks: [{ id: 'test', status: 'failed', output_tail: value }] });
  f.write('run00001', 'delivery/reply.json', { text: value });
  const h = buildPipelineHistory({ ...f.scope, redact: (text) => text.replace(/\b(password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]') });
  const p = JSON.parse(h.runs[0].plan), o = JSON.parse(h.runs[0].outcome);
  assert.match(p.summary, /Quoted "value", \[private path\] password=\[REDACTED\]/);
  assert.equal(o.failure.message, p.summary); assert.equal(o.assistant_reply, p.summary);
  assert.deepEqual(o.verified_steps, ['step:real']); assert.equal(o.verified_step_count, 1);
  assert.deepEqual(o.other_verified_work, ['rev:1', 'int:2']); assert.equal(o.delivery_applied, false);
  assert.match(o.note, /Unverified attempts are not counted/);
  assert.doesNotMatch(JSON.stringify(h), /hidden-value|Users|private\\\\file/);
  f.write('run00001', 'artifacts/plan.json', { ...plan, summary: value + '😀"\\'.repeat(8000) });
  f.write('run00001', 'delivery/reply.json', { text: value + '😀"\\'.repeat(8000) });
  const bounded = buildPipelineHistory(f.scope);
  assert.doesNotThrow(() => JSON.parse(bounded.runs[0].plan));
  assert.doesNotThrow(() => JSON.parse(bounded.runs[0].outcome));
});

test('large valid plan structures retain a usable latest anchor with explicit omissions', (t) => {
  const python = path.resolve('.scratch/pipeline/venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  for (const [stepCount, fileCount] of [[32, 10], [20, 15], [32, 100]]) {
    const f = fixture(t); f.run('run00001'); f.write('run00001', 'artifacts/plan.json', plan);
    f.run('run00002'); f.write('run00002', 'run.json', { task: 'LATEST-TASK: keep this work' });
    const large = { ...plan, summary: 'LATEST-PLAN: structural continuity', steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `step-${i}`, title: `Repair component ${i}`, description: 'Inspect and repair the component',
      files: Array.from({ length: fileCount }, (_, j) => ({ path: `src/component-${i}-${j}.js`, action: 'modify' })),
      depends_on: i ? [`step-${i - 1}`] : [], criteria: ['c1'],
    })) };
    f.write('run00002', 'artifacts/plan.json', large);
    f.run('run00003', { reply: { text: 'LATEST-ANSWER' } });
    const h = buildPipelineHistory(f.scope), latest = h.runs.find((r) => r.run_id === 'run00002');
    assert.ok(latest.plan, `${stepCount} steps x ${fileCount} files must not erase the latest plan`);
    const projected = JSON.parse(latest.plan);
    assert.equal(projected.summary, large.summary); assert.equal(projected.revision, 1);
    assert.equal(projected.truncated, true); assert.equal(h.truncated, true);
    assert.equal(projected.steps.length, stepCount, 'ordinary IDs and dependencies survive file-list compaction');
    for (const [i, step] of projected.steps.entries()) {
      assert.equal(step.id, large.steps[i].id); assert.equal(step.title, large.steps[i].title);
      assert.deepEqual(step.depends_on, large.steps[i].depends_on);
      assert.equal(step.files.length + (step.omitted?.files ?? 0), fileCount);
    }
    assert.ok(projected.steps.some((s) => s.omitted?.files > 0));
    assert.equal(JSON.parse(latest.outcome).plan_availability, 'available');
    assert.ok(Array.from(latest.plan).length <= 8000); assert.ok(Buffer.byteLength(JSON.stringify(h)) <= 32768);
    const consumed = spawnSync(python, ['-c', `import json,sys
from scranton_pipeline.models import Plan
from scranton_pipeline.history import history_block,validate_history
from scranton_pipeline.tools.secrets import Redactor
payload=json.load(sys.stdin)
Plan.model_validate(payload['plan'])
history=validate_history(payload['history'],Redactor())
block=history_block(history,12000)
assert len(block.encode())<=12000
assert 'LATEST-PLAN' in block and 'LATEST-TASK' in block and 'LATEST-ANSWER' in block
assert next(r for r in reversed(history['runs']) if r['plan'].strip())['run_id']=='run00002'
`], { input: JSON.stringify({ plan: large, history: h }), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONPATH: path.resolve('engine/src'), PYTHONPYCACHEPREFIX: path.resolve('.scratch/pipeline/bytecode') } });
    assert.equal(consumed.status, 0, consumed.stderr);
  }
});

test('historical dependencies distinguish default sequential, independent and explicit IDs', (t) => {
  const f = fixture(t); f.run('run00001');
  const steps = [undefined, null, [], ['step-0']].map((depends_on, i) => ({ ...plan.steps[0], id: `step-${i}`, depends_on }));
  f.write('run00001', 'artifacts/plan.json', { ...plan, steps });
  const projected = JSON.parse(buildPipelineHistory(f.scope).runs[0].plan);
  assert.deepEqual(projected.steps.map((s) => s.depends_on), [null, null, [], ['step-0']]);
});

test('oversized model-valid plans honestly fall back to an older usable advisory anchor', (t) => {
  const f = fixture(t); f.run('run00001'); f.write('run00001', 'artifacts/plan.json', plan);
  f.run('run00002');
  const large = { ...plan, steps: Array.from({ length: 32 }, (_, i) => ({ ...plan.steps[0], id: `step-${i}`,
    description: 'x'.repeat(40000), depends_on: null })) };
  const file = f.write('run00002', 'artifacts/plan.json', large);
  assert.ok(fs.statSync(file).size > 1024 * 1024);
  const unavailable = buildPipelineHistory(f.scope).runs.find((r) => r.run_id === 'run00002');
  for (let i = 3; i <= 5; i++) f.run('run0000' + i);
  const h = buildPipelineHistory(f.scope);
  assert.equal(h.runs[0].run_id, 'run00001'); assert.ok(h.runs[0].plan);
  assert.equal(unavailable.plan, '');
  assert.match(JSON.parse(unavailable.outcome).plan_availability, /missing, malformed, oversized or unreadable/);
  assert.doesNotMatch(unavailable.outcome, /"plan_availability":"available"/);
});
