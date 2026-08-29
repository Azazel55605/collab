import { describe, expect, it } from 'vitest';

import { INK_SAMPLE_RANGES } from '../../types/ink';
import type { InkSample } from '../../types/ink';

import { decodeSamples, encodeSamples, sampleCount } from './codec';
import { buildStrokeSamples } from './fixture';
import { captureStroke } from './samples';

describe('encodeSamples / decodeSamples', () => {
  it('round-trips every channel exactly', () => {
    const samples = buildStrokeSamples({ samples: 120, x: 4_000, y: 9_000, tilt: true });
    expect(decodeSamples(encodeSamples(samples))).toEqual(samples);
  });

  it('round-trips a stroke with no optional channels', () => {
    const samples: InkSample[] = [
      { x: 10, y: 20 },
      { x: 15, y: 22 },
    ];
    const encoded = encodeSamples(samples);
    expect(encoded.p).toBeUndefined();
    expect(encoded.t).toBeUndefined();
    expect(decodeSamples(encoded)).toEqual(samples);
  });

  it('stores deltas, not absolute values', () => {
    // This is the whole point of the encoding: consecutive positions become
    // small integers, which is what makes the JSON small.
    const encoded = encodeSamples([
      { x: 100_000, y: 200_000 },
      { x: 100_004, y: 200_003 },
      { x: 100_009, y: 200_001 },
    ]);
    expect(encoded.x).toEqual([100_000, 4, 5]);
    expect(encoded.y).toEqual([200_000, 3, -2]);
  });

  it('holds the previous value across a gap in an optional channel', () => {
    // A delta array has no representation for "absent here". Holding is what
    // the renderer would do anyway; the alternative is dropping the channel
    // from the whole stroke.
    const decoded = decodeSamples(
      encodeSamples([
        { x: 0, y: 0, pressure: 100 },
        { x: 1, y: 0 },
        { x: 2, y: 0, pressure: 300 },
      ]),
    );
    expect(decoded.map((sample) => sample.pressure)).toEqual([100, 100, 300]);
  });

  it('ignores a truncated channel instead of half-applying it', () => {
    // A short array is corruption. Decoding part of it produces a stroke that
    // looks plausible and is wrong, which is worse than losing the channel.
    const decoded = decodeSamples({ x: [0, 1, 1], y: [0, 0, 0], p: [500, 10] });
    expect(decoded).toHaveLength(3);
    expect(decoded.every((sample) => sample.pressure === undefined)).toBe(true);
  });

  it('reports the sample count without decoding', () => {
    const encoded = encodeSamples(buildStrokeSamples({ samples: 41, x: 0, y: 0 }));
    expect(sampleCount(encoded)).toBe(41);
  });

  it('decodes an empty stroke to nothing', () => {
    expect(decodeSamples({ x: [], y: [] })).toEqual([]);
  });
});

describe('storage size', () => {
  it('is materially smaller than one object per sample', () => {
    // The contract's size claim. Reproduced here against the real encoder so
    // it cannot drift from the document.
    const samples = buildStrokeSamples({ samples: 512, x: 120_000, y: 90_000, tilt: true });
    const verboseBytes = JSON.stringify(samples).length;
    const compactBytes = JSON.stringify(encodeSamples(samples)).length;

    expect(compactBytes).toBeLessThan(verboseBytes / 2);
  });

  it('costs about a dozen bytes per stored sample', () => {
    // Measured, not aspirational: 12.2-12.7 B/sample across stroke lengths for
    // a stroke carrying position, pressure, and time. The ceiling here is what
    // the contract's storage table is derived from.
    const samples = buildStrokeSamples({ samples: 512, x: 5_000, y: 5_000, length: 30_720 });
    const bytesPerSample = JSON.stringify(encodeSamples(samples)).length / samples.length;
    expect(bytesPerSample).toBeLessThan(16);
  });

  it('stores a captured stroke far more cheaply than the readings it came from', () => {
    // The two reductions compound: the capture pipeline drops redundant
    // samples, then the codec drops repeated keys and absolute values.
    const raw = buildStrokeSamples({ samples: 100, x: 5_000, y: 5_000, length: 6_000 });
    const readings = raw.map((sample) => ({
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure! / INK_SAMPLE_RANGES.pressureMax,
      elapsed: sample.elapsed,
    }));
    const stored = JSON.stringify(encodeSamples(captureStroke(readings))).length;

    expect(stored).toBeLessThan(1_024);
    expect(stored).toBeLessThan(JSON.stringify(raw).length / 5);
  });
});
