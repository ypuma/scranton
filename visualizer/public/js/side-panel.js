// The side panel beside the main column, opened from the view bar: the Browser (a preview of what the agents
// built, from a dev server on this computer) or the Changes of the run on screen. One at a time; the choice lasts
// across chats and reloads.
import { store } from './control-panel.js';
import { classifyDiff } from './pipeline-model.js';
import { planOf } from './plan.js';
import { renderPlan } from './plan-render.js';

export const SIDE_KEY = 'scranton.side';
export const PREVIEW_KEY = 'scranton.preview_url';
export const SIDE_VIEWS = ['plan', 'browser', 'changes'];
const TITLES = { plan: 'Plan', browser: 'Browser', changes: 'Changes' };
const KIND_WORD = { write: 'wrote', wrote: 'wrote', edit: 'edited', edited: 'edited', create: 'created', delete: 'deleted' };
const LOCAL_ONLY = 'Only a dev server on this computer can be previewed: http://localhost:PORT or http://127.0.0.1:PORT.';
const DIFF_LINES_MAX = 4000;

export function parseSide(v) {
  return SIDE_VIEWS.includes(v) ? v : null;
}

// The address of a dev server on this computer, or why it is none. The page's content security policy frames
// http://localhost and http://127.0.0.1 only, so anything else would stay blank.
export function parsePreviewUrl(raw, own = '') {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'Enter an address first.' };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { error: LOCAL_ONLY };
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) return { error: LOCAL_ONLY };
  if (own && url.origin === own) return { error: 'That is this app. Enter the address of the app the agents built.' };
  return { url: url.href };
}

// The files the agents changed, each once, with who changed it last. agents: the run view's, newest file first.
export function changedFiles(agents) {
  const out = new Map();
  for (const a of agents ?? []) {
    for (const f of a.files ?? []) {
      if (!f?.path || f.kind === 'read') continue;
      const have = out.get(f.path);
      if (!have || String(f.ts ?? '') > String(have.ts ?? '')) out.set(f.path, { path: f.path, kind: KIND_WORD[f.kind] ?? String(f.kind ?? 'changed'), by: a.name ?? a.id, ts: f.ts ?? null });
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// onChange(open): the human opened or closed a panel, so what it shows may need to be fetched.
export function createSidePanel({ onChange } = {}) {
  const e = {
    panel: $('side-panel'), title: $('side-title'), aside: $('side-aside'), close: $('side-close'),
    views: { plan: $('side-plan'), browser: $('side-browser'), changes: $('side-changes') },
    buttons: { plan: $('bar-plan'), browser: $('bar-browser'), changes: $('bar-changes') },
    plan: $('plan-body'), planEmpty: $('plan-empty'), boardPlan: $('board-plan'),
    form: $('browser-form'), url: $('browser-url'), reload: $('browser-reload'), status: $('browser-status'),
    empty: $('browser-empty'), frame: $('browser-frame'),
    note: $('changes-note'), files: $('changes-files'), none: $('changes-empty'), diff: $('changes-diff'),
  };
  let open = parseSide(store.get(SIDE_KEY));
  let shown = '';
  let changesKey = '';
  let planKey = null;
  let asides = { plan: '', browser: '', changes: '' };

  function sync() {
    e.panel.hidden = !open;
    if (open) document.body.dataset.side = open;
    else delete document.body.dataset.side;
    for (const name of SIDE_VIEWS) {
      e.views[name].hidden = name !== open;
      e.buttons[name].setAttribute('aria-pressed', String(name === open));
    }
    if (open) {
      e.title.textContent = TITLES[open];
      e.aside.textContent = asides[open];
    }
  }

  function set(next, { focus = false } = {}) {
    open = next;
    store.set(SIDE_KEY, open ?? '');
    sync();
    if (open === 'browser' && !shown && e.url.value) show(e.url.value, { quiet: true });
    if (focus && open) (open === 'browser' && !shown ? e.url : e.title).focus();
    onChange?.(open);
  }

  function say(text, tone = '') {
    e.status.textContent = text;
    e.status.dataset.tone = tone;
  }

  function show(raw, { quiet = false } = {}) {
    const { url, error } = parsePreviewUrl(raw, globalThis.location?.origin ?? '');
    if (error) {
      if (!quiet) {
        say(error, 'error');
        e.url.setAttribute('aria-invalid', 'true');
      }
      return;
    }
    e.url.removeAttribute('aria-invalid');
    e.url.value = url;
    store.set(PREVIEW_KEY, url);
    shown = url;
    e.frame.src = url;
    e.frame.hidden = false;
    e.empty.hidden = true;
    e.reload.hidden = false;
    asides.browser = new URL(url).host;
    if (open === 'browser') e.aside.textContent = asides.browser;
    say(quiet ? '' : `Opened ${url}. A blank frame means nothing answers there yet.`);
  }

  e.form.addEventListener('submit', (event) => {
    event.preventDefault();
    show(e.url.value);
  });
  e.url.addEventListener('input', () => {
    e.url.removeAttribute('aria-invalid');
    if (e.status.dataset.tone === 'error') say('');
  });
  e.reload.addEventListener('click', () => {
    if (!shown) return;
    // a new assignment loads the address again, whatever the page inside went to since
    e.frame.src = shown;
    say(`Reloaded ${shown}.`);
  });
  e.close.addEventListener('click', () => {
    const from = e.buttons[open];
    set(null);
    from?.focus();
  });
  for (const name of SIDE_VIEWS) e.buttons[name].addEventListener('click', () => set(open === name ? null : name, { focus: true }));
  // the board's own way to its plan
  e.boardPlan.addEventListener('click', () => set('plan', { focus: true }));

  e.url.value = store.get(PREVIEW_KEY) ?? '';
  sync();
  if (open === 'browser' && e.url.value) show(e.url.value, { quiet: true });

  // rv: the run view on screen. diff: a pipeline chat's diff artifact ({ content, loading, error, truncated }) or null.
  function render(rv, diff = null) {
    const plan = planOf(rv?.board);
    const nextPlan = JSON.stringify(plan);
    if (nextPlan !== planKey) {
      planKey = nextPlan;
      e.plan.replaceChildren(...(plan.length ? [renderPlan(plan)] : []));
      e.planEmpty.hidden = plan.length > 0;
      e.boardPlan.hidden = !plan.length;
      const word = rv?.board?.kind === 'step' ? 'step' : 'milestone';
      asides.plan = plan.length ? `${plan.length} ${word}${plan.length === 1 ? '' : 's'}` : '';
      if (open === 'plan') e.aside.textContent = asides.plan;
    }
    const files = changedFiles(rv?.agents);
    const key = JSON.stringify([rv?.runId, files, diff?.key, diff?.loading, diff?.error, Boolean(diff?.content), diff?.known]);
    if (key === changesKey) return;
    changesKey = key;
    e.files.replaceChildren(...files.map((f) => {
      const li = el('li');
      const path = el('span', 'changes-path mono', f.path);
      path.title = f.path;
      li.append(path, el('span', 'changes-by', `${f.kind} by ${f.by}`));
      return li;
    }));
    const has = Boolean(diff?.content);
    e.none.hidden = files.length > 0 || has || Boolean(diff?.loading);
    e.files.hidden = !files.length;
    e.note.textContent = !rv?.runId ? 'No run is on screen.'
      : diff?.loading ? 'Loading the diff...'
        : diff?.error ? `The diff could not be shown. ${diff.error}`
          : has ? `What the run changed in the project${diff.truncated ? ', cut at the size limit' : ''}.`
            : diff?.known && files.length ? 'The project is the same as when the run started: what the agents wrote so far is not integrated yet, or came out identical.'
              : diff?.known ? 'The project is the same as when the run started.'
                : files.length ? 'The files the agents changed in this run, each with who touched it last.' : '';
    e.note.hidden = !e.note.textContent;
    e.diff.hidden = !has;
    if (has) {
      const lines = classifyDiff(diff.content);
      e.diff.replaceChildren(...lines.slice(0, DIFF_LINES_MAX).map((l) => {
        const span = el('span', 'dl', l.text);
        span.dataset.kind = l.kind;
        return span;
      }));
      if (lines.length > DIFF_LINES_MAX) e.diff.append(el('span', 'dl', `... ${lines.length - DIFF_LINES_MAX} more lines`));
    } else e.diff.replaceChildren();
    asides.changes = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '';
    if (open === 'changes') e.aside.textContent = asides.changes;
  }

  return { render, get: () => open, set };
}
