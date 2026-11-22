import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { killTree, helperEnv } from '../../src/core/process-tree.js';

test('helper environment drops inherited run ownership without mutating its source', () => {
  const env = { SCRANTON_RUN_LEASE: 'lease', scranton_parent_guard: 'guard', PATH: 'path', API_KEY: 'credential' };
  assert.deepEqual(helperEnv(env), { PATH: 'path', API_KEY: 'credential' });
  assert.equal(env.SCRANTON_RUN_LEASE, 'lease');
});

test('tree kill is harmless without a running child', async () => {
  await killTree(); await killTree({ exitCode: null });
  await killTree({ pid: 1, exitCode: 0, kill() { assert.fail('already exited'); } });
});

test('tree kill terminates the child and its pipe-holding grandchild', { timeout: 15000 }, async t => {
  const base = path.resolve('.scratch/pi-cleanup/process-tree');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const file = path.join(dir, 'tree.mjs');
  await fs.writeFile(file, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.on('data', chunk => process.stdout.write(chunk));
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [file], { cwd: dir, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => { await killTree(child); await closed; await fs.rm(dir, { recursive: true, force: true }); });
  const [chunk] = await once(child.stdout, 'data');
  const pid = Number(String(chunk)); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await killTree(child); await closed;
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
  const deadline = Date.now() + 5000;
  while (alive() && Date.now() < deadline) await sleep(25);
  assert.equal(alive(), false, 'grandchild must not survive tree cleanup');
});

test('tree kill falls back to adapter kill without a PID', async () => {
  let kills = 0;
  await killTree({ kill(signal) { assert.equal(signal, 'SIGKILL'); kills++; } });
  assert.equal(kills, 1);
});

for (const mode of ['error', 'nonzero', 'stalled']) test(`taskkill ${mode} safely falls back to the child`, { skip: process.platform !== 'win32', timeout: 5000 }, async t => {
  let kills = 0, killerKills = 0;
  t.mock.method(childProcess, 'spawn', () => {
    const killer = Object.assign(new EventEmitter(), { kill() { killerKills++; } });
    queueMicrotask(() => {
      if (mode === 'error') killer.emit('error', new Error('taskkill unavailable'));
      else if (mode === 'nonzero') killer.emit('close', 1);
    });
    return killer;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await killTree({ pid: 12345, exitCode: null, kill(signal) { assert.equal(signal, 'SIGKILL'); kills++; } });
  assert.equal(kills, 1);
  assert.equal(killerKills, mode === 'stalled' ? 1 : 0);
});
