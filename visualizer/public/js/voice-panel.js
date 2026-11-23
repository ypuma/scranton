// The Voice group of Settings (.enma/voice-contract.md §1): whether dictation works here and why not, the language,
// the speech models with their sizes, download with progress and cancel, delete, and a microphone test that only
// shows the level. voice: the object createDictation returns; confirm: the shared confirm dialog, if there is one.
import { sizeText, percent, stateText, captureError, modelHint, ERRORS } from './voice.js';
import { startLevelTest } from './voice-audio.js';
import { meterFill } from './dictation.js';

const $ = (id) => document.getElementById(id);
const PROGRESS_BARS = 20;
// the test lets go of the microphone on its own after this long
const TEST_MS = 60_000;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createVoiceSettings({ voice, confirm = null, audio = { startLevelTest }, timers = globalThis } = {}) {
  const e = {
    state: $('prefs-voice-state'), app: $('prefs-voice-app'), language: $('prefs-voice-language'),
    models: $('prefs-voice-models'), action: $('prefs-voice-action'),
    test: $('prefs-voice-test'), testMeter: $('prefs-voice-test-meter'), testNote: $('prefs-voice-test-note'),
  };
  const rows = new Map();
  // downloads cancelled here, so their end reads as cancelled and not as failed
  const cancelling = new Set();
  let pending = false;
  let test = null;
  let testTimer = null;
  const testBars = Array.from({ length: PROGRESS_BARS }, () => el('i'));
  e.testMeter.replaceChildren(...testBars);

  function note(text, tone = '') {
    e.action.textContent = text;
    e.action.dataset.tone = tone;
  }

  function row(m) {
    const li = el('li', 'voice-model');
    const label = el('label', 'check');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'prefs-voice-model';
    radio.value = m.id;
    const text = el('span');
    const name = el('span', 'voice-model-name');
    const hint = el('span', 'hint');
    const about = el('span', 'hint', modelHint(m.id));
    about.hidden = !about.textContent;
    text.append(name, ' ', hint, about);
    label.append(radio, text);
    const actions = el('div', 'voice-model-actions');
    const get = el('button', 'btn btn-small', 'Download');
    get.type = 'button';
    const del = el('button', 'btn btn-small btn-quiet', 'Delete');
    del.type = 'button';
    const progress = el('span', 'voice-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    const bars = Array.from({ length: PROGRESS_BARS }, () => el('i'));
    const meter = el('span', 'voice-meter');
    meter.setAttribute('aria-hidden', 'true');
    meter.append(...bars);
    const pct = el('span', 'voice-progress-text');
    progress.append(meter, pct);
    const stop = el('button', 'btn btn-small', 'Cancel');
    stop.type = 'button';
    actions.append(get, progress, stop, del);
    li.append(label, actions);
    const r = { li, radio, name, hint, get, del, progress, bars, pct, stop, id: m.id };
    radio.addEventListener('change', () => { if (radio.checked) act(() => voice.settings({ model: m.id })); });
    get.addEventListener('click', () => act(() => voice.download(m.id)));
    stop.addEventListener('click', () => act(async () => {
      cancelling.add(m.id);
      const out = await voice.remove(m.id);
      if (!out.ok) cancelling.delete(m.id);
      return out;
    }));
    del.addEventListener('click', () => removeModel(r));
    return r;
  }

  function removeModel(r) {
    const run = async () => {
      const out = await voice.remove(r.id);
      if (out.ok) note(`Deleted ${r.label}.`);
      return out.ok ? { focus: rows.get(r.id)?.get } : { error: out.error };
    };
    if (!confirm) return act(() => voice.remove(r.id), () => `Deleted ${r.label}.`);
    confirm({
      title: `Delete ${r.label}?`,
      detail: `This frees ${r.size || 'its space'} on this computer. Dictation needs a model; downloading it again takes a while.`,
      ok: 'Delete model',
      action: run,
    });
  }

  // one change at a time; the answer re-renders through the shared status
  async function act(fn, done) {
    if (pending) return;
    pending = true;
    note('');
    render();
    const r = await fn();
    pending = false;
    if (!r.ok) note(r.error, 'error');
    else if (done) note(done());
    render();
  }

  function render() {
    const s = voice.status();
    const st = stateText(s, { loaded: voice.loaded() });
    e.state.textContent = st.text;
    e.state.dataset.tone = st.tone;
    e.app.hidden = !s?.available;
    for (const b of e.language.querySelectorAll('.seg')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === (s?.language ?? 'auto')));
      b.disabled = pending || !s;
    }
    const models = s?.models ?? [];
    if (models.map((m) => m.id).join('\n') !== [...rows.keys()].join('\n')) {
      rows.clear();
      for (const m of models) rows.set(m.id, row(m));
      e.models.replaceChildren(...[...rows.values()].map((r) => r.li));
    }
    const active = document.activeElement;
    for (const m of models) {
      const r = rows.get(m.id);
      const had = [r.get, r.stop, r.del].find((b) => b === active);
      r.label = m.label;
      r.size = sizeText(m.bytes);
      r.name.textContent = m.label;
      r.hint.textContent = [r.size, m.download ? 'downloading' : m.installed ? 'installed' : 'not downloaded'].filter(Boolean).join(' · ');
      r.radio.checked = s.model === m.id;
      r.radio.disabled = pending;
      const p = percent(m.download);
      r.get.hidden = Boolean(m.installed || m.download);
      r.get.textContent = r.size ? `Download (${r.size})` : 'Download';
      r.del.hidden = !m.installed || Boolean(m.download);
      r.progress.hidden = !m.download;
      r.stop.hidden = !m.download;
      r.progress.setAttribute('aria-label', `Download of ${m.label}`);
      if (p === null) r.progress.removeAttribute('aria-valuenow');
      else r.progress.setAttribute('aria-valuenow', String(p));
      r.pct.textContent = p === null ? (m.download ? sizeText(m.download.received) : '') : `${p}%`;
      meterFill(r.bars, p === null ? 0 : p / 100);
      for (const b of [r.get, r.stop, r.del]) b.disabled = pending;
      // a button that went away under the keyboard hands focus to the one that took its place
      if (had?.hidden) [r.stop, r.del, r.get].find((b) => !b.hidden)?.focus();
    }
    e.test.disabled = !s?.available;
  }

  // ------------------------------------------------------------ microphone test
  function stopTest() {
    timers.clearTimeout(testTimer);
    testTimer = null;
    const t = test;
    test = null;
    if (t && t !== 'starting') t.stop();
    meterFill(testBars, 0);
    e.test.textContent = 'Test microphone';
    e.test.setAttribute('aria-pressed', 'false');
  }

  async function startTest() {
    test = 'starting';
    e.testNote.textContent = '';
    e.testNote.dataset.tone = '';
    e.test.textContent = 'Stop test';
    e.test.setAttribute('aria-pressed', 'true');
    let t;
    try {
      t = await audio.startLevelTest({ onLevel: (v) => meterFill(testBars, v) });
    } catch (err) {
      if (test !== 'starting') return;
      stopTest();
      e.testNote.textContent = ERRORS[captureError(err)];
      e.testNote.dataset.tone = 'error';
      return;
    }
    if (test !== 'starting') return t.stop();
    test = t;
    e.testNote.textContent = 'Speak: the bar follows your voice. Nothing is recorded.';
    testTimer = timers.setTimeout(stopTest, TEST_MS);
  }

  e.test.addEventListener('click', () => (test ? stopTest() : startTest()));
  e.language.addEventListener('click', (event) => {
    const b = event.target.closest?.('.seg');
    if (b?.dataset.value && b.getAttribute('aria-pressed') !== 'true') act(() => voice.settings({ language: b.dataset.value }));
  });

  voice.subscribe((s, prev) => {
    // what came of a download, said once
    for (const was of prev?.models ?? []) {
      if (!was.download) continue;
      const now = s?.models.find((m) => m.id === was.id);
      if (now?.download) continue;
      if (cancelling.delete(was.id)) note('Download cancelled.');
      else if (now?.installed) note(`${was.label} is ready. Dictation works offline now.`);
      else note(`The download of ${was.label} did not finish.`, 'error');
    }
    if (!s?.available) stopTest();
    render();
  });
  render();

  return { refresh: () => voice.refresh().then(render), stop: stopTest };
}
