/**
 * Compact encoding of stroke samples inside `.ink` JSON.
 *
 * A handwritten page is tens of thousands of samples. Stored as one object
 * apiece — `{"x":1234,"y":5678,"pressure":2048}` — a page costs hundreds of
 * kilobytes of repeated key names before any ink exists. So samples are stored
 * structure-of-arrays with each channel delta-encoded: the first value is
 * absolute and the rest are differences, which are small integers because a
 * pen moves a little between samples.
 *
 * This stays JSON. A binary blob would be smaller still, but it would be
 * opaque to the CRDT, to revision diffs, and to anyone reading a document to
 * debug it — and the delta arrays already recover most of the difference.
 */
import type { InkSample, InkSampleChannels } from '../../types/ink';

type OptionalChannel = 'p' | 'tx' | 'ty' | 'tw' | 't';

const OPTIONAL_CHANNEL_FIELDS: Record<OptionalChannel, keyof InkSample> = {
  p: 'pressure',
  tx: 'tiltX',
  ty: 'tiltY',
  tw: 'twist',
  t: 'elapsed',
};

function encodeDeltas(values: number[]): number[] {
  const output = new Array<number>(values.length);
  let previous = 0;
  for (let index = 0; index < values.length; index += 1) {
    output[index] = values[index] - previous;
    previous = values[index];
  }
  return output;
}

function decodeDeltas(deltas: number[]): number[] {
  const output = new Array<number>(deltas.length);
  let running = 0;
  for (let index = 0; index < deltas.length; index += 1) {
    running += deltas[index];
    output[index] = running;
  }
  return output;
}

/**
 * Encodes samples for storage.
 *
 * An optional channel is written only when at least one sample carries it. A
 * channel that is present on some samples but not others is filled by holding
 * the previous value, because a gap in the middle of a delta array has no
 * representation — and holding is what the renderer would do anyway.
 */
export function encodeSamples(samples: InkSample[]): InkSampleChannels {
  const channels: InkSampleChannels = {
    x: encodeDeltas(samples.map((sample) => sample.x)),
    y: encodeDeltas(samples.map((sample) => sample.y)),
  };

  for (const key of Object.keys(OPTIONAL_CHANNEL_FIELDS) as OptionalChannel[]) {
    const field = OPTIONAL_CHANNEL_FIELDS[key];
    let present = false;
    const values = new Array<number>(samples.length);
    let held = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index][field] as number | undefined;
      if (value !== undefined) {
        present = true;
        held = value;
      }
      values[index] = held;
    }
    if (present) channels[key] = encodeDeltas(values);
  }

  return channels;
}

/**
 * Decodes stored channels back into samples.
 *
 * Channel arrays shorter than `x` are ignored rather than partially applied:
 * a truncated array is corruption, and half-decoding it produces a stroke that
 * looks plausible and is wrong.
 */
export function decodeSamples(channels: InkSampleChannels): InkSample[] {
  const xs = decodeDeltas(channels.x ?? []);
  const ys = decodeDeltas(channels.y ?? []);
  const count = Math.min(xs.length, ys.length);

  const optional: Partial<Record<OptionalChannel, number[]>> = {};
  for (const key of Object.keys(OPTIONAL_CHANNEL_FIELDS) as OptionalChannel[]) {
    const encoded = channels[key];
    if (encoded && encoded.length >= count) optional[key] = decodeDeltas(encoded);
  }

  const samples = new Array<InkSample>(count);
  for (let index = 0; index < count; index += 1) {
    const sample: InkSample = { x: xs[index], y: ys[index] };
    for (const key of Object.keys(OPTIONAL_CHANNEL_FIELDS) as OptionalChannel[]) {
      const values = optional[key];
      if (values) (sample[OPTIONAL_CHANNEL_FIELDS[key]] as number) = values[index];
    }
    samples[index] = sample;
  }
  return samples;
}

/** Sample count of an encoded stroke, without decoding it. */
export function sampleCount(channels: InkSampleChannels): number {
  return Math.min(channels.x?.length ?? 0, channels.y?.length ?? 0);
}

/**
 * The verbose form, for size comparison only.
 *
 * Kept in the source rather than in a test so the contract's size claim can be
 * reproduced against a named function instead of an inline literal.
 */
export function encodeSamplesVerbose(samples: InkSample[]): InkSample[] {
  return samples;
}
