import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createScriptedProvider, getModel } from '../llm/index.js';

// Test/demo-only; an ambient delay or failure setting never enables this provider.
export function scriptedSettings(value, env = process.env) {
  if (value === undefined && (env.SCRANTON_FAKE_MODE !== '1' || !env.SCRANTON_FAKE_SCENARIO)) return null;
  const settings = {};
  for (const [key, suffix] of Object.entries({ scenario: 'SCENARIO', delayMs: 'DELAY_MS', log: 'LOG', fail: 'FAIL', failRole: 'FAIL_ROLE', plan: 'PLAN', keyword: 'KEYWORD', keywordRole: 'KEYWORD_ROLE', missingKeywordRole: 'MISSING_KEYWORD_ROLE', longText: 'LONG_TEXT', reportFail: 'REPORT_FAIL', expectPrompt: 'EXPECT_PROMPT', deterministic: 'DETERMINISTIC' })) {
    if (env[`SCRANTON_FAKE_${suffix}`] !== undefined) settings[key] = env[`SCRANTON_FAKE_${suffix}`];
  }
  return { scenario: 'happy', ...settings, ...(typeof value === 'string' ? { scenario: value } : value) };
}

function parseInbox(text) {
  const match = /---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const header = {};
  for (const line of match?.[1].split(/\r?\n/) ?? []) {
    const at = line.indexOf(':');
    if (at > 0) header[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { header, body: match ? text.slice(match.index + match[0].length) : text };
}

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


export async function createAgentScript(value, options) {
  const settings = scriptedSettings(value, options.env);
  if (!settings) return null;
  const { scenario } = settings;
  const role = options.agentId, inbox = parseInbox(options.message);
  const milestone = inbox.header.milestone || options.milestone || options.env.SCRANTON_MILESTONE || '';
  const cycle = Number(inbox.header.cycle || options.cycle || options.env.SCRANTON_CYCLE || 1);
  const kind = inbox.header.kind || '';
  const section = name => new RegExp(`^## ${name}[^\\n]*\\n+([\\s\\S]*?)(?=\\n## |$)`, 'm').exec(inbox.body)?.[1].trim() ?? '';
  const delayMs = Number(settings[`${role}DelayMs`] ?? options.env[`SCRANTON_FAKE_${role.toUpperCase()}_DELAY_MS`] ?? settings.delayMs ?? 0);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Invalid scripted delay');
  if (settings.log) await fs.appendFile(settings.log, JSON.stringify({ role, cwd: options.cwd, milestone, cycle, kind, scenario,
    instanceId: options.instanceId, runId: options.runId, agentConfig: options.agentConfig,
    message: options.message, messages: options.messages, systemPrompt: options.systemPrompt, systemPromptFile: options.systemPromptFile,
    scranton: Object.fromEntries(Object.entries(options.env).filter(([key]) => /^SCRANTON_(?:AGENT|RUN_ID|MILESTONE|CYCLE|CONVERSATION|ROLE_KIND|PASS_KEYWORD|FAIL_KEYWORD|INSTANCE_ID)$/.test(key))) }) + '\n');
  const conversation = options.env.SCRANTON_CONVERSATION === '1';
  let failure = conversation && kind === 'report_request' ? settings.reportFail : null;
  failure ||= !settings.failRole || settings.failRole === role ? settings.fail : null;
  const turns = [];
  let call = 0;
  const tool = (name, args) => turns.push({ text: `Using ${name}.`, toolCalls: [{ id: `scenario-${++call}`, name, arguments: args }] });
  let answer;
  if (role === 'michael') {
    if (kind === 'progress') answer = settings.progressAnswer ?? (scenario === 'breaker' || scenario === 'security_issues' ? '[STALLED]\nThe underlying problem keeps returning.' : '[PROGRESS]\nThe failure has narrowed.');
    else if (conversation && kind === 'report_request') answer = settings.reportFail === 'missing' ? 'Report without a keyword.' : 'Completed the requested work. The milestone checks passed.\n[REPORT_READY]';
    else if (conversation && scenario === 'question') answer = 'The Team orchestrator asks Michael to plan the request, Dwight to implement each milestone, and Angela to verify it. Failed checks return to Dwight; repeated failures pause for a human.\n[ANSWER_READY]';
    else answer = settings.plan === 'invalid' ? 'I could not decide how to split this up.\n[PLAN_READY]' : `Here is the plan: three small milestones.\n\n\`\`\`json\n${JSON.stringify(PLAN(section('Request') || 'the request'), null, 2)}\n\`\`\`\n\n[PLAN_READY]`;
    if (kind !== 'progress' && (!conversation || kind !== 'report_request')) tool('ls', { path: '.' });
  } else if (role === 'angela' || role === 'oscar' || role === 'hank' || options.agentConfig?.kind === 'gate' || options.env.SCRANTON_ROLE_KIND === 'gate') {
    const failed = scenario === 'progress' && cycle < 5 || scenario === 'flaky' && milestone === 'm2' && cycle === 1 || scenario === 'breaker' && role === 'angela' && milestone === 'm2' && !/human feedback/i.test(inbox.body) || role !== 'hank' && role !== 'angela' && scenario === 'changes_once' && cycle === 1 || role === 'hank' && scenario === 'security_issues';
    const pass = options.env.SCRANTON_PASS_KEYWORD || ({ angela: 'TEST_PASSED', oscar: 'REVIEW_APPROVED', hank: 'SECURITY_PASSED' }[role]) || options.agentConfig?.keywords?.[0];
    const fail = options.env.SCRANTON_FAIL_KEYWORD || ({ angela: 'TEST_FAILED', oscar: 'CHANGES_REQUESTED', hank: 'SECURITY_ISSUES' }[role]) || options.agentConfig?.keywords?.[1];
    if (role === 'angela') { tool('ls', { path: '.' }); tool('read', { path: 'todo.js' }); tool('bash', { command: 'node --test' }); }
    const criteria = section('Acceptance criteria').split('\n').map(line => line.replace(/^-\s*/, '').trim()).filter(Boolean);
    if (role === 'angela') {
      if (failed) tool('bash', { command: 'node cli.js done 1' });
      answer = [`QA report for ${milestone} (cycle ${cycle}): ${failed ? 'one criterion fails.' : 'all criteria verified.'}`, '',
        ...criteria.map((criterion, i) => `${i + 1}. ${failed && i === 0 ? 'FAIL' : 'PASS'} - ${criterion}${failed ? '' : ' (evidence: node --test, 0 failures)'}`), '',
        ...(failed ? ['### Failure', 'Command: `node cli.js done 1`', 'Output: TypeError: Cannot read properties of undefined (reading "done")', 'Expected: item 1 is marked done and the list is printed', 'Actual: the CLI crashes on an empty todos.json', 'Suspected file: cli.js', ''] : []),
        `[${failed ? fail : pass}]`].join('\n');
    } else answer = `${role} report: ${failed ? 'Unhandled input crosses a trust boundary; validate cli.js arguments before use.' : 'All checks passed.'}\n[${scenario === 'blocked' ? 'BLOCKED' : failed ? fail : pass}]`;
  } else {
    tool('ls', { path: '.' });
    if (scenario === 'blocked' && milestone === 'm2' && kind !== 'feedback') answer = 'I need a human decision before I write the CLI.\n[BLOCKED]';
    else {
      const rev = `revision for cycle ${cycle} (${kind || 'task'})`;
      const files = milestone === 'm1' ? [['todo.js', TODO_JS(rev)]] : milestone === 'm2' ? [['cli.js', CLI_JS(rev)]] : milestone === 'm3' ? [['test/todo.test.js', TEST_JS(rev)], ['README.md', README_MD(rev)]] : [[`${milestone || 'work'}.md`, `# ${milestone || 'work'}\n\n${rev}\n`]];
      for (const [path, content] of files) tool('write', { path, content });
      tool('bash', { command: 'node --test' });
      answer = `Implemented ${milestone || 'the task'} (cycle ${cycle}).\nFiles: ${files.map(([file]) => file).join(', ')}\n${kind === 'feedback' ? 'Applied the human feedback: ' + section('Human feedback').split('\n')[0] : kind === 'bug_report' ? "Fixed the failures from Angela's report." : ''}\nTest command: node --test\n[TASK_COMPLETE]`;
    }
  }
  if (settings.keyword && settings.keywordRole === role) answer = answer.replace(/\[[A-Z_]+\](?=\s*$)/, `[${settings.keyword}]`);
  if (settings.missingKeywordRole === role) answer = answer.replace(/\[[A-Z_]+\](?=\s*$)/, '');
  if (conversation && (settings.longText === true || settings.longText === '1')) answer = 'x'.repeat(17000) + '\n' + answer;
  turns.push({ text: answer });
  for (const turn of turns) Object.assign(turn, { delayMs, thinking: 'Checking the request and choosing the next safe step.', usage: { input: 800, output: 120 }, chunkSize: 60 });
  const provider = createScriptedProvider(turns);
  const llm = { calls: provider.calls, stream(model, context, requestOptions) {
    const stream = provider.stream(model, context, requestOptions);
    if (!failure || failure === 'missing') return stream;
    const injected = { exit1: ['exit', 'Scripted agent exited with code 1'], stoperror: ['stop_reason', 'Scripted provider stopped with an error'], nomessage: ['no_message', 'Scripted agent finished without producing an assistant message'] }[failure];
    return { async *[Symbol.asyncIterator]() {
      if (failure === 'hang') await delay(2147483647, undefined, { signal: requestOptions.signal });
      throw Object.assign(new Error(injected?.[1] ?? 'Unknown scripted failure'), { name: `ScriptedAgentFailure:${injected?.[0] ?? 'agent'}`, agentFailure: injected?.[0] ?? 'agent' });
    }, result: () => stream.result() };
  } };
  if (settings.expectPrompt && !(options.systemPrompt ?? '').includes(settings.expectPrompt)) throw new Error('Scripted resolved system prompt missing');
  return { llm, model: getModel('openai', 'gpt-4o'), spawn() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end('# tests 2\n# pass 2\n# fail 0\n'); child.stderr.end(); child.emit('close', 0); });
    return child;
  } };
}
