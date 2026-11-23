import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createVoice } from '../../src/core/voice/index.js';
import { localVoiceData } from '../../src/core/voice/models.js';
import { MAX_WAV_BYTES, validateWav } from '../../src/core/voice/wav.js';
import { resolveWhisper } from '../../src/core/voice/whisper.js';
import { modelBytes, pin, until, voiceFixture, wav } from './voice-fixture.js';

test('accept only bounded 16 kHz mono PCM16 RIFF and canonicalize ancillary chunks', () => {
  const valid = wav();
  assert.deepEqual(validateWav(valid), { wav: valid, durationMs: 100 });
  const extra = Buffer.concat([valid.subarray(0, 12), Buffer.from('JUNK\x01\x00\x00\x00x\x00'), valid.subarray(12)]);
  extra.writeUInt32LE(extra.length - 8, 4);
  assert.deepEqual(validateWav(extra).wav, valid);
  for (const [offset, value, bits] of [[4, 2, 32], [20, 3, 16], [22, 2, 16], [24, 44100, 32], [28, 1, 32], [32, 1, 16], [34, 8, 16], [40, 99999, 32]]) {
    const malformed = Buffer.from(valid);
    malformed[`writeUInt${bits}LE`](value, offset);
    assert.throws(() => validateWav(malformed), { status: 415 });
  }
  assert.throws(() => validateWav(wav(0)), { status: 415 });
  assert.equal(validateWav(wav((MAX_WAV_BYTES - 44) / 2)).wav.length, MAX_WAV_BYTES);
  assert.throws(() => validateWav(Buffer.alloc(MAX_WAV_BYTES + 1)), { status: 413 });
});

test('voice status shape, non-roaming path, and persistent settings', async t => {
  const { voice, options, install } = await voiceFixture(t);
  assert.equal(localVoiceData('win32', { LOCALAPPDATA: 'local', APPDATA: 'roaming' }), path.join('local', 'dev.scranton.desktop'));
  assert.deepEqual(resolveWhisper({ platform: 'linux' }), { reason: 'unsupported_platform' });
  const missing = createVoice({ ...options, engine: () => ({ reason: 'engine_missing' }) });
  assert.deepEqual(await missing.status(), { available: false, reason: 'engine_missing', engine: { installed: false, version: null }, models: [{ id: pin.id, label: pin.label, bytes: pin.bytes, installed: false }], model: pin.id, language: 'auto' });
  await assert.rejects(missing.transcribe(wav()), { status: 503, message: 'engine_unavailable' });
  await install();
  assert.deepEqual(await voice.setSettings({ language: 'en' }), { available: true, engine: { installed: true, version: 'fixture' }, models: [{ id: pin.id, label: pin.label, bytes: pin.bytes, installed: true }], model: pin.id, language: 'en' });
  const reopened = createVoice(options);
  assert.deepEqual(await reopened.transcribe(wav()), { text: 'Private transcript.', language: 'en', durationMs: 100, model: pin.id });
});

test('a corrupt same-size model is never used; a verified atomic download repairs it', async t => {
  let download = Buffer.alloc(pin.bytes);
  const { voice, install, modelFile, modelDir } = await voiceFixture(t, { fetchModel: async () => new Response(download) });
  await install();
  assert.equal((await voice.status()).models[0].installed, true);
  await install(download);
  await assert.rejects(voice.transcribe(wav()), { status: 409, message: 'model_missing' });
  voice.download(pin.id);
  await until(async () => !(await voice.status()).models[0].download);
  assert.deepEqual(await fs.readFile(modelFile), download);
  assert.equal((await voice.status()).models[0].installed, false);
  assert.deepEqual(await fs.readdir(modelDir), [path.basename(modelFile)]);
  download = modelBytes;
  voice.download(pin.id);
  await until(async () => (await voice.status()).models[0].installed);
  await voice.remove(pin.id);
  assert.equal((await voice.status()).models[0].installed, false);
});

test('cancel removes a partial download and exposes byte progress', async t => {
  let cancelled = false;
  const { voice, modelDir } = await voiceFixture(t, { fetchModel: async (_url, { signal }) => {
    signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(modelBytes.subarray(0, 4)); } }));
  } });
  voice.download(pin.id);
  await until(async () => (await voice.status()).models[0].download?.received === 4);
  assert.deepEqual((await voice.status()).models[0].download, { received: 4, total: pin.bytes });
  await voice.remove(pin.id);
  assert.ok(cancelled);
  assert.equal((await voice.status()).models[0].download, undefined);
  assert.deepEqual(await fs.readdir(modelDir), []);
});

test('one transcription at a time; cleans up WAV and output on success and failure', async t => {
  const { voice, options, install, localData, script } = await voiceFixture(t);
  const tmp = path.join(localData, 'voice-temp');
  await install();
  const first = voice.transcribe(wav(), { language: 'de' });
  await assert.rejects(voice.transcribe(wav()), { status: 429, message: 'busy' });
  assert.deepEqual(await first, { text: 'Private transcript.', language: 'de', durationMs: 100, model: pin.id });
  assert.deepEqual(await fs.readdir(tmp), []);
  const broken = createVoice({ ...options, engine: () => ({ executable: process.execPath, prefix: [script, '--fail'] }) });
  await assert.rejects(broken.transcribe(wav()), { status: 503, message: 'engine_unavailable' });
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('closing voice kills an active helper and waits for recording cleanup', async t => {
  const { options, install, localData, script } = await voiceFixture(t);
  const tmp = path.join(localData, 'voice-temp');
  await install();
  const hanging = createVoice({ ...options, engine: () => ({ executable: process.execPath, prefix: [script, '--hang'] }) });
  t.after(() => hanging.close());
  const pending = assert.rejects(hanging.transcribe(wav()), { status: 503 });
  await until(async () => (await fs.readdir(tmp).catch(() => [])).length > 0);
  await hanging.close();
  await pending;
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('model sweeps remove stale partials at initialization and before the matching download', async t => {
  const { options, modelDir } = await voiceFixture(t, {
    fetchModel: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(modelBytes.subarray(0, 4)); } })),
  });
  await fs.mkdir(modelDir);
  const stale = path.join(modelDir, `ggml-${pin.id}.bin.interrupted.part`);
  const unrelated = path.join(modelDir, 'keep.bin');
  await fs.writeFile(stale, 'partial');
  await fs.writeFile(unrelated, 'keep');
  const reopened = createVoice(options);
  try {
    assert.deepEqual(await fs.readdir(modelDir), ['keep.bin']);
    await fs.writeFile(stale, 'another interrupted download');
    reopened.download(pin.id);
    let active;
    await until(async () => {
      active = (await fs.readdir(modelDir)).find(name => name.endsWith('.part') && name !== path.basename(stale));
      return active && (await fs.stat(path.join(modelDir, active))).size === 4;
    });
    assert.deepEqual((await fs.readdir(modelDir)).sort(), [active, 'keep.bin']);
    const observer = createVoice({ ...options, fetchModel: async () => { throw new Error('Offline fixture'); } });
    try {
      observer.download(pin.id);
      await until(async () => !(await observer.status()).models[0].download);
      assert.deepEqual(await fs.readFile(path.join(modelDir, active)), modelBytes.subarray(0, 4));
    } finally { await observer.close(); }
  } finally { await reopened.close(); }
  assert.deepEqual(await fs.readdir(modelDir), ['keep.bin']);
});

test('recording sweep deletes stale WAVs but keeps a running transcription', async t => {
  const { options, install, localData, script } = await voiceFixture(t);
  const tmp = path.join(localData, 'voice-temp');
  await install();
  const hanging = createVoice({ ...options, engine: () => ({ executable: process.execPath, prefix: [script, '--hang'] }) });
  const pending = assert.rejects(hanging.transcribe(wav()), { status: 503 });
  try {
    let active;
    await until(async () => {
      [active] = await fs.readdir(tmp).catch(() => []);
      return active && (await fs.stat(path.join(tmp, active, 'audio.wav')).catch(() => null))?.size === wav().length;
    });
    const stale = path.join(tmp, 'recording-interrupted');
    await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, 'audio.wav'), wav());
    const reopened = createVoice(options);
    await reopened.close();
    assert.deepEqual(await fs.readdir(tmp), [active]);
    assert.deepEqual(await fs.readFile(path.join(tmp, active, 'audio.wav')), wav());
  } finally {
    await hanging.close();
    await pending;
  }
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('voice sweeps do not traverse linked roots, root ancestors, or recording entries', async t => {
  const { options, localData, modelDir } = await voiceFixture(t);
  const tmp = path.join(localData, 'voice-temp');
  const outside = path.join(localData, 'outside');
  const outsideCache = path.join(outside, 'cache');
  const outsideRecording = path.join(outsideCache, 'recording-external');
  const outsidePart = path.join(outsideCache, 'preserve.part');
  const outsideAudio = path.join(outsideRecording, 'audio.wav');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.mkdir(outsideRecording, { recursive: true });
  await fs.writeFile(outsidePart, 'preserve');
  await fs.writeFile(outsideAudio, 'private outside fixture');
  await fs.symlink(outsideCache, modelDir, type);
  await fs.symlink(outsideCache, tmp, type);
  await createVoice(options).close();
  const alias = path.join(localData, 'alias');
  await fs.symlink(outside, alias, type);
  await createVoice({ ...options, modelDirectory: path.join(alias, 'cache'), temporaryRoot: path.join(alias, 'cache') }).close();
  assert.equal(await fs.readFile(outsidePart, 'utf8'), 'preserve');
  assert.equal(await fs.readFile(outsideAudio, 'utf8'), 'private outside fixture');

  await fs.unlink(modelDir);
  await fs.unlink(tmp);
  await fs.mkdir(modelDir);
  const stale = path.join(tmp, 'recording-stale');
  await fs.mkdir(stale, { recursive: true });
  await fs.writeFile(path.join(stale, 'audio.wav'), wav());
  const recordingLink = path.join(tmp, 'recording-link');
  const modelLink = path.join(modelDir, 'recording-link.part');
  await fs.symlink(outsideRecording, recordingLink, type);
  await fs.symlink(outsideRecording, modelLink, type);
  await fs.symlink(outsideRecording, path.join(stale, 'nested-link'), type);
  if (process.platform !== 'win32') await fs.symlink(outsidePart, path.join(modelDir, 'file-link.part'));
  await createVoice(options).close();
  await assert.rejects(fs.lstat(stale), { code: 'ENOENT' });
  assert.ok((await fs.lstat(recordingLink)).isSymbolicLink());
  assert.ok((await fs.lstat(modelLink)).isSymbolicLink());
  if (process.platform !== 'win32') assert.ok((await fs.lstat(path.join(modelDir, 'file-link.part'))).isSymbolicLink());
  assert.equal(await fs.readFile(outsidePart, 'utf8'), 'preserve');
  assert.equal(await fs.readFile(outsideAudio, 'utf8'), 'private outside fixture');
});

test('startup sweeps respect another process until its artifact owner exits', async t => {
  const { options, localData, modelDir } = await voiceFixture(t);
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = once(owner, 'exit');
  try {
    await once(owner, 'spawn');
    const partial = path.join(modelDir, `ggml-${pin.id}.bin.${owner.pid}-12345678-1234-1234-1234-123456789abc.part`);
    const recording = path.join(localData, `voice-temp/recording-${owner.pid}-Abc123`);
    const audio = path.join(recording, 'audio.wav');
    await fs.mkdir(modelDir);
    await fs.mkdir(recording, { recursive: true });
    await fs.writeFile(partial, 'in progress');
    await fs.writeFile(audio, wav());
    await createVoice(options).close();
    assert.equal(await fs.readFile(partial, 'utf8'), 'in progress');
    assert.deepEqual(await fs.readFile(audio), wav());
    owner.kill('SIGKILL');
    await exited;
    await createVoice(options).close();
    await assert.rejects(fs.lstat(partial), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(recording), { code: 'ENOENT' });
  } finally {
    owner.kill('SIGKILL');
    await exited.catch(() => {});
  }
});
