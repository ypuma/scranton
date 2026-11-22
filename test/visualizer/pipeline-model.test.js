// Pure logic of the Pipeline UI (.enma/pipeline-contract.md sections 6, 9, 10): diff lines, status and phase
// mapping, the stepper, the run line, request bodies, poll timing, and that no pipeline module writes HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDiff, diffFiles, chatStatusOf, stepper, lastWorkNode, runLine, parseStatus, buildRunBody, buildDecision,
  pollDelay, createPoller, parseEngineInfo, modelGroups, parseModelValue, parseRunList, pickRun, runChoices, mergeEvents,
  revealBidi, runErrorField, folderName, parseDetect, parseRunDoc, launchText, parseSandbox, sandboxView, eventText, laneRows, announcement, LOUD_EVENTS, COMMAND_ID_RE, DEMO_TASK, DEMO_SCENARIOS, demoScenario, TASK_MAX_BYTES, POLL_LIVE_MS, POLL_IDLE_MS,
  evidenceView, riskFlagText, activityEvents, eventLoud, nodeLabel, phaseOfNode, parsePlan, parseReview,
} from '../../visualizer/public/js/pipeline-model.js';
import { REAL_GROUNDING, REAL_EVIDENCE_DEMO, REAL_ABSENCE_REFUTED } from './fixtures/engine-grounding.js';

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
  assert.deepEqual(line.parts, ['Implement', 'step 2/3 Handle empty input', 'attempt 2', '4 model calls · 12.4k in · 1.8k out', 'Docker (isolated, no network)']);
  assert.ok(!line.parts.some((p) => /running/i.test(p)), 'the status is not repeated in the figures');
  const host = runLine(parseStatus(runStatus({ status: 'failed', sandbox: { mode: 'host', isolated: false }, usage: { calls: 0 } })));
  assert.equal(host.loud, true, 'critical states are inverted');
  assert.deepEqual(host.parts, ['step 2/3 Handle empty input', 'attempt 2', 'host, no OS isolation']);
  assert.equal(parseStatus({ status: 'bogus' }), null);
});

// exactly what engine/src/scranton_pipeline/tools/sandbox.py sandbox_description sends
const DOCKER_SENTENCE = 'Docker container with read-only root and no network for checks; shares the Docker VM kernel; workspace mounted read-write; setup commands with network can reach the internet and local services (including host.docker.internal).';
const ENGINE_SANDBOX = {
  host: { mode: 'host', isolated: false, image: null, isolation: 'No OS isolation.', setup_network: false },
  docker: { mode: 'docker', isolated: true, image: 'scranton-pipeline-sandbox:0.1.0', isolation: DOCKER_SENTENCE, setup_network: false },
};
const sandboxLine = (sandbox) => runLine(parseStatus(runStatus({ sandbox })));
const frag = (sandbox) => sandboxLine(sandbox).parts.at(-1);

// guards `const c = sentence.split(';')[0].replace(TRAILING, '')` in firstClause and the `^${label}\b` test in sandboxFragment
test('runLine: the sandbox fragment is the first clause of the engine\'s sentence, the mode named once', () => {
  assert.equal(frag(ENGINE_SANDBOX.docker), 'Docker container with read-only root and no network for checks');
  assert.equal(frag(ENGINE_SANDBOX.host), 'host · No OS isolation');
  assert.equal(frag({ mode: 'host', isolation: 'HOST shell, unrestricted.' }), 'HOST shell, unrestricted', 'already named, any case');
  assert.equal(frag({ mode: 'docker', isolation: 'Container; no network' }), 'Docker · Container');
  assert.equal(frag({ mode: 'docker', isolation: 'Dockerised runner v0.1.0 in use.' }), 'Docker · Dockerised runner v0.1.0 in use', 'a word boundary, not a prefix; an inner dot stays');
});

// guards `const at = c.slice(0, max - 2).lastIndexOf(' ')` and the `...` in firstClause
test('runLine: a first clause over 80 characters is cut between words, with an ellipsis', () => {
  const long = `Docker container ${'with many words '.repeat(8)}; rest`;
  const f = frag({ mode: 'docker', isolation: long });
  assert.ok(f.length <= 80, `${f.length} characters`);
  assert.ok(f.endsWith('...'));
  assert.ok(long.startsWith(f.slice(0, -3)), 'a prefix of the sentence');
  assert.equal(long[f.length - 3], ' ', 'cut where a word ends');
  assert.equal(frag({ mode: 'docker', isolation: 'x'.repeat(200) }), `Docker · ${'x'.repeat(77)}...`, 'one long word');
});

// guards `isolation: str(obj(o.sandbox)?.isolation)...` in parseStatus and the fallback in sandboxFragment
test('runLine: an older engine without the isolation sentence keeps the fixed words, with no title', () => {
  for (const [sandbox, text] of [
    [{ mode: 'docker', isolated: true }, 'Docker (isolated, no network)'],
    [{ mode: 'docker', isolated: true, isolation: { odd: 1 } }, 'Docker (isolated, no network)'],
    [{ mode: 'host', isolation: '   ' }, 'host, no OS isolation'],
    [{ mode: 'host', isolation: '.;' }, 'host, no OS isolation'],
  ]) {
    const line = sandboxLine(sandbox);
    assert.equal(line.parts.at(-1), text, JSON.stringify(sandbox));
    assert.equal(line.sandbox.full, '');
    assert.equal(line.sandbox.more, false);
  }
  assert.equal(sandboxLine({ isolation: 'x' }).sandbox, null, 'no mode, no fragment');
});

// guards `full: sb.isolation, more: clause !== sb.isolation.replace(TRAILING, '')` in sandboxFragment
test('runLine: the full sentence goes with the fragment; more only when the fragment leaves something out', () => {
  const docker = sandboxLine(ENGINE_SANDBOX.docker);
  assert.deepEqual(docker.sandbox, { at: docker.parts.length - 1, full: DOCKER_SENTENCE, more: true });
  const host = sandboxLine(ENGINE_SANDBOX.host);
  assert.deepEqual(host.sandbox, { at: host.parts.length - 1, full: 'No OS isolation.', more: false });
  assert.equal(sandboxLine({ mode: 'docker', isolation: '  Docker   container\n with no network.  ' }).sandbox.full, 'Docker container with no network.', 'whitespace folded');
});

// guards `setupNetwork: obj(o.sandbox)?.setup_network === true` in parseStatus and its push in runLine
test('runLine: setup with network access is said once, after the sandbox; new fields are read tolerantly', () => {
  const on = sandboxLine({ ...ENGINE_SANDBOX.docker, setup_network: true });
  assert.deepEqual(on.parts.slice(-2), ['Docker container with read-only root and no network for checks', 'setup had network access']);
  assert.equal(on.parts.filter((p) => /network access/.test(p)).length, 1);
  for (const v of [false, 'true', 1, null, undefined]) {
    assert.ok(!sandboxLine({ ...ENGINE_SANDBOX.docker, setup_network: v }).parts.includes('setup had network access'), String(v));
  }
  assert.equal(parseStatus(runStatus({ sandbox: ENGINE_SANDBOX.docker })).sandbox.image, 'scranton-pipeline-sandbox:0.1.0');
  assert.equal(parseStatus(runStatus({ sandbox: ENGINE_SANDBOX.host })).sandbox.image, null);
  assert.deepEqual(parseStatus(runStatus({ sandbox: { mode: 'docker', image: 7, setup_network: 'yes' } })).sandbox,
    { mode: 'docker', isolated: false, isolation: null, image: null, setupNetwork: false });
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
      models: MODELS, approvals: { plan: 'always' }, replans: 1, parallelSteps: 2, grounding: 'enforce', guidance: false, conversation: true,
    },
  });
  assert.deepEqual(buildRunBody({ ...FORM, image: 'scranton-sandbox:1.5.0', approvals: 'auto_low_risk', delivery: 'patch' }).body.sandbox, { mode: 'docker', image: 'scranton-sandbox:1.5.0' });
  assert.equal(buildRunBody({ ...FORM, delivery: 'patch' }).body.delivery, 'patch');
});

test('buildRunBody: a demo needs no checks or models and sends only task, demo, scenario, delivery and sandbox', () => {
  assert.deepEqual(buildRunBody({ demo: true, task: '', delivery: 'apply', sandbox: 'host', trustHost: false, models: {} }),
    { body: { task: DEMO_TASK, demo: true, demoScenario: 'basic', delivery: 'apply', sandbox: { mode: 'host' }, grounding: 'enforce', guidance: false, conversation: true } });
  assert.deepEqual(buildRunBody({ demo: true, task: 'Try it', delivery: 'patch', sandbox: 'docker' }),
    { body: { task: 'Try it', demo: true, demoScenario: 'basic', delivery: 'patch', sandbox: { mode: 'docker' }, grounding: 'enforce', guidance: false, conversation: true } });
});

// section 19. Guards `demoScenario: demoScenario(form.demoScenario).id` and `sandbox: sb.sandbox` in the demo body,
// `if (demo) return { sandbox: { mode: 'host' } };` in sandboxOf, and that the non-demo body never names a scenario.
test('buildRunBody: a demo sends its scenario and sandbox; the host needs no acknowledgement there, and only there', () => {
  const demo = { demo: true, task: '', delivery: 'apply', image: '', trustHost: false, checks: 'ignored', models: {} };
  for (const id of ['basic', 'replan', 'parallel']) {
    assert.deepEqual(buildRunBody({ ...demo, demoScenario: id, sandbox: 'docker' }).body,
      { task: DEMO_TASK, demo: true, demoScenario: id, delivery: 'apply', sandbox: { mode: 'docker' }, grounding: 'enforce', guidance: false, conversation: true }, id);
    assert.deepEqual(buildRunBody({ ...demo, demoScenario: id, sandbox: 'host' }).body.sandbox, { mode: 'host' }, `${id} on the host`);
  }
  assert.equal(buildRunBody({ ...demo, demoScenario: '', sandbox: 'host' }).body.demoScenario, 'basic', 'an empty or unknown choice is the default');
  assert.equal(buildRunBody({ ...demo, demoScenario: 'nope', sandbox: 'host' }).body.demoScenario, 'basic');
  assert.deepEqual(buildRunBody({ ...demo, sandbox: 'docker', image: ' my/img:2 ' }).body.sandbox, { mode: 'docker', image: 'my/img:2' });
  assert.deepEqual(buildRunBody({ ...demo, sandbox: 'host', trustHost: true, image: 'ignored' }).body.sandbox, { mode: 'host' }, 'never trustHost for a demo');
  assert.equal(buildRunBody({ ...demo, sandbox: 'docker', image: 'two words' }).field, 'image');
  assert.equal(buildRunBody({ ...demo, sandbox: '' }).field, 'sandbox');
  assert.equal(buildRunBody({ ...FORM, sandbox: 'host', trustHost: false, demoScenario: 'replan' }).field, 'trustHost', 'a real run still needs it');
  assert.equal('demoScenario' in buildRunBody({ ...FORM, demoScenario: 'replan' }).body, false);
});

// section 25b. Guards the `evidence` entry of DEMO_SCENARIOS and `if (scenario.enforce) evidence.grounding = 'enforce';`
test('buildRunBody: the evidence demo is accepted and always sends enforce; the other scenarios and real runs keep the choice', () => {
  const demo = { demo: true, task: '', delivery: 'apply', sandbox: 'host', guidance: true };
  assert.deepEqual(buildRunBody({ ...demo, demoScenario: 'evidence', grounding: 'observe' }),
    { body: { task: DEMO_TASK, demo: true, demoScenario: 'evidence', delivery: 'apply', sandbox: { mode: 'host' }, grounding: 'enforce', guidance: true, conversation: true } });
  assert.equal(buildRunBody({ ...demo, demoScenario: 'evidence' }).body.grounding, 'enforce');
  for (const id of ['basic', 'replan', 'parallel']) assert.equal(buildRunBody({ ...demo, demoScenario: id, grounding: 'observe' }).body.grounding, 'observe', id);
  const real = buildRunBody({ ...FORM, demoScenario: 'evidence', grounding: 'observe' }).body;
  assert.deepEqual([real.grounding, 'demoScenario' in real], ['observe', false], 'a real run never names a scenario and keeps observe');
});

test('demoScenario: one quiet line per scenario, the basic fix by default', () => {
  assert.deepEqual(DEMO_SCENARIOS.map((s) => [s.id, s.label, s.hint]), [
    ['basic', 'Basic fix', 'One bug, one step, both approvals.'],
    ['replan', 'Re-planning', 'The first plan gets stuck; you approve a revised plan.'],
    ['parallel', 'Parallel steps', 'Two independent fixes run side by side and are merged.'],
    ['evidence', 'Evidence checks', 'Ungrounded output is rejected and repaired; at delivery one criterion is shown by checks, one passed before the change too.'],
    ['answer', 'Direct answer', 'A question about the sample project: the planner reads the code and answers. Nothing is changed and no approval is asked.'],
  ]);
  assert.deepEqual(DEMO_SCENARIOS.filter((s) => s.enforce).map((s) => s.id), ['evidence'], 'only the evidence demo needs Enforce');
  assert.equal(demoScenario('parallel').id, 'parallel');
  assert.equal(demoScenario(undefined).id, 'basic');
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

// finding 6: models offered through Scranton's bridge are marked, unsupported ones keep their reason (reverting the via
// suffix fails this). A server from before the own runtime still says via: 'pi' for the same bridge.
test('modelGroups marks models answered through the bridge as via Scranton and keeps unsupported ones disabled with the reason', () => {
  const info = parseEngineInfo({ available: true, models: [
    { provider: 'anthropic', label: 'Anthropic', supported: true, via: 'pi', reason: null, models: [{ id: 'claude', label: 'Claude' }] },
    { provider: 'openai', label: 'OpenAI', supported: true, via: 'bridge', reason: null, models: [{ id: 'gpt', label: 'GPT' }] },
    { provider: 'other', label: 'Other', supported: true, via: 'carrier-pigeon', reason: null, models: [{ id: 'x', label: 'X' }] },
    { provider: 'groq', label: 'Groq', supported: true, via: 'direct', reason: null, models: [{ id: 'llama', label: 'Llama' }] },
    { provider: 'odd', label: 'Odd', supported: false, reason: 'pi reports no model', models: [] },
  ] });
  assert.deepEqual(modelGroups(info.providers).map((g) => [g.label, g.disabled]), [
    ['Anthropic · via Scranton', false], ['OpenAI · via Scranton', false], ['Other', false], ['Groq', false], ['Odd - pi reports no model', true],
  ]);
  assert.deepEqual(info.providers.map((p) => p.via), ['bridge', 'bridge', null, 'direct', null], 'pi and bridge read as the one bridge');
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
  assert.deepEqual(parseEngineInfo(null, 404), { available: false, reason: 'This server does not offer the Pipeline engine yet.', version: null, dockerImage: null,
    sandbox: { known: false, docker: null, image: null, build: null }, providers: [] });
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

// ------------------------------------------------------------ sections 16-18: re-planning, parallel lanes, Docker

const SANDBOX = (over = {}) => ({
  dockerImage: 'scranton-pipeline-sandbox:0.2.0',
  docker: { available: true, version: '29.9.2', reason: null },
  image: { name: 'scranton-pipeline-sandbox:0.2.0', present: true },
  build: { state: 'idle', startedAt: null, finishedAt: null, tail: '' },
  ...over,
});
const view = (sb, opts) => sandboxView(parseSandbox(sb), opts);

// guards `if (!docker || typeof docker.available !== 'boolean') return { known: false, ...` in parseSandbox
test('parseSandbox: the full probe is read; an older server that only names the image leaves Docker unknown', () => {
  assert.deepEqual(parseSandbox(SANDBOX()), {
    known: true, docker: { available: true, version: '29.9.2', reason: null },
    image: { name: 'scranton-pipeline-sandbox:0.2.0', present: true }, build: { state: 'idle', startedAt: null, finishedAt: null, tail: '' },
  });
  assert.equal(parseSandbox({ dockerImage: 'scranton-sandbox:1.5.0' }).known, false);
  assert.equal(parseSandbox({ dockerImage: 'x', docker: { version: '29' } }).known, false, 'without a yes or no Docker is not known');
  assert.equal(parseEngineInfo({ available: true, sandbox: { dockerImage: 'x' } }).sandbox.known, false);
  assert.equal(parseSandbox(SANDBOX({ build: { state: 'exploded' } })).build, null, 'an unknown build state is no build state');
  assert.deepEqual(view({ dockerImage: 'x' }), { line: '', tone: '', ready: null, build: 'hidden', tail: '' }, 'unknown: no line, no build button');
});

// guards each branch of sandboxView (the line says exactly what is missing)
test('sandboxView: ready, Docker down, image missing, building, failed', () => {
  assert.deepEqual(view(SANDBOX()), { line: 'Docker 29.9.2 is running; the image scranton-pipeline-sandbox:0.2.0 is present.', tone: '', ready: true, build: 'hidden', tail: '' });
  const down = view(SANDBOX({ docker: { available: false, version: null, reason: 'the Docker daemon does not answer' } }));
  assert.equal(down.line, 'Docker is not running: the Docker daemon does not answer');
  assert.deepEqual([down.ready, down.build], [false, 'hidden'], 'no build without Docker');
  const missing = view(SANDBOX({ image: { name: 'scranton-pipeline-sandbox:0.2.0', present: false } }));
  assert.deepEqual([missing.line, missing.ready, missing.build], ['The sandbox image scranton-pipeline-sandbox:0.2.0 has not been built yet.', false, 'idle']);
  const running = view(SANDBOX({ image: { name: 'img:1', present: false }, build: { state: 'running', tail: 'Step 3/9 : RUN apt-get' } }));
  assert.deepEqual([running.line, running.tone, running.build, running.tail], ['Building the sandbox image img:1...', 'busy', 'running', 'Step 3/9 : RUN apt-get']);
  const failed = view(SANDBOX({ image: { name: 'img:1', present: false }, build: { state: 'failed', tail: 'pull access denied' } }));
  assert.deepEqual([failed.tone, failed.ready, failed.build, failed.tail], ['error', false, 'idle', 'pull access denied'], 'the tail stays, the button offers a retry');
  assert.equal(view(SANDBOX({ image: { name: 'img:1', present: false } }), { buildError: 'Docker is not available' }).line, 'The sandbox image could not be built: Docker is not available');
  assert.equal(view(SANDBOX({ build: { state: 'succeeded', tail: 'done' } })).tail, '', 'a finished build shows no tail');
});

// guards `const replans = choice(...)` / `const parallelSteps = choice(...)` and the `form.sandbox !== 'host' && ...` check
test('buildRunBody: replans and parallelSteps are sent within their bounds, never for a demo; a sandbox must be chosen', () => {
  assert.deepEqual(['replans', 'parallelSteps'].map((k) => buildRunBody({ ...FORM, replans: '0', parallelSteps: '4' }).body[k]), [0, 4]);
  assert.deepEqual(['replans', 'parallelSteps'].map((k) => buildRunBody({ ...FORM, replans: '9', parallelSteps: '0' }).body[k]), [1, 2], 'out of range: the form defaults');
  const demo = buildRunBody({ demo: true, task: '', delivery: 'apply', sandbox: 'docker', replans: '3', parallelSteps: '3' }).body;
  assert.equal('replans' in demo || 'parallelSteps' in demo, false);
  assert.deepEqual(buildRunBody({ ...FORM, sandbox: '' }), { error: 'Choose where the checks run: Docker container or Trusted host.', field: 'sandbox' });
});

// guards the plan_revision / replans_left / steps_done / lanes lines of parseStatus and the revision part of parsePending
test('parseStatus reads re-planning and lane progress; junk lanes and unknown fields are dropped, not fatal', () => {
  const s = parseStatus(runStatus({
    progress: { step_index: 2, step_count: 5, step_title: 'x', attempt: 1, review_round: 0, plan_revision: 1, replans_left: 0, steps_done: 2,
      lanes: [{ step_id: 's3', title: 'Parser', state: 'running', attempt: 1 }, { title: 'no id' }, 'junk', { step_id: 's4', state: 'merged', attempt: 2, future: true }],
      something_new: { deep: [1] } },
    pending: { gate: 'plan', digest: 'd', risk_flags: ['replan'], revision: 2, replan_reason: 'apply_edits: edits never applied', extra: 1 },
    brand_new_field: 42,
  }));
  assert.deepEqual([s.progress.planRevision, s.progress.replansLeft, s.progress.stepsDone], [1, 0, 2]);
  assert.deepEqual(s.progress.lanes, [{ stepId: 's3', title: 'Parser', state: 'running', attempt: 1 }, { stepId: 's4', title: '', state: 'merged', attempt: 2 }]);
  assert.deepEqual([s.pending.revision, s.pending.replanReason], [2, 'apply_edits: edits never applied']);
  const asObject = parseStatus(runStatus({ pending: { gate: 'plan', digest: 'd', revision: 1, replan_reason: { code: 'step_blocked', message: 'no API', scope: 's1' } } }));
  assert.equal(asObject.pending.replanReason, 'step_blocked: no API', 'an object reason reads like the string one');
  for (const odd of [42, ['a', 'b'], { scope: 's1' }, { code: { deep: 1 }, message: ['x'] }, null]) {
    assert.equal(parseStatus(runStatus({ pending: { gate: 'plan', digest: 'd', revision: 1, replan_reason: odd } })).pending.replanReason, '', JSON.stringify(odd));
  }
  const old = parseStatus(runStatus());
  assert.deepEqual([old.progress.planRevision, old.progress.replansLeft, old.progress.stepsDone, old.progress.lanes], [0, null, null, []], 'an older engine');
});

// guards `if (revision > 0) {` and `if (s.progress.lanes.length) {` in runLine
test('runLine: plan revision and replans left only after a re-plan; lanes replace step i/n by steps done', () => {
  const quiet = runLine(parseStatus(runStatus({ progress: { step_index: 0, step_count: 2, plan_revision: 0, replans_left: 1, steps_done: 0, lanes: [] } })));
  assert.ok(!quiet.parts.some((p) => /revision|replan/.test(p)), 'no re-plan happened: nothing about it');
  const revised = runLine(parseStatus(runStatus({ progress: { step_index: 0, step_count: 2, plan_revision: 2, replans_left: 1, steps_done: 1, lanes: [] } })));
  assert.deepEqual(revised.parts.filter((p) => /revision|replan/.test(p)), ['plan revision 2', '1 replan left']);
  const pending = runLine(parseStatus(runStatus({ status: 'awaiting_approval', phase: 'approve_plan', progress: { step_index: -1, step_count: 2, replans_left: 0 }, pending: { gate: 'plan', digest: 'd', revision: 1 } })));
  assert.deepEqual(pending.parts.filter((p) => /revision|replan/.test(p)), ['plan revision 1', '0 replans left']);
  const lanes = runLine(parseStatus(runStatus({ progress: { step_index: 1, step_count: 5, attempt: 2, steps_done: 1, lanes: [{ step_id: 's2', state: 'running', attempt: 2 }] } })));
  assert.ok(!lanes.parts.some((p) => /^step |^attempt /.test(p)), 'no single step figure while lanes run');
  assert.ok(lanes.parts.includes('1 of 5 steps done'));
});

// guards the EVENT_TEXT entries for sections 16 and 17, the lane read in parseEvent and the try/catch in eventText
test('eventText: readable labels for re-planning and wave events; unknown types and odd data never throw', () => {
  const ev = (type, data) => parseRunDoc({ status: runStatus(), events: [{ seq: 1, type, node: 'x', data }] }).events[0];
  assert.equal(eventText(ev('replan_requested', { code: 'step_blocked', message: 'the API does not exist', scope: 'step:s2' })), 'step_blocked: the API does not exist');
  assert.equal(eventText(ev('replanned', { revision: 2 })), 'plan revision 2');
  assert.equal(eventText(ev('wave_started', { wave: 1, steps: ['s2', 's3'] })), 'wave 1: s2, s3');
  // the engine numbers waves from 1 and prints them as sent; an older fake started at 0
  assert.equal(eventText(ev('wave_started', { wave: 0, steps: ['s1'] })), 'wave 0: s1');
  // guards `str(d.message) ?` in replan_requested: an odd message is left out, not printed as an empty tail
  assert.equal(eventText(ev('replan_requested', { code: 'step_blocked', message: { text: 'x' } })), 'step_blocked');
  assert.equal(eventText(ev('replan_requested', { code: 7, message: 'stuck' })), 'replan: stuck');
  assert.equal(eventText(ev('replanned', { revision: '2' })), 'plan revised');
  for (const type of ['replan_requested', 'replanned', 'wave_started', 'wave_merged', 'lane_finished']) {
    const said = eventText(ev(type, { code: {}, message: {}, revision: {}, wave: {}, steps: {}, merged: [{}], failed: {}, status: {} }));
    assert.doesNotMatch(said, /object Object|undefined|null/, type);
  }
  assert.equal(eventText(ev('lane_finished', { lane: 's2', status: 'passed' })), 'passed');
  assert.equal(eventText(ev('wave_merged', { wave: 1, merged: ['s2'], failed: ['s3'] })), 'wave 1: merged s2 · not merged s3');
  assert.equal(eventText(ev('wave_merged', { wave: { odd: 1 }, merged: 'nope' })), 'wave ?: merged none');
  assert.equal(ev('lane_started', { lane: 's3' }).lane, 's3', 'the lane is kept for the prefix');
  assert.equal(ev('route', {}).lane, null);
  assert.equal(eventText(ev('from_the_future', { a: 1 })), '');
  assert.equal(eventText({ type: 'toString', data: {} }), '', 'an inherited name is not a label');
  assert.equal(eventText(ev('route', null)), '->', 'no data is no data, not a crash');
  assert.ok(LOUD_EVENTS.has('replan_requested'));
});

test('laneRows: state glyphs, a failed lane is loud, an unknown state is shown as its word', () => {
  assert.deepEqual(laneRows([
    { stepId: 's2', title: 'Parser', state: 'running', attempt: 1 },
    { stepId: 's3', title: '', state: 'failed', attempt: 3 },
    { stepId: 's4', title: 'Docs', state: 're_queued', attempt: 0 },
  ]).map((r) => [r.title, r.glyph, r.label, r.attempt, r.loud]), [
    ['Parser', '●', 'running', 'attempt 1', false],
    ['s3', '✕', 'failed', 'attempt 3', true],
    ['Docs', '·', 're queued', '', false],
  ]);
});

test('announcement names a revised plan gate', () => {
  assert.equal(announcement(parseStatus(runStatus({ status: 'awaiting_approval', pending: { gate: 'plan', digest: 'd', revision: 1 } }))), 'Pipeline: the revised plan (revision 1) waits for your approval');
  assert.equal(announcement(parseStatus(runStatus({ status: 'awaiting_approval', pending: { gate: 'plan', digest: 'd' } }))), 'Pipeline: the plan waits for your approval');
});

// ------------------------------------------------------------ sections 21, 23 and 24: evidence grounding, guidance

// exactly the status.grounding example of section 24
const G24 = {
  mode: 'enforce', answer: 1.0, trajectory: 0.875, unadjusted: 0.9375, violation_rate: 0.1667, adjusted: 0.651, tier: 'major', outputs: 6,
  violations: { false_absence: 1 }, criteria: [{ id: 'c1', verified_by: 'checks', state: 'demonstrated', by: 'baseline', checks: ['unit'] }],
  probe: { status: 'not_needed' },
};
const NO_JUNK = /object Object|NaN|undefined|null/;

// guards `grounding: parseGrounding(o.grounding),` and the procedure lines of parseStatus, `grounding: parseGrounding(o.grounding),`
// and the shared `riskFlags` of parsePending
test('parseStatus: status.grounding, status.procedure and the delivery gate as section 24 sends them; an older engine has none', () => {
  const s = parseStatus(runStatus({ grounding: G24, procedure: { enabled: true, name: 'default', digest: 'ab12', situation: 'implement.repair' } }));
  assert.deepEqual(s.grounding, {
    mode: 'enforce', answer: 1, trajectory: 0.875, violationRate: 0.1667, adjusted: 0.651, tier: 'major', outputs: 6,
    violations: [{ kind: 'false_absence', count: 1 }], criteria: [{ id: 'c1', verifiedBy: 'checks', state: 'demonstrated', by: 'baseline', checks: ['unit'] }],
    probe: 'not_needed',
  });
  assert.deepEqual(s.procedure, { enabled: true, name: 'default', situation: 'implement.repair' });
  const old = parseStatus(runStatus());
  assert.equal(old.grounding, null, 'an older engine: no grounding at all');
  assert.deepEqual(old.procedure, { enabled: false, name: null, situation: null });
  const odd = parseStatus(runStatus({
    grounding: { mode: 'loud', answer: '1', trajectory: Infinity, violation_rate: 3, adjusted: -1, tier: 'great', outputs: 2.5,
      violations: { a: '1', b: 0, c: 2, constructor: 1 }, criteria: [null, { id: 7 }, { id: 'c2', state: 5, by: 'magic', checks: [1, 'x', ''] }], probe: 'demonstrated' },
    procedure: { enabled: 'yes', situation: { a: 1 } },
  }));
  assert.deepEqual(odd.grounding, {
    mode: 'enforce', answer: null, trajectory: null, violationRate: null, adjusted: null, tier: null, outputs: 0,
    violations: [{ kind: 'c', count: 2 }, { kind: 'constructor', count: 1 }], criteria: [{ id: 'c2', verifiedBy: '', state: 'undecided', by: 'none', checks: ['x'] }], probe: null,
  });
  assert.deepEqual(odd.procedure, { enabled: false, name: null, situation: null });
  const gate = parseStatus(runStatus({ status: 'awaiting_approval', phase: 'deliver', pending: {
    gate: 'delivery', digest: 'd', files: [], risk_flags: ['criteria_not_demonstrated', 'grounding_violations', 3, ''], grounding: G24 } })).pending;
  assert.deepEqual(gate.riskFlags, ['criteria_not_demonstrated', 'grounding_violations']);
  assert.equal(gate.grounding.adjusted, 0.651);
  assert.equal(parseStatus(runStatus({ status: 'awaiting_approval', pending: { gate: 'delivery', digest: 'd' } })).pending.grounding, null);
});

const PLAN_DOC = parsePlan({ acceptance_criteria: [
  { id: 'c1', text: 'Empty input returns []', verified_by: 'checks' }, { id: 'c3', text: 'The README names the flag', verified_by: 'review' },
] });

// guards the CRITERION_STATES / DEMONSTRATED_BY words, the `checks` and `note` lines and the score lines of evidenceView
test('evidenceView: every criterion state in plain words, the check ids, the score with its parts, the plan text by id', () => {
  const crit = (id, verified_by, state, by, checks = []) => ({ id, verified_by, state, by, checks });
  const g = parseStatus(runStatus({ grounding: { ...G24, criteria: [
    crit('c1', 'checks', 'demonstrated', 'baseline', ['unit']), crit('c2', 'checks', 'demonstrated', 'probe', ['unit', 'e2e']),
    crit('c3', 'review', 'attested', 'review'), crit('c4', 'checks', 'met_not_demonstrated', 'none'), crit('c5', 'checks', 'not_met', 'none', ['unit']),
    crit('c6', 'review', 'unclear', 'review'), crit('c7', 'review', 'undecided', 'none'), crit('c8', 'review', 'half_met', 'none'),
  ] } })).grounding;
  const review = parseReview({ verdict: 'approve', summary: '', criteria: [{ id: 'c3', status: 'met', evidence: 'H-0123456789 adds the flag' }], findings: [] });
  const v = evidenceView(g, PLAN_DOC, review);
  assert.deepEqual(v.criteria.map((c) => [c.id, c.text, c.label, c.detail, c.checks, c.note, c.loud]), [
    ['c1', 'Empty input returns []', 'shown by checks', 'failed before the change, passes now', 'checks: unit', '', false],
    ['c2', 'c2', 'shown by checks', 'the new tests fail without the change', 'checks: unit, e2e', '', false],
    ['c3', 'The README names the flag', "reviewer's judgement, with cited evidence", '', '', 'H-0123456789 adds the flag', false],
    ['c4', 'c4', 'passes, but passed before the change too', '', 'all required checks', '', false],
    ['c5', 'c5', 'not met', '', 'checks: unit', '', true],
    ['c6', 'c6', 'unclear', '', '', '', false],
    ['c7', 'c7', 'not decided yet', '', '', '', false],
    ['c8', 'c8', 'half met', '', '', '', false],
  ]);
  assert.equal(v.score, 'Evidence score 0.65 · major');
  assert.equal(v.parts, 'answer 1.00 · trajectory 0.88 · 17% of outputs with a violation');
  assert.deepEqual([v.probe, v.observe], ['', false], 'probe not needed: no line; enforce: no note');
  assert.equal(evidenceView(null), null, 'an older engine says nothing');
  assert.equal(evidenceView(parseStatus(runStatus({ grounding: { ...G24, outputs: 0, criteria: [], violations: {} } })).grounding), null, 'nothing evaluated yet');
  const junk = evidenceView(parseStatus(runStatus({ grounding: { outputs: 1, adjusted: 'high', answer: {}, violation_rate: null } })).grounding);
  assert.deepEqual([junk.score, junk.parts], ['', ''], 'unreadable numbers are left out, never NaN');
  const rounding = evidenceView(parseStatus(runStatus({ grounding: { ...G24, adjusted: 0.9375, tier: 'clean', violation_rate: 0.004 } })).grounding);
  assert.equal(rounding.score, 'Evidence score 0.94 · clean');
  assert.match(rounding.parts, / · 0% of outputs with a violation$/);
});

// guards the VIOLATION_TEXT words, `own(VIOLATION_TEXT, kind) ?? str(kind)` and the PROBE_TEXT line
test('evidenceView: violations by kind in words with their count, unknown kinds raw; the probe line only for three outcomes', () => {
  const kinds = ['unknown_citation', 'unsupported_assessment', 'unsupported_finding', 'unseen_target', 'unseen_edit', 'false_absence', 'protected_request', 'out_of_scope_edit', 'brand_new_kind'];
  const v = evidenceView(parseStatus(runStatus({ grounding: { ...G24, violations: Object.fromEntries(kinds.map((k, i) => [k, i + 1])) } })).grounding);
  assert.deepEqual(v.violations.map((x) => `${x.count} ${x.label}`), [
    '1 cited evidence that was never shown', '2 criterion marked met without evidence', '3 finding without evidence',
    '4 planned a change to a file it had not read', '5 edited a file it had not been shown', '6 claimed something was missing that exists',
    '7 asked for a protected path', "8 edited outside the step's files", '9 brand_new_kind',
  ]);
  const probe = (status) => evidenceView(parseStatus(runStatus({ grounding: { ...G24, probe: { status } } })).grounding).probe;
  assert.equal(probe('demonstrated'), 'Counterfactual probe: the new tests fail without the change');
  assert.equal(probe('not_demonstrated'), 'Counterfactual probe: the tests pass even without the change');
  assert.equal(probe('inconclusive'), 'Counterfactual probe: could not be run');
  for (const quiet of ['not_needed', 'off', 'toString', 7]) assert.equal(probe(quiet), '', String(quiet));
  assert.equal(evidenceView(parseStatus(runStatus({ grounding: { ...G24, mode: 'observe' } })).grounding).observe, true);
  assert.deepEqual(['criteria_not_demonstrated', 'grounding_violations', 'deletes_files', 'constructor'].map(riskFlagText), [
    "A criterion's checks passed before the change too", 'Output that was not backed by evidence was accepted (observe only)', 'deletes files', 'constructor',
  ]);
});

// guards the violationsLead line of evidenceView (section 21.7 as amended)
test('evidenceView: the violation counts say whether the output was rejected and repaired or accepted', () => {
  const lead = (over) => evidenceView(parseStatus(runStatus({ grounding: { ...G24, ...over } })).grounding).violationsLead;
  assert.equal(lead({}), 'Rejected and repaired:');
  assert.equal(lead({ mode: 'observe' }), 'Accepted without evidence:');
  assert.equal(lead({ mode: 'observe', violations: {} }), '', 'nothing to introduce');
});

// the engine's own status.grounding objects (fixtures/engine-grounding.js), through parseStatus and evidenceView
test('evidenceView: real engine objects - integer scores, by none, an unclear review criterion without checks', () => {
  const review = parseReview({ verdict: 'approve', summary: '', criteria: [{ id: 'sum', status: 'unclear', evidence: 'no test covers negative numbers' }], findings: [] });
  const views = REAL_GROUNDING.map((g) => evidenceView(parseStatus(runStatus({ grounding: g })).grounding, null, review));
  assert.deepEqual(views.map((v) => [v.criteria.map((c) => [c.id, c.text, c.label, c.detail, c.checks, c.note, c.loud]), v.score, v.parts,
    v.violations.map((x) => `${x.count} ${x.label}`), v.violationsLead, v.probe, v.observe]), [
    [[['sum', 'sum', 'shown by checks', 'failed before the change, passes now', 'checks: test', '', false]], 'Evidence score 0.52 · major',
      'answer 1.00 · trajectory 0.83 · 25% of outputs with a violation', ['1 planned a change to a file it had not read'], 'Rejected and repaired:', '', false],
    [[['sum', 'sum', 'passes, but passed before the change too', '', 'checks: test', '', false]], 'Evidence score 0.38 · major',
      'answer 1.00 · trajectory 0.33 · 25% of outputs with a violation', ['1 planned a change to a file it had not read'], 'Rejected and repaired:', '', false],
    [[['sum', 'sum', 'unclear', '', '', 'no test covers negative numbers', false]], 'Evidence score 0.64 · major',
      'answer 1.00 · trajectory 1.00 · 20% of outputs with a violation', ['1 criterion marked met without evidence'], 'Rejected and repaired:', '', false],
  ]);
});

// guards the `rating` and `observeNote` lines of evidenceView (F10)
test('evidenceView: a tier that is not clean is explained as a rating of the models, with how many outputs it rejected or accepted', () => {
  const view = (g) => evidenceView(parseStatus(runStatus({ grounding: g })).grounding);
  const real = view(REAL_EVIDENCE_DEMO);
  assert.deepEqual([real.score, real.parts, real.rating, real.observeNote], ['Evidence score 0.25 · failing', 'answer 1.00 · trajectory 0.39 · 40% of outputs with a violation',
    'The score rates how the models worked, not the change itself: 2 of 5 outputs were rejected and repaired.', false]);
  const lead = 'The score rates how the models worked, not the change itself';
  const g = (over) => ({ ...REAL_EVIDENCE_DEMO, ...over });
  assert.equal(view(g({ violation_rate: 0.2, tier: 'major' })).rating, `${lead}: 1 of 5 outputs was rejected and repaired.`);
  assert.equal(view(g({ violation_rate: 1, outputs: 1, tier: 'minor' })).rating, `${lead}: 1 of 1 output was rejected and repaired.`);
  const observed = view(g({ mode: 'observe' }));
  assert.deepEqual([observed.rating, observed.observe, observed.observeNote], [`${lead}: 2 of 5 outputs were accepted without evidence.`, true, false],
    'the count already says nothing was rejected');
  for (const outputs of [0, undefined, -2, 2.5, '5']) {
    assert.equal(view(g({ outputs })).rating, `${lead}.`, String(outputs));
    assert.equal(view(g({ outputs, mode: 'observe' })).observeNote, true, `${outputs}: without a count the observe note stays`);
  }
  assert.equal(view(g({ violation_rate: 'high' })).rating, `${lead}.`, 'no rate, no count');
  assert.equal(view(g({ violation_rate: 0.04, mode: 'observe' })).observeNote, true, '0 accepted outputs say nothing about the mode');
  for (const tier of ['clean', undefined, 'excellent', {}]) {
    assert.equal(view(g({ tier })).rating, '', String(tier));
    assert.equal(view(g({ tier, mode: 'observe' })).observeNote, true, `${tier}: observe note`);
  }
  assert.equal(view(g({ mode: 'enforce', tier: 'clean' })).observeNote, false);
  for (const odd of [{ outputs: {}, violation_rate: [] }, { outputs: 3, violation_rate: NaN }, { outputs: 7, violation_rate: 0.3333 }]) {
    assert.doesNotMatch(view(g(odd)).rating, NO_JUNK, JSON.stringify(odd));
  }
  assert.equal(view(g({ outputs: 7, violation_rate: 0.3333 })).rating, `${lead}: 2 of 7 outputs were rejected and repaired.`);
});

// guards the absence_refuted entry of EVENT_TEXT (F10)
test('eventText: a refuted absence names where the claimed missing thing was found', () => {
  const ev = (data) => parseRunDoc({ status: runStatus(), events: [{ seq: 1, type: 'absence_refuted', node: null, data }] }).events[0];
  const real = parseRunDoc({ status: runStatus(), events: [REAL_ABSENCE_REFUTED] }).events[0];
  assert.equal(eventText(real), 'Refuted: add exists at calculator.py:1');
  const hit = (path, line) => ({ path, line });
  assert.equal(eventText(ev({ kind: 'missing_symbol', subject: 'add', hits: [hit('calculator.py', 1), hit('ops.py', 4), hit('lib/x.py', 9)] })),
    'Refuted: add exists at calculator.py:1 and 2 more places');
  assert.equal(eventText(ev({ subject: 'add', hits: [hit('calculator.py', 1), hit('ops.py', 4)] })), 'Refuted: add exists at calculator.py:1 and 1 more place');
  assert.equal(eventText(ev({ kind: 'missing_file', subject: 'src/util.py', hits: [{ path: 'src/util.py' }] })), 'Refuted: src/util.py exists at src/util.py');
  assert.equal(eventText(ev({ kind: 'missing_file', subject: 'a.py', hits: [hit('a.py', null)] })), 'Refuted: a.py exists at a.py');
  assert.equal(eventText(ev({ subject: 'a.py', hits: [hit('a.py', 0), hit('b.py', '3'), hit('c.py', -1), hit('d.py', 2.5)] })), 'Refuted: a.py exists at a.py and 3 more places');
  assert.equal(eventText(ev({ subject: 'add', hits: [null, 'calculator.py', [], { line: 1 }, { path: 7 }, hit('', 2), hit('calc.py', 3)] })), 'Refuted: add exists at calc.py:3',
    'unusable hits are skipped and not counted');
  for (const hits of [[], undefined, 'calculator.py', [{}], { path: 'x' }]) {
    assert.equal(eventText(ev({ subject: 'add', hits })), 'Refuted: add exists in the project', JSON.stringify(hits));
  }
  for (const subject of [undefined, '', 7, {}, ['add']]) {
    assert.equal(eventText(ev({ subject, hits: [hit('calculator.py', 1)] })), 'Refuted: the claimed absence', String(subject));
  }
  assert.equal(eventText(ev({})), 'Refuted: the claimed absence');
  assert.doesNotMatch(eventText(ev({ subject: 'x', hits: [{ path: 'p', line: {} }, { path: {}, line: 1 }] })), NO_JUNK);
  assert.equal(eventLoud(real), false, 'a refuted claim is good news');
  assert.deepEqual(activityEvents([real]).map((e) => e.type), ['absence_refuted']);
});

// guards the grounding / absence_verified / criteria_decided / probe_finished entries of EVENT_TEXT, activityEvents, eventLoud and NODE_LABEL
test('eventText: rejected outputs, verified absences, decided criteria and the probe in words; accepted outputs and procedure events get no entry', () => {
  const ev = (type, data) => parseRunDoc({ status: runStatus(), events: [{ seq: 1, type, node: 'ground', data }] }).events[0];
  const rejected = ev('grounding', { role: 'implementer', scope: 'step:s1', accepted: false, violations: ['unseen_edit', 'unknown_citation', 'unseen_edit'], cited: 2, shown: 9 });
  assert.equal(eventText(rejected), 'Implementer output rejected: edited a file it had not been shown, cited evidence that was never shown');
  assert.equal(eventText(ev('grounding', { role: 'planner', accepted: false, violations: ['unseen_target'] }), { observe: true }), 'Planner output recorded: planned a change to a file it had not read');
  assert.equal(eventText(ev('grounding', { role: 7, accepted: false, violations: ['brand_new_kind', 3] })), 'Model output rejected: brand_new_kind');
  assert.equal(eventText(ev('grounding', { role: 'constructor', accepted: false, violations: 'x' })), 'constructor output rejected: no violation named');
  assert.equal(eventText(ev('absence_verified', { kind: 'missing_file', subject: 'src/legacy.py', files_searched: 42 })), 'Verified: src/legacy.py was not found in the 42 files models may read');
  assert.equal(eventText(ev('absence_verified', { kind: 'missing_symbol', subject: 'parse_v2', files_searched: 1 })), 'Verified: parse_v2 was not found in the 1 file models may read');
  assert.equal(eventText(ev('absence_verified', { subject: {}, files_searched: '3' })), 'Verified: it was not found in the files models may read');
  assert.equal(eventText(ev('criteria_decided', { states: { demonstrated: 2, met_not_demonstrated: 1, not_met: 0, odd_state: 1, attested: '1' } })),
    'criteria decided: 2 shown by checks; 1 passes, but passed before the change too; 1 odd state');
  assert.equal(eventText(ev('criteria_decided', { states: [] })), 'criteria decided');
  for (const [status, words] of [['demonstrated', 'the new tests fail without the change'], ['not_demonstrated', 'the tests pass even without the change'],
    ['inconclusive', 'could not be run'], ['not_needed', 'not needed'], ['off', 'off']]) {
    assert.equal(eventText(ev('probe_finished', { status, checks: ['unit'] })), `counterfactual probe: ${words} (unit)`, status);
  }
  assert.equal(eventText(ev('probe_finished', { status: null, checks: null })), 'counterfactual probe: finished');
  for (const type of ['grounding', 'absence_verified', 'criteria_decided', 'probe_finished']) {
    const odd = { role: {}, accepted: false, violations: [{}], subject: [], files_searched: {}, states: { x: {} }, status: {}, checks: [{}] };
    assert.doesNotMatch(eventText(ev(type, odd)), NO_JUNK, type);
  }
  const events = [
    ev('grounding', { accepted: true }), ev('grounding', { accepted: false }), ev('grounding', { accepted: 'no' }), ev('grounding', {}),
    ev('procedure', { role: 'planner', scope: 'plan', situation: 'plan.start', matched: true }), ev('absence_verified', {}),
  ];
  assert.deepEqual(activityEvents(events).map((e) => [e.type, e.data.accepted]), [['grounding', false], ['absence_verified', undefined]]);
  assert.equal(eventLoud(rejected), true, 'a rejected output is loud');
  assert.equal(eventLoud(rejected, { observe: true }), false, 'a recorded one is not');
  assert.equal(eventLoud(ev('probe_finished', {})), false);
  assert.deepEqual(['ground', 'verify', 'constructor', null].map(nodeLabel), ['Check evidence', 'verify', 'constructor', '']);
  assert.equal(phaseOfNode('ground'), 'review');
});

// guards `if (s.procedure.enabled && s.procedure.situation) parts.push(...)` in runLine
test('runLine: guidance names its situation once, only while it is enabled and has one', () => {
  const parts = (procedure) => runLine(parseStatus(runStatus({ procedure }))).parts;
  const on = parts({ enabled: true, name: 'default', digest: 'ab12', situation: 'implement.repair' });
  assert.deepEqual(on.filter((p) => p.startsWith('guidance')), ['guidance: implement.repair']);
  for (const p of [{ enabled: true, name: 'default', digest: 'ab12', situation: null }, { enabled: false, situation: 'plan.start' }, undefined]) {
    assert.ok(!parts(p).some((x) => x.startsWith('guidance')), JSON.stringify(p));
  }
});

// guards `const evidenceOf = ...` and both `...evidenceOf(form)` in buildRunBody
test('buildRunBody: grounding and guidance are always sent, enforce and off unless chosen, for the demo too', () => {
  const pick = (r) => [r.body.grounding, r.body.guidance];
  assert.deepEqual(pick(buildRunBody({ ...FORM, grounding: 'observe', guidance: true })), ['observe', true]);
  for (const odd of [{}, { grounding: 'Observe', guidance: 'true' }, { grounding: null, guidance: 1 }, { grounding: 'enforce', guidance: false, conversation: true }]) {
    assert.deepEqual(pick(buildRunBody({ ...FORM, ...odd })), ['enforce', false], JSON.stringify(odd));
  }
  assert.deepEqual(pick(buildRunBody({ demo: true, task: '', delivery: 'apply', sandbox: 'docker', grounding: 'observe', guidance: true })), ['observe', true]);
  assert.deepEqual(pick(buildRunBody({ demo: true, task: '', delivery: 'apply', sandbox: 'docker' })), ['enforce', false]);
});
