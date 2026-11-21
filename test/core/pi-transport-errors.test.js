import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startPi } from '../../src/core/pi-runner.js';
import { fakeConfig } from './helpers.js';

function fixture(t) {
  const root = path.resolve('.scratch/usability/fix7/transport');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'transport-'));
  const script = path.join(dir, 'pi.mjs'), runners = [];
  fs.writeFileSync(script, `
    import { createInterface } from 'node:readline';
    const mode = process.env.TRANSPORT_CASE;
    const rpc = process.argv.includes('rpc');
    const send = r => process.stdout.write(JSON.stringify(r) + '\\n');
    const message = (content = '[TASK_COMPLETE]', extra = {}) => send({type:'message_end',message:{role:'assistant',content,stopReason:'stop',...extra}});
    const end = () => { message(); send({type:'agent_settled'}); };
    const run = async r => {
      if (mode === 'auth') {
        process.stderr.write('AuthenticationError: 401 Unauthorized - not signed in; api_key=sk-fixture123456\\n', () => process.exit(1)); return;
      }
      if (rpc && !['noise-only', 'mismatched', 'bad-success'].includes(mode)) send({type:'response',id:r.id,command:r.type,success:true});
      send({type:'agent_start'});
      if (mode === 'rate') { process.stderr.write('429 Too Many Requests - quota exhausted\\n', () => process.exit(2)); return; }
      if (mode === 'signal') { process.stderr.write('Provider connection lost\\n', () => process.kill(process.pid, 'SIGKILL')); return; }
      if (mode === 'mid-answer') {
        message('Completed earlier turn');
        send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Partial answer'}});
        process.stderr.write('ConnectionError: stream disconnected\\n', () => process.exit(3)); return;
      }
      if (mode === 'stop-error') { message('', {stopReason:'error',errorMessage:'429 quota exhausted; token="private token with spaces"'}); send({type:'agent_settled'}); return; }
      if (mode === 'noise' || mode === 'noise-exit' || mode === 'noise-only' || mode === 'noise-bounded') {
        if (mode === 'noise-bounded') process.stdout.write('old-banner\\n' + 'x'.repeat(20000) + '\\n');
        process.stdout.write('(node:1) DeprecationWarning: fixture banner token="private token with spaces"\\r\\n');
        process.stdout.write('null\\n42\\n[]\\n{"banner":"not a protocol record"}\\n{"type":\\n');
        if (mode === 'noise-exit' || mode === 'noise-bounded') { process.stdout.write('last-banner\\n', () => process.exit(4)); return; }
        if (mode === 'noise-only') return;
      }
      if (mode === 'bounded') {
        process.stderr.write('old-error\\n' + 'x'.repeat(20000) + '\\n' + Array.from({length:20}, (_, i) => 'diagnostic-' + i + '\\n').join('') + '401 last diagnostic token=sk-lastfixture12345\\n', () => process.exit(1)); return;
      }
      if (mode === 'single-line') {
        process.stderr.write('x'.repeat(20000) + ' 401 provider connection failed\\n', () => process.exit(1)); return;
      }
      if (mode === 'cut-secret') {
        process.stderr.write('token=' + 'private'.repeat(4000) + '\\n401 after long credential\\n', () => process.exit(1)); return;
      }
      if (mode === 'split-secret') {
        process.stderr.write('401 api_key="private ', () => setTimeout(() => process.stderr.write('key with spaces"\\n', () => process.exit(1)), 20)); return;
      }
      if (mode === 'secrets') {
        process.stderr.write('401 ' + process.env.TRANSPORT_TEST_KEY + '\\nAuthorization: Bearer fixture-bearer-value\\nx-api-key: "private key with spaces"\\nrefresh_token=fixture-refresh-value\\neyJfixture.eyJpayload.fixtureSignature\\n\\x1b[31mnot signed in\\x1b[0m\\n', () => process.exit(1)); return;
      }
      if (mode === 'mismatched') { send({type:'response',id:r.id,command:'steer',success:true}); return; }
      if (mode === 'bad-success') { send({type:'response',id:r.id,command:r.type,success:'yes'}); return; }
      if (mode === 'parse-error') { send({type:'response',command:'parse',success:false,error:'Failed to parse command token=sk-parsefixture1234'}); return; }
      if (mode === 'bad-content') { message([null]); return; }
      if (mode === 'truncated') { process.stdout.write('{"type":"message_end","message":', () => process.exit(0)); return; }
      if (mode === 'unknown-id') { send({type:'response',id:'stale-response',command:'steer',success:true}); send({type:'future_event'}); }
      if (mode === 'oversized' || mode === 'oversized-unframed') {
        const prefix = '{"type":"unknown","text":"';
        await new Promise(resolve => process.stdout.write(prefix + 'x'.repeat(16 * 1024 * 1024), resolve));
        if (mode === 'oversized-unframed') return;
        process.stdout.write('"}\\n');
      }
      if (mode === 'silent') { send({type:'tool_execution_start',toolName:'bash',args:{command:'long tool'}}); return; }
      end();
    };
    if (rpc) createInterface({input:process.stdin}).on('line', line => { const r = JSON.parse(line); if (r.type === 'prompt') void run(r); }).on('close', () => process.exit(0));
    else { await run(); if (['silent', 'noise-only', 'oversized-unframed'].includes(mode)) setInterval(() => {}, 10000); }
  `);
  const config = fakeConfig(dir);
  t.after(async () => { await Promise.all(runners.map(r => r.kill())); fs.rmSync(dir, { recursive: true, force: true }); });
  return (transport, mode, extra = {}) => {
    const runner = startPi({ transport, spec: { argv: [process.execPath, script], shell: false },
      cwd: dir, agentId: 'dwight', agentConfig: config.agents.dwight, pi: config.pi,
      hive: { dir, inboxPath: () => path.join(dir, 'inbox.md'), sessionDir: () => dir },
      message: 'transport test', timeoutMs: 5000, startupTimeoutMs: 3000,
      extraEnv: { TRANSPORT_CASE: mode, TRANSPORT_TEST_KEY: 'fixture-env-secret-value' }, ...extra });
    runners.push(runner);
    return runner;
  };
}

for (const transport of ['json', 'rpc']) {
  test(`${transport}: auth failure includes a redacted, single-line stderr cause`, async t => {
    const result = await fixture(t)(transport, 'auth').done;
    assert.equal(result.failure.kind, 'exit');
    assert.equal(result.failure.message, 'pi exited with code 1; pi stderr: AuthenticationError: 401 Unauthorized - not signed in; api_key=[redacted]');
    assert.equal(result.stderrTail, 'AuthenticationError: 401 Unauthorized - not signed in; api_key=[redacted]');
    assert.equal(result.keyword, null);
  });

  for (const [mode, cause] of [['rate', '429 Too Many Requests - quota exhausted'], ['signal', 'Provider connection lost'], ['mid-answer', 'ConnectionError: stream disconnected']]) {
    test(`${transport}: ${mode} retains the provider cause and cannot succeed`, async t => {
      const result = await fixture(t)(transport, mode).done;
      assert.equal(result.failure.kind, 'exit');
      assert.match(result.failure.message, /pi exited with (code [1-9]|signal SIGKILL)/);
      assert.ok(result.failure.message.includes(cause), result.failure.message);
      assert.equal(result.ok, false);
      assert.equal(result.keyword, null);
      if (mode === 'mid-answer') assert.equal(result.text, 'Completed earlier turn');
    });
  }

  test(`${transport}: fix5 single long stderr line keeps a marked cause`, async t => {
    const result = await fixture(t)(transport, 'single-line').done;
    assert.match(result.failure.message, /401 provider connection failed/);
    assert.match(result.stderrTail, /\[cut\]/); assert.ok(result.stderrTail.length <= 2048);
  });

  test(`${transport}: stderr tail is bounded and retains the end`, async t => {
    const result = await fixture(t)(transport, 'bounded').done;
    assert.ok(result.stderrTail.length <= 2048);
    assert.ok(result.stderrTail.split('\n').length <= 8);
    assert.match(result.stderrTail, /401 last diagnostic token=\[redacted\]/);
    assert.doesNotMatch(result.failure.message, /old-error|diagnostic-0\b|sk-lastfixture/);
  });

  test(`${transport}: provider diagnostics redact env secrets, headers, quoted values and JWTs`, async t => {
    const result = await fixture(t)(transport, 'secrets').done;
    for (const text of [result.failure.message, result.stderrTail]) {
      assert.doesNotMatch(text, /fixture-env-secret-value|fixture-bearer-value|private key with spaces|fixture-refresh-value|eyJfixture|\x1b/);
      assert.match(text, /401/);
      assert.match(text, /not signed in/);
    }
  });

  for (const mode of ['cut-secret', 'split-secret']) test(`${transport}: ${mode} never exposes a credential fragment`, async t => {
    const result = await fixture(t)(transport, mode).done;
    assert.doesNotMatch(result.failure.message, /private|key with spaces/);
    assert.doesNotMatch(result.stderrTail, /private|key with spaces/);
    assert.match(result.failure.message, /401/);
  });

  test(`${transport}: stopReason diagnostics are redacted too`, async t => {
    const result = await fixture(t)(transport, 'stop-error').done;
    assert.equal(result.failure.kind, 'stop_reason');
    assert.match(result.failure.message, /429 quota exhausted/);
    assert.doesNotMatch(result.failure.message, /private token|with spaces/);
  });

  test(`${transport}: LF-delimited noise does not prevent a healthy answer`, async t => {
    const live = [];
    const result = await fixture(t)(transport, 'noise', { onLive: r => live.push(r) }).done;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.keyword, 'TASK_COMPLETE');
    assert.equal(result.stderrTail, '');
    if (transport === 'rpc') assert.ok(live.every(r => typeof r.type === 'string'));
  });

  test(`${transport}: an accepted prompt with a quiet tool stays live until its configured timeout`, async t => {
    let entered;
    const tool = new Promise(resolve => { entered = resolve; });
    const runner = fixture(t)(transport, 'silent', { timeoutMs: 0, onTool: entered });
    await tool;
    let finished = false;
    runner.done.then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(finished, false);
    await runner.kill();
    assert.equal((await runner.done).failure.kind, 'interrupted');
  });
}

for (const mode of ['noise-exit', 'noise-bounded']) test(`rpc: ${mode} retains a bounded, redacted stdout sample on later failure`, async t => {
  const result = await fixture(t)('rpc', mode).done;
  assert.equal(result.failure.kind, 'exit');
  assert.match(result.failure.message, /pi stdout \(ignored\):/);
  assert.match(result.failure.message, /last-banner/);
  assert.doesNotMatch(result.failure.message, /private token|with spaces|old-banner/);
  assert.ok(result.failure.message.length < 5000);
});

test('rpc: noise alone does not satisfy a pending command or replace the startup timeout', async t => {
  const result = await fixture(t)('rpc', 'noise-only', { startupTimeoutMs: 400 }).done;
  assert.equal(result.failure.kind, 'rpc_timeout');
  assert.match(result.failure.message, /pi did not start within 0.4 s/);
  assert.match(result.failure.message, /pi stdout \(ignored\):/);
});

for (const [mode, message] of [['mismatched', 'Mismatched Pi RPC ACK'], ['bad-success', 'Mismatched Pi RPC ACK'], ['parse-error', 'Failed to parse command'], ['bad-content', 'Invalid assistant content'], ['truncated', 'Incomplete Pi RPC record at EOF'], ['oversized', 'Pi RPC record exceeds'], ['oversized-unframed', 'Pi RPC record exceeds']]) {
  test(`rpc: ${mode} remains a fatal protocol error`, async t => {
    const result = await fixture(t)('rpc', mode).done;
    assert.equal(result.failure.kind, 'protocol');
    assert.ok(result.failure.message.includes(message), result.failure.message);
    assert.doesNotMatch(result.failure.message, /sk-parsefixture/);
  });
}

test('rpc: unknown response IDs and unknown event types remain forward compatible', async t => {
  assert.equal((await fixture(t)('rpc', 'unknown-id').done).ok, true);
});

for (const [form, secret] of [
  ['client_secret=fixture-client-value', 'fixture-client-value'],
  ['id_token=fixture-id-value', 'fixture-id-value'],
  ['failed with sk-fixtureBare12345678901234567890', 'sk-fixtureBare12345678901234567890'],
  ['https://user:fixture-password@example.test/api', 'user:fixture-password@'],
  ['Cookie: session=fixture-cookie; other=also-private', 'fixture-cookie'],
  ['Set-Cookie: session=fixture-set-cookie; HttpOnly', 'fixture-set-cookie'],
  ['https://example.test/api?key=AIzaFixtureSecretValue&mode=test', 'AIzaFixtureSecretValue'],
  ['https://example.test/api?api_key=fixture-query&access_token=fixture-access', 'fixture-query']
]) test(`fix2: redact ${form.split(/[=:]/)[0]}`, async () => {
  const { piErrorText } = await import('../../src/core/pi-rpc-session.js');
  const text = piErrorText(form, {});
  assert.ok(!text.includes(secret), text); assert.match(text, /\[redacted\]/);
  if (form.startsWith('Cookie:')) assert.ok(!text.includes('also-private'));
});
for (const text of ['C:\\project folder\\src\\file.js', '56f83a0123456789abcdef0123456789abcdef0123', 'https://example.test/api?mode=test', 'The token budget is sufficient.']) test(`fix2: redaction preserves ${text}`, async () => {
  const { piErrorText } = await import('../../src/core/pi-rpc-session.js');
  assert.equal(piErrorText(text, {}), text);
});

test('fix3 item6: multi-megabyte spaces and key repetitions have bounded redaction cost', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const source = `import { performance } from 'node:perf_hooks';
    import { piErrorText, piErrorTail } from ${JSON.stringify(new URL('../../src/core/pi-rpc-session.js', import.meta.url).href)};
    const inputs = [('api_key' + ' '.repeat(1024) + '!\\n').repeat(4096), 'key='.repeat(1024 * 1024)];
    const start = performance.now();
    const results = inputs.map(text => [piErrorText(text + '\\nprovider detail\\n401 end', {}), piErrorTail(text + '\\nprovider detail\\n401 end', {})]);
    console.log(JSON.stringify({ ms: performance.now() - start, lengths: results.flat().map(s => s.length), end: results.flat().every(s => s.endsWith('401 end')) }));`;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const measured = JSON.parse(result.stdout); t.diagnostic(`redaction workload: ${measured.ms.toFixed(2)} ms`);
  assert.ok(measured.ms < 250, `redaction took ${measured.ms.toFixed(2)} ms (limit 250 ms)`);
  assert.ok(measured.lengths.every(n => n <= 2048)); assert.equal(measured.end, true);
});

test('fix3 item6: internal window cuts discard the credential fragment at the first line', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const text = 'token="' + 'private'.repeat(1000000) + '"\n401 safe diagnostic';
  for (const redact of [piErrorText, piErrorTail]) {
    const result = redact(text, {}); assert.equal(result, '401 safe diagnostic');
  }
});

test('fix5: a cut single-line diagnostic keeps its marked, bounded error tail', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const input = 'x'.repeat(20000) + ' 401 provider connection failed';
  for (const redact of [piErrorText, piErrorTail]) {
    const result = redact(input, {}); assert.match(result, /401 provider connection failed$/); assert.match(result, /\[cut\]/); assert.ok(result.length <= 2048);
  }
});

test('fix5: a credential label split off by the window cannot expose its next-line value', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const secret = 'PRIVATE_VALUE_' + 's'.repeat(8166), input = 'x'.repeat(12000) + '\napi_key:\n' + secret + '\n401 end';
  for (const redact of [piErrorText, piErrorTail]) {
    const result = redact(input, {}); assert.doesNotMatch(result, /PRIVATE_VALUE|s{20}/); assert.match(result, /401 end$/);
  }
});

test('fix5: single-line credentials straddling either cut retain no token fragment', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  for (const input of ['token=' + 'private'.repeat(4000) + ' 401 end', 'Authorization: Bearer ' + 'private'.repeat(4000) + ' 401 end', 'token="' + 'private '.repeat(4000) + 'private tail" 401 end']) {
    for (const redact of [piErrorText, piErrorTail]) {
      const result = redact(input, {}); assert.doesNotMatch(result, /private|rivate|ivate/); assert.match(result, /401 end$/);
    }
  }
});

test('fix6 C: every window alignment across a credential label and value hides all secret fragments', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(510), segment = 'api_key:\n' + secret;
  const fragments = new Set(Array.from({ length: secret.length - 3 }, (_, i) => secret.slice(i, i + 4)));
  for (let offset = 0; offset <= segment.length; offset++) {
    const suffix = '\n401 end\n', padding = ' '.repeat(8192 - (segment.length - offset + suffix.length));
    const input = 'old banner\n' + segment + suffix + padding;
    for (const redact of [piErrorText, piErrorTail]) {
      const result = redact(input, {});
      for (const fragment of fragments) assert.ok(!result.includes(fragment), `cut ${offset}: ${redact.name} leaked a secret fragment`);
    }
  }
});

test('fix6 C: an ordinary complete first line at the window boundary is kept', async () => {
  const { piErrorText } = await import('../../src/core/pi-rpc-session.js');
  const tail = 'x'.repeat(8160) + '401 ordinary diagnostic\n401 end\n';
  assert.equal(tail.length, 8192);
  assert.match(piErrorText('old banner\n' + tail, {}), /401 ordinary diagnostic\n401 end$/);
});

test('fix6 C: original credential labels with long spacing still mask the next-line value', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  for (const label of ['api_key', 'access_token', 'refresh_token', 'id_token', 'client_secret', 'password', 'authorization', 'cookie', 'set-cookie']) {
    const value = 'Q7mR2vX9'.repeat(1021), tail = '\n' + value + '\n401 end';
    assert.equal(tail.length, 8177);
    const input = label + ' '.repeat(400) + ':' + tail + ' '.repeat(8192 - tail.length);
    for (const redact of [piErrorText, piErrorTail]) assert.ok(!redact(input, {}).includes('Q7mR'), label);
  }
});

for (const label of ['api_key:', 'OPENAI_API_KEY:', 'GITHUB_TOKEN=', 'private_key:', 'Authorization:', '"client_secret" :', 'arbitrary label =\t"\'']) test(`fix7: every window alignment across ${label} hides the next-line secret`, async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(8);
  const fragments = new Set(Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)));
  for (const eol of ['\n', '\r\n']) {
    const segment = label + eol + secret, suffix = eol + '401 end' + eol;
    for (let offset = 0; offset < segment.length; offset++) {
      const padding = '\r'.repeat(8192 - (segment.length - offset + suffix.length));
      const input = 'old banner\n' + segment + suffix + padding;
      assert.equal(input.length - 8192, 'old banner\n'.length + offset);
      for (const redact of [piErrorText, piErrorTail]) {
        const result = redact(input, {});
        for (const fragment of fragments) assert.ok(!result.includes(fragment), `cut ${offset}: ${redact.name} leaked a secret fragment`);
        assert.match(result, /401 end$/);
      }
    }
  }
});

test('fix7: a secret ending a single 20000-character line leaves no fragment', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(1250);
  assert.equal(secret.length, 20000);
  for (const redact of [piErrorText, piErrorTail]) {
    const result = redact(secret, {});
    assert.equal(result, '[cut] [redacted]');
    for (let i = 0; i <= secret.length - 8; i++) assert.ok(!result.includes(secret.slice(i, i + 8)));
  }
});

test('fix7: ordinary multiline errors and complete lines after an ordinary cut line stay verbatim', async () => {
  const { piErrorText, piErrorTail } = await import('../../src/core/pi-rpc-session.js');
  const ordinary = 'Connection failed\nRetry exhausted\n401 end';
  for (const redact of [piErrorText, piErrorTail]) {
    assert.equal(redact(ordinary, {}), ordinary);
    for (const offset of [3, 13, 14]) {
      const segment = 'ordinary line\n' + ordinary;
      const input = 'old banner\n' + segment + '\n' + '\r'.repeat(8192 - (segment.length - offset + 1));
      assert.equal(redact(input, {}), ordinary);
    }
  }
});
