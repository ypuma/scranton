import './runtime-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createControl } from '../../src/server/control.js';
import { readRunLease } from '../../src/core/run-lease.js';

async function post(control, route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'x-scranton-client': '1', 'content-type': 'application/json' };
  req.socket = { localPort: 1234, remoteAddress: '127.0.0.1' };
  req.method = 'POST';
  let status;
  await control.handle(req, { writeHead(code) { status = code; }, end() {} }, route);
  assert.equal(status, 202);
}

for (const shutdown of ['exit', 'stop', 'close']) test(`controller settles exited child with inherited output pipes (${shutdown})`, { timeout: 10000 }, async t => {
  const base = path.resolve('.scratch/suite-hang3/fixtures');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'pipes-'));
  const pidFile = path.join(dir, 'pid');
  const shell = path.join(dir, 'shell.cjs');
  await fs.writeFile(shell, `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`)}],{detached:true,stdio:['ignore','inherit','inherit']});
    child.unref();process.exit(0);`);
  let child, control;
  t.after(async () => {
    const pid = await fs.readFile(pidFile, 'utf8').then(Number, () => null);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
    if (child && child.exitCode === null) child.kill();
    await control?.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const hive = path.join(dir, 'hive');
  control = createControl({ hive, workspace: dir, auth: { close() {} }, runner(_exe, _args, options) {
    child = spawn(process.execPath, [shell], options);
    return child;
  } });
  await post(control, '/api/runs', { request: 'inherited pipe' });
  await once(child, 'exit');
  const deadline = Date.now() + 2000;
  while (!await fs.access(pidFile).then(() => true, () => false)) {
    assert.ok(Date.now() < deadline, 'descendant started');
    await sleep(10);
  }
  assert.equal(child.stdout.destroyed, false);
  if (shutdown === 'stop') await post(control, '/api/runs/stop', {});
  const closing = shutdown === 'close' ? control.close() : null;
  const end = Date.now() + 3000;
  while (control.snapshot().run && Date.now() < end) await sleep(10);
  assert.equal(control.snapshot().run, null, 'exit must not wait forever for inherited pipes');
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.ok(readRunLease(hive), 'pipe cleanup is not proof that descendants stopped');
  assert.equal(control.snapshot().recoveryRequired, true);
  assert.equal(control.snapshot().lastExit.exitCode, 0);
  assert.match(control.snapshot().lastExit.outputTail, /descendant cleanup is unverified/);
  await closing;
  await control.close();
});
