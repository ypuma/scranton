import './helpers.js';
import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { handoffBody, dwightMessage, gateBugReport } from '../../src/core/messages.js';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { WorktreeManager } from '../../src/core/worktree.js';

const context = { milestone: { id: 'm1', title: 'Example', description: 'Implement the example.', acceptanceCriteria: ['It works'] }, request: 'Example request', cycle: 1, dwightReport: 'Done [TASK_COMPLETE]' };

// Original handoffBody, retained as the byte-level legacy oracle.
function oldHandoffBody({ milestone: m, request, cycle, dwightReport }) {
  return [
    `# Handoff: verify milestone ${m.id} - ${m.title} (cycle ${cycle})`,
    '',
    'The Developer reports the milestone as complete. Verify every acceptance criterion independently; do not create or modify files in the project.',
    '',
    '## Milestone',
    '',
    m.description,
    '',
    '## Acceptance criteria',
    '',
    m.acceptanceCriteria.length ? m.acceptanceCriteria.map((c) => `- ${c}`).join('\n') : '- The milestone works as described and is covered by automated tests.',
    '',
    "## Developer's report",
    '',
    dwightReport,
    '',
    '## Overall request (context only)',
    '',
    request
  ].join('\n');
}

for (const [role, purpose, instruction] of [
  ['oscar', 'review milestone', /Review the changes for correctness, edge cases, error handling, regressions, maintainability, and test coverage/],
  ['hank', 'security audit of milestone', /Audit the changes for security vulnerabilities/],
  ['angela', 'verify milestone', /Verify every acceptance criterion independently/]
]) test(`${role} regression guard: retains its own handoff purpose and instruction`, () => {
  const body = handoffBody({ ...context, role });
  assert.match(body, instruction);
  assert.ok(body.startsWith(`# Handoff: ${purpose} m1`));
  assert.match(body, /do not create or modify files/);
  assert.match(body, /- It works/);
  if (role !== 'angela') {
    assert.notEqual(body, handoffBody({ ...context, role: 'angela' }));
    assert.match(body, /Acceptance criteria \(context only, not the gate verdict basis\)/);
  }
});

test('Angela default and explicit handoffs remain byte-identical to the old body', () => {
  for (const acceptanceCriteria of [[], ['It works'], ['First', 'Second']]) {
    const input = { ...context, milestone: { ...context.milestone, acceptanceCriteria }, changedFiles: ['ignored.txt'] };
    assert.equal(handoffBody(input), oldHandoffBody(input));
    assert.equal(handoffBody({ ...input, role: 'angela' }), oldHandoffBody(input));
  }
});

test('review and security changed-file sections contain at most 200 sanitized paths', () => {
  const changedFiles = ['src/a\n\r\t\x00\x1b\x7f\x85\u2028\u2029.js', ...Array.from({ length: 204 }, (_, i) => `src/file-${i}.js`)];
  for (const role of ['oscar', 'hank']) {
    const body = handoffBody({ ...context, role, changedFiles });
    const section = body.split('## Changed files\n\n')[1]?.split("## Developer's report")[0];
    assert.ok(section, 'changed files section is present');
    assert.equal(section.split('\n').filter((line) => line.startsWith('- ')).length, 200);
    assert.match(section, /- src\/a.js/);
    assert.match(section, /and 5 more/);
    assert.doesNotMatch(section, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/);
    assert.doesNotMatch(section, /file-199\.js/);
    assert.doesNotMatch(handoffBody({ ...context, role }), /## Changed files/);
  }
});

test('gate bug reports are neutral with one heading; legacy Angela attribution is unchanged', () => {
  const failures = [{ agent: 'oscar', text: 'Fix this [CHANGES_REQUESTED]' }, { agent: 'hank', text: 'Fix that [SECURITY_ISSUES]' }];
  for (const body of [gateBugReport({ ...context, failures }), dwightMessage({ ...context, kind: 'bug_report', gateReports: failures })]) {
    assert.match(body, /Gate verification failed for your previous work/);
    assert.doesNotMatch(body, /QA Tester's QA failed/);
    assert.equal((body.match(/^# Bug report:/gm) ?? []).length, 1);
    assert.match(body, /Code Reviewer's Review report/);
    assert.match(body, /Security Auditor's Security report/);
  }
  assert.match(dwightMessage({ ...context, kind: 'bug_report', angelaReport: 'Failed' }), /The QA Tester's QA failed your previous work\. Fix the reported failures first, then make sure every acceptance criterion holds\./);
});

function fixture(t) {
  const root = path.resolve('.scratch/prompt-fix/gate-handoff');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ cwd: dir, env: {}, flags: { gates: 'oscar+hank,angela', trustedHost: true }, fileConfig: {  } });
  config.scripted = 'happy';
  return { dir, config };
}

function inboxes(hiveDir, agent) {
  const dir = path.join(hiveDir, agent);
  const archive = path.join(dir, 'archive');
  return [path.join(dir, 'inbox.md'), ...(fs.existsSync(archive) ? fs.readdirSync(archive).map((name) => path.join(archive, name)) : [])].map((file) => fs.readFileSync(file, 'utf8'));
}

test('CLI --gates delivers distinct handoffs and neutral CHANGES_REQUESTED report with the scripted model', async (t) => {
  const { dir, config } = fixture(t);
  await promisify(execFile)(process.execPath, [path.resolve('bin/scranton.js'), 'run', 'Test gates', '--trusted-host', '--no-plan', '--gates', 'oscar+hank,angela', '--workspace', config.workspace, '--hive', config.hiveDir], { cwd: dir, env: { ...process.env, SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'changes_once' }, timeout: 30000 });
  const oscar = inboxes(config.hiveDir, 'oscar-m1').find((text) => /cycle: 1/.test(text));
  const hank = inboxes(config.hiveDir, 'hank-m1').find((text) => /cycle: 1/.test(text));
  assert.match(oscar, /Review the changes for correctness/);
  assert.match(hank, /Audit the changes for security vulnerabilities/);
  assert.notEqual(oscar, hank);
  for (const body of [oscar, hank]) {
    assert.match(body, /## Changed files\n\n- todo\.js/);
    assert.match(body, /## How to see the changes\n\nYou are in your own checkout of the Developer's snapshot/);
    assert.match(body, /Changed files list below is authoritative/);
    assert.match(body, /git diff HEAD\^ HEAD/);
  }
  const report = inboxes(config.hiveDir, 'dwight-m1').find((text) => /kind: bug_report/.test(text));
  assert.match(report, /CHANGES_REQUESTED/);
  assert.match(report, /Gate verification failed/);
  assert.doesNotMatch(report, /QA Tester's QA failed/);
});

for (const decision of ['retry', 'feedback']) test(`breaker ${decision} preserves neutral gate report attribution`, async (t) => {
  const { config } = fixture(t);
  config.maxFailedCycles = 1;
  const o = new Orchestrator({ config, noPlan: true, extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'changes_once' }, hitl: async () => ({ decision, feedback: 'Fix review findings' }) });
  assert.equal((await o.run('gate retry')).status, 'success');
  const body = inboxes(config.hiveDir, 'dwight-m1')[0];
  assert.match(body, /Code Reviewer's Review report/);
  assert.doesNotMatch(body, /QA Tester's QA failed|QA Tester's last QA report/);
  assert.match(body, decision === 'retry' ? /Gate verification failed/ : /A human intervened/);
});

test('snapshot paths cover additions, deletions and mode/content changes relative to milestone base', async (t) => {
  const { dir, config } = fixture(t);
  fs.mkdirSync(config.workspace, { recursive: true });
  for (const name of ['deleted.txt', 'modified.txt', 'mode.txt', 'unchanged.txt']) fs.writeFileSync(path.join(config.workspace, name), 'base');
  const manager = new WorktreeManager({ workspace: config.workspace, hiveDir: config.hiveDir, runId: 'handoff-paths' });
  await manager.init(); t.after(() => manager.close());
  assert.equal(manager.changedFiles({ milestoneId: 'm1' }), null);
  const dev = await manager.createWorktree({ agent: 'dwight', milestoneId: 'm1' });
  fs.unlinkSync(path.join(dev.dir, 'deleted.txt'));
  fs.writeFileSync(path.join(dev.dir, 'modified.txt'), 'changed');
  fs.writeFileSync(path.join(dev.dir, 'added.txt'), 'new');
  await manager.snapshotWorktree({ agent: 'dwight', milestoneId: 'm1' });
  manager.snapshots.get('m1').entries.get('mode.txt').mode = '100755';
  assert.deepEqual(manager.changedFiles({ milestoneId: 'm1' }), ['added.txt', 'deleted.txt', 'mode.txt', 'modified.txt']);
  assert.equal(fs.existsSync(path.join(dir, 'hive', 'todo.js')), false);
});

test('shared trusted-host handoffs omit unavailable snapshot paths', async (t) => {
  const { config } = fixture(t);
  config.execution.isolation = 'shared';
  const o = new Orchestrator({ config, noPlan: true, extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy' } });
  assert.equal((await o.run('shared gates')).status, 'success');
  for (const role of ['oscar', 'hank']) {
    const body = inboxes(config.hiveDir, `${role}-m1`)[0];
    assert.doesNotMatch(body, /## Changed files/);
    assert.match(body, role === 'oscar' ? /Review the changes/ : /Audit the changes/);
    assert.match(body, /## How to see the changes\n\nYou are in the shared workspace/);
    assert.match(body, /The Developer's changes are uncommitted/);
    assert.match(body, /git status --short.*git diff/);
    assert.match(body, /earlier milestones' changes/);
    assert.doesNotMatch(body, /HEAD\^/);
  }
});

for (const role of ['oscar', 'hank']) {
  test(`${role} Docker handoff explains masked Git metadata`, () => {
    const body = handoffBody({ ...context, role, isolation: 'worktree', docker: true, changedFiles: ['src/a.js'] });
    assert.match(body, /Docker masks \x60\.git\x60, so rely on the list there/);
    assert.match(body, /own checkout of the Developer's snapshot/);
  });

  test(`${role} empty changed-files list states the milestone has no changes`, () => {
    const body = handoffBody({ ...context, role, changedFiles: [] });
    assert.match(body, /## Changed files\n\nNo file changes against the milestone base\./);
  });

  test(`${role} caps a 5000-character changed path at 300 characters`, () => {
    const body = handoffBody({ ...context, role, changedFiles: ['a'.repeat(5000)] });
    const line = body.split('## Changed files\n\n')[1].split('\n')[0];
    assert.equal(line.length, 302, 'path plus bullet is bounded to 302 characters');
    assert.ok(line.endsWith('...'), 'truncated path has an ellipsis');
  });
}
