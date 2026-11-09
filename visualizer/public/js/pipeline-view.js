// The main area of a pipeline chat (.enma/pipeline-contract.md section 10): run line, phase stepper, and the
// Plan, Checks, Review, Changes, Result and Activity sections, each only once it has something to show.
// Plans, diffs, reports and events quote the repository and the models: every text goes through textContent.
import { CLIENT_HEADERS } from './control.js';
import { postJson } from './control-panel.js';
import { formatClock } from './format.js';
import {
  parseRunList, parseRunDoc, mergeEvents, runChoices, pickRun, runLine, stepper, lastWorkNode, announcement,
  canCancel, canResume, createPoller, classifyDiff, diffFiles, actionLabel, eventText, LOUD_EVENTS, buildDecision,
  reportLimitations, revealBidi, folderName, pipelineUrl, runUrl, launchText, TERMINAL, RUN_STATUS, DIFF_LINES_SHOWN, COMMENT_MAX,
  RUN_ID_RE,
} from './pipeline-model.js';

const $ = (id) => document.getElementById(id);
const EVENTS_SHOWN = 300;
const FRESH_MS = 15000;
const MOVED = 'Another chat is on screen now. Nothing was sent.';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls, text, focusKey) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (focusKey) b.dataset.focus = focusKey;
  return b;
}

// works on the real DOM and on the test fake alike
function find(node, pred) {
  for (const c of node?.childNodes ?? []) {
    if (!c || typeof c !== 'object' || !c.dataset) continue;
    if (pred(c)) return c;
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}
const holds = (node, target) => Boolean(target) && (node === target || Boolean(find(node, (c) => c === target)));

async function getDoc(url) {
  try {
    const r = await fetch(url, { cache: 'no-store', headers: CLIENT_HEADERS });
    return { status: r.status, doc: r.ok ? await r.json().catch(() => null) : null };
  } catch {
    return { status: 0, doc: null };
  }
}

function bullets(cls, items, render) {
  const ul = el('ul', cls);
  ul.append(...items.map((x) => {
    const li = el('li');
    render(li, x);
    return li;
  }));
  return ul;
}

// confirm(opts): the shared confirm dialog. openRun(target, onStarted): the New run drawer for this chat's next run.
// timers: setTimeout/clearTimeout (tests pass fakes).
export function createPipelineView({ confirm, openRun, onChange, timers = globalThis } = {}) {
  const e = {
    root: $('pipeline-view'), pill: $('pv-status'), meta: $('pv-meta'), runs: $('pv-runs'), picker: $('pv-run'),
    resume: $('pv-resume'), cancel: $('pv-cancel'), announce: $('pv-announce'), msg: $('pv-msg'), stepper: $('pv-stepper'),
    empty: $('pv-empty'), emptyTitle: $('pv-empty-title'), start: $('pv-start'), sections: $('pv-sections'), side: $('pv-side'),
  };
  let scope = null;
  let shownAt = 0;
  let workspace = '';
  let gen = 0;
  let list = null;
  let listError = '';
  // the run the human picked in the selector; null follows the active (or newest) run
  let picked = null;
  let run = null;
  let runError = '';
  // name -> { key, content, truncated, error, loading }
  let artifacts = new Map();
  // a gate decision on its way or sent: { gate, digest, decision, error }
  let deciding = null;
  // what this page last asked the engine for ('decision' | 'resume' | 'cancel'), for the text of a failed call
  let action = '';
  // loads are numbered; one that began before the last action was answered still describes the call before it
  let loadSeq = 0;
  let actionAt = 0;
  // the checks whose output the human opened
  let openTails = new Set();
  let comment = '';
  let busy = '';
  // the message line shows a loading or load error text render() put there, not the answer to an action
  let autoShown = false;
  let announced = '';
  let choicesKey = '';
  // section name -> { key, node, container }
  const built = new Map();
  // where focus goes after a rebuild took the focused control away
  let restore = [];

  const poller = createPoller({ load, timers });
  // a run this page just started: shown once the chat lists it, and no older run is shown meanwhile
  let expected = null;
  const currentId = () => (expected && !list?.runs.some((r) => r.runId === expected) ? null : pickRun(list, picked));
  // the next run may start once nothing in this chat is still going
  const canStart = () => Boolean(list) && !list.active && !canCancel(run?.status);

  function say(text, tone = '') {
    autoShown = false;
    if (e.msg.textContent === text && e.msg.dataset.tone === tone) return;
    e.msg.textContent = text;
    e.msg.dataset.tone = tone;
  }

  // ------------------------------------------------------------ data
  async function loadList() {
    const mine = gen;
    const { status, doc } = await getDoc(pipelineUrl(scope));
    if (mine !== gen) return false;
    const parsed = parseRunList(doc);
    if (!parsed) {
      listError = status === 0 ? 'The server did not answer. Retrying...' : `The pipeline runs could not be loaded (HTTP ${status}).`;
      return false;
    }
    listError = '';
    list = parsed;
    return true;
  }

  async function load() {
    const mine = gen;
    const seq = ++loadSeq;
    const prevStatus = run?.status?.status ?? null;
    if (!list || !run?.status || TERMINAL.has(prevStatus) || !currentId()) await loadList();
    if (mine !== gen) return null;
    if (expected && list?.runs.some((r) => r.runId === expected)) expected = null;
    const id = currentId();
    if (!id) {
      run = null;
      render();
      // a run started a moment ago may not be listed yet
      return { live: Date.now() - shownAt < FRESH_MS, status: null };
    }
    if (run && run.runId !== id) resetRun();
    const after = run?.lastSeq ?? 0;
    const { status, doc } = await getDoc(`${runUrl(scope, id)}?after=${after}`);
    if (mine !== gen || currentId() !== id) return null;
    if (status === 404) {
      // asking again finds nothing either; picking another run or starting one polls again
      resetRun();
      runError = 'This run was not found in the chat. It may have been removed.';
      poller.stop();
      render();
      return null;
    }
    const parsed = parseRunDoc(doc);
    if (!parsed) {
      runError = status === 0 ? 'The server did not answer. Retrying...' : `The run could not be loaded (HTTP ${status}).`;
      render();
      return run ? { live: false, status: run.status?.status ?? null } : null;
    }
    runError = '';
    const fresh = seq > actionAt;
    run = {
      runId: id, status: parsed.status, live: parsed.live,
      launchError: fresh ? parsed.launchError : run?.launchError ?? null,
      events: mergeEvents(run?.events ?? [], parsed.events),
      lastSeq: parsed.lastSeq ?? run?.lastSeq ?? 0,
      plan: parsed.plan ?? run?.plan ?? null, review: parsed.review ?? run?.review ?? null, stderrTail: parsed.stderrTail,
    };
    if (deciding && !deciding.error) {
      // taken up once the gate it answered is gone; failed once the engine call ended and the gate still waits
      if (run.status?.pending?.digest !== deciding.digest) deciding = null;
      else if (fresh && (!run.live || run.launchError)) deciding = null;
    }
    const nextStatus = parsed.status?.status ?? null;
    if (prevStatus !== nextStatus) {
      if (prevStatus && e.msg.dataset.tone === 'busy') say('');
      await loadList();
      if (mine !== gen) return null;
      onChange?.();
    }
    if (parsed.status) fetchArtifacts(mine);
    render();
    return { live: run.live, status: nextStatus };
  }

  function resetRun() {
    run = null;
    runError = '';
    artifacts = new Map();
    deciding = null;
    action = '';
    comment = '';
    openTails = new Set();
    built.clear();
  }

  // An action was sent (answered: false) or answered (true). Until it is answered no load result may report
  // the failure of the call before it.
  function acted(what, answered) {
    action = what;
    actionAt = answered ? loadSeq : Infinity;
    if (!answered && run) run.launchError = null;
  }

  function wake() {
    if (poller.running()) poller.now();
    else poller.start();
  }

  // which artifact the screen needs, keyed so a new diff (another gate digest) is fetched again
  function wanted(s) {
    const out = [];
    // a failed or cancelled run names its partial diff under the same name (section 15 g)
    const changed = s.pending?.gate === 'delivery' || s.artifacts.diff;
    if (changed) out.push(['diff', s.pending?.gate === 'delivery' ? s.pending.digest : s.delivery?.diffSha256 ?? s.status]);
    if (TERMINAL.has(s.status) && s.artifacts.reportMd) out.push(['report', s.updatedAt ?? '']);
    if (TERMINAL.has(s.status) && s.artifacts.reportJson) out.push(['report-json', s.updatedAt ?? '']);
    return out;
  }

  function fetchArtifacts(mine) {
    const id = run.runId;
    const at = run.status.updatedAt;
    for (const [name, key] of wanted(run.status)) {
      const have = artifacts.get(name);
      // a failed one is asked for again only once the run changed
      if (have && have.key === key && (!have.error || have.failedAt === at)) continue;
      if (have?.loading) continue;
      artifacts.set(name, { key, loading: true, content: have?.content ?? '', truncated: false, error: '' });
      getDoc(runUrl(scope, id, `artifacts/${name}`)).then(({ status, doc }) => {
        if (mine !== gen || run?.runId !== id) return;
        const ok = doc && typeof doc.content === 'string';
        artifacts.set(name, {
          key, loading: false, content: ok ? doc.content : '', truncated: ok && doc.truncated === true,
          error: ok ? '' : `It could not be loaded (HTTP ${status}).`, failedAt: ok ? null : at,
        });
        render();
      });
    }
  }

  // ------------------------------------------------------------ actions
  function pinned() {
    const at = gen;
    const where = scope;
    return { where, stale: () => at !== gen };
  }

  async function decide(gate, decision) {
    const s = run?.status;
    const b = buildDecision({ gate, decision, comment: gate === 'plan' ? comment : '' }, s?.pending);
    if (b.error) {
      deciding = { gate, digest: s?.pending?.digest ?? '', decision, error: b.error };
      render();
      return;
    }
    const to = pinned();
    const id = run.runId;
    deciding = { gate, digest: b.body.digest, decision, error: '' };
    acted('decision', false);
    render();
    const r = await postJson(runUrl(to.where, id, 'decision'), b.body);
    if (to.stale() || run?.runId !== id) return;
    acted('decision', true);
    if (!r.ok) {
      deciding = { ...deciding, error: r.error };
      render();
      if (r.status === 409) poller.now();
      return;
    }
    poller.now();
  }

  async function control(what) {
    const to = pinned();
    const id = run?.runId;
    if (!id) return { error: 'No run selected.' };
    busy = what;
    acted(what, false);
    render();
    const r = await postJson(runUrl(to.where, id, what), {});
    if (to.stale()) return {};
    acted(what, true);
    busy = '';
    if (!r.ok) {
      say(r.error, 'error');
      render();
      poller.now();
      return { error: r.error };
    }
    say(what === 'cancel' ? 'Cancel requested. The run stops at the next step boundary.' : 'Resuming the run...', 'busy');
    poller.now();
    return { focus: e.msg };
  }

  e.cancel.addEventListener('click', () => {
    if (!canCancel(run?.status) || busy) return;
    const to = pinned();
    confirm?.({
      title: 'Cancel this pipeline run?',
      detail: 'The engine stops at the next step boundary and finishes the run as cancelled. The project folder is not changed.',
      ok: 'Cancel run',
      scoped: to,
      action: () => (to.stale() ? { error: MOVED } : control('cancel')),
    });
  });
  e.resume.addEventListener('click', () => {
    if (canResume(run?.status) && !busy) control('resume');
  });
  e.picker.addEventListener('change', () => {
    const v = e.picker.value;
    // the newest run is the live one: picking it follows whatever runs next
    picked = v === list?.runs.at(-1)?.runId ? null : v;
    resetRun();
    say('');
    render();
    wake();
  });
  e.start.addEventListener('click', () => startRun());

  function startRun() {
    if (!scope) return;
    if (!canStart()) {
      say(list ? 'A run of this chat is still going. Cancel it or wait until it has finished, then start the next one.' : 'The runs of this chat are still loading.', 'error');
      e.msg.focus();
      return;
    }
    const to = pinned();
    openRun?.({
      title: 'New pipeline run',
      workspace: workspace || null,
      project: to.where.project,
      startPipeline: (body) => postJson(pipelineUrl(to.where, 'runs'), body),
    }, (r) => {
      if (to.stale()) return;
      shownAt = Date.now();
      picked = null;
      expected = RUN_ID_RE.test(r?.data?.runId ?? '') ? r.data.runId : null;
      resetRun();
      say('');
      wake();
    });
  }

  // ------------------------------------------------------------ rendering
  function render() {
    if (!scope) return;
    const s = run?.status ?? null;
    const line = runLine(s);
    e.pill.dataset.status = line.status;
    e.pill.dataset.loud = String(line.loud);
    const glyph = el('span', 'pill-glyph', line.glyph);
    glyph.setAttribute('aria-hidden', 'true');
    e.pill.replaceChildren(glyph, el('span', 'pill-text', line.label));
    e.meta.textContent = line.parts.join(' · ');
    e.pill.hidden = !s;

    const choices = runChoices(list?.runs ?? []);
    const key = JSON.stringify(choices);
    if (key !== choicesKey) {
      choicesKey = key;
      e.picker.replaceChildren(...choices.map((c) => {
        const o = el('option', '', c.text);
        o.value = c.value;
        o.title = c.title;
        return o;
      }));
    }
    e.runs.dataset.choices = String(choices.length);
    e.picker.value = currentId() ?? '';

    e.cancel.hidden = !canCancel(s);
    e.cancel.disabled = Boolean(busy);
    e.cancel.textContent = busy === 'cancel' ? 'Cancelling...' : 'Cancel run';
    e.resume.hidden = !canResume(s);
    e.resume.disabled = Boolean(busy);
    e.resume.textContent = busy === 'resume' ? 'Resuming...' : 'Resume';

    const none = list && !list.runs.length && !expected;
    e.empty.hidden = !none;
    if (none) e.emptyTitle.textContent = 'No pipeline run in this chat yet.';
    // the last engine call ended without a new status: said in the run line, inverted, instead of waiting
    const failed = run?.launchError && !run.live ? launchText(run.launchError, { started: Boolean(s), action }) : '';
    const auto = listError && !list ? [listError, 'error'] : runError ? [runError, 'error']
      : failed ? [failed, 'critical'] : expected ? ['Starting the run...', 'busy']
        : !list || (currentId() && !run) ? ['Loading the pipeline run...', 'busy'] : null;
    if (auto) {
      say(...auto);
      autoShown = true;
    } else if (autoShown) {
      say('');
      autoShown = false;
    }

    e.stepper.hidden = !s;
    if (s) renderStepper(s);

    const news = failed || announcement(s);
    if (news !== announced) {
      // the first look at a run is not news; changes after it are, and so is a failed engine call
      if ((announced || failed) && news) e.announce.textContent = news;
      announced = news;
    }
    renderSections(s);
  }

  function renderStepper(s) {
    const steps = stepper(s, lastWorkNode(run.events));
    const key = JSON.stringify(steps);
    if (e.stepper.dataset.key === key) return;
    e.stepper.dataset.key = key;
    const glyph = { done: '✓', current: '●', waiting: '■', stopped: '–', failed: '✕', pending: '○' };
    const word = { done: 'done', current: 'in progress', waiting: 'waiting for you', stopped: 'stopped here', failed: 'failed here', pending: 'not reached' };
    e.stepper.replaceChildren(...steps.map((p, i) => {
      const li = el('li', 'pv-step');
      li.dataset.state = p.state;
      if (['current', 'waiting', 'stopped', 'failed'].includes(p.state)) li.setAttribute('aria-current', 'step');
      const g = el('span', 'pv-step-glyph', glyph[p.state]);
      g.setAttribute('aria-hidden', 'true');
      li.append(g, el('span', 'pv-step-label', `${i + 1} ${p.label}`), el('span', 'sr-only', `, ${word[p.state]}`));
      return li;
    }));
  }

  // Each section is rebuilt only when what it shows changed; focus inside a rebuilt section returns to the same
  // control, or to the section heading when that control is gone (a decided gate).
  function place(container, list) {
    const active = document.activeElement;
    const nodes = [];
    for (const [name, key, build] of list) {
      const prev = built.get(name);
      if (prev && prev.key === key) {
        nodes.push(prev.node);
        continue;
      }
      const node = build();
      const had = prev && holds(prev.node, active);
      built.set(name, { key, node });
      nodes.push(node);
      if (had) {
        const key = active.dataset?.focus;
        const same = key ? find(node, (c) => c.dataset.focus === key && !c.disabled) : null;
        // a pressed gate button is disabled while its decision is on the way; its status line says so
        const status = active.dataset?.decision ? find(node, (c) => c.dataset.focus === 'gate-status') : null;
        restore.push(same ?? status ?? find(node, (c) => c.dataset.heading === 'true') ?? node);
      }
    }
    for (const [name, b] of built) if (!list.some(([n]) => n === name) && container === b.container) built.delete(name);
    for (const [name] of list) built.get(name).container = container;
    const same = nodes.length === container.childNodes.length && nodes.every((n, i) => container.childNodes[i] === n);
    if (!same) container.replaceChildren(...nodes);
  }

  function renderSections(s) {
    restore = [];
    const main = [];
    const side = [];
    if (s && run) {
      const plan = run.plan;
      const planGate = s.pending?.gate === 'plan' ? s.pending : null;
      if (plan || planGate) main.push(['plan', JSON.stringify([plan, planGate, s.progress.stepIndex, gateState('plan')]), () => planSection(plan, planGate, s)]);
      if (s.checks.length) main.push(['checks', JSON.stringify(s.checks), () => checksSection(s.checks)]);
      if (run.review) main.push(['review', JSON.stringify(run.review), () => reviewSection(run.review)]);
      const diff = artifacts.get('diff');
      const deliveryGate = s.pending?.gate === 'delivery' ? s.pending : null;
      if (deliveryGate || diff?.content || diff?.loading || diff?.error || s.delivery?.applied === true || s.delivery?.conflicts.length) {
        main.push(['changes', JSON.stringify([diff?.key, diff?.loading, diff?.error, Boolean(diff?.content), deliveryGate, s.delivery, s.sourceDir, gateState('delivery')]),
          () => changesSection(diff, deliveryGate, s)]);
      }
      if (TERMINAL.has(s.status) || s.status === 'suspended') {
        const report = artifacts.get('report');
        const limits = artifacts.get('report-json');
        main.push(['result', JSON.stringify([s.status, s.failure, s.resumable, report?.key, report?.loading, report?.error, Boolean(report?.content), limits?.key, limits?.loading]),
          () => resultSection(s, report, limits)]);
      }
      if (run.events.length || run.stderrTail) side.push(['activity', JSON.stringify([run.events.at(-1)?.seq ?? 0, run.events.length, run.stderrTail]), () => activitySection(run.events, run.stderrTail)]);
    }
    place(e.sections, main);
    place(e.side, side);
    e.side.hidden = side.length === 0;
    restore.at(-1)?.focus?.();
  }

  const gateState = (gate) => (deciding?.gate === gate ? [deciding.digest, deciding.decision, deciding.error] : null);

  function section(name, title, aside = '') {
    const root = el('section', 'pv-section');
    root.dataset.section = name;
    const head = el('header', 'section-head');
    const h = el('h3', 'pv-h', title);
    h.tabIndex = -1;
    h.dataset.heading = 'true';
    h.id = `pv-h-${name}`;
    root.setAttribute('aria-labelledby', h.id);
    head.append(h);
    if (aside) head.append(el('span', 'section-aside', aside));
    root.append(head);
    return root;
  }

  function sub(title) {
    return el('h4', 'pv-sub', title);
  }

  function gateBox(gate, title, detail, actions) {
    const box = el('div', 'pv-gate');
    box.dataset.gate = gate;
    const head = el('div', 'hitl-head');
    const mark = el('span', 'hitl-mark', '■');
    mark.setAttribute('aria-hidden', 'true');
    head.append(mark, el('strong', 'pv-gate-title', title));
    box.append(head);
    for (const d of detail) box.append(d);
    const row = el('div', 'hitl-actions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', title);
    const sent = deciding?.gate === gate && !deciding.error;
    for (const [label, decision, primary, extra] of actions) {
      const b = button(primary ? 'btn btn-primary' : 'btn', label, `${gate}-${decision}`);
      b.dataset.decision = decision;
      b.disabled = sent;
      if (extra) extra(b);
      b.addEventListener('click', () => decide(gate, decision));
      row.append(b);
    }
    box.append(row);
    const status = el('p', 'hitl-status');
    status.tabIndex = -1;
    status.dataset.focus = 'gate-status';
    if (deciding?.gate === gate) {
      status.textContent = deciding.error || 'Decision sent. Waiting for the engine to take it up...';
      status.dataset.tone = deciding.error ? 'error' : 'busy';
    }
    box.append(status);
    return box;
  }

  function planSection(plan, gate, s) {
    const root = section('plan', 'Plan', plan ? `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}` : '');
    if (gate) {
      const flags = gate.riskFlags.length
        ? bullets('pv-flags', gate.riskFlags, (li, f) => { li.className = 'badge'; li.dataset.tone = 'loud'; li.textContent = f.replace(/_/g, ' '); })
        : el('p', 'hint', 'No risk flag was raised.');
      const field = el('div', 'field');
      const label = el('label', '', 'Comment ');
      label.append(el('span', 'hint', 'optional, kept with the decision'));
      const text = el('textarea', 'pv-comment');
      text.id = 'pv-plan-comment';
      text.rows = 2;
      text.maxLength = COMMENT_MAX;
      text.value = comment;
      text.dataset.focus = 'plan-comment';
      text.disabled = deciding?.gate === 'plan' && !deciding.error;
      label.htmlFor = text.id;
      text.addEventListener('input', () => { comment = text.value; });
      field.append(label, text);
      root.append(gateBox('plan', 'The plan waits for your approval', [flags, field], [
        ['Approve plan', 'approve', true],
        ['Reject plan', 'reject', false],
      ]));
    }
    if (!plan) {
      root.append(el('p', 'hint', 'The plan is being loaded...'));
      return root;
    }
    if (plan.summary) root.append(el('p', 'pv-text', plan.summary));
    if (plan.criteria.length) {
      root.append(sub('Acceptance criteria'), bullets('pv-list', plan.criteria, (li, c) => {
        li.append(el('span', 'mono pv-id', c.id), ' ', el('span', '', c.text));
        if (c.verifiedBy) li.append(' ', el('span', 'hint', `verified by ${c.verifiedBy}`));
      }));
    }
    if (plan.steps.length) {
      const ol = el('ol', 'pv-steps');
      plan.steps.forEach((st, i) => {
        const li = el('li', 'pv-plan-step');
        if (i === s.progress.stepIndex && !TERMINAL.has(s.status)) li.setAttribute('aria-current', 'step');
        const head = el('div', 'pv-step-head');
        head.append(el('span', 'mono pv-id', st.id || String(i + 1)), ' ', el('strong', '', st.title));
        li.append(head);
        if (st.description) li.append(el('p', 'pv-text pv-dim', st.description));
        if (st.files.length) li.append(bullets('pv-files', st.files, (f, x) => f.append(el('span', 'pv-action', actionLabel(x.action)), ' ', el('span', 'mono', x.path))));
        ol.append(li);
      });
      root.append(sub('Steps'), ol);
    }
    if (plan.risks.length) {
      root.append(sub('Risks'), bullets('pv-list', plan.risks, (li, r) => {
        li.append(el('span', 'pv-action', r.severity || 'risk'), ' ', el('span', '', r.description));
        if (r.mitigation) li.append(el('span', 'hint pv-block', `Mitigation: ${r.mitigation}`));
      }));
    }
    if (plan.assumptions.length) root.append(sub('Assumptions'), bullets('pv-list', plan.assumptions, (li, a) => { li.textContent = a; }));
    return root;
  }

  function checksSection(checks) {
    const failed = checks.filter((c) => c.status !== 'passed').length;
    const root = section('checks', 'Checks', failed ? `${failed} not passed` : 'all passed');
    const glyph = { passed: '✓', failed: '✕', timed_out: '✕', error: '!' };
    root.append(bullets('pv-checks', checks, (li, c) => {
      li.dataset.status = c.status;
      li.dataset.loud = String(c.required && c.status !== 'passed');
      const g = el('span', 'pv-check-glyph', glyph[c.status] ?? '·');
      g.setAttribute('aria-hidden', 'true');
      li.append(g, el('span', 'mono pv-check-id', c.id), el('span', 'pv-check-status', c.status.replace(/_/g, ' ')),
        el('span', 'hint', [c.kind, c.required ? 'required' : 'optional', c.durationS !== null ? `${c.durationS.toFixed(1)} s` : ''].filter(Boolean).join(' · ')));
      if (c.status !== 'passed' && c.outputTail.trim()) li.append(outputTail(c));
    }));
    return root;
  }

  // a check's output, on demand; it stays open across the rebuilds of the section
  function outputTail(c) {
    const d = el('details', 'pv-tail');
    d.open = openTails.has(c.id);
    d.addEventListener('toggle', () => {
      if (d.open) openTails.add(c.id);
      else openTails.delete(c.id);
    });
    const summary = el('summary', '', 'Output');
    summary.dataset.focus = `tail-${c.id}`;
    summary.append(el('span', 'sr-only', ` of ${c.id}`));
    const pre = el('pre', 'exit-tail', revealBidi(c.outputTail));
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', `Last output of check ${c.id}`);
    d.append(summary, pre);
    return d;
  }

  function reviewSection(r) {
    const root = section('review', 'Review');
    const verdict = el('p', 'pv-verdict');
    const badge = el('span', 'badge', r.verdict === 'approve' ? 'Approved' : 'Changes requested');
    if (r.verdict !== 'approve') badge.dataset.tone = 'loud';
    verdict.append(badge);
    if (r.summary) verdict.append(' ', el('span', '', r.summary));
    root.append(verdict);
    if (r.criteria.length) {
      root.append(sub('Criteria'), bullets('pv-list', r.criteria, (li, c) => {
        const st = el('span', 'pv-action', c.status.replace(/_/g, ' '));
        if (c.status === 'not_met') st.dataset.loud = 'true';
        li.append(el('span', 'mono pv-id', c.id), ' ', st);
        if (c.evidence) li.append(el('span', 'hint pv-block', c.evidence));
      }));
    }
    if (r.findings.length) {
      root.append(sub('Findings'), bullets('pv-list', r.findings, (li, f) => {
        const sev = el('span', 'pv-action', f.severity);
        if (f.severity === 'blocking' || f.severity === 'major') sev.dataset.loud = 'true';
        li.append(sev, ' ', el('span', 'hint', f.category), f.path ? ' ' : '', f.path ? el('span', 'mono', f.path) : '');
        li.append(el('span', 'pv-block', f.description));
        if (f.suggestion) li.append(el('span', 'hint pv-block', `Suggestion: ${f.suggestion}`));
      }));
    }
    return root;
  }

  function changesSection(diff, gate, s) {
    const lines = diff?.content ? classifyDiff(diff.content) : [];
    const files = gate?.files.length ? gate.files.map((f) => ({ ...f, action: f.action })) : diffFiles(lines);
    // without a delivery gate, only a succeeded run has the whole change; any other one stopped part way
    const title = !gate && s.status !== 'succeeded' ? 'Changes up to the last passing step' : 'Changes';
    const root = section('changes', title, files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '');
    if (gate) {
      const folder = s.sourceDir;
      const where = el('p', 'pv-text');
      where.id = 'pv-apply-where';
      where.append('Apply writes these changes into ', el('span', 'mono', folder || 'the project folder'),
        '. Nothing there changes until you choose. Keep as patch only leaves the folder as it is.');
      root.append(gateBox('delivery', 'Apply the changes to the project?', [where], [
        [`Apply to ${folderName(folder) || 'project'}`, 'approve', true, (b) => { b.title = folder; b.setAttribute('aria-describedby', where.id); }],
        ['Keep as patch only', 'reject', false],
      ]));
    } else if (s.delivery && (s.delivery.applied !== null || s.delivery.conflicts.length)) {
      const d = s.delivery;
      const text = d.applied === true ? `Applied to ${s.sourceDir}.`
        : d.applied === false ? (s.deliveryMode === 'patch' ? 'Kept as a patch; the project folder was not changed.' : 'Not applied; the project folder was not changed.')
          : 'Not applied.';
      root.append(el('p', 'pv-text', text));
      if (d.conflicts.length) root.append(sub('Conflicts'), bullets('pv-list', d.conflicts, (li, c) => { li.textContent = c; }));
    }
    if (files.length) {
      root.append(bullets('pv-changed', files, (li, f) => {
        li.append(el('span', 'pv-action', actionLabel(f.action)), el('span', 'mono pv-path', revealBidi(f.path)),
          el('span', 'mono hint', `+${f.added} -${f.removed}`));
      }));
    }
    if (diff?.loading && !diff.content) root.append(el('p', 'hint', 'Loading the diff...'));
    else if (diff?.error) root.append(el('p', 'hitl-status', `The diff: ${diff.error}`));
    if (lines.length) {
      const pre = el('pre', 'pv-diff');
      pre.tabIndex = 0;
      pre.dataset.focus = 'diff';
      pre.setAttribute('aria-label', 'Unified diff');
      pre.append(...lines.slice(0, DIFF_LINES_SHOWN).map((l) => {
        const span = el('span', 'dl', revealBidi(l.text) || ' ');
        span.dataset.kind = l.kind;
        return span;
      }));
      root.append(pre);
      if (lines.length > DIFF_LINES_SHOWN || diff.truncated) {
        root.append(el('p', 'hint', `Showing ${Math.min(lines.length, DIFF_LINES_SHOWN)} lines${diff.truncated ? ' of a diff cut at 1 MiB' : ` of ${lines.length}`}. The full diff is in the run folder.`));
      }
    }
    return root;
  }

  function resultSection(s, report, limits) {
    const root = section('result', 'Result', RUN_STATUS[s.status].label);
    if (s.failure) {
      const box = el('div', 'pv-failure');
      box.append(el('strong', '', `${s.failure.failureClass || 'failure'}${s.failure.code ? ` / ${s.failure.code}` : ''}`));
      if (s.failure.message) box.append(el('span', 'pv-block', s.failure.message));
      if (s.failure.node) box.append(el('span', 'pv-block pv-dim', `in ${s.failure.node}`));
      root.append(box);
    } else if (s.status === 'rejected') root.append(el('p', 'pv-text', 'The plan was rejected; nothing was implemented.'));
    else if (s.status === 'cancelled') root.append(el('p', 'pv-text', 'The run was cancelled. The project folder was not changed by it unless the changes had been applied before.'));
    else if (s.status === 'suspended') root.append(el('p', 'pv-text', s.resumable ? 'The run stopped before it finished (the engine or the app went away). Resume continues from the last finished step.' : 'The run stopped before it finished.'));
    const lim = limits?.content ? reportLimitations(limits.content) : [];
    if (lim.length) root.append(sub('Limitations'), bullets('pv-list', lim, (li, l) => { li.textContent = l; }));
    if (report?.loading && !report.content) root.append(el('p', 'hint', 'Loading the report...'));
    else if (report?.error) root.append(el('p', 'hitl-status', `The report: ${report.error}`));
    if (report?.content) {
      const pre = el('pre', 'pv-report', revealBidi(report.content));
      pre.tabIndex = 0;
      pre.dataset.focus = 'report';
      pre.setAttribute('aria-label', 'Run report');
      root.append(sub('Report'), pre);
    }
    return root;
  }

  function activitySection(events, stderr) {
    const root = section('activity', 'Activity', `${events.length} event${events.length === 1 ? '' : 's'}, newest first`);
    const ol = el('ol', 'pv-events');
    ol.tabIndex = 0;
    ol.dataset.focus = 'events';
    ol.setAttribute('aria-label', 'Engine events, newest first');
    ol.append(...events.slice(-EVENTS_SHOWN).reverse().map((ev) => {
      const li = el('li', 'pv-event');
      if (LOUD_EVENTS.has(ev.type)) li.dataset.loud = 'true';
      li.append(el('span', 'mono pv-ev-time', formatClock(ev.ts)), el('span', 'mono pv-ev-type', ev.type.replace(/_/g, ' ')),
        el('span', 'pv-ev-text', [ev.node, eventText(ev)].filter(Boolean).join(' · ')));
      return li;
    }));
    if (events.length) root.append(ol);
    if (stderr.trim()) {
      const d = el('details', 'pv-stderr');
      d.append(el('summary', '', 'Engine output'), el('pre', 'exit-tail', stderr));
      root.append(d);
    }
    return root;
  }

  // ------------------------------------------------------------ api
  return {
    // s: { project, chat }; ws: the project folder
    show(s, ws = '') {
      if (scope && s && scope.project === s.project && scope.chat === s.chat) return;
      gen += 1;
      scope = s ? { project: s.project, chat: s.chat } : null;
      workspace = ws;
      shownAt = Date.now();
      list = null;
      listError = '';
      picked = null;
      expected = null;
      busy = '';
      announced = '';
      choicesKey = '';
      resetRun();
      say('');
      e.announce.textContent = '';
      e.stepper.dataset.key = '';
      e.sections.replaceChildren();
      e.side.replaceChildren();
      e.root.hidden = !scope;
      if (!scope) return poller.stop();
      render();
      poller.start();
    },
    hide() {
      if (!scope && e.root.hidden) return;
      gen += 1;
      scope = null;
      poller.stop();
      e.root.hidden = true;
    },
    newRun: startRun,
    canStart,
    polling: () => poller.running(),
  };
}
