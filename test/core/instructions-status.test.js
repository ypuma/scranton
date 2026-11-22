import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createInstructionCache, discoverInstructions, discoverInstructionsAsync } from '../../src/core/instructions.js';
import { createContext } from '../../src/core/context/index.js';
import { createProjectRegistry } from '../../src/core/projects.js';

function fixture(t) {
  const scratch = path.resolve('.scratch/agents-md-review'); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const put = (root, rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('status discovery matches runtime bytes, cuts, sorted nested files and ignore rules', async t => {
  const root = fixture(t);
  put(root, 'AGENTS.md', '\ufeffFirst line\n' + 'x'.repeat(40000));
  put(root, '.gitignore', 'ignored/\n'); put(root, 'a/.gitignore', 'hidden/\n');
  for (const dir of ['a/public', 'a/hidden', 'ignored', '.scratch', 'node_modules', 'z']) put(root, `${dir}/AGENTS.md`, 'nested');
  const result = await discoverInstructionsAsync(root);
  assert.deepEqual(result, discoverInstructions(root));
  assert.equal(result.summary.bytes, 11);
  assert.deepEqual(result.nested, ['a/public/AGENTS.md', 'z/AGENTS.md']);
});
test('status discovery bounds entry work and reports a partial nested list', async t => {
  const root = fixture(t); for (let i = 0; i < 20; i++) put(root, `d${i}/AGENTS.md`, 'nested');
  const result = await discoverInstructionsAsync(root, { maxEntries: 5 });
  assert.equal(result.status.partial, true);
  assert.ok(result.nestedCount < 20);
});
test('instruction cache shares in-flight discovery, fingerprints root edits and expires nested results', async t => {
  const root = fixture(t); put(root, 'AGENTS.md', 'one'); let at = 0, calls = 0;
  const cache = createInstructionCache({ now: () => at, discover: async (...args) => { calls++; return discoverInstructionsAsync(...args); } });
  const [a, b] = await Promise.all([cache(root), cache(root)]); assert.deepEqual(a, b); assert.equal(calls, 1);
  a.nested.push('poison'); assert.deepEqual((await cache(root)).nested, []);
  put(root, 'AGENTS.md', 'two changed'); assert.equal((await cache(root)).bytes, 11); assert.equal(calls, 2);
  put(root, 'nested/AGENTS.md', 'new'); assert.equal((await cache(root)).nestedCount, 0);
  at = 30001; assert.equal((await cache(root)).nestedCount, 1); assert.equal(calls, 3);
  assert.equal(await cache(root, { enabled: false }), null); assert.equal(calls, 3);
});
test('context status discovery leaves the event loop responsive and inspect reuses the scan', async t => {
  const root = fixture(t), workspace = path.join(root, 'workspace');
  put(workspace, 'AGENTS.md', 'root'); put(workspace, '.gitignore', 'ignored/\n');
  for (let i = 0; i < 40; i++) put(workspace, `d${i}/AGENTS.md`, 'nested');
  const dataDir = path.join(root, 'data'), registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Probe', workspace }), chat = registry.createChat(project.id), context = createContext({ dataDir, registry });
  let previous = performance.now(), maxGap = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++; }, 5);
  let status;
  try { status = await context.status(project.id); await new Promise(resolve => setTimeout(resolve, 10)); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 2); assert.ok(maxGap < 250, `Maximum timer gap ${maxGap.toFixed(1)} ms`);
  assert.deepEqual(status.instructions, discoverInstructions(workspace).status);
  const readdir = t.mock.method(fs.promises, 'opendir', () => { throw Error('cache missed'); });
  assert.deepEqual((await context.inspect(project.id, chat.id)).instructions, status.instructions); readdir.mock.restore();
});

test('async discovery reads only 32 KiB of oversized root instructions', async t => {
  const root = fixture(t); put(root, 'AGENTS.md', 'x'.repeat(1024 * 1024 + 1));
  const open = fs.promises.open; let bytes = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const fd = await open(...args), read = fd.read.bind(fd);
    t.mock.method(fd, 'read', async (...values) => { const result = await read(...values); bytes += result.bytesRead; return result; });
    return fd;
  });
  const result = await discoverInstructionsAsync(root);
  assert.equal(bytes, 32768); assert.equal(result.summary.bytes, 32768); assert.equal(result.summary.truncated, true);
});

for (const kind of ['junction', 'hardlink', 'file symlink', 'escape']) test(`runtime and status discovery classify ${kind} links`, async t => {
  const base = fixture(t), root = path.join(base, 'workspace'); fs.mkdirSync(root);
  put(root, 'source.md', 'internal'); fs.mkdirSync(path.join(root, 'target')); fs.mkdirSync(path.join(base, 'outside'));
  for (const rel of ['AGENTS.md', 'src/AGENTS.md']) {
    const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (kind === 'hardlink') fs.linkSync(path.join(root, 'source.md'), file);
      else if (kind === 'file symlink') fs.symlinkSync(path.join(root, 'source.md'), file, 'file');
      else fs.symlinkSync(kind === 'escape' ? path.join(base, 'outside') : path.join(root, 'target'), file, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) { if (error.code === 'EPERM') return t.skip('File symlinks require Windows privilege'); throw error; }
  }
  for (const result of [discoverInstructions(root), await discoverInstructionsAsync(root)]) {
    assert.equal(result.summary, null);
    assert.deepEqual(result.warnings.map(w => [w.file, w.reason]).sort(), [['AGENTS.md', kind === 'escape' ? 'escape' : 'not_regular'], ['src/AGENTS.md', kind === 'escape' ? 'escape' : 'not_regular']]);
  }
});

test('runtime and status scans walk directories named AGENTS.md', async t => {
  const root = fixture(t); put(root, 'AGENTS.md/sub/AGENTS.md', 'nested'); put(root, 'src/AGENTS.md/sub/AGENTS.md', 'nested');
  for (const result of [discoverInstructions(root), await discoverInstructionsAsync(root)]) {
    assert.equal(result.text, null);
    assert.deepEqual(result.nested, ['AGENTS.md/sub/AGENTS.md', 'src/AGENTS.md/sub/AGENTS.md']);
  }
});

test('CLI context show marks partial scans without claiming no AGENTS.md', async t => {
  const { runCli } = await import('../../src/core/cli.js');
  const root = fixture(t), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const dataDir = path.join(root, 'data'), registry = createProjectRegistry({ dataDir });
  const project = registry.addProject({ name: 'Partial', workspace });
  t.mock.method(fs.promises, 'opendir', async () => { throw Error('scan unavailable'); });
  let output = '', errors = '';
  const code = await runCli(['context', 'show', '--data', dataDir, '--project', project.id], { cwd: root, env: {}, stdout: { write: s => output += s }, stderr: { write: s => errors += s } });
  assert.equal(code, 0, errors);
  assert.match(output, /nested scan partial/);
  assert.doesNotMatch(output, /no AGENTS\.md/i);
});

test('internal file symlinks report not_regular in both discovery paths without platform privileges', async t => {
  const root = fixture(t); put(root, 'AGENTS.md', 'internal'); put(root, 'src/AGENTS.md', 'nested');
  const lstat = fs.lstatSync, asyncLstat = fs.promises.lstat;
  const linked = stat => Object.assign(Object.create(stat), { isSymbolicLink: () => true });
  t.mock.method(fs, 'lstatSync', (file, ...args) => path.basename(file) === 'AGENTS.md' ? linked(lstat(file, ...args)) : lstat(file, ...args));
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => path.basename(file) === 'AGENTS.md' ? linked(await asyncLstat(file, ...args)) : asyncLstat(file, ...args));
  for (const result of [discoverInstructions(root), await discoverInstructionsAsync(root)]) {
    assert.equal(result.summary, null);
    assert.deepEqual(result.warnings.map(w => [w.file, w.reason]).sort(), [['AGENTS.md', 'not_regular'], ['src/AGENTS.md', 'not_regular']]);
  }
});
