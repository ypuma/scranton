import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalLog } from '../../src/core/log.js';

function logLine(event) {
  let text = '';
  createTerminalLog({ stream: { isTTY: false, write: (s) => (text += s) }, env: { NO_COLOR: '1' } })(event);
  return text;
}

test('console log times are local HH:MM:SS, not UTC', (t) => {
  const previous = process.env.TZ;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  process.env.TZ = 'Asia/Kolkata'; // UTC+05:30, never equal to UTC
  const ts = '2025-03-01T20:55:04.123Z';
  if (new Date(ts).getTimezoneOffset() !== -330) return t.skip('cannot switch the time zone at runtime here');
  assert.equal(logLine({ type: 'log', ts, level: 'info', message: 'hello' }), '02:25:04 info: hello\n');
});

test('console log times follow the machine time zone', () => {
  const ts = '2025-07-01T20:55:04.000Z';
  const d = new Date(ts);
  const two = (n) => String(n).padStart(2, '0');
  const expected = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  assert.equal(logLine({ type: 'log', ts, level: 'info', message: 'x' }), `${expected} info: x\n`);
});
