// Tool approvals (.enma/run-options-contract.md, Approvals API): what GET .../approvals lists, what a card says
// about a call, the countdown to its deadline and the verdict a POST sends. No DOM, so Node can test it. The
// arguments are written by a model: they are only ever shown as text.
import { stripBidi } from './format.js';
import { responseError } from './control.js';
import { displayName } from './state.js';

export const APPROVALS_POLL_MS = 1000;
export const APPROVALS_RETRY_MS = 5000;
export const ARGS_MAX = 2000;
export const BADGE = 'Approval needed';
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const TOOL_TEXT = {
  bash: 'Run a shell command', powershell: 'Run a PowerShell command', write: 'Write a file', edit: 'Edit a file',
};
const SHELL = new Set(['bash', 'powershell']);
const FILES = new Set(['write', 'edit']);

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => stripBidi(str(v)).replace(/\r\n?/g, '\n').replace(CONTROLS, '');
const clip = (t, max = ARGS_MAX) => (t.length > max ? `${t.slice(0, max - 3)}...` : t);

// The identity of a card, as the server listed it (never cleaned: it has to match exactly). Provider call ids can
// repeat across turns, so the durable position (or, from an older server, the deadline) tells two such calls apart.
export const approvalKey = (a) => JSON.stringify([a.workflowId, a.step ?? a.deadline ?? null, a.callId]);

// GET .../approvals -> [{ key, workflowId, step, runId, instanceId, agent, callId, tool, args, timeoutSeconds, deadline }],
// or null for anything that is no approvals document.
export function parseApprovals(doc) {
  const list = obj(doc)?.approvals;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    const a = obj(raw);
    if (!a || !str(a.workflowId) || !str(a.callId) || !str(a.tool)) continue;
    const item = {
      workflowId: a.workflowId, step: str(a.step) || null, callId: a.callId, runId: clean(a.runId) || null, instanceId: clean(a.instanceId) || null,
      agent: clean(a.agent) || null, tool: clean(a.tool), args: obj(a.args) ?? {},
      timeoutSeconds: Number.isFinite(a.timeoutSeconds) && a.timeoutSeconds > 0 ? a.timeoutSeconds : null,
      deadline: Number.isFinite(Date.parse(str(a.deadline))) ? a.deadline : null,
    };
    item.key = approvalKey(item);
    if (!out.some((x) => x.key === item.key)) out.push(item);
  }
  return out;
}

function pathsOf(args) {
  const one = [args.path, args.file_path, args.filePath].map(clean).filter(Boolean);
  const many = [...(Array.isArray(args.paths) ? args.paths : []), ...(Array.isArray(args.edits) ? args.edits.map((x) => obj(x)?.path) : [])]
    .map(clean).filter(Boolean);
  return [...new Set([...one, ...many])];
}

// What a card shows about the call. -> { title, label, text } (label names what text is: a command, the files)
export function callView(a) {
  const tool = a?.tool ?? '';
  const args = obj(a?.args) ?? {};
  const title = TOOL_TEXT[tool] ?? `Use ${tool || 'a tool'}`;
  if (SHELL.has(tool)) return { title, label: 'Command', text: clip(clean(args.command) || clean(args.cmd)) || '(no command given)' };
  if (FILES.has(tool)) {
    const paths = pathsOf(args);
    return { title, label: paths.length > 1 ? 'Files' : 'File', text: clip(paths.join('\n')) || '(no path given)' };
  }
  let text = '';
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = '';
  }
  return { title, label: 'Arguments', text: clip(clean(text)) || '(none)' };
}

// Who asks: "Dwight · dwight-m1". state: the reducer state, for the names of custom agents.
export function whoText(a, state = null) {
  const name = a?.agent ? displayName(a.agent, state) : '';
  return [name, a?.instanceId && a.instanceId !== a.agent ? a.instanceId : ''].filter(Boolean).join(' \u00b7 ') || 'An agent';
}

// Whole seconds until the deadline, never below 0; null without one.
export function secondsLeft(a, now = Date.now()) {
  const at = Date.parse(a?.deadline ?? '');
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

// "4:59 left", or what happens once the wait ran out. '' without a deadline.
export function countdownText(a, now = Date.now()) {
  const s = secondsLeft(a, now);
  if (s === null) return '';
  if (s === 0) return 'Time is up: the call is denied';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss} left`;
}

// The live region's sentence for a call that started waiting.
export function askedText(a, state = null) {
  const v = callView(a);
  return `Approval needed: ${whoText(a, state)} wants to ${v.title.charAt(0).toLowerCase()}${v.title.slice(1)}: ${clip(v.text.split('\n')[0], 120)}`;
}

// POST .../approvals -> { body }
export function buildVerdict(a, approved) {
  return { body: { workflowId: a.workflowId, callId: a.callId, approved: approved === true } };
}

export function verdictText(approved) {
  return approved ? 'Approved - the agent goes on' : 'Denied - the agent is told so';
}

export function verdictError(status, data) {
  if (status === 404) return 'This call is no longer waiting for an answer.';
  if (status === 409) return 'Too late: the wait for this call ran out, so it was denied.';
  if (status === 0) return 'The server did not answer. Is it still running?';
  return responseError(status, data);
}
