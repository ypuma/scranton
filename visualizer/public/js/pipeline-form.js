// The Pipeline part of the New run drawer (#run-dialog): the engine choice for a new chat and the pipeline form.
// The team fields stay as they are; #run-form[data-engine="pipeline"] only hides them (styles.css).
import { CLIENT_HEADERS } from './control.js';
import { postJson, store } from './control-panel.js';
import {
  parseEngineInfo, modelGroups, parseModelValue, hasSupportedModel, parseDetect, buildRunBody, runErrorField, detectUrl, sandboxView, demoScenario,
  ROLES, CHECK_KINDS, CHECKS_MAX, SETUP_MAX, COMMAND_ID_MAX, TASK_MAX_BYTES, SANDBOX_POLL_MS, BUILD_URL, PIPELINE_MODELS_KEY, byteLength,
  storedPlannerPick,
} from './pipeline-model.js';

const $ = (id) => document.getElementById(id);
const MODELS_KEY = PIPELINE_MODELS_KEY;

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

// timers: setTimeout/clearTimeout for the image build poll (tests pass fakes). onPlanner(): the planner pick the
// next run would send (plannerPick) may have changed
export function createPipelineForm({ timers = globalThis, onPlanner = null } = {}) {
  const e = {
    dialog: $('run-dialog'), form: $('run-form'), engineRow: $('f-engine'), team: $('f-engine-team'), pipeline: $('f-engine-pipeline'),
    pipelineRow: $('f-engine-pipeline-row'), pipelineHint: $('f-engine-pipeline-hint'),
    fields: $('pipeline-fields'), unavailable: $('pf-unavailable'), task: $('pf-task'), taskOpt: $('pf-task-opt'), taskCount: $('pf-task-count'),
    demo: $('pf-demo'), scenarioRow: $('pf-scenario-row'), scenario: $('pf-scenario'), scenarioHint: $('pf-scenario-hint'), checksSet: $('pf-checks-set'), checks: $('pf-checks'), add: $('pf-check-add'), detect: $('pf-check-detect'),
    setupSet: $('pf-setup-set'), setup: $('pf-setup'), setupAdd: $('pf-setup-add'), setupNote: $('pf-setup-note'),
    checksStatus: $('pf-checks-status'), sandboxSet: $('pf-sandbox-set'), docker: $('pf-docker'), host: $('pf-host'),
    image: $('pf-image'), imageHint: $('pf-image-hint'), trustRow: $('pf-trust-row'), trust: $('pf-trust'), trustKept: $('pf-trust-kept'), trustDemo: $('pf-trust-demo'),
    sandboxStatus: $('pf-sandbox-status'), build: $('pf-build'), buildLog: $('pf-build-log'), buildTail: $('pf-build-tail'),
    execRow: $('pf-exec-row'), replans: $('pf-replans'), parallel: $('pf-parallel'), grounding: $('pf-grounding'), groundingHint: $('pf-grounding-hint'), guidance: $('pf-guidance'),
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
  // 'docker' | 'host' as the human last picked it; kept across drawer sessions, unlike the acknowledgement
  let sandboxPick = null;
  // the chat on screen already ran on the trusted host: its acknowledgement is given
  let kept = false;
  let building = false;
  let buildError = '';
  // the server's 409 about the sandbox (image missing, Docker gone), shown in the sandbox line instead of the probe
  let refused = '';
  let pollTimer = 0;
  // the Evidence checks choice while a scenario that needs Enforce holds the select; null when it is free
  let groundingHeld = null;

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
    renderSandbox();
    let found = null;
    if (engine === 'pipeline') {
      sync();
      found = detect();
    }
    schedulePoll();
    await found;
  }

  // ------------------------------------------------------------ Docker state and the image build
  function renderSandbox() {
    const sb = info?.sandbox ?? null;
    const v = sandboxView(sb, { buildError });
    e.sandboxStatus.textContent = refused || v.line;
    e.sandboxStatus.dataset.tone = refused ? 'error' : v.tone;
    e.build.hidden = v.build === 'hidden';
    e.build.textContent = v.build === 'running' ? 'Building...' : 'Build sandbox image';
    const wasFocused = document.activeElement === e.build;
    e.build.disabled = v.build === 'running' || building;
    if (wasFocused && e.build.disabled) e.sandboxStatus.focus();
    e.buildLog.hidden = !v.tail.trim();
    if (e.buildTail.textContent !== v.tail) e.buildTail.textContent = v.tail;
    // a probe only reports on Docker; it never moves the sandbox choice (open() and the human set it)
    sync();
  }

  function schedulePoll() {
    timers.clearTimeout(pollTimer);
    pollTimer = 0;
    if (info?.sandbox?.build?.state !== 'running' || !e.dialog.open) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = 0;
      if (e.dialog.open) loadInfo();
    }, SANDBOX_POLL_MS);
  }

  function clearRefused() {
    if (!refused) return;
    refused = '';
    e.image.removeAttribute('aria-invalid');
    e.image.removeAttribute('aria-describedby');
    renderSandbox();
  }

  e.build.addEventListener('click', async () => {
    if (e.build.disabled || building) return;
    building = true;
    buildError = '';
    refused = '';
    renderSandbox();
    const r = await postJson(BUILD_URL, {});
    building = false;
    // 409: a build is already running; either way the next probe shows it
    if ((r.ok || r.status === 409) && info?.sandbox?.known) {
      info.sandbox = { ...info.sandbox, build: { state: 'running', startedAt: null, finishedAt: null, tail: info.sandbox.build?.state === 'running' ? info.sandbox.build.tail : '' } };
    } else if (!r.ok) {
      buildError = r.status === 404 ? 'this server cannot build it.' : r.error || `HTTP ${r.status}`;
    }
    renderSandbox();
    schedulePoll();
  });

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
    // a stored pick the server no longer offers is dropped from the select, not from storage
    onPlanner?.();
  }

  function keepModels() {
    store.set(MODELS_KEY, JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, e.models[r].value]))));
    onPlanner?.();
  }

  // What build() would send as the planner: the select once it is filled, before that the stored pick it starts from
  function plannerPick() {
    if (!modelsKey) return storedPlannerPick(store.get(MODELS_KEY));
    return parseModelValue(e.models.planner.value, info?.providers ?? []);
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
    e.scenarioRow.hidden = !demo;
    e.scenarioHint.textContent = demoScenario(e.scenario.value).hint;
    // the demo honours the sandbox choice, so that part stays operable
    for (const set of [e.setupSet, e.checksSet, e.modelsSet]) set.dataset.demo = String(demo);
    for (const r of [...setupRows, ...rows]) for (const x of [...fieldsOf(r), r.remove]) x.disabled = demo;
    e.add.disabled = demo || rows.length >= CHECKS_MAX;
    e.setupAdd.disabled = demo || setupRows.length >= SETUP_MAX;
    e.detect.disabled = demo || !info?.available;
    e.image.disabled = host;
    e.build.disabled = building || info?.sandbox?.build?.state === 'running';
    // the demo honours the evidence checks and the guidance, not re-planning or parallel steps
    e.replans.disabled = demo;
    e.parallel.disabled = demo;
    e.execRow.dataset.disabled = String(demo);
    const enforced = demo && demoScenario(e.scenario.value).enforce === true;
    if (enforced && groundingHeld === null) {
      groundingHeld = e.grounding.value;
      e.grounding.value = 'enforce';
    } else if (!enforced && groundingHeld !== null) {
      e.grounding.value = groundingHeld;
      groundingHeld = null;
    }
    e.grounding.disabled = enforced;
    e.groundingHint.hidden = !enforced;
    if (enforced) e.grounding.setAttribute('aria-describedby', 'pf-grounding-hint');
    else e.grounding.removeAttribute('aria-describedby');
    e.trustRow.hidden = demo || !host;
    e.trustDemo.hidden = !demo || !host;
    if (!host) e.trust.checked = false;
    e.trustKept.hidden = !(kept && host);
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
  e.scenario.addEventListener('change', sync);
  e.docker.addEventListener('change', () => {
    if (e.docker.checked) sandboxPick = 'docker';
    clearRefused();
    sync();
  });
  e.host.addEventListener('change', () => {
    if (e.host.checked) sandboxPick = 'host';
    clearRefused();
    sync();
    if (e.host.checked && kept) e.trust.checked = true;
    else if (e.host.checked && !e.demo.checked) e.trust.focus();
  });
  e.image.addEventListener('input', clearRefused);
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
    if (field === 'sandbox') return e.docker;
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
    // choice: a new chat, so Team or Pipeline may be picked; fixed: a pipeline chat's next run;
    // task: what the Chat composer holds, for the task field.
    // -> a promise that settles once the engine info and the project's checks are in (the Chat composer starts a
    //    run with the form's choices without showing the drawer, and waits for it)
    // trusted: this chat already ran on the trusted host, so its acknowledgement is given (asked once per chat)
    open({ choice: canChoose = false, fixed: isFixed = false, project: p = null, task = '', trusted = false } = {}) {
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
      // Trusted host unless the human picked Docker; a chat asks for the acknowledgement once (trust.js)
      e.docker.checked = sandboxPick === 'docker';
      e.host.checked = !e.docker.checked;
      kept = trusted === true;
      e.trust.checked = kept && e.host.checked;
      buildError = '';
      refused = '';
      groundingHeld = null;
      e.grounding.value = 'enforce';
      e.guidance.checked = false;
      e.image.removeAttribute('aria-describedby');
      e.engineRow.hidden = !choice;
      for (const f of e.fields.querySelectorAll('[aria-invalid]')) f.removeAttribute('aria-invalid');
      setEngine(fixed ? 'pipeline' : 'team');
      if (fixed && task.trim()) e.task.value = task;
      updateCount();
      if (!choice && !fixed) return Promise.resolve();
      renderAvailability();
      return loadInfo();
    },
    active: () => engine === 'pipeline',
    plannerPick,
    focus() {
      e.task.focus();
    },
    // over: { task, demo } from the Chat composer, which has its own task field and never starts a demo
    build(over = {}) {
      for (const r of [...setupRows, ...rows]) clearRowError(r);
      if (fixed && info && !info.available) return { error: `The Pipeline engine is not available: ${info.reason}` };
      sent = { checks: rows.filter(filled), setup: setupRows.filter(filled) };
      clearRefused();
      return buildRunBody({
        task: over.task ?? e.task.value, demo: over.demo ?? e.demo.checked, demoScenario: e.scenario.value, delivery: e.delivery.value,
        sandbox: e.host.checked ? 'host' : e.docker.checked ? 'docker' : '', image: e.image.value, trustHost: e.trust.checked,
        replans: e.replans.value, parallelSteps: e.parallel.value, grounding: e.grounding.value, guidance: e.guidance.checked,
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
    // A 409 about the sandbox (the image is missing, Docker is gone) is said in the sandbox line. -> true when shown there
    sandboxRefused(r) {
      if (r?.status !== 409 || !/\bimage\b|docker/i.test(r.error ?? '')) return false;
      refused = r.error;
      renderSandbox();
      e.image.setAttribute('aria-invalid', 'true');
      e.image.setAttribute('aria-describedby', 'pf-sandbox-status');
      (e.image.disabled ? e.sandboxStatus : e.image).focus();
      return true;
    },
    started() {
      e.task.value = '';
      updateCount();
    },
  };
}
