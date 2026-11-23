// Access outside the project (.enma/user-orders-contract.md sections 2-5): the permission modes of a run, what a
// request_access approval card says and offers, and what the run panel lists of the grants and the writes outside
// the project. No DOM, so Node can test it. Paths, reasons and quotes come from a model or a human: they are only
// ever shown as text.
import { stripBidi } from './format.js';
import { displayName } from './state.js';

export const PERMISSIONS = ['ask', 'auto', 'bypass'];
export const PERMISSION_DEFAULT = 'ask';
export const PERMISSION_LABEL = { ask: 'Ask', auto: 'Auto-approve', bypass: 'Bypass' };
// the contract's mode table in one line each; index.html carries the same words beside the radios
export const PERMISSION_HINT = {
  ask: 'default: reads of paths you named are allowed; other reads, writes and protected paths wait for your click',
  auto: 'reads outside the project and tool approvals are allowed; writes and protected paths wait for your click',
  bypass: 'reads, writes and tool approvals are allowed; protected paths still wait for your click',
};
export const ACCESS_TOOL = 'request_access';
export const MODES = ['read', 'write'];
export const PROTECTED = ['credentials', 'scranton-state'];
export const UNDO_WARNING = 'Changes outside the project are not covered by undo.';
export const PROTECTED_WARNING = {
  credentials: 'This path holds credentials. Allow it only if the agent really needs them.',
  'scranton-state': 'This is Scranton\'s own state. Agents may only read it, and only with your click.',
};
export const REASON_MAX = 2000;

const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => stripBidi(str(v)).replace(/\r\n?/g, '\n').replace(CONTROLS, '');
const clip = (t, max) => (t.length > max ? `${t.slice(0, max - 3)}...` : t);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

export const permissionOf = (v) => (PERMISSIONS.includes(v) ? v : null);
export const protectedOf = (v) => (PROTECTED.includes(v) ? v : null);
export const isAccess = (a) => a?.tool === ACCESS_TOOL;

// The access_request of the reducer state that a waiting request_access call belongs to: the instance's pending
// request, the one for the same path or mode first (the event has the resolved path, the call the model's text).
function requestOf(a, state) {
  const list = Array.isArray(state?.access) ? state.access : [];
  const args = obj(a?.args) ?? {};
  const mine = list.filter((r) => r.status === 'pending' && r.instanceId && r.instanceId === a?.instanceId);
  return mine.findLast((r) => r.path === clean(args.path)) ?? mine.findLast((r) => r.mode === args.mode) ?? mine.at(-1) ?? null;
}

// What a request_access card shows and offers. a: an approvals item (approvals.js parseApprovals). state: the
// reducer state, for the resolved path and the protected flag of its access_request.
// -> { mode, path, asked (the model's path text when the resolved one differs), reason, protected, warnings, grants }
export function accessCard(a, state = null) {
  const args = obj(a?.args) ?? {};
  const req = requestOf(a, state);
  const mode = MODES.includes(args.mode) ? args.mode : req?.mode === 'write' ? 'write' : 'read';
  const asked = clip(clean(args.path), REASON_MAX);
  const path = req?.path || asked;
  const prot = protectedOf(a?.protected) ?? req?.protected ?? null;
  const warnings = [mode === 'write' && UNDO_WARNING, prot && PROTECTED_WARNING[prot]].filter(Boolean);
  // writing to Scranton's own state is refused by the runtime, so it is never offered
  const grants = mode === 'write' && prot !== 'scranton-state' ? ['read', 'write'] : ['read'];
  return {
    mode, path: path || '(no path given)', asked: asked && asked !== path ? asked : '',
    reason: clip(clean(args.reason) || req?.reason || '', REASON_MAX) || '(no reason given)', protected: prot, warnings, grants,
  };
}

export const accessTitle = (mode) => (mode === 'write' ? 'Change files outside the project' : 'Read files outside the project');

// "granted: you asked for it" and the like; by is the access_decision's
export function decisionText(decision, by, permissions = null) {
  if (decision === 'pending') return 'waiting for your answer';
  if (decision === 'granted') {
    if (by === 'order') return 'granted: you asked for it';
    if (by === 'mode') return `granted by the permission mode${permissions ? ` (${PERMISSION_LABEL[permissions]})` : ''}`;
    if (by === 'human') return 'allowed by you';
    return 'granted';
  }
  if (by === 'timeout') return 'denied: no answer in time';
  if (by === 'human') return 'denied by you';
  // the runtime refuses a write by a read-only role or into Scranton's own state without asking
  if (by === 'mode') return 'refused: read-only role or Scranton state';
  return 'denied';
}

// What the run panel lists. -> { permissions, label, entries: [{ key, path, mode, line, quote, status, protected }],
// writes: [path], writeCount } or null when the run asked for nothing and wrote nothing outside the project.
export function accessView(state) {
  const list = Array.isArray(state?.access) ? state.access : [];
  const writes = Array.isArray(state?.outsideWrites) ? state.outsideWrites : [];
  const permissions = permissionOf(state?.permissions);
  if (!list.length && !writes.length) return null;
  const entries = list.map((r) => {
    const granted = r.status === 'granted' && r.grant && r.grant !== r.mode ? `${cap(r.grant)} (${r.mode} was asked)` : cap(r.grant ?? r.mode);
    const who = r.agent ? displayName(r.agent, state) : '';
    return {
      key: r.key, path: r.path || '(no path given)', mode: r.grant ?? r.mode, status: r.status, protected: r.protected ?? null,
      line: [granted, decisionText(r.status, r.by, r.permissions ?? permissions), who, r.protected && `protected: ${r.protected}`].filter(Boolean).join(' \u00b7 '),
      quote: r.quote || '',
    };
  });
  const count = Number.isInteger(state?.outsideWriteCount) ? state.outsideWriteCount : writes.length;
  return {
    permissions, label: permissions ? `Permissions: ${PERMISSION_LABEL[permissions]}` : '', entries, writes: writes.map((w) => w.path), writeCount: count,
  };
}

const cap = (t) => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : '');
