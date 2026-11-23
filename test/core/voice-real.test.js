import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createVoice } from '../../src/core/voice/index.js';
import { resolveWhisper, whisperVersion } from '../../src/core/voice/whisper.js';
import { scratch } from './voice-fixture.js';

const models = path.join(scratch, 'models');
const wav = path.join(scratch, 'de.wav');
const model = path.join(models, 'ggml-small-q5_1.bin');
const benchExecutable = path.join(scratch, 'whisper/Release/whisper-cli.exe');
const executable = process.platform === 'win32' && process.arch === 'x64' &&
  (resolveWhisper().executable ?? (existsSync(benchExecutable) ? benchExecutable : null));

test('real pinned Whisper detects and transcribes the synthetic German sample', {
  skip: (!executable || !existsSync(wav) || !existsSync(model)) && 'Requires Windows x64 Whisper and the downloaded benchmark model/audio',
  timeout: 60_000,
}, async t => {
  const localData = await fs.mkdtemp(path.join(scratch, 'real-test-'));
  const voice = createVoice({ localData, modelDirectory: models, engine: () => ({ executable, version: whisperVersion }) });
  t.after(async () => { await voice.close(); await fs.rm(localData, { recursive: true, force: true }); });
  const result = await voice.transcribe(await fs.readFile(wav));
  assert.equal(result.model, 'small-q5_1');
  assert.equal(result.language, 'de');
  assert.equal(result.durationMs, 10000);
  for (const word of ['Guten Morgen', 'Test', 'Fenster', 'Nachricht', 'Wetter', 'Berlin']) assert.match(result.text, new RegExp(word, 'i'));
  assert.deepEqual(await fs.readdir(path.join(localData, 'voice-temp')), []);
});
