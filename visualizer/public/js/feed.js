// Event sources: the live SSE stream (GET /events, or a chat's scoped .../events) and the demo replay of
// demo/sample-events.jsonl.
import { parseJsonl } from './state.js';

export const CONNECT_TIMEOUT_MS = 2000;
const DEMO_LOOP_PAUSE_MS = 7000;
const REPLAY_WINDOW_MS = 400;
const RETRY_MS = 3000;
const RETRY_MAX_MS = 60000;
// the scoped stream: the response head must arrive within this, or the attempt counts as lost
export const STREAM_CONNECT_MS = 10000;
// answers that no retry will change: the chat is gone, or this page is not allowed to read it
const FINAL_STATUS = new Set([403, 404]);

// Delay before reconnect attempt n (0-based): doubles from RETRY_MS up to RETRY_MAX_MS.
export function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.max(0, Math.min(attempt, 20)));
}

// Splits buffered text/event-stream text into the data of its complete messages; rest = an unfinished message.
// Comments (": ping") and messages without data ("retry: 2000") yield nothing.
export function sseMessages(buffer) {
  const blocks = String(buffer).replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop();
  const messages = [];
  for (const block of blocks) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length) messages.push(data.join('\n'));
  }
  return { messages, rest };
}

// EventSource cannot send headers, and the scoped routes answer 403 without X-Scranton-Client, so a chat's
// stream is read with fetch. Resolves when the server ends the stream; rejects on an HTTP error or abort.
async function readStream(url, { headers, signal, onOpen, onMessage }) {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers }, cache: 'no-store', signal });
  if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  onOpen();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const { messages, rest } = sseMessages(buffer + value);
    buffer = rest;
    for (const m of messages) onMessage(m);
  }
}

// Delay (ms) before each event, derived from the ts deltas: scaled so the whole run takes about
// targetMs, each gap capped at capMs. A hive_write gets at least hiveMs after it so its handoff
// animation is not swallowed by the events that follow it within milliseconds.
export function demoDelays(events, { targetMs = 75000, capMs = 2600, minMs = 90, hiveMs = 1100 } = {}) {
  const raw = events.map((e, i) => {
    if (i === 0) return 0;
    const d = Date.parse(e.ts) - Date.parse(events[i - 1].ts);
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
  const floor = events.map((e, i) => (i > 0 && events[i - 1].type === 'hive_write' ? hiveMs : minMs));
  const total = (f) => raw.reduce((sum, d, i) => sum + (i === 0 ? 0 : Math.min(capMs, Math.max(floor[i], d * f))), 0);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i += 1) {
    const mid = (lo + hi) / 2;
    if (total(mid) < targetMs) lo = mid;
    else hi = mid;
  }
  return raw.map((d, i) => (i === 0 ? 0 : Math.round(Math.min(capMs, Math.max(floor[i], d * lo)))));
}

// mode: 'auto' | 'live' | 'demo'. onEvent(event, { instant }) ; onMode(mode, info)
// modes reported: connecting | live | reconnecting | unavailable (403/404 on a scoped stream, no more retries) | demo
// headers: read the stream with fetch and send them (scoped routes); without, an EventSource reads url.
export function startFeed({
  mode = 'auto', onEvent, onMode, url = '/events', headers = null, demoUrl = 'demo/sample-events.jsonl', speed = 1, seek = 0,
  connectTimeoutMs = STREAM_CONNECT_MS,
}) {
  let stopped = false;
  let es = null;
  let demoTimer = null;
  let retryTimer = null;
  let abort = null;
  const emit = (fn) => (...args) => {
    if (!stopped) fn(...args);
  };
  onEvent = emit(onEvent);
  onMode = emit(onMode);

  function startDemo(reason) {
    if (stopped) return;
    onMode('demo', { reason });
    fetch(demoUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => playDemo(parseJsonl(text)))
      .catch((err) => onMode('demo', { reason, error: `Could not load the demo run: ${err.message}` }));
  }

  function playDemo(events) {
    if (!events.length) return;
    const delays = demoDelays(events).map((d) => d / Math.max(0.05, speed));
    let loop = 1;
    let i = 0;
    const emit = (e, instant) => onEvent(loop === 1 ? e : { ...e, runId: `${e.runId}#${loop}` }, { instant });
    for (; i < Math.min(seek, events.length); i += 1) emit(events[i], true);
    const next = () => {
      if (stopped) return;
      if (i >= events.length) {
        demoTimer = setTimeout(() => {
          loop += 1;
          i = 0;
          next();
        }, DEMO_LOOP_PAUSE_MS / Math.max(0.05, speed));
        return;
      }
      emit(events[i], false);
      i += 1;
      demoTimer = setTimeout(next, i < events.length ? delays[i] : 0);
    };
    demoTimer = setTimeout(next, i > 0 && i < events.length ? delays[i] : 0);
  }

  function startLive(fallbackToDemo) {
    let opened = false;
    let openedAt = 0;
    let timer = null;
    onMode('connecting');
    const open = () => {
      opened = true;
      openedAt = performance.now();
      clearTimeout(timer);
      onMode('live');
    };
    const message = (data) => {
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      // the replay right after (re)connecting is history, not something happening now
      onEvent(ev, { instant: performance.now() - openedAt < REPLAY_WINDOW_MS });
    };
    let attempt = 0;
    const connectFetch = () => {
      if (stopped) return;
      const ctl = new AbortController();
      abort = ctl;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, connectTimeoutMs);
      const onOpen = () => {
        clearTimeout(deadline);
        attempt = 0;
        open();
      };
      const lost = (err) => {
        clearTimeout(deadline);
        if (stopped) return;
        if (FINAL_STATUS.has(err?.status)) {
          onMode('unavailable', {
            status: err.status,
            error: err.status === 404 ? 'This chat is not on the server any more (HTTP 404). Pick another chat.'
              : 'The server refused this page access to the chat stream (HTTP 403). Reload the page.',
          });
          return;
        }
        const wait = retryDelay(attempt);
        attempt += 1;
        onMode('reconnecting', { reason: `${timedOut ? 'No answer' : 'Stream lost'} - retrying in ${Math.round(wait / 1000)} s` });
        retryTimer = setTimeout(connectFetch, wait);
      };
      readStream(url, { headers, signal: ctl.signal, onOpen, onMessage: message }).then(lost, lost);
    };
    if (headers) {
      connectFetch();
      return;
    }
    const connect = () => {
      if (stopped) return;
      es = new EventSource(url);
      es.onopen = open;
      es.onmessage = (msg) => message(msg.data);
      es.onerror = () => {
        if (!opened && fallbackToDemo) {
          clearTimeout(timer);
          es.close();
          startDemo(`No live server at ${url}`);
          return;
        }
        onMode('reconnecting');
        // a non-SSE answer (404, server gone) closes the EventSource for good; retry by hand
        if (es.readyState === EventSource.CLOSED) {
          es = null;
          retryTimer = setTimeout(connect, RETRY_MS);
        }
      };
    };
    if (fallbackToDemo) {
      timer = setTimeout(() => {
        if (opened || stopped) return;
        es?.close();
        startDemo('Live server did not answer within 2 s');
      }, CONNECT_TIMEOUT_MS);
    }
    connect();
  }

  if (mode === 'demo') startDemo('Demo mode (?demo=1)');
  else startLive(mode === 'auto');

  return {
    stop() {
      stopped = true;
      es?.close();
      abort?.abort();
      clearTimeout(demoTimer);
      clearTimeout(retryTimer);
    },
  };
}
