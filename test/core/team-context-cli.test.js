import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../../src/core/cli.js';
import { Orchestrator } from '../../src/core/orchestrator.js';

function fixture(t) {
  const root = path.resolve('.scratch/context-system/lane-b'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  t.mock.method(Orchestrator.prototype, 'run', async function (request) {
    calls.push({ request, threadContext: this.threadContext, developerContext: this.developerContext, noPlan: this.noPlan });
    return { status: 'success' };
  });
  const file = path.join(dir, 'context.json');
  async function invoke(raw, args = [], fileArg = file) {
    if (raw !== undefined) fs.writeFileSync(file, raw);
    let output = ''; const stream = { isTTY: false, write(s) { output += s; } };
    const code = await runCli(['run', 'New goal', '--thread-context', fileArg, ...args], { cwd: dir, env: {}, stdout: stream, stderr: stream });
    return { code, output };
  }
  return { file, calls, invoke };
}

// Revert cmdRun's version-dependent text bound / v2 developer extraction or constructor forwarding.
for (const [name, value, developer = ''] of [
  ['v1 empty', { v: 1, text: '' }],
  ['v1 maximum', { v: 1, text: 'x'.repeat(8000) }],
  ['v1 ignores developer as before', { v: 1, text: 'Legacy', developer: 42 }],
  ['v1 ignores long unknown fields as before', { v: 1, text: 'Legacy', developer: 'x'.repeat(4001), extra: true }],
  ['v2 empty', { v: 2, text: '', developer: '' }],
  ['v2 optional developer', { v: 2, text: 'Planner only' }],
  ['v2 maximum text and developer', { v: 2, text: 'x'.repeat(24000), developer: 'd'.repeat(4000) }, 'd'.repeat(4000)],
  ['v2 UTF-8 larger than old file cap', { v: 2, text: '界'.repeat(24000), developer: 'Brief' }, 'Brief'],
  ['v3 maximum', { v: 3, text: 'x'.repeat(800000), developer: 'd'.repeat(8000) }, 'd'.repeat(8000)],
  ['v3 optional developer', { v: 3, text: 'Planner only' }],
  ['v3 escaped controls', { v: 3, text: '\u0001'.repeat(800000), developer: '\u0002'.repeat(8000) }, '\u0002'.repeat(8000)]
]) test(`CLI accepts ${name} and forwards both strings`, async (t) => {
  const f = fixture(t), result = await f.invoke(JSON.stringify(value));
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(f.calls, [{ request: 'New goal', threadContext: value.text, developerContext: developer, noPlan: false }]);
});

// Revert cmdRun's v2 developer validation to fail the wrong-type/oversized developer cases.
for (const [name, value] of [
  ['v1 text over 8000', { v: 1, text: 'x'.repeat(8001) }],
  ['v2 text over 24000', { v: 2, text: 'x'.repeat(24001) }],
  ['v3 text over 800000', { v: 3, text: 'x'.repeat(800001) }],
  ['v3 developer over 8000', { v: 3, text: '', developer: 'x'.repeat(8001) }],
  ['v3 developer null', { v: 3, text: '', developer: null }],
  ['v3 non-string text', { v: 3, text: 1 }],
  ['v2 developer over 4000', { v: 2, text: '', developer: 'd'.repeat(4001) }],
  ['v2 developer null', { v: 2, text: '', developer: null }],
  ['v2 developer number', { v: 2, text: '', developer: 1 }],
  ['v2 developer object', { v: 2, text: '', developer: {} }],
  ['v2 developer array', { v: 2, text: '', developer: [] }],
  ['v2 developer boolean', { v: 2, text: '', developer: false }],
  ['missing text', { v: 2 }],
  ['v1 non-string text', { v: 1, text: 42 }],
  ['v2 non-string text', { v: 2, text: [] }],
  ['v2 null text', { v: 2, text: null }],
  ['missing version', { text: '' }],
  ['future version', { v: 4, text: '' }],
  ['string version', { v: '2', text: '' }],
  ['null', null],
  ['array', []]
]) test(`CLI rejects ${name} before starting the orchestrator`, async (t) => {
  const f = fixture(t), result = await f.invoke(JSON.stringify(value));
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /Invalid thread context file/);
  assert.deepEqual(f.calls, []);
});

test('CLI rejects corrupt and missing thread-context files', async (t) => {
  const f = fixture(t);
  for (const raw of [undefined, '{broken']) {
    const result = await f.invoke(raw);
    assert.equal(result.code, 2); assert.match(result.output, /Invalid thread context file/);
  }
  assert.deepEqual(f.calls, []);
});

// Revert the legacy byte cap to fail boundary acceptance or rejection.
test('CLI accepts exactly 262144 UTF-8 bytes and rejects 262145 bytes', async (t) => {
  const f = fixture(t), json = JSON.stringify({ v: 2, text: '界'.repeat(24000), developer: 'Brief' });
  const raw = json + ' '.repeat(262144 - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(raw), 262144);
  assert.equal((await f.invoke(raw)).code, 0);
  assert.equal(fs.statSync(f.file).size, 262144);
  const result = await f.invoke(raw + ' ');
  assert.equal(result.code, 2); assert.match(result.output, /Invalid thread context file/);
  assert.equal(f.calls.length, 1);
});

test('CLI passes v2 developer context even with --no-plan', async (t) => {
  const f = fixture(t), result = await f.invoke(JSON.stringify({ v: 2, text: 'Planning', developer: 'Developer brief' }), ['--no-plan']);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(f.calls, [{ request: 'New goal', threadContext: 'Planning', developerContext: 'Developer brief', noPlan: true }]);
});

// Regression anchor: cmdRun's v3 byte cap (legacy versions retain 262144).
test('CLI v3 accepts exactly 8388608 bytes and rejects the next byte', async (t) => {
  const f = fixture(t), json = JSON.stringify({ v: 3, text: 'Pack', developer: 'Brief' });
  const raw = json + ' '.repeat(8388608 - Buffer.byteLength(json));
  assert.equal((await f.invoke(raw)).code, 0);
  const result = await f.invoke(raw + ' ');
  assert.equal(result.code, 2); assert.match(result.output, /Invalid thread context file/);
  assert.equal(f.calls.length, 1);
});

// Revert cmdRun's boundedRead to readFileSync to admit a linked artifact or a mid-read replacement.
test('CLI refuses hardlinked thread-context files before orchestration', async (t) => {
  const f = fixture(t), link = f.file + '.link';
  fs.writeFileSync(f.file, JSON.stringify({ v: 3, text: 'Context' })); fs.linkSync(f.file, link);
  const result = await f.invoke(undefined, [], link);
  assert.equal(result.code, 2); assert.match(result.output, /Invalid thread context file/); assert.deepEqual(f.calls, []);
});
for (const phase of ['open', 'read']) test(`CLI refuses a thread-context replacement at ${phase}`, async (t) => {
  const { replaceDuringRead } = await import('./fixtures/replace-during-read.js');
  const f = fixture(t); fs.writeFileSync(f.file, JSON.stringify({ v: 3, text: 'Context' }));
  const replaced = replaceDuringRead(t, fs.realpathSync.native(f.file), phase, false);
  const result = await f.invoke(undefined);
  assert.equal(result.code, 2); assert.match(result.output, /Invalid thread context file/); assert.equal(replaced(), true); assert.deepEqual(f.calls, []);
});
test('CLI accepts thread-context through a directory junction while retaining legacy shapes', async (t) => {
  const f = fixture(t), link = path.join(path.dirname(f.file), 'junction');
  fs.symlinkSync(path.dirname(f.file), link, process.platform === 'win32' ? 'junction' : 'dir');
  const input = { v: 1, text: 'Legacy', developer: 42, extra: true };
  const result = await f.invoke(JSON.stringify(input), [], path.join(link, path.basename(f.file)));
  assert.equal(result.code, 0, result.output); assert.equal(f.calls[0].threadContext, input.text);
});
