// The pipeline view driven with the fake DOM and a fake server: gate rendering and the decision requests (the
// digest comes from status.pending), the Apply control naming the folder, poll scheduling, and untrusted text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineView } from '../../visualizer/public/js/pipeline-view.js';
import { FakeEl, installDom } from './fixtures/fake-dom.js';
import { REAL_GROUNDING, REAL_EVIDENCE_DEMO, REAL_ABSENCE_REFUTED } from './fixtures/engine-grounding.js';

const RUN = 'abc123def456';
const BASE = `/api/projects/core/chats/c1/pipeline`;

function runStatus(over = {}) {
  return {
    schema: 1, run_id: RUN, status: 'awaiting_approval', phase: 'approve_plan', node: 'plan', task: 'Fix the parser',
    source_dir: 'C:\\code\\my-app', delivery_mode: 'apply',
    progress: { step_index: -1, step_count: 2, step_title: '', attempt: 0, review_round: 0 },
    pending: { gate: 'plan', digest: 'plan-digest-1', risk_flags: ['deletes_files'], path: 'C:\\runs\\plan.json' },
    failure: null, resumable: false, usage: { calls: 1, input_tokens: 900, output_tokens: 200, estimated_cost: null },
    checks: [], delivery: null, artifacts: { plan: 'p', diff: null, report_md: null, report_json: null },
    sandbox: { mode: 'docker', isolated: true }, pid: 7, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:01:00Z',
    engine_version: '0.1.0', ...over,
  };
}

const EVIL = '<img src=x onerror="alert(1)">';
const PLAN = {
  summary: `Guard the parser ${EVIL}`, assumptions: [], risks: [],
  acceptance_criteria: [{ id: 'c1', text: 'Empty input returns []', verified_by: 'checks' }],
  steps: [{ id: 's1', title: 'Handle empty input', description: 'Return early', files: [{ path: 'src/parse.py', action: 'modify' }] }],
};

function fakeTimers() {
  const t = { delays: [], pending: new Map(), seq: 0 };
  t.setTimeout = (fn, ms) => { t.delays.push(ms); t.pending.set(++t.seq, fn); return t.seq; };
  t.clearTimeout = (id) => { t.pending.delete(id); };
  return t;
}

function walk(node, pred, out = []) {
  for (const c of node?.childNodes ?? []) {
    if (!(c instanceof FakeEl)) continue;
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
}
const texts = (node) => walk(node, () => true).map((n) => n.textContent).filter(Boolean);
// what the reader gets from a node built of strings and elements (the fake has no derived textContent)
const lineText = (node) => (node.childNodes.length ? node.childNodes.map((c) => (c instanceof FakeEl ? lineText(c) : String(c))).join('') : node.textContent);

// doc: what GET runs/:id answers (a function of the call count); artifacts: name -> content
const LIST = { active: RUN, runs: [{ runId: RUN, status: 'awaiting_approval', phase: 'approve_plan', task: 'Fix', createdAt: '2026-11-09T10:00:00Z', updatedAt: '2026-11-09T10:01:00Z' }] };

// runStatusCode: the HTTP status of GET runs/:id (a function of the call count); artifactStatus: name -> HTTP status
function harness({ doc, artifacts = {}, list = () => LIST, runStatusCode = () => 200, artifactStatus = {} }) {
  const $ = installDom();
  const html = [];
  // any markup assignment anywhere in the view is recorded
  Object.defineProperty(FakeEl.prototype, 'innerHTML', { configurable: true, get() { return ''; }, set(v) { html.push(v); } });
  const requests = [];
  let runCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body ? JSON.parse(opts.body) : null });
    let data;
    let code = opts.method === 'POST' ? 202 : 200;
    if (url === BASE) data = list();
    else if (url.startsWith(`${BASE}/runs/${RUN}?after=`)) {
      code = runStatusCode(runCalls);
      data = code === 200 ? doc(runCalls) : { error: 'Pipeline run not found' };
      runCalls += 1;
    } else if (url.startsWith(`${BASE}/runs/${RUN}/artifacts/`)) {
      const name = url.split('/').at(-1);
      code = artifactStatus[name] ?? 200;
      data = code === 200 ? { name, content: artifacts[name] ?? '', truncated: false } : { error: 'Not found' };
    } else data = { ok: true };
    return { ok: code < 400, status: code, json: async () => data };
  };
  const timers = fakeTimers();
  const confirms = [];
  const opened = [];
  const view = createPipelineView({ timers, confirm: (o) => confirms.push(o), openRun: (target, onStarted) => opened.push({ target, onStarted }) });
  return { $, view, requests, timers, html, confirms, opened, tick: () => new Promise((r) => setTimeout(r, 15)) };
}

const done = (t, h) => t.after(() => {
  h.view.hide();
  delete FakeEl.prototype.innerHTML;
});
const buttons = (h) => walk(h.$('pv-sections'), (n) => n.dataset.decision);

test('plan gate: Approve and Reject appear while it is pending, and the decision carries its digest and the comment', async (t) => {
  const h = harness({ doc: () => ({ status: runStatus(), live: false, events: [], lastSeq: 3, plan: PLAN, review: null, stderrTail: '' }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' }, 'C:\\code\\my-app');
  await h.tick();
  assert.deepEqual(buttons(h).map((b) => [b.textContent, b.dataset.decision]), [['Approve plan', 'approve'], ['Reject plan', 'reject']]);
  assert.ok(texts(h.$('pv-sections')).includes('deletes files'), 'the risk flag is shown');
  assert.equal(h.$('pv-status').childNodes[1].textContent, 'Waiting for you');
  const comment = walk(h.$('pv-sections'), (n) => n.dataset.focus === 'plan-comment')[0];
  comment.value = ' split it in two ';
  await comment.fire('input');
  await buttons(h).find((b) => b.dataset.decision === 'reject').fire('click');
  const post = h.requests.find((r) => r.method === 'POST');
  assert.equal(post.url, `${BASE}/runs/${RUN}/decision`);
  assert.deepEqual(post.body, { gate: 'plan', decision: 'reject', digest: 'plan-digest-1', comment: 'split it in two' });
  assert.equal(post.headers['X-Scranton-Client'], '1');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.ok(buttons(h).every((b) => b.disabled), 'no second decision while the first is on its way');
});

test('delivery gate: Apply names the project folder and approves with the delivery digest', async (t) => {
  const delivery = runStatus({
    phase: 'deliver', node: 'package',
    pending: { gate: 'delivery', digest: 'diff-digest-9', files: [{ path: 'src/parse.py', action: 'M', added: 1, removed: 1 }], path: 'C:\\runs\\candidate.diff' },
    artifacts: { plan: 'p', diff: 'd', report_md: null, report_json: null },
  });
  const diff = 'diff --git a/src/parse.py b/src/parse.py\n--- a/src/parse.py\n+++ b/src/parse.py\n@@ -1 +1 @@\n-return x\n+return x or [] # <script>alert(1)</script>\n';
  const h = harness({ doc: () => ({ status: delivery, live: false, events: [], lastSeq: 9, plan: PLAN, review: null, stderrTail: '' }), artifacts: { diff } });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  await h.tick();
  const apply = buttons(h).find((b) => b.dataset.decision === 'approve');
  assert.equal(apply.textContent, 'Apply to my-app');
  assert.equal(apply.title, 'C:\\code\\my-app');
  assert.ok(buttons(h).some((b) => b.textContent === 'Keep as patch only'));
  const lines = walk(h.$('pv-sections'), (n) => n.className === 'dl');
  assert.deepEqual(lines.map((l) => l.dataset.kind), ['file', 'meta', 'meta', 'hunk', 'del', 'add']);
  assert.equal(lines.at(-1).textContent, '+return x or [] # <script>alert(1)</script>', 'diff text is shown as text');
  await apply.fire('click');
  assert.deepEqual(h.requests.find((r) => r.method === 'POST').body, { gate: 'delivery', decision: 'approve', digest: 'diff-digest-9' });
  assert.deepEqual(h.html, [], 'nothing was assigned as markup');
});

test('a decided gate leaves no buttons behind, and focus goes to the section heading', async (t) => {
  let decided = false;
  const h = harness({
    doc: () => (decided
      ? { status: runStatus({ status: 'running', phase: 'implement', pending: null }), live: true, events: [], lastSeq: 5, plan: PLAN, review: null, stderrTail: '' }
      : { status: runStatus(), live: false, events: [], lastSeq: 3, plan: PLAN, review: null, stderrTail: '' }),
  });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const approve = buttons(h).find((b) => b.dataset.decision === 'approve');
  approve.focus();
  decided = true;
  await approve.fire('click');
  await h.tick();
  assert.deepEqual(buttons(h), [], 'the gate is gone once the engine took the decision up');
  assert.equal(document.activeElement.textContent, 'Plan', 'focus is on the Plan heading, not lost');
});

test('untrusted plan, event and stderr text is rendered through textContent only', async (t) => {
  const h = harness({
    doc: () => ({
      status: runStatus({ status: 'failed', phase: 'done', node: 'finalize', pending: null, failure: { failure_class: 'security', code: 'path_escape', message: EVIL, node: 'apply_edits' } }),
      live: false, lastSeq: 2, plan: PLAN, review: { verdict: 'request_changes', summary: EVIL, criteria: [], findings: [{ severity: 'blocking', category: 'security', path: EVIL, description: EVIL }] },
      events: [{ seq: 1, ts: '2026-11-09T10:00:00Z', type: 'warning', node: 'plan', data: { code: 'x', message: EVIL } }], stderrTail: EVIL,
    }),
  });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const all = [...texts(h.$('pv-sections')), ...texts(h.$('pv-side'))];
  assert.ok(all.includes(`Guard the parser ${EVIL}`));
  assert.ok(all.includes(EVIL), 'failure message, review text and stderr are there as text');
  assert.ok(all.some((x) => x.includes(`x: ${EVIL}`)), 'the event detail too');
  assert.deepEqual(h.html, []);
});

test('polling: 1 s while the run is live, 5 s once it waits, nothing after the chat is left', async (t) => {
  let n = 0;
  const h = harness({
    doc: () => (n++ === 0
      ? { status: runStatus({ status: 'running', phase: 'plan', pending: null }), live: true, events: [], lastSeq: 1, plan: null, review: null, stderrTail: '' }
      : { status: runStatus(), live: false, events: [], lastSeq: 2, plan: PLAN, review: null, stderrTail: '' }),
  });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.deepEqual(h.timers.delays, [1000]);
  assert.match(h.requests.find((r) => r.url.includes('?after=')).url, /\?after=0$/);
  await [...h.timers.pending.values()][0]();
  await h.tick();
  assert.deepEqual(h.timers.delays, [1000, 5000]);
  assert.match(h.requests.filter((r) => r.url.includes('?after=')).at(-1).url, /\?after=1$/, 'the next poll asks only for newer events');
  h.view.hide();
  assert.equal(h.timers.pending.size, 0);
  assert.equal(h.view.polling(), false);
  assert.equal(h.$('pipeline-view').hidden, true);
});

test('New run opens no drawer while a run of the chat is still active, and says why', async (t) => {
  const h = harness({ doc: () => ({ status: runStatus({ status: 'succeeded', phase: 'done', node: 'finalize', pending: null }), live: false, events: [], lastSeq: 4, plan: null, review: null, stderrTail: '' }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' }, 'C:\\code\\my-app');
  await h.tick();
  assert.equal(h.view.canStart(), false, 'the fake list still names the run as active');
  h.view.newRun();
  assert.equal(h.opened.length, 0, 'no drawer while a run of the chat is active');
  assert.match(h.$('pv-msg').textContent, /still going/);
});

test('a started run is waited for at 1 s, and the finished one is not shown meanwhile', async (t) => {
  const done1 = { active: null, runs: [{ ...LIST.runs[0], status: 'succeeded' }] };
  let listed = done1;
  const h = harness({
    list: () => listed,
    doc: () => ({ status: runStatus({ status: 'succeeded', phase: 'done', node: 'finalize', pending: null }), live: false, events: [], lastSeq: 4, plan: null, review: null, stderrTail: '' }),
  });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' }, 'C:\\code\\my-app');
  await h.tick();
  h.view.newRun();
  const { target, onStarted } = h.opened[0];
  assert.equal(target.project, 'core');
  const body = { task: 'Demo', demo: true, delivery: 'apply' };
  await target.startPipeline(body);
  const post = h.requests.find((r) => r.method === 'POST');
  assert.deepEqual([post.url, post.body], [`${BASE}/runs`, body]);
  onStarted({ ok: true, status: 202, data: { ok: true, runId: 'fedcba987654' } });
  await h.tick();
  assert.equal(h.$('pv-msg').textContent, 'Starting the run...');
  assert.equal(h.$('pv-status').hidden, true, 'the finished run is not shown as if it were the new one');
  assert.equal(h.timers.delays.at(-1), 1000);
  listed = { active: 'fedcba987654', runs: [...done1.runs, { runId: 'fedcba987654', status: 'running', phase: 'prepare', task: 'Demo' }] };
  await [...h.timers.pending.values()].at(-1)();
  await h.tick();
  assert.match(h.requests.at(-1).url, /\/runs\/fedcba987654\?after=0$/);
});

test('Cancel asks first and posts an empty body; Resume is offered only for a suspended run', async (t) => {
  const h = harness({ doc: () => ({ status: runStatus({ status: 'suspended', resumable: true, pending: null }), live: false, events: [], lastSeq: 1, plan: null, review: null, stderrTail: '' }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(h.$('pv-resume').hidden, false);
  assert.equal(h.$('pv-cancel').hidden, false);
  await h.$('pv-cancel').fire('click');
  assert.equal(h.confirms.length, 1);
  assert.equal(h.requests.filter((r) => r.method === 'POST').length, 0, 'nothing is sent before the confirm');
  await h.confirms[0].action();
  assert.deepEqual(h.requests.filter((r) => r.method === 'POST').map((r) => [r.url, r.body]), [[`${BASE}/runs/${RUN}/cancel`, {}]]);
});

const fire = async (h) => {
  await [...h.timers.pending.values()].at(-1)();
  await h.tick();
};
const runGets = (h) => h.requests.filter((r) => r.url.includes('?after='));

// finding 2 (reverting `if (c.status !== 'passed' && c.outputTail.trim()) li.append(outputTail(c))` fails this)
test('checks: a check that did not pass offers its output tail on demand, as text; a passed one offers nothing', async (t) => {
  const tail = `AssertionError: expected [] ${EVIL}`;
  const h = harness({
    doc: () => ({
      status: runStatus({ status: 'running', phase: 'implement', node: 'verify', pending: null, checks: [
        { id: 'unit', kind: 'test', status: 'failed', required: true, duration_s: 2.1, output_tail: tail },
        { id: 'lint', kind: 'lint', status: 'passed', required: true, duration_s: 0.3, output_tail: '' },
      ] }),
      live: true, events: [], lastSeq: 2, plan: null, review: null, stderrTail: '',
    }),
  });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const tails = walk(h.$('pv-sections'), (n) => n.className === 'pv-tail');
  assert.equal(tails.length, 1, 'only the failed check has an output disclosure');
  assert.equal(tails[0].open, false, 'closed until asked for');
  assert.equal(tails[0].childNodes[0].textContent, 'Output');
  assert.equal(tails[0].childNodes[1].className, 'exit-tail');
  assert.equal(tails[0].childNodes[1].textContent, tail, 'the tail is preformatted text');
  assert.deepEqual(h.html, []);
});

// finding 3 (reverting the `failed ? [failed, 'critical']` branch of render() fails this)
test('a run that could not start says so inverted, once, without a stepper, instead of "Starting the run..."', async (t) => {
  const NEW = 'fedcba987654';
  const listed = { active: null, runs: [{ runId: NEW, status: 'failed', phase: null, task: 'Fix', createdAt: '2026-11-09T10:00:00Z' }] };
  const h = harness({ list: () => listed, doc: () => null });
  done(t, h);
  globalThis.fetch = ((inner) => async (url, opts) => (url.startsWith(`${BASE}/runs/${NEW}?after=`)
    ? { ok: true, status: 200, json: async () => ({ status: null, live: false, events: [], lastSeq: 0, plan: null, review: null, stderrTail: '', launchError: { code: 2, message: 'invalid_input/bad_config' } }) }
    : inner(url, opts)))(globalThis.fetch);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(h.$('pv-msg').textContent, 'The run could not start: invalid_input/bad_config');
  assert.equal(h.$('pv-msg').dataset.tone, 'critical');
  assert.equal(h.$('pv-stepper').hidden, true);
  assert.equal(h.$('pv-status').hidden, true, 'no status pill for a run that has no status');
  assert.equal(h.$('pv-announce').textContent, 'The run could not start: invalid_input/bad_config');
  assert.equal(h.view.canStart(), true, 'the next run may be started');
  assert.equal(h.timers.delays.at(-1), 5000);
  h.$('pv-announce').textContent = '';
  await fire(h);
  assert.equal(h.$('pv-announce').textContent, '', 'announced once');
});

// finding 3 (reverting `else if (fresh && (!run.live || run.launchError)) deciding = null;` fails this)
test('a decision whose engine call fails re-enables the gate and says why in the run line', async (t) => {
  let n = 0;
  const waiting = { status: runStatus(), live: false, events: [], lastSeq: 3, plan: PLAN, review: null, stderrTail: '' };
  const h = harness({ doc: () => (n++ === 0 ? waiting : { ...waiting, launchError: { code: 2, message: 'stale_digest' } }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  await buttons(h).find((b) => b.dataset.decision === 'approve').fire('click');
  await h.tick();
  assert.ok(buttons(h).every((b) => !b.disabled), 'the gate can be answered again');
  assert.equal(h.$('pv-msg').textContent, 'The decision could not be carried out: stale_digest');
  assert.equal(h.$('pv-msg').dataset.tone, 'critical');
  const status = walk(h.$('pv-sections'), (n) => n.dataset.focus === 'gate-status')[0];
  assert.equal(status.textContent, '', 'the failure is said once, in the run line');
});

// finding 3 (same line): no launchError, but the engine call is over and the gate is the same one
test('"Decision sent" clears once the run is not live and the gate it answered still waits', async (t) => {
  let n = 0;
  const h = harness({ doc: () => ({ status: runStatus(), live: n++ === 1, events: [], lastSeq: 3, plan: PLAN, review: null, stderrTail: '' }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  await buttons(h).find((b) => b.dataset.decision === 'approve').fire('click');
  await h.tick();
  assert.ok(buttons(h).every((b) => b.disabled), 'still on its way while the engine call is live');
  await fire(h);
  assert.ok(buttons(h).every((b) => !b.disabled), 'the engine call ended without taking the gate up');
});

// finding 3 (reverting `poller.stop()` in the 404 branch of load() fails this)
test('a run the server does not know any more stops the polling and says it was not found', async (t) => {
  const h = harness({ doc: () => ({ status: runStatus(), live: false, events: [], lastSeq: 1, plan: null, review: null, stderrTail: '' }), runStatusCode: () => 404 });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(h.$('pv-msg').textContent, 'This run was not found in the chat. It may have been removed.');
  assert.equal(h.view.polling(), false);
  assert.equal(h.timers.pending.size, 0);
  assert.equal(runGets(h).length, 1);
});

// finding 4 (reverting the `have.failedAt === at` condition in fetchArtifacts fails this)
test('a failed run shows its partial diff as changes up to the last passing step, and a failed artifact is not asked for again', async (t) => {
  const failed = (over = {}) => ({
    status: runStatus({ status: 'failed', phase: 'done', node: 'finalize', pending: null, artifacts: { plan: 'p', diff: 'partial.diff', report_md: null, report_json: null },
      failure: { failure_class: 'checks_failed', code: 'exhausted', message: 'unit failed', node: 'verify' }, ...over }),
    live: false, events: [], lastSeq: 9, plan: null, review: null, stderrTail: '',
  });
  const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n';
  const ok = harness({ doc: () => failed(), artifacts: { diff } });
  done(t, ok);
  ok.view.show({ project: 'core', chat: 'c1' });
  await ok.tick();
  await ok.tick();
  assert.ok(ok.requests.some((r) => r.url.endsWith('/artifacts/diff')), 'the diff is asked for although the run failed');
  assert.equal(walk(ok.$('pv-sections'), (n) => n.id === 'pv-h-changes')[0].textContent, 'Changes up to the last passing step');
  ok.view.hide();

  let updated = '2026-11-09T10:01:00Z';
  const h = harness({ doc: () => failed({ updated_at: updated }), artifactStatus: { diff: 404 } });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  await h.tick();
  const diffGets = () => h.requests.filter((r) => r.url.endsWith('/artifacts/diff')).length;
  assert.equal(diffGets(), 1);
  assert.ok(texts(h.$('pv-sections')).includes('The diff: It could not be loaded (HTTP 404).'));
  await fire(h);
  await fire(h);
  assert.equal(diffGets(), 1, 'the same run state does not ask again');
  updated = '2026-11-09T10:02:00Z';
  await fire(h);
  assert.equal(diffGets(), 2, 'a changed run may have it now');
});

// ------------------------------------------------------------ sections 16 and 17

const doc = (status, over = {}) => ({ status, live: false, events: [], lastSeq: 1, plan: PLAN, review: null, stderrTail: '', ...over });

// guards `revised ? \`Revised plan (revision ${gate.revision}) waits for your approval\` : ...` and the `Why:` line in planSection
test('revised plan gate: titled with its revision, says why, lists the replan flag, same Approve / Reject', async (t) => {
  const h = harness({ doc: () => doc(runStatus({
    progress: { step_index: -1, step_count: 1, step_title: '', attempt: 0, review_round: 0, plan_revision: 1, replans_left: 0, steps_done: 1, lanes: [] },
    pending: { gate: 'plan', digest: 'plan-digest-r1', risk_flags: ['replan'], revision: 1, replan_reason: 'step_blocked: the module does not exist', path: 'C:\\runs\\plan.json' },
  })) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const title = walk(h.$('pv-sections'), (n) => n.className === 'pv-gate-title')[0];
  assert.equal(title.textContent, 'Revised plan (revision 1) waits for your approval');
  const all = texts(h.$('pv-sections'));
  assert.ok(all.includes('Why: step_blocked: the module does not exist'));
  assert.ok(all.includes('replan'), 'the replan risk flag is shown');
  assert.deepEqual(buttons(h).map((b) => b.dataset.decision), ['approve', 'reject']);
  assert.match(lineText(h.$('pv-meta')), /plan revision 1 · 0 replans left/);
  await buttons(h)[0].fire('click');
  assert.deepEqual(h.requests.find((r) => r.method === 'POST').body, { gate: 'plan', decision: 'approve', digest: 'plan-digest-r1' });
});

// the real engine sends the reason as a string (above); an older fake sent an object, anything else degrades to no line
test('revised plan gate: an object reason reads like the string, an unreadable one leaves the Why line out', async (t) => {
  const gateWith = (reason) => harness({ doc: () => doc(runStatus({
    progress: { step_index: -1, step_count: 1, plan_revision: 1, replans_left: 0, steps_done: 0, lanes: [] },
    pending: { gate: 'plan', digest: 'd1', risk_flags: ['replan'], revision: 1, replan_reason: reason },
  })) });
  const old = gateWith({ code: 'step_blocked', message: 'no API', scope: 's1' });
  done(t, old);
  old.view.show({ project: 'core', chat: 'c1' });
  await old.tick();
  assert.ok(texts(old.$('pv-sections')).includes('Why: step_blocked: no API'));
  for (const odd of [{ scope: 's1' }, ['a'], 7]) {
    const h = gateWith(odd);
    done(t, h);
    h.view.show({ project: 'core', chat: 'c1' });
    await h.tick();
    const all = texts(h.$('pv-sections'));
    assert.ok(!all.some((x) => x.startsWith('Why:')), JSON.stringify(odd));
    assert.ok(!all.some((x) => /object Object/.test(x)), JSON.stringify(odd));
    assert.equal(walk(h.$('pv-sections'), (n) => n.className === 'pv-gate-title')[0].textContent, 'Revised plan (revision 1) waits for your approval');
  }
});

test('an original plan gate says nothing about revisions', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ progress: { step_index: -1, step_count: 2, plan_revision: 0, replans_left: 1, steps_done: 0, lanes: [] } })) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(walk(h.$('pv-sections'), (n) => n.className === 'pv-gate-title')[0].textContent, 'The plan waits for your approval');
  assert.doesNotMatch(lineText(h.$('pv-meta')), /revision|replan/);
});

// guards `if (s.progress.lanes.length) main.push(['lanes', ...])` in renderSections
test('parallel lanes: one hairline list of the lanes replaces the step figure while a wave runs', async (t) => {
  const lanes = [
    { step_id: 's2', title: 'Parse empty input', state: 'running', attempt: 1 },
    { step_id: 's3', title: `Docs ${EVIL}`, state: 'failed', attempt: 2 },
    { step_id: 's4', title: 'Types', state: 'merged', attempt: 1 },
  ];
  const h = harness({ doc: () => doc(runStatus({ status: 'running', phase: 'implement', node: 'run_lane', pending: null,
    progress: { step_index: 1, step_count: 4, step_title: 'Parse empty input', attempt: 1, review_round: 0, plan_revision: 0, replans_left: 1, steps_done: 1, lanes } }), { live: true }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const sec = walk(h.$('pv-sections'), (n) => n.dataset.section === 'lanes')[0];
  assert.ok(sec, 'the lanes section is there');
  assert.equal(h.$('pv-sections').childNodes[0], sec, 'first: it is what is happening now');
  const rows = walk(sec, (n) => n.className === 'pv-lane');
  assert.deepEqual(rows.map((r) => [r.dataset.state, r.dataset.loud]), [['running', 'false'], ['failed', 'true'], ['merged', 'false']]);
  assert.deepEqual(rows.map((r) => r.childNodes.slice(2).map((c) => c.textContent)), [['running', 'attempt 1'], ['failed', 'attempt 2'], ['merged', 'attempt 1']]);
  assert.ok(texts(sec).includes(`Docs ${EVIL}`), 'the title is text');
  assert.equal(walk(sec, (n) => n.className === 'pv-lanes').length, 1, 'one list, no box per lane');
  assert.match(lineText(h.$('pv-meta')), /1 of 4 steps done/);
  assert.doesNotMatch(lineText(h.$('pv-meta')), /step 2\/4/);
  assert.deepEqual(h.html, []);
});

test('no lanes: no lanes section, and the run line keeps step i/n', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ status: 'running', phase: 'implement', node: 'verify', pending: null,
    progress: { step_index: 1, step_count: 4, step_title: 'Parse', attempt: 1, steps_done: 1, lanes: [] } }), { live: true }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(walk(h.$('pv-sections'), (n) => n.dataset.section === 'lanes').length, 0);
  assert.match(lineText(h.$('pv-meta')), /step 2\/4 Parse/);
});

// guards `if (ev.lane) text.append(el('span', 'mono pv-ev-lane', ev.lane), ...)` in activitySection
test('activity: wave and re-planning events read as words, lane events carry the lane as a quiet prefix, unknown ones still render', async (t) => {
  const events = [
    { seq: 1, ts: '2026-11-10T10:00:00Z', type: 'wave_started', node: 'select_step', data: { wave: 1, steps: ['s2', 's3'] } },
    { seq: 2, ts: '2026-11-10T10:00:01Z', type: 'lane_started', node: 'run_lane', data: { lane: 's2' } },
    { seq: 3, ts: '2026-11-10T10:00:09Z', type: 'lane_finished', node: 'run_lane', data: { lane: 's3', status: 'failed' } },
    { seq: 4, ts: '2026-11-10T10:00:10Z', type: 'wave_merged', node: 'merge_wave', data: { wave: 1, merged: ['s2'], failed: ['s3'] } },
    { seq: 5, ts: '2026-11-10T10:00:11Z', type: 'replan_requested', node: 'merge_wave', data: { code: 'lane_blocked', message: 'no such API', scope: 'step:s3' } },
    { seq: 6, ts: '2026-11-10T10:00:12Z', type: 'replanned', node: 'replan', data: { revision: 1 } },
    { seq: 7, ts: '2026-11-10T10:00:13Z', type: 'quantum_event', node: 'nowhere', data: { lane: 's9', anything: { deep: true } }, unknown_top: 1 },
  ];
  const h = harness({ doc: () => doc(runStatus({ status: 'running', phase: 'plan', node: 'replan', pending: null, future_field: [1, 2] }), { events, lastSeq: 7, live: true }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const rows = walk(h.$('pv-side'), (n) => n.className === 'pv-event');
  assert.equal(rows.length, 7, 'every event has its row, unknown included');
  const said = (li) => {
    const cell = li.childNodes[2];
    return cell.childNodes.length ? cell.childNodes.map((c) => c.textContent) : [cell.textContent];
  };
  assert.deepEqual(rows.map(said).reverse(), [
    ['select_step · wave 1: s2, s3'],
    ['s2', 'run_lane · started'],
    ['s3', 'run_lane · failed'],
    ['merge_wave · wave 1: merged s2 · not merged s3'],
    ['merge_wave · lane_blocked: no such API'],
    ['replan · plan revision 1'],
    ['s9', 'nowhere'],
  ]);
  assert.equal(walk(h.$('pv-side'), (n) => n.className === 'mono pv-ev-lane').length, 3);
  assert.equal(rows.find((r) => r.childNodes[1].textContent === 'replan requested').dataset.loud, 'true');
});

test('sandbox fragment of the run line comes from status.sandbox', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ sandbox: { mode: 'host', isolated: false } })) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.match(lineText(h.$('pv-meta')), /host, no OS isolation$/);
  const d = harness({ doc: () => doc(runStatus()) });
  done(t, d);
  d.view.show({ project: 'core', chat: 'c1' });
  await d.tick();
  assert.match(lineText(d.$('pv-meta')), /Docker \(isolated, no network\)$/);
  assert.equal(walk(d.$('pv-meta'), (n) => n.title).length, 0, 'an older engine: no sentence, no title');
});

// exactly what engine/src/scranton_pipeline/tools/sandbox.py sandbox_description sends
const DOCKER_SENTENCE = 'Docker container with read-only root and no network for checks; shares the Docker VM kernel; workspace mounted read-write; setup commands with network can reach the internet and local services (including host.docker.internal).';
const DOCKER_SANDBOX = { mode: 'docker', isolated: true, image: 'scranton-pipeline-sandbox:0.1.0', isolation: DOCKER_SENTENCE, setup_network: false };

// guards `node.title = sb.full;` and `if (sb?.more) e.meta.append(el('span', 'hint pv-block', sb.full));` in renderMeta
test('sandbox fragment: the first clause in the run line, the whole sentence as its title and once in a quiet line', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ sandbox: DOCKER_SANDBOX })) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const meta = h.$('pv-meta');
  const [frag] = walk(meta, (n) => n.title);
  assert.equal(frag.textContent, 'Docker container with read-only root and no network for checks');
  assert.equal(frag.title, DOCKER_SENTENCE);
  const full = walk(meta, (n) => n.className === 'hint pv-block');
  assert.deepEqual(full.map((n) => n.textContent), [DOCKER_SENTENCE], 'said once, quietly');
  assert.equal(lineText(meta).split(DOCKER_SENTENCE).length - 1, 1);
  assert.ok(lineText(meta).endsWith(` ${DOCKER_SENTENCE}`), 'apart from the run line in plain text too');
  assert.doesNotMatch(lineText(meta), /Docker · Docker/);
  assert.match(lineText(meta), /^Approval · 1 model call · .* · Docker container with read-only root and no network for checks/);
  assert.deepEqual(h.html, [], 'textContent only');

  const host = harness({ doc: () => doc(runStatus({ sandbox: { mode: 'host', isolated: false, image: null, isolation: 'No OS isolation.', setup_network: false } })) });
  done(t, host);
  host.view.show({ project: 'core', chat: 'c1' });
  await host.tick();
  assert.match(lineText(host.$('pv-meta')), /· host · No OS isolation$/);
  assert.equal(walk(host.$('pv-meta'), (n) => n.title)[0].title, 'No OS isolation.');
  assert.equal(walk(host.$('pv-meta'), (n) => n.className === 'hint pv-block').length, 0, 'nothing left out, no second line');
});

// guards `if (e.meta.dataset.key === key) return;` in renderMeta
test('sandbox fragment: a poll that changes nothing keeps the titled node, so its tooltip stays up', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ sandbox: DOCKER_SANDBOX })) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const before = walk(h.$('pv-meta'), (n) => n.title)[0];
  await fire(h);
  assert.ok(h.requests.filter((r) => r.url.includes('?after=')).length >= 2, 'polled again');
  assert.equal(walk(h.$('pv-meta'), (n) => n.title)[0], before);
});

// guards `if (s.sandbox.setupNetwork) parts.push('setup had network access');` in runLine
test('sandbox fragment: setup with network access is said once in the run line', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ sandbox: { ...DOCKER_SANDBOX, setup_network: true } })) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const text = lineText(h.$('pv-meta'));
  assert.equal(text.split('setup had network access').length - 1, 1);
  assert.match(text, /no network for checks · setup had network access/);
});

// ------------------------------------------------------------ sections 21, 23 and 24: evidence grounding, guidance

// exactly the status.grounding example of section 24
const G24 = {
  mode: 'enforce', answer: 1.0, trajectory: 0.875, unadjusted: 0.9375, violation_rate: 0.1667, adjusted: 0.651, tier: 'major', outputs: 6,
  violations: { false_absence: 1 }, criteria: [{ id: 'c1', verified_by: 'checks', state: 'demonstrated', by: 'baseline', checks: ['unit'] }],
  probe: { status: 'not_needed' },
};
const NO_JUNK = /object Object|NaN|undefined|null/;
const section = (h, name) => walk(h.$('pv-sections'), (n) => n.dataset.section === name)[0];
const REVIEWED = { verdict: 'approve', summary: 'Looks right', criteria: [{ id: 'c1', status: 'met', evidence: 'K-0123456789 unit passes' }], findings: [] };

// guards `if (evidence) detail.push(evidenceBlock(evidence));` and `if (gate.riskFlags.length) detail.push(riskFlags(gate.riskFlags));`
// in changesSection, the score lines of evidenceBlock and `if (r.criteria.length && !decided)` in reviewSection
test('delivery gate: Evidence shows the decided criteria, the score and its parts, the violations and the new risk flags in words, once', async (t) => {
  const delivery = runStatus({
    phase: 'deliver', node: 'package', grounding: G24,
    pending: { gate: 'delivery', digest: 'diff-digest-9', files: [{ path: 'src/parse.py', action: 'M', added: 1, removed: 1 }], path: 'C:\\runs\\candidate.diff',
      risk_flags: ['criteria_not_demonstrated', 'grounding_violations'], grounding: G24 },
    artifacts: { plan: 'p', diff: 'd', report_md: null, report_json: null },
  });
  const h = harness({ doc: () => doc(delivery, { review: REVIEWED }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  await h.tick();
  const gate = walk(h.$('pv-sections'), (n) => n.className === 'pv-gate')[0];
  const [ev] = walk(gate, (n) => n.className === 'pv-evidence');
  assert.ok(ev, 'the evidence is in the gate, where the decision is made');
  assert.equal(walk(ev, (n) => n.className === 'pv-gate' || n.className === 'pv-failure').length, 0, 'no box inside the box');
  const said = texts(ev);
  for (const s of ['Evidence', 'c1', 'Empty input returns []', 'shown by checks', ' · failed before the change, passes now · checks: unit',
    'Evidence score 0.65 · major', 'answer 1.00 · trajectory 0.88 · 17% of outputs with a violation', 'Violations', '1', 'claimed something was missing that exists']) {
    assert.ok(said.includes(s), s);
  }
  assert.ok(!said.some((x) => x.startsWith('Counterfactual probe')), 'probe not needed: no line');
  assert.ok(!said.includes('observe only - nothing was rejected'));
  assert.deepEqual(walk(gate, (n) => n.className === 'badge').map((b) => [b.textContent, b.dataset.tone]), [
    ["A criterion's checks passed before the change too", 'loud'], ['Output that was not backed by evidence was accepted (observe only)', 'loud'],
  ]);
  assert.deepEqual(said.slice(said.indexOf('Violations'), said.indexOf('Violations') + 3), ['Violations', 'Rejected and repaired:', '1'], 'one lead-in, then the counts');
  const all = texts(h.$('pv-sections'));
  assert.equal(all.filter((x) => x === 'shown by checks').length, 1, 'the criterion state is said once');
  assert.equal(all.filter((x) => x === 'Evidence').length, 1, 'one Evidence block');
  assert.ok(!texts(section(h, 'review')).includes('Criteria'), 'the review leaves its criteria list to the evidence');
  assert.ok(texts(section(h, 'review')).includes('Looks right'), 'the review summary stays');
  assert.equal(section(h, 'result'), undefined);
  assert.ok(!all.some((x) => NO_JUNK.test(x)));
  assert.deepEqual(h.html, []);
});

// guards `if (evidence) root.append(evidenceBlock(evidence));` in resultSection, the observe and probe lines of evidenceBlock,
// and `if (!g || (!g.outputs && !g.criteria.length)) return null;` in evidenceView
test('finished run: the result carries the evidence once; observe mode says nothing was rejected; an older engine shows no Evidence', async (t) => {
  const g = { ...G24, mode: 'observe', violations: {}, tier: 'clean', violation_rate: 0, adjusted: 0.9375,
    criteria: [{ id: 'c1', verified_by: 'checks', state: 'demonstrated', by: 'probe', checks: ['unit'] }], probe: { status: 'demonstrated' } };
  const finished = (grounding) => runStatus({ status: 'succeeded', phase: 'done', node: 'finalize', pending: null, ...(grounding ? { grounding } : {}) });
  const h = harness({ doc: () => doc(finished(g), { review: REVIEWED }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const said = texts(section(h, 'result'));
  for (const s of ['Evidence', 'Empty input returns []', ' · the new tests fail without the change · checks: unit', 'Evidence score 0.94 · clean',
    'answer 1.00 · trajectory 0.88 · 0% of outputs with a violation', 'observe only - nothing was rejected', 'Counterfactual probe: the new tests fail without the change']) {
    assert.ok(said.includes(s), s);
  }
  assert.ok(!said.includes('Violations'), 'no violations, no list');
  assert.equal(texts(h.$('pv-sections')).filter((x) => x === 'Evidence').length, 1);

  // guards `in ${nodeLabel(s.failure.node)}` in resultSection
  const f = harness({ doc: () => doc(runStatus({ status: 'failed', phase: 'done', node: 'finalize', pending: null, grounding: G24,
    failure: { failure_class: 'limits', code: 'max_active_seconds', message: 'time is up', node: 'ground' } })) });
  done(t, f);
  f.view.show({ project: 'core', chat: 'c1' });
  await f.tick();
  assert.ok(texts(section(f, 'result')).includes('in Check evidence'));
  assert.ok(texts(section(f, 'result')).includes('Evidence score 0.65 · major'), 'a failed run keeps what was evaluated');

  for (const [what, grounding] of [['an older engine', null], ['nothing evaluated yet', { ...G24, outputs: 0, criteria: [], violations: {} }]]) {
    const o = harness({ doc: () => doc(finished(grounding), { review: REVIEWED }) });
    done(t, o);
    o.view.show({ project: 'core', chat: 'c1' });
    await o.tick();
    assert.equal(walk(o.$('pv-sections'), (n) => n.className === 'pv-evidence').length, 0, what);
    assert.ok(!texts(o.$('pv-sections')).includes('Evidence'), what);
    assert.ok(texts(section(o, 'review')).includes('Criteria'), `${what}: the review keeps its criteria`);
  }
});

// guards `el('p', 'hint pv-text', v.violationsLead)` in evidenceBlock
test('observe mode with violations: the counts are introduced as accepted, and the risk flag says it was accepted', async (t) => {
  const g = { ...G24, mode: 'observe' };
  const h = harness({ doc: () => doc(runStatus({ phase: 'deliver', node: 'package', grounding: g,
    pending: { gate: 'delivery', digest: 'd', files: [], risk_flags: ['grounding_violations'], grounding: g } }), { review: REVIEWED }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const said = texts(walk(h.$('pv-sections'), (n) => n.className === 'pv-evidence')[0]);
  assert.deepEqual(said.slice(said.indexOf('Violations'), said.indexOf('Violations') + 4),
    ['Violations', 'Accepted without evidence:', '1', 'claimed something was missing that exists']);
  assert.ok(!said.includes('Rejected and repaired:'));
  const gate = walk(h.$('pv-sections'), (n) => n.className === 'pv-gate')[0];
  assert.deepEqual(walk(gate, (n) => n.className === 'badge').map((b) => b.textContent), ['Output that was not backed by evidence was accepted (observe only)']);
});

// the engine's own status.grounding objects (fixtures/engine-grounding.js) in the result of a finished run
test('finished run: the real engine objects render once, in words, without junk; a review criterion never says all required checks', async (t) => {
  const review = { verdict: 'approve', summary: 'Adds sum', criteria: [{ id: 'sum', status: 'unclear', evidence: 'no test covers negative numbers' }], findings: [] };
  const expected = [
    ['shown by checks', ' · failed before the change, passes now · checks: test', 'Evidence score 0.52 · major', 'answer 1.00 · trajectory 0.83 · 25% of outputs with a violation',
      'planned a change to a file it had not read'],
    ['passes, but passed before the change too', ' · checks: test', 'Evidence score 0.38 · major', 'answer 1.00 · trajectory 0.33 · 25% of outputs with a violation',
      'planned a change to a file it had not read'],
    ['unclear', 'no test covers negative numbers', 'Evidence score 0.64 · major', 'answer 1.00 · trajectory 1.00 · 20% of outputs with a violation',
      'criterion marked met without evidence'],
  ];
  for (const [i, grounding] of REAL_GROUNDING.entries()) {
    const h = harness({ doc: () => doc(runStatus({ status: 'succeeded', phase: 'done', node: 'finalize', pending: null, grounding }), { review }) });
    done(t, h);
    h.view.show({ project: 'core', chat: 'c1' });
    await h.tick();
    const said = texts(section(h, 'result'));
    for (const s of ['Evidence', 'sum', 'Violations', 'Rejected and repaired:', '1', ...expected[i]]) assert.ok(said.includes(s), `${i}: ${s}`);
    assert.equal(said.filter((x) => x === expected[i][0]).length, 1, `${i}: the state once`);
    assert.ok(!said.some((x) => x.includes('all required checks')), `${i}: named checks or a review criterion`);
    assert.ok(!said.some((x) => x.startsWith('Counterfactual probe') || x.startsWith('observe only')), `${i}: probe not needed, enforce`);
    assert.ok(!texts(h.$('pv-sections')).some((x) => NO_JUNK.test(x)), `${i}: no junk`);
    assert.ok(!texts(section(h, 'review')).includes('Criteria'), `${i}: one state per criterion`);
  }
});

// guards `if (v.rating) root.append(...)` and `if (v.observeNote)` in evidenceBlock (F10)
test('delivery gate of the real evidence demo: one quiet line under the score says what the tier rates; observe says it once', async (t) => {
  const gateOf = async (grounding) => {
    const h = harness({ doc: () => doc(runStatus({ phase: 'deliver', node: 'package', grounding,
      pending: { gate: 'delivery', digest: 'd', files: [], grounding } }), { review: REVIEWED }) });
    done(t, h);
    h.view.show({ project: 'core', chat: 'c1' });
    await h.tick();
    const ev = walk(h.$('pv-sections'), (n) => n.className === 'pv-evidence')[0];
    return { said: texts(ev), hints: walk(ev, (n) => n.className === 'hint pv-text').map((n) => n.textContent) };
  };
  const rating = 'The score rates how the models worked, not the change itself: 2 of 5 outputs were rejected and repaired.';
  const real = await gateOf(REAL_EVIDENCE_DEMO);
  const at = real.said.indexOf('Evidence score 0.25 · failing');
  assert.deepEqual(real.said.slice(at, at + 3), ['Evidence score 0.25 · failing', 'answer 1.00 · trajectory 0.39 · 40% of outputs with a violation', rating]);
  assert.ok(real.hints.includes(rating), 'quiet, like the parts line');
  assert.ok(!real.said.includes('observe only - nothing was rejected'));
  assert.ok(!real.said.some((x) => NO_JUNK.test(x)));

  const observed = await gateOf({ ...REAL_EVIDENCE_DEMO, mode: 'observe' });
  assert.ok(observed.said.includes('The score rates how the models worked, not the change itself: 2 of 5 outputs were accepted without evidence.'));
  assert.ok(!observed.said.includes('observe only - nothing was rejected'), 'said once, by the new line');
  const uncounted = await gateOf({ ...REAL_EVIDENCE_DEMO, mode: 'observe', outputs: 0 });
  assert.ok(uncounted.said.includes('The score rates how the models worked, not the change itself.'));
  assert.ok(uncounted.said.includes('observe only - nothing was rejected'), 'without a count the note still says the mode');
  const clean = await gateOf({ ...REAL_EVIDENCE_DEMO, tier: 'clean' });
  assert.ok(!clean.said.some((x) => x.startsWith('The score rates')), 'clean needs no explanation');
});

// guards the absence_refuted entry of EVENT_TEXT through activitySection (F10)
test('activity: the real absence_refuted event reads as a refutation with its place', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ status: 'running', phase: 'implement', node: 'implement', pending: null, grounding: REAL_EVIDENCE_DEMO }),
    { events: [REAL_ABSENCE_REFUTED], lastSeq: 36, live: true }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const [row] = walk(h.$('pv-side'), (n) => n.className === 'pv-event');
  assert.equal(row.childNodes[1].textContent, 'absence refuted');
  assert.equal(row.childNodes[2].textContent, 'Refuted: add exists at calculator.py:1');
  assert.equal(row.dataset.loud, undefined);
});

// guards `activityEvents(all)`, `eventLoud(ev, { observe })` and `nodeLabel(ev.node)` in activitySection
test('activity: rejected outputs, verified absences, decided criteria and the probe in words; accepted outputs and procedure events get no row', async (t) => {
  const events = [
    { seq: 1, ts: '2026-11-10T10:00:00Z', type: 'grounding', node: 'plan', data: { role: 'planner', scope: 'plan', accepted: true, violations: [], cited: 0, shown: 4 } },
    { seq: 2, ts: '2026-11-10T10:00:01Z', type: 'grounding', node: 'implement', data: { role: 'implementer', scope: 'step:s2', accepted: false, violations: ['unseen_edit'], cited: 0, shown: 3, lane: 's2' } },
    { seq: 3, ts: '2026-11-10T10:00:02Z', type: 'procedure', node: 'implement', data: { role: 'implementer', scope: 'step:s2', situation: 'implement.repair', matched: true } },
    { seq: 4, ts: '2026-11-10T10:00:03Z', type: 'absence_verified', node: 'implement', data: { kind: 'missing_file', subject: 'src/legacy.py', files_searched: 42 } },
    { seq: 5, ts: '2026-11-10T10:00:04Z', type: 'criteria_decided', node: 'ground', data: { states: { demonstrated: 1, met_not_demonstrated: 1 } } },
    { seq: 6, ts: '2026-11-10T10:00:05Z', type: 'probe_finished', node: 'ground', data: { status: 'not_demonstrated', checks: ['unit'] } },
  ];
  const said = (li) => {
    const cell = li.childNodes[2];
    return cell.childNodes.length ? cell.childNodes.map((c) => c.textContent) : [cell.textContent];
  };
  for (const mode of ['enforce', 'observe']) {
    const h = harness({ doc: () => doc(runStatus({ status: 'running', phase: 'review', node: 'ground', pending: null, grounding: { ...G24, mode } }), { events, lastSeq: 6, live: true }) });
    done(t, h);
    h.view.show({ project: 'core', chat: 'c1' });
    await h.tick();
    const rows = walk(h.$('pv-side'), (n) => n.className === 'pv-event');
    assert.deepEqual(rows.map(said).reverse(), [
      ['s2', `implement · Implementer output ${mode === 'observe' ? 'recorded' : 'rejected'}: edited a file it had not been shown`],
      ['implement · Verified: src/legacy.py was not found in the 42 files models may read'],
      ['Check evidence · criteria decided: 1 shown by checks; 1 passes, but passed before the change too'],
      ['Check evidence · counterfactual probe: the tests pass even without the change (unit)'],
    ], mode);
    assert.equal(rows.at(-1).dataset.loud, mode === 'observe' ? undefined : 'true', `${mode}: the rejection is loud only when it rejected`);
    assert.ok(texts(section(h, 'activity') ?? h.$('pv-side')).includes('4 events, newest first'));
  }
});

// guards `if (s.procedure.enabled && s.procedure.situation) parts.push(...)` in runLine, through the view
test('run line: procedural guidance is one quiet fragment naming the situation', async (t) => {
  const h = harness({ doc: () => doc(runStatus({ status: 'running', phase: 'implement', node: 'implement', pending: null,
    procedure: { enabled: true, name: 'default', digest: 'ab12', situation: 'implement.repair' } }), { live: true }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(lineText(h.$('pv-meta')).split('guidance: implement.repair').length - 1, 1);
  // a situation without guidance enabled is not guidance
  const off = harness({ doc: () => doc(runStatus({ procedure: { enabled: false, name: null, digest: null, situation: 'plan.start' } })) });
  done(t, off);
  off.view.show({ project: 'core', chat: 'c1' });
  await off.tick();
  assert.doesNotMatch(lineText(off.$('pv-meta')), /guidance/);
});

// The shared transcript consumes the existing poller rather than adding a Chat-mode fetch loop.
test('Pipeline Chat uses one poller across repeated shows, reads and Details approval focus', async (t) => {
  const h = harness({ doc: () => doc(runStatus(), { events: [{ seq: 1, type: 'agent_message', data: { role: 'planner', text: 'Plan', final: true } }] }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  const count = h.requests.length;
  for (let i = 0; i < 5; i += 1) {
    h.view.show({ project: 'core', chat: 'c1' });
    h.view.chat();
    h.view.live();
  }
  assert.equal(h.requests.length, count);
  assert.equal(h.timers.pending.size, 1);
  assert.equal(h.view.chat().run.events[0].data.text, 'Plan');
  h.view.review();
  assert.equal(document.activeElement.dataset.focus, 'gate-title');
  assert.equal(buttons(h).length, 2, 'only the existing Details approval controls');
  h.view.hide();
  assert.equal(h.timers.pending.size, 0);
});

test('Pipeline Chat history stays lazy, pages by lastSeq, caches once and forgets on chat switch', async (t) => {
  const old = 'old123456789';
  const h = harness({ list: () => ({ ...LIST, runs: [{ runId: old, status: 'succeeded', task: 'Earlier', reply: { kind: 'answer', text: 'Earlier answer' } }, ...LIST.runs] }), doc: () => doc(runStatus()) });
  done(t, h);
  const baseFetch = globalThis.fetch;
  const pages = [];
  globalThis.fetch = async (url, opts) => {
    if (!url.startsWith(`${BASE}/runs/${old}?after=`)) return baseFetch(url, opts);
    pages.push(url);
    const after = Number(url.split('after=')[1]);
    const events = after === 0 ? Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, type: i === 0 ? 'agent_message' : 'node_started', data: { role: 'planner', text: 'Earlier plan' } })) : [{ seq: 501, type: 'run_reply', data: { kind: 'answer', text: 'Full earlier answer' } }];
    return { ok: true, status: 200, json: async () => ({ status: { status: 'succeeded', task: 'Earlier' }, events, lastSeq: events.at(-1).seq }) };
  };
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  assert.equal(pages.length, 0, 'run-list reply needs no historical fetch');
  assert.equal(h.view.chat().list.runs[0].reply.text, 'Earlier answer');
  assert.deepEqual(await h.view.loadRun(old), { ok: true });
  assert.deepEqual(pages.map((p) => p.split('after=')[1]), ['0', '500']);
  assert.deepEqual(h.view.chat().details[0].events.map((e) => e.seq), [1, 501], 'irrelevant events discarded only after paging');
  await h.view.loadRun(old);
  assert.equal(pages.length, 2);
  h.view.show({ project: 'core', chat: 'other' });
  assert.deepEqual(h.view.chat().details, []);
});

test('Pipeline Chat drains full current event pages immediately without a second timer', async (t) => {
  const h = harness({ doc: (n) => doc(runStatus(), { events: n === 0 ? Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, type: i === 2 ? 'agent_message' : 'node_started', data: { role: 'planner', text: 'First' } })) : [{ seq: 501, type: 'agent_message', data: { role: 'implementer', text: 'Next' } }], lastSeq: n === 0 ? 500 : 501 }) });
  done(t, h);
  h.view.show({ project: 'core', chat: 'c1' });
  await h.tick();
  await h.tick();
  assert.deepEqual(runGets(h).map((r) => r.url.split('after=')[1]), ['0', '500']);
  assert.deepEqual(h.view.chat().run.events.map((e) => e.seq), [3, 501]);
  assert.equal(h.timers.pending.size, 1);
});
