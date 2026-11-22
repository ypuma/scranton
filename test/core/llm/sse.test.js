import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../../src/core/llm/sse.js';

async function* chunks(text, width) { const b = Buffer.from(text); for (let i = 0; i < b.length; i += width) yield b.subarray(i, i + width); }
async function collect(body, options) { return Array.fromAsync(parseSSE(body, options)); }
for (const ending of ['\n', '\r\n', '\r']) {
  test(`SSE chunk boundaries ${JSON.stringify(ending)}`, async () => {
    const text = ['\ufeff: comment', 'id: 12', 'event: delta', 'data: one', 'data:  two \u00e9', '', ': ping', '', 'data: next', '', ''].join(ending);
    for (let width = 1; width < 40; width++) assert.deepEqual(await collect(chunks(text, width)), [{ event: 'delta', id: '12', data: 'one\n two \u00e9' }, { event: 'message', id: '12', data: 'next' }]);
  });
}
test('SSE limits, malformed UTF8, truncation and abort', async () => {
  await assert.rejects(collect(chunks('data: unfinished', 2)), /Truncated/);
  await assert.rejects(collect(chunks('data: too big\n\n', 2), { maxEventBytes: 4 }), /limit/);
  await assert.rejects(collect(chunks('data: too big\n\n', 2), { maxBytes: 4 }), /limit/);
  await assert.rejects(collect((async function* () { yield Buffer.from([0xff]); })()));
  const c = new AbortController(); c.abort();
  await assert.rejects(collect(chunks('data: x\n\n', 2), { signal: c.signal }));
});

test('SSE ignores empty transport chunks between split CRLF', async () => {
  const body = (async function* () { for (const text of ['data: one\r', '', '\ndata: two\r\n\r\n']) yield Buffer.from(text); })();
  assert.deepEqual(await collect(body), [{ event: 'message', data: 'one\ntwo' }]);
});
