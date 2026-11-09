// The Pipeline part of the New run drawer (#run-dialog): the engine choice for a new chat and the pipeline form.
// The team fields stay as they are; #run-form[data-engine="pipeline"] only hides them (styles.css).
import { CLIENT_HEADERS } from './control.js';
import { postJson, store } from './control-panel.js';
import {
  parseEngineInfo, modelGroups, parseModelValue, hasSupportedModel, parseDetect, buildRunBody, runErrorField, detectUrl,
  ROLES, CHECK_KINDS, CHECKS_MAX, SETUP_MAX, COMMAND_ID_MAX, TASK_MAX_BYTES, byteLength,
} from './pipeline-model.js';

const $ = (id) => document.getElementById(id);
const MODELS_KEY = 'scranton.pipelineModels';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function getDoc(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', headers: CLIENT_HEADERS });
    return { status: r.status, doc: r.ok ? await r.json().catch(() => null) : null };
  } catch {
    return { status: 0, doc: null };
  }
}

export function createPipelineForm() {
  const e = {
    form: $('run-form'), engineRow: $('f-engine'), team: $('f-engine-team'), pipeline: $('f-engine-pipeline'),
    pipelineRow: $('f-engine-pipeline-row'), pipelineHint: $('f-engine-pipeline-hint'),
    fields: $('pipeline-fields'), unavailable: $('pf-unavailable'), task: $('pf-task'), taskOpt: $('pf-task-opt'), taskCount: $('pf-task-count'),
    demo: $('pf-demo'), checksSet: $('pf-checks-set'), checks: $('pf-checks'), add: $('pf-check-add'), detect: $('pf-check-detect'),
    setupSet: $('pf-setup-set'), setup: $('pf-setup'), setupAdd: $('pf-setup-add'), setupNote: $('pf-setup-note'),
    checksStatus: $('pf-checks-status'), sandboxSet: $('pf-sandbox-set'), docker: $('pf-docker'), host: $('pf-host'),
    image: $('pf-image'), imageHint: $('pf-image-hint'), trustRow: $('pf-trust-row'), trust: $('pf-trust'),
    modelsSet: $('pf-models-set'), all: $('pf-model-all'), modelsNote: $('pf-models-note'),
    policySet: $('pf-policy-set'), approval: $('pf-approval'), delivery: $('pf-delivery'),
    models: Object.fromEntries(ROLES.map((r) => [r, $(`pf-model-${r}`)])),
  };
  const hintDefault = e.pipelineHint.textContent;
  const modelsNoteDefault = e.modelsNote.textContent;
  let info = null;
  let infoGen = 0;
  let project = null;
  let choice = false;
  let fixed = false;
  let engine = 'team';
  // { li, id, kind, command, required, remove, error }; setup rows have network instead of kind and required
  let rows = [];
  let setupRows = [];
  // the non-blank rows of the last build, in the order the server numbers them
  let sent = { checks: [], setup: [] };
  let rowSeq = 0;
  let rowsTouched = false;
  let detectedFor = null;
  let detectGen = 0;
  let modelsKey = '';

  // ------------------------------------------------------------ engine
  function setEngine(next) {
    engine = next;
    e.form.dataset.engine = next;
    e.fields.hidden = next !== 'pipeline';
    e.team.checked = next === 'team';
    e.pipeline.checked = next === 'pipeline';
    if (next === 'pipeline') {
      sync();
      detect();
    }
  }

  function renderAvailability() {
    const ok = Boolean(info?.available);
    e.pipeline.disabled = !ok;
    e.pipelineRow.dataset.disabled = String(!ok);
    e.pipelineHint.textContent = !info ? 'checking whether the engine is installed...' : ok ? hintDefault : `not available: ${info.reason}`;
    // a fixed pipeline chat still shows its form, with the reason a run cannot start
    e.unavailable.textContent = fixed && info && !ok ? `The Pipeline engine is not available: ${info.reason}` : '';
    e.unavailable.hidden = !e.unavailable.textContent;
    if (!ok && engine === 'pipeline' && !fixed) setEngine('team');
  }

  async function loadInfo() {
    const mine = ++infoGen;
    const { status, doc } = await getDoc('/api/pipeline');
    if (mine !== infoGen) return;
    info = parseEngineInfo(doc, status);
    renderAvailability();
    fillModels();
    e.image.placeholder = info.dockerImage ?? '';
    e.imageHint.textContent = info.dockerImage ? `optional, default ${info.dockerImage}` : 'optional';
    if (engine === 'pipeline') {
      sync();
      detect();
    }
  }

  // ------------------------------------------------------------ models
  function storedModels() {
    try {
      const v = JSON.parse(store.get(MODELS_KEY) ?? '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  function fillModels() {
    const providers = info?.providers ?? [];
    const key = JSON.stringify(providers);
    if (key === modelsKey) return;
    modelsKey = key;
    const stored = storedModels();
    for (const role of ROLES) {
      const sel = e.models[role];
      const prev = sel.value || stored[role] || '';
      const none = el('option', '', providers.length ? 'Choose a model' : 'No model available');
      none.value = '';
      const groups = modelGroups(providers).map((g) => {
        const og = el('optgroup');
        og.label = g.label;
        og.disabled = g.disabled;
        og.append(...g.options.map((o) => {
          const opt = el('option', '', o.text);
          opt.value = o.value;
          opt.disabled = o.disabled;
          return opt;
        }));
        return og;
      });
      sel.replaceChildren(none, ...groups);
      sel.value = parseModelValue(prev, providers) ? prev : '';
    }
    e.modelsNote.textContent = info && !hasSupportedModel(providers)
      ? 'No model is available yet. Sign in or add a provider under Accounts. The demo needs none.'
      : modelsNoteDefault;
  }

  function keepModels() {
    store.set(MODELS_KEY, JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, e.models[r].value]))));
  }

  for (const role of ROLES) e.models[role].addEventListener('change', keepModels);
  e.all.addEventListener('click', () => {
    const v = e.models.planner.value;
    if (!v) {
      e.models.planner.focus();
      return;
    }
    for (const role of ROLES) e.models[role].value = v;
    keepModels();
  });

  // ------------------------------------------------------------ setup and checks
  // type: 'check' | 'setup'
  function commandRow(type, c = {}) {
    const n = ++rowSeq;
    const setup = type === 'setup';
    const li = el('li', 'pf-check');
    const top = el('div', setup ? 'pf-check-top pf-setup-top' : 'pf-check-top');
    const idLabel = el('label', 'sr-only', setup ? 'Setup id' : 'Check id');
    const id = el('input', 'mono pf-check-id');
    id.type = 'text';
    id.id = `pf-${type}-${n}-id`;
    id.maxLength = COMMAND_ID_MAX;
    id.spellcheck = false;
    id.autocomplete = 'off';
    id.placeholder = 'id';
    id.value = c.id ?? '';
    idLabel.htmlFor = id.id;
    const remove = el('button', 'icon-btn pf-check-remove', '✕');
    const row = { li, id, remove, type };
    top.append(idLabel, id);
    if (setup) {
      const net = el('label', 'check pf-check-req');
      row.network = el('input');
      row.network.type = 'checkbox';
      row.network.checked = c.network === true;
      net.append(row.network, el('span', '', 'needs network'));
      top.append(net);
    } else {
      const kindLabel = el('label', 'sr-only', 'Kind');
      row.kind = el('select', 'pf-check-kind');
      row.kind.id = `pf-check-${n}-kind`;
      row.kind.append(...CHECK_KINDS.map((k) => {
        const o = el('option', '', k);
        o.value = k;
        return o;
      }));
      row.kind.value = CHECK_KINDS.includes(c.kind) ? c.kind : 'test';
      kindLabel.htmlFor = row.kind.id;
      const req = el('label', 'check pf-check-req');
      row.required = el('input');
      row.required.type = 'checkbox';
      row.required.checked = c.required !== false;
      req.append(row.required, el('span', '', 'required'));
      top.append(kindLabel, row.kind, req);
    }
    remove.type = 'button';
    top.append(remove);
    const cmdLabel = el('label', 'sr-only', 'Command');
    const command = el('input', 'mono pf-check-cmd');
    command.type = 'text';
    command.id = `pf-${type}-${n}-cmd`;
    command.spellcheck = false;
    command.autocomplete = 'off';
    command.maxLength = 2000;
    command.placeholder = setup ? 'command, for example npm ci' : 'command, for example npm test';
    command.value = c.command ?? '';
    cmdLabel.htmlFor = command.id;
    row.command = command;
    // the message about this row (a client check or the server's 400) is shown here, not in the drawer's error line
    row.error = el('p', 'form-status pf-row-error');
    row.error.id = `pf-${type}-${n}-error`;
    row.error.dataset.tone = 'error';
    li.append(top, cmdLabel, command);
    if (c.reason) li.append(el('span', 'hint pf-check-reason', c.reason));
    li.append(row.error);
    for (const x of fieldsOf(row)) {
      x.addEventListener('input', () => {
        rowsTouched = true;
        clearRowError(row);
      });
    }
    remove.addEventListener('click', () => {
      const list = setup ? setupRows : rows;
      const i = list.indexOf(row);
      const rest = list.filter((r) => r !== row);
      if (setup) setupRows = rest;
      else rows = rest;
      rowsTouched = true;
      renderRows();
      (rest[Math.min(i, rest.length - 1)]?.id ?? (setup ? e.setupAdd : e.add)).focus();
    });
    return row;
  }

  const fieldsOf = (r) => [r.id, r.kind, r.required, r.network, r.command].filter(Boolean);

  function clearRowError(r) {
    r.error.textContent = '';
    for (const x of [r.id, r.command]) if (x.getAttribute('aria-describedby') === r.error.id) x.removeAttribute('aria-describedby');
  }

  function renderRows() {
    for (const [list, word] of [[rows, 'check'], [setupRows, 'setup command']]) {
      list.forEach((r, i) => {
        const what = r.id.value.trim() || `${i + 1}`;
        r.remove.setAttribute('aria-label', `Remove ${word} ${what}`);
        r.remove.title = `Remove ${word} ${what}`;
        r.id.setAttribute('aria-label', `Id of ${word} ${i + 1}`);
        r.command.setAttribute('aria-label', `Command of ${word} ${i + 1}`);
        r.kind?.setAttribute('aria-label', `Kind of check ${i + 1}`);
        r.network?.setAttribute('aria-label', `Setup command ${i + 1} needs network`);
      });
    }
    e.checks.replaceChildren(...rows.map((r) => r.li));
    e.setup.replaceChildren(...setupRows.map((r) => r.li));
    e.setupNote.hidden = !setupRows.length;
    e.add.disabled = e.demo.checked || rows.length >= CHECKS_MAX;
    e.setupAdd.disabled = e.demo.checked || setupRows.length >= SETUP_MAX;
  }

  function setRows(checks, setup) {
    rows = checks.map((c) => commandRow('check', c));
    setupRows = setup.map((c) => commandRow('setup', c));
    renderRows();
  }

  const rowValue = (r) => (r.network
    ? { id: r.id.value, command: r.command.value, network: r.network.checked }
    : { id: r.id.value, kind: r.kind.value, command: r.command.value, required: r.required.checked });
  const filled = (r) => Boolean(r.id.value.trim() || r.command.value.trim());

  function checksStatus(text, tone = '') {
    e.checksStatus.textContent = text;
    e.checksStatus.dataset.tone = tone;
  }

  async function detect({ force = false } = {}) {
    if (!project || !info?.available || e.demo.checked) return;
    if (!force && (detectedFor === project || rowsTouched)) return;
    const mine = ++detectGen;
    const at = project;
    checksStatus('Looking for checks in the project...', 'busy');
    const r = await postJson(detectUrl(at), {});
    if (mine !== detectGen || at !== project) return;
    detectedFor = at;
    const found = r.ok ? parseDetect(r.data) : null;
    if (!found) {
      checksStatus(r.status === 404 ? 'This server cannot detect checks yet. Add them by hand.' : `Checks could not be detected: ${r.error ?? 'unexpected answer'}`, 'error');
      if (!rows.length) setRows([{}], setupRows.map(rowValue));
      return;
    }
    if (!rowsTouched || force) {
      rowsTouched = false;
      setRows(found.checks.length ? found.checks : [{}], found.setup);
    }
    const n = found.checks.length;
    const s = found.setup.length;
    const setupText = `${s} setup command${s === 1 ? '' : 's'}`;
    checksStatus(n
      ? `${s ? `${setupText} and ` : ''}${n} check${n === 1 ? '' : 's'} suggested from the project files. Edit or remove what does not fit.`
      : `${s ? `${setupText} suggested, but no checks` : 'No checks'} were detected. Add the commands that prove the change works; without checks nothing is verified automatically.`);
  }

  function addRow(type) {
    const setup = type === 'setup';
    if ((setup ? setupRows : rows).length >= (setup ? SETUP_MAX : CHECKS_MAX)) return;
    const row = commandRow(type);
    (setup ? setupRows : rows).push(row);
    rowsTouched = true;
    renderRows();
    row.id.focus();
  }
  e.add.addEventListener('click', () => addRow('check'));
  e.setupAdd.addEventListener('click', () => addRow('setup'));
  e.detect.addEventListener('click', () => detect({ force: true }));

  // ------------------------------------------------------------ demo, sandbox, task
  function sync() {
    const demo = e.demo.checked;
    const host = e.host.checked;
    e.taskOpt.hidden = !demo;
    for (const set of [e.setupSet, e.checksSet, e.sandboxSet, e.modelsSet]) set.dataset.demo = String(demo);
    for (const r of [...setupRows, ...rows]) for (const x of [...fieldsOf(r), r.remove]) x.disabled = demo;
    e.add.disabled = demo || rows.length >= CHECKS_MAX;
    e.setupAdd.disabled = demo || setupRows.length >= SETUP_MAX;
    e.detect.disabled = demo || !info?.available;
    e.docker.disabled = demo;
    e.host.disabled = demo;
    e.image.disabled = demo || host;
    e.trustRow.hidden = demo || !host;
    if (!host) e.trust.checked = false;
    for (const role of ROLES) e.models[role].disabled = demo;
    e.all.disabled = demo;
    e.approval.disabled = demo;
    e.policySet.dataset.demo = String(demo);
  }

  function updateCount() {
    const n = byteLength(e.task.value);
    e.taskCount.textContent = `${n} / ${TASK_MAX_BYTES} bytes`;
  }

  e.demo.addEventListener('change', () => {
    sync();
    if (!e.demo.checked) detect();
  });
  e.docker.addEventListener('change', sync);
  e.host.addEventListener('change', () => {
    sync();
    if (e.host.checked) e.trust.focus();
  });
  e.task.addEventListener('input', updateCount);
  e.task.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      e.form.requestSubmit();
    }
  });
  e.team.addEventListener('change', () => { if (e.team.checked) setEngine('team'); });
  e.pipeline.addEventListener('change', () => { if (e.pipeline.checked && !e.pipeline.disabled) setEngine('pipeline'); });

  function fieldInput(field) {
    if (field === 'task') return e.task;
    if (field === 'trustHost') return e.trust;
    if (field === 'image') return e.image;
    if (field?.startsWith('models.')) return e.models[field.slice(7)] ?? null;
    return null;
  }

  // fromServer: the server numbers only the rows that were sent
  function rowOf(field, fromServer) {
    const m = /^(checks|setup)\.(\d+)\.(id|command)$/.exec(field ?? '');
    if (!m) return null;
    const list = fromServer ? sent[m[1]] : m[1] === 'setup' ? setupRows : rows;
    const row = list[Number(m[2])] ?? null;
    return row && { row, input: row[m[3]] };
  }

  return {
    // choice: a new chat, so Team or Pipeline may be picked; fixed: a pipeline chat's next run
    open({ choice: canChoose = false, fixed: isFixed = false, project: p = null } = {}) {
      choice = canChoose && !isFixed;
      fixed = isFixed;
      if (p !== project) {
        rowsTouched = false;
        detectedFor = null;
        rows = [];
        setupRows = [];
        renderRows();
      }
      project = p;
      e.engineRow.hidden = !choice;
      for (const f of e.fields.querySelectorAll('[aria-invalid]')) f.removeAttribute('aria-invalid');
      setEngine(fixed ? 'pipeline' : 'team');
      updateCount();
      if (choice || fixed) {
        renderAvailability();
        loadInfo();
      }
    },
    active: () => engine === 'pipeline',
    focus() {
      e.task.focus();
    },
    build() {
      for (const r of [...setupRows, ...rows]) clearRowError(r);
      if (fixed && info && !info.available) return { error: `The Pipeline engine is not available: ${info.reason}` };
      sent = { checks: rows.filter(filled), setup: setupRows.filter(filled) };
      return buildRunBody({
        task: e.task.value, demo: e.demo.checked, delivery: e.delivery.value,
        sandbox: e.host.checked ? 'host' : 'docker', image: e.image.value, trustHost: e.trust.checked,
        setup: setupRows.map(rowValue),
        checks: rows.map(rowValue),
        models: Object.fromEntries(ROLES.map((r) => [r, parseModelValue(e.models[r].value, info?.providers ?? [])])),
        approvals: e.approval.value,
      });
    },
    // -> true when the message is shown next to its row (the drawer's error line then stays empty)
    markInvalid(field, message = '', { fromServer = false } = {}) {
      const hit = rowOf(field, fromServer);
      const input = hit?.input ?? fieldInput(field);
      if (!input) return false;
      input.setAttribute('aria-invalid', 'true');
      const atRow = Boolean(hit && message);
      if (atRow) {
        hit.row.error.textContent = message;
        input.setAttribute('aria-describedby', hit.row.error.id);
      }
      input.focus();
      return atRow;
    },
    errorField: runErrorField,
    started() {
      e.task.value = '';
      updateCount();
    },
  };
}
