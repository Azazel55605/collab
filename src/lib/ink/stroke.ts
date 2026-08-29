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

function arcLengths(samples: InkSample[]): { lengths: number[]; total: number } {
  const lengths = new Array<number>(samples.length).fill(0);
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    total += Math.hypot(
      samples[index].x - samples[index - 1].x,
      samples[index].y - samples[index - 1].y,
    );
    lengths[index] = total;
  }
  return { lengths, total };
}

/** Unit normals, averaged at interior samples so corners do not pinch. */
function normalsFor(samples: InkSample[]): InkPoint[] {
  const normals = new Array<InkPoint>(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[Math.max(0, index - 1)];
    const next = samples[Math.min(samples.length - 1, index + 1)];
    let dx = next.x - previous.x;
    let dy = next.y - previous.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      dx = 1;
      dy = 0;
    } else {
      dx /= length;
      dy /= length;
    }
    normals[index] = { x: -dy, y: dx };
  }
  return normals;
}

/** Semicircular cap, walked from one offset point to the other. */
function capPoints(
  centre: InkSample,
  normal: InkPoint,
  radius: number,
  startAngleOffset: number,
  segments: number,
): InkPoint[] {
  const base = Math.atan2(normal.y, normal.x) + startAngleOffset;
  const points: InkPoint[] = [];
  for (let step = 1; step < segments; step += 1) {
    const angle = base + (Math.PI * step) / segments;
    points.push({
      x: centre.x + Math.cos(angle) * radius,
      y: centre.y + Math.sin(angle) * radius,
    });
  }
  return points;
}

const CAP_SEGMENTS = 8;

/**
 * The first-party outliner.
 *
 * Walks the centre line offsetting by the pressure- and taper-scaled
 * half-width, then closes the polygon with round caps. Deterministic: the same
 * samples and brush always produce the same points, which is what makes SVG
 * export reproducible.
 */
export const outlineStroke: InkStrokeOutliner = (samples, brush) => {
  if (samples.length === 0) return [];

  const simulated = brush.simulatePressure ? simulatedPressures(samples) : undefined;
  const { lengths, total } = arcLengths(samples);

  if (samples.length === 1 || total === 0) {
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

  const normals = normalsFor(samples);
  const radii = samples.map((sample, index) => {
    const half = halfWidthAt(sample, brush, simulated?.[index]);
    return half * taperFactor(lengths[index], total, brush.taperStart, brush.taperEnd);
  });

  const left: InkPoint[] = [];
  const right: InkPoint[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const normal = normals[index];
    const radius = radii[index];
    left.push({ x: sample.x + normal.x * radius, y: sample.y + normal.y * radius });
    right.push({ x: sample.x - normal.x * radius, y: sample.y - normal.y * radius });
  }

  const last = samples.length - 1;
  return [
    ...left,
    ...capPoints(samples[last], normals[last], radii[last], 0, CAP_SEGMENTS),
    ...right.reverse(),
    ...capPoints(samples[0], normals[0], radii[0], Math.PI, CAP_SEGMENTS),
  ];
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
