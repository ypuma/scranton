import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createDreamingSources, dreamingCap, teamDreamingContext, pipelineDreamingCohort, teamDreamingCohort } from '../../src/core/dreaming-sources.js';
import { buildPipelineHistory } from '../../src/core/pipeline-history.js';
import { runCli } from '../../src/core/cli.js';
import { loadConfig } from '../../src/core/config.js';
import { auditRole } from '../../src/core/agents-config.js';
import { promptAudit } from '../../src/core/prompts.js';

function fixture(t) {
  const base = path.resolve('.scratch/dreaming-integration-fix/tests'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'unit-')), dataDir = path.join(dir, 'data'), workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = createProjectRegistry({ dataDir }), project = registry.addProject({ name: 'Test', workspace });
  const chat = registry.createChat(project.id), pipeline = registry.createChat(project.id, { engine: 'pipeline' });
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const events = (file, rows, engine, runId) => write(file, rows.map((e, i) => JSON.stringify({ ...(engine === 'team' ? { v: 1, runId } : { run_id: runId }), seq: i + 1, ts: '2026-01-01T00:00:00.000Z', ...e })).join('\n') + '\n');
  const cfg = loadConfig({ cwd: workspace, env: {}, flags: { trustedHost: true } });
  function team(runId = 'run1', extra = []) {
    const file = path.join(chat.hiveDir, 'runs', runId, 'events.jsonl');
    const gates = cfg.workflow.gates.flat();
    events(file, [{ type: 'run_started', request: 'PRIVATE-TASK-' + runId, maxFailedCycles: 3, execution: { workflow: cfg.workflow }, prompts: promptAudit(cfg), roles: gates.map((id) => auditRole({ ...cfg.roles.find((r) => r.id === id), tools: cfg.agents[id].tools })) }, ...extra,
      ...[1, 2, 3].map((cycle) => ({ type: 'cycle_result', milestoneId: 'm1', cycle, result: 'failed', reason: 'PRIVATE-AGENT-PROSE' })),
      { type: 'milestone_finished', milestoneId: 'm1', status: 'failed' }, { type: 'run_finished', status: 'failed' }], 'team', runId);
    return file;
  }
  const checks = [{ id: 'test', kind: 'test', argv: ['node', '--test'], required: true, timeout_s: 600, scope: 'step' }];
  function pipe(runId = 'abc12345', attempts = true, override = {}) {
    const root = path.join(dataDir, 'projects', project.id, 'chats', pipeline.id, 'pipeline/runs', runId);
    write(path.join(root, 'status.json'), { schema: 1, run_id: runId, status: 'failed', updated_at: '2026-01-01T00:00:00.000Z', delivery: { applied: false } });
    write(path.join(root, 'run.json'), { task: 'PRIVATE-PIPELINE-' + runId });
    write(path.join(root, 'config.json'), { checks, limits: { max_step_attempts: 3 }, ...override });
    events(path.join(root, 'events.jsonl'), [{ type: 'run_started' }, { type: 'check_finished', data: { id: 'test', status: 'passed' } }, ...(attempts ? [1, 2, 3].map((ordinal) => ({ type: 'dream_attempt', data: { schema: 1, scope: JSON.stringify([0, 'step:s1', null]), ordinal, result: 'failed', quality: 0, retry_ceiling: 3, plan_revision: 0 } })) : []), { type: 'run_finished', data: { status: 'failed' } }], 'pipeline', runId);
    return root;
  }
  const source = createDreamingSources({ dataDir, projectId: project.id });
  function rewritePipe(root, change) {
    const file = path.join(root, 'events.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    events(file, change(rows).map(({ seq, ...row }) => row), 'pipeline', path.basename(root));
  }
  return { rewritePipe, dir, dataDir, registry, project, chat, pipeline, write, events, team, pipe, source, cfg, checks };
}

test('adapter emits private deterministic sourced Team chains and cohort matches current evaluator', (t) => {
  const f = fixture(t); f.team();
  const e = f.source.collect().episodes[0]; assert.equal(e.attempts.length, 3); assert.equal(e.complete, true);
  assert.equal(e.cohort, teamDreamingCohort(f.cfg)); assert.match(e.taskHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(e), /PRIVATE|reason|request/); assert.match(e.observations[0].text, /failed outcome/);
  assert.deepEqual(f.source.collect().episodes[0], e);
  f.team('human', [{ type: 'hitl_response', decision: 'retry' }]);
  f.team('truncated', [{ type: 'agent_message', truncated: true }]);
  assert.equal(f.source.collect().episodes.find((e) => e.runId === 'human').intervened, true);
  assert.equal(f.source.collect().episodes.some((e) => e.runId === 'truncated'), false);
});

test('future Pipeline attempts use authoritative bindings, legacy contributes no invented attempt and final checks abstain', (t) => {
  const f = fixture(t); f.pipe(); f.pipe('abc12346', false); f.pipe('abc12347', true, { checks: [{ ...f.checks[0], scope: 'final' }] });
  const result = f.source.collect(), modern = result.episodes.find((e) => e.runId === 'abc12345' && e.attempts.length);
  assert.equal(modern.attempts.length, 3); assert.equal(modern.cohort, pipelineDreamingCohort({ checks: f.checks }));
  assert.ok(result.episodes.filter((e) => e.runId === 'abc12346').every((e) => !e.attempts.length));
  assert.equal(result.episodes.find((e) => e.runId === 'abc12347' && e.attempts.length).cohort, null);
  assert.equal(pipelineDreamingCohort({ checks: [] }), null);
  assert.equal(pipelineDreamingCohort({ checks: [{ ...f.checks[0], required: false }] }), null);
  assert.equal(dreamingCap({ policy() { assert.fail('unknown cohort must not call policy'); } }, 'pipeline', 3, pipelineDreamingCohort({ checks: [{ ...f.checks[0], scope: 'final' }] })), 3);
  assert.ok(result.limitations.some((s) => /Legacy/.test(s)));
});

test('unsafe, external, linked, oversized and unterminated histories never become evidence', (t) => {
  const f = fixture(t), file = f.team(); fs.appendFileSync(file, '{');
  assert.equal(f.source.collect().episodes.length, 0);
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1)); assert.equal(f.source.collect().episodes.length, 0);
  fs.rmSync(path.dirname(file), { recursive: true });
  const target = path.join(f.dir, 'linked'); fs.mkdirSync(target); f.write(path.join(target, 'events.jsonl'), '{}\n');
  fs.symlinkSync(target, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.source.collect().episodes.length, 0);
  f.registry.createChat(f.project.id, { hiveDir: target });
  assert.ok(f.source.collect().limitations.some((s) => /External/.test(s)));
});

test('registry memory is live revalidated and replay cap is engine/ceiling/cohort scoped and opt-in', (t) => {
  const f = fixture(t); const files = [f.team('one'), f.team('two'), f.team('three')];
  const dream = f.registry.dreaming(f.project.id); t.after(() => dream.close());
  assert.equal(dream.status().enabled, false); assert.equal(dream.policy('team', 3, teamDreamingCohort(f.cfg)), null);
  assert.equal(dream.preview().preview, true); assert.equal(fs.existsSync(path.join(f.dataDir, 'projects', f.project.id, 'dreaming')), false);
  const saved = dream.sweep(); assert.ok(saved.memory.length); assert.equal(saved.replay.worlds, 3);
  dream.configure({ applyPolicy: true }); assert.equal(dream.policy('team', 3, teamDreamingCohort(f.cfg)), 1);
  assert.equal(dream.policy('team', 2, teamDreamingCohort(f.cfg)), null); assert.equal(dream.policy('pipeline', 3, teamDreamingCohort(f.cfg)), null);
  assert.equal(dream.policy('team', 3, 'f'.repeat(64)), null);
  assert.ok(dream.structuredContext().length); assert.ok(teamDreamingContext('prior chat', dream.context()).startsWith('prior chat'));
  fs.appendFileSync(files[0], '\n'); fs.appendFileSync(files[1], '\n'); fs.appendFileSync(files[2], '\n');
  assert.equal(dream.context(), ''); assert.equal(dream.policy('team', 3, teamDreamingCohort(f.cfg)), null);
});

test('memory-only Pipeline history is real schema1 without fabricated runs and is bounded/redacted', (t) => {
  const f = fixture(t), projectMemory = [{ id: 'memory1', text: 'secret E-0123456789 ' + 'x'.repeat(500), sources: [`projects/${f.project.id}/source.json`] }];
  const h = buildPipelineHistory({ dataDir: f.dataDir, projectId: f.project.id, chatId: f.pipeline.id, projectMemory, redact: (s) => s.replaceAll('secret', '[REDACTED]') });
  assert.deepEqual(h.runs, []); assert.equal(h.schema, 1); assert.ok(h.project_memory[0].text.length <= 400);
  assert.doesNotMatch(h.project_memory[0].text, /secret|E-0123456789/); assert.ok(Buffer.byteLength(JSON.stringify(h)) <= 32768);
  assert.equal(buildPipelineHistory({ dataDir: f.dataDir, projectId: f.project.id, chatId: f.pipeline.id }), null);
});

test('learned cap never exceeds explicit operator ceiling and unknown cohorts abstain', () => {
  assert.equal(dreamingCap({ policy: () => 9 }, 'team', 2, 'a'.repeat(64)), 2);
  assert.equal(dreamingCap({ policy: () => 1 }, 'team', 2, 'a'.repeat(64)), 1);
  assert.equal(dreamingCap({ policy: () => 0 }, 'team', 2, 'a'.repeat(64)), 2);
});

test('dreaming CLI commands are registry scoped, JSON compatible and do not need pi/models', async (t) => {
  const f = fixture(t); let output = '', errors = '';
  const io = { cwd: f.dir, env: {}, stdout: { write: (s) => output += s }, stderr: { write: (s) => errors += s } };
  const args = ['--data', f.dataDir, '--project', f.project.id, '--json'];
  for (const action of ['status', 'preview', 'run', 'on', 'off', 'rollback']) {
    output = ''; assert.equal(await runCli(['dreaming', action, ...args], io), 0, errors);
    assert.equal(JSON.parse(output).projectId, f.project.id);
  }
  assert.equal(await runCli(['dreaming', 'status'], io), 2); assert.match(errors, /Registry projects only/);
});

// Matches dreaming.py's JSON tuple emitter, not the older handcrafted scope strings.
test('Pipeline tuple scopes preserve serial, revision and lane identity; invalid chains retain terminal facts', (t) => {
  const f = fixture(t);
  const valid = [[0, 'step:s1', null], [2, 'step:s1', [3, 0, 's1']], [2, 'rev:1', null], [0, 'step:' + '"\\😀'.repeat(341) + 'x', null]];
  for (const [i, tuple] of valid.entries()) {
    const root = f.pipe('valid000' + i);
    f.rewritePipe(root, (rows) => rows.map((e) => e.type === 'dream_attempt' ? { ...e, data: { ...e.data, scope: JSON.stringify(tuple), plan_revision: tuple[0] } } : e));
    const episodes = f.source.collect().episodes.filter((e) => e.runId === path.basename(root));
    assert.equal(episodes.filter((e) => e.attempts.length && e.complete).length, 1, JSON.stringify(tuple));
    assert.equal(episodes.filter((e) => !e.attempts.length).length, 1);
  }
  const invalid = ['step:s1', '{}', '[', [1, 'step:s1', null], [0, 'step:s1'], [0, 'int:1', null], [0, 'rev:0', null], [0, 'rev:1', [0, 0, 's1']], [0, 'step:s1', [0, 0, 'other']], [0, 'step:s1', [-1, 0, 's1']], [0, 'step:s1', [0, true, 's1']], [0, 'step:' + 'x'.repeat(1025), null]];
  for (const [i, tuple] of invalid.entries()) {
    const root = f.pipe('invalid0' + i);
    f.rewritePipe(root, (rows) => rows.map((e) => e.type === 'dream_attempt' ? { ...e, data: { ...e.data, scope: typeof tuple === 'string' ? tuple : JSON.stringify(tuple) } } : e));
    const episodes = f.source.collect().episodes.filter((e) => e.runId === path.basename(root));
    assert.equal(episodes.length, 1); assert.equal(episodes[0].attempts.length, 0); assert.equal(episodes[0].observations[0].verified, true);
  }
  for (const [i, mutate] of [
    (rows) => rows.splice(2, 1),
    (rows) => { rows[2].data.ordinal = 2; },
    (rows) => { rows[2].data.result = 'passed'; rows[2].data.quality = 1; },
    (rows) => { rows[2].data.retry_ceiling = 2; },
    (rows) => { rows[2].data.quality = 1; }
  ].entries()) {
    const root = f.pipe('broken00' + i);
    f.rewritePipe(root, (rows) => { mutate(rows); return rows; });
    const episodes = f.source.collect().episodes.filter((e) => e.runId === path.basename(root));
    assert.equal(episodes.length, 1, `broken chain ${i}: ${JSON.stringify(f.source.collect().limitations)}`); assert.equal(episodes[0].attempts.length, 0);
  }
});

test('Pipeline clean approvals are autonomous only with explicit no-feedback resume evidence; demo excluded independently', (t) => {
  const f = fixture(t);
  const cases = [
    [{ gate: 'plan', decision: 'approve', has_feedback: false }, false],
    [{ gate: 'delivery', decision: 'approve', has_feedback: false }, false],
    [{ gate: 'plan', decision: 'approve', has_feedback: true }, true],
    [{ gate: 'plan', decision: 'reject', has_feedback: false }, true],
    [{ gate: null, decision: null, has_feedback: false }, true],
    [{}, true], [{ gate: 'plan', decision: 'approve' }, true]
  ];
  for (const [i, [data, intervened]] of cases.entries()) {
    const root = f.pipe('resume00' + i);
    f.rewritePipe(root, (rows) => [rows[0], { type: 'run_resumed', data }, ...rows.slice(1)]);
    assert.ok(f.source.collect().episodes.filter((e) => e.runId === path.basename(root)).every((e) => e.intervened === intervened));
  }
  const demo = f.pipe('demo0000'); f.write(path.join(demo, 'run.json'), { task: 'Demo', demo: true });
  assert.equal(f.source.collect().episodes.some((e) => e.runId === 'demo0000'), false);
});

test('Team project memory yields whole blocks before established newest same-chat history', () => {
  const history = 'OLDEST-RUN\n' + 'h'.repeat(7900) + '\nLATEST-RUN-LATEST-PLAN';
  assert.equal(teamDreamingContext(history, 'memory'.repeat(300)), history);
  assert.ok(teamDreamingContext('LATEST-RUN', 'short memory').includes('short memory'));
});

test('imported legacy sources are excluded without treating inert history as busy; ownership and unknown state still defer', (t) => {
  const f = fixture(t), hive = path.join(f.dataDir, 'hive');
  f.registry.createChat(f.project.id, { hiveDir: hive });
  f.write(path.join(hive, 'state.json'), { v: 1, status: 'finished' });
  assert.equal(f.source.isBusy(), false);
  assert.ok(f.source.collect().limitations.some((s) => /External/.test(s)));
  f.write(path.join(hive, 'control/owner.json'), 'null'); assert.equal(f.source.isBusy(), true);
  fs.rmSync(path.join(hive, 'control/owner.json'));
  f.write(path.join(hive, 'state.json'), '{'); assert.throws(() => f.source.isBusy(), /cannot establish project idle/);
  f.write(path.join(hive, 'state.json'), { status: 'running' }); assert.equal(f.source.isBusy(), true);
});

test('older large histories do not become permanent busy and unscannable liveness reports an accurate error', (t) => {
  const f = fixture(t);
  const chats = path.join(f.dataDir, 'projects', f.project.id, 'chats');
  const template = JSON.parse(fs.readFileSync(path.join(chats, f.chat.id, 'chat.json')));
  for (let i = 0; i < 130; i++) f.write(path.join(chats, 'old' + i, 'chat.json'), { ...template, id: 'old' + i });
  const runs = path.join(chats, f.pipeline.id, 'pipeline/runs');
  for (let i = 0; i < 130; i++) f.write(path.join(runs, 'oldrun' + i, 'status.json'), { status: 'failed' });
  assert.equal(f.source.isBusy(), false); assert.ok(f.source.collect().limitations.length);
  f.write(path.join(runs, 'oldrun129/status.json'), { status: 'suspended' }); assert.equal(f.source.isBusy(), true);
  f.write(path.join(runs, 'oldrun129/status.json'), '{'); assert.throws(() => f.source.isBusy(), /cannot establish project idle/);
});

test('paired Python attempt_observation fixtures cross the Node boundary without scope invention', (t) => {
  const f = fixture(t);
  const fixtures = JSON.parse(fs.readFileSync(new URL('./dreaming-emitter-fixtures.json', import.meta.url), 'utf8'));
  for (const [index, pair] of fixtures.entries()) {
    for (const variant of ['positive', 'negative']) {
      const runId = `emitter${index}${variant}`;
      const root = f.pipe(runId);
      f.rewritePipe(root, (rows) => [rows[0], ...pair[variant].map((data) => ({ type: 'dream_attempt', data })), rows.at(-1)]);
      const episodes = f.source.collect().episodes.filter((e) => e.runId === runId);
      assert.equal(episodes.filter((e) => e.attempts.length && e.complete).length, Number(variant === 'positive'), pair.name);
      assert.equal(episodes.filter((e) => !e.attempts.length).length, 1);
    }
  }
});

test('actual scripted Python CLI clean and feedback resume events preserve autonomous classification', (t) => {
  const f = fixture(t);
  const resumes = JSON.parse(fs.readFileSync(new URL('./dreaming-resume-fixtures.json', import.meta.url), 'utf8'));
  assert.deepEqual(resumes.map((r) => r.data.has_feedback), [false, true, true]);
  for (const [index, row] of resumes.entries()) {
    const runId = `actualresume${index}`, root = f.pipe(runId);
    f.rewritePipe(root, (rows) => [rows[0], { type: 'run_resumed', data: row.data }, ...rows.slice(1)]);
    const episodes = f.source.collect().episodes.filter((e) => e.runId === runId);
    assert.equal(episodes.length, 2);
    assert.ok(episodes.every((e) => e.intervened === row.data.has_feedback));
    assert.equal(episodes.some((e) => e.observations.length > 0), !row.data.has_feedback);
  }
});
