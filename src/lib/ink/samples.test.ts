import { describe, expect, it } from 'vitest';

import { INK_LIMITS, INK_SAMPLE_RANGES } from '../../types/ink';

import { buildStrokeSamples } from './fixture';
import {
  captureStroke,
  dropDuplicates,
  normalizeReading,
  pressureFromStored,
  quantize,
  simplify,
  splitIntoSegments,
  streamline,
} from './samples';
import type { InkPointerReading } from './samples';

describe('normalizeReading', () => {
  it('drops a reading with a non-finite coordinate rather than clamping it', () => {
    // A NaN from a driver glitch is not a point at the origin. Clamping one to
    // zero draws a line from the stroke to the corner of the page.
    expect(normalizeReading({ x: Number.NaN, y: 10 })).toBeNull();
    expect(normalizeReading({ x: 10, y: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('drops a reading outside the world extent', () => {
    expect(normalizeReading({ x: INK_LIMITS.worldExtent + 1, y: 0 })).toBeNull();
    expect(normalizeReading({ x: INK_LIMITS.worldExtent, y: 0 })).not.toBeNull();
  });

  it('treats zero pressure as unreported', () => {
    // Chromium reports 0 for a held mouse button. "No data" and "no force" must
    // stay distinguishable, because a brush renders them differently.
    expect(normalizeReading({ x: 0, y: 0, pressure: 0 })?.pressure).toBeUndefined();
    expect(normalizeReading({ x: 0, y: 0, pressure: 0.4 })?.pressure).toBe(0.4);
  });

  it('clamps tilt and twist into their specified ranges', () => {
    const reading = normalizeReading({ x: 0, y: 0, tiltX: -400, tiltY: 400, twist: 900 });
    expect(reading?.tiltX).toBe(INK_SAMPLE_RANGES.tiltMin);
    expect(reading?.tiltY).toBe(INK_SAMPLE_RANGES.tiltMax);
    expect(reading?.twist).toBe(INK_SAMPLE_RANGES.twistMax);
  });
});

describe('streamline', () => {
  it('pulls the line toward the pointer without ever passing it', () => {
    const readings: InkPointerReading[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 300, y: 0 },
    ];
    const smoothed = streamline(readings, 0.5);
    expect(smoothed[1].x).toBeGreaterThan(0);
    expect(smoothed[1].x).toBeLessThan(100);
  });

  it('ends exactly where the pointer lifted', () => {
    // Without this every stroke stops short of where the user stopped, which
    // is visible as a gap when joining two strokes.
    const readings: InkPointerReading[] = Array.from({ length: 20 }, (_, index) => ({
      x: index * 50,
      y: 0,
    }));
    const smoothed = streamline(readings, 0.9);
    expect(smoothed[smoothed.length - 1].x).toBe(950);
  });

  it('is a no-op at zero strength', () => {
    const readings: InkPointerReading[] = [
      { x: 0, y: 0 },
      { x: 100, y: 40 },
    ];
    expect(streamline(readings, 0)).toEqual(readings);
  });
});

describe('simplify', () => {
  it('reduces a straight run to its endpoints', () => {
    const readings: InkPointerReading[] = Array.from({ length: 50 }, (_, index) => ({
      x: index * 10,
      y: 0,
    }));
    expect(simplify(readings, 24)).toHaveLength(2);
  });

  it('keeps points that carry the shape', () => {
    const readings: InkPointerReading[] = [
      { x: 0, y: 0 },
      { x: 100, y: 1000 },
      { x: 200, y: 0 },
    ];
    expect(simplify(readings, 24)).toHaveLength(3);
  });

  it('carries the surviving samples channels along untouched', () => {
    // Pressure is never interpolated onto a synthesized point: an invented
    // reading is worse than a coarser one.
    const readings: InkPointerReading[] = [
      { x: 0, y: 0, pressure: 0.2 },
      { x: 50, y: 2, pressure: 0.9 },
      { x: 100, y: 0, pressure: 0.4 },
    ];
    const simplified = simplify(readings, 24);
    expect(simplified[0].pressure).toBe(0.2);
    expect(simplified[simplified.length - 1].pressure).toBe(0.4);
  });

  it('handles a long stroke without recursing', () => {
    // Sorted input is the pathological case for a recursive implementation.
    const readings: InkPointerReading[] = Array.from({ length: 20_000 }, (_, index) => ({
      x: index,
      y: index,
    }));
    expect(() => simplify(readings, 1)).not.toThrow();
  });
});

describe('dropDuplicates', () => {
  it('removes consecutive readings sharing a quantized position', () => {
    const readings: InkPointerReading[] = [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.1 },
      { x: 40, y: 0 },
      { x: 40, y: 0 },
    ];
    expect(dropDuplicates(readings)).toHaveLength(2);
  });
});

describe('quantize', () => {
  it('maps pressure onto the stored integer range and back', () => {
    expect(quantize({ x: 0, y: 0, pressure: 1 }).pressure).toBe(INK_SAMPLE_RANGES.pressureMax);
    expect(quantize({ x: 0, y: 0, pressure: 0 }).pressure).toBe(0);
    const roundTripped = pressureFromStored(quantize({ x: 0, y: 0, pressure: 0.5 }).pressure);
    expect(roundTripped).toBeCloseTo(0.5, 3);
  });

  it('leaves an absent channel absent', () => {
    const sample = quantize({ x: 1, y: 2 });
    expect(sample.pressure).toBeUndefined();
    expect(sample.tiltX).toBeUndefined();
  });

  it('stays within the documented quantization error for pressure', () => {
    // The contract claims quantization error below one part in 4095. A brush
    // width derived from pressure inherits exactly this error.
    let worst = 0;
    for (let step = 0; step <= 1000; step += 1) {
      const original = step / 1000;
      const recovered = pressureFromStored(quantize({ x: 0, y: 0, pressure: original }).pressure)!;
      worst = Math.max(worst, Math.abs(recovered - original));
    }
    expect(worst).toBeLessThanOrEqual(0.5 / INK_SAMPLE_RANGES.pressureMax);
  });
});

describe('captureStroke', () => {
  it('stays within the documented visual tolerance of the captured curve', () => {
    // The claim under test: simplification never moves the drawn line further
    // than the tolerance from where the pen actually went.
    const raw = buildStrokeSamples({ samples: 600, x: 0, y: 0, length: 30_000 });
    const readings: InkPointerReading[] = raw.map((sample) => ({
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure! / INK_SAMPLE_RANGES.pressureMax,
      elapsed: sample.elapsed,
    }));
    const tolerance = 24;
    const captured = captureStroke(readings, { simplifyTolerance: tolerance, streamline: 0 });

    let worst = 0;
    for (const reading of readings) {
      let best = Infinity;
      for (let index = 1; index < captured.length; index += 1) {
        const a = captured[index - 1];
        const b = captured[index];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        const t =
          lengthSquared === 0
            ? 0
            : Math.max(
                0,
                Math.min(1, ((reading.x - a.x) * dx + (reading.y - a.y) * dy) / lengthSquared),
              );
        best = Math.min(best, Math.hypot(reading.x - (a.x + t * dx), reading.y - (a.y + t * dy)));
      }
      worst = Math.max(worst, best);
    }
    // Half a unit of slack for the final rounding onto the integer grid.
    expect(worst).toBeLessThanOrEqual(tolerance + 0.5);
  });

  it('materially reduces the sample count of a real stroke', () => {
    const raw = buildStrokeSamples({ samples: 600, x: 0, y: 0, length: 30_000 });
    const readings: InkPointerReading[] = raw.map((sample) => ({ x: sample.x, y: sample.y }));
    const captured = captureStroke(readings, { simplifyTolerance: 24, streamline: 0 });
    expect(captured.length).toBeLessThan(readings.length / 2);
  });

  it('preserves every captured turn when simplification is disabled for handwriting', () => {
    const readings = [
      { x: 0, y: 0 },
      { x: 20, y: 40 },
      { x: 40, y: 0 },
      { x: 60, y: 40 },
    ];
    expect(captureStroke(readings, { streamline: 0, simplifyTolerance: 0 })).toEqual(readings);
  });

  it('returns nothing when every reading is invalid', () => {
    expect(captureStroke([{ x: Number.NaN, y: Number.NaN }])).toEqual([]);
  });

  it('never exceeds the per-stroke sample ceiling', () => {
    const readings: InkPointerReading[] = Array.from(
      { length: INK_LIMITS.samplesPerStroke * 2 },
      (_, index) => ({ x: index * 100, y: (index % 2) * 5_000 }),
    );
    expect(captureStroke(readings).length).toBeLessThanOrEqual(INK_LIMITS.samplesPerStroke);
  });
});

describe('splitIntoSegments', () => {
  it('splits on the sample ceiling and repeats the seam sample', () => {
    const samples = Array.from({ length: 25 }, (_, index) => ({ x: index, y: 0, elapsed: index }));
    const segments = splitIntoSegments(samples, 10, 100_000);
    expect(segments.length).toBeGreaterThan(1);
    // The seam is shared, so the rendered line has no gap between segments.
    expect(segments[1][0]).toEqual(segments[0][segments[0].length - 1]);
  });

  it('splits on the duration ceiling', () => {
    const samples = Array.from({ length: 10 }, (_, index) => ({
      x: index,
      y: 0,
      elapsed: index * 10_000,
    }));
    expect(splitIntoSegments(samples, 1_000, 30_000).length).toBeGreaterThan(1);
  });

  it('leaves an ordinary stroke as one segment', () => {
    const samples = Array.from({ length: 200 }, (_, index) => ({
      x: index,
      y: 0,
      elapsed: index * 8,
    }));
    expect(splitIntoSegments(samples)).toHaveLength(1);
  });
});
