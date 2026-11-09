// Pure logic of the Pipeline UI (.enma/pipeline-contract.md sections 6, 9, 10): diff lines, status and phase
// mapping, the stepper, the run line, request bodies, poll timing, and that no pipeline module writes HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDiff, diffFiles, chatStatusOf, stepper, lastWorkNode, runLine, parseStatus, buildRunBody, buildDecision,
  pollDelay, createPoller, parseEngineInfo, modelGroups, parseModelValue, parseRunList, pickRun, runChoices, mergeEvents,
  revealBidi, runErrorField, folderName, parseDetect, parseRunDoc, launchText, COMMAND_ID_RE, DEMO_TASK, TASK_MAX_BYTES, POLL_LIVE_MS, POLL_IDLE_MS,
} from '../../visualizer/public/js/pipeline-model.js';

function runStatus(over = {}) {
  return {
    schema: 1, run_id: 'abc123def456', status: 'running', phase: 'implement', node: 'verify', task: 'Fix the parser',
    source_dir: 'C:\\code\\app', delivery_mode: 'apply',
    progress: { step_index: 1, step_count: 3, step_title: 'Handle empty input', attempt: 2, review_round: 0 },
    pending: null, failure: null, resumable: false,
    usage: { calls: 4, input_tokens: 12400, output_tokens: 1800, estimated_cost: null },
    checks: [], delivery: null, artifacts: { plan: 'p', diff: null, report_md: null, report_json: null },
    sandbox: { mode: 'docker', isolated: true }, pid: 4242,
    created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:05:00Z', engine_version: '0.1.0',
    ...over,
  };
}

const DIFF = [
  'diff --git a/src/a.py b/src/a.py',
  'index 1111111..2222222 100644',
  '--- a/src/a.py',
  '+++ b/src/a.py',
  '@@ -1,4 +1,4 @@',
  ' def f(x):',
  '--- old comment',
  '+++ new comment',
  '-    return x',
  '+    return x or 0',
  '\\ No newline at end of file',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');

test('classifyDiff: hunk counts decide, so "--- x" inside a hunk is a removed line, not a file header', () => {
  const kinds = classifyDiff(DIFF).map((l) => l.kind);
  assert.deepEqual(kinds, [
    'file', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'del', 'add', 'note',
    'file', 'meta', 'meta', 'meta', 'hunk', 'add',
  ]);
  assert.equal(classifyDiff('a\r\nb\r\n').length, 2, 'CRLF and the final newline make no extra line');
});

test('diffFiles counts lines per file and reads added files from the mode line', () => {
  assert.deepEqual(diffFiles(classifyDiff(DIFF)), [
    { path: 'src/a.py', action: 'M', added: 2, removed: 2 },
    { path: 'new.txt', action: 'A', added: 1, removed: 0 },
  ]);
  assert.deepEqual(diffFiles(classifyDiff('diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n')),
    [{ path: 'x', action: 'D', added: 0, removed: 1 }]);
});

test('revealBidi shows bidi controls of repository text instead of applying them', () => {
  assert.equal(revealBidi('a\u202Eb'), 'a<U+202E>b');
});

test('chatStatusOf maps every run status like the sidebar summary does', () => {
  assert.deepEqual(
    ['running', 'awaiting_approval', 'succeeded', 'failed', 'suspended', 'rejected', 'cancelled', null].map(chatStatusOf),
    ['running', 'needs_human', 'done', 'failed', 'stopped', 'stopped', 'stopped', 'idle'],
  );
});

const states = (s, last) => stepper(s ? parseStatus(runStatus(s)) : null, last).map((p) => p.state);

test('stepper: phases before the current one are done, the current one is marked, the rest are pending', () => {
  assert.deepEqual(states({}), ['done', 'done', 'done', 'current', 'pending', 'pending']);
  assert.deepEqual(states(null), Array(6).fill('pending'));
  assert.deepEqual(states({ status: 'succeeded', phase: 'done', node: 'finalize' }), Array(6).fill('done'));
});

test('stepper: a waiting gate is shown where it waits, whatever node finished last', () => {
  const plan = { status: 'awaiting_approval', phase: 'plan', pending: { gate: 'plan', digest: 'd', risk_flags: [], path: 'p' } };
  assert.deepEqual(states(plan), ['done', 'done', 'waiting', 'pending', 'pending', 'pending']);
  const delivery = { status: 'awaiting_approval', phase: 'deliver', pending: { gate: 'delivery', digest: 'd', files: [], path: 'p' } };
  assert.deepEqual(states(delivery), ['done', 'done', 'done', 'done', 'done', 'waiting']);
});

test('stepper: a finished run marks the phase it ended in', () => {
  const failed = { status: 'failed', phase: 'done', node: 'finalize', failure: { failure_class: 'checks_failed', code: 'exhausted', message: 'x', node: 'verify' } };
  assert.deepEqual(states(failed), ['done', 'done', 'done', 'failed', 'pending', 'pending']);
  assert.deepEqual(states({ status: 'rejected', phase: 'done', node: 'finalize' }), ['done', 'done', 'stopped', 'pending', 'pending', 'pending']);
  // no failure node: the last node that did work, from the events
  const events = [{ node: 'plan' }, { node: 'review' }, { node: 'finalize' }];
  assert.equal(lastWorkNode(events), 'review');
  assert.deepEqual(states({ status: 'cancelled', phase: 'done', node: 'finalize' }, lastWorkNode(events)), ['done', 'done', 'done', 'done', 'stopped', 'pending']);
  assert.deepEqual(states({ status: 'suspended', phase: 'implement' }), ['done', 'done', 'done', 'stopped', 'pending', 'pending']);
});

test('runLine says the status once and the figures after it', () => {
  const line = runLine(parseStatus(runStatus()));
  assert.equal(line.label, 'Running');
  assert.equal(line.loud, false);
  assert.deepEqual(line.parts, ['Implement', 'step 2/3 Handle empty input', 'attempt 2', '4 model calls · 12.4k in · 1.8k out', 'Docker sandbox']);
  assert.ok(!line.parts.some((p) => /running/i.test(p)), 'the status is not repeated in the figures');
  const host = runLine(parseStatus(runStatus({ status: 'failed', sandbox: { mode: 'host', isolated: false }, usage: { calls: 0 } })));
  assert.equal(host.loud, true, 'critical states are inverted');
  assert.deepEqual(host.parts, ['step 2/3 Handle empty input', 'attempt 2', 'host, no OS isolation']);
  assert.equal(parseStatus({ status: 'bogus' }), null);
});

const MODELS = { planner: { provider: 'ollama', model: 'qwen' }, implementer: { provider: 'ollama', model: 'qwen' }, reviewer: { provider: 'ollama', model: 'llama' } };
const FORM = {
  task: '  Fix the parser  ', demo: false, delivery: 'apply', sandbox: 'docker', image: '', trustHost: false,
  setup: [{ id: 'deps', command: 'npm ci', network: true }, { id: '', command: '', network: false }],
  checks: [{ id: 'tests', kind: 'test', command: 'python -m pytest -q', required: true }, { id: '', kind: 'lint', command: '', required: true }],
  models: MODELS, approvals: 'always',
};

test('buildRunBody: a pipeline run sends exactly the fields of the contract', () => {
  assert.deepEqual(buildRunBody(FORM), {
    body: {
      task: 'Fix the parser', delivery: 'apply', sandbox: { mode: 'docker' },
      setup: [{ id: 'deps', command: 'npm ci', network: true }],
      checks: [{ id: 'tests', kind: 'test', command: 'python -m pytest -q', required: true }],
      models: MODELS, approvals: { plan: 'always' },
    },
  });
  assert.deepEqual(buildRunBody({ ...FORM, image: 'scranton-sandbox:1.5.0', approvals: 'auto_low_risk', delivery: 'patch' }).body.sandbox, { mode: 'docker', image: 'scranton-sandbox:1.5.0' });
  assert.equal(buildRunBody({ ...FORM, delivery: 'patch' }).body.delivery, 'patch');
});

test('buildRunBody: a demo needs no checks, sandbox or models and sends only task, demo and delivery', () => {
  assert.deepEqual(buildRunBody({ demo: true, task: '', delivery: 'apply', sandbox: 'host', trustHost: false, models: {} }),
    { body: { task: DEMO_TASK, demo: true, delivery: 'apply' } });
  assert.deepEqual(buildRunBody({ demo: true, task: 'Try it', delivery: 'patch' }), { body: { task: 'Try it', demo: true, delivery: 'patch' } });
});

test('buildRunBody: the trusted host needs the explicit acknowledgement', () => {
  assert.deepEqual(buildRunBody({ ...FORM, sandbox: 'host' }), {
    error: 'Confirm that the checks may run on this computer without OS isolation, or use Docker.', field: 'trustHost',
  });
  assert.deepEqual(buildRunBody({ ...FORM, sandbox: 'host', trustHost: true, image: 'ignored' }).body.sandbox, { mode: 'host', trustHost: true });
});

test('buildRunBody: field errors name the input they are about', () => {
  assert.equal(buildRunBody({ ...FORM, task: ' ' }).field, 'task');
  assert.equal(buildRunBody({ ...FORM, task: 'x'.repeat(TASK_MAX_BYTES + 1) }).field, 'task');
  assert.equal(buildRunBody({ ...FORM, task: 'ä'.repeat(TASK_MAX_BYTES / 2 + 1) }).field, 'task', 'the limit counts bytes');
  assert.equal(buildRunBody({ ...FORM, models: { ...MODELS, reviewer: null } }).field, 'models.reviewer');
  assert.equal(buildRunBody({ ...FORM, checks: [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }] }).field, 'checks.1.id');
  assert.equal(buildRunBody({ ...FORM, checks: [{ id: '', command: 'x' }] }).field, 'checks.0.id');
  assert.equal(buildRunBody({ ...FORM, checks: [{ id: 'ok', command: ' ' }] }).field, 'checks.0.command');
  assert.equal(buildRunBody({ ...FORM, checks: [{ id: 'has space', command: 'x' }] }).field, 'checks.0.id');
  assert.equal(buildRunBody({ ...FORM, image: 'two words' }).field, 'image');
  assert.deepEqual(buildRunBody({ ...FORM, checks: [] }).body.checks, [], 'no checks is allowed; the report says nothing was verified');
  assert.equal(runErrorField('models.implementer: provider not supported'), 'models.implementer');
  assert.equal(runErrorField('host mode needs trustHost'), 'trustHost');
});

// finding 1: setup rows come from detect and go out as `setup` (reverting `setup: setup.rows` in buildRunBody fails this)
test('setup: detect suggests setup rows, the run body carries them, at most 4, ids checked like checks', () => {
  const found = parseDetect({
    git: true, languages: {}, checks: [{ id: 'test', kind: 'test', command: 'npm test', reason: 'package.json' }],
    setup: [{ id: 'npm-ci', command: 'npm ci', network: true, reason: 'package-lock.json' }, { id: 'blank', command: ' ' }],
  });
  assert.deepEqual(found.setup, [{ id: 'npm-ci', command: 'npm ci', network: true, reason: 'package-lock.json' }]);
  assert.deepEqual(parseDetect({ checks: [] }).setup, [], 'an older server sends no setup');
  const body = buildRunBody({ ...FORM, setup: [{ id: 'npm-ci', command: ' npm ci ', network: true }, { id: 'gen', command: 'node gen.js' }] }).body;
  assert.deepEqual(body.setup, [{ id: 'npm-ci', command: 'npm ci', network: true }, { id: 'gen', command: 'node gen.js', network: false }]);
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, command: 'x' }));
  assert.equal(buildRunBody({ ...FORM, setup: five }).field, 'setup.4.id');
  assert.equal(buildRunBody({ ...FORM, setup: [{ id: '', command: 'npm ci' }] }).field, 'setup.0.id');
  assert.equal(buildRunBody({ ...FORM, setup: [{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }] }).field, 'setup.1.id');
  assert.equal(buildRunBody({ ...FORM, setup: [{ id: 'deps', command: '' }] }).field, 'setup.0.command');
});

// finding 5: the id rule is CommandConfig.id of the engine (reverting COMMAND_ID_RE to the old pattern with "." fails this)
test('check and setup ids use exactly the pattern of engine config.py, and a 400 names its row', () => {
  const py = readFileSync(fileURLToPath(new URL('../../engine/src/scranton_pipeline/config.py', import.meta.url)), 'utf8');
  const m = /^COMMAND_ID_PATTERN = r"([^"]+)"$/m.exec(py);
  assert.ok(m, 'config.py defines COMMAND_ID_PATTERN');
  assert.match(py, /class CommandConfig\b[\s\S]*?\bid: str = Field\(pattern=COMMAND_ID_PATTERN\)/, 'and CommandConfig.id uses it');
  assert.equal(COMMAND_ID_RE.source, m[1]);
  assert.equal(buildRunBody({ ...FORM, checks: [{ id: 'unit.fast', command: 'x' }] }).field, 'checks.0.id', 'a dot is not allowed by the engine');
  assert.ok(buildRunBody({ ...FORM, checks: [{ id: 'x'.repeat(64), command: 'x' }] }).body);
  assert.equal(buildRunBody({ ...FORM, checks: [{ id: 'x'.repeat(65), command: 'x' }] }).field, 'checks.0.id');
  assert.equal(runErrorField('checks[1].id: Invalid command ID'), 'checks.1.id');
  assert.equal(runErrorField('setup.0.command: unsafe_shim_arguments'), 'setup.0.command');
  assert.equal(runErrorField('setup[2]: argv must not be empty'), 'setup.2.command');
  assert.equal(runErrorField('checks.3: duplicate'), 'checks.3.id');
});

// finding 2: check output tails (reverting the outputTail line in parseStatus fails this)
test('parseStatus keeps the output tail of a check that did not pass, and none for a passed one', () => {
  const s = parseStatus(runStatus({ checks: [
    { id: 'unit', kind: 'test', status: 'failed', required: true, duration_s: 1.5, output_tail: 'AssertionError: 1 !== 2\n' },
    { id: 'lint', kind: 'lint', status: 'passed', required: true, duration_s: 0.2, output_tail: 'noise' },
  ] }));
  assert.deepEqual(s.checks.map((c) => c.outputTail), ['AssertionError: 1 !== 2\n', '']);
});

// finding 3: a run that never started (reverting the `status: null` branch of parseRunDoc fails this)
test('parseRunDoc reads a run that never started, and launchText says what failed', () => {
  const never = parseRunDoc({ status: null, live: false, events: [], lastSeq: 0, plan: null, review: null, stderrTail: '', launchError: { code: 2, message: 'invalid config: models.planner' } });
  assert.equal(never.status, null);
  assert.deepEqual(never.launchError, { code: 2, message: 'invalid config: models.planner' });
  assert.equal(parseRunDoc({ status: null, live: true }), null, 'no status and no reason is not a run');
  assert.equal(launchText(never.launchError, { started: false }), 'The run could not start: invalid config: models.planner');
  assert.equal(launchText({ code: 2, message: 'stale digest' }, { action: 'decision' }), 'The decision could not be carried out: stale digest');
  assert.equal(launchText({ code: null, message: 'spawn failed' }, { action: 'resume' }), 'The run could not be resumed: spawn failed');
  assert.equal(launchText(null), '');
  assert.equal(parseRunDoc({ status: runStatus(), live: true, events: [] }).launchError, null, 'absent on an older server');
});

// finding 6: models offered through pi are marked, unsupported ones keep their reason (reverting the via suffix fails this)
test('modelGroups marks models answered through pi and keeps unsupported ones disabled with the reason', () => {
  const info = parseEngineInfo({ available: true, models: [
    { provider: 'anthropic', label: 'Anthropic', supported: true, via: 'pi', reason: null, models: [{ id: 'claude', label: 'Claude' }] },
    { provider: 'groq', label: 'Groq', supported: true, via: 'direct', reason: null, models: [{ id: 'llama', label: 'Llama' }] },
    { provider: 'odd', label: 'Odd', supported: false, reason: 'pi reports no model', models: [] },
  ] });
  assert.deepEqual(modelGroups(info.providers).map((g) => [g.label, g.disabled]), [
    ['Anthropic · via pi', false], ['Groq', false], ['Odd - pi reports no model', true],
  ]);
});

test('buildDecision passes the pending digest through and refuses a gate that is not pending', () => {
  const pending = { gate: 'plan', digest: 'sha-1', riskFlags: [] };
  assert.deepEqual(buildDecision({ gate: 'plan', decision: 'approve', comment: '  ' }, pending), { body: { gate: 'plan', decision: 'approve', digest: 'sha-1' } });
  assert.deepEqual(buildDecision({ gate: 'plan', decision: 'reject', comment: ' too broad ' }, pending), { body: { gate: 'plan', decision: 'reject', digest: 'sha-1', comment: 'too broad' } });
  assert.ok(buildDecision({ gate: 'delivery', decision: 'approve' }, pending).error);
  assert.ok(buildDecision({ gate: 'plan', decision: 'approve' }, null).error);
  assert.ok(buildDecision({ gate: 'plan', decision: 'maybe' }, pending).error);
});

test('pollDelay: 1 s while live or running, 5 s otherwise, nothing when the chat is not shown', () => {
  assert.equal(pollDelay({ live: true, status: 'awaiting_approval' }), POLL_LIVE_MS);
  assert.equal(pollDelay({ live: false, status: 'running' }), POLL_LIVE_MS);
  assert.equal(pollDelay({ live: false, status: 'succeeded' }), POLL_IDLE_MS);
  assert.equal(pollDelay({ live: false, status: 'awaiting_approval' }), POLL_IDLE_MS);
  assert.equal(pollDelay({ shown: false, live: true, status: 'running' }), null);
  assert.equal(POLL_LIVE_MS, 1000);
  assert.equal(POLL_IDLE_MS, 5000);
});

function fakeTimers() {
  const t = { delays: [], pending: new Map(), seq: 0 };
  t.setTimeout = (fn, ms) => { t.delays.push(ms); t.pending.set(++t.seq, fn); return t.seq; };
  t.clearTimeout = (id) => { t.pending.delete(id); };
  t.fire = async () => {
    const [id, fn] = [...t.pending][0];
    t.pending.delete(id);
    await fn();
  };
  return t;
}
const flush = () => new Promise((r) => setImmediate(r));

test('createPoller schedules by the answer and stops for good', async () => {
  const timers = fakeTimers();
  const answers = [{ live: true, status: 'running' }, { live: false, status: 'succeeded' }];
  let loads = 0;
  const p = createPoller({ timers, load: async () => answers[Math.min(loads++, answers.length - 1)] });
  p.start();
  await flush();
  assert.deepEqual(timers.delays, [1000]);
  await timers.fire();
  await flush();
  assert.deepEqual(timers.delays, [1000, 5000]);
  p.stop();
  assert.equal(timers.pending.size, 0, 'the next poll is cancelled');
  assert.equal(p.running(), false);
  // a load that was on its way when the chat went away schedules nothing
  let release;
  const slow = createPoller({ timers, load: () => new Promise((r) => { release = r; }) });
  slow.start();
  await flush();
  slow.stop();
  release({ live: true, status: 'running' });
  await flush();
  assert.equal(timers.pending.size, 0);
});

test('parseEngineInfo: a missing route and an unavailable engine both give a reason to show', () => {
  assert.deepEqual(parseEngineInfo(null, 404), { available: false, reason: 'This server does not offer the Pipeline engine yet.', version: null, dockerImage: null, providers: [] });
  assert.equal(parseEngineInfo({ available: false, reason: 'python not found' }).reason, 'python not found');
  const info = parseEngineInfo({
    available: true, reason: null, version: '0.1.0', source: 'dev', sandbox: { dockerImage: 'scranton-sandbox:1.5.0' },
    models: [
      { provider: 'ollama', label: 'Ollama', supported: true, reason: null, models: [{ id: 'qwen', label: 'Qwen' }] },
      { provider: 'anthropic', label: 'Anthropic', supported: false, reason: 'OAuth accounts are not supported', models: [{ id: 'claude', label: 'Claude' }] },
    ],
  });
  assert.equal(info.available, true);
  assert.equal(info.dockerImage, 'scranton-sandbox:1.5.0');
  const groups = modelGroups(info.providers);
  assert.deepEqual(groups.map((g) => [g.label, g.disabled]), [['Ollama', false], ['Anthropic - OAuth accounts are not supported', true]]);
  assert.equal(groups[1].options[0].disabled, true, 'an unsupported provider is listed, disabled');
  assert.deepEqual(parseModelValue(groups[0].options[0].value, info.providers), { provider: 'ollama', model: 'qwen' });
  assert.equal(parseModelValue(groups[1].options[0].value, info.providers), null, 'an unsupported pick is never sent');
});

test('run list: the picked run while it exists, else the active one, else the newest; the selector lists newest first', () => {
  const list = parseRunList({ active: null, runs: [
    { runId: 'aaaaaaaa0001', status: 'failed', task: 'first', createdAt: '2026-11-09T09:00:00Z' },
    { runId: 'aaaaaaaa0002', status: 'succeeded', task: 'second', createdAt: '2026-11-09T10:00:00Z' },
    { runId: '../evil', status: 'running' },
  ] });
  assert.deepEqual(list.runs.map((r) => r.runId), ['aaaaaaaa0001', 'aaaaaaaa0002'], 'a run id that is not one is dropped');
  assert.equal(pickRun(list), 'aaaaaaaa0002');
  assert.equal(pickRun(list, 'aaaaaaaa0001'), 'aaaaaaaa0001');
  assert.equal(pickRun({ ...list, active: 'aaaaaaaa0001' }), 'aaaaaaaa0001');
  assert.equal(pickRun(list, 'gone00000000'), 'aaaaaaaa0002');
  assert.deepEqual(runChoices(list.runs).map((c) => c.value), ['aaaaaaaa0002', 'aaaaaaaa0001']);
  assert.match(runChoices(list.runs)[0].text, /^Run 2 · second · succeeded/);
});

test('mergeEvents keeps seq order, skips what it has and drops the oldest beyond the cap', () => {
  const ev = (seq) => ({ seq, type: 'route', data: {} });
  const kept = mergeEvents([], [ev(2), ev(1)]);
  assert.deepEqual(kept.map((e) => e.seq), [1, 2]);
  assert.equal(mergeEvents(kept, [ev(2)]), kept, 'nothing new: the same list');
  assert.deepEqual(mergeEvents(kept, [ev(3), ev(4)], 3).map((e) => e.seq), [2, 3, 4]);
});

test('folderName names the project folder for the Apply button', () => {
  assert.equal(folderName('C:\\Users\\me\\code\\app\\'), 'app');
  assert.equal(folderName('/home/me/app'), 'app');
});

test('no pipeline module writes markup: every text goes through textContent', () => {
  const dir = fileURLToPath(new URL('../../visualizer/public/js/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.startsWith('pipeline-'));
  assert.deepEqual(files.sort(), ['pipeline-form.js', 'pipeline-model.js', 'pipeline-view.js']);
  for (const f of files) {
    const src = readFileSync(dir + f, 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/, f);
  }
});
