// Pure logic of the direct-message panel (POST /api/chat): recipients, request building, the local outbox of
// messages the server queued but the event stream has not shown yet, and what the live region says.
// No DOM, so Node can test it.
import { lanesOf, isLive, TERMINAL_STATUSES, instanceLabel, theName } from './state.js';
import { clip } from './control.js';

// The control route limit; a longer text is refused before it is sent.
export const CHAT_MAX = 16000;
export const RECIPIENT_RE = /^[a-z][a-z0-9-]{0,63}$/;
// A queued message the orchestrator has not echoed by then is flagged, never relabelled.
export const OUTBOX_STALE_MS = 20000;

export const DELIVERY_LABEL = { queued: 'queued', delivered: 'delivered', rejected: 'rejected', unknown: 'delivery unknown' };

// Who a human may write to: live instances of the run on screen. The event stream is the source of truth;
// the control document fills in instances the stream has not shown yet and marks ones it already ended.
// -> [{ id, name ("Developer · m1"), agent, milestoneId, status }]
export function chatRecipients(state, control) {
  if (!state?.runId) return [];
  const byId = new Map(lanesOf(state).map((i) => [i.id, { id: i.id, name: instanceLabel(i.id, state), agent: i.agent, milestoneId: i.milestoneId, status: i.status }]));
  if (control?.run?.runId === state.runId) {
    for (const c of Object.values(control.instances ?? {})) {
      const known = byId.get(c.id);
      if (!known) byId.set(c.id, { ...c, name: instanceLabel(c.id, state) });
      else if (TERMINAL_STATUSES.has(c.status)) known.status = c.status;
    }
  }
  return [...byId.values()].filter((r) => isLive(r) && RECIPIENT_RE.test(r.id));
}

// name(id): what the recipient is called in a sentence. -> { body } or { error, field }
export function buildChatRequest({ to, text } = {}, { runId, recipients = [], name = theName } = {}) {
  if (!runId) return { error: 'No run is in progress.' };
  const target = typeof to === 'string' ? to : '';
  if (!target) return { error: 'Pick the agent instance that should get the message.', field: 'to' };
  if (!recipients.some((r) => r.id === target)) return { error: `${capital(name(target))} is not running any more. Pick another instance.`, field: 'to' };
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { error: 'Write the message first.', field: 'text' };
  if (body.length > CHAT_MAX) return { error: `The message is ${body.length} characters; the limit is ${CHAT_MAX}.`, field: 'text' };
  return { body: { runId, to: target, text: body } };
}

// Which outbox entries the stream has echoed -> Set of their ids. The orchestrator keeps the id POST /api/chat
// returned, so only that id counts: two identical messages to one instance never claim each other's echo.
export function matchOutbox(outbox, state) {
  const echoed = new Set((state?.chat ?? []).map((c) => c.id));
  return new Set(outbox.filter((o) => o.runId === state?.runId && echoed.has(o.id)).map((o) => o.id));
}

// The transcript: state.chat plus the outbox entries the stream has not echoed yet, oldest first.
export function transcript(state, outbox = []) {
  const matched = matchOutbox(outbox, state);
  const local = outbox.filter((o) => o.runId === state?.runId && !matched.has(o.id));
  return [...(state?.chat ?? []), ...local.map((o) => ({ ...o, local: true }))];
}

// Outbox entries still waiting for their chat_message, for the given run.
export function pruneOutbox(outbox, state) {
  const matched = matchOutbox(outbox, state);
  return outbox.filter((o) => o.runId === state?.runId && !matched.has(o.id));
}

export function outboxStale(entry, now = Date.now()) {
  return Boolean(entry?.local) && now - (entry.sentAt ?? now) >= OUTBOX_STALE_MS;
}

// What the live region says about the human's own messages whose delivery changed.
// prev / next: Map id -> delivery. name(id): what the recipient is called in a sentence. -> text or ''
export function deliveryNews(prev, next, entries, name = theName) {
  const lines = [];
  for (const e of entries) {
    const before = prev.get(e.id);
    const now = next.get(e.id);
    if (!now || before === now || now === 'queued') continue;
    if (now === 'delivered') lines.push(`Message to ${name(e.to)} delivered`);
    else if (now === 'unknown') lines.push(`Message to ${name(e.to)}: delivery unknown, it is not resent automatically`);
    else lines.push(`Message to ${name(e.to)} rejected${e.reason ? `: ${clip(e.reason, 120)}` : ''}`);
  }
  return lines.join('. ');
}

const capital = (t) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

// Why the composer is off, or '' when it is on.
export function composerBlock({ enabled, mode, alive, sameRun, recipients, gone = false }) {
  if (mode === 'demo') return 'This is a recorded replay; messages cannot be sent.';
  if (!enabled) return 'Read only. Messaging needs the desktop app or scranton visualize --control.';
  if (gone && !alive) return 'The run process exited; nobody can receive messages any more.';
  if (!alive) return 'No run is in progress.';
  if (!sameRun) return 'Waiting for the running process to publish its run.';
  if (!recipients.length) return 'No agent instance is running right now.';
  return '';
}
