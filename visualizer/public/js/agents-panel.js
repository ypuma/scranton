// The Agents drawer behind the top-bar button: one row per agent (built-in and custom) with its keywords, tools,
// model and prompt source, and three forms that open in place one at a time: the prompt editor, an agent's
// settings (model, thinking, handoff instruction; for a custom agent also its name, title, keywords and tools)
// and New agent. Invisible unless the control API is on and the server answers GET /api/agents. Prompt text is
// held only while the drawer is open; it is never stored or logged here.
import {
  AGENTS_URL, PROMPT_MAX_BYTES, INSTRUCTION_MAX, CUSTOM_MAX, parseAgents, promptUrl, agentUrl, utf8Bytes, missingKeywords, missingNote,
  roleView, buildPrompt, isDirty, resetConfirm, discardConfirm, discardSettingsConfirm, deleteConfirm, promptError, probeDelay,
  defaultKeywords, idProblem, buildNewAgent, buildAgentPatch, modelValueKey, instructionText, canResetInstruction, agentErrorField, agentError,
  customCount, formTools, THINKING_LEVELS,
} from './agents.js';
import { parseModels, modelGroups, AUTOMATIC } from './accounts.js';
import { sendJson } from './control-panel.js';
import { getJson, fillModelSelect } from './accounts-panel.js';
import { stripBidi } from './format.js';

const $ = (id) => document.getElementById(id);
const lines = (t) => String(t ?? '').replace(/\r\n?/g, '\n');
const capital = (t) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// the server's own words for a refused request; the run-state wording of sendJson does not fit here
const serverMessage = (res) => (typeof res.data?.error === 'string' ? res.data.error : res.status ? '' : res.error);

// confirm: the shared confirm dialog of the control panel ({ title, detail, ok, action } -> action() { error } | { focus })
// onChange: an agent was created, changed or deleted (the New run drawer lists the gates)
export function createAgentsPanel({ getControl, confirm, onChange = () => {} }) {
  const e = {
    open: $('agents-open'), dialog: $('agents-dialog'), error: $('agents-error'), status: $('agents-status'), empty: $('agents-empty'),
    list: $('agents-list'), foot: $('agents-foot'), warnings: $('agents-warnings'),
    form: $('prompt-panel'), title: $('prompt-title'), count: $('prompt-count'), note: $('prompt-note'), text: $('prompt-text'),
    warning: $('prompt-warning'), formError: $('prompt-error'), formStatus: $('prompt-status'),
    reset: $('prompt-reset'), cancel: $('prompt-cancel'), save: $('prompt-save'),
    createRow: $('create-row'), createOpen: $('create-open'), createLimit: $('create-limit'),
    cForm: $('create-panel'), cId: $('create-id'), cIdHint: $('create-id-hint'), cName: $('create-name'), cTitle: $('create-role-title'),
    cPass: $('create-pass'), cFail: $('create-fail'), cIns: $('create-instruction'), cCount: $('create-instruction-count'),
    cTools: { read: $('create-tool-read'), grep: $('create-tool-grep'), find: $('create-tool-find'), ls: $('create-tool-ls'), bash: $('create-tool-bash') },
    cModel: $('create-model'), cThinking: $('create-thinking'), cError: $('create-error'), cStatus: $('create-status'),
    cCancel: $('create-cancel'), cSubmit: $('create-submit'),
    sForm: $('settings-panel'), sTitle: $('settings-title'), sIdentity: $('settings-identity'), sName: $('settings-name'),
    sRoleTitle: $('settings-role-title'), sPass: $('settings-pass'), sFail: $('settings-fail'),
    sTools: { read: $('settings-tool-read'), grep: $('settings-tool-grep'), find: $('settings-tool-find'), ls: $('settings-tool-ls'), bash: $('settings-tool-bash') },
    sModel: $('settings-model'), sModelNote: $('settings-model-note'), sThinking: $('settings-thinking'), sThinkingNote: $('settings-thinking-note'),
    sInsRow: $('settings-instruction-row'), sIns: $('settings-instruction'), sInsReset: $('settings-instruction-reset'), sInsCount: $('settings-instruction-count'),
    sError: $('settings-error'), sStatus: $('settings-status'), sDelete: $('settings-delete'), sCancel: $('settings-cancel'), sSave: $('settings-save'),
  };
  const cIdHintDefault = e.cIdHint.textContent;
  // the inputs a server message can be about
  const SETTINGS_FIELDS = {
    model: e.sModel, thinking: e.sThinking, instruction: e.sIns, name: e.sName, title: e.sRoleTitle, passKeyword: e.sPass, failKeyword: e.sFail,
    tools: e.sTools.read,
  };
  const CREATE_FIELDS = {
    id: e.cId, name: e.cName, title: e.cTitle, passKeyword: e.cPass, failKeyword: e.cFail, instruction: e.cIns, tools: e.cTools.read,
    model: e.cModel, thinking: e.cThinking,
  };
  // 'unknown' until the first answer, 'no' when the server has no /api/agents
  let support = 'unknown';
  let wasOn = false;
  // the roles document while the drawer is open, null otherwise
  let doc = null;
  let loading = null;
  // GET /api/models while the drawer is open: the options of the model selects (null: Automatic only)
  let catalog = null;
  // what is open: the prompt editor of a role, the settings of a role, or New agent; at most one of them
  let editing = null;
  let settingsFor = null;
  let creating = false;
  // the forms as they were opened, to tell an edit from nothing
  let settingsSnap = '';
  let createSnap = '';
  let busy = false;
  // bumped whenever a form opens, closes or the drawer closes: a reply for an older one is dropped
  let gen = 0;
  let probeTimer = 0;
  let probeAttempt = 0;
  let opener = null;
  const rows = new Map();

  const on = () => Boolean(getControl()?.gates.on);
  const role = (id) => doc?.roles.find((r) => r.id === id) ?? null;
  const tools = (boxes) => Object.entries(boxes).filter(([, b]) => b.checked).map(([t]) => t);
  const readSettings = () => ({
    model: e.sModel.value, thinking: e.sThinking.value, instruction: lines(e.sIns.value), name: e.sName.value, title: e.sRoleTitle.value,
    passKeyword: e.sPass.value, failKeyword: e.sFail.value, tools: tools(e.sTools),
  });
  const readCreate = () => ({
    id: e.cId.value, name: e.cName.value, title: e.cTitle.value, passKeyword: e.cPass.value, failKeyword: e.cFail.value,
    instruction: lines(e.cIns.value), tools: tools(e.cTools), model: e.cModel.value, thinking: e.cThinking.value,
  });
  const promptDirty = () => Boolean(editing) && isDirty(role(editing), e.text.value);
  const settingsDirty = () => Boolean(settingsFor) && JSON.stringify(readSettings()) !== settingsSnap;
  const createDirty = () => creating && JSON.stringify(readCreate()) !== createSnap;
  const dirty = () => promptDirty() || settingsDirty() || createDirty();
  // the roles document's own list, else the one GET /api/control reports, else the engine's of today
  const levels = () => doc?.thinkingLevels ?? getControl()?.control?.thinkingLevels ?? THINKING_LEVELS;

  function setText(node, text, tone) {
    if (node.textContent !== text) node.textContent = text;
    if (tone !== undefined && node.dataset.tone !== tone) node.dataset.tone = tone;
  }

  function showError(node, text) {
    node.textContent = text;
    node.hidden = !text;
  }

  // a check that failed: the message in the form, the field it is about marked and focused
  function fieldError(node, { error, field }, fields) {
    showError(node, error);
    const input = fields[field];
    if (!input) return;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  // ------------------------------------------------------------ server
  // Only an open drawer holds the document; the probe for the button drops the prompt texts at once.
  function load() {
    if (loading) return loading;
    loading = getJson(AGENTS_URL).then((answer) => {
      loading = null;
      if (answer === null) {
        support = 'no';
        doc = null;
        probeAttempt = 0;
      } else if (answer !== undefined && parseAgents(answer)) {
        support = 'yes';
        probeAttempt = 0;
        doc = e.dialog.open ? parseAgents(answer) : null;
        if (e.dialog.open) showError(e.error, '');
      } else if (e.dialog.open) {
        showError(e.error, 'The agents could not be loaded. Close and open the drawer to try again.');
      }
      // no definitive answer yet (network error, 5xx): ask again, like the Accounts panel, until there is one
      if (support === 'unknown' && on()) {
        clearTimeout(probeTimer);
        probeTimer = setTimeout(() => {
          if (support === 'unknown' && on()) load();
        }, probeDelay(probeAttempt++));
      }
      render();
    });
    return loading;
  }

  // The model list of the New run drawer, for the model selects here; without it only Automatic is offered.
  function loadModels() {
    return getJson('/api/models').then((answer) => {
      const next = answer ? parseModels(answer) : null;
      if (!e.dialog.open || !next) return;
      catalog = next;
      fillModel(e.sModel, e.sModel.value, role(settingsFor)?.model.value ?? null);
      fillModel(e.cModel, e.cModel.value, null);
    });
  }

  // current: the model the server reports, offered even when the list does not have it (any more)
  function fillModel(select, value, current) {
    const groups = modelGroups(catalog);
    fillModelSelect(select, groups, AUTOMATIC);
    if (value && !groups.some((g) => g.options.some((o) => o.value === value)) && current) {
      const opt = el('option', '', `${stripBidi(current.provider)}/${stripBidi(current.model)} (not in the model list)`);
      opt.value = value;
      select.append(opt);
    }
    select.value = value;
  }

  function fillThinking(select, value) {
    const list = levels().includes(value) || !value ? levels() : [...levels(), value];
    const def = el('option', '', AUTOMATIC);
    def.value = '';
    select.replaceChildren(def, ...list.map((l) => {
      const opt = el('option', '', l);
      opt.value = l;
      return opt;
    }));
    select.value = value;
  }

  // ------------------------------------------------------------ rendering
  function render() {
    if (!on()) {
      // nothing can be saved without control: the drawer closes, unsaved text included
      if (e.dialog.open) e.dialog.close();
      if (wasOn) support = 'unknown';
      wasOn = false;
      clearTimeout(probeTimer);
      probeAttempt = 0;
      e.open.hidden = true;
      return;
    }
    if (!wasOn) {
      wasOn = true;
      load();
    }
    e.open.hidden = support !== 'yes';
    if (e.dialog.open) renderDrawer();
  }

  function renderDrawer() {
    const empty = doc ? '' : support === 'no' ? 'This server does not offer agent settings.' : loading ? 'Loading agents...' : '';
    setText(e.empty, empty);
    e.empty.hidden = !empty;
    e.list.hidden = !doc;
    renderWarnings();
    const ids = new Set(doc?.roles.map((r) => r.id) ?? []);
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.li.remove();
      rows.delete(id);
    }
    for (const r of doc?.roles ?? []) renderRow(r);
    // a role deleted elsewhere takes its open form with it
    if (editing && !role(editing)) closeEditor({ force: true });
    if (settingsFor && !role(settingsFor)) closeSettings({ force: true });
    renderEditor();
    renderSettings();
    renderCreate();
    setText(e.foot, dirty() ? 'Unsaved changes' : '');
  }

  // agents.json entries the server skipped: said once, under the status line, never announced
  function renderWarnings() {
    const list = doc?.warnings ?? [];
    const key = JSON.stringify(list);
    if (e.warnings.dataset.key === key) return;
    e.warnings.dataset.key = key;
    e.warnings.replaceChildren(...list.map((w) => el('li', '', w)));
    e.warnings.hidden = !list.length;
  }

  function renderRow(r) {
    let row = rows.get(r.id);
    if (!row) {
      const li = el('li', 'account role-row');
      const head = el('div', 'account-head');
      const name = el('span', 'account-name');
      const title = el('span', 'role-title');
      const source = el('span', 'badge role-source');
      const kind = el('span', 'role-kind');
      head.append(name, title, source, kind);
      const detail = el('div', 'role-detail');
      // what the agent does, and the id that config files and the CLI know it by
      const about = el('span', 'role-about');
      const does = el('span', 'role-does');
      const id = el('span', 'agent-id');
      id.append('id ', el('code', '', r.id));
      about.append(does, id);
      const keywords = el('span', 'role-keywords');
      const toolsLine = el('span', 'role-tools mono');
      const model = el('span', 'role-model');
      detail.append(about, keywords, toolsLine, model);
      const actions = el('div', 'account-actions');
      const edit = el('button', 'btn btn-small');
      edit.type = 'button';
      edit.setAttribute('aria-controls', 'prompt-panel');
      edit.addEventListener('click', () => toggleEditor(r.id));
      const settings = el('button', 'btn btn-small', 'Settings');
      settings.type = 'button';
      settings.setAttribute('aria-controls', 'settings-panel');
      settings.addEventListener('click', () => toggleSettings(r.id));
      actions.append(edit, settings);
      li.append(head, detail, actions);
      e.list.append(li);
      row = { li, name, title, does, source, kind, keywords, tools: toolsLine, model, edit, settings };
      rows.set(r.id, row);
    }
    const v = roleView(r);
    row.li.dataset.source = r.prompt.source;
    row.li.dataset.builtin = String(r.builtin);
    setText(row.name, r.name);
    setText(row.title, r.title);
    setText(row.does, r.description ? `${r.description} ` : '');
    setText(row.source, v.source, v.sourceTone);
    setText(row.kind, v.kind);
    row.keywords.replaceChildren(...r.keywords.map((k) => el('span', 'kw-chip mono', k)));
    row.keywords.setAttribute('aria-label', `Keywords ${r.keywords.join(', ')}`);
    setText(row.tools, v.tools);
    row.tools.title = v.tools ? `Tools: ${v.tools}` : '';
    setText(row.model, v.model);
    row.model.title = `Model: ${v.model}`;
    setText(row.edit, v.action);
    row.edit.setAttribute('aria-label', `${v.action} of ${r.inText}`);
    row.edit.setAttribute('aria-expanded', String(editing === r.id));
    row.edit.disabled = busy;
    row.settings.setAttribute('aria-label', `Settings of ${r.inText}`);
    row.settings.setAttribute('aria-expanded', String(settingsFor === r.id));
    row.settings.disabled = busy;
  }

  function renderEditor() {
    e.form.hidden = !editing;
    const r = role(editing);
    if (!r) return;
    const v = roleView(r);
    const editable = r.prompt.editable;
    setText(e.title, `${capital(r.inText)}'s system prompt`);
    e.text.readOnly = !editable;
    const bytes = utf8Bytes(e.text.value);
    setText(e.count, editable ? `${bytes} / ${PROMPT_MAX_BYTES} bytes` : `${bytes} bytes`, bytes > PROMPT_MAX_BYTES ? 'error' : '');
    setText(e.note, v.note);
    e.note.hidden = !v.note;
    // the server's list for the saved text, the editor's own check for a draft
    const missing = promptDirty() ? missingKeywords(e.text.value, r.keywords) : r.prompt.missingKeywords;
    const warn = missingNote(missing);
    setText(e.warning, warn);
    e.warning.hidden = !warn;
    e.save.hidden = !editable;
    e.save.disabled = busy || !promptDirty();
    e.reset.hidden = !editable || r.prompt.source !== 'custom';
    setText(e.reset, r.builtin ? 'Reset to built-in' : 'Reset to starter');
    e.reset.disabled = busy;
    e.cancel.disabled = busy;
    setText(e.cancel, editable ? 'Cancel' : 'Close');
    e.text.disabled = busy;
  }

  function renderSettings() {
    e.sForm.hidden = !settingsFor;
    const r = role(settingsFor);
    if (!r) return;
    e.sModel.disabled = busy || r.model.pinned;
    e.sThinking.disabled = busy || r.thinking.pinned;
    for (const input of [e.sName, e.sRoleTitle, e.sPass, e.sFail, e.sIns, ...Object.values(e.sTools)]) input.disabled = busy;
    const n = lines(e.sIns.value).length;
    setText(e.sInsCount, `${n} / ${INSTRUCTION_MAX}`, n > INSTRUCTION_MAX ? 'error' : '');
    e.sInsReset.hidden = !r.gate || !canResetInstruction(r, e.sIns.value);
    e.sDelete.hidden = r.builtin;
    e.sDelete.disabled = busy;
    e.sCancel.disabled = busy;
    e.sSave.disabled = busy || !settingsDirty();
  }

  function renderCreate() {
    const count = customCount(doc?.roles);
    const full = count >= CUSTOM_MAX;
    e.createRow.hidden = !doc;
    e.createOpen.disabled = busy || full;
    e.createOpen.setAttribute('aria-expanded', String(creating));
    setText(e.createLimit, full ? `${CUSTOM_MAX} custom agents is the most there can be. Delete one to add another.` : '');
    e.createLimit.hidden = !full;
    e.cForm.hidden = !creating;
    if (!creating) return;
    const d = defaultKeywords(e.cId.value);
    e.cPass.placeholder = d.pass;
    e.cFail.placeholder = d.fail;
    const n = lines(e.cIns.value).length;
    setText(e.cCount, `${n} / ${INSTRUCTION_MAX}`, n > INSTRUCTION_MAX ? 'error' : '');
    e.cSubmit.disabled = busy;
    e.cCancel.disabled = busy;
  }

  // The id is checked as it is typed, once there is something to check.
  function checkId() {
    const typed = e.cId.value.trim();
    const problem = typed ? idProblem(typed, doc?.roles ?? []) : '';
    setText(e.cIdHint, problem || cIdHintDefault, problem ? 'error' : '');
    if (problem) e.cId.setAttribute('aria-invalid', 'true');
    else e.cId.removeAttribute('aria-invalid');
  }

  // ------------------------------------------------------------ one form at a time
  // Runs next() at once, or after the human agreed to drop unsaved edits.
  function guard(next) {
    if (!dirty()) return next();
    const ask = promptDirty() ? discardConfirm(role(editing)) : discardSettingsConfirm(settingsFor ? role(settingsFor) : null);
    confirm({
      ...ask,
      action: () => {
        e.text.value = '';
        const target = next() ?? null;
        return { focus: target };
      },
    });
    return undefined;
  }

  // the form that is open goes without a question (the human was asked already, or nothing is lost)
  function closeOthers(keep) {
    if (keep !== 'prompt') closeEditor({ force: true, focus: false });
    if (keep !== 'settings') closeSettings({ force: true, focus: false });
    if (keep !== 'create') closeCreate({ force: true, focus: false });
  }

  // ------------------------------------------------------------ prompt editor
  function toggleEditor(id) {
    if (busy) return;
    if (editing === id) return closeEditor();
    guard(() => openEditor(id));
  }

  function openEditor(id) {
    const r = role(id);
    if (!r) return null;
    closeOthers('prompt');
    gen += 1;
    editing = id;
    e.text.value = r.prompt.text;
    showError(e.formError, '');
    setText(e.formStatus, '', '');
    rows.get(id).li.append(e.form);
    renderDrawer();
    e.text.focus();
    return e.text;
  }

  // force: no question about unsaved edits (they were saved, reset or cannot be kept)
  function closeEditor({ force = false, focus = true } = {}) {
    if (!editing) return null;
    if (!force && dirty()) {
      guard(() => closeEditor({ force: true, focus }));
      return null;
    }
    const id = editing;
    gen += 1;
    editing = null;
    e.text.value = '';
    showError(e.formError, '');
    e.form.hidden = true;
    e.list.after(e.form);
    if (e.dialog.open) renderDrawer();
    const button = rows.get(id)?.edit ?? null;
    if (focus && button) button.focus();
    return button;
  }

  e.cancel.addEventListener('click', () => closeEditor());
  e.text.addEventListener('input', () => {
    e.text.removeAttribute('aria-invalid');
    showError(e.formError, '');
    renderDrawer();
  });
  e.text.addEventListener('keydown', (ev) => {
    // Escape leaves the editor first, not the whole drawer
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation?.();
      closeEditor();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      e.form.requestSubmit();
    }
  });

  e.form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = role(editing);
    if (busy || !r || !promptDirty()) return;
    const built = buildPrompt(e.text.value, r);
    if (built.error) {
      showError(e.formError, built.error);
      e.text.setAttribute('aria-invalid', 'true');
      e.text.focus();
      return;
    }
    busy = true;
    const at = gen;
    setText(e.formStatus, 'Saving...', 'busy');
    renderDrawer();
    const res = await sendJson('PUT', promptUrl(r.id), built.body);
    // closed (and maybe reopened on another prompt) meanwhile: this reply belongs to an editor that is gone; a
    // reopened drawer only gets its rows refreshed, its editor is left alone
    if (at !== gen || !e.dialog.open) {
      if (res.ok && e.dialog.open) load();
      return;
    }
    busy = false;
    setText(e.formStatus, '', '');
    if (!res.ok) {
      showError(e.formError, promptError(res.status, res.error, r));
      renderDrawer();
      e.text.setAttribute('aria-invalid', 'true');
      e.text.focus();
      return;
    }
    await load();
    if (at !== gen || !e.dialog.open) return;
    const button = closeEditor({ force: true, focus: false });
    setText(e.status, `Saved ${r.inText}'s prompt. Runs started from now on use it.`);
    (button ?? e.status).focus();
  });

  e.reset.addEventListener('click', () => {
    const r = role(editing);
    if (busy || !r) return;
    confirm({
      ...resetConfirm(r),
      action: async () => {
        busy = true;
        const at = gen;
        renderDrawer();
        const res = await sendJson('DELETE', promptUrl(r.id));
        if (at !== gen || !e.dialog.open) {
          if (res.ok && e.dialog.open) load();
          return {};
        }
        busy = false;
        if (!res.ok) {
          renderDrawer();
          return { error: promptError(res.status, res.error, r) };
        }
        await load();
        if (at !== gen || !e.dialog.open) return {};
        const button = closeEditor({ force: true, focus: false });
        setText(e.status, `${capital(r.inText)}'s prompt is the ${r.builtin ? 'built-in' : 'starter'} one again.`);
        return { focus: button ?? e.status };
      },
    });
  });

  // ------------------------------------------------------------ settings
  function toggleSettings(id) {
    if (busy) return;
    if (settingsFor === id) return closeSettings();
    guard(() => openSettings(id));
  }

  // pinned: { source } of a field set by scranton.config.json or the environment
  function pinnedNote(r, what, field) {
    if (!field.pinned) return '';
    return field.source === 'env'
      ? `Set by env (SCRANTON_${r.id.toUpperCase()}_${what.toUpperCase()}), so it is read only here.`
      : `Set by config (agents.${r.id}.${what} in scranton.config.json), so it is read only here.`;
  }

  function openSettings(id) {
    const r = role(id);
    if (!r) return null;
    closeOthers('settings');
    gen += 1;
    settingsFor = id;
    setText(e.sTitle, `${capital(r.inText)}'s settings`);
    e.sIdentity.hidden = r.builtin;
    const d = defaultKeywords(r.id);
    e.sName.value = r.builtin ? '' : r.name;
    e.sRoleTitle.value = r.builtin ? '' : r.title;
    e.sPass.value = r.builtin ? '' : r.passKeyword ?? d.pass;
    e.sFail.value = r.builtin ? '' : r.failKeyword ?? d.fail;
    const boxes = r.builtin ? [] : formTools(r);
    for (const [t, box] of Object.entries(e.sTools)) box.checked = boxes.includes(t);
    fillModel(e.sModel, modelValueKey(r), r.model.value);
    fillThinking(e.sThinking, r.thinking.value ?? '');
    const modelNote = pinnedNote(r, 'model', r.model);
    setText(e.sModelNote, modelNote);
    e.sModelNote.hidden = !modelNote;
    const thinkingNote = pinnedNote(r, 'thinking', r.thinking);
    setText(e.sThinkingNote, thinkingNote);
    e.sThinkingNote.hidden = !thinkingNote;
    e.sInsRow.hidden = !r.gate;
    e.sIns.value = r.gate ? instructionText(r) : '';
    for (const input of Object.values(SETTINGS_FIELDS)) input.removeAttribute('aria-invalid');
    showError(e.sError, '');
    setText(e.sStatus, '', '');
    settingsSnap = JSON.stringify(readSettings());
    rows.get(id).li.append(e.sForm);
    renderDrawer();
    const first = !r.builtin ? e.sName : !r.model.pinned ? e.sModel : r.gate ? e.sIns : e.sCancel;
    first.focus();
    return first;
  }

  function closeSettings({ force = false, focus = true } = {}) {
    if (!settingsFor) return null;
    if (!force && dirty()) {
      guard(() => closeSettings({ force: true, focus }));
      return null;
    }
    const id = settingsFor;
    gen += 1;
    settingsFor = null;
    e.sIns.value = '';
    showError(e.sError, '');
    e.sForm.hidden = true;
    e.cForm.after(e.sForm);
    if (e.dialog.open) renderDrawer();
    const button = rows.get(id)?.settings ?? null;
    if (focus && button) button.focus();
    return button;
  }

  e.sCancel.addEventListener('click', () => closeSettings());
  e.sInsReset.addEventListener('click', () => {
    const r = role(settingsFor);
    if (busy || !r?.defaultInstruction) return;
    e.sIns.value = r.defaultInstruction;
    renderDrawer();
    e.sIns.focus();
  });

  e.sForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = role(settingsFor);
    if (busy || !r) return;
    const built = buildAgentPatch(readSettings(), r, doc.roles, levels());
    if (built.error) return fieldError(e.sError, built, SETTINGS_FIELDS);
    if (!Object.keys(built.body).length) return closeSettings({ force: true });
    busy = true;
    const at = gen;
    setText(e.sStatus, 'Saving...', 'busy');
    renderDrawer();
    const res = await sendJson('PATCH', agentUrl(r.id), built.body);
    if (res.ok) onChange();
    if (at !== gen || !e.dialog.open) {
      if (res.ok && e.dialog.open) load();
      return;
    }
    busy = false;
    setText(e.sStatus, '', '');
    if (!res.ok) {
      const msg = serverMessage(res);
      renderDrawer();
      fieldError(e.sError, { error: agentError(res.status, msg, r), field: agentErrorField(msg, Object.keys(SETTINGS_FIELDS)) }, SETTINGS_FIELDS);
      return;
    }
    await load();
    if (at !== gen || !e.dialog.open) return;
    const button = closeSettings({ force: true, focus: false });
    setText(e.status, `Saved ${r.inText}'s settings. Runs started from now on use them.`);
    (button ?? e.status).focus();
  });

  e.sDelete.addEventListener('click', () => {
    const r = role(settingsFor);
    if (busy || !r || r.builtin) return;
    confirm({
      ...deleteConfirm(r),
      action: async () => {
        busy = true;
        const at = gen;
        renderDrawer();
        const res = await sendJson('DELETE', agentUrl(r.id));
        if (res.ok) onChange();
        if (at !== gen || !e.dialog.open) {
          if (res.ok && e.dialog.open) load();
          return {};
        }
        busy = false;
        if (!res.ok) {
          renderDrawer();
          return { error: agentError(res.status, serverMessage(res), r) };
        }
        // closed first: the reload would close the form of the agent that is gone and look like a newer request
        closeSettings({ force: true, focus: false });
        const after = gen;
        await load();
        if (after !== gen || !e.dialog.open) return {};
        setText(e.status, `Deleted ${r.name}. Runs started from now on cannot use it.`);
        return { focus: e.createOpen.hidden || e.createOpen.disabled ? e.status : e.createOpen };
      },
    });
  });

  // ------------------------------------------------------------ new agent
  function openCreate() {
    if (!doc || customCount(doc.roles) >= CUSTOM_MAX) return null;
    closeOthers('create');
    gen += 1;
    creating = true;
    for (const input of [e.cId, e.cName, e.cTitle, e.cPass, e.cFail, e.cIns]) input.value = '';
    for (const box of Object.values(e.cTools)) box.checked = true;
    fillModel(e.cModel, '', null);
    fillThinking(e.cThinking, '');
    for (const input of Object.values(CREATE_FIELDS)) input.removeAttribute('aria-invalid');
    setText(e.cIdHint, cIdHintDefault, '');
    showError(e.cError, '');
    setText(e.cStatus, '', '');
    createSnap = JSON.stringify(readCreate());
    renderDrawer();
    e.cId.focus();
    return e.cId;
  }

  function closeCreate({ force = false, focus = true } = {}) {
    if (!creating) return null;
    if (!force && dirty()) {
      guard(() => closeCreate({ force: true, focus }));
      return null;
    }
    gen += 1;
    creating = false;
    e.cIns.value = '';
    showError(e.cError, '');
    e.cForm.hidden = true;
    if (e.dialog.open) renderDrawer();
    if (focus && !e.createOpen.hidden) e.createOpen.focus();
    return e.createOpen;
  }

  e.createOpen.addEventListener('click', () => {
    if (busy) return;
    if (creating) return closeCreate();
    guard(() => openCreate());
  });
  e.cCancel.addEventListener('click', () => closeCreate());
  e.cId.addEventListener('input', () => {
    checkId();
    renderDrawer();
  });

  e.cForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy || !creating || !doc) return;
    const built = buildNewAgent(readCreate(), doc.roles, levels());
    if (built.error) return fieldError(e.cError, built, CREATE_FIELDS);
    busy = true;
    const at = gen;
    setText(e.cStatus, 'Creating...', 'busy');
    renderDrawer();
    const res = await sendJson('POST', AGENTS_URL, built.body);
    if (res.ok) onChange();
    if (at !== gen || !e.dialog.open) {
      if (res.ok && e.dialog.open) load();
      return;
    }
    busy = false;
    setText(e.cStatus, '', '');
    if (!res.ok) {
      const msg = serverMessage(res);
      // a duplicate id is the only 409 about a field; too many agents is about none
      const field = res.status === 409 && /exist|duplicate|taken|already/i.test(msg) ? 'id' : agentErrorField(msg, Object.keys(CREATE_FIELDS));
      renderDrawer();
      fieldError(e.cError, { error: agentError(res.status, msg), field }, CREATE_FIELDS);
      return;
    }
    await load();
    if (at !== gen || !e.dialog.open) return;
    closeCreate({ force: true, focus: false });
    const name = built.body.name;
    setText(e.status, `Created ${name}. Turn it on for a run under New run, Workflow.`);
    (rows.get(built.body.id)?.settings ?? e.status).focus();
  });

  // ------------------------------------------------------------ the settings and new-agent forms
  for (const [form, close] of [[e.sForm, closeSettings], [e.cForm, closeCreate]]) {
    const changed = (ev) => {
      // the id is marked by its own live check
      if (ev.target !== e.cId) ev.target?.removeAttribute?.('aria-invalid');
      showError(form === e.sForm ? e.sError : e.cError, '');
      renderDrawer();
    };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    // Escape leaves the form first, not the whole drawer
    form.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation?.();
      close();
    });
  }

  // ------------------------------------------------------------ drawer
  function open() {
    if (support !== 'yes' || !on()) return false;
    opener = document.activeElement;
    showError(e.error, '');
    setText(e.status, '');
    doc = null;
    catalog = null;
    e.dialog.showModal();
    const loaded = load();
    loadModels();
    renderDrawer();
    e.dialog.querySelector('[data-close]')?.focus();
    loaded.then(() => {
      // the first row's button once the list is there, unless the human already moved on
      const first = rows.get(doc?.roles[0]?.id)?.edit;
      if (e.dialog.open && first && !editing && !settingsFor && !creating) first.focus();
    });
    return true;
  }

  function requestClose() {
    guard(() => {
      e.text.value = '';
      e.dialog.close();
      return e.open.hidden ? null : e.open;
    });
  }

  e.open.addEventListener('click', () => open());
  for (const b of e.dialog.querySelectorAll('[data-close]')) b.addEventListener('click', requestClose);
  e.dialog.addEventListener('click', (ev) => {
    if (ev.target === e.dialog) requestClose();
  });
  // Escape: the same question as the Close button when edits are unsaved
  e.dialog.addEventListener('cancel', (ev) => {
    if (!dirty()) return;
    ev.preventDefault();
    requestClose();
  });
  e.dialog.addEventListener('close', () => {
    // nothing of the prompts or forms outlives the drawer, and no reply still on its way may act on the next one
    gen += 1;
    editing = null;
    settingsFor = null;
    creating = false;
    e.text.value = '';
    e.sIns.value = '';
    e.cIns.value = '';
    e.form.hidden = true;
    e.sForm.hidden = true;
    e.cForm.hidden = true;
    e.list.after(e.form);
    e.cForm.after(e.sForm);
    doc = null;
    catalog = null;
    e.list.replaceChildren();
    rows.clear();
    busy = false;
    setText(e.foot, '');
    const usable = (t) => t && t !== document.body && t.isConnected && !t.closest('[hidden]') && !t.disabled;
    const target = usable(opener) ? opener : null;
    opener = null;
    if (target) target.focus();
    else if (!e.open.hidden) e.open.focus();
  });

  return {
    render, open,
    available: () => support === 'yes' && on(),
    editing: () => editing,
    settings: () => settingsFor,
    creating: () => creating,
  };
}
