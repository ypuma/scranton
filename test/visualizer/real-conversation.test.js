import { isolationTestEnv } from '../core/isolation-test-root.js';
// The pinned parity of .enma/chat-view-contract.md section 10: the real engine in conversation mode (scranton demo
// --conversation with the fake pi) writes agent_message and run_reply events, and the web reducer replaying them
// agrees with the state.json of the same run, the reply included. The Chat view's adapter turns the same events
// into a conversation with exactly one reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceAll, parseJsonl, createState, AGENT_IDS, humanNeeded } from '../../visualizer/public/js/state.js';
import { teamChatAdapter } from '../../visualizer/public/js/chat-adapter-team.js';
import { splitKeyword } from '../../visualizer/public/js/chat-entries.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'scranton.js');
const SCRATCH = path.join(ROOT, '.scratch', 'viz-real-conversation');
const RUNS = {
  // milestones, then Michael's closing report
  report: { scenario: 'happy', conversation: true, reply: 'report' },
  // a question: Michael answers himself, no plan and no milestone
  answer: { scenario: 'question', conversation: true, reply: 'answer' },
  // the same engine without the switch: neither event, no reply
  off: { scenario: 'happy', conversation: false, reply: null },
};

let tmp;
const done = {};

function demo({ scenario, conversation }, dir) {
  const hive = path.join(dir, 'hive');
  const args = [CLI, 'demo', '--scenario', scenario, '--delay', '0', '--hive', hive, '--workspace', path.join(dir, 'ws'), '--on-breaker', 'skip',
    ...(conversation ? ['--conversation'] : [])];
  const env = isolationTestEnv({ NO_COLOR: '1' });
  for (const k of Object.keys(env)) if (/^SCRANTON_(SETTINGS_DIR|PROMPTS_DIR|DATA|CONVERSATION)/.test(k)) delete env[k];
  return new Promise((resolve, reject) => {
    // cwd without a scranton.config.json or .env, so only the flags shape the run
    const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let events = [];
      let snapshot = null;
      try {
        events = parseJsonl(fs.readFileSync(path.join(hive, 'events.jsonl'), 'utf8'));
        snapshot = JSON.parse(fs.readFileSync(path.join(hive, 'state.json'), 'utf8'));
      } catch {
        // reported by the tests with the CLI output
      }
      resolve({ code, output, events, snapshot });
    });
  });
}

before(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  tmp = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  await Promise.all(Object.entries(RUNS).map(async ([name, run]) => {
    done[name] = await demo(run, fs.mkdtempSync(path.join(tmp, `${name}-`)));
  }));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

function parity(name) {
  const { code, output, events, snapshot } = done[name];
  assert.ok(snapshot && events.length, `no events/state written. CLI exit ${code}:\n${output.slice(-1500)}`);
  assert.equal(code, 0, `exit code. CLI output:\n${output.slice(-1500)}`);
  assert.equal(events.at(-1).type, 'run_finished');
  assert.equal(events.at(-1).status, 'success');
  const s = reduceAll(events);
  assert.equal(s.applied, events.length, 'every real event type is known to the reducer');
  assert.equal(s.runId, snapshot.runId);
  assert.equal(s.lastSeq, snapshot.lastSeq);
  assert.equal(s.status, snapshot.status, 'run status');
  assert.equal(Object.hasOwn(s, 'reply'), Object.hasOwn(snapshot, 'reply'), 'reply is present exactly when state.json has it');
  assert.deepEqual(s.reply, snapshot.reply, 'reply as state.json');
  for (const id of AGENT_IDS) {
    const mine = s.agents[id].totals;
    const theirs = snapshot.agents[id].totals;
    assert.deepEqual([mine.runs, mine.input, mine.output], [theirs.runs, theirs.input, theirs.output], `${id} totals`);
    assert.ok(Math.abs(mine.cost - theirs.cost) < 1e-9, `${id} totals.cost`);
    assert.equal(s.agents[id].status, snapshot.agents[id].status, `${id} status`);
  }
  assert.deepEqual(s.milestones.map((m) => [m.id, m.status]), snapshot.milestones.map((m) => [m.id, m.status]), 'milestone statuses');
  assert.equal(humanNeeded(s), false);
  // a reconnect replay of the same file changes nothing
  assert.equal(reduceAll(events, s), s);
  return { s, events, snapshot, entries: teamChatAdapter({ events, state: s, runs: [] }) };
}

test('a conversation run with milestones: reply, totals and statuses as state.json, and the adapter yields the report', () => {
  const { s, events, snapshot, entries } = parity('report');
  assert.equal(events[0].execution.conversation, true, 'the run recorded the switch');
  assert.deepEqual(events.slice(-2).map((e) => e.type), ['run_reply', 'run_finished'], 'the reply directly before the end');
  assert.equal(events.filter((e) => e.type === 'run_reply').length, 1);
  assert.deepEqual([snapshot.reply.from, snapshot.reply.kind], ['michael', 'report']);
  assert.ok(snapshot.reply.text.trim().length > 0);
  assert.doesNotMatch(snapshot.reply.text, /\[REPORT_READY\]/, 'the keyword line is not part of the reply');
  assert.deepEqual(s.reply, { from: 'michael', kind: 'report', text: snapshot.reply.text });

  const replies = entries.filter((x) => x.kind === 'reply');
  assert.equal(replies.length, 1, 'exactly one reply entry');
  assert.equal(entries.at(-1), replies[0], 'and it is the last entry');
  assert.deepEqual([replies[0].replyKind, replies[0].text, replies[0].tone, replies[0].who.name], ['report', snapshot.reply.text, 'ok', 'Michael']);
  assert.match(replies[0].context, /^Success · 3\/3 milestones · [\d.]+k tokens · \$\d+\.\d+ · \d+s$/);

  // every agent message of the run is an agent entry, and no mailbox summary doubles one
  const messages = events.filter((e) => e.type === 'agent_message');
  assert.ok(messages.length >= 6, `${messages.length} agent messages`);
  const agents = entries.filter((x) => x.kind === 'agent');
  assert.equal(agents.length, messages.length);
  assert.deepEqual(agents.map((x) => x.text), messages.map((e) => e.text));
  assert.ok(agents.some((x) => x.final) && agents.some((x) => !x.final), 'final and intermediate messages');
  assert.ok(agents.some((x) => x.context === 'm1 · cycle 1'), 'with the milestone and the cycle as context');
  // one final message per launch that reported, and its keyword is the one the engine extracted
  const finals = messages.filter((e) => e.final);
  const reported = events.filter((e) => e.type === 'agent_finished' && e.keyword && !['REPORT_READY', 'ANSWER_READY'].includes(e.keyword));
  assert.equal(finals.length, reported.length);
  assert.deepEqual(finals.map((e) => splitKeyword(e.text).keyword), reported.map((e) => e.keyword));
  assert.equal(entries[0].kind, 'request');
  assert.equal(entries[0].text, events[0].request);
  assert.ok(entries.some((x) => x.kind === 'activity' && x.text === 'm3 passed' && x.tone === 'ok'));
});

test('a question: Michael answers directly, without a plan, and the reply is the answer', () => {
  const { s, events, snapshot, entries } = parity('answer');
  assert.deepEqual(events.slice(-2).map((e) => e.type), ['run_reply', 'run_finished']);
  assert.deepEqual([snapshot.reply.from, snapshot.reply.kind], ['michael', 'answer']);
  assert.doesNotMatch(snapshot.reply.text, /\[ANSWER_READY\]/);
  assert.equal(events.at(-1).summary, 'Answered by Michael');
  assert.deepEqual(s.milestones, [], 'no milestone ran');
  assert.equal(events.some((e) => e.type === 'plan_ready' || e.type === 'milestone_started'), false);
  assert.deepEqual(entries.filter((x) => x.kind === 'reply').map((x) => [x.replyKind, x.text, x.tone]), [['answer', snapshot.reply.text, 'ok']]);
  assert.equal(entries.at(-1).kind, 'reply');
  assert.match(entries.at(-1).context, /^Success · [\d.]+k tokens · \$\d+\.\d+ · \d+s$/, 'no milestones to count');
  // the answer is published as the reply only, not a second time as an agent message
  assert.equal(entries.some((x) => x.kind === 'agent' && x.text.includes(snapshot.reply.text)), false);
});

test('without the switch the engine emits neither event, and the reply is absent on both sides', () => {
  const { s, events, snapshot, entries } = parity('off');
  assert.equal(events.some((e) => e.type === 'agent_message' || e.type === 'run_reply'), false);
  assert.equal(events[0].execution.conversation, undefined);
  assert.equal(Object.hasOwn(snapshot, 'reply'), false, 'state.json has no reply key (off-mode bytes)');
  assert.equal(Object.hasOwn(s, 'reply'), false);
  assert.equal(Object.hasOwn(createState(), 'reply'), false);
  // such a run still reads as a conversation, from its mailbox summaries and its summary
  assert.deepEqual(entries.filter((x) => x.kind === 'reply').map((x) => [x.replyKind, x.text, x.who.name]), [['summary', events.at(-1).summary, 'Scranton']]);
  assert.ok(entries.filter((x) => x.kind === 'agent').length >= 6);
});

test('a conversation run after another one: the earlier reply does not carry over', () => {
  const s = reduceAll(done.off.events, reduceAll(done.report.events));
  assert.equal(Object.hasOwn(s, 'reply'), false);
  const back = reduceAll(done.answer.events, s);
  assert.deepEqual(back.reply, done.answer.snapshot.reply);
});
