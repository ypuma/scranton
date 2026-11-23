import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startVisualizerServer } from '../../src/server/visualizer-server.js';
import { MAX_WAV_BYTES } from '../../src/core/voice/wav.js';
import { modelBytes, pin, until, voiceFixture, wav } from '../core/voice-fixture.js';

const client = { 'X-Scranton-Client': '1' };
const audio = { ...client, 'Content-Type': 'audio/wav' };
const json = { ...client, 'Content-Type': 'application/json' };

async function fixture(t, overrides, { registry = false, ...listen } = {}) {
  const f = await voiceFixture(t, overrides);
  if (registry) {
    const env = ['SCRANTON_CREDENTIALS_DIR', 'PI_CODING_AGENT_DIR'];
    const saved = env.map(key => process.env[key]);
    for (const key of env) process.env[key] = path.join(f.localData, key);
    t.after(() => env.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  }
  const app = await startVisualizerServer({ publicDir: f.localData, hiveDir: path.join(f.localData, 'hive'), port: 0,
    ...(registry && { dataDir: path.join(f.localData, 'data'), control: { workspace: f.localData, modelWindows: { warm() {} } } }),
    voiceOptions: f.options, ...listen });
  t.after(() => app.close());
  return { ...f, ...app, send: (route, options = {}) => fetch(`${app.url}/api/voice${route}`, { headers: client, ...options }) };
}

async function error(response, status, message) {
  assert.equal(response.status, status);
  if (message) assert.deepEqual(await response.json(), { error: message });
  else await response.text();
}

function chunked(url, parts) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: audio }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    for (const part of parts) req.write(part);
    req.end();
  });
}

test('voice routes require a local host, same origin when supplied, and the client header', async t => {
  const { send, url, port } = await fixture(t);
  await error(await send('/status', { headers: {} }), 403);
  await error(await send('/status', { headers: { ...client, Origin: 'https://example.invalid' } }), 403);
  const foreignHost = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/api/voice/status', headers: { ...client, Host: 'example.invalid' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await send('/status', { headers: { ...client, Origin: url } })).status, 200);
  await error(await send('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 403);
  await error(await send(`/models/${pin.id}/download`, { method: 'DELETE', headers: {} }), 403);
});

test('registry voice settings round-trip in <data>/voice.json and query language overrides the preference', async t => {
  const { send, install, localData } = await fixture(t, {}, { registry: true });
  const status = await (await send('/status')).json();
  assert.deepEqual(status, { available: true, engine: { installed: true, version: 'fixture' },
    models: [{ id: pin.id, label: pin.label, bytes: pin.bytes, installed: false }], model: pin.id, language: 'auto' });
  const update = await send('/settings', { method: 'POST', headers: json, body: '{"language":"en"}' });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).language, 'en');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(localData, 'data/voice.json'), 'utf8')), { model: pin.id, language: 'en' });
  await error(await send('/settings', { method: 'POST', headers: json, body: '{"language":"fr"}' }), 400, 'invalid_language');
  await error(await send('/settings', { method: 'POST', headers: json, body: '{"other":0}' }), 400, 'invalid_settings');
  await install();
  const transcribe = { method: 'POST', headers: audio, body: wav() };
  assert.equal((await (await send('/transcribe', transcribe)).json()).language, 'en');
  const result = await send('/transcribe?language=de', transcribe);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { text: 'Private transcript.', language: 'de', durationMs: 100, model: pin.id });
});

test('download returns 202, status reports progress, and DELETE cancels with 204', async t => {
  const { send, modelDir } = await fixture(t, { fetchModel: async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(modelBytes.subarray(0, 4)); },
  })) });
  await error(await send('/models/missing/download', { method: 'POST' }), 404, 'unknown_model');
  const route = `/models/${pin.id}/download`;
  const accepted = await send(route, { method: 'POST' });
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), '');
  const status = async () => (await (await send('/status')).json()).models[0];
  await until(async () => (await status()).download?.received === 4);
  assert.deepEqual((await status()).download, { received: 4, total: pin.bytes });
  assert.equal((await send(route, { method: 'DELETE' })).status, 204);
  assert.equal((await status()).download, undefined);
  assert.deepEqual(await fs.readdir(modelDir), []);
});

test('transcribe rejects bad language, type, WAV, size (declared and chunked) and missing model', async t => {
  const { send, url } = await fixture(t);
  const post = { method: 'POST', headers: audio, body: wav() };
  await error(await send('/transcribe?language=fr', post), 400, 'invalid_language');
  await error(await send('/transcribe?language=de&language=en', post), 400, 'invalid_language');
  await error(await send('/transcribe', { ...post, headers: client }), 415, 'invalid_audio');
  await error(await send('/transcribe', { ...post, body: 'not a wave' }), 415, 'invalid_audio');
  await error(await send('/transcribe', { ...post, body: Buffer.alloc(MAX_WAV_BYTES + 1) }), 413, 'body_too_large');
  assert.equal(await chunked(`${url}/api/voice/transcribe`, [Buffer.alloc(MAX_WAV_BYTES), Buffer.alloc(1)]), 413);
  await error(await send('/transcribe?language=auto', post), 409, 'model_missing');
});

test('transcribe returns 503 when engine unavailable and 429 when a request is already active', async t => {
  let available = false;
  const f = await fixture(t, { engine: () => available ? { executable: process.execPath, prefix: [f.script, '--hang'] } : { reason: 'unsupported_platform' } });
  const { send, install, localData, close } = f;
  const post = { method: 'POST', headers: audio, body: wav() };
  await error(await send('/transcribe', post), 503, 'engine_unavailable');
  await install();
  available = true;
  const pending = send('/transcribe', post).then(res => res.status, () => null);
  const tmp = path.join(localData, 'voice-temp');
  await until(async () => (await fs.readdir(tmp).catch(() => [])).length > 0);
  await error(await send('/transcribe', post), 429, 'busy');
  await close();
  await pending;
  assert.deepEqual(await fs.readdir(tmp), []);
});
