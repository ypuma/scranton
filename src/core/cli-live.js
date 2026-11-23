import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { approveToolCall } from './agent/index.js';
import { quotePathArgument } from './run-summary.js';

const terminal = new Set(['SUCCESS', 'ERROR', 'CANCELLED']);
export const safeTerminal = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufe0e\ufe0f\u2028\u2029]/g, '');

export async function pendingApproval(client, workflowId, callId) {
  const status = await client.retrieveWorkflow(workflowId).getStatus();
  if (!status) throw Error('Unknown workflow');
  const state = await client.getEvent(workflowId, 'agent_state', { timeoutSeconds: 0 });
  if (state?.phase !== 'waiting_approval' || state.detail?.callId !== callId) throw Error('Tool call is not pending approval');
  const detail = state.detail;
  if (!Number.isFinite(Date.parse(detail.deadline)) || Date.parse(detail.deadline) <= Date.now()) throw Error('Approval expired; denied by timeout');
  if (terminal.has(status.status)) throw Error('Tool call is not pending approval (workflow ended)');
  return detail;
}

const accessCanWrite = detail => detail.tool === 'request_access' && detail.args.mode === 'write' && detail.protected !== 'scranton-state';
function showAccess(detail, stderr) {
  if (detail.tool === 'request_access') stderr.write(safeTerminal(`Access: ${detail.args.mode} ${detail.args.path}; reason: ${detail.args.reason}${detail.protected ? '; protected: ' + detail.protected : ''}${detail.warning ? '; ' + detail.warning : ''}\n`));
}

export async function promptApproval(detail, { agent, stdin, stderr, signal }) {
  showAccess(detail, stderr);
  stderr.write(safeTerminal(`Approval required: ${agent}; tool: ${detail.tool}\nArguments: ${JSON.stringify(detail.args)}\nDeadline: ${detail.deadline} (${detail.timeoutSeconds}s) ${accessCanWrite(detail) ? '[y=write/r=read/N=deny]' : '[y/N]'} `));
  const rl = createInterface({ input: stdin, terminal: false });
  return new Promise(resolve => {
    let settled = false;
    const finish = (approved, reason) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); rl.close(); stdin.pause?.();
      stderr.write(`${reason}\n`); resolve(approved);
    };
    const abort = () => finish(false, 'Denied (run ended)');
    const remaining = Date.parse(detail.deadline) - Date.now();
    const timer = setTimeout(() => finish(false, 'Denied (approval timed out)'), Number.isFinite(remaining) ? Math.max(0, Math.min(remaining, 86400 * 1000)) : 0);
    rl.once('line', line => {
      const read = accessCanWrite(detail) && /^r(?:ead)?$/i.test(line.trim());
      const yes = /^y(?:es)?$/i.test(line.trim());
      finish(read ? 'read' : yes, read ? 'Approved read only' : yes ? 'Approved' : 'Denied');
    });
    rl.once('close', () => finish(false, 'Denied (input closed)'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// Batch replay bursts before displaying them: a marker replaces even the same attempt number.
export async function streamAnswer(client, workflowId, { stdout, agent = workflowId, quiet = false }) {
  const steps = new Map();
  let timer, quietTimer;
  const flush = (remainder = false) => {
    clearTimeout(timer); timer = undefined;
    for (const state of steps.values()) {
      const end = remainder ? state.pending.length : state.pending.lastIndexOf('\n') + 1;
      const text = state.pending.slice(0, end);
      if (!quiet && text) {
        for (const line of safeTerminal(text).split('\n')) if (line) stdout.write(`[${safeTerminal(agent)}] ${line}\n`);
        state.shown = true;
      }
      state.pending = state.pending.slice(end);
    }
  };
  try {
    for await (const { value } of client.readStream(workflowId, 'output', { fromOffset: 0, pageSize: 128 })) {
      if (value.type === 'attempt_start') {
        if (!quiet && steps.get(value.step)?.shown) stdout.write(`[${safeTerminal(agent)}] [previous ${safeTerminal(value.step)} attempt superseded]\n`);
        if (!steps.has(value.step)) flush(true);
        steps.set(value.step, { attempt: value.attempt, pending: '', shown: false });
      } else if (value.kind === 'text' && !String(value.step).startsWith('compact:')) {
        const state = steps.get(value.step);
        if (state && state.attempt === value.attempt) {
          state.pending += value.delta;
          if (state.pending.length >= 8192) flush(true);
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => flush(true), 1500);
        }
      }
      timer ??= setTimeout(() => flush(), 30);
    }
  } finally { clearTimeout(timer); clearTimeout(quietTimer); flush(true); }
}

export function startCliLive({ openClient, workflows, stdout, stderr, stdin, scope, quiet = false, pollMs = 100 }) {
  const controller = new AbortController(), jobs = new Map(), seen = new Set();
  let client, stopping = false, prompting = Promise.resolve();
  const approval = (workflowId, agent, detail) => {
    const key = JSON.stringify([workflowId, detail.step, detail.callId]);
    if (seen.has(key)) return;
    seen.add(key);
    prompting = prompting.then(async () => {
      if (stopping) return;
      try {
        const current = await pendingApproval(client, workflowId, detail.callId);
        if (current.step !== detail.step) return;
        if (!stdin?.isTTY || !stderr.isTTY) {
          showAccess(current, stderr);
          stderr.write(safeTerminal(`Approval required: ${agent}; ${current.tool}; arguments: ${JSON.stringify(current.args)}; deadline: ${current.deadline}\n`));
          stderr.write(`scranton approve ${safeTerminal(quotePathArgument(workflowId))} ${safeTerminal(quotePathArgument(current.callId))} --yes ${safeTerminal(scope).replace(/[\r\n\t]/g, '')}\n`);
          return;
        }
        const approved = await promptApproval(detail, { agent, stdin, stderr, signal: controller.signal });
        if (stopping) return;
        await pendingApproval(client, workflowId, detail.callId);
        await approveToolCall(client, workflowId, { ...detail, ...(approved === 'read' ? { grant: 'read' } : {}) }, Boolean(approved), 'human-cli');
      } catch (error) { if (!stopping) stderr.write(`Approval: ${safeTerminal(error.message)}\n`); }
    });
  };
  const scan = async () => {
    for (const row of await workflows(client)) {
      const id = row.workflowId, agent = row.agent ?? id;
      if (!jobs.has(id)) jobs.set(id, streamAnswer(client, id, { stdout, agent, quiet }).catch(error => {
        if (!stopping) stderr.write(`Live output: ${safeTerminal(error.message)}\n`);
      }));
      if (!terminal.has(row.status)) {
        const state = await client.getEvent(id, 'agent_state', { timeoutSeconds: 0 });
        if (state?.phase === 'waiting_approval') approval(id, agent, state.detail);
      }
    }
  };
  const done = (async () => {
    try {
      client = await openClient();
      while (!stopping) { await scan(); await sleep(pollMs, undefined, { signal: controller.signal }).catch(() => {}); }
      await scan();
    } catch (error) { if (!stopping) stderr.write(`Live output: ${safeTerminal(error.message)}\n`); }
  })();
  return { async stop() {
    stopping = true; controller.abort(); await done; await prompting;
    // A cancelled workflow may leave agent_state nonterminal; close the read-only connection too.
    let timer;
    await Promise.race([Promise.all(jobs.values()), new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
    clearTimeout(timer);
    await client?.shutdown(); await Promise.all(jobs.values());
  } };
}
