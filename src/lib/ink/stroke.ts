/**
 * Stroke outline generation.
 *
 * A stroke is stored as a centre line plus per-sample pressure. To draw it we
 * need a filled polygon: the centre line offset to either side by a
 * pressure-dependent half-width, capped at both ends. That conversion is the
 * one part of ink rendering with a credible third-party option
 * (`perfect-freehand`), so it sits behind an adapter.
 *
 * Everything on either side of the adapter is Collab-owned: the sample model,
 * the brush parameters, the bounds, the hit test, and the exporter all speak
 * `InkSample` and ink units. `InkStrokeOutliner` is the entire replaceable
 * surface — see `strokeAdapters.ts` for the alternative implementation and
 * `docs/plans/digital-ink-phase0-contract.md` for the comparison.
 */
import { INK_SAMPLE_RANGES } from '../../types/ink';
import type { InkBounds, InkBrushParameters, InkSample } from '../../types/ink';

/** A point on a generated outline, in ink units. */
export interface InkPoint {
  x: number;
  y: number;
}

/**
 * The replaceable half of ink rendering: centre line plus brush in, closed
 * outline polygon out.
 */
export type InkStrokeOutliner = (samples: InkSample[], brush: InkBrushParameters) => InkPoint[];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Half-width at one sample, in ink units.
 *
 * With no reported pressure the stroke is uniform unless the brush opts into
 * simulation. `thinning` is signed in the same sense `perfect-freehand` uses
 * it: positive means more pressure draws wider.
 */
export function halfWidthAt(
  sample: InkSample,
  brush: InkBrushParameters,
  simulated: number | undefined,
): number {
  const base = brush.width / 2;
  const thinning = clamp(brush.thinning, -1, 1);
  if (thinning === 0) return base;

  let pressure: number | undefined;
  if (sample.pressure !== undefined) {
    pressure = sample.pressure / INK_SAMPLE_RANGES.pressureMax;
  } else if (brush.simulatePressure && simulated !== undefined) {
    pressure = simulated;
  }
  if (pressure === undefined) return base;

  // Same curve `perfect-freehand` uses, so the two adapters are comparable:
  // half-width is `width * (0.5 - thinning * (0.5 - pressure))`. Negative
  // thinning inverts it, which is what a wet brush does.
  const scale = 2 * (0.5 - thinning * (0.5 - pressure));
  return base * clamp(scale, 0.05, 2);
}

/** Taper multiplier at a position along the stroke, 0..1 at each end. */
function taperFactor(
  distance: number,
  total: number,
  taperStart: number,
  taperEnd: number,
): number {
  let factor = 1;
  if (taperStart > 0 && distance < taperStart) {
    factor = Math.min(factor, Math.sin((distance / taperStart) * (Math.PI / 2)));
  }
  if (taperEnd > 0 && total - distance < taperEnd) {
    factor = Math.min(factor, Math.sin(((total - distance) / taperEnd) * (Math.PI / 2)));
  }
  return clamp(factor, 0, 1);
}

/**
 * Velocity-derived pressure, used only when the brush asks for it.
 *
 * Faster movement means a lighter line, which is how a real pen behaves. The
 * reference speed is deliberately generous so ordinary writing sits in the
 * middle of the range rather than pinned at one end.
 */
const SIMULATED_PRESSURE_REFERENCE_UNITS_PER_MS = 6;

function simulatedPressures(samples: InkSample[]): number[] {
  const output = new Array<number>(samples.length).fill(0.5);
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const sample = samples[index];
    const dx = sample.x - previous.x;
    const dy = sample.y - previous.y;
    const distance = Math.hypot(dx, dy);
    const dt = Math.max(1, (sample.elapsed ?? 0) - (previous.elapsed ?? 0));
    const speed = distance / dt / SIMULATED_PRESSURE_REFERENCE_UNITS_PER_MS;
    // Smooth so a single fast sample does not pinch the line.
    output[index] = clamp(output[index - 1] * 0.7 + (1 - clamp(speed, 0, 1)) * 0.3, 0, 1);
  }
  return output;
}

/**
 * The smoothed centre line as parallel arrays: position plus untapered
 * half-width. Flat arrays, because this runs for every stroke in every tile
 * repaint and per-point objects dominated its cost.
 */
interface InkCurve {
  xs: number[];
  ys: number[];
  halves: number[];
}

/**
 * Largest distance, in ink units, a flattened curve segment may stray from the
 * true curve. 4 units is 1/16 pt: under a device pixel even at deep zoom.
 */
const CURVE_TOLERANCE_UNITS = 4;
const CURVE_MAX_SUBDIVISIONS = 16;

/**
 * Smooths the centre line with a quadratic B-spline through sample midpoints.
 *
 * Fast pointer movement delivers samples far apart, and joining them with
 * straight segments shows as corners. Each interior sample instead becomes the
 * control point of a quadratic curve between its neighbouring midpoints,
 * flattened just finely enough that no facet is visible. Densely sampled
 * strokes need little or no subdivision. The curve starts and ends on the
 * first and last sample.
 *
 * Every generated point, and its half-width, is a convex combination of three
 * consecutive samples, so the outline never leaves `strokeBounds`. The stored
 * samples are not changed; this is purely how they are drawn.
 */
function smoothCentreLine(samples: InkSample[], halfWidths: number[]): InkCurve {
  const count = samples.length;
  const xs: number[] = [samples[0].x];
  const ys: number[] = [samples[0].y];
  const halves: number[] = [halfWidths[0]];

  for (let index = 1; index < count - 1; index += 1) {
    const a = samples[index - 1];
    const b = samples[index];
    const c = samples[index + 1];
    const ha = halfWidths[index - 1];
    const hb = halfWidths[index];
    const hc = halfWidths[index + 1];

    // The chord between the midpoints misses the curve by |2b - a - c| / 8,
    // and splitting into n pieces divides that by n².
    const bendX = 2 * b.x - a.x - c.x;
    const bendY = 2 * b.y - a.y - c.y;
    const deviation = Math.sqrt(bendX * bendX + bendY * bendY) / 8;
    const steps = Math.min(
      CURVE_MAX_SUBDIVISIONS,
      Math.max(1, Math.ceil(Math.sqrt(deviation / CURVE_TOLERANCE_UNITS))),
    );

    // Each curve starts where the previous one ended, so only the first curve
    // emits its start point.
    for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      const w0 = 0.5 * (1 - t) * (1 - t);
      const w2 = 0.5 * t * t;
      const w1 = 1 - w0 - w2;
      xs.push(w0 * a.x + w1 * b.x + w2 * c.x);
      ys.push(w0 * a.y + w1 * b.y + w2 * c.y);
      halves.push(w0 * ha + w1 * hb + w2 * hc);
    }
  }

  if (count > 1) {
    xs.push(samples[count - 1].x);
    ys.push(samples[count - 1].y);
    halves.push(halfWidths[count - 1]);
  }
  return { xs, ys, halves };
}

/** Whether every sample sits on the first one, i.e. the stroke is a dot. */
function isDot(samples: InkSample[]): boolean {
  const { x, y } = samples[0];
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].x !== x || samples[index].y !== y) return false;
  }
  return true;
}

/** Semicircular cap, walked from one offset point to the other. */
function pushCap(
  output: InkPoint[],
  centreX: number,
  centreY: number,
  normalAngle: number,
  radius: number,
  segments: number,
): void {
  for (let step = 1; step < segments; step += 1) {
    const angle = normalAngle + (Math.PI * step) / segments;
    output.push({ x: centreX + Math.cos(angle) * radius, y: centreY + Math.sin(angle) * radius });
  }
}

const CAP_SEGMENTS = 8;

/**
 * The first-party outliner.
 *
 * Smooths the centre line, walks it offsetting by the pressure- and
 * taper-scaled half-width, then closes the polygon with round caps.
 * Deterministic: the same samples and brush always produce the same points,
 * which is what makes SVG export reproducible.
 */
export const outlineStroke: InkStrokeOutliner = (samples, brush) => {
  if (samples.length === 0) return [];

  const simulated = brush.simulatePressure ? simulatedPressures(samples) : undefined;

  if (isDot(samples)) {
    // A dot. Draw the cap circle rather than nothing, so a tap leaves a mark.
    const radius = halfWidthAt(samples[0], brush, simulated?.[0]);
    const points: InkPoint[] = [];
    const steps = CAP_SEGMENTS * 2;
    for (let step = 0; step < steps; step += 1) {
      const angle = (step / steps) * Math.PI * 2;
      points.push({
        x: samples[0].x + Math.cos(angle) * radius,
        y: samples[0].y + Math.sin(angle) * radius,
      });
    }
    return points;
  }

  const halfWidths = new Array<number>(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    halfWidths[index] = halfWidthAt(samples[index], brush, simulated?.[index]);
  }
  const { xs, ys, halves } = smoothCentreLine(samples, halfWidths);
  const count = xs.length;
  const last = count - 1;

  // Arc length along the smoothed curve, for tapering.
  const lengths = new Array<number>(count);
  lengths[0] = 0;
  for (let index = 1; index < count; index += 1) {
    const dx = xs[index] - xs[index - 1];
    const dy = ys[index] - ys[index - 1];
    lengths[index] = lengths[index - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = lengths[last];
  const tapered = brush.taperStart > 0 || brush.taperEnd > 0;

  // Left side forwards into `output`, right side into `right`, both offset by
  // unit normals averaged across neighbours so corners do not pinch.
  const output: InkPoint[] = [];
  const right: InkPoint[] = new Array(count);
  let firstAngle = 0;
  let lastAngle = 0;
  let firstRadius = 0;
  let lastRadius = 0;
  for (let index = 0; index < count; index += 1) {
    const previous = index > 0 ? index - 1 : 0;
    const next = index < last ? index + 1 : last;
    let dx = xs[next] - xs[previous];
    let dy = ys[next] - ys[previous];
    // Math.hypot is several times slower than this in V8, and this loop runs
    // for every outline point of every stroke in a tile repaint.
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) {
      dx = 1;
      dy = 0;
    } else {
      dx /= length;
      dy /= length;
    }
    const nx = -dy;
    const ny = dx;
    const radius = tapered
      ? halves[index] * taperFactor(lengths[index], total, brush.taperStart, brush.taperEnd)
      : halves[index];
    const x = xs[index];
    const y = ys[index];
    output.push({ x: x + nx * radius, y: y + ny * radius });
    right[last - index] = { x: x - nx * radius, y: y - ny * radius };
    if (index === 0) {
      firstAngle = Math.atan2(ny, nx);
      firstRadius = radius;
    }
    if (index === last) {
      lastAngle = Math.atan2(ny, nx);
      lastRadius = radius;
    }
  }

  pushCap(output, xs[last], ys[last], lastAngle, lastRadius, CAP_SEGMENTS);
  for (const point of right) output.push(point);
  pushCap(output, xs[0], ys[0], firstAngle + Math.PI, firstRadius, CAP_SEGMENTS);
  return output;
};

/**
 * Bounds of the drawn stroke, including its width.
 *
 * Computed from the centre line and radii rather than from the outline, so it
 * does not depend on which outliner is installed. A bound that changed when
 * the adapter changed would invalidate every cached tile.
 */
export function strokeBounds(samples: InkSample[], brush: InkBrushParameters): InkBounds {
  if (samples.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const simulated = brush.simulatePressure ? simulatedPressures(samples) : undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const radius = halfWidthAt(sample, brush, simulated?.[index]);
    if (sample.x - radius < minX) minX = sample.x - radius;
    if (sample.y - radius < minY) minY = sample.y - radius;
    if (sample.x + radius > maxX) maxX = sample.x + radius;
    if (sample.y + radius > maxY) maxY = sample.y + radius;
  }
  return {
    minX: Math.floor(minX),
    minY: Math.floor(minY),
    maxX: Math.ceil(maxX),
    maxY: Math.ceil(maxY),
  };
}

/** Squared distance from a point to a segment, for hit testing. */
function distanceSquaredToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const projection = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  const ox = px - (ax + projection * dx);
  const oy = py - (ay + projection * dy);
  return ox * ox + oy * oy;
}

/**
 * Whether a point is on the stroke.
 *
 * Tests against the centre line with the local half-width, not against the
 * outline polygon: a polygon test is a point-in-polygon walk over hundreds of
 * points, while this is a segment scan with an early exit, and the two agree
 * everywhere except within a fraction of a unit at the cap seams.
 *
 * `slop` widens the target for touch and is supplied by the caller in ink
 * units, already divided by the current zoom.
 */
export function strokeHitTest(
  samples: InkSample[],
  brush: InkBrushParameters,
  x: number,
  y: number,
  slop = 0,
): boolean {
  if (samples.length === 0) return false;
  const simulated = brush.simulatePressure ? simulatedPressures(samples) : undefined;

  if (samples.length === 1) {
    const radius = halfWidthAt(samples[0], brush, simulated?.[0]) + slop;
    return (x - samples[0].x) ** 2 + (y - samples[0].y) ** 2 <= radius * radius;
  }

  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1];
    const b = samples[index];
    const radius =
      Math.max(
        halfWidthAt(a, brush, simulated?.[index - 1]),
        halfWidthAt(b, brush, simulated?.[index]),
      ) + slop;
    if (distanceSquaredToSegment(x, y, a.x, a.y, b.x, b.y) <= radius * radius) return true;
  }
  return false;
}
