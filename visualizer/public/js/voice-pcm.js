// Audio for dictation as the server takes it (.enma/voice-contract.md §3, §5): 16 kHz mono PCM16 in a WAV. No
// imports and no DOM, so the AudioWorklet, the OfflineAudioContext fallback and Node all use the same code.
export const VOICE_RATE = 16000;
export const WAV_HEADER = 44;

// A streaming resampler: push() takes Float32 chunks at `from` Hz and returns what is ready at `to` Hz. Going down,
// each output sample is the mean of the input it covers, a crude low-pass against aliasing; going up, linear.
export function createResampler(from, to = VOICE_RATE) {
  const ratio = from / to;
  let tail = new Float32Array(0);
  let pos = 0;
  let taken = 0;
  let given = 0;
  function push(chunk) {
    const input = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk ?? []);
    taken += input.length;
    const buf = new Float32Array(tail.length + input.length);
    buf.set(tail);
    buf.set(input, tail.length);
    const out = [];
    if (ratio >= 1) {
      while (pos + ratio <= buf.length) {
        const s = Math.floor(pos);
        const e = Math.max(s + 1, Math.floor(pos + ratio));
        let sum = 0;
        for (let i = s; i < e; i += 1) sum += buf[i];
        out.push(sum / (e - s));
        pos += ratio;
      }
    } else {
      while (pos + 1 < buf.length) {
        const i = Math.floor(pos);
        const f = pos - i;
        out.push(buf[i] * (1 - f) + buf[i + 1] * f);
        pos += ratio;
      }
    }
    const used = Math.min(Math.floor(pos), buf.length);
    tail = buf.slice(used);
    pos -= used;
    given += out.length;
    return Float32Array.from(out);
  }
  // the last samples, so that n input samples give round(n * to / from) in all
  function flush() {
    const want = Math.round((taken * to) / from) - given;
    if (want <= 0 || tail.length === 0) return new Float32Array(0);
    const out = new Float32Array(want).fill(tail[tail.length - 1]);
    for (let k = 0; k < want; k += 1) out[k] = tail[Math.min(tail.length - 1, Math.floor(pos + k * ratio))];
    given += want;
    tail = new Float32Array(0);
    return out;
  }
  return { push, flush, ratio };
}

export function toPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

// pcm: Int16Array or a list of them, in order -> the bytes of a RIFF/WAVE file, PCM format 1
export function encodeWav(pcm, rate = VOICE_RATE) {
  const parts = Array.isArray(pcm) ? pcm : [pcm];
  const samples = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(WAV_HEADER + samples * 2);
  const v = new DataView(bytes.buffer);
  const tag = (at, s) => { for (let i = 0; i < 4; i += 1) bytes[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples * 2, true);
  let at = WAV_HEADER;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 1, at += 2) v.setInt16(at, p[i], true);
  }
  return bytes;
}

// RMS of a block -> 0..1 on a rough loudness scale (-60 dBFS is 0), for the level meters
export function levelOf(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
}
