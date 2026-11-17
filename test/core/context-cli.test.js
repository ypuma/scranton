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
  const command = (args, extra = []) => invoke(['context', ...args, ...flags, ...extra]);
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
  f.turn(f.chat, 'four', 'Fourth'); f.turn(f.chat, 'five', 'Fifth');
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
  assert.match(output, /Sharing: on; notes: 0\/4000 chars/); assert.match(output, new RegExp(`${f.chat.id} \\| First chat \\| team \\| 1 turns`));
  const doc = json(await f.command(['show', '--chat', f.chat.id, '--json'])); assert.deepEqual(doc, f.context.inspect(f.project.id, f.chat.id));
  const text = ok(await f.command(['show', '--chat', f.chat.id])).output;
  assert.match(text, /Turns: 1 total; 1 visible; 1 detailed; 0 condensed; 0 omitted/); assert.match(text, /Budget: \d+\/24000 chars/);
  for (const section of doc.sections) { assert.ok(text.includes(`${section.title} (${section.chars} chars)`)); assert.ok(text.includes(section.text)); }
  assert.ok(text.includes(`Developer brief (${doc.developer.chars} chars)\n${doc.developer.text}`));
});

test('context show includes existing advisory memory and supports Pipeline documents', async (t) => {
  const f = fixture(t); const memory = await f.memory();
  const doc = json(await f.command(['show', '--chat', f.chat.id, '--json']));
  assert.deepEqual(doc, f.context.inspect(f.project.id, f.chat.id, { memory })); assert.ok(doc.memory.chars > 0);
  const pipe = f.registry.createChat(f.project.id, { engine: 'pipeline' });
  const pipeline = json(await f.command(['show', '--chat', pipe.id, '--json']));
  assert.equal(pipeline.engine, 'pipeline'); assert.equal(pipeline.developer, null); assert.equal(pipeline.budget.limit, 32768);
  const output = ok(await f.command(['show', '--chat', pipe.id])).output;
  assert.match(output, /\/32768 bytes/); assert.doesNotMatch(output, /Developer brief/);
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

// Regression anchor: statSync(...).size > 16384 rejects before readFileSync; module validation errors become UsageError unchanged.
test('notes rejects oversized files before reading, character overflow, missing files and directories with code 2', async (t) => {
  const f = fixture(t), file = f.write(path.join(f.dir, 'large.md'), 'x'.repeat(16385));
  const read = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', function (target, ...args) { if (target === file) reads++; return read.call(this, target, ...args); });
  let result = await f.command(['notes', '--file', file]); assert.equal(result.code, 2); assert.match(result.errors, /exceeds 16384 bytes/); assert.equal(reads, 0);
  f.write(file, 'x'.repeat(4001)); result = await f.command(['notes', '--file', file]);
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
  for (const syntax of ['context show', 'context notes', 'context share', 'context reset|restore']) assert.ok(HELP.includes(syntax));
});

for (const action of ['show', 'notes', 'share', 'reset', 'restore']) test(`context ${action} reports unknown projects/chats with code 2`, async (t) => {
  const f = fixture(t), args = [action, ...(action === 'notes' ? ['--clear'] : action === 'share' ? ['on'] : []), ...(['reset', 'restore'].includes(action) ? ['--chat', f.chat.id] : [])];
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
