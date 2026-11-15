export const MAX_WAVEFORM_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 60;
const BUCKETS = 96;

function pcmPeaks(bytes: Uint8Array) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => data.getUint32(at, false);
  if (bytes.length < 12 || tag(0) !== 0x52494646 || tag(8) !== 0x57415645) {
    throw new Error('Waveform previews require a PCM WAV file.');
  }
  let channels = 0;
  let rate = 0;
  let samples: DataView | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = data.getUint32(at + 4, true);
    const start = at + 8;
    if (start + length > bytes.length) break;
    if (tag(at) === 0x666d7420 && length >= 16) {
      if (data.getUint16(start, true) !== 1 || data.getUint16(start + 14, true) !== 16) break;
      channels = data.getUint16(start + 2, true);
      rate = data.getUint32(start + 4, true);
    } else if (tag(at) === 0x64617461) {
      samples = new DataView(bytes.buffer, bytes.byteOffset + start, length);
      break;
    }
    at = start + length + (length % 2);
  }
  if (!samples || ![1, 2].includes(channels) || !(rate > 0 && rate <= 192_000)) {
    throw new Error('Waveform previews support 16-bit mono and stereo PCM WAV.');
  }
  const frames = Math.floor(samples.byteLength / (channels * 2));
  if (frames === 0 || frames / rate > MAX_SECONDS)
    throw new Error('This track is too long for a waveform preview.');
  const peaks = new Array<number>(BUCKETS).fill(0);
  for (let frame = 0; frame < frames; frame++) {
    const bucket = Math.floor((frame * BUCKETS) / frames);
    for (let channel = 0; channel < channels; channel++) {
      const sample = samples.getInt16((frame * channels + channel) * 2, true);
      peaks[bucket] = Math.max(peaks[bucket], Math.abs(sample) / 32768);
    }
  }
  return peaks;
}

export async function loadWaveform(url: string, size: number, signal: AbortSignal) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_WAVEFORM_BYTES) {
    throw new Error('This file exceeds the waveform preview limit.');
  }
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error('Could not load the waveform source.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > size) throw new Error('The waveform source size changed.');
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== size) throw new Error('The waveform source is incomplete.');
    signal.throwIfAborted();
    return pcmPeaks(bytes);
  } finally {
    void reader.cancel().catch(() => {});
  }
}
