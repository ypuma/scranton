export const MAX_WAV_BYTES = 10 * 1024 * 1024;
export const voiceError = (status, message) => Object.assign(new Error(message), { status });

export function validateWav(wav) {
  const invalid = () => voiceError(415, 'invalid_audio');
  if (Buffer.isBuffer(wav) && wav.length > MAX_WAV_BYTES) throw voiceError(413, 'body_too_large');
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('latin1', 0, 4) !== 'RIFF' ||
      wav.toString('latin1', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) !== wav.length - 8) throw invalid();
  let format, pcm;
  for (let i = 12; i < wav.length;) {
    if (i + 8 > wav.length) throw invalid();
    const size = wav.readUInt32LE(i + 4), end = i + 8 + size;
    const next = end + (size % 2);
    if (next > wav.length) throw invalid();
    const chunk = wav.subarray(i + 8, end);
    switch (wav.toString('latin1', i, i + 4)) {
      case 'fmt ':
        if (format || pcm || size < 16 || chunk.readUInt16LE(0) !== 1 || chunk.readUInt16LE(2) !== 1 ||
            chunk.readUInt32LE(4) !== 16000 || chunk.readUInt32LE(8) !== 32000 ||
            chunk.readUInt16LE(12) !== 2 || chunk.readUInt16LE(14) !== 16) throw invalid();
        format = chunk.subarray(0, 16);
        break;
      case 'data':
        if (!format || pcm || !size || size % 2) throw invalid();
        pcm = chunk;
        break;
    }
    i = next;
  }
  if (!pcm) throw invalid();
  // Only the canonical PCM header and samples cross into the native decoder.
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); format.copy(header, 20);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([header, pcm]), durationMs: Math.round(pcm.length / 32) };
}
