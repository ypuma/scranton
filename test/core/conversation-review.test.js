import './helpers.js';
import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadConfig } from '../../src/core/config.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { startAgent } from '../../src/core/agent/index.js';
import { resolvePrompt } from '../../src/core/prompts.js';
import { createTerminalLog } from '../../src/core/log.js';
import { conversationProof } from './fixtures/conversation-proof.js';

const root = path.resolve('.scratch/chat-backend-fix/review');
fs.mkdirSync(root, { recursive: true });
function fixture(t, { worktree = false } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive'), workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'user.txt'), 'user bytes\n');
  const fileConfig = { execution: { conversation: true, ...(!worktree ? { isolation: 'shared' } : {}), maxParallel: 1, sandbox: { mode: 'host' } },  };
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(fileConfig));
  const config = loadConfig({ env: {}, cwd: dir, fileConfig, flags: { hive, workspace } });
  config.scripted = 'happy';
  return { dir, hive, workspace, file, config };
}
const eventsAt = (hive) => fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const body = (file) => fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n\n?/, '').trimEnd();
function runCli(f, scenario, command = 'run') {
  const result = spawnSync(process.execPath, ['bin/scranton.js', command, '--trusted-host', ...(command === 'run' ? [scenario === 'question' ? 'How does the Team orchestrator handle a request?' : 'Build a tiny todo CLI'] : ['--scenario', scenario, '--delay', '0']), '--config', f.file, '--hive', f.hive, '--workspace', f.workspace, '--on-breaker', 'abort', '--conversation', '--ascii'], {
    env: { ...process.env, SCRANTON_DATA: '', SCRANTON_ISOLATION_ROOT: path.join(f.dir, 'iso'), SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: scenario, SCRANTON_FAKE_DELAY_MS: '0', SCRANTON_FAKE_DETERMINISTIC: '1' }, encoding: 'utf8', timeout: 60000
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  return { result, events: eventsAt(f.hive) };
}

test('CLI conversation messages strip ANSI, controls and dashboard bidi/format classes', () => {
  for (const ascii of [false, true]) {
    let output = '';
    const log = createTerminalLog({ stream: { write: (s) => { output += s; } }, env: { NO_COLOR: '1' }, ascii });
    const text = 'Visible\x1b]0;hostile title\x07\x1b[2J\x00\x08\x9b\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufe0e\ufe0f safe\nnext';
    for (const type of ['agent_message', 'run_reply']) log({ type, agent: 'michael', kind: 'answer', ts: '2026-01-01T00:00:00Z', text });
    assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufe0e\ufe0f]/, 'CLI strips hostile terminal characters');
    assert.doesNotMatch(output, /hostile title/); assert.match(output, /Visible/); assert.match(output, /safe\nnext/);
  }
});

test('staged Michael system prompt overrides plan-only rules for builtin and custom, audit hashes actual text', async (t) => {
  for (const custom of [false, true]) for (const conversation of [false, true]) {
    const f = fixture(t); f.config.execution.conversation = conversation;
    if (custom) { fs.mkdirSync(f.config.promptsDir, { recursive: true }); fs.writeFileSync(path.join(f.config.promptsDir, 'michael.md'), 'Always reply with a plan. [PLAN_READY]'); }
    const original = resolvePrompt(f.config, 'michael').text;
    const o = new Orchestrator({ config: f.config, onBreaker: 'abort', extraEnv: { SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'question', SCRANTON_FAKE_DELAY_MS: '0' } });
    await o.run('How does the Team orchestrator handle a request?');
    const staged = fs.readFileSync(path.join(f.hive, 'michael/system.md'), 'utf8');
    if (conversation) {
      assert.match(staged, /## Conversation mode/, 'Michael receives conversation system override');
      assert.match(staged, /Required answer/); assert.match(staged, /overrides any earlier rule/);
      for (const keyword of ['PLAN_READY', 'ANSWER_READY', 'REPORT_READY']) assert.ok(staged.includes(`[${keyword}]`));
    } else assert.doesNotMatch(staged, /## Conversation mode/);
    assert.ok(staged.startsWith(original + '\n\n## Progress checks\n'), 'run-only progress instructions follow the unchanged source');
    assert.equal((staged.match(/## Progress checks/g) ?? []).length, 1);
    assert.equal(eventsAt(f.hive)[0].prompts.michael.sha256, createHash('sha256').update(staged.trimEnd()).digest('hex'), 'audit commits actual staged prompt');
    assert.equal(resolvePrompt(f.config, 'michael').text, original, 'source prompt is never edited');
  }
});

function synthetic(text, keyword, ok = true) {
  return { text, keyword, ok, exitCode: ok ? 0 : 1, durationMs: 0, ...(!ok ? { failure: { kind: 'timeout', message: 'Report timeout' } } : {}) };
}
test('inline trailing answer/report keywords are removed but interior keywords survive', async (t) => {
  for (const report of [false, true]) {
    const f = fixture(t);
    const keyword = report ? 'REPORT_READY' : 'ANSWER_READY';
    const o = new Orchestrator({ config: f.config, onBreaker: 'abort', startRunner: (options) => {
      const isReport = body(options.hive.inboxPath('michael')).includes('Write the closing report');
      if (options.agentId !== 'michael' || report && !isReport) return startAgent(options);
      const result = synthetic(`Keep [ANSWER_READY] inside. Done. [${keyword}]`, keyword);
      options.onAssistantMessage(result.text, false);
      return { done: Promise.resolve(result), kill: async () => {} };
    }, extraEnv: { SCRANTON_FAKE_DELAY_MS: '0' } });
    await o.run('Build');
    assert.equal(eventsAt(f.hive).at(-2).text, 'Keep [ANSWER_READY] inside. Done.', 'reply strips inline trailing keyword only');
  }
});

test('failed report text and pending-only failed launches remain final messages before agent_finished and match outbox', async (t) => {
  for (const failure of ['missing', 'timeout', 'crash', 'pending', 'stopped']) {
    const f = fixture(t); let o;
    o = new Orchestrator({ config: f.config, onBreaker: 'abort', startRunner: (options) => {
      const isReport = options.agentId === 'michael' && body(options.hive.inboxPath('michael')).includes('Write the closing report');
      if (!isReport) return startAgent(options);
      options.onAssistantMessage(`Retained ${failure} text.`, false);
      if (failure === 'stopped') o.abort('Stopped reporting');
      const result = synthetic(failure === 'pending' ? '' : `Retained ${failure} text.`, failure === 'stopped' ? 'REPORT_READY' : null, failure === 'missing' || failure === 'stopped');
      if (failure === 'crash') result.failure = { kind: 'exit', message: 'Report process exited' };
      return { done: Promise.resolve(result), kill: async () => {} };
    }, extraEnv: { SCRANTON_FAKE_DELAY_MS: '0' } });
    const result = await o.run('Build'); const events = eventsAt(f.hive);
    assert.equal(result.status, 'success'); assert.equal(events.at(-2).kind, 'summary');
    const final = events.find(e => e.type === 'agent_message' && e.text === `Retained ${failure} text.`);
    assert.ok(final?.final, `${failure}: failed report final text is published`);
    assert.equal(body(path.join(f.hive, 'michael/outbox.md')), final.text);
    assert.ok(events.indexOf(final) < events.findLastIndex(e => e.type === 'agent_finished'));
    assert.equal(events.some(e => e.type === 'hitl_request'), false);
  }
});

test('pending-only failed planning launch is retained, not silently dropped', async (t) => {
  const f = fixture(t);
  const o = new Orchestrator({ config: f.config, onBreaker: 'abort', startRunner: (options) => {
    options.onAssistantMessage('Partial planning text.', false);
    return { done: Promise.resolve(synthetic('', null, false)), kill: async () => {} };
  } });
  await o.run('Build');
  assert.equal(eventsAt(f.hive).find(e => e.type === 'agent_message' && e.final)?.text, 'Partial planning text.', 'pending planning text survives failed empty result');
});

for (const isolation of ['shared', 'worktree']) for (const scenario of ['question', 'happy']) test(`${isolation}/${scenario}: real subprocess exercises supported isolation through answer/report and cleanup`, (t) => {
  const worktree = isolation === 'worktree';
  const f = fixture(t, { worktree });
  assert.equal(f.config.execution.isolation, worktree ? 'worktree' : 'shared', 'both supported isolation modes are exercised');
  const before = fs.readFileSync(path.join(f.workspace, 'user.txt'));
  const { events } = runCli(f, scenario);
  assert.equal(events[0].execution.isolation, worktree ? 'worktree' : 'shared');
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'user.txt')), before);
  const integrations = events.filter(e => e.type === 'milestone_integrated');
  if (scenario === 'question') {
    assert.equal(events.at(-2).kind, 'answer'); assert.equal(integrations.length, 0, 'answer integrates nothing');
    assert.deepEqual(fs.readdirSync(f.workspace), ['user.txt'], 'answer leaves workspace byte-identical');
  } else {
    assert.equal(events.at(-2).kind, 'report', 'report works after milestones'); assert.equal(integrations.length, worktree ? 3 : 0);
    assert.ok(fs.existsSync(path.join(f.workspace, 'todo.js')));
    assert.ok(events.findIndex(e => e.kind === 'report_request') > events.findLastIndex(e => e.type === 'milestone_finished'));
  }
  assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(fs.existsSync(path.join(f.hive, 'control/owner.json')), false, 'subprocess releases lease after cleanup');
  assert.equal(fs.existsSync(path.join(f.workspace, '.git')), false, 'shadow Git never touches target');
});

test('worktree scripted fixture follows happy milestones rather than answering every Michael turn', (t) => {
  const f = fixture(t, { worktree: true });
  const { events } = runCli(f, 'happy');
  assert.equal(events.at(-2).kind, 'report', 'worktree happy scenario plans and reports');
  assert.equal(events.filter(e => e.type === 'milestone_finished').length, 3);
});

test('question demo asks a matching question and scripted messages describe the next tool', (t) => {
  const f = fixture(t);
  const { events } = runCli(f, 'question', 'demo');
  assert.equal(events[0].request, 'How does the Team orchestrator handle a request?', 'question demo default is a question');
  assert.match(events.at(-2).text, /Michael.*plan.*Dwight.*implement.*Angela.*verify/);
  const happy = runCli(f, 'happy');
  for (let i = 0; i < happy.events.length; i++) {
    const e = happy.events[i]; if (e.type !== 'agent_tool') continue;
    const previous = happy.events.slice(0, i).findLast(m => m.type === 'agent_message');
    const expected = `Using ${e.tool}.`;
    assert.equal(previous?.text, expected, 'intermediate message names scripted tool intent');
  }
});

test('off-mode proof detects payload, state and inbox leaks independently', (t) => {
  const f = fixture(t); runCli(f, 'question');
  const baseline = conversationProof({ ...f, packageRoot: path.resolve('.') });
  for (const [file, replacement, field] of [
    ['events.jsonl', s => s.replace('Answered by Michael', 'CONVERSATION_LEAK'), 'events'],
    ['state.json', s => s.replace('"status": "finished"', '"status": "CONVERSATION_LEAK"'), 'stateBytes'],
    ['michael/inbox.md', s => s + '\nCONVERSATION_LEAK\n', 'planningInbox'],
  ]) {
    const full = path.join(f.hive, file), original = fs.readFileSync(full, 'utf8'); fs.writeFileSync(full, replacement(original));
    assert.notDeepEqual(conversationProof({ ...f, packageRoot: path.resolve('.') })[field], baseline[field], `${field} drift cannot hide behind unchanged event types`);
    fs.writeFileSync(full, original);
  }
});
