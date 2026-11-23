// The dictation recorder on the audio thread: mono input at the context's rate in, 16 kHz PCM16 chunks out through
// the port about every 100 ms. 'flush' sends the rest and then { done: true }. Loaded with audioWorklet.addModule.
import { VOICE_RATE, createResampler, toPcm16 } from './voice-pcm.js';

const CHUNK = VOICE_RATE / 10;

export class VoiceRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = createResampler(sampleRate, VOICE_RATE);
    this.pending = [];
    this.count = 0;
    this.open = true;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush' || !this.open) return;
      this.open = false;
      this.add(this.resampler.flush());
      this.send();
      this.port.postMessage({ done: true });
    };
  }

  add(samples) {
    if (!samples.length) return;
    this.pending.push(samples);
    this.count += samples.length;
  }

  send() {
    if (!this.count) return;
    const all = new Float32Array(this.count);
    let at = 0;
    for (const p of this.pending) {
      all.set(p, at);
      at += p.length;
    }
    this.pending = [];
    this.count = 0;
    const pcm = toPcm16(all);
    this.port.postMessage({ pcm }, [pcm.buffer]);
  }

  process(inputs) {
    if (!this.open) return false;
    // the node is mono by its channelCount, so the browser has mixed the channels down already
    const channel = inputs[0]?.[0];
    if (channel?.length) this.add(this.resampler.push(channel));
    if (this.count >= CHUNK) this.send();
    return true;
  }
}

registerProcessor('scranton-voice', VoiceRecorder);
