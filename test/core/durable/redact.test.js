import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, errorData } from '../../../src/core/durable/shared.js';

const cases = [
  ['raw slash in password', 'postgresql://alice:pa/ss/word@host/db', 'postgresql://***@host/db'],
  ['password query', 'postgresql://alice@host/db?password=query-secret&sslmode=require', 'postgresql://***@host/db?password=***&sslmode=require'],
  ['query without userinfo', 'postgres://host/db?password=query-secret', 'postgresql://***/db?password=***'],
  ['encoded and mixed-case keys', 'POSTGRES://bob:p%40ss@host/db?%70assword=one&PASSword=two&api_key=three&access_token=four&client_secret=five&credential=six&pwd=seven&user=eight', 'postgresql://***@host/db?%70assword=***&PASSword=***&api_key=***&access_token=***&client_secret=***&credential=***&pwd=***&user=***'],
  ['raw slash plus query', 'postgres://alice:raw/slash@host/db?sslpassword=another/secret&sslkey=private-key', 'postgresql://***@host/db?sslpassword=***&sslkey=***'],
  ['existing userinfo masking', 'failed postgresql://alice:password@host/db and postgres://bob:p%40ss@host/db', 'failed postgresql://***@host/db and postgresql://***@host/db'],
  ['existing authority masking', 'postgres://host/db', 'postgresql://***/db'],
  ['ordinary text', 'connection failed without a URL', 'connection failed without a URL'],
];
for (const [name, input, expected] of cases) {
  test(`redact: ${name}`, () => {
    assert.equal(redact(input), expected);
    assert.equal(errorData(new Error(input)).message, expected);
    assert.equal(redact(expected), expected);
  });
}

test('redact masks secrets in multiple quoted URLs without eating surrounding text', () => {
  assert.equal(redact('failed "postgres://alice:pa/ss@host/db?password=one" and \'postgresql://bob:pw@host/db?token=two\''),
    'failed "postgresql://***@host/db?password=***" and \'postgresql://***@host/db?token=***\'');
});
