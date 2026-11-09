import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDashboard } from '../../src/dashboard/index.js';
import { stripAnsi } from '../../src/dashboard/text.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fakeStdout({ columns = 100, rows = 30, isTTY = false } = {}) {
  const out = new EventEmitter();
  Object.assign(out, { columns, rows, isTTY, chunks: [] });
  out.write = (chunk) => {
    out.chunks.push(String(chunk));
    return true;
  };
  out.text = () => out.chunks.join('');
  return out;
}

function fakeStdin() {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, rawModes: [], paused: false });
  input.setRawMode = (on) => {
    input.rawModes.push(on);
    return input;
  };
  input.resume = () => { input.paused = false; return input; };
  input.pause = () => { input.paused = true; return input; };
  return input;
}

async function hiveFrom(t, name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scranton-dash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(path.join(fixtures, name), dir, { recursive: true });
  return dir;
}

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('once: writes exactly one frame of the hive and resolves', async (t) => {
  withEnv(t, { NO_COLOR: undefined, FORCE_COLOR: undefined });
  const hiveDir = await hiveFrom(t, 'running');
  const stdout = fakeStdout({ columns: 100, rows: 30 });
  await runDashboard({ hiveDir, once: true, stdout });
  assert.equal(stdout.chunks.length, 1);
  const frame = stdout.text();
  assert.ok(!frame.includes('\x1b'), 'a non-TTY frame has no escape sequences');
  assert.equal(frame.split('\n').length, 31);
  assert.match(frame, /Milestone 2\/3: JSON file storage/);
  assert.match(frame, /Writing code\.\.\./);
  assert.ok(frame.includes(hiveDir));
});

test('once against an empty temp hive shows the idle screen', async (t) => {
  const hiveDir = await mkdtemp(path.join(os.tmpdir(), 'scranton-dash-'));
  t.after(() => rm(hiveDir, { recursive: true, force: true }));
  const stdout = fakeStdout({ columns: 80, rows: 24 });
  await runDashboard({ hiveDir, once: true, stdout });
  assert.match(stdout.text(), /No run yet - start one with: scranton run "\.\.\."  or  scranton demo/);
});

test('a non-TTY stdout behaves like once, ascii is honoured', async (t) => {
  const hiveDir = await hiveFrom(t, 'tripped');
  const stdout = fakeStdout({ columns: 80, rows: 24 });
  await runDashboard({ hiveDir, ascii: true, stdout, stdin: fakeStdin() });
  assert.equal(stdout.chunks.length, 1);
  assert.match(stdout.text(), /^[\x00-\x7f]*$/);
  assert.match(stdout.text(), /CIRCUIT BREAKER TRIPPED - answer in the orchestrator terminal/);
});

test('NO_COLOR wins over a TTY, FORCE_COLOR colours a pipe', async (t) => {
  const hiveDir = await hiveFrom(t, 'running');
  withEnv(t, { NO_COLOR: '1', FORCE_COLOR: undefined });
  const tty = fakeStdout({ isTTY: true });
  await runDashboard({ hiveDir, once: true, stdout: tty });
  assert.ok(!tty.text().includes('\x1b'));

  withEnv(t, { NO_COLOR: undefined, FORCE_COLOR: '1' });
  const pipe = fakeStdout();
  await runDashboard({ hiveDir, once: true, stdout: pipe });
  assert.ok(pipe.text().includes('\x1b['));
});

test('live: alternate screen, redraws, and restores the terminal on q', async (t) => {
  withEnv(t, { NO_COLOR: '1' });
  const hiveDir = await hiveFrom(t, 'running');
  const stdout = fakeStdout({ isTTY: true, columns: 100, rows: 30 });
  const stdin = fakeStdin();
  const done = runDashboard({ hiveDir, refreshMs: 30, stdout, stdin });
  await new Promise((r) => setTimeout(r, 300));
  const live = stdout.text();
  assert.ok(live.startsWith('\x1b[?1049h\x1b[?25l'), 'enters the alternate screen with a hidden cursor');
  assert.match(stripAnsi(live), /Writing code\.\.\./);
  assert.deepEqual(stdin.rawModes, [true]);
  assert.ok(stdout.listenerCount('resize') > 0);

  const before = stdout.chunks.length;
  stdout.columns = 70;
  stdout.emit('resize');
  assert.ok(stdout.chunks.length > before, 'resize redraws');

  stdin.emit('data', 'q');
  await done;
  assert.ok(stdout.text().endsWith('\x1b[?25h\x1b[?1049l'), 'cursor shown and main screen restored');
  assert.deepEqual(stdin.rawModes, [true, false]);
  assert.ok(stdin.paused);
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(stdin.listenerCount('data'), 0);
  const written = stdout.chunks.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(stdout.chunks.length, written, 'nothing is drawn after quitting');
});

test('live: Ctrl+C quits too, and process signal handlers are removed', async (t) => {
  const hiveDir = await hiveFrom(t, 'finished');
  const sigint = process.listenerCount('SIGINT');
  const stdout = fakeStdout({ isTTY: true });
  const stdin = fakeStdin();
  const done = runDashboard({ hiveDir, refreshMs: 30, stdout, stdin });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(process.listenerCount('SIGINT'), sigint + 1);
  stdin.emit('data', Buffer.from([3]));
  await done;
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.ok(stdout.text().endsWith('\x1b[?1049l'));
});
