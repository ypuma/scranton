// The Chat view: a chat's runs as one conversation, drawn from the engine-neutral entries of an adapter
// (.enma/chat-view-contract.md section 7, chat-entries.js). It never reads an engine's events itself, and model
// text only ever becomes text nodes.
import { groupRuns, runDigest, followers, splitKeyword, keywordWords, isLong, entryKey, entryLabel, announcement, REPLY_LABEL } from './chat-entries.js';
import { richText } from './long-text.js';
import { copyButton } from './copy.js';
import { formatWhen } from './format.js';

const $ = (id) => document.getElementById(id);
const FOLLOW_SLACK_PX = 24;
const LOAD_FAILED = 'The agent messages of this run could not be loaded.';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// children of parent become exactly nodes, in order; a node already in place is not touched, so it keeps the focus
function place(parent, nodes) {
  nodes.forEach((n, i) => {
    if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null);
  });
}

// getEntries(): the whole conversation as Entry[], oldest first; the same array again means nothing changed.
// currentRunId(): the run shown in full; every other run is an earlier one and shows its request and reply.
// loadRun(runId) -> Promise<{ ok: true } | { error }>: fetch an earlier run's detail; getEntries() then has it.
//   null: earlier runs cannot be opened.
// announce(text, kind): the page's live region; called for a new reply and a question that waits, nothing else.
// ask(entry) -> { label, open() } | null: the one button of a question that waits, for an engine whose answer
//   controls are not docked under the transcript. The view itself never answers anything.
export function createChatView({ getEntries, currentRunId = () => null, loadRun = null, announce = () => {}, ask = () => null, plan = null }) {
  const e = { scroll: $('chat-view-scroll'), list: $('chat-view-list'), jump: $('chat-view-jump') };
  // runId -> { el, tools, toggle, note, items: Map(entry id -> { el, key }) }
  const sections = new Map();
  // entries shown in full, earlier runs showing their agent messages, and how their loading stands
  const expanded = new Set();
  const open = new Set();
  const loading = new Set();
  const failed = new Map();
  // replies and questions that were announced, or were history when the page got them
  const said = new Set();
  let drawn = null;
  let drawnFor = null;
  // follow the newest entry unless the reader scrolled back; kept while the view is hidden and has no box
  let follow = true;
  let readTop = 0;
  let unseen = 0;
  // bumped by reset(): an earlier run that arrives for the previous chat is dropped
  let gen = 0;

  // A hidden view has no box: every measurement is 0, so it would always read as at the bottom.
  const laidOut = () => e.scroll.clientHeight > 0;

  function atBottom() {
    return e.scroll.scrollHeight - e.scroll.scrollTop - e.scroll.clientHeight <= FOLLOW_SLACK_PX;
  }

  function showJump() {
    // the button is about to go: the transcript it belongs to takes the focus, not the page
    if (follow && document.activeElement === e.jump) e.scroll.focus({ preventScroll: true });
    e.jump.hidden = follow;
    e.jump.textContent = unseen ? `${unseen} new · Jump to latest` : 'Jump to latest';
  }

  function toBottom() {
    e.scroll.scrollTop = e.scroll.scrollHeight;
    follow = true;
    unseen = 0;
    showJump();
  }

  e.scroll.addEventListener('scroll', () => {
    if (!laidOut()) return;
    follow = atBottom();
    readTop = e.scroll.scrollTop;
    if (follow) unseen = 0;
    showJump();
  });
  e.jump.addEventListener('click', toBottom);

  function head(x, keyword) {
    const h = el('div', 'chat-head');
    // a reply is named by what it is, then by who wrote it
    if (x.kind === 'reply') h.append(el('span', 'chat-kind', REPLY_LABEL[x.replyKind] ?? 'Reply'));
    h.append(el('span', 'chat-who', x.who?.name || 'Scranton'));
    if (x.kind !== 'reply' && x.who?.title) h.append(el('span', 'chat-role', x.who.title));
    if (x.kind !== 'reply' && x.context) h.append(el('span', 'chat-context', x.context));
    // the keyword in the run panel's words; the protocol word stays at hand for whoever looks for it
    const chip = keyword ? el('span', 'badge chat-keyword', keywordWords(keyword))
      : x.kind === 'question' && x.tone === 'warn' ? el('span', 'badge', 'waiting for an answer') : null;
    if (chip) {
      chip.dataset.tone = keyword ? 'quiet' : 'loud';
      if (keyword) {
        chip.dataset.keyword = keyword;
        chip.title = `[${keyword}]`;
      }
      h.append(chip);
    }
    if (x.ts) {
      const time = el('time', 'chat-time mono', formatWhen(x.ts));
      time.dateTime = x.ts;
      time.title = x.ts;
      h.append(time);
    }
    return h;
  }

  // cont: the entry follows its speaker's label line (chat-entries.js followers), so it does without its own
  function fill(node, x, cont) {
    node.dataset.entry = x.id;
    node.dataset.kind = x.kind;
    node.dataset.cont = String(cont);
    if (x.tone) node.dataset.tone = x.tone;
    else delete node.dataset.tone;
    // one quiet line: who, where, what
    if (x.kind === 'activity') {
      const text = [x.who?.name, x.context, x.text].filter(Boolean).join(' · ');
      const line = el('span', 'chat-act');
      if (cont) {
        const prefix = [x.who?.name, x.context].filter(Boolean).join(' · ');
        if (prefix) line.append(el('span', 'sr-only', `${prefix} · `));
        line.append(x.text ?? '');
      } else line.textContent = text;
      line.title = x.keyword ? `${text} [${x.keyword}]` : text;
      const time = el('time', 'chat-time mono', x.ts ? formatWhen(x.ts) : '');
      time.title = x.ts ?? '';
      node.replaceChildren(line, time);
      return;
    }
    node.setAttribute('aria-label', entryLabel(x));
    if (x.kind === 'agent') node.dataset.final = String(x.final === true);
    const model = x.kind === 'agent' || x.kind === 'reply';
    const { text, keyword } = x.kind === 'agent' ? splitKeyword(x.text) : { text: x.text ?? '', keyword: null };
    const parts = [head(x, keyword)];
    // what a run hands over (a reply, an agent's final message) can be taken along as it was written
    const copyable = Boolean(text.trim()) && (x.kind === 'reply' || x.final === true);
    node.className = copyable ? 'chat-entry copy-host' : 'chat-entry';
    if (copyable) parts[0].append(copyButton({ text, what: x.kind === 'reply' ? `the ${(REPLY_LABEL[x.replyKind] ?? 'Reply').toLowerCase()}` : 'this message' }));
    if (text.trim()) {
      const body = el('div', model ? 'chat-body md' : 'chat-body');
      // what a person typed is shown as typed; what a model wrote goes through the Markdown subset
      // an entry that carries a plan (the planner's message) is read as one, not as a long line of JSON
      const planned = plan && Array.isArray(x.plan) && x.plan.length > 0;
      if (planned) {
        body.append(plan.render(x.plan));
        // the message as the planner wrote it, JSON and all, for whoever wants to read or copy it
        if (plan.brief && expanded.has(x.id)) {
          const raw = el('div', 'chat-raw');
          raw.append(...richText(text));
          body.append(raw);
        }
      } else if (model) body.append(...richText(text));
      else body.textContent = text;
      parts.push(body);
      if (planned && plan.open) {
        const b = el('button', 'btn btn-small chat-plan', 'Open the plan');
        b.type = 'button';
        b.dataset.plan = x.id;
        parts.push(b);
      }
    }
    // a plan shown as its titles (plan.brief) is short whatever the length of the JSON it came as
    const brief = Boolean(plan?.brief && Array.isArray(x.plan) && x.plan.length > 0);
    const long = !brief && isLong(text);
    node.dataset.long = String(long);
    node.toggleAttribute('data-open', expanded.has(x.id));
    if (long || (brief && text.trim())) {
      const more = el('button', 'msg-more', brief ? (expanded.has(x.id) ? 'Hide the raw message' : 'Show the raw message')
        : expanded.has(x.id) ? 'Show less' : 'Show more');
      more.type = 'button';
      more.dataset.toggle = x.id;
      more.setAttribute('aria-expanded', String(expanded.has(x.id)));
      parts.push(more);
    }
    if (x.truncated) parts.push(el('p', 'chat-note', 'This text was shortened.'));
    if (x.kind === 'reply' && x.context) parts.push(el('p', 'chat-outcome', x.context));
    const offer = x.kind === 'question' && x.tone === 'warn' ? ask(x) : null;
    if (offer) {
      const b = el('button', 'btn btn-small chat-ask', offer.label);
      b.type = 'button';
      b.dataset.ask = x.id;
      parts.push(b);
    }
    node.replaceChildren(...parts);
  }

  function section(runId) {
    const sec = { el: el('section', 'chat-run'), tools: el('div', 'chat-run-tools'), toggle: el('button', 'msg-more chat-run-expand'), note: el('span', 'chat-run-note'), items: new Map() };
    sec.el.dataset.runId = runId;
    sec.toggle.type = 'button';
    sec.toggle.dataset.runId = runId;
    // the outcome of a load the human asked for; the transcript itself is no live region
    sec.note.setAttribute('role', 'status');
    sec.tools.append(sec.toggle, sec.note);
    return sec;
  }

  function renderTools(sec, runId) {
    const shown = open.has(runId);
    sec.toggle.textContent = loading.has(runId) ? 'Loading agent messages...' : shown ? 'Hide agent messages' : 'Show agent messages';
    sec.toggle.setAttribute('aria-expanded', String(shown));
    sec.toggle.setAttribute('aria-busy', String(loading.has(runId)));
    const why = failed.get(runId) ?? '';
    if (sec.note.textContent !== why) sec.note.textContent = why;
  }

  // quiet: what is new in this render is history (a chat that was just opened), so nothing is announced.
  function render({ quiet = false } = {}) {
    const entries = getEntries();
    const current = currentRunId();
    const state = [current, [...open], [...loading], [...failed], [...expanded]].join('|');
    if (entries === drawn && state === drawnFor) return;
    drawn = entries;
    drawnFor = state;

    const held = e.list.contains(document.activeElement) ? document.activeElement : null;
    // the button of an entry is found again by what it does and the entry it belongs to
    const heldAt = !held ? null : held.dataset.toggle ? ['toggle', held.dataset.toggle] : held.dataset.ask ? ['ask', held.dataset.ask] : null;
    // follow, not only the position: a box that just shrank (the dock grew) is off the bottom
    const stick = follow || (laidOut() && atBottom());
    const groups = groupRuns(entries);
    let changed = false;
    let added = 0;

    for (const [runId, sec] of sections) {
      if (groups.some((g) => g.runId === runId)) continue;
      sec.el.remove();
      sections.delete(runId);
      changed = true;
    }
    for (const g of groups) {
      let sec = sections.get(g.runId);
      if (!sec) {
        sec = section(g.runId);
        sections.set(g.runId, sec);
      }
      const earlier = g.runId !== current;
      const shown = earlier && !open.has(g.runId) ? runDigest(g.entries) : g.entries;
      const ids = new Set(shown.map((x) => x.id));
      const follows = followers(shown);
      for (const [id, item] of sec.items) {
        if (ids.has(id)) continue;
        item.el.remove();
        sec.items.delete(id);
        changed = true;
      }
      const nodes = shown.map((x) => {
        const cont = follows.has(x.id);
        const key = `${entryKey(x, expanded.has(x.id))}${cont ? '+' : ''}`;
        let item = sec.items.get(x.id);
        if (!item) {
          item = { el: el(x.kind === 'activity' ? 'p' : 'article', 'chat-entry'), key: '' };
          sec.items.set(x.id, item);
          if (!earlier) added += 1;
        }
        if (item.key !== key) {
          item.key = key;
          fill(item.el, x, cont);
          changed = true;
        }
        return item.el;
      });
      // an earlier run can be opened: the control sits under what was asked, where it stays when the run opens
      if (earlier && loadRun) {
        renderTools(sec, g.runId);
        nodes.splice(Math.min(1, nodes.length), 0, sec.tools);
      } else if (sec.tools.parentNode) {
        sec.tools.remove();
      }
      place(sec.el, nodes);
    }
    place(e.list, groups.map((g) => sections.get(g.runId).el));

    // a redrawn entry took its button with it: the same button of the new one gets the focus, else the transcript
    if (held && !e.list.contains(document.activeElement)) {
      const again = heldAt ? [...e.list.querySelectorAll(`button[data-${heldAt[0]}]`)].find((b) => b.dataset[heldAt[0]] === heldAt[1]) : null;
      (again ?? e.scroll).focus({ preventScroll: true });
    }

    for (const g of groups) {
      if (g.runId !== current) continue;
      for (const x of g.entries) {
        const text = announcement(x);
        if (!text || said.has(x.id)) continue;
        said.add(x.id);
        if (!quiet) announce(text, x.kind);
      }
    }

    if (!changed) return;
    if (stick) toBottom();
    else {
      unseen += added;
      showJump();
    }
  }

  async function toggleRun(runId) {
    if (loading.has(runId)) return;
    failed.delete(runId);
    if (open.has(runId)) {
      open.delete(runId);
      render();
      return;
    }
    const at = gen;
    loading.add(runId);
    render();
    let r = null;
    try {
      r = await loadRun(runId);
    } catch {
      // said as a failed load below
    }
    if (at !== gen) return;
    loading.delete(runId);
    if (r?.ok) open.add(runId);
    else failed.set(runId, r?.error || LOAD_FAILED);
    render();
    // opening a run is reading it: the next entry must not scroll it away
    if (laidOut()) follow = atBottom();
    showJump();
  }

  e.list.addEventListener('click', (ev) => {
    const more = ev.target.closest('button[data-toggle]');
    if (more) {
      const id = more.dataset.toggle;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
      if (laidOut()) follow = atBottom();
      showJump();
      return;
    }
    const run = ev.target.closest('.chat-run-expand');
    if (run && loadRun) {
      toggleRun(run.dataset.runId);
      return;
    }
    if (ev.target.closest('button[data-plan]')) { plan?.open?.(); return; }
    const asked = ev.target.closest('button[data-ask]');
    const entry = asked ? getEntries().find((x) => x.id === asked.dataset.ask) : null;
    if (entry) ask(entry)?.open();
  });

  // Another chat is on screen: nothing of the previous conversation carries over.
  function reset() {
    gen += 1;
    sections.clear();
    for (const set of [expanded, open, loading, said]) set.clear();
    failed.clear();
    drawn = null;
    drawnFor = null;
    follow = true;
    readTop = 0;
    unseen = 0;
    e.list.replaceChildren();
    showJump();
  }

  // On screen again: entries that came in while the view had no box could not scroll it, so a follower gets the
  // newest entry and a reader the place they left.
  function reveal() {
    if (!laidOut()) return;
    if (follow) toBottom();
    else e.scroll.scrollTop = readTop;
  }
  // shown by the view switch, or resized by the dock growing under it: the scroller says so itself
  let lastHeight = 0;
  if (globalThis.ResizeObserver) {
    new ResizeObserver(() => {
      const h = e.scroll.clientHeight;
      if (h > 0 && lastHeight === 0) reveal();
      else if (h > 0 && follow) toBottom();
      lastHeight = h;
    }).observe(e.scroll);
  }

  showJump();
  return { render, reset, reveal, toBottom };
}
