// What the agents of a run reasoned and wrote, block by block, as the server keeps it beside the run's journal
// (GET .../runs/<id>/thoughts, .enma/live-activity-contract.md section 3a), and the stream of every agent made
// from it: its reasoning, its answers and its tool calls in the order they happened, with the block it is writing
// now at the end. No DOM in the model part, so Node can test it.
import { CLIENT_HEADERS } from './control.js';
import { toolLine } from './activity-model.js';
import { stripBidi } from './format.js';

export const THOUGHTS_POLL_MS = 1500;
export const THOUGHTS_RETRY_MS = 5000;
const KINDS = ['reasoning', 'answer'];
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const clean = (v) => stripBidi(typeof v === 'string' ? v : '').replace(/\r\n?/g, '\n').replace(CONTROLS, '');

// -> { runId, thoughts: [{ n, ts, instanceId, agent, kind, text, cut }], next } | null for anything else
export function parseThoughts(doc) {
  if (!doc || typeof doc !== 'object' || typeof doc.runId !== 'string' || !Array.isArray(doc.thoughts)) return null;
  const thoughts = doc.thoughts.flatMap((t) => {
    if (!t || typeof t !== 'object' || !Number.isSafeInteger(t.n) || typeof t.instanceId !== 'string' || !KINDS.includes(t.kind)) return [];
    const text = clean(t.text);
    return text.trim() ? [{ n: t.n, ts: typeof t.ts === 'string' ? t.ts : null, instanceId: t.instanceId, agent: typeof t.agent === 'string' ? t.agent : t.instanceId, kind: t.kind, text, cut: t.cut === true }] : [];
  });
  return { runId: doc.runId, thoughts, next: Number.isSafeInteger(doc.next) ? doc.next : thoughts.at(-1)?.n ?? 0 };
}

// The saved thoughts of one run at a time. want(runId, { live, open }): the run to show; asked for only while the
// view that shows it is open, again and again while the run is going, and once more after it ended.
// get() -> { runId, thoughts, off } (off: the server keeps none for this run - an older server, an older run, or
// an engine that saves none).
export function createThoughtLog({ url, onChange = null, fetch: ask = (...a) => globalThis.fetch(...a), timers = globalThis }) {
  let runId = null;
  let thoughts = [];
  let next = 0;
  let off = false;
  let timer = 0;
  let inflight = false;
  let gen = 0;
  let wanted = { live: false, open: false };
  // the run was read once after it ended: nothing more will come
  let settled = false;

  function reset(id) {
    gen += 1;
    timers.clearTimeout(timer);
    timer = 0;
    inflight = false;
    runId = id;
    thoughts = [];
    next = 0;
    off = false;
    settled = false;
  }

  async function poll() {
    const mine = gen;
    const at = url(runId);
    if (!at) return;
    const wasLive = wanted.live;
    let wait = THOUGHTS_POLL_MS;
    inflight = true;
    try {
      const r = await ask(`${at}?after=${next}`, { cache: 'no-store', headers: CLIENT_HEADERS });
      if (mine !== gen) return;
      if (r.status === 404) {
        // a run that is going may not have written its first block yet; one that is over never will
        if (!wasLive) off = true;
        if (!wasLive) settled = true;
        onChange?.();
      } else {
        const doc = r.ok ? parseThoughts(await r.json().catch(() => null)) : null;
        if (mine !== gen) return;
        if (doc && doc.runId === runId) {
          const fresh = doc.thoughts.filter((t) => t.n > next);
          if (fresh.length) {
            thoughts = [...thoughts, ...fresh];
            next = fresh.at(-1).n;
          }
          if (!wasLive) settled = true;
          if (fresh.length || off) {
            off = false;
            onChange?.();
          }
        } else wait = THOUGHTS_RETRY_MS;
      }
    } catch {
      if (mine !== gen) return;
      wait = THOUGHTS_RETRY_MS;
    } finally {
      if (mine === gen) {
        inflight = false;
        timer = timers.setTimeout(() => {
          timer = 0;
          sync();
        }, wait);
      }
    }
  }

  function sync() {
    if (!runId || !wanted.open || (settled && !wanted.live)) {
      timers.clearTimeout(timer);
      timer = 0;
      return;
    }
    if (!timer && !inflight) poll();
  }

  return {
    want(id, { live = false, open = false } = {}) {
      if (id !== runId) reset(id ?? null);
      // a run that just ended is read once more: its last blocks were written as it stopped
      if (wanted.live && !live) settled = false;
      wanted = { live, open };
      sync();
    },
    get: () => ({ runId, thoughts, off }),
  };
}

// The stream of every agent of the run on screen, in the order of the run view's agents; an instance the view no
// longer lists (it only left thoughts) follows.
// agents: the run view's. thoughts: createThoughtLog().get().thoughts. tools: the run's agent_tool events.
// tails: the /live instances (activity-model liveTails) or null. saved: the server keeps thoughts for this run.
// -> [{ id, name, role, status, live, line, items: [{ id, kind: 'reasoning' | 'answer' | 'tool', ts, text, cut }],
//       open: { kind, label, body, cut } | null }]
export function thoughtColumns({ agents = [], thoughts = [], tools = [], tails = null, saved = true } = {}) {
  const byId = new Map();
  const column = (id, a = null) => {
    if (!byId.has(id)) byId.set(id, { id, name: a?.name ?? id, role: a?.role ?? '', status: a?.status ?? 'done', live: Boolean(a?.live), line: a?.line ?? '', items: [], open: null });
    return byId.get(id);
  };
  for (const a of agents) column(a.id, a);
  for (const t of thoughts) column(t.instanceId).items.push({ id: `t${t.n}`, kind: t.kind, ts: t.ts, text: t.text, cut: t.cut, order: t.n });
  tools.forEach((e, i) => {
    const text = toolLine(e);
    if (text) column(e.instanceId ?? e.agent).items.push({ id: `e${e.seq ?? i}`, kind: 'tool', ts: e.ts ?? null, text, cut: false, order: i });
  });
  for (const c of byId.values()) {
    // by time; what shares a time stamp keeps the order it came in, a thought before the tool it led to
    c.items = c.items.map((x, i) => ({ x, i })).sort((a, b) => String(a.x.ts ?? '').localeCompare(String(b.x.ts ?? '')) || (a.x.kind === 'tool') - (b.x.kind === 'tool') || a.i - b.i)
      .map(({ x }) => ({ id: x.id, kind: x.kind, ts: x.ts, text: x.text, cut: x.cut }));
    const tail = tails?.[c.id];
    if (!tail) continue;
    // a server that saves thoughts says which block is still being written (open); the tail of a block that is
    // already saved is not shown a second time. Without saved thoughts the tail is all there is.
    const kind = saved ? tail.open : tail.phase === 'text' && tail.text ? 'text' : tail.thinking ? 'thinking' : tail.text ? 'text' : null;
    const part = kind === 'thinking' ? tail.thinking : kind === 'text' ? tail.text : null;
    if (part) c.open = { kind: kind === 'thinking' ? 'reasoning' : 'answer', label: kind === 'thinking' ? 'Reasoning' : 'Answer', body: part.body, cut: part.cut };
  }
  return [...byId.values()];
}
