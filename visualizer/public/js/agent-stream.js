// What the models of the run on screen are producing right now, read from each active agent's live stream
// (.enma/run-options-contract.md, Live stream route; chunk format .enma/agent-stream-contract.md). The stream gives
// every delta of the current request; a marker starts each attempt, and the chunks of an attempt it replaces are
// dropped. An agent whose stream answers 404 or fails is left to the /live poll (live-poll.js), which keeps working
// as before. The result has the shape of the poll's, so the live views draw it unchanged.
import { CLIENT_HEADERS } from './control.js';
import { parseLive, LIVE_STALE_MS } from './activity-model.js';

export const STREAM_RETRY_MS = 5000;
export const STREAM_CONNECT_MS = 10000;
// what is kept of each kind; the views show the last 2,000 characters (activity-model TAIL_MAX)
export const STREAM_KEEP = 4000;

// Splits buffered text/event-stream text into its complete messages; rest = an unfinished message. Comments
// (": ping") and messages without data yield nothing. -> { frames: [{ id, event, data }], rest }
export function sseFrames(buffer) {
  const blocks = String(buffer).replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop();
  const frames = [];
  for (const block of blocks) {
    let id = null;
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const at = line.indexOf(':');
      const name = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (name === 'data') data.push(value);
      else if (name === 'event') event = value || 'message';
      else if (name === 'id') id = value;
    }
    if (data.length) frames.push({ id, event, data: data.join('\n') });
  }
  return { frames, rest };
}

const keep = (t) => (t.length > STREAM_KEEP ? { body: t.slice(t.length - STREAM_KEEP), cut: true } : { body: t, cut: false });

// The tail of one agent's stream: the reasoning and the text of the attempt that is going now. A compaction
// request is no answer of the agent, so only `llm:` steps count. push(value) -> true when the tail changed.
export function createStreamTail() {
  let step = null;
  let attempt = null;
  let thinking = '';
  let text = '';
  let thinkingCut = false;
  let textCut = false;
  let open = null;
  let updatedAt = null;

  function append(kind, delta) {
    if (kind === 'thinking') {
      const k = keep(thinking + delta);
      thinking = k.body;
      thinkingCut ||= k.cut;
    } else {
      const k = keep(text + delta);
      text = k.body;
      textCut ||= k.cut;
    }
    open = kind;
  }

  return {
    push(v, at = new Date().toISOString()) {
      if (!v || typeof v !== 'object' || typeof v.step !== 'string' || !v.step.startsWith('llm:')) return false;
      if (v.type === 'attempt_start') {
        // every marker starts over, also with the same attempt number: a recovered attempt restarts at 1
        step = v.step;
        attempt = v.attempt ?? null;
        thinking = '';
        text = '';
        thinkingCut = false;
        textCut = false;
        open = null;
        updatedAt = at;
        return true;
      }
      if (v.v !== 1 || (v.kind !== 'text' && v.kind !== 'thinking') || typeof v.delta !== 'string' || !v.delta) return false;
      if (step === null) {
        step = v.step;
        attempt = v.attempt ?? null;
      } else if (v.step !== step || (v.attempt ?? null) !== attempt) {
        return false;
      }
      append(v.kind, v.delta);
      updatedAt = at;
      return true;
    },
    // in the shape of a GET .../live instance (live-activity-contract section 3)
    instance(agent) {
      return {
        agent, phase: open === 'text' ? 'text' : 'thinking',
        thinking: thinking || null, thinkingCut, text: text || null, textCut, updatedAt, open,
      };
    },
  };
}

// url(runId, instanceId): where an agent's stream is read, or null. onChange(): get() changed.
export function createAgentStreams({
  url, onChange = null, fetch: ask = (...a) => globalThis.fetch(...a), timers = globalThis, now = Date.now,
}) {
  // instance id -> { id, agent, state: 'connecting' | 'open' | 'failed' | 'off' | 'ended', tail, ctl, timer }
  const streams = new Map();
  let runId = null;

  function close(s) {
    s.ctl?.abort();
    s.ctl = null;
    timers.clearTimeout(s.timer);
    s.timer = 0;
  }

  function changed() {
    onChange?.();
  }

  function retry(s, state = 'failed') {
    s.state = state;
    s.timer = timers.setTimeout(() => {
      s.timer = 0;
      if (streams.get(s.id) === s) connect(s);
    }, STREAM_RETRY_MS);
    changed();
  }

  // Reads the stream from its start: a reconnect rebuilds the tail, so no cursor has to be trusted.
  async function connect(s) {
    const at = url(runId, s.id);
    if (!at) return;
    const ctl = new AbortController();
    s.ctl = ctl;
    s.state = 'connecting';
    s.tail = createStreamTail();
    const mine = () => streams.get(s.id) === s && s.ctl === ctl;
    let headed = false;
    const deadline = timers.setTimeout(() => {
      if (!headed) ctl.abort();
    }, STREAM_CONNECT_MS);
    try {
      const res = await ask(at, { headers: { Accept: 'text/event-stream', ...CLIENT_HEADERS }, cache: 'no-store', signal: ctl.signal });
      headed = true;
      timers.clearTimeout(deadline);
      if (!mine()) return;
      // no such route, or no workflow of the agent yet (it has only just started): asked again in a while
      if (res.status === 404) {
        s.ctl = null;
        retry(s, 'off');
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      s.state = 'open';
      changed();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (!mine()) return;
        if (done) break;
        const { frames, rest } = sseFrames(buffer + value);
        buffer = rest;
        let moved = false;
        for (const f of frames) {
          if (f.event === 'end') {
            // the workflow is over: the agent's tail goes, as /live drops a finished agent
            close(s);
            s.state = 'ended';
            changed();
            return;
          }
          if (f.event !== 'chunk' && f.event !== 'message') continue;
          let v;
          try {
            v = JSON.parse(f.data);
          } catch {
            continue;
          }
          moved = s.tail.push(v, new Date(now()).toISOString()) || moved;
        }
        if (moved) changed();
      }
      // the server closed it without an end: read it again in a while, the poll covers the gap
      if (mine()) retry(s);
    } catch {
      timers.clearTimeout(deadline);
      if (mine()) retry(s);
    }
  }

  function closeAll() {
    const had = streams.size > 0;
    for (const s of streams.values()) close(s);
    streams.clear();
    if (had) changed();
  }

  return {
    // targets: [{ id, agent }] of the agents working now in run nextRun (activity-model liveTargets). on: the run on
    // screen is live; anything else closes every stream.
    sync({ runId: nextRun = null, targets = [], on = false } = {}) {
      if (!on || !nextRun) return closeAll();
      if (nextRun !== runId) {
        closeAll();
        runId = nextRun;
      }
      const ids = new Set(targets.map((t) => t.id));
      for (const [id, s] of streams) {
        if (ids.has(id)) continue;
        close(s);
        streams.delete(id);
        changed();
      }
      for (const t of targets) {
        if (streams.has(t.id)) continue;
        const s = { id: t.id, agent: t.agent, state: 'connecting', tail: createStreamTail(), ctl: null, timer: 0 };
        streams.set(t.id, s);
        connect(s);
      }
    },
    // { doc, at } like the poll's (parseLive), with the agents whose stream is open; null when none is
    get() {
      const open = [...streams.values()].filter((s) => s.state === 'open');
      if (!open.length) return null;
      const doc = parseLive({ runId, updatedAt: null, instances: Object.fromEntries(open.map((s) => [s.id, s.tail.instance(s.agent)])) });
      return doc ? { doc, at: now() } : null;
    },
    // an agent working now has no open stream: the /live poll is needed for it
    fallback: () => [...streams.values()].some((s) => s.state !== 'open'),
    served: (id) => streams.get(id)?.state === 'open',
    serving: () => [...streams.values()].some((s) => s.state === 'open'),
    states: () => Object.fromEntries([...streams].map(([id, s]) => [id, s.state])),
    reset() {
      for (const s of streams.values()) close(s);
      streams.clear();
      runId = null;
    },
  };
}

// The live document the views draw: every streamed agent from its stream, every other one from the /live poll as
// long as that answer is fresh. poll: createLivePoll(); streams: createAgentStreams().
export function mergeLive(poll, streams, now = Date.now()) {
  const s = streams.get();
  const p = poll.get();
  if (!s) return p;
  const fresh = p?.doc && p.doc.runId === s.doc.runId && Number.isFinite(p.at) && now - p.at <= LIVE_STALE_MS;
  const rest = fresh ? Object.fromEntries(Object.entries(p.doc.instances).filter(([id]) => !streams.served(id))) : {};
  return { doc: { ...s.doc, instances: { ...rest, ...s.doc.instances } }, at: now };
}
