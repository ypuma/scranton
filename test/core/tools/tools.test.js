import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runTool, toolDefinitions } from '../../../src/core/tools/index.js';
import { truncate } from '../../../src/core/tools/truncate.js';
import { globMatcher } from '../../../src/core/tools/glob.js';
import { childEnv, resolveShell } from '../../../src/core/tools/process.js';
import { resolveBinaries } from '../../../src/core/tools/binaries.js';
import { validate } from '../../../src/core/tools/schema.js';

const scratch = path.resolve('.scratch/tools-tests');
fs.mkdirSync(scratch, { recursive: true });
const allow = ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'powershell', 'agent_chat'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const put = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const call = (name, args, extra = {}) => runTool(name, args, { root, allow, binaries: {}, ...extra });
  return { root, put, call, get: (name) => fs.readFileSync(path.join(root, name), 'utf8') };
}
const ok = (result) => { assert.equal(result.isError, false, result.content); return result; };
const bad = (result, regex) => { assert.equal(result.isError, true, result.content); if (regex) assert.match(result.content, regex); return result; };

for (const [label, edits, expected] of [
  ['unique', [{ oldText: 'alpha', newText: 'A' }], 'A beta gamma'],
  ['multiple', [{ oldText: 'alpha', newText: 'A' }, { oldText: 'gamma', newText: 'G' }], 'A beta G'],
  ['original not incremental', [{ oldText: 'alpha', newText: 'beta' }, { oldText: 'beta', newText: 'B' }], 'beta B gamma'],
]) test(`edit ${label}`, async (t) => {
  const f = fixture(t); f.put('a', 'alpha beta gamma');
  const result = ok(await f.call('edit', { path: 'a', edits }));
  assert.equal(f.get('a'), expected);
  assert.equal(result.details.idempotency, 'guarded');
  assert.equal(result.details.files[0].after, createHash('sha256').update(expected).digest('hex'));
});

for (const [label, text, edits, error] of [
  ['zero matches', 'alpha beta', [{ oldText: 'absent', newText: 'x' }], /Could not find the exact text/],
  ['two matches', 'alpha alpha', [{ oldText: 'alpha', newText: 'x' }], /Found 2 occurrences/],
  ['overlapping occurrences', 'aaa', [{ oldText: 'aa', newText: 'x' }], /Found 2 occurrences/],
  ['overlap', 'alpha beta', [{ oldText: 'alpha', newText: 'x' }, { oldText: 'alpha beta', newText: 'y' }], /edits\[0\] and edits\[1\] overlap/],
  ['rollback', 'alpha beta', [{ oldText: 'alpha', newText: 'x' }, { oldText: 'absent', newText: 'y' }], /Could not find edits\[1\]/],
  ['empty array', 'alpha', [], /edits must contain at least one/],
  ['empty text', 'alpha', [{ oldText: '', newText: 'x' }], /oldText must not be empty/],
  ['identical', 'alpha', [{ oldText: 'alpha', newText: 'alpha' }], /No changes made/],
  ['no fuzzy', 'smart \u201cquotes\u201d', [{ oldText: 'smart "quotes"', newText: 'x' }], /Could not find the exact text/],
]) test(`edit refuses ${label} without mutation`, async (t) => {
  const f = fixture(t); f.put('a', text);
  bad(await f.call('edit', { path: 'a', edits }), error);
  assert.equal(f.get('a'), text);
  assert.deepEqual(fs.readdirSync(f.root), ['a']);
});

test('legacy edit, CRLF and BOM preservation, mixed endings', async (t) => {
  const f = fixture(t); f.put('a', '\ufeffone\r\ntwo\r\nthree\nlast');
  ok(await f.call('edit', { path: 'a', oldText: 'one\ntwo', newText: 'first\nsecond' }));
  assert.equal(f.get('a'), '\ufefffirst\r\nsecond\r\nthree\nlast');
});

test('write creates parents, is atomic, hashes and serializes with edit', async (t) => {
  const f = fixture(t);
  const [first, second] = await Promise.all([
    f.call('write', { path: 'sub/a', content: 'first' }),
    f.call('edit', { path: 'sub/a', oldText: 'first', newText: 'second' }),
  ]);
  ok(first); ok(second);
  assert.equal(first.details.files[0].before, null);
  assert.equal(second.details.files[0].before, first.details.files[0].after);
  assert.equal(f.get('sub/a'), 'second');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'sub')), ['a']);
});

for (const value of ['../escape', '..\\escape', '/outside', '\\\\server\\share', '\\\\?\\C:\\a', '\\\\.\\C:\\a', 'C:foo', '~', '~/a', 'nul', 'CON.txt', 'aux', 'COM1', 'lpt9.txt', 'a:stream', 'a\0b', 'a\nb', 'trail.', 'trail ', 'a/../../escape']) {
  test(`path rejects ${JSON.stringify(value)}`, async (t) => {
    if (process.platform !== 'win32' && ['C:foo', 'nul', 'CON.txt', 'aux', 'COM1', 'lpt9.txt', 'a:stream', 'trail.', 'trail '].includes(value)) return t.skip('Windows-only path restriction');
    const f = fixture(t);
    bad(await f.call('write', { path: value, content: 'x' }), /path|root/i);
  });
}
for (const value of ['.git/hooks/pre-commit', '.GIT/config', 'sub/.GiT/a']) test(`mutation rejects ${value}`, async (t) => {
  const f = fixture(t); bad(await f.call('write', { path: value, content: 'x' }), /\.git/);
});

test('absolute inside, slash variants and Windows case variants', async (t) => {
  const f = fixture(t); f.put('sub/a', 'yes');
  assert.equal(ok(await f.call('read', { path: path.join(f.root, 'sub', 'a') })).content, 'yes');
  assert.equal(ok(await f.call('read', { path: 'sub\\a' })).content, 'yes');
  if (['win32', 'darwin'].includes(process.platform)) assert.equal(ok(await f.call('read', { path: path.join(f.root, 'SUB', 'a') })).content, 'yes');
  bad(await f.call('read', { path: path.join(f.root + '-sibling', 'a') }), /escapes/);
});

test('real junction/symlink escape and alias cannot mutate .git', async (t) => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(scratch, 'outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret'), 'outside');
  fs.symlinkSync(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['read', 'write', 'edit']) bad(await f.call(name, name === 'read' ? { path: 'link/secret' } : name === 'write' ? { path: 'link/secret', content: 'bad' } : { path: 'link/secret', oldText: 'outside', newText: 'bad' }), /Link\/reparse/);
  fs.mkdirSync(path.join(f.root, '.git'));
  fs.symlinkSync(path.join(f.root, '.git'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  bad(await f.call('write', { path: 'alias/config', content: 'x' }), /Link\/reparse/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'outside');
});

test('read ranges, BOM, EOF, binary and images', async (t) => {
  const f = fixture(t); f.put('a', '\ufeffone\ntwo\nthree');
  assert.equal(ok(await f.call('read', { path: 'a', offset: 2, limit: 1 })).content, 'two\n\n[1 more lines in file. Use offset=3 to continue.]');
  assert.equal(ok(await f.call('read', { path: 'a' })).content, 'one\ntwo\nthree');
  bad(await f.call('read', { path: 'a', offset: 4 }), /Offset 4 is beyond end of file \(3 lines total\)/);
  f.put('binary', Buffer.from([1, 0, 2])); bad(await f.call('read', { path: 'binary' }), /Binary/);
  f.put('image.png', Buffer.from([137, 80, 78, 71])); bad(await f.call('read', { path: 'image.png' }), /Images/);
  f.put('empty', ''); assert.equal(ok(await f.call('read', { path: 'empty' })).content, '');
  assert.match(ok(await f.call('read', { path: 'a' }, { limits: { readMaxLines: 1 } })).content, /Use offset=2 to continue/);
});

test('central truncation head, tail, UTF-8 boundaries and no partial head lines', () => {
  assert.equal(truncate('a\nb\nc', { maxLines: 2, maxBytes: 100 }).content, 'a\nb');
  assert.equal(truncate('a\nb\nc', { maxLines: 2, maxBytes: 100 }, true).content, 'b\nc');
  assert.equal(truncate('long line', { maxLines: 2, maxBytes: 3 }).content, '');
  const text = '\u{1f600}'.repeat(10);
  const tail = truncate(text, { maxLines: 2, maxBytes: 7 }, true);
  assert.equal(tail.content, '\u{1f600}'); assert.equal(tail.lastLinePartial, true);
  assert.equal(truncate('a\n', { maxLines: 2, maxBytes: 10 }).content, 'a\n');
});

test('schema validation, allowlist, no throw, enums and bounds', async (t) => {
  const f = fixture(t);
  assert.equal(toolDefinitions(allow).length, 9);
  for (const definition of toolDefinitions(allow)) { assert.equal(definition.parameters.additionalProperties, false); assert.equal(definition.parameters.type, 'object'); }
  bad(await f.call('read', { path: 'a' }, { allow: [] }), /not allowed/);
  bad(await f.call('other', {}), /not allowed/);
  for (const args of [null, {}, { path: 1 }, { path: 'a', unknown: true }, { path: 'a', offset: 0 }, { path: 'a', limit: 1.5 }]) bad(await f.call('read', args));
  bad(await f.call('bash', { command: 'x', timeout: 1801 }), /at most 1800/);
  bad(await f.call('agent_chat', { to: 'x', text: 'a'.repeat(16001) }), /length/);
  bad(await f.call('agent_chat', { to: 'x', text: ' ' }), /non-whitespace/);
  assert.throws(() => validate({ type: 'string', enum: ['a'] }, 'b'), /one of/);
});

test('agent chat delegates exactly once and returns JSON ack', async (t) => {
  const f = fixture(t); let count = 0;
  const result = ok(await f.call('agent_chat', { to: 'dwight-1', text: 'hello' }, { chat: async (args) => { count++; assert.deepEqual(args, { to: 'dwight-1', text: 'hello' }); return { ok: true }; } }));
  assert.equal(result.content, '{"ok":true}'); assert.equal(count, 1); assert.equal(result.details.idempotency, 'at-most-once');
});

for (const [pattern, good, not] of [
  ['*.js', ['a.js', 'sub/a.js'], ['a.ts']], ['src/**/*.js', ['src/a.js', 'src/sub/a.js'], ['a.js']],
  ['**/{a,b}.[jt]s', ['a.js', 'sub/b.ts'], ['c.js']], ['file?.[!x]', ['file1.a'], ['file12.a', 'file1.x']],
]) test(`glob ${pattern}`, () => { const matches = globMatcher(pattern); for (const name of good) assert.equal(matches(name), true, name); for (const name of not) assert.equal(matches(name), false, name); });

test('find fallback ignores files, sorts, glob paths and limit; ls sorted and empty', async (t) => {
  const f = fixture(t);
  for (const name of ['z.js', 'A.js', 'src/a.ts', 'src/b.js', 'node_modules/no.js', '.git/no.js', 'ignored.js']) f.put(name, 'x');
  f.put('.gitignore', 'ignored.js\n');
  const result = ok(await f.call('find', { pattern: '*.js' }));
  assert.equal(result.content, 'A.js\nsrc/b.js\nz.js');
  assert.equal(ok(await f.call('find', { pattern: 'src/*.{js,ts}' })).content, 'src/a.ts\nsrc/b.js');
  assert.match(ok(await f.call('find', { pattern: '*.js', limit: 1 })).content, /^A.js\n\n\[1 results limit reached/);
  fs.mkdirSync(path.join(f.root, 'empty'));
  assert.equal(ok(await f.call('ls', { path: 'empty' })).content, '(empty directory)');
  assert.match(ok(await f.call('ls', {})).content, /empty\//);
});

test('grep fallback context, sorting, limit and line cutting', async (t) => {
  const f = fixture(t); f.put('z.txt', 'hit\n'); f.put('a.txt', 'before\nhit\nafter\nhit\n');
  assert.equal(ok(await f.call('grep', { pattern: 'hit', context: 1 })).content, 'a.txt-1- before\na.txt:2: hit\na.txt-3- after\na.txt:4: hit\nz.txt:1: hit');
  const limited = ok(await f.call('grep', { pattern: 'hit', context: 1, limit: 1 }));
  assert.match(limited.content, /^a.txt-1- before\na.txt:2: hit\na.txt-3- after\n\n\[1 matches limit reached/);
  f.put('long.txt', 'x'.repeat(600));
  assert.match(ok(await f.call('grep', { pattern: 'x', path: 'long.txt' })).content, new RegExp(`^long.txt:1: ${'x'.repeat(500)}\\.\\.\\. \\[truncated\\]`));
  assert.equal(ok(await f.call('grep', { pattern: 'HIT', ignoreCase: true, path: 'z.txt' })).content, 'z.txt:1: hit');
  assert.equal(ok(await f.call('grep', { pattern: '[', literal: true })).content, 'No matches found');
  bad(await f.call('grep', { pattern: '[' }), /regular expression/i);
});

const rg = resolveBinaries().rg;
test('real rg and native fallback produce identical text including context and limits', { skip: !rg && 'No bundled or PATH rg binary is available' }, async (t) => {
  const f = fixture(t);
  f.put('a.txt', 'before\nhit\nafter\nhit\n'); f.put('sub/z.txt', 'hit\n'); f.put('long.txt', 'hit' + 'x'.repeat(600));
  f.put('.gitignore', 'ignored.txt\n'); f.put('ignored.txt', 'hit'); f.put('node_modules/a', 'hit');
  for (const args of [{ pattern: 'hit' }, { pattern: 'hit', context: 1 }, { pattern: 'hit', context: 2, limit: 1 }, { pattern: 'hit', glob: '*.txt' }, { pattern: 'hit', path: 'a.txt', context: 1 }]) {
    const native = ok(await f.call('grep', args));
    const external = ok(await f.call('grep', args, { binaries: { rg } }));
    assert.equal(external.content, native.content, JSON.stringify(args));
  }
});

test('injected rg argv, deterministic sort and injected fd path workaround', async (t) => {
  const f = fixture(t); f.put('a.txt', 'hit');
  let seen;
  const spawn = (file, args, options) => {
    seen = { file, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(file === 'rg-test' ? JSON.stringify({ type: 'match', data: { path: { text: './a.txt' }, line_number: 1, lines: { text: 'hit\n' } } }) + '\n' : path.join(f.root, 'a.txt') + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  assert.equal(ok(await f.call('grep', { pattern: 'hit' }, { spawn, binaries: { rg: 'rg-test' } })).content, 'a.txt:1: hit');
  assert.ok(seen.args.includes('--sort')); assert.ok(seen.args.includes('path')); assert.ok(seen.args.includes('!**/node_modules/**'));
  assert.equal(ok(await f.call('find', { pattern: '**/*.txt' }, { spawn, binaries: { fd: 'fd-test' } })).content, 'a.txt');
  assert.ok(seen.args.includes('--hidden'));
});

test('child environment strips secrets and preserves unrelated variables', () => {
  assert.deepEqual(childEnv({ PATH: 'path', NORMAL: 'yes', API_KEY: 'x', TOKEN: 'x', FOO_SECRET: 'x', PASSWORD: 'x', PRIVATE_KEY: 'x', DATABASE_URL: 'x', DBOS_SYSTEM_DATABASE_URL: 'x', SCRANTON_RUN_LEASE: 'x', SCRANTON_PARENT_GUARD: 'x' }), { PATH: 'path', NORMAL: 'yes' });
});

for (const name of ['bash', 'powershell']) {
  let available = true;
  try { resolveShell(name); } catch { available = false; }
  test(`${name} real exit code and ordered stdout/stderr`, { skip: !available && `${name} is not available (no shell installed)` }, async (t) => {
    const f = fixture(t);
    const command = name === 'bash' ? 'printf first; sleep 0.1; printf second >&2; sleep 0.1; printf third; exit 7' : '[Console]::Out.Write("first"); Start-Sleep -Milliseconds 100; [Console]::Error.Write("second"); Start-Sleep -Milliseconds 100; [Console]::Out.Write("third"); exit 7';
    const result = bad(await f.call(name, { command }), /Command exited with code 7/);
    assert.equal(result.content, 'firstsecondthird\n\nCommand exited with code 7');
    bad(await f.call(name, { command: 'echo bad', cwd: '../outside' }), /escapes/);
  });
  test(`${name} timeout kills whole process tree`, { skip: !available && `${name} is not available (no shell installed)` }, async (t) => {
    const f = fixture(t);
    const script = path.join(f.root, 'child.cjs');
    f.put('child.cjs', 'setTimeout(() => require("node:fs").writeFileSync("escaped", "bad"), 2200); setInterval(() => {}, 1000);');
    const command = name === 'bash' ? `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}" & wait` : `$p = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${script}"' -WorkingDirectory '${f.root}' -PassThru -NoNewWindow; Wait-Process -Id $p.Id`;
    bad(await f.call(name, { command, timeout: 1 }), /timed out after 1 seconds/);
    await new Promise((resolve) => setTimeout(resolve, 2400));
    assert.equal(fs.existsSync(path.join(f.root, 'escaped')), false);
  });
  test(`${name} abort kills process`, { skip: !available && `${name} is not available (no shell installed)` }, async (t) => {
    const f = fixture(t), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try { bad(await f.call(name, { command: name === 'bash' ? 'sleep 10' : 'Start-Sleep -Seconds 10' }, { signal: controller.signal }), /Command aborted/); }
    finally { clearTimeout(timer); }
  });
}

test('shell tail truncation retains chunk-boundary newlines without spill', async (t) => {
  const f = fixture(t);
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.write('first\nsecond\n');
      child.stdout.write('third\n');
      child.stdout.write('fourth\n');
      child.stdout.end(); child.emit('close', 0);
    });
    return child;
  };
  let name = 'bash';
  try { resolveShell(name); } catch { name = 'powershell'; }
  const result = ok(await f.call(name, { command: 'ignored' }, { spawn, limits: { maxLines: 2 } }));
  assert.match(result.content, /^third\nfourth\n\n\[Showing last/);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('search central caps and nested gitignore inheritance and negation', async (t) => {
  const f = fixture(t);
  f.put('.gitignore', '/sub/ignore.txt\n*.log\n!keep.log\n');
  f.put('sub/ignore.txt', 'hit'); f.put('sub/yes.txt', 'hit');
  f.put('keep.log', 'hit'); f.put('no.log', 'hit'); f.put('sub/second.txt', 'hit');
  assert.equal(ok(await f.call('find', { pattern: '*.txt', path: 'sub' })).content, 'second.txt\nyes.txt');
  assert.equal(ok(await f.call('grep', { pattern: 'hit', path: 'sub' })).content, 'second.txt:1: hit\nyes.txt:1: hit');
  assert.equal(ok(await f.call('find', { pattern: '*.log' })).content, 'keep.log');
  assert.match(ok(await f.call('grep', { pattern: 'hit' }, { limits: { maxLines: 1 } })).content, /1 lines \/ 10.0KB limit reached/);
  assert.match(ok(await f.call('ls', {}, { limits: { maxBytes: 5 } })).content, /5B limit reached/);
});

const fd = resolveBinaries().fd;
test('real fd and native walker glob results agree and are sorted', { skip: !fd && 'No bundled or PATH fd binary is available' }, async (t) => {
  const f = fixture(t);
  for (const name of ['z.js', 'sub/a.js', 'sub/b.ts', 'ignore.js', 'node_modules/a.js']) f.put(name, 'x');
  f.put('.gitignore', 'ignore.js\n');
  for (const pattern of ['*.js', 'sub/**/*.{js,ts}', '**/*.js']) {
    assert.equal(ok(await f.call('find', { pattern }, { binaries: { fd } })).content, ok(await f.call('find', { pattern })).content);
  }
});

test('sandbox shell capabilities bypass host discovery and reject unsupported shells', async t => {
  const f = fixture(t), calls = [];
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => {
    assert.doesNotMatch(String(file), /(?:bash|pwsh|powershell)(?:\.exe)?$/i, 'sandbox shells must not probe host shell files');
    return exists(file);
  });
  const spawn = (file, args) => {
    calls.push({file, args});
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout.end('container'); child.emit('close', 0); });
    return child;
  };
  const ctx = {spawn, shells: {bash: {file: '/bin/bash', args: ['-c']}}, env: {}};
  assert.equal(ok(await f.call('bash', {command: 'echo container'}, ctx)).content, 'container');
  assert.deepEqual(calls, [{file: '/bin/bash', args: ['-c', 'echo container']}]);
  bad(await f.call('powershell', {command: 'ignored'}, ctx), /powershell is not available in this sandbox/);
  assert.equal(calls.length, 1);
});
