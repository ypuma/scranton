import fs from 'node:fs';
import path from 'node:path';
import { JsonlSplitter } from '../src/core/jsonl.js';
import agentChat from './pi-agent-chat.js';

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const mode = process.env.FAKE_RPC_MODE;
const splitter = new JsonlSplitter();
const dialogs = new Map();
let tool, prompt = '', steers = [], timer, dialogSequence = 0;
agentChat({ registerTool: (value) => { tool = value; } });
const ctx = { mode: 'rpc', ui: { input: (title, placeholder, opts) => new Promise((resolve) => {
  const id = `chat-${dialogSequence++}`;
  const request = { type: 'extension_ui_request', method: 'input', id, title, placeholder, timeout: opts?.timeout };
  let deadline, replayed = false;
  const finish = (value) => {
    clearTimeout(deadline);
    opts?.signal?.removeEventListener('abort', cancel);
    dialogs.delete(id);
    resolve(value);
  };
  const cancel = () => finish(undefined);
  if (opts?.signal?.aborted) return cancel();
  opts?.signal?.addEventListener('abort', cancel, { once: true });
  if (opts?.timeout) deadline = setTimeout(cancel, opts.timeout);
  dialogs.set(id, (value) => {
    if (mode === 'chat-replay' && !replayed) { replayed = true; send(request); return; }
    finish(value);
  });
  send(request);
  if (mode === 'chat-replay') send(request);
}) } };
const ack = (r, success = true, data) => send({ type: 'response', id: r.id, command: r.type, success, data, ...(!success ? { error: 'Rejected by fixture' } : {}) });
const settle = (text) => {
  const keyword = process.env.FAKE_RPC_KEYWORD ?? (process.env.SCRANTON_PASS_KEYWORD || ({ oscar: 'REVIEW_APPROVED', hank: 'SECURITY_PASSED' }[process.env.SCRANTON_AGENT]));
  if (keyword) text = text.replace(/\[TASK_COMPLETE\]/g, `[${keyword}]`);
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 2, output: 3, cost: { total: 0.01 } } } });
  send({ type: 'agent_end' });
  timer = setTimeout(() => send({ type: 'agent_settled', aborted: false }), 30);
};
async function handle(r) {
  if (r.type === 'extension_ui_response') {
    if (r.id === 'forged') { settle(r.value); return; }
    dialogs.get(r.id)?.(r.cancelled ? undefined : r.value); return;
  }
  if (r.type === 'steer') {
    if (mode === 'no-ack') return;
    if (mode === 'reject-steer') return ack(r, false);
    steers.push(r.message); ack(r, true, { disposition: 'queued' });
    if (mode === 'wait-chat') settle(`Received: ${r.message}\n[TASK_COMPLETE]`);
    return;
  }
  if (r.type === 'clear_queue' || r.type === 'abort') { ack(r); return; }
  if (r.type !== 'prompt') return ack(r, false);
  prompt = r.message;
  if (mode === 'bad-json') { process.stdout.write('not json\n'); return; }
  if (mode === 'reject') return ack(r, false);
  if (mode === 'early-exit') return process.exit(0);
  if (mode === 'nonzero-exit') return process.exit(7);
  const promptAckDelay = Number(process.env.SCRANTON_FAKE_PROMPT_ACK_DELAY_MS);
  if (Number.isFinite(promptAckDelay) && promptAckDelay > 0) await new Promise((resolve) => setTimeout(resolve, promptAckDelay));
  ack(r, true, { disposition: 'started' });
  send({ type: 'agent_start' });
  const dir = flag('--session-dir');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${flag('--session-id')}.jsonl`);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0;
  fs.appendFileSync(file, `${JSON.stringify({ prompt })}\n`);
  send({ type: 'tool_execution_start', toolName: 'agent_chat', args: {} });
  if (mode === 'hang' || mode === 'no-ack' || mode === 'wait-chat' || mode === 'reject-steer') return;
  if (mode === 'chat' || mode === 'chat-replay' || mode === 'forge') {
    const params = { to: process.env.FAKE_RPC_TO, text: 'live hello' };
    if (mode === 'forge') {
      send({ type: 'extension_ui_request', id: 'forged', method: 'input', title: 'scranton.agent_chat.v1', placeholder: JSON.stringify({ ...params, from: 'victim', runId: 'forged' }) });
      return;
    }
    const result = await tool.execute('tool1', params, undefined, undefined, ctx);
    send({ type: 'tool_execution_end', toolName: 'agent_chat', isError: result.isError });
    settle(`${result.content[0].text}\n[TASK_COMPLETE]`);
  } else timer = setTimeout(() => settle(JSON.stringify({ prompt, steers, previous, args }) + '\n[TASK_COMPLETE]'), 100);
}
const startupDelay = Number(process.env.FAKE_RPC_STARTUP_DELAY_MS);
if (Number.isFinite(startupDelay) && startupDelay > 0) await new Promise((resolve) => setTimeout(resolve, startupDelay));
process.stdin.on('data', (chunk) => { for (const line of splitter.push(chunk)) void handle(JSON.parse(line)); });
process.stdin.on('end', () => { clearTimeout(timer); process.exit(0); });
