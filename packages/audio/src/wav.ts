/**
 * Minimal WAV reader/writer.
 *
 * Used only OUTSIDE the realtime path: recording a fixed utterance for the
 * comparison (spec section 18), and exporting captured audio for inspection.
 * The live pipeline never builds a WAV file -- that is an explicit anti-pattern
 * in section 28.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Uint8Array;
}

export function encodeWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(out.buffer);

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // format = PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  dv.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

export function decodeWav(buf: Uint8Array): WavInfo | null {
  if (buf.byteLength < 44) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 16_000;
  let channels = 1;
  let bitsPerSample = 16;
  let data: Uint8Array | null = null;

  while (offset + 8 <= buf.byteLength) {
    const id = tag(offset);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bitsPerSample = dv.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.byteLength));
    }
    // Chunks are word-aligned.
    offset = body + size + (size % 2);
  }
  return data ? { sampleRate, channels, bitsPerSample, data } : null;
}
