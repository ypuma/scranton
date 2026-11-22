import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { launch } from '../../../src/core/tools/process.js';

for (const mode of ['timeout', 'abort']) test(`${mode} settles after the shell exits with inherited pipes still open`, { timeout: 12000 }, async t => {
  const base = path.resolve('.scratch/suite-hang/fixtures');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'orphan-'));
  const pidFile = path.join(dir, 'pid');
  const file = path.join(dir, 'shell.cjs');
  await fs.writeFile(file, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
child.unref();
process.exit(0);
`);
  let child, watchdog;
  t.after(async () => {
    clearTimeout(watchdog);
    const pid = await fs.readFile(pidFile, 'utf8').then(Number, () => null);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    child?.stdout?.destroy(); child?.stderr?.destroy();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const controller = new AbortController();
  const result = launch(process.execPath, [file], { signal: controller.signal, spawn: (...args) => (child = spawn(...args)) }, { cwd: dir, timeout: mode === 'timeout' ? 2 : 60 });
  await once(child, 'exit');
  assert.equal(child.exitCode, 0, 'the shell is gone before termination');
  const deadline = Date.now() + 2000;
  while (!await fs.access(pidFile).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'grandchild started');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(child.stdout.destroyed, false, 'grandchild still holds the output pipe');
  if (mode === 'abort') controller.abort();
  const bounded = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('launch did not settle after termination')), 5000); });
  const value = await Promise.race([result, bounded]);
  assert.match(value.reason, mode === 'timeout' ? /timed out after 2 seconds/ : /Command aborted/);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

for (const mode of ['throws', 'never resolves']) test(`termination is bounded when adapter kill ${mode} and never emits close`, { timeout: 8000 }, async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killOwnsTree: true,
    kill() { if (mode === 'throws') throw new Error('cannot kill'); return new Promise(() => {}); } });
  const result = await launch('fixture', [], { spawn: () => child }, { timeout: 0.01 });
  assert.match(result.reason, /timed out/);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
});
