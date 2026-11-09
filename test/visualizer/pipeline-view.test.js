// The pipeline view driven with the fake DOM and a fake server: gate rendering and the decision requests (the
// digest comes from status.pending), the Apply control naming the folder, poll scheduling, and untrusted text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineView } from '../../visualizer/public/js/pipeline-view.js';
import { FakeEl, installDom } from './fixtures/fake-dom.js';

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
