// Pure logic of voice dictation (.enma/voice-contract.md §1, §3): the server's status document, the routes and
// their request shapes, the texts the mic buttons and Settings show, and putting a transcript into a text field.
// A transcript is plain text and only ever becomes a field's value. No DOM, so Node can test it.
import { stripBidi } from './format.js';
import { CLIENT_HEADERS, CONTROL_HEADERS, clip } from './control.js';

export const VOICE_URL = '/api/voice';
export const LANGUAGES = Object.freeze([['auto', 'Auto'], ['de', 'Deutsch'], ['en', 'English']]);
export const LANGUAGE_IDS = LANGUAGES.map(([id]) => id);
export const MAX_RECORD_MS = 5 * 60 * 1000;
export const MAX_UPLOAD = 10 * 1024 * 1024;
// a shorter recording holds no speech; the server would refuse its empty WAV as unreadable
export const MIN_RECORD_MS = 300;
// how often status is asked while a model downloads
export const POLL_MS = 1000;
export const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;
export const AUDIO_CONSTRAINTS = Object.freeze({ audio: Object.freeze({ channelCount: 1, echoCancellation: true, noiseSuppression: true }) });
const LABEL_MAX = 80;
const TEXT_MAX = 300;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const line = (v, max) => (typeof v === 'string' ? clip(stripBidi(v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim(), max) : '');
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// -> the status, or null when the answer is none
export function parseVoiceStatus(doc) {
  const d = obj(doc);
  if (!d || typeof d.available !== 'boolean') return null;
  const engine = obj(d.engine);
  const models = (Array.isArray(d.models) ? d.models : []).map((m) => {
    const o = obj(m);
    if (!o || typeof o.id !== 'string' || !MODEL_ID.test(o.id)) return null;
    const dl = obj(o.download);
    const received = dl ? count(dl.received) : null;
    return {
      id: o.id,
      label: line(o.label, LABEL_MAX) || o.id,
      bytes: count(o.bytes),
      installed: o.installed === true,
      download: received === null ? null : { received, total: count(dl.total) || null },
    };
  }).filter(Boolean);
  const ids = models.map((m) => m.id);
  return {
    available: d.available,
    reason: d.available ? null : line(d.reason, LABEL_MAX) || null,
    engine: { installed: engine?.installed === true, version: line(engine?.version, LABEL_MAX) || null },
    models,
    model: ids.includes(d.model) ? d.model : null,
    language: LANGUAGE_IDS.includes(d.language) ? d.language : 'auto',
  };
}

// decimal units, as README and DESKTOP.md give the model sizes
export function sizeText(bytes) {
  if (!bytes) return '';
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

// what choosing a pinned model means, timed on the test machine (docs/DESKTOP.md)
const MODEL_HINTS = Object.freeze({
  'small-q5_1': 'Fast - default. About 4 s for 10 s of speech on the test machine.',
  'large-v3-turbo-q5_0': 'More precise, about 3x slower (about 11 s for 10 s of speech).',
});
export const modelHint = (id) => (Object.hasOwn(MODEL_HINTS, id) ? MODEL_HINTS[id] : '');

// the model dictation uses: the selected one, else the first installed, else the first on offer
export function chosenModel(s) {
  if (!s?.models.length) return null;
  return s.models.find((m) => m.id === s.model) ?? s.models.find((m) => m.installed) ?? s.models[0];
}
export const downloadingModel = (s) => s?.models.find((m) => m.download) ?? null;
export const ready = (s) => Boolean(s?.available && chosenModel(s)?.installed);

// 0..100, or null while the size is not known
export function percent(download) {
  if (!download?.total) return null;
  return Math.min(100, Math.floor((download.received / download.total) * 100));
}

export function offerText(model) {
  const size = sizeText(model?.bytes);
  return size ? `Download speech model (${size})` : 'Download speech model';
}

export function progressText(model) {
  const p = percent(model?.download);
  if (p !== null) return `Downloading speech model: ${p}%`;
  const got = sizeText(model?.download?.received);
  return got ? `Downloading speech model: ${got}` : 'Downloading speech model';
}

const REASONS = {
  unsupported_platform: 'Dictation runs a local speech engine that exists for Windows only so far. On this system the microphone buttons stay hidden.',
  engine_missing: 'The local speech engine is not part of this installation. Install the desktop app again to get it.',
  engine_unavailable: 'The local speech engine cannot be started on this computer.',
};

export function reasonText(reason) {
  if (!reason) return 'Dictation is not available here.';
  return REASONS[reason] ?? `Dictation is not available here (${reason}).`;
}

// -> { text, tone } for the state line of Settings
export function stateText(s, { loaded = true } = {}) {
  if (!s) return loaded ? { text: 'This dashboard cannot reach the speech engine.', tone: '' } : { text: 'Checking the speech engine', tone: 'busy' };
  if (!s.available) return { text: reasonText(s.reason), tone: '' };
  const dl = downloadingModel(s);
  if (dl) return { text: `${progressText(dl)} (${dl.label})`, tone: 'busy' };
  const m = chosenModel(s);
  if (!m) return { text: 'No speech model is on offer.', tone: '' };
  if (!m.installed) return { text: `Download a speech model to dictate. ${m.label} is selected.`, tone: '' };
  return { text: `Ready: dictation runs offline with ${m.label}.`, tone: '' };
}

// Everything that can stop a dictation, with what the person can do about it.
export const ERRORS = Object.freeze({
  denied: 'Microphone access is blocked. Allow it for Scranton and try again.',
  no_mic: 'No microphone was found.',
  mic_unreadable: 'The microphone could not be started. Another app may be using it.',
  unsupported: 'This window cannot record audio.',
  model_missing: 'No speech model is installed.',
  too_long: 'The recording is too long to transcribe. Keep it under 5 minutes.',
  busy: 'Another transcription is running. Try again in a moment.',
  engine_unavailable: 'The speech engine is not available.',
  bad_audio: 'The recording could not be read.',
  empty: 'Nothing was heard.',
  too_short: 'Nothing was heard - try again.',
  offline: 'The speech engine did not answer.',
  failed: 'The transcription failed.',
});

// a getUserMedia or audio setup failure -> an ERRORS key
export function captureError(err) {
  const name = typeof err?.name === 'string' ? err.name : '';
  if (err?.code && ERRORS[err.code]) return err.code;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_mic';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'mic_unreadable';
  return 'unsupported';
}

// a transcribe answer that is not 2xx -> an ERRORS key; the status decides, the body's code only fills gaps
export function transcribeError(status, body) {
  const code = typeof obj(body)?.code === 'string' ? body.code : typeof obj(body)?.error === 'string' ? body.error : '';
  if (status === 409) return 'model_missing';
  if (status === 413) return 'too_long';
  if (status === 415) return 'bad_audio';
  if (status === 429) return 'busy';
  if (status === 503) return 'engine_unavailable';
  if (status === 0) return 'offline';
  return ERRORS[code] ? code : 'failed';
}

// -> { text, language, durationMs, model } with the text as plain text, or null
export function parseTranscript(doc) {
  const d = obj(doc);
  if (!d || typeof d.text !== 'string') return null;
  const text = stripBidi(d.text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return { text, language: LANGUAGE_IDS.includes(d.language) ? d.language : null, durationMs: count(d.durationMs), model: typeof d.model === 'string' ? d.model : null };
}

// Text into value at [start, end): a space on a side where the neighbour is not one, never past max.
// -> { value, caret } or null when there is nothing to put in.
export function insertText(value, start, end, text, max = Infinity) {
  const v = String(value ?? '');
  const t = String(text ?? '').trim();
  if (!t) return null;
  const s = Number.isInteger(start) ? Math.max(0, Math.min(start, v.length)) : v.length;
  const e = Number.isInteger(end) ? Math.max(s, Math.min(end, v.length)) : s;
  const before = v.slice(0, s);
  const after = v.slice(e);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const room = (Number.isFinite(max) && max >= 0 ? max : Infinity) - before.length - after.length;
  let piece = `${lead}${t}`;
  let tail = trail;
  if (piece.length + tail.length > room) {
    tail = '';
    piece = room > lead.length ? piece.slice(0, room).trimEnd() : '';
  }
  if (!piece.trim()) return null;
  // the caret stays before the added trailing space, where the next dictation or word continues
  return { value: before + piece + tail + after, caret: before.length + piece.length };
}

export function clockText(ms) {
  const secs = Math.max(0, Math.floor((ms ?? 0) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// What a mic control shows. session: the dictation in progress ({ target, phase, startedAt }) or null;
// note: the last word of this control ({ kind, text?, tone? }) or null.
export function micView(status, session, target, note = null, now = Date.now()) {
  const shown = Boolean(status?.available);
  const mine = session?.target === target;
  const phase = mine ? session.phase : 'idle';
  const elsewhere = Boolean(session && !mine);
  const dl = downloadingModel(status);
  const view = {
    hidden: !shown,
    pressed: phase === 'recording',
    disabled: elsewhere || phase === 'starting' || phase === 'transcribing',
    label: phase === 'recording' ? 'Stop dictation and transcribe' : 'Dictate',
    title: phase === 'recording' ? 'Stop and transcribe (Escape cancels)' : elsewhere ? 'Dictation is in use in another field' : 'Dictate with the microphone',
    live: phase === 'recording',
    time: phase === 'recording' ? clockText(now - session.startedAt) : '',
    text: '', tone: '', offer: null, cancel: false,
  };
  if (!shown) return view;
  if (phase === 'starting') return { ...view, text: 'Starting the microphone', tone: 'busy', cancel: true };
  if (phase === 'recording') return { ...view, text: 'Recording', tone: 'busy', cancel: true };
  if (phase === 'transcribing') return { ...view, text: 'Transcribing…', tone: 'busy', cancel: true };
  if (note?.kind === 'download' && dl) return { ...view, text: progressText(dl), tone: 'busy', cancel: true };
  if (note?.kind === 'download' && !ready(status)) return { ...view, text: ERRORS.model_missing, offer: chosenModel(status) };
  if (note?.text) return { ...view, text: note.text, tone: note.tone ?? '' };
  return view;
}

// ------------------------------------------------------------ the routes
export const statusUrl = () => `${VOICE_URL}/status`;
export const settingsUrl = () => `${VOICE_URL}/settings`;
export const modelUrl = (id) => `${VOICE_URL}/models/${encodeURIComponent(id)}/download`;
export const transcribeUrl = (language) => `${VOICE_URL}/transcribe?language=${LANGUAGE_IDS.includes(language) ? language : 'auto'}`;

// { model?, language? } with only the known fields -> the body, or null when nothing is left
export function settingsBody(change) {
  const c = obj(change) ?? {};
  const out = {};
  if (typeof c.model === 'string' && MODEL_ID.test(c.model)) out.model = c.model;
  if (LANGUAGE_IDS.includes(c.language)) out.language = c.language;
  return Object.keys(out).length ? out : null;
}

// The fetch calls of the routes. Every answer is { ok, status, data }; status 0 = no answer.
export function voiceApi(fetcher = (...a) => globalThis.fetch(...a)) {
  async function send(url, init) {
    try {
      const r = await fetcher(url, { credentials: 'same-origin', cache: 'no-store', ...init });
      let data = null;
      try { data = await r.json(); } catch { /* empty or non-JSON body */ }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }
  return {
    status: () => send(statusUrl(), { headers: CLIENT_HEADERS, signal: AbortSignal.timeout(10_000) }),
    settings: (change) => send(settingsUrl(), { method: 'POST', headers: CONTROL_HEADERS, body: JSON.stringify(settingsBody(change) ?? {}) }),
    download: (id) => send(modelUrl(id), { method: 'POST', headers: CLIENT_HEADERS }),
    remove: (id) => send(modelUrl(id), { method: 'DELETE', headers: CLIENT_HEADERS }),
    transcribe: (wav, language, signal) => send(transcribeUrl(language), {
      method: 'POST', headers: { 'Content-Type': 'audio/wav', ...CLIENT_HEADERS }, body: wav,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]) : AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    }),
  };
}

export const refusalText = (r, fallback) => {
  const msg = line(typeof r?.data?.error === 'string' ? r.data.error : '', TEXT_MAX);
  return r?.status === 0 ? `${fallback}: the dashboard server did not answer` : msg ? `${fallback}: ${msg}` : fallback;
};
