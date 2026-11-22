import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  const { errorText } = await import('../../src/core/redact.js');
  const text = errorText(form, {});
  assert.ok(!text.includes(secret), text); assert.match(text, /\[redacted\]/);
  if (form.startsWith('Cookie:')) assert.ok(!text.includes('also-private'));
});
for (const text of ['C:\\project folder\\src\\file.js', '56f83a0123456789abcdef0123456789abcdef0123', 'https://example.test/api?mode=test', 'The token budget is sufficient.']) test(`fix2: redaction preserves ${text}`, async () => {
  const { errorText } = await import('../../src/core/redact.js');
  assert.equal(errorText(text, {}), text);
});

test('fix3 item6: multi-megabyte spaces and key repetitions have bounded redaction cost', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const source = `import { performance } from 'node:perf_hooks';
    import { errorText, errorTail } from ${JSON.stringify(new URL('../../src/core/redact.js', import.meta.url).href)};
    const inputs = [('api_key' + ' '.repeat(1024) + '!\\n').repeat(4096), 'key='.repeat(1024 * 1024)];
    const start = performance.now();
    const results = inputs.map(text => [errorText(text + '\\nprovider detail\\n401 end', {}), errorTail(text + '\\nprovider detail\\n401 end', {})]);
    console.log(JSON.stringify({ ms: performance.now() - start, lengths: results.flat().map(s => s.length), end: results.flat().every(s => s.endsWith('401 end')) }));`;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const measured = JSON.parse(result.stdout); t.diagnostic(`redaction workload: ${measured.ms.toFixed(2)} ms`);
  assert.ok(measured.ms < 250, `redaction took ${measured.ms.toFixed(2)} ms (limit 250 ms)`);
  assert.ok(measured.lengths.every(n => n <= 2048)); assert.equal(measured.end, true);
});

test('fix3 item6: internal window cuts discard the credential fragment at the first line', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const text = 'token="' + 'private'.repeat(1000000) + '"\n401 safe diagnostic';
  for (const redact of [errorText, errorTail]) {
    const result = redact(text, {}); assert.equal(result, '401 safe diagnostic');
  }
});

test('fix5: a cut single-line diagnostic keeps its marked, bounded error tail', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const input = 'x'.repeat(20000) + ' 401 provider connection failed';
  for (const redact of [errorText, errorTail]) {
    const result = redact(input, {}); assert.match(result, /401 provider connection failed$/); assert.match(result, /\[cut\]/); assert.ok(result.length <= 2048);
  }
});

test('fix5: a credential label split off by the window cannot expose its next-line value', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const secret = 'PRIVATE_VALUE_' + 's'.repeat(8166), input = 'x'.repeat(12000) + '\napi_key:\n' + secret + '\n401 end';
  for (const redact of [errorText, errorTail]) {
    const result = redact(input, {}); assert.doesNotMatch(result, /PRIVATE_VALUE|s{20}/); assert.match(result, /401 end$/);
  }
});

test('fix5: single-line credentials straddling either cut retain no token fragment', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  for (const input of ['token=' + 'private'.repeat(4000) + ' 401 end', 'Authorization: Bearer ' + 'private'.repeat(4000) + ' 401 end', 'token="' + 'private '.repeat(4000) + 'private tail" 401 end']) {
    for (const redact of [errorText, errorTail]) {
      const result = redact(input, {}); assert.doesNotMatch(result, /private|rivate|ivate/); assert.match(result, /401 end$/);
    }
  }
});

test('fix6 C: every window alignment across a credential label and value hides all secret fragments', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(510), segment = 'api_key:\n' + secret;
  const fragments = new Set(Array.from({ length: secret.length - 3 }, (_, i) => secret.slice(i, i + 4)));
  for (let offset = 0; offset <= segment.length; offset++) {
    const suffix = '\n401 end\n', padding = ' '.repeat(8192 - (segment.length - offset + suffix.length));
    const input = 'old banner\n' + segment + suffix + padding;
    for (const redact of [errorText, errorTail]) {
      const result = redact(input, {});
      for (const fragment of fragments) assert.ok(!result.includes(fragment), `cut ${offset}: ${redact.name} leaked a secret fragment`);
    }
  }
});

test('fix6 C: an ordinary complete first line at the window boundary is kept', async () => {
  const { errorText } = await import('../../src/core/redact.js');
  const tail = 'x'.repeat(8160) + '401 ordinary diagnostic\n401 end\n';
  assert.equal(tail.length, 8192);
  assert.match(errorText('old banner\n' + tail, {}), /401 ordinary diagnostic\n401 end$/);
});

test('fix6 C: original credential labels with long spacing still mask the next-line value', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  for (const label of ['api_key', 'access_token', 'refresh_token', 'id_token', 'client_secret', 'password', 'authorization', 'cookie', 'set-cookie']) {
    const value = 'Q7mR2vX9'.repeat(1021), tail = '\n' + value + '\n401 end';
    assert.equal(tail.length, 8177);
    const input = label + ' '.repeat(400) + ':' + tail + ' '.repeat(8192 - tail.length);
    for (const redact of [errorText, errorTail]) assert.ok(!redact(input, {}).includes('Q7mR'), label);
  }
});

function windowAt(segment, suffix, offset) {
  const padding = '\r'.repeat(8192 - (segment.length - offset + suffix.length));
  const input = 'old banner\n' + segment + suffix + padding;
  assert.equal(input.length - 8192, 'old banner\n'.length + offset);
  return input;
}

for (const label of ['api_key:', 'OPENAI_API_KEY:', 'GITHUB_TOKEN=', 'private_key:', 'Authorization:', '"client_secret" :', 'arbitrary label =\t"\'']) test(`fix7: every window alignment across ${label} hides the next-line secret`, async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(8);
  const fragments = new Set(Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)));
  for (const eol of ['\n', '\r\n']) {
    const segment = label + eol + secret, suffix = eol + '401 end' + eol;
    for (let offset = 0; offset < segment.length; offset++) {
      const input = windowAt(segment, suffix, offset);
      for (const redact of [errorText, errorTail]) {
        const result = redact(input, {});
        for (const fragment of fragments) assert.ok(!result.includes(fragment), `cut ${offset}: ${redact.name} leaked a secret fragment`);
        assert.match(result, /401 end$/);
      }
    }
  }
});

test('fix7: a secret ending a single 20000-character line leaves no fragment', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(1250);
  assert.equal(secret.length, 20000);
  for (const redact of [errorText, errorTail]) {
    const result = redact(secret, {});
    assert.equal(result, '[cut] [redacted]');
    for (let i = 0; i <= secret.length - 8; i++) assert.ok(!result.includes(secret.slice(i, i + 8)));
  }
});

test('fix7: ordinary multiline errors and complete lines after an ordinary cut line stay verbatim', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const ordinary = 'Connection failed\nRetry exhausted\n401 end';
  for (const redact of [errorText, errorTail]) {
    assert.equal(redact(ordinary, {}), ordinary);
    for (const offset of [3, 13, 14]) {
      const segment = 'ordinary line\n' + ordinary;
      const input = 'old banner\n' + segment + '\n' + '\r'.repeat(8192 - (segment.length - offset + 1));
      assert.equal(redact(input, {}), ordinary);
    }
  }
});

for (const label of ['api_key:', 'OPENAI_API_KEY:', 'GITHUB_TOKEN=', 'private_key:', 'Authorization:', '"client_secret" :']) {
  for (const separator of ['\n\n', '\n\n\n', '\r\n\r\n', '\n \t\n']) test(`fix8: blank-separated ${label} ${JSON.stringify(separator)} hides every cut alignment`, async () => {
    const { errorText, errorTail } = await import('../../src/core/redact.js');
    const secret = 'Q7mR2vX9pL4zT6kN'.repeat(8), segment = label + separator + secret;
    const fragments = new Set(Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)));
    const leaks = [];
    for (let offset = 0; offset < segment.length; offset++) {
      const input = windowAt(segment, '\n401 end\n', offset);
      for (const redact of [errorText, errorTail]) {
        const result = redact(input, {});
        if ([...fragments].some(fragment => result.includes(fragment))) leaks.push(`${redact.name}@${offset}`);
        assert.match(result, /401 end$/);
      }
    }
    assert.deepEqual(leaks, []);
  });
}

test('fix8: single-line credential shapes hide every cut alignment', async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  const secret = 'Q7mR2vX9pL4zT6kN'.repeat(8);
  const fragments = new Set(Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)));
  const leaks = [];
  for (const shape of ['api_key: SECRET', 'api_key = SECRET', 'api_key: "SECRET"', '"api_key": "SECRET"', 'token=SECRET']) {
    const segment = shape.replace('SECRET', secret);
    for (let offset = 0; offset < segment.indexOf(secret) + secret.length; offset++) {
      const input = windowAt(segment, ' 401 end', offset);
      assert.ok(!input.slice(-8192).includes('\n'));
      for (const redact of [errorText, errorTail]) {
        const result = redact(input, {});
        if ([...fragments].some(fragment => result.includes(fragment))) leaks.push(`${shape}: ${redact.name}@${offset}`);
      }
    }
  }
  assert.deepEqual(leaks, []);
});

for (const [name, input, forbidden] of [
  ['environment and headers', '401 fixture-env-secret-value\nAuthorization: Bearer fixture-bearer-value\nx-api-key: "private key with spaces"\nrefresh_token=fixture-refresh-value\neyJfixture.eyJpayload.fixtureSignature\n\x1b[31mnot signed in\x1b[0m', /fixture-env-secret-value|fixture-bearer-value|private key with spaces|fixture-refresh-value|eyJfixture|\x1b/],
  ['split chunks joined before redaction', '401 api_key="private ' + 'key with spaces"\n', /private|key with spaces/],
  ['cut credential', 'token=' + 'private'.repeat(4000) + '\n401 after long credential\n', /private/],
  ['stop reason', '429 quota exhausted; token="private token with spaces"', /private token|with spaces/],
]) test('provider diagnostic redaction: ' + name, async () => {
  const { errorText, errorTail } = await import('../../src/core/redact.js');
  for (const redact of [errorText, errorTail]) {
    const result = redact(input, { TRANSPORT_TEST_KEY: 'fixture-env-secret-value' });
    assert.doesNotMatch(result, forbidden); assert.match(result, /401|429/);
  }
});

test('diagnostic tail keeps the final eight lines and masks the last credential', async () => {
  const { errorTail } = await import('../../src/core/redact.js');
  const input = 'old-error\n' + 'x'.repeat(20000) + '\n' + Array.from({ length: 20 }, (_, i) => 'diagnostic-' + i + '\n').join('') + '401 last diagnostic token=sk-lastfixture12345\n';
  const result = errorTail(input, {});
  assert.ok(result.length <= 2048); assert.ok(result.split('\n').length <= 8);
  assert.match(result, /401 last diagnostic token=\[redacted\]/);
  assert.doesNotMatch(result, /old-error|diagnostic-0\b|sk-lastfixture/);
});
