import './isolation-test-root.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { parseMessage } from '../../src/core/hive.js';

function fixture(t, mock = true) {
  const root = path.resolve('.scratch/context-budget/a2'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'request-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], file = path.join(dir, 'request.json');
  if (mock) t.mock.method(Orchestrator.prototype, 'run', async function (request) { calls.push(request); return { status: 'success' }; });
  async function invoke(raw, args = ['run'], fileArg = file) {
    if (raw !== undefined) fs.writeFileSync(file, raw);
    let output = ''; const stream = { isTTY: false, write(s) { output += s; } };
    const code = await runCli([...args, '--request-file', fileArg], { cwd: dir, env: {}, stdout: stream, stderr: stream });
    return { code, output };
  }
  return { dir, file, calls, invoke };
}

// Regression anchors: cmdRun's hardened reader, closed shape and request length validation.
for (const [name, value] of [
  ['short', { v: 1, request: 'Short request' }],
  ['maximum escaped Unicode', { v: 1, request: ('\u754c"\\').repeat(10922) + 'xx' }],
  ['surrounding spaces preserved to orchestrator', { v: 1, request: '  Goal  ' }]
]) test(`request-file accepts ${name}`, async (t) => {
  const f = fixture(t), result = await f.invoke(JSON.stringify(value));
  assert.equal(result.code, 0, result.output); assert.deepEqual(f.calls, [value.request]);
});

for (const [name, value] of [
  ['missing request', { v: 1 }], ['missing version', { request: 'x' }],
  ['wrong version', { v: 2, request: 'x' }], ['boolean version', { v: true, request: 'x' }], ['string version', { v: '1', request: 'x' }],
  ['extra key', { v: 1, request: 'x', extra: true }], ['non-string request', { v: 1, request: 1 }],
  ['blank', { v: 1, request: ' \n\t' }], ['empty', { v: 1, request: '' }], ['over chars', { v: 1, request: 'x'.repeat(32769) }]
]) test(`request-file rejects ${name} before orchestration`, async (t) => {
  const f = fixture(t), result = await f.invoke(JSON.stringify(value));
  assert.equal(result.code, 2); assert.match(result.output, /Invalid request file/); assert.deepEqual(f.calls, []);
});

// Reverting literal-text selection to JSON-only parsing rejects these exact scalar/array strings.
for (const [name, value] of [['null', null], ['array', []], ['string', 'request']]) test(`request-file accepts ${name} as text`, async (t) => {
  const f = fixture(t), raw = JSON.stringify(value), result = await f.invoke(raw);
  assert.equal(result.code, 0, result.output); assert.deepEqual(f.calls, [raw]);
  assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
});

// Regression anchors: BOM encoding detection, fatal decoding and removal of only one final line break.
for (const [name, raw, request] of [
  ['UTF-8 BOM', '\ufeffBuild a CLI\n', 'Build a CLI'],
  ['UTF-8 BOM envelope', '\ufeff{"v":1,"request":"Goal"}', 'Goal'],
  ['UTF-16 LE BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Build \u754c\r\n', 'utf16le')]), 'Build \u754c'],
  ['UTF-16 BE BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Build \u754c\n', 'utf16le').swap16()]), 'Build \u754c'],
  ['UTF-16 LE envelope', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"v":1,"request":"Goal"}', 'utf16le')]), 'Goal'],
  ['CRLF trailing line break', '  Build a CLI  \r\n', '  Build a CLI  '],
  ['CR trailing line break', 'Build a CLI\r', 'Build a CLI'],
  ['multi-line prompt', 'First line\r\nSecond line\n', 'First line\r\nSecond line'],
  ['braces later in text', 'Build {a CLI}\n', 'Build {a CLI}'],
  ['one of two final line breaks', '  Goal\n\n', '  Goal\n'],
  ['maximum text', 'x'.repeat(32768) + '\n', 'x'.repeat(32768)]
]) test(`request-file accepts text: ${name}`, async (t) => {
  const f = fixture(t), result = await f.invoke(raw);
  assert.equal(result.code, 0, result.output); assert.deepEqual(f.calls, [request]);
  assert.deepEqual(fs.readFileSync(f.file), Buffer.from(raw));
});

// Revert the startsWith('{') branch, fatal decoder or in-file validation to lose these reasons/refusals.
for (const [name, raw, reason] of [
  ['blank file', '', 'empty'], ['whitespace file', ' \r\n\t', 'empty'],
  ['overlong text', 'x'.repeat(32769), 'longer than 32768 characters'],
  ['malformed UTF-8', Buffer.from([0xc3, 0x28]), 'not valid text'],
  ['odd UTF-16 LE', Buffer.from([0xff, 0xfe, 0x41]), 'not valid text'],
  ['odd UTF-16 BE', Buffer.from([0xfe, 0xff, 0x00]), 'not valid text'],
  ['unpaired UTF-16 surrogate', Buffer.from([0xff, 0xfe, 0x00, 0xd8]), 'not valid text'],
  ['broken leading brace', ' \n{broken', 'starts with { but is not a request envelope'],
  ['missing envelope key', '{"v":1}', 'starts with { but is not a request envelope'],
  ['extra envelope key', '{"v":1,"request":"x","extra":true}', 'starts with { but is not a request envelope'],
  ['wrong envelope version', '{"v":2,"request":"x"}', 'starts with { but is not a request envelope'],
  ['empty envelope request', '{"v":1,"request":""}', 'empty'],
  ['overlong envelope request', JSON.stringify({ v: 1, request: 'x'.repeat(32769) }), 'longer than 32768 characters']
]) test(`request-file explains ${name}`, async (t) => {
  const f = fixture(t), result = await f.invoke(raw);
  assert.equal(result.code, 2); assert.ok(result.output.includes(`Invalid request file: ${reason}`), result.output);
  assert.deepEqual(f.calls, []); assert.deepEqual(fs.readFileSync(f.file), Buffer.from(raw));
});

// Revert the reader's typed refusals or the catch reason mapping to lose these diagnostics.
test('request-file explains missing, nonregular, linked and oversized files', async (t) => {
  const f = fixture(t);
  async function rejected(file, reason) {
    const result = await f.invoke(undefined, ['run'], file);
    assert.equal(result.code, 2); assert.ok(result.output.includes(`Invalid request file: ${reason}`), result.output);
  }
  await rejected(f.file, 'not found'); await rejected(path.join(f.dir, 'missing', 'file'), 'not found');
  await rejected(f.dir, 'not a regular file');
  fs.writeFileSync(f.file, 'x'.repeat(262145)); await rejected(f.file, 'too large');
  fs.writeFileSync(f.file, 'Goal');
  const hard = path.join(f.dir, 'hard'); fs.linkSync(f.file, hard);
  await rejected(hard, 'a link'); fs.unlinkSync(hard);
  const link = path.join(f.dir, 'link');
  try { fs.symlinkSync(f.file, link); }
  catch (error) {
    if (error.code !== 'EPERM') throw error;
    const target = path.join(f.dir, 'linked-directory'); fs.mkdirSync(target);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    t.diagnostic('File symlink creation unavailable; checked junction refusal');
  }
  await rejected(link, 'a link');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Goal'); assert.deepEqual(f.calls, []);
});

test('request-file rejects missing, corrupt, directory, symlink and hardlink input', async (t) => {
  const f = fixture(t);
  for (const raw of [undefined, '{broken']) {
    const result = await f.invoke(raw); assert.equal(result.code, 2); assert.match(result.output, /Invalid request file/);
  }
  assert.equal((await f.invoke(undefined, ['run'], f.dir)).code, 2);
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, request: 'Goal' }));
  const hard = path.join(f.dir, 'hard.json'); fs.linkSync(f.file, hard);
  assert.equal((await f.invoke(undefined, ['run'], hard)).code, 2); fs.unlinkSync(hard);
  const link = path.join(f.dir, 'link.json');
  try { fs.symlinkSync(f.file, link); }
  catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('File symlink creation unavailable; tested linked directory instead'); }
  if (fs.existsSync(link)) assert.equal((await f.invoke(undefined, ['run'], link)).code, 2);
  assert.deepEqual(f.calls, []);
});

test('request-file byte boundary is 262144, including whitespace outside JSON', async (t) => {
  const f = fixture(t), json = JSON.stringify({ v: 1, request: 'Goal' });
  const raw = json + ' '.repeat(262144 - Buffer.byteLength(json));
  assert.equal((await f.invoke(raw)).code, 0);
  assert.equal((await f.invoke(raw + ' ')).code, 2); assert.equal(f.calls.length, 1);
});

// Regression anchors: runCli positional conflict and non-run refusal.
test('request-file cannot be combined with a positional and cannot be used on other commands', async (t) => {
  const f = fixture(t), raw = JSON.stringify({ v: 1, request: 'Goal' });
  for (const args of [['run', 'Positional'], ['run', ''], ['agent', 'dwight'], ['demo'], ['context', 'show']]) {
    const result = await f.invoke(raw, args); assert.equal(result.code, 2); assert.doesNotMatch(result.output, /Invalid request file/);
  }
  assert.deepEqual(f.calls, []);
});

// Regression anchor: cmdRun assigns value.request, leaving the request out of process argv.
test('32768-character quoted request reaches the real orchestrator and fake pi intact through file transport', (t) => {
  const f = fixture(t, false), request = '"\\'.repeat(16384);
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, request }));
  const config = { workspace: path.join(f.dir, 'workspace'), hiveDir: path.join(f.dir, 'hive'),
    execution: { maxParallel: 1, isolation: 'shared', sandbox: { mode: 'host' } },
    pi: { transport: 'json', command: [process.execPath, path.resolve('tools/fake-pi.js')] } };
  const configFile = path.join(f.dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const result = spawnSync(process.execPath, [path.resolve('bin/scranton.js'), 'run', '--request-file', f.file, '--config', configFile, '--on-breaker', 'abort'], {
    cwd: f.dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, SCRANTON_DATA: '', FAKE_PI_SCENARIO: 'happy', FAKE_PI_DELAY_MS: '0' }, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const events = fs.readFileSync(path.join(config.hiveDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].request, request);
  const inbox = parseMessage(fs.readFileSync(path.join(config.hiveDir, 'michael/inbox.md'), 'utf8')).body;
  assert.ok(inbox.includes(`## Request\n\n${request}`));
  assert.ok(events.some((e) => e.type === 'agent_finished' && e.agent === 'michael' && e.keyword === 'PLAN_READY'));
});

// Regression anchor: request-file resolves from the invocation cwd, not registryRun's PACKAGE_ROOT config cwd.
test('registry request-file accepts a path relative to the invocation directory', async (t) => {
  const { createProjectRegistry } = await import('../../src/core/projects.js');
  const f = fixture(t), dataDir = path.join(f.dir, 'data');
  const registry = createProjectRegistry({ dataDir, projectsRoot: path.join(f.dir, 'workspaces') });
  const project = registry.addProject({ name: 'Project', create: true }), chat = registry.createChat(project.id, { title: 'Chat' });
  const result = await f.invoke(JSON.stringify({ v: 1, request: 'Relative file goal' }), ['run', '--data', dataDir, '--project', project.id, '--chat', chat.id], 'request.json');
  assert.equal(result.code, 0, result.output); assert.deepEqual(f.calls, ['Relative file goal']);
});

// Reverting cmdRun's canonicalDirectory/join read to the original file path rejects this junction.
test('registry request-file accepts a data path through a directory junction', async (t) => {
  const { createProjectRegistry } = await import('../../src/core/projects.js');
  const f = fixture(t), target = path.join(f.dir, 'target'), link = path.join(f.dir, 'junction');
  fs.mkdirSync(target); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const dataDir = path.join(link, 'data'), registry = createProjectRegistry({ dataDir, projectsRoot: path.join(target, 'workspaces') });
  const project = registry.addProject({ name: 'Project', create: true }), chat = registry.createChat(project.id, { title: 'Chat' });
  const file = path.join(chat.hiveDir, 'control', 'request.json'), request = 'Long request '.repeat(500);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ v: 1, request }));
  const result = await f.invoke(undefined, ['run', '--data', dataDir, '--project', project.id, '--chat', chat.id], file);
  assert.equal(result.code, 0, result.output); assert.deepEqual(f.calls, [request]);
});
