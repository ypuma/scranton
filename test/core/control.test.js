import { isolationTestEnv } from './isolation-test-root.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { once } from 'node:events';
import { runFake, tempDir, ROOT, readEvents } from './helpers.js';
import { writeFileAtomicSync } from '../../src/core/util.js';
import { loadConfig } from '../../src/core/config.js';

for (const decision of ['feedback', 'retry', 'skip', 'abort']) {
  test(`hive breaker answer ${decision}`, { timeout: 60000 }, async (t) => {
    let hive;
    let count = 0;
    const run = await runFake(t, { scenario: 'breaker', onBreaker: 'hive',
      beforeRun: (o) => { hive = o.hive.dir; },
      listener: (e) => {
        if (e.type !== 'hitl_request') return;
        const answer = ++count > 1 ? 'skip' : decision;
        writeFileAtomicSync(path.join(hive, 'human/response.json'), JSON.stringify({ v: 1, runId: e.runId, requestSeq: e.seq, decision: answer, feedback: 'Use current directory', ts: new Date().toISOString() }));
      }
    });
    assert.equal(run.events.find((e) => e.type === 'hitl_response').decision, decision);
    assert.equal(run.result.status, decision === 'feedback' ? 'success' : decision === 'abort' ? 'aborted' : 'partial');
    assert.ok(fs.readdirSync(path.join(hive, 'human/archive')).some((f) => f.startsWith('response-')));
  });
}
for (const scenario of ['blocked', 'infra']) {
  test(`hive handles ${scenario} pause`, async (t) => {
    let hive;
    const run = await runFake(t, { scenario, noPlan: scenario === 'infra', onBreaker: 'hive', env: scenario === 'infra' ? { SCRANTON_FAKE_FAIL: 'exit1' } : {},
      beforeRun: (o) => { hive = o.hive.dir; }, listener: (e) => {
        if (e.type === 'hitl_request') writeFileAtomicSync(path.join(hive, 'human/response.json'), JSON.stringify({ v: 1, runId: e.runId, requestSeq: e.seq, decision: 'skip', ts: new Date().toISOString() }));
      }
    });
    assert.equal(run.result.status, 'partial');
    assert.equal(run.events.filter((e) => e.type === 'cycle_result' && e.result === 'failed').length, 0);
  });
}

test('stale, mismatched and invalid answers are archived, never applied', { timeout: 20000 }, async (t) => {
  let hive;
  let expected;
  let pending = [];
  const sendNext = () => writeFileAtomicSync(path.join(hive, 'human/response.json'), JSON.stringify(pending.shift()));
  const run = await runFake(t, { scenario: 'blocked', onBreaker: 'hive', beforeRun: (o) => { hive = o.hive.dir; }, listener: (e) => {
    if (e.type === 'run_started') writeFileAtomicSync(path.join(hive, 'human/response.json'), '{}');
    // The rejection log is emitted after the archive rename. Don't overwrite the
    // single response slot while the consumer is still polling the previous answer.
    if (e.type === 'log' && e.message === 'Rejected stale, invalid or mismatched human response' && pending.length) sendNext();
    if (e.type !== 'hitl_request') return;
    const base = { v: 1, runId: e.runId, requestSeq: e.seq, decision: 'skip', ts: new Date().toISOString() };
    const bad = [{ ...base, runId: 'old' }, { ...base, requestSeq: 0 }, { ...base, decision: 'feedback', feedback: '' }, { ...base, decision: 'nope' }, { ...base, v: 2 }, { ...base, ts: 'bad' }];
    expected = [{}, ...bad].map(v => JSON.stringify(v)).sort();
    pending = [...bad, base];
    sendNext();
  } });
  assert.equal(run.result.status, 'partial');
  assert.deepEqual(run.events.filter(e => e.type === 'hitl_response').map(e => e.decision), ['skip']);
  const archive = path.join(hive, 'human/archive');
  const rejected = fs.readdirSync(archive).filter(f => f.startsWith('rejected-'));
  assert.equal(rejected.length, 7);
  assert.deepEqual(rejected.map(f => fs.readFileSync(path.join(archive, f), 'utf8')).sort(), expected);
});

for (const waiting of [false, true]) {
  test(`stop file during ${waiting ? 'human wait' : 'scripted agent run'} exits 130`, { timeout: 15000 }, async (t) => {
    const dir = tempDir(t);
    const hive = path.join(dir, 'hive');
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/scranton.js'), 'run', 'Build a todo CLI', '--trusted-host', '--hive', hive, '--workspace', path.join(dir, 'ws'), '--on-breaker', 'hive'], { env: isolationTestEnv({ SCRANTON_FAKE_MODE: '1', SCRANTON_FAKE_SCENARIO: 'blocked', SCRANTON_FAKE_DELAY_MS: waiting ? '0' : '100' }), stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const ended = once(child, 'close');
    let wrote = false;
    const timer = setInterval(() => {
      if (wrote || !fs.existsSync(path.join(hive, 'events.jsonl'))) return;
      const events = readEvents(hive);
      if (!events.some((e) => e.type === (waiting ? 'hitl_request' : 'agent_tool'))) return;
      wrote = true;
      writeFileAtomicSync(path.join(hive, 'control/stop.json'), JSON.stringify({ v: 1, runId: events[0].runId, ts: new Date().toISOString() }));
    }, 50);
    t.after(() => clearInterval(timer));
    assert.equal((await ended)[0], 130);
    assert.equal(readEvents(hive).at(-1).status, 'aborted');
    assert.equal(fs.existsSync(path.join(hive, 'control/stop.json')), false);
  });
}

test('hive policy config/env/flag precedence', () => {
  const opts = { env: { SCRANTON_ON_BREAKER: 'hive' }, fileConfig: { onBreaker: 'skip' } };
  assert.equal(loadConfig(opts).onBreaker, 'hive');
  assert.equal(loadConfig({ ...opts, flags: { onBreaker: 'abort' } }).onBreaker, 'abort');
});

for (const input of ['', 'quit\n']) {
  test(`app-server ready and clean exit on ${input ? 'quit' : 'EOF'}`, { timeout: 15000 }, async (t) => {
    const dir = tempDir(t);
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/scranton.js'), 'app-server', '--hive', path.join(dir, 'hive'), '--workspace', path.join(dir, 'ws')], { cwd: dir, env: isolationTestEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const ended = once(child, 'close');
    let text = '';
    const ready = new Promise((resolve) => child.stdout.on('data', (d) => { text += d; if (text.includes('\n')) resolve(); }));
    await ready;
    const value = JSON.parse(text.trim());
    assert.equal(value.ready, true);
    assert.equal(value.pid, child.pid);
    assert.match(value.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    if (input) child.stdin.write(input); else child.stdin.end();
    assert.equal((await ended)[0], 0);
    assert.equal(text.trim().split('\n').length, 1);
    t.diagnostic(text.trim());
  });
}
