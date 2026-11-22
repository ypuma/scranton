import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, HELP } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { createProjectRegistry } from '../../src/core/projects.js';
import { createContext } from '../../src/core/context/index.js';
import { EventRecorder } from '../../src/core/events.js';
import { loadConfig, PACKAGE_ROOT } from '../../src/core/config.js';
import { promptAudit } from '../../src/core/prompts.js';
import { auditRole } from '../../src/core/agents-config.js';
import { teamDreamingContext } from '../../src/core/dreaming-sources.js';
import { createProviderStore } from '../../src/core/providers.js';

function fixture(t) {
  const root = path.resolve('.scratch/context-system/lane-b2'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'data'), registry = createProjectRegistry({ dataDir, projectsRoot: path.join(dir, 'workspaces') });
  const project = registry.addProject({ name: 'Project', create: true }), chat = registry.createChat(project.id, { title: 'First chat' });
  const context = createContext({ dataDir, registry });
  const calls = [];
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  function turn(chat, id, request, config) {
    const start = { type: 'run_started', request, maxFailedCycles: 3, ...(config ? { execution: { workflow: config.workflow }, prompts: promptAudit(config), roles: config.workflow.gates.flat().map((id) => auditRole({ ...config.roles.find((r) => r.id === id), tools: config.agents[id].tools })) } : {}) };
    const rows = [start, ...(config ? [1, 2, 3].map((cycle) => ({ type: 'cycle_result', milestoneId: 'm1', cycle, result: 'failed' })) : []),
      { type: 'milestone_finished', milestoneId: 'm1', status: config ? 'failed' : 'passed' }, { type: 'run_finished', status: config ? 'failed' : 'success', summary: 'Outcome ' + request }];
    write(path.join(chat.hiveDir, 'runs', id, 'events.jsonl'), rows.map((row, i) => JSON.stringify({ v: 1, seq: i + 1, runId: id, ts: '2026-01-01T00:00:00.000Z', ...row })).join('\n') + '\n');
  }
  async function invoke(args, env = {}) {
    let output = '', errors = '';
    const code = await runCli(args, { cwd: dir, env, stdout: { isTTY: false, write(s) { output += s; } }, stderr: { isTTY: false, write(s) { errors += s; } } });
    return { code, output, errors };
  }
  const flags = ['--data', dataDir, '--project', project.id];
  const command = (args, extra = [], env = {}) => invoke(['context', ...args, ...flags, ...extra], env);
  const run = (extra = [], request = 'Current goal') => invoke(['run', request, ...flags, '--trusted-host', ...extra]);
  function mockRun(record = false) {
    t.mock.method(Orchestrator.prototype, 'run', async function (request) {
      calls.push({ request, text: this.threadContext, developer: this.developerContext, ceiling: this.config.maxFailedCycles, hive: this.config.hiveDir });
      if (record) {
        const recorder = new EventRecorder({ hiveDir: this.config.hiveDir, runId: this.runId }); recorder.start();
        recorder.emit('run_started', { request, maxFailedCycles: this.config.maxFailedCycles });
        recorder.emit('run_finished', { status: 'success', summary: 'Delivered ' + request });
      }
      return { status: 'success', cleanupComplete: true };
    });
  }
  async function memory() {
    const config = loadConfig({ cwd: PACKAGE_ROOT, env: {}, flags: { trustedHost: true } });
    for (const id of ['one', 'two', 'three']) turn(chat, id, 'Earlier ' + id, config);
    const dream = registry.dreaming(project.id);
    try { dream.sweep(); dream.configure({ applyPolicy: true }); return dream.context(); }
    finally { await dream.close(); }
  }
  return { dir, dataDir, registry, project, chat, context, calls, write, turn, invoke, command, run, flags, mockRun, memory };
}
const ok = (r) => { assert.equal(r.code, 0, r.errors); return r; };
const json = (r) => JSON.parse(ok(r).output);

// Regression anchor: cmdRun's forTeam call and both pack assignments; reverting to formatThreadContext loses the brief and siblings.
test('registry turns use the exact Team pack and brief; same-chat continuity, siblings and project isolation', async (t) => {
  const f = fixture(t); f.mockRun(true);
  ok(await f.run(['--chat', f.chat.id], 'FIRST-REQUEST'));
  assert.equal(f.calls[0].text, ''); assert.equal(f.calls[0].developer, '');
  const first = f.context.forTeam(f.project.id, f.chat.id);
  ok(await f.run(['--chat', f.chat.id], 'SECOND-REQUEST'));
  assert.equal(f.calls[1].text, first.text); assert.equal(f.calls[1].developer, first.developer);
  assert.match(f.calls[1].text, /FIRST-REQUEST/); assert.match(f.calls[1].developer, /FIRST-REQUEST/);
  const foreign = f.registry.addProject({ name: 'Foreign', create: true }), foreignChat = f.registry.createChat(foreign.id);
  f.turn(foreignChat, 'foreign', 'FOREIGN-SECRET');
  ok(await f.run([], 'NEW-CHAT'));
  const call = f.calls[2], newChat = f.registry.listChats(f.project.id).find((c) => c.hiveDir === call.hive);
  assert.match(call.text, /Other chats/); assert.match(call.text, /#2 \[success\] SECOND-REQUEST -> Delivered SECOND-REQUEST/);
  assert.doesNotMatch(call.text + call.developer, /FOREIGN-SECRET/); assert.equal(call.developer, '');
  // The new run has finished by now; compare its earlier sibling section, not its own newly recorded turn.
  assert.equal(call.text, f.context.inspect(f.project.id, newChat.id).sections.find((s) => s.id === 'other-chats').text);
});

// Regression anchors: cmdRun uses memory inside forTeam, never teamDreamingContext for a generated pack.
test('registry pack renders notes, memory, siblings, earlier and recent in order', async (t) => {
  const f = fixture(t); f.mockRun(); const memory = await f.memory(); assert.ok(memory);
  f.context.setNotes(f.project.id, 'STANDING-NOTES');
  for (let i = 4; i <= 12; i++) f.turn(f.chat, 'turn' + i, 'Earlier task ' + i);
  const sibling = f.registry.createChat(f.project.id); f.turn(sibling, 'sibling', 'SIBLING-TASK');
  // Additions do not alter the source-bound memory of the first three runs.
  const dream = f.registry.dreaming(f.project.id); let currentMemory;
  try { currentMemory = dream.context(); } finally { await dream.close(); }
  const expected = f.context.forTeam(f.project.id, f.chat.id, { memory: currentMemory });
  ok(await f.run(['--chat', f.chat.id])); assert.equal(f.calls[0].text, expected.text); assert.equal(f.calls[0].developer, expected.developer);
  const headings = ['Project notes', 'Project memory', 'Other chats', 'This chat - earlier', 'This chat - recent'];
  const offsets = headings.map((heading) => f.calls[0].text.indexOf(heading));
  assert.ok(offsets.every((n, i) => n >= 0 && (!i || n > offsets[i - 1])), JSON.stringify(offsets));
});

// Regression anchors: contextVersion === 2 skips memory read/merge but still applies dreamingCap; v1 retains teamDreamingContext.
for (const version of [1, 2]) test(`registry v${version} file keeps its transport semantics and Dreaming cycle cap`, async (t) => {
  const f = fixture(t); f.mockRun(); const memory = await f.memory(); assert.ok(memory);
  const input = { v: version, text: 'Already built pack\nMEMORY-ONCE', ...(version === 2 ? { developer: 'Existing brief' } : {}) };
  const file = f.write(path.join(f.dir, 'transport.json'), input);
  ok(await f.run(['--chat', f.chat.id, '--thread-context', file]));
  assert.equal(f.calls[0].ceiling, 1);
  assert.equal(f.calls[0].text, version === 2 ? input.text : teamDreamingContext(input.text, memory));
  assert.equal(f.calls[0].developer, version === 2 ? input.developer : '');
});

// Regression anchor: cmdRun builds forTeam outside the optional Dreaming try/catch with memory='' after failure.
test('unsafe optional Dreaming cannot prevent context, developer brief or a registry run', async (t) => {
  const f = fixture(t); f.mockRun(); f.turn(f.chat, 'old', 'HISTORICAL'); f.context.setNotes(f.project.id, 'NOTES');
  const target = path.join(f.dir, 'redirect'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.dataDir, 'projects', f.project.id, 'dreaming'), process.platform === 'win32' ? 'junction' : 'dir');
  ok(await f.run(['--chat', f.chat.id, '--max-cycles', '5']));
  const expected = f.context.forTeam(f.project.id, f.chat.id);
  assert.equal(f.calls[0].text, expected.text); assert.equal(f.calls[0].developer, expected.developer); assert.equal(f.calls[0].ceiling, 5);
});

// Regression anchors for command tests: runCli's context dispatch; cmdContext action branches and contextSummary rendering.
test('context show prints project/chat documents, counters, exact sections, brief and raw JSON', async (t) => {
  const f = fixture(t); f.turn(f.chat, 'old', 'OLD-REQUEST');
  const project = json(await f.command(['show', '--json'])); assert.deepEqual(project, f.context.status(f.project.id));
  const output = ok(await f.command(['show'])).output;
  assert.match(output, /Sharing: on; notes: 0\/16000 chars/); assert.match(output, new RegExp(`${f.chat.id} \\| First chat \\| team \\| 1 turns`));
  const doc = json(await f.command(['show', '--chat', f.chat.id, '--json'])); assert.deepEqual(doc, f.context.inspect(f.project.id, f.chat.id));
  const text = ok(await f.command(['show', '--chat', f.chat.id])).output;
  assert.match(text, /Turns: 1 total; 1 visible; 1 detailed; 0 condensed; 0 omitted/); assert.match(text, /Budget: ≈\d+\/12800 tokens \(.*128000-token window of Automatic\) \[window assumed\]/);
  for (const section of doc.sections) { assert.ok(text.includes(`${section.title} (${section.chars} chars; ≈${section.tokens} tokens)`)); assert.ok(text.includes(section.text)); }
  assert.ok(text.includes(`Developer brief: ≈${doc.developer.tokens}/1280 tokens`)); assert.ok(text.includes(doc.developer.text));
  assert.equal(project.v, 2); assert.equal(doc.v, 2);
});

test('context show includes existing advisory memory and supports Pipeline documents', async (t) => {
  const f = fixture(t); const memory = await f.memory();
  const doc = json(await f.command(['show', '--chat', f.chat.id, '--json']));
  assert.deepEqual(doc, f.context.inspect(f.project.id, f.chat.id, { memory })); assert.ok(doc.memory.chars > 0);
  const pipe = f.registry.createChat(f.project.id, { engine: 'pipeline' });
  const pipeline = json(await f.command(['show', '--chat', pipe.id, '--json']));
  assert.equal(pipeline.engine, 'pipeline'); assert.equal(pipeline.developer, null); assert.equal(pipeline.budget.tokens, 12800); assert.equal(pipeline.v, 2); assert.equal(Object.hasOwn(pipeline.budget, 'limit'), false);
  const output = ok(await f.command(['show', '--chat', pipe.id])).output;
  assert.match(output, /\/12800 tokens/); assert.doesNotMatch(output, /Developer brief/);
});

test('notes reads UTF-8, normalizes and clears; sharing on/off changes show and sibling injection', async (t) => {
  const f = fixture(t), file = f.write(path.join(f.dir, 'notes.md'), 'Prefer concise replies.\r\nUnicode: 界');
  ok(await f.command(['notes', '--file', file]));
  assert.equal(json(await f.command(['show', '--json'])).notes.text, 'Prefer concise replies.\nUnicode: 界');
  const sibling = f.registry.createChat(f.project.id); f.turn(sibling, 'old', 'SIBLING-ONLY');
  for (const sharing of ['off', 'on']) {
    ok(await f.command(['share', sharing]));
    const project = json(await f.command(['show', '--json'])); assert.equal(project.settings.crossChat, sharing === 'on');
    const chat = json(await f.command(['show', '--chat', f.chat.id, '--json']));
    assert.equal(chat.otherChats.chats, sharing === 'on' ? 1 : 0);
    assert.match(ok(await f.command(['show'])).output, new RegExp(`Sharing: ${sharing}`));
  }
  ok(await f.command(['notes', '--clear'])); assert.equal(json(await f.command(['show', '--json'])).notes.chars, 0);
});

test('reset then restore changes visible counters and sections but preserves project run counts on disk', async (t) => {
  const f = fixture(t); f.turn(f.chat, 'old', 'RESET-ME');
  assert.match(ok(await f.command(['show', '--chat', f.chat.id])).output, /RESET-ME/);
  ok(await f.command(['reset', '--chat', f.chat.id]));
  let doc = json(await f.command(['show', '--chat', f.chat.id, '--json']));
  assert.equal(doc.turns.total, 1); assert.equal(doc.turns.visible, 0); assert.ok(doc.reset.at);
  assert.doesNotMatch(ok(await f.command(['show', '--chat', f.chat.id])).output, /RESET-ME/);
  const chat = json(await f.command(['show', '--json'])).chats[0]; assert.equal(chat.turns, 1); assert.equal(chat.reset, true);
  ok(await f.command(['restore', '--chat', f.chat.id]));
  doc = json(await f.command(['show', '--chat', f.chat.id, '--json'])); assert.equal(doc.turns.visible, 1); assert.equal(doc.reset, null);
  assert.match(ok(await f.command(['show', '--chat', f.chat.id])).output, /RESET-ME/);
  assert.equal(json(await f.command(['show', '--json'])).chats[0].turns, 1);
});

// Regression anchors: terminalText strips the same unsafe formatting as run_reply; JSON escaping retains raw values.
test('human context output strips controls, ANSI and bidi; JSON round-trips raw notes', async (t) => {
  const f = fixture(t), note = 'Safe\u202e\u2066\ufe0f notes';
  f.context.setNotes(f.project.id, note); f.turn(f.chat, 'old', 'Request\x1b[31m\u202e\x07 end');
  const output = ok(await f.command(['show', '--chat', f.chat.id])).output;
  assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufe0f]/); assert.match(output, /Safe notes/);
  const raw = ok(await f.command(['show', '--json'])).output;
  assert.doesNotMatch(raw, /[\u202e\u2066\ufe0f]/); assert.equal(JSON.parse(raw).notes.text, note);
});

// Regression anchor: statSync(...).size > LIMITS.notesBytes rejects before readFileSync; module validation errors become UsageError unchanged.
test('notes rejects oversized files before reading, character overflow, missing files and directories with code 2', async (t) => {
  const f = fixture(t), file = f.write(path.join(f.dir, 'large.md'), 'x'.repeat(65537));
  const read = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', function (target, ...args) { if (target === file) reads++; return read.call(this, target, ...args); });
  let result = await f.command(['notes', '--file', file]); assert.equal(result.code, 2); assert.match(result.errors, /exceeds 65536 bytes/); assert.equal(reads, 0);
  f.write(file, 'x'.repeat(16001)); result = await f.command(['notes', '--file', file]);
  assert.equal(result.code, 2); assert.match(result.errors, /Context notes limit exceeded/);
  for (const input of [path.join(f.dir, 'missing'), f.dir]) { result = await f.command(['notes', '--file', input]); assert.equal(result.code, 2); }
  assert.equal(f.context.status(f.project.id).notes.chars, 0);
});

for (const [name, args, message] of [
  ['missing action', [], /context requires/], ['unknown action', ['unknown'], /context requires/],
  ['extra argument', ['show', 'extra'], /context requires/], ['reset missing chat', ['reset'], /requires --chat ID/],
  ['restore missing chat', ['restore'], /requires --chat ID/], ['notes missing source', ['notes'], /exactly one/],
  ['notes conflicting sources', ['notes', '--clear', '--file', 'notes.md'], /exactly one/],
  ['share missing value', ['share'], /context requires/], ['share invalid value', ['share', 'yes'], /requires on\|off/],
  ['share chat', ['share', 'on', '--chat', 'missing'], /--chat is only valid/],
  ['show file', ['show', '--file', 'notes.md'], /only valid for context notes/]
]) test(`context usage rejects ${name}`, async (t) => {
  const f = fixture(t), result = await f.command(args);
  assert.equal(result.code, 2); assert.match(result.errors, message); assert.match(result.errors, /Run "scranton help" for usage/);
});

test('context requires registry scope, accepts inherited SCRANTON_DATA and resolves relative files against cwd', async (t) => {
  const f = fixture(t);
  for (const args of [['context', 'show'], ['context', 'show', '--project', f.project.id], ['context', 'show', '--data', f.dataDir], ['context', 'show', ...f.flags, '--single-hive']]) {
    const result = await f.invoke(args); assert.equal(result.code, 2); assert.match(result.errors, /Registry projects only|conflicts with registry options/);
  }
  f.write(path.join(f.dir, 'relative.md'), 'Relative note');
  ok(await f.invoke(['context', 'notes', '--project', f.project.id, '--file', 'relative.md'], { SCRANTON_DATA: f.dataDir }));
  const doc = json(await f.invoke(['context', 'show', '--project', f.project.id, '--json'], { SCRANTON_DATA: f.dataDir }));
  assert.equal(doc.notes.text, 'Relative note');
  for (const syntax of ['context show', 'context budget', 'context notes', 'context share', 'context reset|restore']) assert.ok(HELP.includes(syntax));
});

for (const action of ['show', 'budget', 'notes', 'share', 'reset', 'restore']) test(`context ${action} reports unknown projects/chats with code 2`, async (t) => {
  const f = fixture(t), args = [action, ...(action === 'notes' ? ['--clear'] : action === 'share' ? ['on'] : action === 'budget' ? ['--default'] : []), ...(['reset', 'restore'].includes(action) ? ['--chat', f.chat.id] : [])];
  let result = await f.invoke(['context', ...args, '--data', f.dataDir, '--project', 'missing']);
  assert.equal(result.code, 2); assert.match(result.errors, /Project not found/);
  if (['show', 'reset', 'restore'].includes(action)) {
    result = await f.command([action, '--chat', 'missing']); assert.equal(result.code, 2); assert.match(result.errors, /Chat not found/);
    const other = f.registry.addProject({ name: 'Other', create: true }), chat = f.registry.createChat(other.id);
    result = await f.command([action, '--chat', chat.id]); assert.equal(result.code, 2); assert.match(result.errors, /Chat not found/);
  }
});

// Regression anchor: cmdContext's --json branch must serialize each mutation's returned document, not its text summary.
test('every context mutation supports raw --json results', async (t) => {
  const f = fixture(t), file = f.write(path.join(f.dir, 'notes.md'), 'JSON note'); f.turn(f.chat, 'old', 'JSON-REQUEST');
  let doc = json(await f.command(['notes', '--file', file, '--json'])); assert.deepEqual(doc, f.context.status(f.project.id));
  doc = json(await f.command(['share', 'off', '--json'])); assert.deepEqual(doc, f.context.status(f.project.id)); assert.equal(doc.settings.crossChat, false);
  doc = json(await f.command(['share', 'on', '--json'])); assert.equal(doc.settings.crossChat, true);
  doc = json(await f.command(['reset', '--chat', f.chat.id, '--json'])); assert.deepEqual(doc, f.context.inspect(f.project.id, f.chat.id)); assert.equal(doc.turns.visible, 0);
  doc = json(await f.command(['restore', '--chat', f.chat.id, '--json'])); assert.deepEqual(doc, f.context.inspect(f.project.id, f.chat.id)); assert.equal(doc.turns.visible, 1);
  doc = json(await f.command(['notes', '--clear', '--json'])); assert.equal(doc.notes.chars, 0);
});

async function declaredModels(t, f) {
  const agentDir = path.join(f.dir, 'credentials');
  const previous = process.env.SCRANTON_CREDENTIALS_DIR;
  process.env.SCRANTON_CREDENTIALS_DIR = agentDir;
  t.after(() => { if (previous === undefined) delete process.env.SCRANTON_CREDENTIALS_DIR; else process.env.SCRANTON_CREDENTIALS_DIR = previous; });
  await createProviderStore(agentDir).add({ id: 'cli-budget', baseUrl: 'https://example.invalid/v1', api: 'openai-completions', models: [
    { id: 'small', contextWindow: 32000 }, { id: 'large', contextWindow: 1000000 }
  ] });
  f.write(path.join(f.dataDir, 'agents.json'), { v: 1, agents: {
    michael: { model: { provider: 'cli-budget', model: 'small' } }, dwight: { model: { provider: 'cli-budget', model: 'large' } }
  } });
}

// Regression: cmdContext's budget branch must pass { budget: rule } or a computed-key { models: ... } merge patch.
test('context budget sets percent, tokens and default for project and model without replacing other settings', async (t) => {
  const f = fixture(t); f.context.configure(f.project.id, { crossChat: false });
  for (const [args, rule] of [[['--percent', '50'], { mode: 'percent', value: 50 }], [['--tokens', '1000'], { mode: 'tokens', value: 1000 }], [['--default'], { mode: 'percent', value: 10 }]]) {
    const doc = json(await f.command(['budget', ...args, '--json']));
    assert.deepEqual(doc.settings.budget, rule); assert.equal(doc.settings.crossChat, false); assert.deepEqual(doc.settings.models, {});
  }
  f.context.configure(f.project.id, { budget: { mode: 'tokens', value: 200000 }, models: { 'other/model': { mode: 'percent', value: 1 } } });
  for (const [args, rule] of [[['--percent', '1'], { mode: 'percent', value: 1 }], [['--tokens', '200000'], { mode: 'tokens', value: 200000 }], [['--default'], undefined]]) {
    const doc = json(await f.command(['budget', ...args, '--model', 'custom/path/model', '--json']));
    assert.deepEqual(doc.settings.models['custom/path/model'], rule); assert.deepEqual(doc.settings.models['other/model'], { mode: 'percent', value: 1 });
    assert.deepEqual(doc.settings.budget, { mode: 'tokens', value: 200000 }); assert.equal(doc.settings.crossChat, false);
  }
  const output = ok(await f.command(['budget', '--percent', '25'])).output;
  assert.ok(output.includes(JSON.stringify(f.context.status(f.project.id).settings)));
});

// Regression: the budget branch's exactly-one/range checks, model parser and option-scope guards must reject before configure().
for (const [name, args] of [
  ['no rule', ['budget']], ['percent and tokens', ['budget', '--percent', '10', '--tokens', '1000']],
  ['percent and default', ['budget', '--percent', '10', '--default']], ['tokens and default', ['budget', '--tokens', '1000', '--default']],
  ...['0', '51', '1.5', 'NaN', '1e1', '', ' 10', '0x10', '-1'].map((value) => ['percent ' + JSON.stringify(value), ['budget', `--percent=${value}`]]),
  ...['999', '200001', '1000.5', 'Infinity', '1e4', '', '-1'].map((value) => ['tokens ' + JSON.stringify(value), ['budget', `--tokens=${value}`]]),
  ...['__proto__', 'constructor', 'prototype', 'p/', '/m', 'p/a b', 'p/a\u0000b', 'p/a\u007fb', 'p/a\u0080b', 'p'.repeat(257) + '/m', 'p/' + 'm'.repeat(257)].map((value, i) => ['model ' + i, ['budget', '--default', '--model', value]]),
  ['extra positional', ['budget', '--default', 'extra']], ['chat scope', ['budget', '--default', '--chat', 'missing']],
  ['file option', ['budget', '--default', '--file', 'notes.md']], ['clear option', ['budget', '--default', '--clear']],
  ['percent outside budget', ['show', '--percent', '10']], ['tokens outside budget', ['show', '--tokens', '1000']],
  ['default outside budget', ['show', '--default']], ['model outside show or budget', ['share', 'on', '--model', 'p/m']],
  ['missing percent value', ['budget', '--percent']], ['missing tokens value', ['budget', '--tokens']], ['missing model value', ['budget', '--default', '--model']]
]) test(`context budget usage rejects ${name}`, async (t) => {
  const f = fixture(t), before = f.context.status(f.project.id), result = await f.command(args);
  assert.equal(result.code, 2, result.output); assert.match(result.errors, /Run "scranton help" for usage/);
  const message = name.startsWith('missing ') ? /argument is ambiguous/
    : name === 'no rule' || name.includes(' and ') ? /requires exactly one/
    : name.startsWith('percent ') && name !== 'percent outside budget' ? /--percent must be an integer from 1 to 50/
    : name.startsWith('tokens ') && name !== 'tokens outside budget' ? /--tokens must be an integer from 1000 to 200000/
    : /^model \d/.test(name) ? /--model requires PROVIDER\/MODEL/
    : name === 'extra positional' ? /context requires show\|budget/
    : name === 'chat scope' ? /--chat is only valid/
    : name === 'file option' || name === 'clear option' ? /only valid for context notes/
    : name === 'model outside show or budget' ? /--model is only valid/
    : /only valid for context budget/;
  assert.match(result.errors, message);
  assert.deepEqual(f.context.status(f.project.id), before); assert.equal(Object.hasOwn(Object.prototype, 'mode'), false);
});

// Regression: cmdContext must forward the model patch to configure(), which enforces the post-merge 32-key cap.
test('context budget refuses a 33rd model override but permits replacement and removal', async (t) => {
  const f = fixture(t);
  f.context.configure(f.project.id, { models: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`p/model${i}`, { mode: 'percent', value: 10 }])) });
  const before = f.context.status(f.project.id).settings;
  const result = await f.command(['budget', '--percent', '20', '--model', 'p/overflow']);
  assert.equal(result.code, 2); assert.deepEqual(f.context.status(f.project.id).settings, before);
  ok(await f.command(['budget', '--tokens', '1000', '--model', 'p/model0']));
  ok(await f.command(['budget', '--default', '--model', 'p/model1']));
  ok(await f.command(['budget', '--percent', '20', '--model', 'p/overflow']));
  assert.equal(Object.keys(f.context.status(f.project.id).settings.models).length, 32);
});

// Regression: contextBudgetLine's pct, assumed and capped suffixes; Team show must use both agents' modelSetting.value, ignoring --model.
test('context show prints exact known, assumed and capped Team budget lines from configured recipients', async (t) => {
  const f = fixture(t);
  let lines = ok(await f.command(['show', '--chat', f.chat.id])).output.split('\n');
  assert.ok(lines.includes('Budget: ≈0/12800 tokens (0% of budget, 0% of the 128000-token window of Automatic) [window assumed]'));
  assert.ok(lines.includes('Developer brief: ≈0/1280 tokens (0% of budget, 0% of the 128000-token window of Automatic) [window assumed]'));
  await declaredModels(t, f);
  lines = ok(await f.command(['show', '--chat', f.chat.id, '--model', 'ignored/pick'])).output.split('\n');
  assert.ok(lines.includes('Budget: ≈0/3200 tokens (0% of budget, 0% of the 32000-token window of cli-budget/small)'));
  assert.ok(lines.includes('Developer brief: ≈0/2000 tokens (0% of budget, 0% of the 1000000-token window of cli-budget/large)'));
  ok(await f.command(['budget', '--tokens', '50000']));
  lines = ok(await f.command(['show', '--chat', f.chat.id])).output.split('\n');
  assert.ok(lines.includes('Budget: ≈0/16000 tokens (0% of budget, 0% of the 32000-token window of cli-budget/small) [capped: window]'));
  const env = { SCRANTON_MICHAEL_PROVIDER: 'cli-budget', SCRANTON_MICHAEL_MODEL: 'large', SCRANTON_DWIGHT_MODEL: 'small' };
  const doc = json(await f.command(['show', '--chat', f.chat.id, '--json'], [], env));
  assert.equal(doc.model.window, 1000000); assert.equal(doc.developer.model.window, 32000);
  f.context.setNotes(f.project.id, 'ABC'.repeat(200));
  lines = ok(await f.command(['show', '--chat', f.chat.id])).output.split('\n');
  const used = json(await f.command(['show', '--chat', f.chat.id, '--json'])).budget.used;
  assert.ok(lines.includes(`Budget: ≈${used}/16000 tokens (${(used * 100 / 16000).toFixed(1)}% of budget, ${(used * 100 / 32000).toFixed(1)}% of the 32000-token window of cli-budget/small) [capped: window]`));
  assert.ok(lines.includes('Developer brief: ≈159/2000 tokens (8.0% of budget, <0.1% of the 1000000-token window of cli-budget/large)'));
  t.diagnostic(lines.filter((line) => /^(Budget|Developer brief):/.test(line)).join('\n'));
});

// Regression: Pipeline show's createModelWindows().resolve(contextModel(values.model)) must become inspect's planner recipient.
test('context show uses the Pipeline planner pick and reports engine caps and unknown windows exactly', async (t) => {
  const f = fixture(t); await declaredModels(t, f);
  const pipe = f.registry.createChat(f.project.id, { engine: 'pipeline' });
  const pick = ['show', '--chat', pipe.id, '--model', 'cli-budget/small'];
  let doc = json(await f.command([...pick, '--json']));
  assert.deepEqual(doc.model, { id: 'cli-budget/small', window: 32000, known: true }); assert.equal(doc.budget.tokens, 4000); assert.equal(doc.budget.capped, 'engine');
  let lines = ok(await f.command(pick)).output.split('\n');
  assert.ok(lines.includes('Budget: ≈0/4000 tokens (0% of budget, 0% of the 32000-token window of cli-budget/small) [capped: engine]'));
  assert.ok(!lines.some((line) => line.startsWith('Developer brief')));
  t.diagnostic(lines.find((line) => line.startsWith('Budget:')));
  doc = json(await f.command(['show', '--chat', pipe.id, '--model', 'cli-budget/large', '--json'])); assert.equal(doc.budget.tokens, 18750);
  lines = ok(await f.command(['show', '--chat', pipe.id, '--model', 'unknown-cli/model'])).output.split('\n');
  assert.ok(lines.includes('Budget: ≈0/12800 tokens (0% of budget, 0% of the 128000-token window of unknown-cli/model) [window assumed]'));
  for (const model of ['__proto__', 'p/', 'p/invalid pick', 'p/\u0080bad']) assert.equal((await f.command(['show', '--chat', pipe.id, '--model', model])).code, 2);
});

// Regression: cmdRun's `const recipients = await teamRecipients(config)` and `forTeam(..., { memory, recipients })`.
test('registry run budgets the generated pack for the models actually loaded, not Automatic', async (t) => {
  const f = fixture(t); f.mockRun(); await declaredModels(t, f);
  for (let i = 0; i < 14; i++) {
    f.turn(f.chat, 'turn' + i, 'Task ' + i);
    f.write(path.join(f.chat.hiveDir, 'runs', 'turn' + i, 'state.json'), { runId: 'turn' + i, status: 'finished', reply: { kind: 'report', text: 'Detailed reply '.repeat(1000) } });
  }
  const baseline = f.context.forTeam(f.project.id, f.chat.id);
  const recipients = { planner: { id: 'cli-budget/large', window: 1000000, known: true }, developer: { id: 'cli-budget/small', window: 32000, known: true } };
  const expected = f.context.forTeam(f.project.id, f.chat.id, { recipients });
  const env = { SCRANTON_MICHAEL_PROVIDER: 'cli-budget', SCRANTON_MICHAEL_MODEL: 'large', SCRANTON_DWIGHT_PROVIDER: 'cli-budget', SCRANTON_DWIGHT_MODEL: 'small' };
  const read = fs.readFileSync; let resolutions = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === path.join(f.dir, 'credentials/store.json')) resolutions++; return read(file, ...args); });
  ok(await f.invoke(['run', 'Current goal', ...f.flags, '--chat', f.chat.id, '--trusted-host'], env));
  assert.equal(resolutions, 2, 'one window lookup per effective recipient');
  assert.equal(f.calls[0].text, expected.text); assert.equal(f.calls[0].developer, expected.developer);
  assert.ok(expected.text.length > baseline.text.length, `${expected.text.length} > ${baseline.text.length}`);
  assert.equal(expected.meta.budget.tokens, 100000); assert.equal(expected.meta.developer.tokens, 320);
});

// Regression: CLI notes' stat cap must read LIMITS.notesBytes instead of the old 16384-byte cap.
test('notes accepts the v2 16000-character maximum above the old byte cap', async (t) => {
  const f = fixture(t), text = '\u754c'.repeat(16000), file = f.write(path.join(f.dir, 'notes-v2.md'), text);
  const doc = json(await f.command(['notes', '--file', file, '--json']));
  assert.equal(doc.notes.text, text); assert.equal(doc.notes.chars, 16000); assert.equal(doc.notes.tokens, 16000);
});

// Revert contextModel's isWellFormed check to bypass the usage error on a model pick.
test('context model picks reject lone surrogates before configuring or resolving', async (t) => {
  const f = fixture(t), pipe = f.registry.createChat(f.project.id, { engine: 'pipeline' });
  for (const model of ['p/bad\ud800', 'bad\udc00/m']) for (const args of [['budget', '--default'], ['show', '--chat', pipe.id]]) {
    const result = await f.command([...args, '--model', model]);
    assert.equal(result.code, 2); assert.match(result.errors, /--model requires PROVIDER\/MODEL/);
  }
});
