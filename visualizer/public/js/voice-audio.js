// Microphone capture for dictation (.enma/voice-contract.md §5): getUserMedia, a level for the meters, and the
// recording as a 16 kHz mono PCM16 WAV. The AudioWorklet (voice-worklet.js) resamples while it records; a window
// without one records with MediaRecorder and resamples the decoded audio in an OfflineAudioContext. The tracks are
// stopped on every way out. env: the browser globals, so Node can test it with fakes.
import { AUDIO_CONSTRAINTS } from './voice.js';
import { VOICE_RATE, createResampler, encodeWav, levelOf, toPcm16 } from './voice-pcm.js';

export const WORKLET_URL = new URL('./voice-worklet.js', import.meta.url).href;
const LEVEL_MS = 50;
const FLUSH_MS = 1500;

const failure = (code) => Object.assign(new Error(code), { code });

// -> the decoded audio as 16 kHz mono samples
export async function resampleOffline(buffer, env = globalThis) {
  const length = Math.max(1, Math.ceil(buffer.duration * VOICE_RATE));
  const Offline = env.OfflineAudioContext ?? env.webkitOfflineAudioContext;
  if (typeof Offline === 'function') {
    const off = new Offline(1, length, VOICE_RATE);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }
  const r = createResampler(buffer.sampleRate, VOICE_RATE);
  const head = r.push(buffer.getChannelData(0));
  const rest = r.flush();
  const out = new Float32Array(head.length + rest.length);
  out.set(head);
  out.set(rest, head.length);
  return out;
}

// The meter's source on a stream: an AnalyserNode read every 50 ms. -> { ctx, source, sink, stop() }
function meter(env, stream, onLevel) {
  const Ctx = env.AudioContext ?? env.webkitAudioContext;
  if (typeof Ctx !== 'function') throw failure('unsupported');
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // a silent sink keeps the graph pulled without playing the microphone back
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(ctx.destination);
  const block = new Float32Array(analyser.fftSize);
  const timer = env.setInterval(() => {
    analyser.getFloatTimeDomainData(block);
    onLevel(levelOf(block));
  }, LEVEL_MS);
  return {
    ctx, source, sink,
    stop() {
      env.clearInterval(timer);
      try { source.disconnect(); } catch { /* already gone */ }
      return Promise.resolve(ctx.close?.()).catch(() => {});
    },
  };
}

async function open(env) {
  const media = env.navigator?.mediaDevices;
  if (typeof media?.getUserMedia !== 'function') throw failure('unsupported');
  return media.getUserMedia(AUDIO_CONSTRAINTS);
}

const release = (stream) => { for (const t of stream?.getTracks?.() ?? []) t.stop(); };

// Level only, for the microphone test: nothing is recorded or sent. -> { stop() }
export async function startLevelTest({ env = globalThis, onLevel = () => {} } = {}) {
  const stream = await open(env);
  let m;
  try {
    m = meter(env, stream, onLevel);
  } catch (err) {
    release(stream);
    throw err;
  }
  let done = false;
  return {
    stop() {
      if (done) return;
      done = true;
      release(stream);
      onLevel(0);
      m.stop();
    },
  };
}

// -> { stop() -> Promise<Uint8Array WAV>, cancel() }. onEnd(code): the microphone went away on its own.
export async function startCapture({ env = globalThis, workletUrl = WORKLET_URL, onLevel = () => {}, onEnd = () => {} } = {}) {
  const stream = await open(env);
  let m = null;
  let finished = false;
  const close = () => {
    if (finished) return;
    finished = true;
    release(stream);
    onLevel(0);
    m?.stop();
  };
  try {
    m = meter(env, stream, onLevel);
    for (const t of stream.getTracks?.() ?? []) t.addEventListener?.('ended', () => { if (!finished) onEnd('no_mic'); });
    const recorder = await (useWorklet(env, stream, m, workletUrl) ?? useRecorder(env, stream, m));
    return {
      async stop() {
        try {
          return await recorder.finish();
        } finally {
          close();
        }
      },
      cancel() {
        recorder.drop();
        close();
      },
    };
  } catch (err) {
    close();
    throw err;
  }
}

// null when this window has no AudioWorklet, else the promise of a recorder (falling back if the module fails)
function useWorklet(env, stream, m, url) {
  if (!m.ctx.audioWorklet || typeof env.AudioWorkletNode !== 'function') return null;
  return m.ctx.audioWorklet.addModule(url).then(() => {
    const node = new env.AudioWorkletNode(m.ctx, 'scranton-voice', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const chunks = [];
    let done = null;
    node.port.onmessage = (event) => {
      if (event.data?.pcm) chunks.push(event.data.pcm);
      if (event.data?.done) done?.();
    };
    m.source.connect(node);
    node.connect(m.sink);
    const detach = () => { try { node.disconnect(); } catch { /* already gone */ } node.port.onmessage = null; };
    return {
      finish: () => new Promise((resolve) => {
        const timer = env.setTimeout(() => done?.(), FLUSH_MS);
        done = () => {
          done = null;
          env.clearTimeout(timer);
          detach();
          resolve(encodeWav(chunks));
        };
        node.port.postMessage('flush');
      }),
      drop: detach,
    };
  }, () => null).then((r) => r ?? useRecorder(env, stream, m));
}

function useRecorder(env, stream, m) {
  const Recorder = env.MediaRecorder;
  if (typeof Recorder !== 'function') throw failure('unsupported');
  const rec = new Recorder(stream);
  const parts = [];
  rec.addEventListener('dataavailable', (event) => { if (event.data?.size) parts.push(event.data); });
  rec.start(1000);
  return {
    finish: () => new Promise((resolve, reject) => {
      rec.addEventListener('stop', async () => {
        try {
          const bytes = await new env.Blob(parts).arrayBuffer();
          const decoded = await m.ctx.decodeAudioData(bytes);
          resolve(encodeWav(toPcm16(await resampleOffline(decoded, env))));
        } catch {
          reject(failure('bad_audio'));
        }
      }, { once: true });
      rec.stop();
    }),
    drop: () => { if (rec.state !== 'inactive') rec.stop(); },
  };
}
