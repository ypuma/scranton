// Scripted pi for the UI tests and the offline demo recording: speaks pi's RPC protocol, no model, no network.
// Deterministic apart from wall-clock timing.
//
// Environment (besides the SCRANTON_* variables Scranton sets):
//   SCRIPTED_STEP_MS   pause per step (default 20)
//   SCRIPTED_MODE      '' | hang (developers never finish) | hang-tool (developers never leave a tool)
//                      | chat (dwight-m1 messages dwight-m2 while working)
//   SCRIPTED_CRASH     instance id whose pi process exits with code 1 after its first tool
//   SCRIPTED_FLAKY     milestone[:cycles] whose first QA cycles fail, e.g. m2 or m2:2
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const role = env.SCRANTON_AGENT;
const instance = env.SCRANTON_INSTANCE_ID;
const milestone = env.SCRANTON_MILESTONE;
const cycle = Number(env.SCRANTON_CYCLE) || 1;
const stepMs = Number(env.SCRIPTED_STEP_MS ?? 20);
const mode = env.SCRIPTED_MODE ?? '';
const send = (r) => process.stdout.write(`${JSON.stringify(r)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dialogs = new Map();
let aborted = false;
let turn = 0;

const PLAN = {
  milestones: [
    { id: 'm1', title: 'Todo storage module', description: 'todo.js with load/save/add/done backed by todos.json.',
      acceptanceCriteria: ['add() numbers items consecutively', 'items survive a save/load round trip'], dependsOn: [] },
    { id: 'm2', title: 'Command line interface', description: 'cli.js with add, list and done on top of todo.js.',
      acceptanceCriteria: ['`node cli.js add "x"` lists x', 'unknown commands exit 1'], dependsOn: [] },
    { id: 'm3', title: 'Tests and README', description: 'node:test suite and a README with usage.',
      acceptanceCriteria: ['`node --test` passes', 'README documents every command'], dependsOn: ['m1', 'm2'] },
  ],
};

const FILES = { m1: 'todo.js', m2: 'cli.js', m3: 'README.md' };

// Same numbers on every run so a recording does not change between runs.
function usage() {
  turn += 1;
  const base = { michael: 1800, dwight: 4200, angela: 2600 }[role] ?? 1000;
  const n = Number(/\d+/.exec(milestone ?? '')?.[0] ?? 0);
  const input = base + n * 310 + cycle * 120 + turn * 40;
  const output = Math.round(input / 7);
  return { input, output, cost: { total: Math.round((input * 3 + output * 15) / 1000) / 1000 } };
}

async function tool(toolName, args, run = () => {}) {
  if (aborted) return;
  send({ type: 'tool_execution_start', toolName, args });
  await sleep(stepMs);
  run();
  send({ type: 'tool_execution_end', toolName, isError: false });
}

function settle(text) {
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: usage() } });
  send({ type: 'agent_end' });
  send({ type: 'agent_settled', aborted: false });
}

// agent_chat as the managed extension asks for it: an input dialog the host answers with the broker ACK.
function chat(to, text) {
  const id = `chat-${instance}-${dialogs.size + 1}`;
  return new Promise((resolve) => {
    dialogs.set(id, resolve);
    send({ type: 'extension_ui_request', method: 'input', id, title: 'scranton.agent_chat.v1', placeholder: JSON.stringify({ to, text }) });
  });
}

async function michael() {
  await tool('ls', { path: '.' });
  await sleep(stepMs * 2);
  settle(`Three milestones; m1 and m2 are independent, m3 needs both.\n\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\`\n\n[PLAN_READY]`);
}

async function dwight() {
  await tool('ls', { path: '.' });
  if (env.SCRIPTED_CRASH === instance) {
    await sleep(stepMs);
    process.exit(1);
  }
  if (mode === 'hang') return;
  if (mode === 'hang-tool') {
    send({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'node --test --watch' } });
    return;
  }
  const file = FILES[milestone] ?? `${milestone}.md`;
  await tool('read', { path: 'package.json' });
  if (mode === 'chat' && instance === 'dwight-m1' && cycle === 1) {
    await chat('dwight-m2', 'todo.js exports load(), save(), add() and done(). Import them in cli.js instead of reading todos.json yourself.');
  }
  await tool('write', { path: file }, () => fs.writeFileSync(path.resolve(file), `${milestone} cycle ${cycle}\n`));
  await tool('bash', { command: 'node --test' });
  if (!aborted) settle(`Implemented ${milestone} in ${file} (cycle ${cycle}).\n\n[TASK_COMPLETE]`);
}

async function angela() {
  await tool('read', { path: FILES[milestone] ?? '.' });
  await tool('bash', { command: 'node --test' });
  if (aborted) return;
  const [flaky, failing = '1'] = (env.SCRIPTED_FLAKY ?? '').split(':');
  if (flaky === milestone && cycle <= Number(failing)) {
    await tool('bash', { command: 'node cli.js done 1' });
    settle(`QA ${milestone} cycle ${cycle}: \`node cli.js done 1\` crashes on an empty todos.json.\n\n[TEST_FAILED]`);
  } else {
    settle(`QA ${milestone} cycle ${cycle}: all acceptance criteria pass.\n\n[TEST_PASSED]`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.type === 'extension_ui_response') {
    dialogs.get(r.id)?.(r.value);
    return;
  }
  send({ type: 'response', id: r.id, command: r.type, success: true, data: r.type === 'prompt' ? { disposition: 'started' } : { disposition: 'queued' } });
  if (r.type === 'abort') {
    aborted = true;
    send({ type: 'agent_settled', aborted: true });
    return;
  }
  if (r.type !== 'prompt') return;
  send({ type: 'agent_start' });
  void (role === 'michael' ? michael() : role === 'angela' ? angela() : dwight());
}).once('close', () => process.exit(0));
