// Voice dictation for every free-text field (.enma/voice-contract.md §1): a mic control in each element marked
// data-dictate="<textarea id>", the status of the local speech engine they share, and the one dictation that can
// run at a time. Click starts and stops, Escape cancels, the text goes in at the cursor and nothing is sent.
// Settings (voice-panel.js) reads and changes the same status through the object this returns.
import {
  POLL_MS, MAX_RECORD_MS, MIN_RECORD_MS, MAX_UPLOAD, ERRORS, parseVoiceStatus, voiceApi, micView, insertText, parseTranscript, transcribeError,
  captureError, chosenModel, downloadingModel, ready, offerText, modelHint, refusalText,
} from './voice.js';
import { startCapture } from './voice-audio.js';
import { VOICE_RATE, WAV_HEADER } from './voice-pcm.js';

const MIN_WAV_BYTES = WAV_HEADER + Math.round((MIN_RECORD_MS / 1000) * VOICE_RATE) * 2;

const SVG_NS = 'http://www.w3.org/2000/svg';
const BARS = 6;
const NOTE_MS = 6000;
const TICK_MS = 250;
// a download the server accepted shows up in status within these many polls, or it never started
const DOWNLOAD_WAIT = 10;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function micIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 2.25a2 2 0 0 0-2 2v3.5a2 2 0 0 0 4 0v-3.5a2 2 0 0 0-2-2zM4.25 7.5a3.75 3.75 0 0 0 7.5 0M8 11.25v2.5M5.75 13.75h4.5');
  for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.2'], ['stroke-linecap', 'round']]) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

// fills of a segmented meter for a level of 0..1
export function meterFill(bars, level) {
  const lit = Math.round(Math.max(0, Math.min(1, level || 0)) * bars.length);
  bars.forEach((b, i) => { b.dataset.fill = i < lit ? 'full' : ''; });
}

// audio: { startCapture } (voice-audio.js); timers are injectable so tests can drive the clock.
export function createDictation({
  fetcher = (...a) => globalThis.fetch(...a), audio = { startCapture }, root = globalThis.document, now = () => Date.now(),
  poll = POLL_MS, maxMs = MAX_RECORD_MS, noteMs = NOTE_MS, timers = globalThis,
} = {}) {
  const api = voiceApi(fetcher);
  let status = null;
  let loaded = false;
  let session = null;
  let level = 0;
  let pollTimer = null;
  // a download the server accepted that status does not show yet: { id, polls }
  let expected = null;
  const stopped = new Set();
  const controls = new Map();
  const notes = new Map();
  const listeners = new Set();
  let asking = null;

  function setNote(target, note, { fade = false } = {}) {
    const old = notes.get(target);
    if (old?.timer) timers.clearTimeout(old.timer);
    if (!note) notes.delete(target);
    else {
      const n = { ...note };
      if (fade) n.timer = timers.setTimeout(() => { if (notes.get(target) === n) { notes.delete(target); renderTarget(target); } }, noteMs);
      notes.set(target, n);
    }
    // the other controls follow too: a dictation that ends frees them
    renderAll();
  }
  const fail = (target, key) => setNote(target, { text: ERRORS[key] ?? ERRORS.failed, tone: 'error' });

  // ------------------------------------------------------------ status
  function follow() {
    const want = Boolean(downloadingModel(status) || expected);
    if (want && !pollTimer) pollTimer = timers.setInterval(() => { refresh(); }, poll);
    if (!want && pollTimer) {
      timers.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function take(next) {
    const prev = status;
    status = next;
    if (expected) {
      const m = next?.models.find((x) => x.id === expected.id);
      expected.polls += 1;
      if (!m || m.download || m.installed || expected.polls > DOWNLOAD_WAIT) expected = null;
    }
    // what came of a download: said where it was asked for
    const was = downloadingModel(prev);
    if (was && !next?.models.find((m) => m.id === was.id)?.download) {
      const done = next?.models.find((m) => m.id === was.id)?.installed;
      const cancelled = stopped.delete(was.id);
      for (const [target, n] of notes) {
        if (n.kind !== 'download') continue;
        setNote(target, done ? { text: 'Speech model ready. Press the microphone to dictate.' }
          : cancelled ? { text: 'Download cancelled.' } : { text: 'The download stopped before it finished.', tone: 'error' }, { fade: done || cancelled });
      }
    }
    follow();
    renderAll();
    for (const fn of listeners) fn(status, prev);
  }

  // GET status; no answer keeps what is known, any other failure means no dictation here
  function refresh() {
    if (asking) return asking;
    asking = api.status().then((r) => {
      asking = null;
      loaded = true;
      if (r.ok) take(parseVoiceStatus(r.data));
      else if (r.status !== 0 || !status) take(null);
      else renderAll();
      return status;
    });
    return asking;
  }

  // -> { ok, error? } for the Settings panel
  async function settings(change) {
    const r = await api.settings(change);
    if (r.ok && parseVoiceStatus(r.data)) {
      take(parseVoiceStatus(r.data));
      return { ok: true };
    }
    if (r.ok) await refresh();
    return r.ok ? { ok: true } : { ok: false, error: refusalText(r, 'The setting was not saved') };
  }

  async function download(id) {
    stopped.delete(id);
    const r = await api.download(id);
    if (!r.ok) return { ok: false, error: refusalText(r, 'The download did not start') };
    expected = { id, polls: 0 };
    follow();
    await refresh();
    return { ok: true };
  }

  // cancels a running download or removes the model
  async function remove(id) {
    const cancelling = Boolean(status?.models.find((m) => m.id === id)?.download);
    if (cancelling) stopped.add(id);
    const r = await api.remove(id);
    if (!r.ok) {
      stopped.delete(id);
      return { ok: false, error: refusalText(r, cancelling ? 'The download was not cancelled' : 'The model was not deleted') };
    }
    await refresh();
    return { ok: true };
  }

  // ------------------------------------------------------------ the controls
  function build(host) {
    const target = host.dataset.dictate;
    const btn = el('button', 'icon-btn dictate-mic');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Dictate');
    btn.setAttribute('aria-controls', target);
    btn.append(micIcon());
    const live = el('span', 'dictate-live');
    live.hidden = true;
    const meter = el('span', 'dictate-meter');
    meter.setAttribute('aria-hidden', 'true');
    const bars = Array.from({ length: BARS }, () => el('i'));
    meter.append(...bars);
    const time = el('span', 'dictate-time');
    live.append(meter, time);
    const note = el('span', 'form-status dictate-note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    const offer = el('button', 'link-btn dictate-offer');
    offer.type = 'button';
    offer.hidden = true;
    const cancel = el('button', 'link-btn dictate-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.hidden = true;
    host.replaceChildren(btn, live, note, offer, cancel);
    host.dataset.ready = 'true';
    const c = { host, target, btn, live, bars, time, note, offer, cancel };
    btn.addEventListener('click', () => toggle(target));
    offer.addEventListener('click', () => offerDownload(target));
    cancel.addEventListener('click', () => {
      if (session?.target === target) return stop(session, { cancelled: true });
      const dl = downloadingModel(status);
      if (dl) remove(dl.id).then((r) => { if (!r.ok) setNote(target, { text: r.error, tone: 'error' }); });
    });
    controls.set(host, c);
    render(c);
    return c;
  }

  function render(c) {
    const v = micView(status, session, c.target, notes.get(c.target), now());
    const phase = session?.target === c.target ? session.phase : 'idle';
    c.host.hidden = v.hidden;
    c.host.dataset.state = phase;
    c.btn.setAttribute('aria-pressed', String(v.pressed));
    c.btn.setAttribute('aria-label', v.label);
    c.btn.setAttribute('aria-disabled', String(v.disabled));
    c.btn.title = v.title;
    c.live.hidden = !v.live;
    c.time.textContent = v.time;
    meterFill(c.bars, v.live ? level : 0);
    c.note.textContent = v.text;
    c.note.title = v.text;
    c.note.dataset.tone = v.tone;
    c.offer.hidden = !v.offer;
    c.offer.textContent = v.offer ? offerText(v.offer) : '';
    // the note beside it is cut to one line, so what the model means goes in the tooltip
    c.offer.title = v.offer ? modelHint(v.offer.id) : '';
    c.cancel.hidden = !v.cancel;
    c.cancel.textContent = phase === 'idle' ? 'Cancel download' : 'Cancel';
  }

  function renderTarget(target) {
    for (const c of controls.values()) if (c.target === target) render(c);
  }

  function renderAll() {
    for (const [host, c] of controls) {
      if (host.isConnected === false) controls.delete(host);
      else render(c);
    }
  }

  // every marked host on the page that has no control yet
  function mount() {
    for (const host of root?.querySelectorAll?.('[data-dictate]') ?? []) if (!controls.has(host)) build(host);
    renderAll();
  }

  // ------------------------------------------------------------ one dictation
  async function offerDownload(target) {
    const m = chosenModel(status);
    if (!m) return;
    setNote(target, { kind: 'download' });
    const r = await download(m.id);
    if (!r.ok) setNote(target, { text: r.error, tone: 'error' });
  }

  function toggle(target) {
    if (session?.target === target) {
      if (session.phase === 'recording') stop(session);
      return;
    }
    if (session) return;
    if (!ready(status)) return setNote(target, { kind: 'download' });
    start(target);
  }

  async function start(target) {
    setNote(target, null);
    const s = { target, phase: 'starting', startedAt: now(), capture: null, abort: null, tick: null, limit: null };
    session = s;
    level = 0;
    renderAll();
    let capture;
    try {
      capture = await audio.startCapture({
        onLevel: (v) => {
          if (session !== s) return;
          level = v;
          for (const c of controls.values()) if (c.target === target) meterFill(c.bars, v);
        },
        onEnd: () => { if (session === s && s.phase === 'recording') stop(s); },
      });
    } catch (err) {
      if (session !== s) return;
      session = null;
      return fail(target, captureError(err));
    }
    if (session !== s) {
      capture.cancel();
      return;
    }
    s.capture = capture;
    s.phase = 'recording';
    s.startedAt = now();
    s.tick = timers.setInterval(() => renderTarget(target), TICK_MS);
    s.limit = timers.setTimeout(() => stop(s, { limit: true }), maxMs);
    renderAll();
  }

  function clearTimers(s) {
    timers.clearInterval(s.tick);
    timers.clearTimeout(s.limit);
    s.tick = null;
    s.limit = null;
  }

  async function stop(s, { cancelled = false, limit = false } = {}) {
    if (session !== s) return;
    clearTimers(s);
    level = 0;
    if (cancelled) {
      session = null;
      s.capture?.cancel();
      s.abort?.abort();
      return setNote(s.target, { text: 'Dictation cancelled.' }, { fade: true });
    }
    if (s.phase !== 'recording') return;
    const short = now() - s.startedAt < MIN_RECORD_MS;
    s.phase = 'transcribing';
    s.abort = new AbortController();
    renderTarget(s.target);
    let wav;
    try {
      wav = await s.capture.stop();
    } catch (err) {
      if (session !== s) return;
      session = null;
      // a recorder stopped at once has nothing to decode
      if (short) return setNote(s.target, { text: ERRORS.too_short }, { fade: true });
      return fail(s.target, captureError(err) === 'unsupported' ? 'bad_audio' : captureError(err));
    }
    if (session !== s) return;
    // stop() has let go of the microphone; too little audio is not worth the server's 415
    if (wav.length < MIN_WAV_BYTES) {
      session = null;
      return setNote(s.target, { text: ERRORS.too_short }, { fade: true });
    }
    if (wav.length > MAX_UPLOAD) {
      session = null;
      return fail(s.target, 'too_long');
    }
    const r = await api.transcribe(wav, status?.language, s.abort.signal);
    if (session !== s) return;
    session = null;
    if (!r.ok) {
      const key = transcribeError(r.status, r.data);
      if (key === 'model_missing' || key === 'engine_unavailable') refresh();
      if (key === 'model_missing') return setNote(s.target, { kind: 'download' });
      return fail(s.target, key);
    }
    const t = parseTranscript(r.data);
    if (!t) return fail(s.target, 'failed');
    if (!t.text) return setNote(s.target, { text: ERRORS.empty }, { fade: true });
    put(s.target, t.text, limit);
  }

  // the transcript as the field's value, at its cursor; the person reviews it and sends
  function put(target, text, limit) {
    const field = root?.getElementById?.(target);
    if (!field || field.disabled || field.readOnly) return setNote(target, { text: 'The field is closed, so the text was not inserted.', tone: 'error' });
    const before = String(field.value ?? '');
    const max = Number.isInteger(field.maxLength) && field.maxLength >= 0 ? field.maxLength : Infinity;
    const next = insertText(before, field.selectionStart, field.selectionEnd, text, max);
    if (!next) return setNote(target, { text: 'The field is full, so the text was not inserted.', tone: 'error' });
    field.value = next.value;
    field.setSelectionRange?.(next.caret, next.caret);
    field.dispatchEvent?.(new Event('input', { bubbles: true }));
    const active = root.activeElement;
    const ours = [...controls.values()].some((c) => c.host.contains?.(active) || c.btn === active);
    if (!active || active === root.body || ours) field.focus?.();
    const cut = next.value.length - before.length < text.length;
    const said = cut ? 'Only part of the text fit into the field.' : limit ? 'Stopped at 5 minutes. Review the text, then send.' : 'Text inserted. Review it, then send.';
    setNote(target, { text: said, tone: cut ? 'error' : '' }, { fade: !cut });
  }

  // Escape cancels whatever dictation runs, before the field or a dialog takes the key
  root?.addEventListener?.('keydown', (ev) => {
    if (ev.key !== 'Escape' || !session) return;
    ev.preventDefault();
    ev.stopPropagation?.();
    stop(session, { cancelled: true });
  }, true);

  if (typeof globalThis.MutationObserver === 'function' && root?.body) {
    let queued = false;
    new globalThis.MutationObserver((records) => {
      if (queued) return;
      const added = records.some((r) => [...r.addedNodes].some((n) => n.nodeType === 1 && (n.dataset?.dictate || n.querySelector?.('[data-dictate]'))));
      if (!added) return;
      queued = true;
      queueMicrotask(() => { queued = false; mount(); });
    }).observe(root.body, { childList: true, subtree: true });
  }

  mount();
  refresh();
  return {
    status: () => status, loaded: () => loaded, session: () => session,
    refresh, settings, download, remove, mount,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    toggle, cancel: () => (session ? stop(session, { cancelled: true }) : undefined),
  };
}
