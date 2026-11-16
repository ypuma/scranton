// The diff of a team run (the Changes side panel): read from the run's private repository, from the snapshot it
// started from to what it integrated, without touching the worktrees, bounded in size and to the run's own storage.
import './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WorktreeManager, readRunDiff } from '../../src/core/worktree.js';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';

const scratch = path.resolve('.scratch/run-diff');
fs.mkdirSync(scratch, { recursive: true });
const publicDir = fileURLToPath(new URL('../../visualizer/public/', import.meta.url));

async function fixture(t, runId) {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'));
  const workspace = path.join(root, 'workspace');
  const hiveDir = path.join(root, 'hive');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(hiveDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'base.txt'), 'baseline\n');
  fs.writeFileSync(path.join(workspace, 'gone.txt'), 'to be removed\n');
  const manager = new WorktreeManager({ workspace, hiveDir, runId });
  t.after(async () => {
    await manager.close();
    if (manager.storage) fs.rmSync(manager.storage, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await manager.init();
  return { root, workspace, hiveDir, manager };
}

async function integrate(manager, milestoneId, change) {
  const dev = await manager.createWorktree({ agent: 'dwight', milestoneId });
  change(dev.dir);
  await manager.snapshotWorktree({ agent: 'dwight', milestoneId });
  await manager.createQaWorktree({ milestoneId });
  await manager.integrateToTarget({ milestoneId });
}

test('readRunDiff: nothing integrated is an empty diff; each integration adds to it; other runs and hives have none', async (t) => {
  const { hiveDir, manager, root } = await fixture(t, 'run-a');
  assert.deepEqual(await readRunDiff({ hiveDir, runId: 'run-a' }), { content: '', truncated: false }, 'the run has started and integrated nothing');

  await integrate(manager, 'm1', (dir) => {
    fs.writeFileSync(path.join(dir, 'base.txt'), 'reviewed\n');
    fs.writeFileSync(path.join(dir, 'new file.txt'), 'hello\n');
  });
  const first = await readRunDiff({ hiveDir, runId: 'run-a' });
  assert.equal(first.truncated, false);
  assert.match(first.content, /^diff --git a\/base\.txt b\/base\.txt$/m);
  assert.match(first.content, /^-baseline$/m);
  assert.match(first.content, /^\+reviewed$/m);
  assert.match(first.content, /^\+\+\+ b\/new file\.txt\t?$/m, 'a path is not quoted or escaped (git ends one with a space in it with a tab)');
  assert.doesNotMatch(first.content, /\x1b\[/, 'no colour codes');

  await integrate(manager, 'm2', (dir) => fs.rmSync(path.join(dir, 'gone.txt')));
  const second = await readRunDiff({ hiveDir, runId: 'run-a' });
  assert.match(second.content, /^\+reviewed$/m, 'the whole run, not the last milestone alone');
  assert.match(second.content, /^deleted file mode/m);
  assert.match(second.content, /^-to be removed$/m);

  const cut = await readRunDiff({ hiveDir, runId: 'run-a', maxBytes: 64 });
  assert.equal(cut.truncated, true);
  assert.ok(Buffer.byteLength(cut.content) <= 64 + 3, 'cut at the limit');

  assert.equal(await readRunDiff({ hiveDir, runId: 'run-b' }), null, 'another run of the chat kept none');
  const empty = path.join(root, 'other-hive');
  fs.mkdirSync(empty);
  assert.equal(await readRunDiff({ hiveDir: empty, runId: 'run-a' }), null, 'a chat that never ran with worktrees');
  await assert.rejects(readRunDiff({ hiveDir, runId: '../x' }), /Invalid worktree identifier/);

  // still readable once the run is over, and it changed nothing
  const before = fs.readdirSync(manager.storage).sort();
  await manager.close();
  assert.match((await readRunDiff({ hiveDir, runId: 'run-a' })).content, /^\+reviewed$/m);
  assert.deepEqual(fs.readdirSync(manager.storage).sort(), before);
});

test('readRunDiff: a pointer that names storage outside the isolation root is refused, not followed', async (t) => {
  const { hiveDir, manager, root } = await fixture(t, 'run-c');
  const outside = path.join(root, 'elsewhere', path.basename(manager.storage));
  fs.mkdirSync(outside, { recursive: true });
  const pointer = JSON.parse(fs.readFileSync(manager.pointerFile, 'utf8'));
  fs.writeFileSync(manager.pointerFile, JSON.stringify({ ...pointer, storage: outside }));
  await assert.rejects(readRunDiff({ hiveDir, runId: 'run-c' }), /outside the configured root/);
  // a pointer of another name than its storage is no pointer to it either
  fs.writeFileSync(manager.pointerFile, JSON.stringify({ ...pointer, storage: path.join(path.dirname(manager.storage), 'f'.repeat(32)) }));
  await assert.rejects(readRunDiff({ hiveDir, runId: 'run-c' }), /outside the configured root/);
});

test('GET .../runs/:id/diff: the diff for the page, 404 for a run without one, 400 for a bad id, 403 without the client header', async (t) => {
  const { hiveDir, manager } = await fixture(t, 'run-d');
  await integrate(manager, 'm1', (dir) => fs.writeFileSync(path.join(dir, 'base.txt'), 'served\n'));
  const srv = await startVisualizerServer({ hiveDir, publicDir, port: 0 });
  t.after(() => srv.close());
  const get = (id, headers = { 'x-scranton-client': '1' }) => fetch(`${srv.url}/api/projects/default/chats/default/runs/${id}/diff`, { headers });

  const ok = await get('run-d');
  assert.equal(ok.status, 200);
  const doc = await ok.json();
  assert.deepEqual(Object.keys(doc).sort(), ['content', 'runId', 'truncated']);
  assert.equal(doc.runId, 'run-d');
  assert.equal(doc.truncated, false);
  assert.match(doc.content, /^\+served$/m);

  const none = await get('run-zzz');
  assert.equal(none.status, 404);
  await none.arrayBuffer();
  const bad = await get('a.b');
  assert.equal(bad.status, 400);
  await bad.arrayBuffer();
  const foreign = await get('run-d', {});
  assert.equal(foreign.status, 403);
  await foreign.arrayBuffer();
});
