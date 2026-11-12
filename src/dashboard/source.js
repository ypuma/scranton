import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const EVENT_TYPES = new Set([
  'run_started', 'plan_ready', 'milestone_started', 'hive_write', 'agent_status', 'agent_tool',
  'agent_finished', 'cycle_result', 'circuit_breaker', 'hitl_request', 'hitl_response',
  'milestone_finished', 'run_finished', 'log', 'instance_started', 'chat_message', 'chat_delivery', 'milestone_integrated',
  'chat_command_rejected', 'gate_result', 'agent_message', 'run_reply',
]);

function isEvent(ev) {
  return Boolean(ev) && typeof ev === 'object' && !Array.isArray(ev)
    && EVENT_TYPES.has(ev.type) && typeof ev.runId === 'string' && Number.isFinite(ev.seq);
}

/**
 * Parses complete JSON lines. The text after the last LF is a line still being written
 * and is ignored; with dropFirst the first line is a fragment of a tail read and is ignored too.
 */
export function parseEventLines(text, { dropFirst = false } = {}) {
  const lines = String(text).split('\n');
  lines.pop();
  if (dropFirst) lines.shift();
  const events = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (isEvent(ev)) events.push(ev);
  }
  return events;
}

/** Events of one run (state.runId, else the latest run_started), in seq order without repeats. */
export function selectRunEvents(events, runId = null) {
  let target = typeof runId === 'string' && runId ? runId : null;
  if (!target) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'run_started') {
        target = events[i].runId;
        break;
      }
    }
  }
  if (!target && events.length) target = events[events.length - 1].runId;
  const run = events.filter((ev) => ev.runId === target).sort((a, b) => a.seq - b.seq);
  const out = [];
  for (const ev of run) {
    if (out.length && ev.seq <= out[out.length - 1].seq) continue;
    out.push(ev);
  }
  return out;
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

/**
 * Polls hive/state.json and the tail of hive/events.jsonl. poll() resolves true when
 * anything visible may have changed; a missing state file means idle, an unreadable or
 * half-written one keeps the last good snapshot. The run_started line at the head of the
 * file is kept too, so a long run keeps its start time.
 */
export function createHiveSource(hiveDir, { tailBytes = 64 * 1024, headBytes = 16 * 1024, maxEvents = 500 } = {}) {
  const statePath = path.join(hiveDir, 'state.json');
  const eventsPath = path.join(hiveDir, 'events.jsonl');
  let state = null;
  let stateText = null;
  let tail = [];
  let tailKey = null;
  let head = null;
  let events = [];
  let gateOffset = 0;
  let gateRun = null;
  let gateInode = null;
  let gateDropping = false;
  const gateResults = new Map();
  let conversationEvents = [], visibleEvents = [], visibleBytes = 0;

  // Gate verdicts must survive tool traffic scrolling out of the log tail.
  async function readGateResults(handle, info, runId) {
    if (gateRun !== runId || gateInode !== info.ino || gateOffset > info.size) {
      gateResults.clear();
      conversationEvents = []; visibleEvents = []; visibleBytes = 0;
      gateOffset = 0;
      gateDropping = false;
    }
    gateRun = runId;
    gateInode = info.ino;
    let position = gateOffset;
    let pending = Buffer.alloc(0);
    while (position < info.size) {
      const buf = Buffer.alloc(Math.min(64 * 1024, info.size - position));
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      if (gateDropping) {
        const newline = chunk.indexOf(10);
        if (newline < 0) { gateOffset = position; continue; }
        chunk = chunk.subarray(newline + 1);
        gateDropping = false;
      }
      pending = Buffer.concat([pending, chunk]);
      const end = pending.lastIndexOf(10);
      if (end < 0) {
        if (pending.length > 256 * 1024) {
          pending = Buffer.alloc(0);
          gateDropping = true;
          gateOffset = position;
        }
        continue;
      }
      for (const ev of parseEventLines(pending.subarray(0, end + 1).toString('utf8'))) {
        if (ev.runId === runId) {
          const bytes = Buffer.byteLength(JSON.stringify(ev)) + 1;
          visibleEvents.push({ ev, bytes }); visibleBytes += bytes;
          while (visibleEvents.length > 1 && (visibleBytes > tailBytes || visibleEvents.length > Math.max(1, maxEvents))) visibleBytes -= visibleEvents.shift().bytes;
        }
        if (ev.runId === runId && ev.type !== 'agent_message') {
          conversationEvents.push(ev);
          if (conversationEvents.length > Math.max(1, maxEvents)) conversationEvents.shift();
        }
        if (ev.type !== 'gate_result' || ev.runId !== runId || !(/^[a-z][a-z0-9]{1,19}$/).test(ev.agent)) continue;
        const key = `${ev.milestoneId}:${ev.agent}`;
        if (!gateResults.has(key) || ev.seq > gateResults.get(key).seq) gateResults.set(key, ev);
        if (gateResults.size > 119) gateResults.delete(gateResults.keys().next().value);
      }
      pending = pending.subarray(end + 1);
      gateOffset = position - pending.length;
    }
  }

  async function readState() {
    let text;
    try {
      text = await readFile(statePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT' || stateText === null) return false;
      state = null;
      stateText = null;
      return true;
    }
    if (text === stateText) return false;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    state = parsed;
    stateText = text;
    return true;
  }

  async function readEvents() {
    let info;
    try {
      info = await stat(eventsPath);
    } catch (err) {
      if (err.code !== 'ENOENT' || tailKey === 'missing') return false;
      tail = [];
      head = null;
      gateResults.clear();
      conversationEvents = []; visibleEvents = []; visibleBytes = 0;
      gateRun = null;
      gateOffset = 0;
      tailKey = 'missing';
      return true;
    }
    const key = `${info.size}:${info.mtimeMs}:${info.ino}`;
    if (key === tailKey) return false;
    const start = Math.max(0, info.size - tailBytes);
    // One byte before the window tells whether the window starts on a line boundary.
    const from = start > 0 ? start - 1 : 0;
    const length = info.size - from;
    let next = [];
    let nextHead = null;
    if (length > 0) {
      const handle = await open(eventsPath, 'r');
      try {
        next = parseEventLines(await readAt(handle, from, length), { dropFirst: start > 0 });
        let runId = next.at(-1)?.runId || state?.runId || head?.runId || gateRun;
        if (!runId && start > 0) {
          const first = parseEventLines(await readAt(handle, 0, Math.min(headBytes, start)));
          nextHead = first.find(ev => ev.type === 'run_started') ?? null;
          runId = nextHead?.runId ?? first.at(-1)?.runId;
        }
        if (start > 0 && runId && !next.some((ev) => ev.type === 'run_started')) {
          // The head only changes with a new run, which brings a new runId into the tail.
          if (head && head.runId === runId) nextHead = head;
          else nextHead = parseEventLines(await readAt(handle, 0, Math.min(headBytes, start))).find((ev) => ev.type === 'run_started') ?? null;
        }
        await readGateResults(handle, info, runId);
      } finally {
        await handle.close();
      }
    }
    if (!length) {
      gateResults.clear();
      conversationEvents = []; visibleEvents = []; visibleBytes = 0;
      gateRun = null;
      gateOffset = 0;
      gateDropping = false;
    }
    // Assistant bodies do not consume the visible event budget in conversation mode.
    tail = state?.execution?.conversation === true || (nextHead ?? next.find((ev) => ev.type === 'run_started') ?? head)?.execution?.conversation === true
      ? conversationEvents.slice() : visibleEvents.map(row => row.ev);
    head = nextHead;
    tailKey = key;
    return true;
  }

  return {
    get state() {
      return state;
    },
    get events() {
      return events;
    },
    async poll() {
      let changed = false;
      try {
        changed = await readState();
      } catch {
        // keep the last good snapshot
      }
      try {
        changed = (await readEvents()) || changed;
      } catch {
        // file replaced mid-read; the next poll reads it again
      }
      if (changed) {
        const run = selectRunEvents([...(head ? [head] : []), ...gateResults.values(), ...tail], state?.runId);
        const keep = Math.max(1, maxEvents);
        if (run.length <= keep) events = run;
        else {
          const pinned = run.filter((ev) => ev.type === 'run_started' || gateResults.get(`${ev.milestoneId}:${ev.agent}`) === ev).slice(0, keep);
          const recent = run.filter((ev) => !pinned.includes(ev)).slice(-Math.max(0, keep - pinned.length));
          events = selectRunEvents([...pinned, ...(pinned.length < keep ? recent : [])], state?.runId);
        }
      }
      return changed;
    },
  };
}
