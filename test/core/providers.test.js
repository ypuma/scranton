import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { createProviderStore, discoverModels, validateBaseUrl } from '../../src/core/providers.js';

const KEY = 'FAKE_DISCOVERY_KEY_NEVER_ECHO';
function fixture(t) {
  const root = path.resolve('.scratch/auth-ext-backend'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'providers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createProviderStore(dir), file: path.join(dir, 'models.json') };
}
const definition = (id = 'example') => ({ id, label: 'Example', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'model-a' }] });

test('models merge preserves foreign entries, formats JSON, backs up once and serializes concurrent writers', async (t) => {
  const { dir, file, store } = fixture(t);
  const original = '{"providers":{"foreign":{"baseUrl":"https://foreign.test","apiKey":"$FOREIGN","models":[]}},"$schema":"schema"}\n';
  fs.writeFileSync(file, original);
  await Promise.all([store.add(definition('first')), createProviderStore(dir).add(definition('second'))]);
  const data = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(data.providers.foreign, JSON.parse(original).providers.foreign);
  assert.deepEqual(Object.keys(data.providers).sort(), ['first', 'foreign', 'second']);
  assert.equal(fs.readFileSync(file + '.scranton-bak', 'utf8'), original);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2) + '\n');
  await store.remove('first');
  assert.equal(fs.readFileSync(file + '.scranton-bak', 'utf8'), original);
  assert.equal(store.list().length, 1);
  await assert.rejects(store.remove('foreign'), { status: 409 });
  await assert.rejects(store.add(definition('foreign')), { status: 409 });
  const before = fs.readFileSync(file);
  await assert.rejects(store.remove('not-managed'), { status: 409 });
  assert.deepEqual(fs.readFileSync(file), before);
});

test('corrupt models JSON and externally modified managed entries are never overwritten', async (t) => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, '{corrupt');
  await assert.rejects(store.add(definition()), { status: 409 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
  assert.equal(fs.existsSync(file + '.scranton-bak'), false);
  fs.writeFileSync(file, '{"providers":{}}'); await store.add(definition());
  const changed = JSON.parse(fs.readFileSync(file)); changed.providers.example.headers = { 'foreign-header': 'keep' };
  fs.writeFileSync(file, JSON.stringify(changed));
  await assert.rejects(store.remove('example'), { status: 409 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), changed);
  assert.deepEqual(store.list(), []);
});

test('provider validation rejects builtins, metadata commands, malformed models and unsafe URLs', async (t) => {
  const { store } = fixture(t);
  for (const value of [{ ...definition(), id: 'google' }, { ...definition(), apiKey: KEY }, { ...definition(), models: [{ id: 'a', headers: { Authorization: KEY } }] }, { ...definition(), models: [] }]) await assert.rejects(store.add(value), { status: 400 });
  for (const url of ['http://example.test', 'file:///tmp/a', 'https://user:pass@example.test', 'https://example.test?key=x', 'https://example.test/#hash']) assert.throws(() => validateBaseUrl(url), { status: 400 });
  for (const url of ['https://example.test/v1', 'http://localhost:8080/v1', 'http://127.0.0.1/v1', 'http://[::1]/v1']) assert.ok(validateBaseUrl(url));
});

test('HTTPS discovery sends key only as header and projects only safe model fields', async () => {
  const calls = [];
  const result = await discoverModels({ baseUrl: 'https://example.test/v1', api: 'openai-completions', key: KEY }, { fetcher: async (url, options) => {
    calls.push({ url, options }); return Response.json({ data: [{ id: 'model-a', contextWindow: 4096, maxTokens: 512, key: KEY, secret: KEY }] });
  } });
  assert.equal(calls[0].url, 'https://example.test/v1/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(result, { models: [{ id: 'model-a', contextWindow: 4096, maxTokens: 512 }] });
  assert.ok(!JSON.stringify(result).includes(KEY));
  await assert.rejects(discoverModels({ baseUrl: 'https://example.test/' + KEY, api: 'openai-completions', key: KEY }), (e) => !e.message.includes(KEY));
});

test('discovery refuses cross-host redirects before forwarding header and cuts oversized responses', async () => {
  const input = { baseUrl: 'https://example.test/v1', api: 'openai-responses', key: KEY };
  let calls = 0;
  await assert.rejects(discoverModels(input, { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://other.test/models' } }); } }), (e) => e.status === 502 && !e.message.includes(KEY));
  assert.equal(calls, 1);
  for (const headers of [{ 'content-length': '200' }, {}]) await assert.rejects(discoverModels(input, { maxBytes: 64, fetcher: async () => new Response('x'.repeat(200), { headers }) }), { status: 502 });
  await assert.rejects(discoverModels(input, { fetcher: async () => Response.json({ data: [{ id: KEY }] }) }), (e) => e.status === 502 && !e.message.includes(KEY));
});

test('local HTTP discovery aborts slow headers and body; no key in response or diagnostics', async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.startsWith('/body')) { res.writeHead(200); res.write('{"data":['); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const endpoint of ['headers', 'body']) {
    await assert.rejects(discoverModels({ baseUrl: `http://127.0.0.1:${server.address().port}/${endpoint}`, api: 'openai-completions', key: KEY }, { timeoutMs: 100 }), (e) => e.status === 502 && !e.message.includes(KEY));
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.authorization === `Bearer ${KEY}` && !r.url.includes(KEY)));
});
