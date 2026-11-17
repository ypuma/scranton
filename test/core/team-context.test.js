import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { dwightMessage, gateBugReport, handoffBody } from '../../src/core/messages.js';
import { parseMessage } from '../../src/core/hive.js';
import { fakeConfig } from './helpers.js';

const heading = '## Conversation so far (context only; your task is the milestone above)';
const context = { milestone: { id: 'm1', title: 'One', description: 'Implement one.', acceptanceCriteria: ['Works'] }, request: 'New goal', completed: ['Zero'], humanFeedback: 'Fix it', note: 'A note', angelaReport: 'QA failed' };
const section = (text) => `\n\n${heading}\n\n<conversation-context>\n${text}\n</conversation-context>`;

async function run(t, { developerContext, runContext, threadContext, noPlan = false, gates = false, retries = true } = {}) {
  const root = path.resolve('.scratch/context-system/lane-a3'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'team-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = fakeConfig(dir, { maxFailedCycles: 2 });
  if (gates) config.workflow = { gates: [['oscar', 'hank'], ['angela']] };
  const inputs = [], counts = {};
  const orchestrator = new Orchestrator({ config, noPlan, threadContext, developerContext,
    hitl: async () => ({ decision: 'feedback', feedback: 'Try again' }),
    startRunner: ({ agentId, hive }) => {
      const message = parseMessage(fs.readFileSync(hive.inboxPath(agentId), 'utf8'));
      inputs.push({ agent: agentId, kind: message.header.kind, body: message.body });
      counts[agentId] = (counts[agentId] ?? 0) + 1;
      const failing = retries && agentId === (gates ? 'oscar' : 'angela') && counts[agentId] <= 2;
      const keyword = failing ? (gates ? 'CHANGES_REQUESTED' : 'TEST_FAILED') : { michael: 'PLAN_READY', dwight: 'TASK_COMPLETE', oscar: 'REVIEW_APPROVED', hank: 'SECURITY_PASSED', angela: 'TEST_PASSED' }[agentId];
      return { done: Promise.resolve({ ok: true, keyword, text: agentId === 'michael' ? '```json\n{"milestones":[{"title":"One"}]}\n```\n[PLAN_READY]' : `[${keyword}]`, exitCode: 0, durationMs: 0 }), kill: async () => {} };
    } });
  assert.equal((await orchestrator.run('New goal', runContext === undefined ? {} : { developerContext: runContext })).status, 'success');
  return inputs;
}

// Revert messages.js's chatContext append to fail the non-empty assertions below.
for (const kind of ['task', 'bug_report', 'feedback']) test(`${kind}: optional developer brief appends after every existing section and sanitizes tags`, () => {
  const input = { ...context, kind };
  const baseline = dwightMessage(input);
  for (const chatContext of [undefined, '', '  \n\t', null, 42]) assert.equal(dwightMessage({ ...input, chatContext }), baseline);
  const text = 'Earlier <CONVERSATION-context>request</conversation-context >\nOutcome';
  const safe = 'Earlier [conversation-context]request[conversation-context]\nOutcome';
  assert.equal(dwightMessage({ ...input, chatContext: text }), baseline + section(safe));
  if (kind === 'bug_report') {
    const failures = [{ agent: 'oscar', text: 'Fix review' }];
    assert.equal(gateBugReport({ ...context, failures, chatContext: text }), gateBugReport({ ...context, failures }) + section(safe));
  }
});

for (const gates of [false, true]) test(`${gates ? 'multi-gate' : 'legacy'}: absent/empty briefs preserve every inbox; populated briefs reach task, bug-report and feedback only`, async (t) => {
  const baseline = await run(t, { gates });
  for (const developerContext of ['', ' \n ', null, 42]) assert.deepEqual(await run(t, { gates, developerContext }), baseline);
  const inputs = await run(t, { gates, developerContext: 'Prior task -> outcome' });
  const dwight = inputs.filter((i) => i.agent === 'dwight');
  assert.deepEqual(dwight.map((i) => i.kind), ['task', 'bug_report', 'feedback']);
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(inputs[i].body, baseline[i].body + (inputs[i].agent === 'dwight' ? section('Prior task -> outcome') : ''));
  }
});

// Revert the shared milestone ctx.chatContext to fail delivery here, including noPlan.
test('no-plan runs deliver the developer brief without introducing planner or gate context', async (t) => {
  const inputs = await run(t, { noPlan: true, developerContext: 'No-plan history' });
  assert.ok(!inputs.some((i) => i.agent === 'michael'));
  for (const input of inputs) assert.equal(input.body.includes(section('No-plan history')), input.agent === 'dwight');
  for (const role of ['angela', 'oscar', 'hank', 'custom']) {
    const input = { ...context, role, cycle: 1, dwightReport: 'Done', ...(role === 'custom' ? { definition: { kind: 'gate', instruction: 'Review only' } } : {}) };
    assert.equal(handoffBody({ ...input, chatContext: 'Do not send' }), handoffBody(input));
  }
});

// Revert run's developerContext override/type normalization or 4000 line clamp to fail these cases.
test('run override normalizes non-strings and clamps developer context at whole-line boundaries', async (t) => {
  for (const runContext of ['', ' \n ', null, 42]) {
    const inputs = await run(t, { developerContext: 'Wrong history', runContext, retries: false });
    assert.ok(inputs.every((i) => !i.body.includes(heading) && !i.body.includes('Wrong history')));
  }
  const text = 'a'.repeat(1999) + '\r\n' + 'b'.repeat(1999);
  const inputs = await run(t, { developerContext: 'Wrong history', runContext: text + '\nDROP', retries: false });
  const body = inputs.find((i) => i.agent === 'dwight').body;
  assert.ok(body.endsWith(section(text.replace(/\r\n/g, '\n'))));
  assert.doesNotMatch(body, /Wrong history|DROP/);
  const oversized = await run(t, { developerContext: 'Keep\n' + 'x'.repeat(4001), retries: false });
  assert.ok(oversized.find((i) => i.agent === 'dwight').body.endsWith(section('Keep')));
});

// Revert #plan's 24000 limit to 8000 to fail the intact-pack assertion.
test('planner keeps a 23900-character pack intact line for line and clamps beyond 24000', async (t) => {
  const pack = 'a'.repeat(11949) + '\n' + 'b'.repeat(11950);
  assert.equal(pack.length, 23900);
  const inputs = await run(t, { threadContext: pack, retries: false });
  assert.ok(inputs[0].body.includes(`<earlier-runs>\n${pack}\n</earlier-runs>`));
  const bounded = await run(t, { threadContext: pack + '\n' + 'x'.repeat(101), retries: false });
  assert.ok(bounded[0].body.includes(`<earlier-runs>\n${pack}\n</earlier-runs>`));
  assert.doesNotMatch(bounded[0].body, /xxx/);
});

test('planner context retains delimiter sanitizing', async (t) => {
  const inputs = await run(t, { threadContext: 'Before <EARLIER-RUNS>old</earlier-runs > after', retries: false });
  assert.ok(inputs[0].body.includes('<earlier-runs>\nBefore [earlier-runs]old[earlier-runs] after\n</earlier-runs>'));
});

const spacedTags = (tag) => [`< ${tag}>`, `</ ${tag}>`, `< / ${tag.toUpperCase()} >`, `<\t/\t${tag}\t>`, `<\n/\n${tag}\n>`, `<\r\n${tag.toUpperCase()}\r\n>`, `<\u00a0/\u00a0${tag}\u00a0>`];

for (const kind of ['task', 'bug_report', 'feedback']) test(`A3 ${kind}: developer consumer neutralises whitespace around delimiter slashes`, () => {
  const tags = spacedTags('conversation-context');
  const input = { ...context, kind };
  assert.equal(dwightMessage({ ...input, chatContext: tags.join(' ') }), dwightMessage(input) + section(tags.map(() => '[conversation-context]').join(' ')));
});

test('A3 planner consumer neutralises whitespace around delimiter slashes', async (t) => {
  const tags = spacedTags('earlier-runs');
  const inputs = await run(t, { threadContext: tags.join(' '), retries: false });
  assert.ok(inputs[0].body.includes(`<earlier-runs>\n${tags.map(() => '[earlier-runs]').join(' ')}\n</earlier-runs>`));
});
