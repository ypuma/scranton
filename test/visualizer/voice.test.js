// Voice dictation in the visualizer (.enma/voice-contract.md §1, §3, §5): the WAV the server takes, resampling in
// the worklet and the offline fallback, the capture that lets go of the microphone, the mic control on every text
// field (states, errors, Escape, the 5-minute stop, text at the cursor and never sent), the routes it calls, and
// Settings -> Voice with a mocked API. A transcript is plain text from the server to the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_RATE, WAV_HEADER, createResampler, encodeWav, toPcm16, levelOf } from '../../visualizer/public/js/voice-pcm.js';
import {
  AUDIO_CONSTRAINTS, ERRORS, MAX_RECORD_MS, MIN_RECORD_MS, parseVoiceStatus, insertText, micView, captureError, transcribeError, parseTranscript,
  stateText, reasonText, offerText, sizeText, modelHint, settingsBody, transcribeUrl, modelUrl,
} from '../../visualizer/public/js/voice.js';
import { startCapture, startLevelTest, resampleOffline, WORKLET_URL } from '../../visualizer/public/js/voice-audio.js';
import { createDictation } from '../../visualizer/public/js/dictation.js';
import { createVoiceSettings } from '../../visualizer/public/js/voice-panel.js';
import { installDom, FakeEl } from './fixtures/fake-dom.js';

const PUBLIC = new URL('../../visualizer/public/', import.meta.url);
const html = readFileSync(new URL('index.html', PUBLIC), 'utf8');
const MB = 1024 * 1024;
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r)); };
const SCRIPT = '<script>alert(1)</script> & <img src=x onerror=alert(2)>';

// the sizes pinned in voice-models.lock.json
const FAST = { id: 'small-q5_1', label: 'Fast (small)', bytes: 190_085_487, installed: false };
const PRECISE = { id: 'large-v3-turbo-q5_0', label: 'Precise (large-v3-turbo)', bytes: 574_041_195, installed: true };
const FAST_HINT = 'Fast - default. About 4 s for 10 s of speech on the test machine.';
const PRECISE_HINT = 'More precise, about 3x slower (about 11 s for 10 s of speech).';
const status = (fields = {}) => ({ available: true, engine: { installed: true, version: '1.8.2' }, models: [FAST, PRECISE], model: PRECISE.id, language: 'auto', ...fields });
const missing = (fields = {}) => status({ models: [FAST, { ...PRECISE, installed: false }], ...fields });
const UNSUPPORTED = { available: false, reason: 'unsupported_platform', engine: { installed: false, version: null }, models: [], model: null, language: 'auto' };

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const ascii = (b, at) => String.fromCharCode(...b.slice(at, at + 4));

// Timers the test fires by hand: run(ms) calls every timer of that delay; now is the clock micView reads.
function fakeTimers() {
  let id = 0;
  const all = new Map();
  const clock = {
    now: 1_000_000,
    setTimeout: (fn, ms) => { all.set(++id, { fn, ms, repeat: false }); return id; },
    setInterval: (fn, ms) => { all.set(++id, { fn, ms, repeat: true }); return id; },
    clearTimeout: (i) => all.delete(i),
    clearInterval: (i) => all.delete(i),
    pending: (ms) => [...all.values()].filter((t) => t.ms === ms).length,
    run(ms) {
      for (const [k, t] of [...all]) {
        if (t.ms !== ms) continue;
        if (!t.repeat) all.delete(k);
        t.fn();
      }
    },
  };
  return clock;
}

// The voice routes. answer(call) may return a Response for a call it wants to decide; status() is the document.
function fakeServer(doc, answer = () => null) {
  const calls = [];
  const state = { doc };
  const fetcher = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers, body: init.body, credentials: init.credentials, signal: init.signal };
    calls.push(call);
    const custom = await answer(call, state);
    if (custom) return custom;
    if (url === '/api/voice/status') return typeof state.doc === 'number' ? new Response('', { status: state.doc }) : Response.json(state.doc);
    if (url === '/api/voice/settings') {
      state.doc = { ...state.doc, ...JSON.parse(init.body) };
      return Response.json(state.doc);
    }
    if (url.startsWith('/api/voice/models/')) return new Response(null, { status: call.method === 'DELETE' ? 204 : 202 });
    if (url.startsWith('/api/voice/transcribe')) return Response.json({ text: 'login bug', language: 'en', durationMs: 1200, model: PRECISE.id });
    return new Response('', { status: 404 });
  };
  return { fetcher, calls, state, voiceCalls: (path) => calls.filter((c) => c.url.startsWith(path)) };
}

// A capture as voice-audio.js hands it out; level() and end() play the microphone.
function fakeAudio({ fail = null, stopFail = null, wav = encodeWav(new Int16Array(VOICE_RATE)) } = {}) {
  const log = [];
  let opts = null;
  return {
    log,
    level: (v) => opts.onLevel(v),
    end: () => opts.onEnd('no_mic'),
    startCapture: async (o) => {
      opts = o;
      log.push('start');
      if (fail) throw fail;
      return { stop: async () => { log.push('stop'); if (stopFail) throw stopFail; return wav; }, cancel: () => log.push('cancel') };
    },
  };
}

function textField(t, value = '') {
  Object.assign(t, { value, selectionStart: value.length, selectionEnd: value.length, maxLength: -1, events: [], submitted: 0 });
  t.setSelectionRange = (a, b) => { t.selectionStart = a; t.selectionEnd = b; };
  t.dispatchEvent = (ev) => { t.events.push([ev.type, ev.bubbles]); t.fire(ev.type, ev); };
  t.form = { requestSubmit: () => { t.submitted += 1; } };
  t.addEventListener('submit', () => { t.submitted += 1; });
  return t;
}

const TARGETS = ['f-request', 'followup-text', 'chat-view-input', 'hitl-text'];

async function page({ doc = status(), answer, audio = fakeAudio(), targets = TARGETS } = {}) {
  const $ = installDom();
  const hosts = targets.map((id) => {
    const h = $(`mic-${id}`);
    h.dataset.dictate = id;
    h.hidden = true;
    textField($(id));
    return h;
  });
  const keys = [];
  document.querySelectorAll = (sel) => (sel === '[data-dictate]' ? hosts : []);
  document.addEventListener = (type, fn, capture) => keys.push({ type, fn, capture });
  const server = fakeServer(doc, answer);
  const clock = fakeTimers();
  const voice = createDictation({ fetcher: server.fetcher, audio, timers: clock, now: () => clock.now });
  await settle();
  const parts = (id) => {
    const [btn, live, note, offer, cancel] = hosts[targets.indexOf(id)].childNodes;
    const [meter, time] = live.childNodes;
    return { host: hosts[targets.indexOf(id)], btn, live, note, offer, cancel, bars: meter.childNodes, time };
  };
  const escape = () => {
    const ev = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const k of keys) if (k.type === 'keydown') k.fn(ev);
    return ev;
  };
  return { $, voice, server, clock, audio, parts, escape, keys };
}

// ------------------------------------------------------------ WAV and resampling
test('WAV: a RIFF header of 16 kHz mono PCM16 with the sizes of its data, samples little-endian', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
  const b = encodeWav(pcm);
  assert.equal(b.length, WAV_HEADER + pcm.length * 2);
  assert.deepEqual([ascii(b, 0), ascii(b, 8), ascii(b, 12), ascii(b, 36)], ['RIFF', 'WAVE', 'fmt ', 'data']);
  assert.equal(u32(b, 4), 36 + pcm.length * 2, 'RIFF size');
  assert.equal(u32(b, 16), 16, 'fmt chunk size');
  assert.equal(u16(b, 20), 1, 'PCM');
  assert.equal(u16(b, 22), 1, 'mono');
  assert.equal(u32(b, 24), 16000, 'sample rate');
  assert.equal(u32(b, 28), 32000, 'byte rate');
  assert.equal(u16(b, 32), 2, 'block align');
  assert.equal(u16(b, 34), 16, 'bits per sample');
  assert.equal(u32(b, 40), pcm.length * 2, 'data size');
  const back = new Int16Array(b.buffer.slice(WAV_HEADER));
  assert.deepEqual([...back], [...pcm]);
  // chunks in order are one stream
  assert.deepEqual(encodeWav([pcm.subarray(0, 2), pcm.subarray(2)]), b);
  assert.deepEqual([...toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5, NaN]))], [0, 32767, -32768, 32767, -32768, 16384, 0]);
  // five minutes fit the 10 MB the server takes
  assert.ok(WAV_HEADER + (MAX_RECORD_MS / 1000) * VOICE_RATE * 2 <= 10 * MB);
});

test('resampling: n samples give round(n * 16000 / rate), streamed in any chunks, and keep the signal', () => {
  for (const rate of [48000, 44100, 32000, 22050, 16000, 8000]) {
    const n = rate * 2 + 37;
    const r = createResampler(rate);
    let got = 0;
    for (let at = 0; at < n; at += 128) got += r.push(new Float32Array(Math.min(128, n - at)).fill(0.5)).length;
    got += r.flush().length;
    assert.equal(got, Math.round((n * 16000) / rate), `${rate} Hz`);
  }
  // the same at once and in blocks of the audio thread
  const sine = Float32Array.from({ length: 48000 }, (_, i) => 0.8 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const whole = createResampler(48000);
  const a = [...whole.push(sine), ...whole.flush()];
  const blocks = createResampler(48000);
  const b = [];
  for (let at = 0; at < sine.length; at += 128) b.push(...blocks.push(sine.subarray(at, at + 128)));
  b.push(...blocks.flush());
  assert.equal(a.length, 16000);
  assert.deepEqual(b.map((x) => x.toFixed(6)), a.map((x) => x.toFixed(6)));
  const peak = Math.max(...a.map(Math.abs));
  assert.ok(peak > 0.7 && peak <= 0.8, `440 Hz survives at 16 kHz (peak ${peak})`);
  const same = createResampler(16000);
  assert.deepEqual([...same.push(Float32Array.from([0.1, 0.2, 0.3]))].map((x) => x.toFixed(3)), ['0.100', '0.200', '0.300']);
  assert.equal(levelOf(new Float32Array(10)), 0);
  assert.equal(levelOf(new Float32Array(10).fill(1)), 1);
});

test('worklet: 1 s at 48 kHz in render quanta is 16000 PCM16 samples in chunks, then done on flush', async () => {
  const saved = { p: globalThis.AudioWorkletProcessor, r: globalThis.registerProcessor, s: globalThis.sampleRate };
  let registered = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { posted: [], postMessage(m, transfer) { this.posted.push([m, transfer]); }, onmessage: null }; } };
  globalThis.registerProcessor = (name, cls) => { registered = [name, cls]; };
  globalThis.sampleRate = 48000;
  try {
    await import('../../visualizer/public/js/voice-worklet.js');
    assert.equal(registered[0], 'scranton-voice');
    const p = new registered[1]();
    for (let i = 0; i < 375; i += 1) assert.equal(p.process([[new Float32Array(128).fill(0.25)]]), true);
    assert.ok(p.port.posted.length >= 9, 'a chunk about every 100 ms');
    p.port.onmessage({ data: 'flush' });
    const msgs = p.port.posted.map(([m]) => m);
    assert.deepEqual(msgs.at(-1), { done: true });
    const total = msgs.filter((m) => m.pcm).reduce((n, m) => n + m.pcm.length, 0);
    assert.equal(total, 16000);
    assert.ok(msgs.filter((m) => m.pcm).every((m) => m.pcm instanceof Int16Array && m.pcm[0] === 8192));
    assert.ok(p.port.posted.filter(([m]) => m.pcm).every(([m, t]) => t[0] === m.pcm.buffer), 'the buffers are transferred');
    assert.equal(p.process([[new Float32Array(128)]]), false, 'done after the flush');
  } finally {
    Object.assign(globalThis, { AudioWorkletProcessor: saved.p, registerProcessor: saved.r, sampleRate: saved.s });
  }
});

// ------------------------------------------------------------ capture
function fakeEnv({ worklet = true, recorder = true, offline = true, deny = null } = {}) {
  const log = [];
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; }, addEventListener() {} }, { stopped: 0, stop() { this.stopped += 1; }, addEventListener() {} }];
  const stream = { getTracks: () => tracks };
  class Node { connect(n) { log.push(['connect', this.kind, n?.kind ?? 'destination']); } disconnect() {} }
  const node = (kind, extra = {}) => Object.assign(new Node(), { kind }, extra);
  const contexts = [];
  class Ctx {
    constructor() {
      this.destination = { kind: 'destination' };
      this.closed = false;
      if (worklet) this.audioWorklet = { addModule: async (url) => { log.push(['addModule', url]); } };
      contexts.push(this);
    }
    createMediaStreamSource(s) { return node('source', { mediaStream: s }); }
    createAnalyser() { return node('analyser', { fftSize: 0, getFloatTimeDomainData: (b) => b.fill(0.1) }); }
    createGain() { return node('sink', { gain: { value: 1 } }); }
    async decodeAudioData() { return { duration: 0.5, sampleRate: 48000, getChannelData: () => new Float32Array(24000).fill(0.25) }; }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class WorkletNode extends Node {
    constructor(ctx, name, opts) {
      super();
      this.kind = 'worklet';
      log.push(['node', name, opts]);
      this.port = {
        onmessage: null,
        postMessage: (m) => {
          if (m !== 'flush') return;
          queueMicrotask(() => {
            this.port.onmessage?.({ data: { pcm: new Int16Array(1600).fill(7) } });
            this.port.onmessage?.({ data: { done: true } });
          });
        },
      };
    }
  }
  class Recorder {
    constructor(s) { this.stream = s; this.state = 'inactive'; this.on = {}; log.push(['recorder']); }
    addEventListener(t, fn) { this.on[t] = fn; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.on.dataavailable?.({ data: new Blob(['abc']) }); queueMicrotask(() => this.on.stop?.()); }
  }
  class Offline {
    constructor(ch, len, rate) { log.push(['offline', ch, len, rate]); this.len = len; this.destination = {}; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => new Float32Array(this.len).fill(0.25) }; }
  }
  const env = {
    navigator: { mediaDevices: { getUserMedia: async (c) => { log.push(['getUserMedia', c]); if (deny) throw deny; return stream; } } },
    AudioContext: Ctx, AudioWorkletNode: worklet ? WorkletNode : undefined, MediaRecorder: recorder ? Recorder : undefined,
    OfflineAudioContext: offline ? Offline : undefined, Blob, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  return { env, log, tracks, contexts };
}

test('capture: the constraints of §5, the worklet as its own module, a WAV on stop and the tracks let go', async () => {
  assert.deepEqual(AUDIO_CONSTRAINTS, { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const f = fakeEnv();
  const levels = [];
  const c = await startCapture({ env: f.env, onLevel: (v) => levels.push(v) });
  assert.deepEqual(f.log[0], ['getUserMedia', AUDIO_CONSTRAINTS]);
  assert.deepEqual(f.log.find(([k]) => k === 'addModule'), ['addModule', WORKLET_URL]);
  assert.match(WORKLET_URL, /\/js\/voice-worklet\.js$/);
  assert.deepEqual(f.log.find(([k]) => k === 'node'), ['node', 'scranton-voice', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }]);
  assert.ok(f.log.some(([k, from, to]) => k === 'connect' && from === 'sink' && to === 'destination'));
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(levels.some((v) => v > 0.6 && v < 0.7), 'the meter reads the analyser');
  assert.deepEqual(f.tracks.map((t) => t.stopped), [0, 0], 'the microphone stays open while recording');
  const wav = await c.stop();
  assert.equal(ascii(wav, 0), 'RIFF');
  assert.equal(u32(wav, 40), 3200, 'the PCM the worklet sent');
  assert.deepEqual(f.tracks.map((t) => t.stopped), [1, 1], 'stop releases every track');
  assert.equal(f.contexts[0].closed, true);
  assert.equal(levels.at(-1), 0);

  const g = fakeEnv();
  const d = await startCapture({ env: g.env });
  d.cancel();
  assert.deepEqual(g.tracks.map((t) => t.stopped), [1, 1], 'cancel releases every track');
  assert.equal(g.contexts[0].closed, true);

  const denied = fakeEnv({ deny: Object.assign(new Error('no'), { name: 'NotAllowedError' }) });
  await assert.rejects(startCapture({ env: denied.env }), (err) => captureError(err) === 'denied');
  await assert.rejects(startCapture({ env: { navigator: {} } }), (err) => captureError(err) === 'unsupported');
});

test('capture fallback: without an AudioWorklet MediaRecorder records and an OfflineAudioContext resamples to 16 kHz', async () => {
  const f = fakeEnv({ worklet: false });
  const c = await startCapture({ env: f.env });
  assert.ok(f.log.some(([k]) => k === 'recorder'));
  const wav = await c.stop();
  assert.deepEqual(f.log.find(([k]) => k === 'offline'), ['offline', 1, 8000, 16000], '0.5 s at 16 kHz mono');
  assert.equal(u32(wav, 24), 16000);
  assert.equal(u32(wav, 40), 16000, '8000 samples of 2 bytes');
  assert.deepEqual(f.tracks.map((t) => t.stopped), [1, 1]);

  // no OfflineAudioContext either: the JS resampler gives the same length
  const decoded = { duration: 0.5, sampleRate: 44100, getChannelData: () => new Float32Array(22050).fill(0.1) };
  assert.equal((await resampleOffline(decoded, {})).length, 8000);

  // a worklet module that does not load falls back too
  const g = fakeEnv();
  g.env.AudioContext = class extends g.env.AudioContext { constructor() { super(); this.audioWorklet = { addModule: async () => { throw new Error('CSP'); } }; } };
  const d = await startCapture({ env: g.env });
  assert.ok(g.log.some(([k]) => k === 'recorder'));
  d.cancel();
  assert.deepEqual(g.tracks.map((t) => t.stopped), [1, 1]);

  const none = fakeEnv({ worklet: false, recorder: false });
  await assert.rejects(startCapture({ env: none.env }), (err) => err.code === 'unsupported');
  assert.deepEqual(none.tracks.map((t) => t.stopped), [1, 1], 'a failed setup lets the microphone go');
});

test('level test: only the meter, and stop releases the microphone', async () => {
  const f = fakeEnv();
  const levels = [];
  const t = await startLevelTest({ env: f.env, onLevel: (v) => levels.push(v) });
  assert.equal(f.log.some(([k]) => k === 'addModule' || k === 'recorder'), false, 'nothing records');
  t.stop();
  t.stop();
  assert.deepEqual(f.tracks.map((x) => x.stopped), [1, 1]);
});

// ------------------------------------------------------------ pure logic
test('status: read tolerantly; the state line and the reasons', () => {
  const s = parseVoiceStatus(status({ models: [...status().models, { id: '../x', label: 'bad' }, { id: 'y', label: '\u202Eevil', bytes: -1, download: { received: 5, total: 10 } }], language: 'fr', model: 'nope' }));
  assert.deepEqual(s.models.map((m) => m.id), ['small-q5_1', 'large-v3-turbo-q5_0', 'y']);
  assert.deepEqual(s.models[2], { id: 'y', label: 'evil', bytes: null, installed: false, download: { received: 5, total: 10 } });
  assert.deepEqual([s.language, s.model], ['auto', null]);
  for (const bad of [null, [], {}, { available: 'yes' }]) assert.equal(parseVoiceStatus(bad), null);
  assert.equal(stateText(parseVoiceStatus(status())).text, 'Ready: dictation runs offline with Precise (large-v3-turbo).');
  assert.equal(stateText(parseVoiceStatus(missing())).text, 'Download a speech model to dictate. Precise (large-v3-turbo) is selected.');
  assert.equal(stateText(parseVoiceStatus(UNSUPPORTED)).text, reasonText('unsupported_platform'));
  assert.match(reasonText('unsupported_platform'), /Windows only/);
  assert.match(reasonText('engine_missing'), /not part of this installation/);
  assert.equal(stateText(null, { loaded: false }).tone, 'busy');
  assert.equal(offerText({ bytes: PRECISE.bytes }), 'Download speech model (574 MB)');
  assert.deepEqual(settingsBody({ model: 'small-q5_1', language: 'de', extra: 1 }), { model: 'small-q5_1', language: 'de' });
  assert.equal(settingsBody({ language: 'fr' }), null);
  assert.equal(transcribeUrl('xx'), '/api/voice/transcribe?language=auto');
  assert.equal(modelUrl('a/b'), '/api/voice/models/a%2Fb/download');
});

test('errors: every failure has its plain sentence', () => {
  const named = (name) => captureError(Object.assign(new Error(name), { name }));
  assert.deepEqual(['NotAllowedError', 'SecurityError', 'NotFoundError', 'OverconstrainedError', 'NotReadableError', 'TypeError'].map(named),
    ['denied', 'denied', 'no_mic', 'no_mic', 'mic_unreadable', 'unsupported']);
  assert.deepEqual([409, 413, 415, 429, 503, 0, 500].map((s) => transcribeError(s, {})), ['model_missing', 'too_long', 'bad_audio', 'busy', 'engine_unavailable', 'offline', 'failed']);
  assert.equal(transcribeError(400, { error: 'busy' }), 'busy', 'a known code fills a gap');
  assert.deepEqual([ERRORS.denied, ERRORS.no_mic, ERRORS.model_missing, ERRORS.too_long, ERRORS.busy, ERRORS.engine_unavailable], [
    'Microphone access is blocked. Allow it for Scranton and try again.',
    'No microphone was found.',
    'No speech model is installed.',
    'The recording is too long to transcribe. Keep it under 5 minutes.',
    'Another transcription is running. Try again in a moment.',
    'The speech engine is not available.',
  ]);
});

test('insertText: at the cursor or over the selection, a space where a word would touch, never past maxlength', () => {
  assert.deepEqual(insertText('', 0, 0, ' hello '), { value: 'hello', caret: 5 });
  assert.deepEqual(insertText('Fix the', 7, 7, 'login bug'), { value: 'Fix the login bug', caret: 17 });
  assert.deepEqual(insertText('Fix the ', 8, 8, 'bug'), { value: 'Fix the bug', caret: 11 });
  assert.deepEqual(insertText('ab', 1, 1, 'X'), { value: 'a X b', caret: 3 }, 'the caret stays before the added space');
  assert.deepEqual(insertText('one TWO three', 4, 7, 'two'), { value: 'one two three', caret: 7 });
  assert.deepEqual(insertText('text', undefined, undefined, 'more'), { value: 'text more', caret: 9 }, 'no cursor: appended');
  assert.deepEqual(insertText('abc', 3, 3, 'defgh', 6), { value: 'abc de', caret: 6 });
  assert.equal(insertText('abc', 3, 3, 'x', 3), null, 'full');
  assert.equal(insertText('abc', 3, 3, '   '), null, 'nothing heard');
  assert.equal(insertText('', 0, 0, SCRIPT).value, SCRIPT, 'markup stays text');
  assert.equal(parseTranscript({ text: `\u202E${SCRIPT}\u0000\n` }).text, SCRIPT);
  assert.equal(parseTranscript({ text: 3 }), null);
});

test('micView: hidden without an engine; idle, recording, transcribing and the download offer', () => {
  const s = parseVoiceStatus(status());
  assert.equal(micView(null, null, 'a').hidden, true);
  assert.equal(micView(parseVoiceStatus(UNSUPPORTED), null, 'a').hidden, true);
  assert.deepEqual(micView(s, null, 'a'), {
    hidden: false, pressed: false, disabled: false, label: 'Dictate', title: 'Dictate with the microphone', live: false, time: '', text: '', tone: '', offer: null, cancel: false,
  });
  const rec = micView(s, { target: 'a', phase: 'recording', startedAt: 0 }, 'a', null, 75_000);
  assert.deepEqual([rec.pressed, rec.label, rec.live, rec.time, rec.text, rec.cancel], [true, 'Stop dictation and transcribe', true, '1:15', 'Recording', true]);
  assert.equal(micView(s, { target: 'a', phase: 'recording', startedAt: 0 }, 'b').disabled, true, 'one dictation at a time');
  assert.deepEqual([micView(s, { target: 'a', phase: 'transcribing' }, 'a').text, micView(s, { target: 'a', phase: 'transcribing' }, 'a').disabled], ['Transcribing…', true]);
  const offer = micView(parseVoiceStatus(missing()), null, 'a', { kind: 'download' });
  assert.deepEqual([offer.text, offer.offer.id], ['No speech model is installed.', PRECISE.id]);
  const going = micView(parseVoiceStatus(missing({ models: [FAST, { ...PRECISE, installed: false, download: { received: Math.ceil(PRECISE.bytes / 4), total: PRECISE.bytes } }] })), null, 'a', { kind: 'download' });
  assert.deepEqual([going.text, going.cancel, going.offer], ['Downloading speech model: 25%', true, null]);
});

test('sizes are decimal as in README and DESKTOP.md; each pinned model says what it is for', () => {
  assert.deepEqual([sizeText(FAST.bytes), sizeText(PRECISE.bytes)], ['190 MB', '574 MB']);
  assert.deepEqual([sizeText(999_499), sizeText(1_000_000), sizeText(400), sizeText(0), sizeText(null)], ['999 KB', '1 MB', '1 KB', '', '']);
  assert.deepEqual([modelHint(FAST.id), modelHint(PRECISE.id)], [FAST_HINT, PRECISE_HINT]);
  assert.deepEqual([modelHint('other'), modelHint('constructor'), modelHint(undefined)], ['', '', '']);
});

// ------------------------------------------------------------ the mic control
test('mic: record, stop, "Transcribing…", the text at the cursor; nothing is sent', async () => {
  let release;
  const p = await page({
    doc: status({ language: 'de' }),
    answer: (call) => (call.url.startsWith('/api/voice/transcribe') ? new Promise((r) => { release = () => r(Response.json({ text: 'login bug', language: 'de', durationMs: 900, model: PRECISE.id })); }) : null),
  });
  const ta = p.$('followup-text');
  textField(ta, 'Fix the');
  const m = p.parts('followup-text');
  for (const id of TARGETS) assert.equal(p.parts(id).host.hidden, false, `${id} has a mic`);
  assert.deepEqual([m.btn.getAttribute('aria-label'), m.btn.getAttribute('aria-pressed'), m.btn.getAttribute('aria-controls'), m.btn.type], ['Dictate', 'false', 'followup-text', 'button']);
  assert.deepEqual(p.server.calls[0], { url: '/api/voice/status', method: 'GET', headers: { 'X-Scranton-Client': '1' }, body: undefined, credentials: 'same-origin', signal: p.server.calls[0].signal });

  await m.btn.fire('click');
  await settle();
  assert.deepEqual(p.audio.log, ['start']);
  assert.deepEqual([m.btn.getAttribute('aria-pressed'), m.btn.getAttribute('aria-label'), m.live.hidden, m.note.textContent, m.note.dataset.tone], ['true', 'Stop dictation and transcribe', false, 'Recording', 'busy']);
  assert.equal(p.parts('f-request').btn.getAttribute('aria-disabled'), 'true', 'the other fields wait');
  p.audio.level(0.5);
  assert.deepEqual(m.bars.map((b) => b.dataset.fill), ['full', 'full', 'full', '', '', '']);
  p.clock.now += 12_400;
  p.clock.run(250);
  assert.equal(m.time.textContent, '0:12');

  await m.btn.fire('click');
  await settle();
  assert.deepEqual(p.audio.log, ['start', 'stop']);
  assert.deepEqual([m.note.textContent, m.btn.getAttribute('aria-disabled'), m.live.hidden], ['Transcribing…', 'true', true]);
  const t = p.server.voiceCalls('/api/voice/transcribe')[0];
  assert.deepEqual([t.url, t.method, t.headers, t.credentials], ['/api/voice/transcribe?language=de', 'POST', { 'Content-Type': 'audio/wav', 'X-Scranton-Client': '1' }, 'same-origin']);
  assert.ok(t.body instanceof Uint8Array && ascii(t.body, 0) === 'RIFF' && u32(t.body, 24) === 16000);
  assert.ok(t.signal instanceof AbortSignal);

  release();
  await settle();
  assert.equal(ta.value, 'Fix the login bug');
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [17, 17]);
  assert.deepEqual(ta.events, [['input', true]], 'the field hears an input, as if typed');
  assert.equal(ta.submitted, 0, 'never sent');
  assert.equal(document.activeElement, ta, 'back in the field to review');
  assert.deepEqual([m.note.textContent, m.btn.getAttribute('aria-pressed'), m.btn.getAttribute('aria-disabled')], ['Text inserted. Review it, then send.', 'false', 'false']);
  p.clock.run(6000);
  assert.equal(m.note.textContent, '', 'the note fades');
  assert.equal(p.voice.session(), null);
});

test('mic: the text goes in at the cursor of the field, with spaces as needed', async () => {
  const p = await page();
  const ta = textField(p.$('hitl-text'), 'Please and then stop');
  ta.selectionStart = ta.selectionEnd = 7;
  const m = p.parts('hitl-text');
  await m.btn.fire('click');
  await settle();
  await m.btn.fire('click');
  await settle();
  assert.equal(ta.value, 'Please login bug and then stop');
  assert.equal(ta.selectionStart, 16);
});

test('mic: a transcript with <script> is the field\'s plain text value, nothing else', async () => {
  const p = await page({ answer: (call) => (call.url.startsWith('/api/voice/transcribe') ? Response.json({ text: SCRIPT, language: 'en', durationMs: 1, model: 'x' }) : null) });
  const ta = p.$('f-request');
  const m = p.parts('f-request');
  await m.btn.fire('click');
  await settle();
  await m.btn.fire('click');
  await settle();
  assert.equal(ta.value, SCRIPT);
  assert.deepEqual(ta.childNodes, [], 'no element was made of it');
  assert.equal(m.note.textContent, 'Text inserted. Review it, then send.');
  for (const f of ['dictation.js', 'voice.js', 'voice-panel.js', 'voice-audio.js']) {
    assert.doesNotMatch(readFileSync(new URL(`js/${f}`, PUBLIC), 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML|DOMParser/, f);
  }
});

test('mic: Escape cancels recording or transcribing, before the field or a dialog takes the key', async () => {
  const p = await page();
  const ta = textField(p.$('chat-view-input'), 'keep');
  const m = p.parts('chat-view-input');
  assert.equal(p.keys.find((k) => k.type === 'keydown').capture, true);
  assert.equal(p.escape().prevented, false, 'no dictation, the key is not ours');
  await m.btn.fire('click');
  await settle();
  const ev = p.escape();
  assert.deepEqual([ev.prevented, ev.stopped], [true, true]);
  assert.deepEqual(p.audio.log, ['start', 'cancel']);
  assert.deepEqual([m.note.textContent, m.btn.getAttribute('aria-pressed'), m.live.hidden], ['Dictation cancelled.', 'false', true]);
  assert.equal(p.server.voiceCalls('/api/voice/transcribe').length, 0, 'nothing was sent');
  assert.equal(ta.value, 'keep');
  assert.equal(p.clock.pending(250) + p.clock.pending(MAX_RECORD_MS), 0, 'no timer left');

  // while transcribing: the request is aborted and its late answer changes nothing
  let signal;
  const q = await page({ answer: (call) => (call.url.startsWith('/api/voice/transcribe') ? new Promise((r) => { signal = call.signal; signal.addEventListener('abort', () => r(Response.json({ text: 'late' }))); }) : null) });
  const n = q.parts('f-request');
  await n.btn.fire('click');
  await settle();
  await n.btn.fire('click');
  await settle();
  q.escape();
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(q.$('f-request').value, '');
  assert.equal(n.note.textContent, 'Dictation cancelled.');

  // the Cancel link does the same
  const r = await page();
  const c = r.parts('hitl-text');
  await c.btn.fire('click');
  await settle();
  assert.equal(c.cancel.hidden, false);
  await c.cancel.fire('click');
  assert.deepEqual(r.audio.log, ['start', 'cancel']);
});

test('mic: recording stops by itself at 5 minutes and is transcribed', async () => {
  const p = await page();
  const m = p.parts('f-request');
  await m.btn.fire('click');
  await settle();
  assert.equal(p.clock.pending(MAX_RECORD_MS), 1);
  p.clock.now += MAX_RECORD_MS;
  p.clock.run(MAX_RECORD_MS);
  await settle();
  assert.deepEqual(p.audio.log, ['start', 'stop']);
  assert.equal(p.$('f-request').value, 'login bug');
  assert.equal(m.note.textContent, 'Stopped at 5 minutes. Review the text, then send.');

  // the microphone that goes away ends the recording the same way
  const q = await page();
  await q.parts('f-request').btn.fire('click');
  await settle();
  q.audio.end();
  await settle();
  assert.deepEqual(q.audio.log, ['start', 'stop']);
});

test('mic: a recording under 0.3 s is not sent; "Nothing was heard - try again." and the microphone is let go', async () => {
  const under = Math.round((MIN_RECORD_MS / 1000) * VOICE_RATE) - 1;
  for (const [what, wav] of [['no samples', encodeWav(new Int16Array(0))], ['just under 0.3 s', encodeWav(new Int16Array(under))]]) {
    const p = await page({ audio: fakeAudio({ wav }) });
    const m = p.parts('f-request');
    await m.btn.fire('click');
    await settle();
    await m.btn.fire('click');
    await settle();
    assert.deepEqual(p.audio.log, ['start', 'stop'], what);
    assert.equal(p.server.voiceCalls('/api/voice/transcribe').length, 0, `${what}: the server is not asked`);
    assert.deepEqual([m.note.textContent, m.note.dataset.tone, m.btn.getAttribute('aria-disabled')], ['Nothing was heard - try again.', '', 'false'], what);
    assert.equal(p.voice.session(), null);
    assert.equal(p.$('f-request').value, '');
    p.clock.run(6000);
    assert.equal(m.note.textContent, '', 'the note fades');
  }

  // 0.3 s is enough
  const enough = await page({ audio: fakeAudio({ wav: encodeWav(new Int16Array(under + 1)) }) });
  await enough.parts('f-request').btn.fire('click');
  await settle();
  await enough.parts('f-request').btn.fire('click');
  await settle();
  assert.equal(enough.server.voiceCalls('/api/voice/transcribe').length, 1);
  assert.equal(enough.$('f-request').value, 'login bug');

  // the real capture: its worklet flushes 0.1 s; the tracks are stopped and nothing is sent
  const f = fakeEnv();
  const real = await page({ audio: { startCapture: (o) => startCapture({ ...o, env: f.env }) } });
  const r = real.parts('f-request');
  await r.btn.fire('click');
  await settle();
  assert.deepEqual(f.tracks.map((t) => t.stopped), [0, 0]);
  await r.btn.fire('click');
  await settle();
  assert.deepEqual(f.tracks.map((t) => t.stopped), [1, 1], 'the microphone is released');
  assert.equal(f.contexts[0].closed, true);
  assert.equal(real.server.voiceCalls('/api/voice/transcribe').length, 0);
  assert.equal(r.note.textContent, 'Nothing was heard - try again.');

  // a recorder stopped at once has nothing to decode: the same word, not "could not be read"
  const bad = Object.assign(new Error('bad_audio'), { code: 'bad_audio' });
  const quick = await page({ audio: fakeAudio({ stopFail: bad }) });
  await quick.parts('f-request').btn.fire('click');
  await settle();
  await quick.parts('f-request').btn.fire('click');
  await settle();
  assert.equal(quick.parts('f-request').note.textContent, 'Nothing was heard - try again.');
  const slow = await page({ audio: fakeAudio({ stopFail: bad }) });
  await slow.parts('f-request').btn.fire('click');
  await settle();
  slow.clock.now += 2000;
  await slow.parts('f-request').btn.fire('click');
  await settle();
  assert.deepEqual([slow.parts('f-request').note.textContent, slow.parts('f-request').note.dataset.tone], [ERRORS.bad_audio, 'error']);
});

test('mic errors: permission denied, no microphone, too long, busy, engine unavailable - said plainly', async () => {
  for (const [name, text] of [['NotAllowedError', ERRORS.denied], ['NotFoundError', ERRORS.no_mic], ['NotReadableError', ERRORS.mic_unreadable]]) {
    const p = await page({ audio: fakeAudio({ fail: Object.assign(new Error('x'), { name }) }) });
    const m = p.parts('f-request');
    await m.btn.fire('click');
    await settle();
    assert.deepEqual([m.note.textContent, m.note.dataset.tone, m.note.title], [text, 'error', text], name);
    assert.equal(p.voice.session(), null);
    assert.equal(m.btn.getAttribute('aria-disabled'), 'false', 'it can be tried again');
  }
  for (const [code, text] of [[413, ERRORS.too_long], [429, ERRORS.busy], [415, ERRORS.bad_audio], [500, ERRORS.failed]]) {
    const p = await page({ answer: (call) => (call.url.startsWith('/api/voice/transcribe') ? Response.json({ error: 'x' }, { status: code }) : null) });
    const m = p.parts('followup-text');
    await m.btn.fire('click');
    await settle();
    await m.btn.fire('click');
    await settle();
    assert.deepEqual([m.note.textContent, m.note.dataset.tone], [text, 'error'], String(code));
    assert.equal(p.$('followup-text').value, '');
  }
  // 503: the engine is gone; status is asked again and a status that says so hides the buttons
  const p = await page({
    answer: (call, state) => {
      if (!call.url.startsWith('/api/voice/transcribe')) return null;
      state.doc = { ...UNSUPPORTED, reason: 'engine_unavailable' };
      return Response.json({ error: 'engine_unavailable' }, { status: 503 });
    },
  });
  const m = p.parts('followup-text');
  await m.btn.fire('click');
  await settle();
  await m.btn.fire('click');
  await settle();
  assert.equal(p.server.voiceCalls('/api/voice/status').length, 2);
  assert.equal(m.host.hidden, true);
});

test('mic: no model yet - the button offers the download with its size, progress and cancel', async () => {
  const p = await page({ doc: missing() });
  const m = p.parts('f-request');
  await m.btn.fire('click');
  await settle();
  assert.deepEqual(p.audio.log, [], 'no recording without a model');
  assert.deepEqual([m.note.textContent, m.offer.hidden, m.offer.textContent], ['No speech model is installed.', false, 'Download speech model (574 MB)']);
  assert.equal(m.offer.title, PRECISE_HINT, 'what the model means, without widening the one-line note');

  const total = PRECISE.bytes;
  const step = (received) => { p.server.state.doc = missing({ models: [FAST, { ...PRECISE, installed: false, download: { received, total } }] }); };
  step(0);
  await m.offer.fire('click');
  await settle();
  const dl = p.server.voiceCalls('/api/voice/models/')[0];
  assert.deepEqual([dl.url, dl.method, dl.headers], ['/api/voice/models/large-v3-turbo-q5_0/download', 'POST', { 'X-Scranton-Client': '1' }]);
  assert.deepEqual([m.note.textContent, m.offer.hidden, m.cancel.hidden, m.cancel.textContent], ['Downloading speech model: 0%', true, false, 'Cancel download']);
  assert.equal(p.clock.pending(1000), 1, 'status is asked every second while it downloads');
  step(Math.ceil(total / 2));
  p.clock.run(1000);
  await settle();
  assert.equal(m.note.textContent, 'Downloading speech model: 50%');
  p.server.state.doc = status();
  p.clock.run(1000);
  await settle();
  assert.equal(m.note.textContent, 'Speech model ready. Press the microphone to dictate.');
  assert.equal(p.clock.pending(1000), 0, 'the polling ends with the download');

  // cancel from the mic: DELETE on the same path
  const q = await page({ doc: missing({ models: [FAST, { ...PRECISE, installed: false, download: { received: 10, total } }] }) });
  const n = q.parts('hitl-text');
  await n.btn.fire('click');
  await settle();
  assert.equal(n.note.textContent, 'Downloading speech model: 0%');
  q.server.state.doc = missing();
  await n.cancel.fire('click');
  await settle();
  const del = q.server.voiceCalls('/api/voice/models/')[0];
  assert.deepEqual([del.url, del.method, del.headers], ['/api/voice/models/large-v3-turbo-q5_0/download', 'DELETE', { 'X-Scranton-Client': '1' }]);
  assert.equal(n.note.textContent, 'Download cancelled.');

  // a 409 from transcribe offers the download too
  const r = await page({ answer: (call) => (call.url.startsWith('/api/voice/transcribe') ? Response.json({ error: 'model_missing' }, { status: 409 }) : null) });
  const o = r.parts('f-request');
  r.server.state.doc = missing();
  await o.btn.fire('click');
  await settle();
  await o.btn.fire('click');
  await settle();
  assert.deepEqual([o.note.textContent, o.offer.textContent], ['No speech model is installed.', 'Download speech model (574 MB)']);
});

test('mic: hidden when status says unavailable, when the server has no voice routes, and until status is known', async () => {
  const p = await page({ doc: UNSUPPORTED });
  for (const id of TARGETS) assert.equal(p.parts(id).host.hidden, true, id);
  const old = await page({ doc: 404 });
  for (const id of TARGETS) assert.equal(old.parts(id).host.hidden, true, id);
  // no answer at all keeps what was known
  const r = await page({ answer: (call, state) => (state.fail ? Promise.reject(new TypeError('offline')) : null) });
  r.server.state.fail = true;
  await r.voice.refresh();
  assert.equal(r.parts('f-request').host.hidden, false, 'a lost answer is no reason to hide');
});

// ------------------------------------------------------------ Settings -> Voice
async function settings({ doc = status(), audio, confirm } = {}) {
  const p = await page({ doc, targets: ['f-request'] });
  const segs = ['auto', 'de', 'en'].map((v) => {
    const b = new FakeEl();
    b.dataset.value = v;
    b.classList.add('seg');
    b.closest = () => b;
    return b;
  });
  p.$('prefs-voice-language').querySelectorAll = () => segs;
  const asked = [];
  const panel = createVoiceSettings({ voice: p.voice, audio, timers: p.clock, confirm: confirm ?? ((opts) => { asked.push(opts); }) });
  await settle();
  const rows = () => p.$('prefs-voice-models').childNodes.map((li) => {
    const [label, actions] = li.childNodes;
    const [radio, text] = label.childNodes;
    const [get, progress, stop, del] = actions.childNodes;
    const [meter, pct] = progress.childNodes;
    return { li, radio, name: text.childNodes[0], hint: text.childNodes[2], about: text.childNodes[3], get, progress, stop, del, bars: meter.childNodes, pct };
  });
  return { ...p, segs, asked, panel, rows };
}

test('settings: availability, the language, the models with their sizes; changes POST /api/voice/settings', async () => {
  const s = await settings();
  assert.equal(s.$('prefs-voice-state').textContent, 'Ready: dictation runs offline with Precise (large-v3-turbo).');
  assert.equal(s.$('prefs-voice-app').hidden, false);
  assert.deepEqual(s.segs.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  const [fast, precise] = s.rows();
  assert.deepEqual([fast.name.textContent, fast.hint.textContent, fast.radio.checked, fast.get.hidden, fast.get.textContent, fast.del.hidden],
    ['Fast (small)', '190 MB · not downloaded', false, false, 'Download (190 MB)', true]);
  assert.deepEqual([precise.hint.textContent, precise.radio.checked, precise.get.hidden, precise.del.hidden, precise.progress.hidden],
    ['574 MB · installed', true, true, false, true]);
  assert.deepEqual([fast.about.textContent, fast.about.hidden, fast.about.className], [FAST_HINT, false, 'hint']);
  assert.deepEqual([precise.about.textContent, precise.about.hidden], [PRECISE_HINT, false]);
  assert.equal(fast.radio.name, precise.radio.name);

  await s.$('prefs-voice-language').fire('click', { target: s.segs[1] });
  await settle();
  const lang = s.server.voiceCalls('/api/voice/settings')[0];
  assert.deepEqual([lang.method, lang.headers, JSON.parse(lang.body)], ['POST', { 'Content-Type': 'application/json', 'X-Scranton-Client': '1' }, { language: 'de' }]);
  assert.deepEqual(s.segs.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.equal(s.voice.status().language, 'de', 'the mic buttons use it next');

  fast.radio.checked = true;
  await fast.radio.fire('change');
  await settle();
  assert.deepEqual(JSON.parse(s.server.voiceCalls('/api/voice/settings')[1].body), { model: 'small-q5_1' });
  assert.equal(s.rows()[0].radio.checked, true);
  assert.equal(s.$('prefs-voice-state').textContent, 'Download a speech model to dictate. Fast (small) is selected.');
});

test('settings: download with progress, polled every second, and cancel', async () => {
  const s = await settings();
  const total = FAST.bytes;
  s.server.state.doc = status({ models: [{ ...FAST, download: { received: Math.ceil(total / 4), total } }, PRECISE] });
  await s.rows()[0].get.fire('click');
  await settle();
  assert.deepEqual(s.server.voiceCalls('/api/voice/models/').map((c) => [c.url, c.method]), [['/api/voice/models/small-q5_1/download', 'POST']]);
  let fast = s.rows()[0];
  assert.deepEqual([fast.get.hidden, fast.progress.hidden, fast.stop.hidden, fast.pct.textContent, fast.progress.getAttribute('aria-valuenow'), fast.progress.getAttribute('role')],
    [true, false, false, '25%', '25', 'progressbar']);
  assert.equal(fast.bars.filter((b) => b.dataset.fill === 'full').length, 5);
  assert.equal(s.$('prefs-voice-state').textContent, 'Downloading speech model: 25% (Fast (small))');
  assert.equal(s.$('prefs-voice-state').dataset.tone, 'busy');

  s.server.state.doc = status({ models: [{ ...FAST, download: { received: Math.ceil(total * 0.6), total } }, PRECISE] });
  s.clock.run(1000);
  await settle();
  assert.equal(s.rows()[0].pct.textContent, '60%');

  s.server.state.doc = status();
  await s.rows()[0].stop.fire('click');
  await settle();
  assert.deepEqual(s.server.voiceCalls('/api/voice/models/').at(-1).method, 'DELETE');
  assert.equal(s.$('prefs-voice-action').textContent, 'Download cancelled.');
  fast = s.rows()[0];
  assert.deepEqual([fast.get.hidden, fast.progress.hidden], [false, true]);

  // a download that ends installed says so
  s.server.state.doc = status({ models: [{ ...FAST, download: { received: 1, total } }, PRECISE] });
  await s.rows()[0].get.fire('click');
  await settle();
  s.server.state.doc = status({ models: [{ ...FAST, installed: true }, PRECISE] });
  s.clock.run(1000);
  await settle();
  assert.equal(s.$('prefs-voice-action').textContent, 'Fast (small) is ready. Dictation works offline now.');
  assert.equal(s.clock.pending(1000), 0);
});

test('settings: delete asks first, then DELETE; a refusal is said', async () => {
  const s = await settings();
  await s.rows()[1].del.fire('click');
  assert.equal(s.server.voiceCalls('/api/voice/models/').length, 0, 'nothing before the confirmation');
  assert.deepEqual([s.asked[0].title, s.asked[0].ok], ['Delete Precise (large-v3-turbo)?', 'Delete model']);
  assert.match(s.asked[0].detail, /574 MB/);
  s.server.state.doc = missing();
  const r = await s.asked[0].action();
  await settle();
  assert.deepEqual(s.server.voiceCalls('/api/voice/models/').map((c) => [c.url, c.method]), [['/api/voice/models/large-v3-turbo-q5_0/download', 'DELETE']]);
  assert.equal(r.error, undefined);
  assert.equal(s.rows()[1].get.hidden, false);

  const fail = await page({ doc: status(), targets: [], answer: (call) => (call.method === 'DELETE' ? Response.json({ error: 'model in use' }, { status: 409 }) : null) });
  const out = await fail.voice.remove(PRECISE.id);
  assert.deepEqual(out, { ok: false, error: 'The model was not deleted: model in use' });
});

test('settings: the microphone test shows the level only and sends nothing', async () => {
  let level = null;
  let stops = 0;
  const audio = { startLevelTest: async ({ onLevel }) => { level = onLevel; return { stop: () => { stops += 1; } }; } };
  const s = await settings({ audio });
  const before = s.server.calls.length;
  const meter = s.$('prefs-voice-test-meter').childNodes;
  assert.equal(meter.length, 20);
  await s.$('prefs-voice-test').fire('click');
  await settle();
  assert.deepEqual([s.$('prefs-voice-test').textContent, s.$('prefs-voice-test').getAttribute('aria-pressed')], ['Stop test', 'true']);
  level(1);
  assert.equal(meter.filter((b) => b.dataset.fill === 'full').length, 20);
  level(0.25);
  assert.equal(meter.filter((b) => b.dataset.fill === 'full').length, 5);
  await s.$('prefs-voice-test').fire('click');
  assert.equal(stops, 1);
  assert.equal(meter.filter((b) => b.dataset.fill === 'full').length, 0);
  assert.equal(s.$('prefs-voice-test').textContent, 'Test microphone');
  assert.equal(s.server.calls.length, before, 'no request at all');

  // it lets go by itself, and when Settings closes
  await s.$('prefs-voice-test').fire('click');
  await settle();
  s.clock.run(60_000);
  assert.equal(stops, 2);
  await s.$('prefs-voice-test').fire('click');
  await settle();
  s.panel.stop();
  assert.equal(stops, 3);

  const denied = await settings({ audio: { startLevelTest: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); } } });
  await denied.$('prefs-voice-test').fire('click');
  await settle();
  assert.deepEqual([denied.$('prefs-voice-test-note').textContent, denied.$('prefs-voice-test-note').dataset.tone], [ERRORS.denied, 'error']);
});

test('settings: an unsupported platform says why and offers nothing', async () => {
  const s = await settings({ doc: UNSUPPORTED });
  assert.equal(s.$('prefs-voice-state').textContent, reasonText('unsupported_platform'));
  assert.equal(s.$('prefs-voice-app').hidden, true);
  assert.equal(s.$('prefs-voice-test').disabled, true);
  assert.equal(s.parts('f-request').host.hidden, true);
});

// ------------------------------------------------------------ the page
test('markup: every free-text field of the page has a mic host, hidden until status is known', () => {
  const areas = [...html.matchAll(/<textarea id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(areas.sort(), ['chat-text', 'chat-view-input', 'context-notes', 'create-instruction', 'f-request', 'followup-text', 'hitl-text', 'pf-task', 'prompt-text', 'settings-instruction'].sort());
  for (const id of areas) assert.match(html, new RegExp(`<span class="dictate" data-dictate="${id}" hidden></span>`), id);
  assert.equal([...html.matchAll(/data-dictate="/g)].length, areas.length, 'one host each');
  // the Pipeline plan comment is made by its view
  const view = readFileSync(new URL('js/pipeline-view.js', PUBLIC), 'utf8');
  assert.match(view, /const mic = el\('span', 'dictate'\);\s+mic\.dataset\.dictate = text\.id;\s+mic\.hidden = true;\s+field\.append\(label, text, mic\);/);
  const group = html.match(/<fieldset class="exec" id="prefs-voice" hidden>[\s\S]*?<\/fieldset>/)?.[0];
  assert.ok(group, 'Settings has a Voice group');
  assert.match(group, /<legend>Voice<\/legend>/);
  for (const [v, label] of [['auto', 'Auto'], ['de', 'Deutsch'], ['en', 'English']]) assert.match(group, new RegExp(`data-value="${v}"[^>]*>${label}</button>`));
  assert.match(group, /id="prefs-voice-state" role="status" aria-live="polite"/);
  assert.match(group, /Nothing is recorded or sent\./);
  assert.match(readFileSync(new URL('js/main.js', PUBLIC), 'utf8'), /createSettings\(\{ voice: createDictation\(\)/);
});
