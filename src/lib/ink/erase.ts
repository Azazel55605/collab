/**
 * The erasers.
 *
 * Three modes, and the difference between them is what the user expects a
 * rubber to do:
 *
 * - `stroke` removes a whole stroke the moment the eraser touches it. Fast,
 *   predictable, and what most handwriting apps mean by "erase".
 * - `segment` removes only the part under the eraser, splitting the stroke into
 *   the pieces that survive. This is the expensive, precise one.
 * - `object` removes any object, including text and images, not just ink.
 *
 * Segment erasing produces **new strokes with new ids and tombstones the
 * source**, rather than editing the original in place. That is deliberate: two
 * peers erasing different parts of the same stroke would otherwise both claim
 * to have edited it and one would win, silently discarding the other's erase.
 * Deterministic replacement ids make the Phase 6 merge tractable.
 *
 * Raster-style pixel erasing is explicitly not here — the plan defers it, and a
 * vector document has nowhere to put it that survives export.
 */

import type { InkObject, InkSample, InkScene, InkStroke } from '../../types/ink';
import { decodeSamples, encodeSamples } from './codec';
import { InkSpatialIndex } from './spatialIndex';
import { halfWidthAt } from './stroke';
import { addObject, removeObject, removeObjects } from './operations';
import type { InkEdit } from './operations';

export type InkEraserMode = 'stroke' | 'segment' | 'object';

export interface InkEraserPoint {
  x: number;
  y: number;
}

export interface InkEraseResult {
  /** Objects fully removed. */
  removedIds: string[];
  /** Strokes created to replace a partially erased one. */
  replacements: InkStroke[];
}

function distanceToSegmentSquared(
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
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const ox = px - (ax + t * dx);
  const oy = py - (ay + t * dy);
  return ox * ox + oy * oy;
}

function segmentsIntersect(
  a: InkEraserPoint,
  b: InkEraserPoint,
  c: InkEraserPoint,
  d: InkEraserPoint,
): boolean {
  const cross = (p: InkEraserPoint, q: InkEraserPoint, r: InkEraserPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0))
    && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
}

function segmentDistanceSquared(
  a: InkEraserPoint,
  b: InkEraserPoint,
  c: InkEraserPoint,
  d: InkEraserPoint,
): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegmentSquared(a.x, a.y, c.x, c.y, d.x, d.y),
    distanceToSegmentSquared(b.x, b.y, c.x, c.y, d.x, d.y),
    distanceToSegmentSquared(c.x, c.y, a.x, a.y, b.x, b.y),
    distanceToSegmentSquared(d.x, d.y, a.x, a.y, b.x, b.y),
  );
}

function segmentTouchesEraser(
  from: InkSample,
  to: InkSample,
  path: InkEraserPoint[],
  radius: number,
): boolean {
  if (path.length === 1) {
    return distanceToSegmentSquared(path[0].x, path[0].y, from.x, from.y, to.x, to.y)
      <= radius * radius;
  }
  for (let index = 1; index < path.length; index += 1) {
    if (segmentDistanceSquared(from, to, path[index - 1], path[index]) <= radius * radius) {
      return true;
    }
  }
  return false;
}

function interpolateSample(from: InkSample, to: InkSample, amount: number): InkSample {
  const sample: InkSample = {
    x: Math.round(from.x + (to.x - from.x) * amount),
    y: Math.round(from.y + (to.y - from.y) * amount),
  };
  for (const key of ['pressure', 'tiltX', 'tiltY', 'twist', 'elapsed'] as const) {
    const start = from[key];
    const end = to[key];
    if (start !== undefined && end !== undefined) {
      sample[key] = Math.round(start + (end - start) * amount);
    }
  }
  return sample;
}

/**
 * Adds temporary samples only where an eraser crosses a long stored segment.
 * Old drawings may have been simplified aggressively; clipping only at their
 * surviving sample positions would remove a much larger chunk than the rubber
 * actually covered.
 */
function refineSamplesNearEraser(
  samples: InkSample[],
  path: InkEraserPoint[],
  radius: number,
): InkSample[] {
  if (samples.length < 2) return samples;
  const refined: InkSample[] = [samples[0]];
  const targetStep = Math.max(1, radius / 3);
  for (let index = 1; index < samples.length; index += 1) {
    const from = samples[index - 1];
    const to = samples[index];
    if (segmentTouchesEraser(from, to, path, radius)) {
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const divisions = Math.min(256, Math.max(1, Math.ceil(length / targetStep)));
      for (let division = 1; division < divisions; division += 1) {
        refined.push(interpolateSample(from, to, division / divisions));
      }
    }
    refined.push(to);
  }
  return refined;
}

/** True when the eraser path passes within `radius` of a sample. */
function sampleIsErased(
  sample: InkSample,
  path: InkEraserPoint[],
  radius: number,
): boolean {
  if (path.length === 1) {
    return (sample.x - path[0].x) ** 2 + (sample.y - path[0].y) ** 2 <= radius * radius;
  }
  for (let index = 1; index < path.length; index += 1) {
    const distance = distanceToSegmentSquared(
      sample.x,
      sample.y,
      path[index - 1].x,
      path[index - 1].y,
      path[index].x,
      path[index].y,
    );
    if (distance <= radius * radius) return true;
  }
  return false;
}

/**
 * Splits a stroke around the parts the eraser covered.
 *
 * Returns the runs of samples that survive. A run of one sample is dropped: a
 * single leftover point renders as a dot the user did not draw, which reads as
 * eraser debris.
 */
export function splitStrokeAroundEraser(
  samples: InkSample[],
  path: InkEraserPoint[],
  radius: number,
): InkSample[][] {
  const runs: InkSample[][] = [];
  let current: InkSample[] = [];
  const refined = refineSamplesNearEraser(samples, path, radius);

  for (const sample of refined) {
    if (sampleIsErased(sample, path, radius)) {
      if (current.length > 1) runs.push(current);
      current = [];
      continue;
    }
    current.push(sample);
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

/**
 * Works out what an eraser stroke removes, without mutating anything.
 *
 * Separated from applying it so the caller can preview the result, and so the
 * whole erase commits as one undoable edit rather than one per stroke touched.
 */
export function planErase(
  scene: InkScene,
  path: InkEraserPoint[],
  radius: number,
  mode: InkEraserMode,
  index?: InkSpatialIndex,
): InkEraseResult {
  if (path.length === 0) return { removedIds: [], replacements: [] };

  const spatial = index ?? new InkSpatialIndex(scene);
  const touched = spatial.hitTestEraser(path, radius);

  const removedIds: string[] = [];
  const replacements: InkStroke[] = [];

  for (const id of touched) {
    const object: InkObject | undefined = scene.objects[id];
    if (!object) continue;

    if (mode === 'object') {
      removedIds.push(id);
      continue;
    }
    // Stroke and segment mode only erase ink; a text box under the eraser is
    // left alone, because rubbing over a note should not delete the note.
    if (object.type !== 'stroke') continue;

    if (mode === 'stroke') {
      removedIds.push(id);
      continue;
    }

    const samples = decodeSamples(object.samples);
    // The eraser has to reach the *edge* of the line, not its centre, or a
    // thick stroke needs the eraser dragged through its middle to cut.
    const reach = radius + halfWidthAt(samples[0], object.brush, undefined);
    const runs = splitStrokeAroundEraser(samples, path, reach);

    // Nothing actually came off: one surviving run holding every sample.
    if (runs.length === 1 && runs[0].length === samples.length) continue;
    removedIds.push(id);
    runs.forEach((run, runIndex) => {
      replacements.push({
        ...object,
        // Deterministic, so two peers computing the same erase agree.
        id: `${object.id}~e${runIndex}`,
        samples: encodeSamples(run),
        bounds: undefined,
      });
    });
  }

  return { removedIds, replacements };
}

/** Applies a planned erase as a single reversible edit. */
export function applyErase(scene: InkScene, plan: InkEraseResult): InkEdit<InkScene> {
  if (plan.removedIds.length === 0 && plan.replacements.length === 0) {
    return { result: scene, inverse: noop };
  }

  // Replacements are inserted at the removed stroke's own paint index so the
  // surviving pieces stay exactly where the original sat in the z-order.
  const indexes = new Map<string, number>();
  for (const id of plan.removedIds) indexes.set(id, scene.objectOrder.indexOf(id));

  const removal = removeObjects(scene, plan.removedIds);
  let result = removal.result;

  // Each source's pieces advance their own cursor, so the surviving runs keep
  // the order they were drawn in. Inserting them all at one index reverses
  // them, which shows up the moment two pieces overlap.
  const cursors = new Map<string, number>();
  for (const replacement of plan.replacements) {
    const suffix = replacement.id.lastIndexOf('~e');
    const sourceId = suffix < 0 ? replacement.id : replacement.id.slice(0, suffix);
    const base = indexes.get(sourceId);
    const offset = cursors.get(sourceId) ?? 0;
    const insertAt = base === undefined || base < 0
      ? result.objectOrder.length
      : Math.min(base + offset, result.objectOrder.length);
    result = addObject(result, replacement, insertAt).result;
    cursors.set(sourceId, offset + 1);
  }

  return {
    result,
    inverse: (input) => {
      let restored = input;
      for (const replacement of plan.replacements) {
        if (restored.objects[replacement.id]) {
          restored = removeObject(restored, replacement.id).result;
        }
      }
      restored = removal.inverse(restored).result;
      return { result: restored, inverse: (next) => applyErase(next, plan) };
    },
  };
}

function noop<T>(input: T): InkEdit<T> {
  return { result: input, inverse: noop };
}
