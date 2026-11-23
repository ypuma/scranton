import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVoice } from '../../src/core/voice/index.js';

export const scratch = path.resolve(import.meta.dirname, '../../.scratch/voice-engine');
export const modelBytes = Buffer.from('fake model');
export const pin = { id: 'small', label: 'Small', bytes: modelBytes.length, url: 'https://example.invalid/model',
  sha256: createHash('sha256').update(modelBytes).digest('hex') };
export const modelLock = { default: pin.id, models: [pin] };

export function wav(samples = 1600) {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}

export async function voiceFixture(t, overrides = {}) {
  await fs.mkdir(scratch, { recursive: true });
  const localData = await fs.mkdtemp(path.join(scratch, 'test-'));
  const script = path.join(localData, 'whisper.mjs');
  await fs.writeFile(script, `import { existsSync, writeFileSync } from 'node:fs';
    const arg = name => process.argv[process.argv.indexOf(name) + 1];
    if (!existsSync(arg('-m')) || !existsSync(arg('-f'))) process.exit(10);
    if (process.argv.includes('--fail')) { console.error('private text'); process.exit(11); }
    if (process.argv.includes('--hang')) { setInterval(() => {}, 1000); }
    else writeFileSync(arg('-of') + '.json', JSON.stringify({result:{language:arg('-l') === 'auto' ? 'de' : arg('-l')},transcription:[{text:' Private'},{text:' transcript. '}]}));`);
  const options = { localData, modelLock, engine: () => ({ executable: process.execPath, version: 'fixture', prefix: [script] }),
    fetchModel: async () => new Response(modelBytes), ...overrides };
  const modelDir = path.join(localData, 'models');
  const modelFile = path.join(modelDir, `ggml-${pin.id}.bin`);
  const install = async (bytes = modelBytes) => { await fs.mkdir(modelDir, { recursive: true }); await fs.writeFile(modelFile, bytes); };
  const voice = createVoice(options);
  t.after(async () => { await voice.close(); await fs.rm(localData, { recursive: true, force: true }); });
  return { voice, options, localData, script, modelFile, modelDir, install };
}

export async function until(fn) {
  const end = Date.now() + 4000;
  do {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  throw new Error('Timed out waiting for fixture');
}
