#!/usr/bin/env node
// Fake pi for tests and `scranton demo`: speaks pi's `--mode json` JSONL protocol, no model, no network.
//
// Environment:
//   SCRANTON_AGENT        role: michael | dwight | angela (set by Scranton)
//   FAKE_PI_SCENARIO      happy (default) | flaky | breaker | blocked
//   FAKE_PI_DELAY_MS      pause between steps (default 0)
//   FAKE_PI_LOG           append one JSON line per invocation (argv, role, cwd, ...)
//   FAKE_PI_FAIL          exit1 | hang | stoperror | nomessage  (infrastructure failure injection)
//   FAKE_PI_FAIL_ROLE     only inject the failure for this role
//   FAKE_PI_PLAN          invalid: Michael answers without a usable plan
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const env = process.env;

if (argv.includes('--version') || argv.includes('-v')) {
  console.log('fake-pi 0.0.0');
  process.exit(0);
}
if (argv[0] === 'auth') {
  console.log(JSON.stringify({ status: 'ready', provider: 'fake' }));
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (env.FAKE_PI_EXPECT_PROMPT && !fs.readFileSync(flag('--append-system-prompt'), 'utf8').includes(env.FAKE_PI_EXPECT_PROMPT)) {
  console.error('fake-pi: resolved system prompt missing');
  process.exit(2);
}
const rpc = flag('--mode') === 'rpc';
if (!rpc && flag('--mode') !== 'json') {
  console.error('fake-pi: only --mode json is supported');
  process.exit(2);
}

const role = env.SCRANTON_AGENT || 'dwight';
const scenario = env.FAKE_PI_SCENARIO || 'happy';
const delayMs = Number(env[`FAKE_PI_${role.toUpperCase()}_DELAY_MS`] ?? env.FAKE_PI_DELAY_MS ?? 0);
const inboxArg = argv.find((a) => a.startsWith('@'));
let rpcPrompt;
if (rpc) {
  rpcPrompt = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const command = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { disposition: 'queued' } }) + '\n');
      if (command.type === 'prompt') resolve(command.message);
      if (command.type === 'abort') process.exit(0);
    });
    rl.once('close', () => process.exit(0));
  });
  const sessionDir = flag('--session-dir');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.appendFileSync(path.join(sessionDir, flag('--session-id') + '.jsonl'), JSON.stringify({ prompt: rpcPrompt }) + '\n');
}
const inboxText = rpc ? rpcPrompt.slice(rpcPrompt.indexOf('---\n')) : inboxArg ? fs.readFileSync(inboxArg.slice(1), 'utf8') : '';

function parseInbox(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const header = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) header[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return { header, body: m ? text.slice(m[0].length) : text };
}
const inbox = parseInbox(inboxText);
const section = (name) => {
  const m = new RegExp(`^## ${name}[^\\n]*\\n+([\\s\\S]*?)(?=\\n## |$)`, 'm').exec(inbox.body);
  return m ? m[1].trim() : '';
};
const milestone = inbox.header.milestone || env.SCRANTON_MILESTONE || '';
const cycle = Number(inbox.header.cycle || env.SCRANTON_CYCLE || 1);
const kind = inbox.header.kind || '';

if (env.FAKE_PI_LOG) {
  fs.appendFileSync(
    env.FAKE_PI_LOG,
    `${JSON.stringify({ role, argv, cwd: process.cwd(), milestone, cycle, kind, scenario, scranton: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('SCRANTON_'))) })}\n`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = () => (delayMs ? sleep(delayMs) : Promise.resolve());
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
let now = Date.now();
let callNo = 0;
const usage = () => ({
  input: 800 + (env.FAKE_PI_DETERMINISTIC ? 0 : Math.floor(Math.random() * 400)),
  output: 120 + (env.FAKE_PI_DETERMINISTIC ? 0 : Math.floor(Math.random() * 200)),
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1000,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 }
});
const assistant = (content, stopReason, extra = {}) => ({
  role: 'assistant',
  content,
  api: 'fake',
  provider: 'fake',
  model: 'fake-pi',
  usage: usage(),
  stopReason,
  timestamp: now++,
  ...extra
});

const failMode = env.FAKE_PI_FAIL && (!env.FAKE_PI_FAIL_ROLE || env.FAKE_PI_FAIL_ROLE === role) ? env.FAKE_PI_FAIL : null;

function header() {
  out({ type: 'session', version: 3, id: `fake-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), cwd: process.cwd() });
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  const user = { role: 'user', content: 'Your Hive inbox message is attached.', timestamp: now++ };
  out({ type: 'message_start', message: user });
  out({ type: 'message_end', message: user });
}

async function tool(toolName, args, run) {
  const id = `call_${++callNo}`;
  const toolCall = { type: 'toolCall', id, name: toolName, arguments: args };
  out({ type: 'message_start', message: assistant([], 'pending') });
  out({ type: 'message_update', usage: usage(), assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id, toolName } });
  const message = assistant([toolCall], 'toolUse');
  out({ type: 'message_end', message });
  out({ type: 'tool_execution_start', toolCallId: id, toolName, args });
  await step();
  const t0 = Date.now();
  const text = run();
  const result = { content: [{ type: 'text', text }], details: {} };
  out({ type: 'tool_execution_end', toolCallId: id, toolName, result, isError: false, durationMs: Date.now() - t0 });
  const toolResult = { role: 'toolResult', toolCallId: id, toolName, content: result.content, isError: false, timestamp: now++ };
  out({ type: 'message_start', message: toolResult });
  out({ type: 'message_end', message: toolResult });
  out({ type: 'turn_end', message, toolResults: [toolResult] });
  out({ type: 'turn_start' });
}

async function finalText(text) {
  out({ type: 'message_start', message: assistant([], 'pending') });
  for (const chunk of text.match(/[\s\S]{1,60}/g) ?? []) {
    out({ type: 'message_update', usage: usage(), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk } });
  }
  await step();
  const message = assistant([{ type: 'text', text }], 'stop');
  out({ type: 'message_end', message });
  out({ type: 'turn_end', message, toolResults: [] });
  out({ type: 'agent_end', messages: [message], willRetry: false });
  out({ type: 'agent_settled', aborted: false });
}

async function failedFinish() {
  const message = assistant([], 'error', { errorMessage: '401 invalid x-api-key (fake-pi failure injection)' });
  out({ type: 'message_start', message: assistant([], 'pending') });
  out({ type: 'message_end', message });
  out({ type: 'turn_end', message, toolResults: [] });
  out({ type: 'agent_end', messages: [message], willRetry: false });
  out({ type: 'agent_settled', aborted: false });
}

// ---- roles ------------------------------------------------------------------------------

const TODO_JS = (rev) => `// ${rev}
import fs from 'node:fs';

export function load(file = 'todos.json') {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

export function save(items, file = 'todos.json') {
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
}

export function add(items, text) {
  const id = items.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  return [...items, { id, text, done: false }];
}

export function done(items, id) {
  return items.map((t) => (t.id === id ? { ...t, done: true } : t));
}

export function format(items) {
  return items.map((t) => \`\${t.done ? '[x]' : '[ ]'} \${t.id}. \${t.text}\`).join('\\n');
}
`;

const CLI_JS = (rev) => `// ${rev}
import { add, done, format, load, save } from './todo.js';

const [command, ...rest] = process.argv.slice(2);
let items = load();
if (command === 'add') items = add(items, rest.join(' '));
else if (command === 'done') items = done(items, Number(rest[0]));
else if (command !== 'list') {
  console.error('usage: node cli.js add <text> | list | done <id>');
  process.exit(1);
}
save(items);
console.log(format(items));
`;

const TEST_JS = (rev) => `// ${rev}
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, done, format } from '../todo.js';

test('add numbers items and done marks them', () => {
  let items = add([], 'milk');
  items = add(items, 'eggs');
  assert.deepEqual(items.map((t) => t.id), [1, 2]);
  assert.equal(done(items, 2)[1].done, true);
});

test('format renders a checkbox per item', () => {
  assert.equal(format(done(add([], 'milk'), 1)), '[x] 1. milk');
});
`;

const README_MD = (rev) => `# Todo CLI\n\n${rev}\n\n    node cli.js add "buy milk"\n    node cli.js list\n    node cli.js done 1\n\nRun the tests with \`node --test\`.\n`;

function dwightWork() {
  const rev = `revision for cycle ${cycle} (${kind || 'task'})`;
  const n = Number(/^m(\d+)$/.exec(milestone)?.[1]);
  if (n === 1) return [{ file: 'todo.js', content: TODO_JS(rev) }];
  if (n === 2) return [{ file: 'cli.js', content: CLI_JS(rev) }];
  if (n === 3) return [{ file: 'test/todo.test.js', content: TEST_JS(rev) }, { file: 'README.md', content: README_MD(rev) }];
  return [{ file: `${milestone || 'work'}.md`, content: `# ${milestone || 'work'}\n\n${rev}\n` }];
}

async function runDwight() {
  await tool('ls', { path: '.' }, () => fs.readdirSync('.').join('\n') || '(empty)');
  if (scenario === 'blocked' && milestone === 'm2' && kind !== 'feedback') {
    await finalText(
      `I cannot continue with ${milestone}: the acceptance criteria do not say whether todos.json should live in the current directory or in the user's home directory.\nI need a human decision before I write the CLI.\n\n[BLOCKED]`
    );
    return;
  }
  const written = [];
  for (const { file, content } of dwightWork()) {
    await tool('write', { path: file, content }, () => {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, content);
      return `Wrote ${content.length} bytes to ${file}`;
    });
    written.push(file);
  }
  await tool('bash', { command: 'node --test' }, () => '# tests 2\n# pass 2\n# fail 0');
  const feedback = kind === 'feedback' ? section('Human feedback') : '';
  const lines = [
    `Implemented ${milestone || 'the task'} (cycle ${cycle}).`,
    '',
    `Files: ${written.join(', ')}`,
    feedback ? `Applied the human feedback: ${feedback.split('\n')[0]}` : kind === 'bug_report' ? "Fixed the failures from Angela's report." : '',
    '',
    'Test command: `node --test`',
    '',
    '[TASK_COMPLETE]'
  ];
  await finalText(lines.filter((l, i) => l || lines[i - 1] !== '').join('\n'));
}

function angelaVerdict() {
  if (scenario === 'flaky' && milestone === 'm2' && cycle === 1) return false;
  if (scenario === 'breaker' && milestone === 'm2' && !/human feedback/i.test(inbox.body)) return false;
  return true;
}

async function runAngela() {
  await tool('ls', { path: '.' }, () => 'todo.js\ncli.js\ntest\nREADME.md');
  await tool('read', { path: 'todo.js' }, () => 'export function load(...) { ... }');
  await tool('bash', { command: 'node --test' }, () => '# tests 2\n# pass 2\n# fail 0');
  const criteria = section('Acceptance criteria').split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean);
  if (angelaVerdict()) {
    await finalText(
      [`QA report for ${milestone} (cycle ${cycle}): all criteria verified.`, '', ...criteria.map((c, i) => `${i + 1}. PASS - ${c} (evidence: node --test, 0 failures)`), '', '[TEST_PASSED]'].join('\n')
    );
    return;
  }
  await tool('bash', { command: 'node cli.js done 1' }, () => 'TypeError: Cannot read properties of undefined (reading "done")');
  await finalText(
    [
      `QA report for ${milestone} (cycle ${cycle}): one criterion fails.`,
      '',
      ...criteria.map((c, i) => `${i + 1}. ${i === 0 ? 'FAIL' : 'PASS'} - ${c}`),
      '',
      '### Failure',
      'Command: `node cli.js done 1`',
      'Output: TypeError: Cannot read properties of undefined (reading "done")',
      'Expected: item 1 is marked done and the list is printed',
      'Actual: the CLI crashes on an empty todos.json',
      'Suspected file: cli.js',
      '',
      '[TEST_FAILED]'
    ].join('\n')
  );
}

const PLAN = (request) => ({
  milestones: [
    {
      id: 'm1',
      title: 'Todo storage module',
      description: `Create todo.js with load/save/add/done/format helpers backed by todos.json. Context: ${request}`,
      acceptanceCriteria: ['add() numbers items consecutively', 'done() marks exactly one item', 'items survive a save/load round trip']
    },
    {
      id: 'm2',
      title: 'Command line interface',
      description: 'Create cli.js: `add <text>`, `list` and `done <id>` on top of todo.js.',
      acceptanceCriteria: ['`node cli.js add "x"` prints the list including x', '`node cli.js done 1` marks item 1 done', 'unknown commands print usage and exit 1']
    },
    {
      id: 'm3',
      title: 'Tests and README',
      description: 'Add node:test tests for todo.js and a README with usage.',
      acceptanceCriteria: ['`node --test` passes', 'README documents add, list and done']
    }
  ]
});

async function runMichael() {
  await tool('ls', { path: '.' }, () => fs.readdirSync('.').join('\n') || '(empty workspace)');
  const request = section('Request') || 'the request';
  if (env.FAKE_PI_PLAN === 'invalid') {
    await finalText('I could not decide how to split this up.\n\n[PLAN_READY]');
    return;
  }
  await finalText(`Here is the plan: three small milestones.\n\n\`\`\`json\n${JSON.stringify(PLAN(request), null, 2)}\n\`\`\`\n\n[PLAN_READY]`);
}

// ---- main -------------------------------------------------------------------------------

if (failMode === 'exit1') {
  console.error('fake-pi: No API key found for provider "fake" (failure injection)');
  process.exit(1);
}
header();
if (failMode === 'hang') {
  setInterval(() => {}, 1000);
} else if (failMode === 'stoperror') {
  await failedFinish();
} else if (failMode === 'nomessage') {
  out({ type: 'agent_end', messages: [], willRetry: false });
  out({ type: 'agent_settled', aborted: false });
} else if (role === 'michael') {
  await runMichael();
} else if (role === 'oscar' || role === 'hank' || env.SCRANTON_ROLE_KIND === 'gate' && role !== 'angela') {
  await step();
  const failed = scenario === 'flaky' && milestone === 'm2' && cycle === 1 || role !== 'hank' && scenario === 'changes_once' && cycle === 1 || role === 'hank' && scenario === 'security_issues';
  const keyword = env.FAKE_PI_KEYWORD_ROLE === role ? env.FAKE_PI_KEYWORD : scenario === 'blocked' ? 'BLOCKED' : failed ? env.SCRANTON_FAIL_KEYWORD || (role === 'oscar' ? 'CHANGES_REQUESTED' : 'SECURITY_ISSUES') : env.SCRANTON_PASS_KEYWORD || (role === 'oscar' ? 'REVIEW_APPROVED' : 'SECURITY_PASSED');
  await finalText(`${role} report: ${failed ? 'Unhandled input crosses a trust boundary; validate cli.js arguments before use.' : 'All checks passed.'}${env.FAKE_PI_MISSING_KEYWORD_ROLE === role ? '' : `\n[${keyword}]`}`);
} else if (role === 'angela') {
  await runAngela();
} else {
  await runDwight();
}
