// Projects and chats sidebar (.enma/multiproject-contract.md): GET /api/projects every few seconds, status per chat,
// a badge on background chats that need a human, and the New project / rename / remove dialogs. Switching chats
// only changes what this page shows; nothing on the server is stopped.
import { CLIENT_HEADERS, isAbsolutePath, clip } from './control.js';
import { postJson, store } from './control-panel.js';
import {
  PROJECTS_POLL_MS, parseProjects, sidebarModel, capacityText, hashFor, findProject, findChat, scopedUrl,
  buildProject, buildRename, buildRemove, projectError, projectErrorField, titleFromGoal, CHAT_STATUS,
} from './scope.js';

const $ = (id) => document.getElementById(id);
const NARROW = '(max-width: 899px)';
const OPEN_KEY = 'scranton.nav';
const COLLAPSED_KEY = 'scranton.navCollapsed';
const enc = encodeURIComponent;
// the maxlength of #p-folder
const FOLDER_MAX = 1024;

// The desktop app's folder picker (Tauri dialog plugin). A browser never hands out an absolute path, so it has none.
function dialogInvoke() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls, text, label) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

// -> { status, doc } ; status 0 = no answer
async function getDoc(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', headers: CLIENT_HEADERS });
    return { status: r.status, doc: r.ok ? await r.json().catch(() => null) : null };
  } catch {
    return { status: 0, doc: null };
  }
}

// getScope(): the scope on screen. navigate(scope, { replace }) shows another one. openRun(opts): the New run drawer.
export function createNav({ getScope, navigate, openRun, onProjects, announce }) {
  const e = {
    nav: $('sidebar'), toggle: $('nav-toggle'), toggleLabel: $('nav-toggle-label'), alert: $('nav-alert'), scrim: $('nav-scrim'),
    mode: $('nav-mode'), add: $('project-new'), status: $('nav-status'), list: $('projects'), empty: $('nav-empty'), capacity: $('nav-capacity'),
    behind: [document.querySelector('.topbar'), $('main-col')],
    pDialog: $('project-dialog'), pForm: $('project-form'), pName: $('p-name'), pFolder: $('p-folder'), pCreate: $('p-create'),
    pCreateRow: $('p-create-row'), pError: $('p-error'), pCancel: $('p-cancel'), pSubmit: $('p-submit'),
    pBrowse: $('p-browse'), pBrowseStatus: $('p-browse-status'),
    rnDialog: $('rename-dialog'), rnForm: $('rename-form'), rnTitle: $('rn-title'), rnLabel: $('rn-label'), rnInput: $('rn-input'),
    rnError: $('rn-error'), rnCancel: $('rn-cancel'), rnSubmit: $('rn-submit'),
    rmDialog: $('remove-dialog'), rmForm: $('remove-form'), rmTitle: $('rm-title'), rmDetail: $('rm-detail'), rmHistoryRow: $('rm-history-row'),
    rmHistory: $('rm-history'), rmError: $('rm-error'), rmCancel: $('rm-cancel'), rmSubmit: $('rm-submit'),
  };
  const media = matchMedia(NARROW);
  let doc = null;
  let model = null;
  let key = '';
  let timer = 0;
  let inflight = null;
  let started = false;
  let wideOpen = store.get(OPEN_KEY) !== 'closed';
  let overlayOpen = false;
  let collapsed = new Set();
  try {
    collapsed = new Set(JSON.parse(store.get(COLLAPSED_KEY) ?? '[]').filter((x) => typeof x === 'string'));
  } catch { /* a broken setting starts with every project open */ }
  // which "..." rows are open: 'p:<project>' | 'c:<project>/<chat>'
  const openActions = new Set();
  let statuses = new Map();
  // dialog -> its submit action; one per dialog, so a close event that arrives late never clears a newer one
  const actions = new Map();
  let returnFocus = null;

  // ------------------------------------------------------------ open / collapse
  function visible() {
    return media.matches ? overlayOpen : wideOpen;
  }

  function syncOpen() {
    const show = started && Boolean(doc);
    e.nav.hidden = !show;
    e.toggle.hidden = !show;
    document.body.dataset.nav = !show ? 'none' : media.matches ? (overlayOpen ? 'overlay' : 'closed') : wideOpen ? 'open' : 'closed';
    const overlay = show && media.matches && overlayOpen;
    e.scrim.hidden = !overlay;
    // the narrow overlay is modal: the page behind it takes no focus or clicks until it closes
    for (const x of e.behind) if (x) x.inert = overlay;
    e.toggle.setAttribute('aria-expanded', String(show && visible()));
    e.toggleLabel.textContent = visible() ? 'Hide projects and chats' : 'Show projects and chats';
    const n = model?.attention ?? 0;
    // the list shows its own badges; the toggle carries them while the list is out of sight
    e.alert.hidden = !show || visible() || n === 0;
    e.alert.textContent = String(n);
    e.toggle.title = n && !visible() ? `${n} chat${n === 1 ? '' : 's'} in the background need${n === 1 ? 's' : ''} you` : '';
  }

  function setOpen(next, { focus = true } = {}) {
    if (media.matches) overlayOpen = next;
    else {
      wideOpen = next;
      store.set(OPEN_KEY, next ? 'open' : 'closed');
    }
    syncOpen();
    if (!focus) return;
    if (next) (e.list.querySelector('[aria-current="page"]') ?? e.nav.querySelector('a, button:not([hidden])'))?.focus();
    else e.toggle.focus();
  }

  e.toggle.addEventListener('click', () => setOpen(!visible()));
  e.scrim.addEventListener('click', () => setOpen(false));
  // Escape closes the overlay wherever focus is, unless a dialog above it takes the key for itself
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !media.matches || !overlayOpen || ev.defaultPrevented || document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    setOpen(false);
  });
  e.nav.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const items = [...e.list.querySelectorAll('.project-toggle, .chat-link')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))].focus();
    }
  });
  media.addEventListener('change', () => {
    overlayOpen = false;
    syncOpen();
  });

  // ------------------------------------------------------------ data
  function status(text, tone = '') {
    if (e.status.textContent === text && e.status.dataset.tone === tone) return;
    e.status.textContent = text;
    e.status.dataset.tone = tone;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, PROJECTS_POLL_MS);
  }

  // -> the parsed document, null (no projects API: an older server) or undefined (no answer)
  function refresh() {
    if (inflight) return inflight;
    clearTimeout(timer);
    inflight = getDoc('/api/projects').then(({ status: code, doc: answer }) => {
      inflight = null;
      const parsed = parseProjects(answer);
      if (started) schedule();
      if (!parsed) {
        if (started) status(code === 0 ? 'The server did not answer. Retrying...' : `The project list could not be loaded (HTTP ${code}).`, 'error');
        return code === 0 || code >= 500 ? undefined : null;
      }
      if (e.status.dataset.tone === 'error') status('');
      tellNews(parsed);
      doc = parsed;
      render();
      onProjects?.(doc);
      return doc;
    });
    return inflight;
  }

  // A background chat that starts waiting for a human is announced once.
  function tellNews(next) {
    const now = new Map();
    const here = getScope();
    for (const p of next.projects) {
      for (const c of p.chats) {
        const id = `${p.id}/${c.id}`;
        now.set(id, c.status);
        const was = statuses.get(id);
        if (doc && was !== undefined && was !== 'needs_human' && c.status === 'needs_human' && !(here?.project === p.id && here?.chat === c.id)) {
          announce?.(`${c.title} in ${p.name} needs you`);
        }
      }
    }
    statuses = now;
  }

  // ------------------------------------------------------------ rendering
  function actionsRow(id, kind, item, project) {
    const row = el('div', 'nav-actions');
    row.id = id;
    row.hidden = !openActions.has(id);
    // a single-mode server answers rename and remove with 409 single_mode, so it offers neither
    if (!model.single) {
      const rename = button('btn btn-small', 'Rename');
      rename.dataset.act = 'rename';
      row.append(rename);
      const remove = button('btn btn-small', 'Remove');
      remove.dataset.act = 'remove';
      if (item.removeBlock) {
        remove.setAttribute('aria-disabled', 'true');
        remove.title = item.removeBlock;
        const why = el('span', 'hint', item.removeBlock);
        row.append(remove, why);
      } else {
        row.append(remove);
      }
    }
    row.dataset.kind = kind;
    row.dataset.project = project.id;
    if (kind === 'chat') row.dataset.chat = item.id;
    return row;
  }

  function moreButton(id, label) {
    const b = button('icon-btn nav-more', '⋯', label);
    b.dataset.more = id;
    b.setAttribute('aria-controls', id);
    b.setAttribute('aria-expanded', String(openActions.has(id)));
    return b;
  }

  function chatItem(p, c) {
    const li = el('li', 'chat');
    li.dataset.status = c.status;
    li.dataset.current = String(c.current);
    const row = el('div', 'chat-row');
    const a = el('a', 'chat-link');
    a.href = hashFor({ project: p.id, chat: c.id });
    a.dataset.key = `c:${p.id}/${c.id}`;
    if (c.current) a.setAttribute('aria-current', 'page');
    a.title = `${c.title} · ${c.label}${c.runs ? ` · ${c.runs} run${c.runs === 1 ? '' : 's'}` : ''}`;
    const glyph = el('span', 'chat-glyph', c.glyph);
    glyph.setAttribute('aria-hidden', 'true');
    a.append(glyph, el('span', 'chat-title', c.title));
    if (c.status === 'needs_human') {
      const badge = el('span', 'badge chat-badge', 'needs you');
      if (c.attention) badge.dataset.tone = 'loud';
      a.append(badge);
    } else {
      a.append(el('span', 'sr-only', `, ${c.label}`));
    }
    row.append(a);
    li.append(row);
    if (!model.single) {
      const id = `nav-act-c-${p.id}-${c.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
      row.append(moreButton(id, `Actions for chat ${c.title}`));
      li.append(actionsRow(id, 'chat', c, p));
    }
    return li;
  }

  function projectItem(p) {
    const li = el('li', 'project');
    li.dataset.current = String(p.current);
    const row = el('div', 'project-row');
    const t = button('project-toggle');
    t.dataset.toggle = p.id;
    t.dataset.key = `p:${p.id}`;
    t.setAttribute('aria-expanded', String(p.expanded));
    t.title = p.workspace ? `${p.name}\n${p.workspace}` : p.name;
    const chev = el('span', 'project-chev', p.expanded ? '▾' : '▸');
    chev.setAttribute('aria-hidden', 'true');
    t.append(chev, el('span', 'project-name', p.name));
    if (p.waiting) {
      const badge = el('span', 'badge', `${p.waiting} need${p.waiting === 1 ? 's' : ''} you`);
      badge.dataset.tone = 'loud';
      t.append(badge);
    } else if (p.running) {
      t.append(el('span', 'project-count mono', `${p.running} running`));
    }
    row.append(t);
    if (model.canCreate) {
      const add = button('icon-btn nav-add', '+', `New chat in ${p.name}`);
      add.dataset.newChat = p.id;
      add.title = `New chat in ${p.name}`;
      row.append(add);
    }
    li.append(row);
    if (!model.single) {
      const id = `nav-act-p-${p.id}`;
      row.append(moreButton(id, `Actions for project ${p.name}`));
      li.append(actionsRow(id, 'project', p, p));
    }
    const ul = el('ul', 'chats');
    ul.hidden = !p.expanded;
    ul.setAttribute('aria-label', `Chats of ${p.name}`);
    if (p.chats.length) ul.append(...[...p.chats].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0)).map((c) => chatItem(p, c)));
    else ul.append(el('li', 'chat-none hint', 'No chats yet'));
    li.append(ul);
    return li;
  }

  function render() {
    model = sidebarModel(doc, getScope(), { collapsed });
    syncOpen();
    if (!model) return;
    e.mode.hidden = !model.single;
    e.add.hidden = !model.canCreate;
    e.capacity.textContent = capacityText(doc);
    e.empty.hidden = model.projects.length > 0;
    const next = JSON.stringify([model, [...openActions]]);
    if (next === key) return;
    key = next;
    // the list is rebuilt; focus stays on the same control
    const active = e.list.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.dataset.key ?? active?.dataset.more ?? null;
    const act = active?.dataset.act ? [active.closest('.nav-actions')?.id, active.dataset.act] : null;
    e.list.replaceChildren(...model.projects.map(projectItem));
    if (act?.[0]) document.getElementById(act[0])?.querySelector(`[data-act="${act[1]}"]`)?.focus();
    if (focusKey) e.list.querySelector(`[data-key="${CSS.escape(focusKey)}"], [data-more="${CSS.escape(focusKey)}"]`)?.focus();
  }

  e.list.addEventListener('click', (ev) => {
    const t = ev.target.closest('button[data-toggle]');
    if (t) {
      const id = t.dataset.toggle;
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      store.set(COLLAPSED_KEY, JSON.stringify([...collapsed]));
      render();
      return;
    }
    const more = ev.target.closest('button[data-more]');
    if (more) {
      const id = more.dataset.more;
      if (openActions.has(id)) openActions.delete(id);
      else openActions.add(id);
      render();
      return;
    }
    const add = ev.target.closest('button[data-new-chat]');
    if (add) return newChat(add.dataset.newChat);
    const act = ev.target.closest('button[data-act]');
    if (act) {
      const row = act.closest('.nav-actions');
      const target = { project: row.dataset.project, chat: row.dataset.chat ?? null };
      if (act.dataset.act === 'rename') return rename(row.dataset.kind, target);
      if (act.getAttribute('aria-disabled') === 'true') return status(act.title, 'error');
      return remove(row.dataset.kind, target);
    }
    // a chosen chat closes the overlay so the chat is visible
    if (ev.target.closest('a.chat-link') && media.matches) setOpen(false, { focus: false });
  });

  // ------------------------------------------------------------ dialogs
  function openDialog(dialog, action) {
    returnFocus = document.activeElement;
    actions.set(dialog, action);
    for (const b of dialog.querySelectorAll('button[type="submit"]')) b.disabled = false;
    dialog.showModal();
  }

  function closeDialog(dialog) {
    actions.delete(dialog);
    dialog.close();
  }

  for (const d of [e.pDialog, e.rnDialog, e.rmDialog]) {
    d.addEventListener('close', () => {
      if (d.open) return;
      actions.delete(d);
      const target = returnFocus;
      returnFocus = null;
      if (target?.isConnected && !target.hidden) target.focus();
    });
  }
  e.pCancel.addEventListener('click', () => closeDialog(e.pDialog));
  e.rnCancel.addEventListener('click', () => closeDialog(e.rnDialog));
  e.rmCancel.addEventListener('click', () => closeDialog(e.rmDialog));

  function formError(box, message) {
    box.textContent = message;
    box.hidden = !message;
  }

  async function submitDialog(ev, dialog, box, submit) {
    ev.preventDefault();
    const action = actions.get(dialog);
    if (!action || submit.disabled) return;
    formError(box, '');
    submit.disabled = true;
    const r = (await action()) ?? {};
    if (actions.get(dialog) === action) submit.disabled = false;
    if (r.error) formError(box, r.error);
  }

  e.pForm.addEventListener('submit', (ev) => submitDialog(ev, e.pDialog, e.pError, e.pSubmit));
  e.rnForm.addEventListener('submit', (ev) => submitDialog(ev, e.rnDialog, e.rnError, e.rnSubmit));
  e.rmForm.addEventListener('submit', (ev) => submitDialog(ev, e.rmDialog, e.rmError, e.rmSubmit));
  const syncCreate = () => {
    const empty = !e.pFolder.value.trim();
    e.pCreate.disabled = empty;
    e.pCreateRow.dataset.disabled = String(empty);
  };
  e.pFolder.addEventListener('input', syncCreate);
  e.pForm.addEventListener('input', (ev) => ev.target.removeAttribute?.('aria-invalid'));

  // the folder picker request still on its way; a closed or reopened dialog drops it, so its answer is ignored
  let picking = null;
  const pickNote = (text, tone = '') => {
    e.pBrowseStatus.textContent = text;
    e.pBrowseStatus.dataset.tone = tone;
  };
  const syncBrowse = () => {
    const can = Boolean(dialogInvoke());
    e.pBrowse.setAttribute('aria-disabled', String(!can || Boolean(picking)));
    e.pBrowse.title = can ? 'Choose the project folder' : 'Choosing a folder needs the desktop app';
  };
  syncBrowse();
  e.pDialog.addEventListener('close', () => {
    if (e.pDialog.open || !picking) return;
    picking = null;
    e.pSubmit.disabled = false;
    syncBrowse();
  });

  e.pBrowse.addEventListener('click', async () => {
    const invoke = dialogInvoke();
    // a submit on its way disables Create project; the picker waits for its answer too
    if (!e.pDialog.open || picking || e.pSubmit.disabled) return;
    if (!invoke) return pickNote('Choosing a folder needs the Scranton desktop app. Type the absolute path instead.');
    const ticket = {};
    picking = ticket;
    e.pSubmit.disabled = true;
    syncBrowse();
    pickNote('Waiting for the folder picker...', 'busy');
    const options = { directory: true, multiple: false, title: 'Choose project folder' };
    const current = e.pFolder.value.trim();
    if (current.length <= FOLDER_MAX && isAbsolutePath(current)) options.defaultPath = current;
    let result;
    let failed = null;
    try {
      result = await invoke('plugin:dialog|open', { options });
    } catch (err) {
      failed = { why: clip(typeof err === 'string' ? err : err?.message, 160) };
    }
    if (picking !== ticket) return;
    picking = null;
    e.pSubmit.disabled = false;
    syncBrowse();
    if (failed) {
      pickNote(`The folder picker did not open${failed.why ? ` (${failed.why})` : ''}. Type the absolute path instead.`, 'error');
      return e.pFolder.focus();
    }
    // cancelled: every field stays as it was
    if (result === null || result === undefined) {
      pickNote('');
      return e.pBrowse.focus();
    }
    if (typeof result !== 'string' || !result.trim()) {
      pickNote('The folder picker returned no folder. Type the absolute path instead.', 'error');
      return e.pFolder.focus();
    }
    // cut to the field's limit it would name another folder
    if (result.length > FOLDER_MAX) {
      pickNote(`The path of that folder has ${result.length} characters; at most ${FOLDER_MAX} fit. Choose a folder with a shorter path.`, 'error');
      return e.pBrowse.focus();
    }
    e.pFolder.value = result;
    syncCreate();
    if (e.pFolder.getAttribute('aria-invalid') === 'true') {
      e.pFolder.removeAttribute('aria-invalid');
      formError(e.pError, '');
    }
    pickNote('');
    e.pFolder.focus();
  });

  function newProject() {
    if (!model?.canCreate) return;
    e.pName.value = '';
    e.pFolder.value = '';
    e.pCreate.checked = true;
    syncCreate();
    picking = null;
    syncBrowse();
    pickNote('');
    formError(e.pError, '');
    for (const f of [e.pName, e.pFolder]) f.removeAttribute('aria-invalid');
    openDialog(e.pDialog, async () => {
      const built = buildProject({ name: e.pName.value, workspace: e.pFolder.value, create: e.pCreate.checked });
      let error = built.error;
      let field = built.field;
      if (!error) {
        const r = await postJson('/api/projects', built.body);
        if (r.ok) {
          const id = r.data?.project?.id;
          closeDialog(e.pDialog);
          await refresh();
          if (typeof id === 'string' && findProject(doc, id)) {
            navigate({ project: id, chat: null });
            announce?.(`Project ${findProject(doc, id).name} created`);
          }
          return {};
        }
        error = projectError(r.status, r.data);
        field = r.status === 400 || r.status === 409 ? projectErrorField(r.data?.error ?? '') : null;
      }
      const input = field === 'name' ? e.pName : field === 'workspace' ? e.pFolder : null;
      input?.setAttribute('aria-invalid', 'true');
      input?.focus();
      return { error };
    });
    e.pName.focus();
  }
  e.add.addEventListener('click', newProject);

  function rename(kind, target) {
    const p = findProject(doc, target.project);
    const c = kind === 'chat' ? findChat(doc, target) : null;
    if (!p || (kind === 'chat' && !c) || doc.mode === 'single') return;
    e.rnTitle.textContent = kind === 'project' ? 'Rename project' : 'Rename chat';
    e.rnLabel.textContent = kind === 'project' ? 'Name' : 'Title';
    e.rnInput.maxLength = kind === 'project' ? 80 : 120;
    e.rnInput.value = kind === 'project' ? p.name : c.title;
    formError(e.rnError, '');
    openDialog(e.rnDialog, async () => {
      const built = buildRename(kind, { id: kind === 'project' ? p.id : c.id, value: e.rnInput.value });
      if (built.error) return { error: built.error };
      const url = kind === 'project' ? '/api/projects/rename' : `/api/projects/${enc(p.id)}/chats/rename`;
      const r = await postJson(url, built.body);
      if (!r.ok) return { error: projectError(r.status, r.data) };
      closeDialog(e.rnDialog);
      announce?.(`Renamed to ${e.rnInput.value.trim()}`);
      await refresh();
      return {};
    });
    e.rnInput.select();
  }

  function remove(kind, target) {
    const p = findProject(doc, target.project);
    const c = kind === 'chat' ? findChat(doc, target) : null;
    if (!p || (kind === 'chat' && !c) || model.single) return;
    const block = kind === 'project' ? model.projects.find((x) => x.id === p.id)?.removeBlock : model.projects.find((x) => x.id === p.id)?.chats.find((x) => x.id === c.id)?.removeBlock;
    if (block) return status(block, 'error');
    e.rmTitle.textContent = kind === 'project' ? `Remove project ${p.name}?` : `Remove chat ${c.title}?`;
    e.rmDetail.textContent = kind === 'project'
      ? `${p.name} leaves the project list. Its folder${p.workspace ? ` ${p.workspace}` : ''} and every file in it stay exactly as they are.`
      : 'The chat and its run history leave this project. Files the agents wrote into the project folder stay as they are.';
    e.rmHistoryRow.hidden = kind !== 'project';
    e.rmHistory.checked = false;
    e.rmSubmit.textContent = kind === 'project' ? 'Remove project' : 'Remove chat';
    formError(e.rmError, '');
    openDialog(e.rmDialog, async () => {
      const built = buildRemove(kind, { id: kind === 'project' ? p.id : c.id, deleteHistory: e.rmHistory.checked });
      const url = kind === 'project' ? '/api/projects/remove' : `/api/projects/${enc(p.id)}/chats/remove`;
      const r = await postJson(url, built.body);
      if (!r.ok) {
        refresh();
        return { error: projectError(r.status, r.data) };
      }
      returnFocus = e.add.hidden ? e.toggle : e.add;
      closeDialog(e.rmDialog);
      openActions.clear();
      announce?.(kind === 'project' ? `Project ${p.name} removed` : `Chat ${c.title} removed`);
      await refresh();
      return {};
    });
    e.rmCancel.focus();
  }

  // + New chat: the New run drawer, and the run starts in a chat made for it. The chat is created on the first
  // submit and reused if that run is refused (429), and removed again when the drawer closes after a refusal.
  function newChat(projectId) {
    const p = findProject(doc, projectId);
    if (!p || !model?.canCreate) return;
    let chatId = null;
    // a chat's engine is fixed when it is created: 'team' | 'pipeline'
    let chatEngine = null;
    let ran = false;
    // the answer to the last run POST, and the submit still on its way
    let last = null;
    let pending = null;
    const attempt = (engine, body) => {
      const a = startIn(engine, body);
      pending = a;
      return a.finally(() => { if (pending === a) pending = null; });
    };
    // Removes the chat only when the server certainly refused its run and it still has no history: a POST
    // without an answer (status 0) may have started the run anyway.
    async function dropRefused() {
      if (!chatId || ran || !last || last.ok || last.status < 400 || last.status >= 500) return;
      const fresh = await getDoc('/api/projects');
      const c = findChat(parseProjects(fresh.doc), { project: p.id, chat: chatId });
      if (c && c.runs === 0 && c.status === 'idle') await postJson(`/api/projects/${enc(p.id)}/chats/remove`, { id: chatId });
    }
    openRun({
      target: {
        title: `New chat in ${p.name}`,
        workspace: p.workspace || null,
        project: p.id,
        start: (body) => attempt('team', body),
        startPipeline: (body) => attempt('pipeline', body),
        async cancel() {
          await pending;
          await dropRefused();
          refresh();
        },
      },
    });

    async function startIn(engine, body) {
      // refused in one engine, then started in the other: the empty chat of the first one goes
      if (chatId && chatEngine !== engine) {
        await dropRefused();
        chatId = null;
        last = null;
      }
      if (!chatId) {
        const title = engine === 'pipeline'
          ? titleFromGoal(body.task ?? '') || 'Pipeline run'
          : titleFromGoal(body.request ?? '') || `Demo: ${body.demo?.scenario ?? 'run'}`;
        const c = await postJson(`/api/projects/${enc(p.id)}/chats`, engine === 'pipeline' ? { title, engine } : { title });
        if (!c.ok) return { ...c, error: projectError(c.status, c.data) };
        chatId = typeof c.data?.chat?.id === 'string' ? c.data.chat.id : null;
        if (!chatId) return { ok: false, status: 0, error: 'The server did not return the new chat.' };
        chatEngine = engine;
      }
      const r = await postJson(scopedUrl({ project: p.id, chat: chatId }, engine === 'pipeline' ? 'pipeline/runs' : 'runs'), body);
      last = r;
      if (r.ok) {
        ran = true;
        await refresh();
        navigate({ project: p.id, chat: chatId });
      }
      return r;
    }
  }

  // ------------------------------------------------------------ api
  return {
    // first load: null = no projects API (an older server or no control), so the page stays single-hive
    async start() {
      const first = await refresh();
      if (first === null || first === undefined) return null;
      started = true;
      syncOpen();
      schedule();
      return first;
    },
    refresh,
    render,
    doc: () => doc,
    newProject,
    newChat,
    rename,
    statusLabel: (s) => CHAT_STATUS[s]?.label ?? s,
  };
}
