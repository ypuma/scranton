import { readFileSync } from 'node:fs';
import path from 'node:path';
import modelLock from '../../../voice-models.lock.json' with { type: 'json' };
import { writeFileAtomicSync } from '../util.js';
import { createModelManager, localVoiceData } from './models.js';
import { resolveWhisper, runWhisper, sweepRecordings } from './whisper.js';
import { validateWav, voiceError } from './wav.js';

const languages = new Set(['auto', 'de', 'en']);
const unavailable = () => voiceError(503, 'engine_unavailable');

export function createVoice(options = {}) {
  const local = options.localData ?? localVoiceData();
  const settingsFile = path.join(options.dataDir ?? local, 'voice.json');
  const lock = options.modelLock ?? modelLock;
  const temporaryRoot = path.resolve(options.temporaryRoot ?? path.join(local, 'voice-temp'));
  sweepRecordings(temporaryRoot);
  const models = createModelManager({ models: lock.models, directory: options.modelDirectory ?? path.join(local, 'models'), fetchModel: options.fetchModel ?? fetch });
  const engine = options.engine ?? (() => resolveWhisper());
  let active, closed = false;

  function settings() {
    let saved;
    try { saved = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch {}
    return {
      model: lock.models.some(pin => pin.id === saved?.model) ? saved.model : lock.default,
      language: languages.has(saved?.language) ? saved.language : 'auto',
    };
  }

  function engineStatus() {
    try { return engine(); } catch { return { reason: 'engine_missing' }; }
  }

  async function status() {
    const { executable, version, reason } = engineStatus();
    return { available: Boolean(executable), ...(executable ? {} : { reason }),
      engine: { installed: Boolean(executable), version: version ?? null }, models: await models.status(), ...settings() };
  }

  return {
    status,
    setSettings(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
          Object.keys(patch).some(key => key !== 'model' && key !== 'language')) throw voiceError(400, 'invalid_settings');
      if ('language' in patch && !languages.has(patch.language)) throw voiceError(400, 'invalid_language');
      if ('model' in patch && !lock.models.some(pin => pin.id === patch.model)) throw voiceError(400, 'unknown_model');
      writeFileAtomicSync(settingsFile, JSON.stringify({ ...settings(), ...patch }, null, 2) + '\n');
      return status();
    },
    download(id) {
      models.lookup(id);
      if (closed || !engineStatus().executable) throw unavailable();
      models.download(id);
    },
    remove: id => models.remove(id),
    async transcribe(input, { language, signal: requestSignal } = {}) {
      if (closed) throw unavailable();
      if (active) throw voiceError(429, 'busy');
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000), ...(requestSignal ? [requestSignal] : [])]);
      const current = settings();
      language ??= current.language;
      if (!languages.has(language)) throw voiceError(400, 'invalid_language');
      const done = (async () => {
        const audio = validateWav(typeof input === 'function' ? await input(signal) : input);
        const launch = engineStatus();
        if (!launch.executable) throw unavailable();
        const model = await models.verifiedFile(current.model);
        if (!model) throw voiceError(409, 'model_missing');
        try {
          const result = await runWhisper({ ...launch, audio: audio.wav, model, language, signal, temporaryRoot });
          return { ...result, durationMs: audio.durationMs, model: current.model };
        } catch { throw unavailable(); }
      })();
      active = { controller, done };
      try { return await done; }
      finally { active = undefined; }
    },
    async close() {
      closed = true;
      active?.controller.abort();
      await Promise.allSettled([active?.done, models.close()]);
    },
  };
}
