import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonlSplitter, parseJsonLine } from '../../src/core/jsonl.js';

const collect = (chunks) => {
  const s = new JsonlSplitter();
  const lines = [];
  for (const c of chunks) lines.push(...s.push(c));
  lines.push(...s.end());
  return lines;
};

test('splits on LF', () => {
  assert.deepEqual(collect(['{"a":1}\n{"b":2}\n']), ['{"a":1}', '{"b":2}']);
});

test('strips a preceding CR (CRLF framing)', () => {
  assert.deepEqual(collect([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]), ['{"a":1}', '{"b":2}']);
});

test('a chunk boundary inside a multibyte UTF-8 character does not corrupt it', () => {
  const bytes = Buffer.from('{"t":"h\u00e9llo \u20ac \u{1F600}"}\n', 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    const lines = collect([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.equal(lines.length, 1, `cut at ${cut}`);
    assert.equal(JSON.parse(lines[0]).t, 'h\u00e9llo \u20ac \u{1F600}');
  }
});

test('U+2028 and U+2029 inside a JSON string are not record boundaries', () => {
  const record = `{"t":"a\u2028b\u2029c"}`;
  const lines = collect([`${record}\n`]);
  assert.deepEqual(lines, [record]);
  assert.equal(JSON.parse(lines[0]).t, 'a\u2028b\u2029c');
});

test('a trailing partial line is flushed by end() and one without LF is still delivered', () => {
  const s = new JsonlSplitter();
  assert.deepEqual(s.push('{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(s.push('2}'), []);
  assert.deepEqual(s.end(), ['{"b":2}']);
  assert.deepEqual(s.end(), []);
});

test('byte-by-byte delivery gives the same lines as one chunk', () => {
  const data = Buffer.from('{"x":"\u00fc"}\r\n\r\n{"y":2}\n', 'utf8');
  const whole = collect([data]);
  const bytes = collect([...data].map((b) => Buffer.from([b])));
  assert.deepEqual(bytes, whole);
});

test('parseJsonLine returns objects only and skips garbage', () => {
  assert.deepEqual(parseJsonLine('{"type":"x"}'), { type: 'x' });
  assert.equal(parseJsonLine(''), null);
  assert.equal(parseJsonLine('   '), null);
  assert.equal(parseJsonLine('not json'), null);
  assert.equal(parseJsonLine('{"half":'), null);
  assert.equal(parseJsonLine('42'), null);
});
