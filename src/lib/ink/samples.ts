/**
 * Pointer sample capture, normalization, stabilization, and quantization.
 *
 * This module is framework-free and DOM-free on purpose: it takes plain
 * readings, not `PointerEvent`s, so the same pipeline can be driven by a real
 * pointer, a replayed fixture, or a test. `pointer.ts` is the thin adapter that
 * turns browser events into these readings.
 *
 * The order matters and is fixed:
 *
 *   normalize -> drop duplicates -> streamline -> simplify -> quantize
 *
 * Streamlining before simplification means the simplifier works on the curve
 * the user will actually see. Quantizing last means every earlier stage runs in
 * continuous space and only one rounding error is ever introduced.
 */
import { INK_LIMITS, INK_SAMPLE_RANGES } from '../../types/ink';
import type { InkSample } from '../../types/ink';

/** One raw reading, in ink units, before any processing. */
export interface InkPointerReading {
  x: number;
  y: number;
  /** 0..1 as reported by the platform, or undefined when unreported. */
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  /** Milliseconds since the first reading of this stroke. */
  elapsed?: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Rejects readings that cannot be drawn and clamps the rest into range.
 *
 * A non-finite coordinate is dropped rather than clamped: a NaN from a driver
 * glitch is not a point at the origin, and treating it as one draws a line
 * across the page.
 */
export function normalizeReading(reading: InkPointerReading): InkPointerReading | null {
  const x = finite(reading.x);
  const y = finite(reading.y);
  if (x === undefined || y === undefined) return null;
  const extent = INK_LIMITS.worldExtent;
  if (Math.abs(x) > extent || Math.abs(y) > extent) return null;

  const normalized: InkPointerReading = { x, y };

  const pressure = finite(reading.pressure);
  // Chromium reports 0 for a mouse button that is down, which is not the same
  // as a pen touching the surface with no force. Treat it as unreported.
  if (pressure !== undefined && pressure > 0) {
    normalized.pressure = clamp(pressure, 0, 1);
  }

  const tiltX = finite(reading.tiltX);
  if (tiltX !== undefined) {
    normalized.tiltX = clamp(tiltX, INK_SAMPLE_RANGES.tiltMin, INK_SAMPLE_RANGES.tiltMax);
  }
  const tiltY = finite(reading.tiltY);
  if (tiltY !== undefined) {
    normalized.tiltY = clamp(tiltY, INK_SAMPLE_RANGES.tiltMin, INK_SAMPLE_RANGES.tiltMax);
  }
  const twist = finite(reading.twist);
  if (twist !== undefined) {
    normalized.twist = clamp(twist, INK_SAMPLE_RANGES.twistMin, INK_SAMPLE_RANGES.twistMax);
  }
  const elapsed = finite(reading.elapsed);
  if (elapsed !== undefined) normalized.elapsed = Math.max(0, elapsed);

  return normalized;
}

/**
 * Exponential stabilization, the "streamline" control.
 *
 * The cursor lags the pointer by a fraction of the remaining distance each
 * sample, which removes hand tremor. `strength` is 0..1 and is clamped below 1
 * so the stroke can always reach the pointer.
 */
export function streamline(readings: InkPointerReading[], strength: number): InkPointerReading[] {
  const alpha = 1 - clamp(strength, 0, 0.95);
  if (readings.length === 0 || alpha >= 1) return readings;

  const output: InkPointerReading[] = [readings[0]];
  let x = readings[0].x;
  let y = readings[0].y;
  for (let index = 1; index < readings.length; index += 1) {
    const reading = readings[index];
    x += (reading.x - x) * alpha;
    y += (reading.y - y) * alpha;
    output.push({ ...reading, x, y });
  }
  // Pin the last sample to where the pointer actually lifted, otherwise every
  // stroke ends short of where the user stopped.
  output[output.length - 1] = { ...readings[readings.length - 1] };
  return output;
}

/** Drops readings that land on the same quantized point as their predecessor. */
export function dropDuplicates(readings: InkPointerReading[]): InkPointerReading[] {
  const output: InkPointerReading[] = [];
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  for (const reading of readings) {
    const x = Math.round(reading.x);
    const y = Math.round(reading.y);
    if (x === lastX && y === lastY) continue;
    lastX = x;
    lastY = y;
    output.push(reading);
  }
  return output;
}

/**
 * Ramer-Douglas-Peucker simplification with a perpendicular-distance
 * tolerance in ink units.
 *
 * Endpoints are always kept. Pressure and tilt ride along with the samples
 * that survive; they are never resampled, because an interpolated pressure is
 * an invented reading.
 */
export function simplify(
  readings: InkPointerReading[],
  toleranceUnits: number,
): InkPointerReading[] {
  if (readings.length < 3 || toleranceUnits <= 0) return readings;

  const keep = new Uint8Array(readings.length);
  keep[0] = 1;
  keep[readings.length - 1] = 1;
  const toleranceSquared = toleranceUnits * toleranceUnits;

  // Explicit stack rather than recursion: a long stroke is thousands of
  // samples deep in the pathological case.
  const stack: Array<[number, number]> = [[0, readings.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    const ax = readings[first].x;
    const ay = readings[first].y;
    const bx = readings[last].x;
    const by = readings[last].y;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;

    let farthest = -1;
    let farthestDistance = -1;
    for (let index = first + 1; index < last; index += 1) {
      const px = readings[index].x - ax;
      const py = readings[index].y - ay;
      let distanceSquared: number;
      if (lengthSquared === 0) {
        distanceSquared = px * px + py * py;
      } else {
        const projection = clamp((px * dx + py * dy) / lengthSquared, 0, 1);
        const ox = px - projection * dx;
        const oy = py - projection * dy;
        distanceSquared = ox * ox + oy * oy;
      }
      if (distanceSquared > farthestDistance) {
        farthestDistance = distanceSquared;
        farthest = index;
      }
    }

    if (farthestDistance > toleranceSquared && farthest > 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  const output: InkPointerReading[] = [];
  for (let index = 0; index < readings.length; index += 1) {
    if (keep[index]) output.push(readings[index]);
  }
  return output;
}

/** Rounds a normalized reading onto the stored integer grids. */
export function quantize(reading: InkPointerReading): InkSample {
  const sample: InkSample = {
    x: Math.round(reading.x),
    y: Math.round(reading.y),
  };
  if (reading.pressure !== undefined) {
    sample.pressure = Math.round(reading.pressure * INK_SAMPLE_RANGES.pressureMax);
  }
  if (reading.tiltX !== undefined) sample.tiltX = Math.round(reading.tiltX);
  if (reading.tiltY !== undefined) sample.tiltY = Math.round(reading.tiltY);
  if (reading.twist !== undefined) sample.twist = Math.round(reading.twist);
  if (reading.elapsed !== undefined) sample.elapsed = Math.round(reading.elapsed);
  return sample;
}

/** Turns a stored integer pressure back into the 0..1 working value. */
export function pressureFromStored(stored: number | undefined): number | undefined {
  if (stored === undefined) return undefined;
  return stored / INK_SAMPLE_RANGES.pressureMax;
}

export interface StrokeCaptureOptions {
  /** 0..1, from the brush. */
  streamline?: number;
  /** Perpendicular tolerance in ink units. */
  simplifyTolerance?: number;
  /** Ceiling on the committed sample count. */
  maxSamples?: number;
}

/**
 * Default simplification tolerance, in ink units.
 *
 * 24 units is 0.375 pt — about a third of the width of the thinnest line the
 * app draws, and well under a device pixel at ordinary zoom. Phase 0 measured
 * the resulting deviation against the captured curve; see the contract.
 */
export const INK_DEFAULT_SIMPLIFY_TOLERANCE = 24;

/**
 * The whole capture pipeline, from raw readings to committed samples.
 *
 * Returns samples in the order they were drawn. The caller commits these in
 * one transaction; nothing here writes, serializes, or touches the network.
 */
export function captureStroke(
  readings: InkPointerReading[],
  options: StrokeCaptureOptions = {},
): InkSample[] {
  const normalized: InkPointerReading[] = [];
  for (const reading of readings) {
    const valid = normalizeReading(reading);
    if (valid) normalized.push(valid);
  }
  if (normalized.length === 0) return [];

  const deduplicated = dropDuplicates(normalized);
  const stabilized = streamline(deduplicated, options.streamline ?? 0);
  const simplified = simplify(
    stabilized,
    options.simplifyTolerance ?? INK_DEFAULT_SIMPLIFY_TOLERANCE,
  );

  const limit = Math.min(
    options.maxSamples ?? INK_LIMITS.samplesPerStroke,
    INK_LIMITS.samplesPerStroke,
  );
  const bounded = simplified.length > limit ? simplified.slice(0, limit) : simplified;
  return bounded.map(quantize);
}

/**
 * Splits captured samples into the segments that will be committed as linked
 * strokes.
 *
 * A stroke is split when it exceeds the sample ceiling or the wall-clock
 * ceiling. Segments overlap by one sample so the rendered line has no gap at
 * the seam.
 */
export function splitIntoSegments(
  samples: InkSample[],
  maxSamples: number = INK_LIMITS.samplesPerStroke,
  maxDurationMs: number = INK_LIMITS.strokeSegmentMs,
): InkSample[][] {
  if (samples.length === 0) return [];
  const segments: InkSample[][] = [];
  let current: InkSample[] = [];
  let segmentStartElapsed = samples[0].elapsed ?? 0;

  for (const sample of samples) {
    const elapsed = sample.elapsed ?? segmentStartElapsed;
    const wouldOverflow = current.length >= maxSamples;
    const wouldOutlast = elapsed - segmentStartElapsed > maxDurationMs;
    if (current.length > 0 && (wouldOverflow || wouldOutlast)) {
      segments.push(current);
      // Repeat the seam sample so the two segments join visually.
      current = [current[current.length - 1]];
      segmentStartElapsed = elapsed;
    }
    current.push(sample);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
