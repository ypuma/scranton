import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.js';
import { readAgentHistory } from '../../../src/core/agent/index.js';
import { scriptedSettings } from '../../../src/core/agent/scripted.js';

const inbox = (kind = 'task', cycle = 1, body = '') => `---\nkind: ${kind}\nmilestone: m2\ncycle: ${cycle}\n---\n${body}`;
async function run(t, scripted, extra = {}) {
  const s = await fixture(t, { model: undefined, scripted, milestone: 'm2', message: inbox(), ...extra });
  const runner = s.start(); return { ...s, runner, result: await runner.done };
}

test('happy Michael produces the same usable three-milestone plan', async t => {
  const { result } = await run(t, 'happy', { agentId: 'michael', agentConfig: { tools: ['ls'], keywords: ['PLAN_READY'] }, message: '## Request\nBuild a todo CLI' });
  assert.equal(result.ok, true); assert.equal(result.keyword, 'PLAN_READY');
  const plan = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result.text)[1]);
  assert.deepEqual(plan.milestones.map(m => m.id), ['m1', 'm2', 'm3']); assert.match(plan.milestones[0].description, /Build a todo CLI/);
});

test('Dwight writes actual demo sources via write tools for every milestone', async t => {
  const tools = []; const s = await fixture(t, { model: undefined, scripted: 'happy', onTool: value => tools.push(value) });
  for (let n = 1; n <= 3; n++) {
    const r = s.start({ message: `---\nkind: task\nmilestone: m${n}\ncycle: 2\n---\n` });
    const result = await r.done; assert.equal(result.keyword, 'TASK_COMPLETE', JSON.stringify(result));
    const history = await readAgentHistory(s.runtime, r.workflowId);
    assert.ok(history.some(m => m.role === 'toolResult' && m.toolName === 'write' && !m.isError));
  }
  for (const file of ['todo.js', 'cli.js', 'test/todo.test.js', 'README.md']) assert.match(await fs.readFile(path.join(s.dir, file), 'utf8'), /revision for cycle 2/);
  assert.equal(tools.filter(t => t.tool === 'write').length, 4);
  const child = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--test', 'test/todo.test.js'], { cwd: s.dir }); let output = '';
    p.stdout.on('data', data => { output += data; }); p.stderr.on('data', data => { output += data; });
    p.on('error', reject); p.on('close', code => resolve({ code, output }));
  });
  assert.equal(child.code, 0, child.output);
});

for (const [scenario, cycle, feedback, keyword] of [
  ['happy', 1, false, 'TEST_PASSED'], ['flaky', 1, false, 'TEST_FAILED'], ['flaky', 2, false, 'TEST_PASSED'],
  ['breaker', 1, false, 'TEST_FAILED'], ['breaker', 3, false, 'TEST_FAILED'], ['breaker', 4, true, 'TEST_PASSED'],
]) test(`${scenario} Angela cycle ${cycle}${feedback ? ' after feedback' : ''}`, async t => {
  const { result } = await run(t, scenario, { agentId: 'angela', message: inbox('handoff', cycle, feedback ? '## Human feedback\nFix it' : '## Acceptance criteria\n- Works'), agentConfig: { tools: ['ls', 'read', 'bash'], keywords: ['TEST_PASSED', 'TEST_FAILED'] } });
  assert.equal(result.keyword, keyword, JSON.stringify(result));
});

test('blocked Dwight waits for feedback before writing the CLI', async t => {
  const s = await run(t, 'blocked'); assert.equal(s.result.keyword, 'BLOCKED');
  await assert.rejects(fs.stat(path.join(s.dir, 'cli.js')));
  const result = await s.start({ message: inbox('feedback', 2, '## Human feedback\nKeep todos here') }).done;
  assert.equal(result.keyword, 'TASK_COMPLETE'); assert.match(result.text, /Keep todos here/);
  assert.ok(await fs.stat(path.join(s.dir, 'cli.js')));
});

test('question answers directly and report_request produces REPORT_READY', async t => {
  const s = await run(t, 'question', { agentId: 'michael', extraEnv: { SCRANTON_CONVERSATION: '1' }, agentConfig: { tools: ['ls'], keywords: ['ANSWER_READY', 'REPORT_READY'] } });
  assert.equal(s.result.keyword, 'ANSWER_READY');
  assert.equal((await s.start({ message: inbox('report_request') }).done).keyword, 'REPORT_READY');
});

test('delay and per-role delay apply before provider turns', async t => {
  const start = Date.now(); const s = await run(t, { scenario: 'happy', delayMs: 1, michaelDelayMs: 40 }, { agentId: 'michael', agentConfig: { tools: ['ls'], keywords: ['PLAN_READY'] } });
  assert.equal(s.result.ok, true); assert.ok(Date.now() - start >= 80);
});

test('invalid plan retains PLAN_READY but has no plan JSON', async t => {
  const { result } = await run(t, { plan: 'invalid' }, { agentId: 'michael', agentConfig: { tools: ['ls'], keywords: ['PLAN_READY'] } });
  assert.equal(result.keyword, 'PLAN_READY'); assert.doesNotMatch(result.text, /```json/);
});

test('unscoped keyword override is ignored by the scripted model', async t => {
  const { result } = await run(t, { keyword: 'BLOCKED' }); assert.equal(result.keyword, 'TASK_COMPLETE');
});

test('keyword override is scoped to its role', async t => {
  const s = await run(t, { keyword: 'BLOCKED', keywordRole: 'angela' }); assert.equal(s.result.keyword, 'TASK_COMPLETE');
  assert.equal((await s.start({ agentId: 'angela' }).done).keyword, 'BLOCKED');
});

test('missing keyword is scoped to its role', async t => {
  const s = await run(t, { missingKeywordRole: 'dwight' }); assert.equal(s.result.ok, true); assert.equal(s.result.keyword, null);
  const result = await s.start({ agentId: 'michael', agentConfig: { tools: ['ls'], keywords: ['PLAN_READY'] } }).done;
  assert.equal(result.keyword, 'PLAN_READY');
});

test('long text exceeds the consumer 16000-character cap', async t => {
  const { result } = await run(t, { longText: true }, { extraEnv: { SCRANTON_CONVERSATION: '1' } }); assert.ok(result.text.length > 16000); assert.equal(result.keyword, 'TASK_COMPLETE');
});

for (const [fail, kind] of [['exit1', 'exit'], ['stoperror', 'stop_reason'], ['nomessage', 'no_message'], ['hang', 'timeout']]) test(`failure injection ${fail} is role-scoped`, async t => {
  const s = await run(t, { fail, failRole: 'angela' }); assert.equal(s.result.ok, true);
  const result = await s.start({ agentId: 'angela', ...(fail === 'hang' ? { timeoutMs: 80 } : {}) }).done;
  assert.equal(result.ok, false); assert.equal(result.failure.kind, kind, JSON.stringify(result)); assert.equal(result.keyword, null);
});

test('report missing keyword and report failure are independent of task failure settings', async t => {
  const s = await run(t, { reportFail: 'missing' }, { agentId: 'michael', extraEnv: { SCRANTON_CONVERSATION: '1' }, agentConfig: { tools: ['ls'], keywords: ['PLAN_READY', 'REPORT_READY'] } });
  assert.equal(s.result.keyword, 'PLAN_READY');
  const missing = await s.start({ message: inbox('report_request') }).done; assert.equal(missing.ok, true); assert.equal(missing.keyword, null);
  const failed = await s.start({ scripted: { reportFail: 'exit1' }, message: inbox('report_request') }).done;
  assert.equal(failed.failure.kind, 'exit');
});

test('JSON invocation log records prompt, role/config and execution metadata', async t => {
  const s = await fixture(t, { model: undefined }); const file = path.join(s.dir, 'received.jsonl');
  const r = s.start({ scripted: { log: file }, message: inbox('bug_report', 2, '## Request\nRepair'), systemPrompt: 'Role instructions' });
  assert.equal((await r.done).ok, true);
  const [entry] = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entry.role, 'dwight'); assert.equal(entry.kind, 'bug_report'); assert.equal(entry.cycle, 2); assert.equal(entry.milestone, 'm2');
  assert.equal(entry.cwd, s.dir); assert.equal(entry.systemPrompt, 'Role instructions'); assert.match(entry.message, /Repair/); assert.deepEqual(entry.agentConfig, s.options.agentConfig);
});

test('expected system prompt validates resolved prompt files', async t => {
  const s = await fixture(t, { model: undefined }); const file = path.join(s.dir, 'system.md'); await fs.writeFile(file, 'Resolved role');
  assert.equal((await s.start({ scripted: { expectPrompt: 'Resolved role' }, systemPromptFile: file }).done).ok, true);
  assert.match((await s.start({ scripted: { expectPrompt: 'Missing' }, systemPromptFile: file }).done).failure.message, /system prompt missing/);
});

test('environment activation needs MODE=1 and SCENARIO', async t => {
  assert.equal(scriptedSettings(undefined, { FAKE_PI_SCENARIO: 'happy', SCRANTON_FAKE_FAIL: 'hang' }), null);
  for (const mode of [undefined, '', '0', 'true']) assert.equal(scriptedSettings(undefined, { SCRANTON_FAKE_MODE: mode, SCRANTON_FAKE_SCENARIO: 'happy' }), null);
  assert.equal(scriptedSettings(undefined, { SCRANTON_FAKE_MODE: '1' }), null);
  assert.equal(scriptedSettings('happy', {}).scenario, 'happy');
  assert.deepEqual(scriptedSettings(undefined, { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'flaky', SCRANTON_FAKE_FAIL: 'nomessage' }), { scenario: 'flaky', fail: 'nomessage' });
  const { result } = await run(t, undefined, { extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy', SCRANTON_FAKE_KEYWORD: 'BLOCKED', SCRANTON_FAKE_KEYWORD_ROLE: 'dwight', FAKE_PI_FAIL: 'exit1' } });
  assert.equal(result.ok, true); assert.equal(result.keyword, 'BLOCKED');
});

for (const [role, scenario, keyword] of [['oscar', 'happy', 'REVIEW_APPROVED'], ['hank', 'security_issues', 'SECURITY_ISSUES'], ['oscar', 'changes_once', 'CHANGES_REQUESTED'], ['oscar', 'blocked', 'BLOCKED'], ['custom', 'happy', 'CUSTOM_PASS']]) test(`gate ${role} ${scenario}`, async t => {
  const { result } = await run(t, scenario, { agentId: role, agentConfig: { kind: 'gate', tools: ['ls'], keywords: [keyword] }, extraEnv: role === 'custom' ? { SCRANTON_PASS_KEYWORD: keyword } : {} });
  assert.equal(result.keyword, keyword);
});

test('child process activates scripted requests using new environment variables only', async t => {
  const s = await fixture(t); const file = path.join(s.dir, 'child.jsonl');
  const result = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['test/core/agent/scripted-child.js', s.dir], { env: { ...process.env,
      SCRANTON_FAKE_MODE: '1', SCRANTON_CONVERSATION: '1', SCRANTON_FAKE_SCENARIO: 'question', SCRANTON_FAKE_LOG: file, SCRANTON_FAKE_MICHAEL_DELAY_MS: '1',
      FAKE_PI_SCENARIO: 'breaker', FAKE_PI_FAIL: 'exit1' } });
    let stdout = '', stderr = '';
    p.stdout.on('data', data => { stdout += data; }); p.stderr.on('data', data => { stderr += data; });
    p.on('error', reject); p.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout.trim()).keyword, 'ANSWER_READY');
  assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).trim()).scenario, 'question');
});

test('new environment settings map to scenario options without legacy aliases', () => {
  const suffixes = { DELAY_MS: 'delayMs', LOG: 'log', FAIL: 'fail', FAIL_ROLE: 'failRole', PLAN: 'plan',
    KEYWORD: 'keyword', KEYWORD_ROLE: 'keywordRole', MISSING_KEYWORD_ROLE: 'missingKeywordRole', LONG_TEXT: 'longText', REPORT_FAIL: 'reportFail', EXPECT_PROMPT: 'expectPrompt' };
  const env = { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'happy' };
  for (const suffix of Object.keys(suffixes)) env[`SCRANTON_FAKE_${suffix}`] = suffix;
  const settings = scriptedSettings(undefined, env);
  for (const [suffix, option] of Object.entries(suffixes)) assert.equal(settings[option], suffix);
});

test('gates do not issue the extra ls call', async t => {
  const tools = [];
  const { result } = await run(t, 'happy', { agentId: 'oscar', agentConfig: { kind: 'gate', tools: [], keywords: ['REVIEW_APPROVED'] }, onTool: value => tools.push(value.tool) });
  assert.equal(result.keyword, 'REVIEW_APPROVED');
  assert.deepEqual(tools, []);
});

test('question and report handling require conversation mode', async t => {
  const s = await run(t, { scenario: 'question', reportFail: 'exit1' }, { agentId: 'michael', agentConfig: { tools: ['ls'], keywords: ['PLAN_READY', 'ANSWER_READY', 'REPORT_READY'] } });
  assert.equal(s.result.keyword, 'PLAN_READY');
  const report = await s.start({ message: inbox('report_request') }).done;
  assert.equal(report.ok, true); assert.equal(report.keyword, 'PLAN_READY');
});

for (const [fail, kind] of [['exit1', 'exit'], ['stoperror', 'stop_reason'], ['nomessage', 'no_message']]) test(`checkpointed scripted ${fail} retains classification on replay`, async t => {
  const { createAgentScript } = await import('../../../src/core/agent/scripted.js');
  const { errorData, revive } = await import('../../../src/core/durable/shared.js');
  const { runAgentWorkflow } = await import('../../../src/core/agent/workflow.js');
  const script = await createAgentScript({ fail }, { agentId: 'dwight', message: '', env: {} });
  let saved;
  try { for await (const event of script.llm.stream(script.model, {}, { signal: new AbortController().signal })) void event; }
  catch (error) { saved = errorData(error); }
  assert.ok(saved);
  assert.equal(revive(saved).agentFailure, undefined);
  const wf = { now: async () => 0, writeStream: async () => {}, setEvent: async () => {}, closeStream: async () => {}, recv: async () => null,
    runStep: async (body, options) => { if (options.name === 'llm:0') throw revive(saved); return body(); } };
  const result = await runAgentWorkflow(wf, { messages: [], maxTurns: 1, sessionId: 'replay' }, { controller: new AbortController() });
  assert.equal(result.failure.kind, kind);
});
