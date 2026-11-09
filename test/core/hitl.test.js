import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createTerminalHitl, isInteractive } from '../../src/core/hitl.js';

const ctx = { title: 'Circuit breaker: m2 failed 3 cycles in a row', reason: '3 consecutive failed cycles', excerpt: 'line one\nline two' };

function terminal({ tty }) {
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  let output = '';
  const stdout = new PassThrough();
  stdout.isTTY = tty;
  stdout.columns = 80;
  stdout.on('data', (d) => (output += d));
  const ask = createTerminalHitl({ stdin, stdout, env: { NO_COLOR: '1' } });
  return { stdin, ask, output: () => output };
}

for (const tty of [false, true]) {
  const mode = tty ? 'tty' : 'line mode';

  test(`[${mode}] f + one line of text gives feedback`, async () => {
    const t = terminal({ tty });
    const answer = t.ask(ctx);
    t.stdin.write('f\n');
    await new Promise((r) => setTimeout(r, 20));
    t.stdin.write('Use the home directory\n');
    assert.deepEqual(await answer, { decision: 'feedback', feedback: 'Use the home directory' });
    const out = t.output();
    assert.match(out, /Circuit breaker: m2 failed 3 cycles/);
    assert.match(out, /\| line one/);
    assert.match(out, /\[f\] feedback for Dwight.*\[r\] retry.*\[s\] skip milestone.*\[a\] abort/);
  });

  test(`[${mode}] r, s and a (any case, any trailing text) map to retry, skip, abort`, async () => {
    for (const [key, decision] of [['r', 'retry'], ['S', 'skip'], ['abort', 'abort']]) {
      const t = terminal({ tty });
      const answer = t.ask(ctx);
      t.stdin.write(`${key}\n`);
      assert.deepEqual(await answer, { decision });
    }
  });

  test(`[${mode}] garbage and empty feedback re-ask instead of guessing`, async () => {
    const t = terminal({ tty });
    const answer = t.ask(ctx);
    t.stdin.write('what?\n');
    await new Promise((r) => setTimeout(r, 20));
    t.stdin.write('f\n');
    await new Promise((r) => setTimeout(r, 20));
    t.stdin.write('\n');
    await new Promise((r) => setTimeout(r, 20));
    t.stdin.write('s\n');
    assert.deepEqual(await answer, { decision: 'skip' });
    assert.match(t.output(), /Please answer f, r, s or a/);
    assert.match(t.output(), /empty feedback/);
  });

  test(`[${mode}] end of input means abort`, async () => {
    const t = terminal({ tty });
    const answer = t.ask(ctx);
    t.stdin.end();
    assert.deepEqual(await answer, { decision: 'abort' });
  });
}

test('Ctrl+C at the prompt is an interrupt, not a plain abort', async () => {
  for (const typed of [false, true]) {
    const t = terminal({ tty: true });
    const answer = t.ask(ctx);
    await new Promise((r) => setTimeout(r, 20));
    if (typed) {
      t.stdin.write('f\n');
      await new Promise((r) => setTimeout(r, 20));
    }
    t.stdin.write('\x03');
    assert.deepEqual(await answer, { decision: 'abort', interrupted: true }, typed ? 'at the feedback prompt' : 'at the choice prompt');
  }
});

test('end of input stays a plain abort (no interrupted flag)', async () => {
  const t = terminal({ tty: true });
  const answer = t.ask(ctx);
  t.stdin.end();
  assert.deepEqual(await answer, { decision: 'abort' });
});

test('an abort signal cancels a pending prompt', async () => {
  const t = terminal({ tty: false });
  const controller = new AbortController();
  const answer = t.ask(ctx, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await answer, { decision: 'abort' });
});

test('feedbackTarget and skipLabel are shown (planning prompt)', async () => {
  const t = terminal({ tty: false });
  const answer = t.ask({ ...ctx, feedbackTarget: 'Michael', skipLabel: 'skip planning' });
  t.stdin.write('a\n');
  await answer;
  assert.match(t.output(), /feedback for Michael.*\[s\] skip planning/);
});

test('isInteractive needs a TTY on both streams', () => {
  assert.equal(isInteractive({ isTTY: true }, { isTTY: true }), true);
  assert.equal(isInteractive({ isTTY: true }, { isTTY: false }), false);
  assert.equal(isInteractive({ isTTY: false }, { isTTY: true }), false);
  assert.equal(isInteractive(undefined, undefined), false);
});
