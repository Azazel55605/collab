/**
 * Moving, scaling, and rotating ink objects.
 *
 * Vector transforms are **baked into geometry** rather than stored as a matrix.
 * Box-backed text, images, and stamps retain scalar rotation for rendering.
 * Shapes and connectors retain the same scalar only for their editor selection
 * frame; their visible geometry is still baked into points/endpoints. The
 * general `transform` matrix remains deliberately unused.
 *
 * Baking costs a rewrite of the sample arrays per transform. The arrays are
 * small integers, so this remains bounded during interactive transforms.
 */

import { INK_LIMITS } from '../../types/ink';
import type { InkBounds, InkObject, InkSample } from '../../types/ink';
import { decodeSamples, encodeSamples } from './codec';

/** A 2D affine map, applied as `[x', y'] = [a·x + c·y + e, b·x + d·y + f]`. */
export interface InkAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const INK_IDENTITY: InkAffine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translation(dx: number, dy: number): InkAffine {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

/** Scale about a fixed point, so a resize handle drags against its opposite corner. */
export function scaleAbout(
  originX: number,
  originY: number,
  scaleX: number,
  scaleY: number,
): InkAffine {
  return {
    a: scaleX,
    b: 0,
    c: 0,
    d: scaleY,
    e: originX - originX * scaleX,
    f: originY - originY * scaleY,
  };
}

/** Rotate about a fixed point. `radians` is clockwise in screen coordinates. */
export function rotationAbout(originX: number, originY: number, radians: number): InkAffine {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: originX - originX * cos + originY * sin,
    f: originY - originX * sin - originY * cos,
  };
}

export function composeAffine(first: InkAffine, second: InkAffine): InkAffine {
  return {
    a: second.a * first.a + second.c * first.b,
    b: second.b * first.a + second.d * first.b,
    c: second.a * first.c + second.c * first.d,
    d: second.b * first.c + second.d * first.d,
    e: second.a * first.e + second.c * first.f + second.e,
    f: second.b * first.e + second.d * first.f + second.f,
  };
}

export function applyAffine(
  transform: InkAffine,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: transform.a * x + transform.c * y + transform.e,
    y: transform.b * x + transform.d * y + transform.f,
  };
}

/**
 * Uniform scale factor of a transform.
 *
 * Used to scale stroke width with the object. Taken as the geometric mean of
 * the two axis scales so a non-uniform resize still widens the line sensibly
 * rather than picking one axis arbitrarily — ink has no notion of a
 * differently-scaled x and y line width.
 */
export function affineScale(transform: InkAffine): number {
  const determinant = Math.abs(transform.a * transform.d - transform.b * transform.c);
  return Math.sqrt(determinant) || 1;
}

function similarityRotation(transform: InkAffine): number {
  const xLength = Math.hypot(transform.a, transform.b);
  const yLength = Math.hypot(transform.c, transform.d);
  const dot = transform.a * transform.c + transform.b * transform.d;
  const tolerance = Math.max(1, xLength, yLength) * 1e-8;
  if (Math.abs(xLength - yLength) > tolerance || Math.abs(dot) > tolerance) return 0;
  return Math.atan2(transform.b, transform.a);
}

/** Orientation used by the editor frame when an older vector has no metadata. */
export function selectionRotationOf(object: InkObject): number {
  if (object.type === 'text' || object.type === 'image' || object.type === 'stamp') {
    return object.rotation ?? 0;
  }
  if (object.type === 'connector') {
    return object.rotation ?? Math.atan2(object.to.y - object.from.y, object.to.x - object.from.x);
  }
  if (object.type !== 'shape') return 0;
  if (object.rotation !== undefined) return object.rotation;
  if (object.points.length < 4) return 0;
  if (object.shape === 'ellipse' || object.shape === 'star' || object.shape === 'polygon') {
    let centerX = 0;
    let centerY = 0;
    const count = object.points.length / 2;
    for (let index = 0; index + 1 < object.points.length; index += 2) {
      centerX += object.points[index];
      centerY += object.points[index + 1];
    }
    centerX /= count;
    centerY /= count;
    return Math.atan2(object.points[1] - centerY, object.points[0] - centerX);
  }
  return Math.atan2(
    object.points[3] - object.points[1],
    object.points[2] - object.points[0],
  );
}

function clampCoordinate(value: number): number {
  return Math.max(-INK_LIMITS.worldExtent, Math.min(INK_LIMITS.worldExtent, Math.round(value)));
}

function transformSamples(samples: InkSample[], transform: InkAffine): InkSample[] {
  return samples.map((sample) => {
    const point = applyAffine(transform, sample.x, sample.y);
    // Pressure, tilt, twist, and time are properties of how the stroke was
    // drawn, not of where it sits. Moving a stroke must not restyle it.
    return { ...sample, x: clampCoordinate(point.x), y: clampCoordinate(point.y) };
  });
}

/**
 * Applies a transform to one object, returning a new object.
 *
 * Groups are not transformed here: the caller expands a selection to its
 * members first, so every member moves and the group record — which holds only
 * ids — needs no change.
 */
export function transformObject(object: InkObject, transform: InkAffine): InkObject {
  const scale = affineScale(transform);

  switch (object.type) {
    case 'stroke': {
      const samples = transformSamples(decodeSamples(object.samples), transform);
      return {
        ...object,
        samples: encodeSamples(samples),
        brush: { ...object.brush, width: Math.max(1, object.brush.width * scale) },
        bounds: undefined,
      };
    }
    case 'shape': {
      const points = [...object.points];
      for (let index = 0; index + 1 < points.length; index += 2) {
        const moved = applyAffine(transform, points[index], points[index + 1]);
        points[index] = clampCoordinate(moved.x);
        points[index + 1] = clampCoordinate(moved.y);
      }
      return {
        ...object,
        points,
        stroke: { ...object.stroke, width: Math.max(1, object.stroke.width * scale) },
        rotation: selectionRotationOf(object) + similarityRotation(transform),
        bounds: undefined,
      };
    }
    case 'connector': {
      const from = applyAffine(transform, object.from.x, object.from.y);
      const to = applyAffine(transform, object.to.x, object.to.y);
      return {
        ...object,
        from: { ...object.from, x: clampCoordinate(from.x), y: clampCoordinate(from.y) },
        to: { ...object.to, x: clampCoordinate(to.x), y: clampCoordinate(to.y) },
        rotation: selectionRotationOf(object) + similarityRotation(transform),
        bounds: undefined,
      };
    }
    case 'text':
    case 'image':
    case 'stamp': {
      const center = applyAffine(
        transform,
        object.x + object.width / 2,
        object.y + object.height / 2,
      );
      const previousRotation = object.rotation ?? 0;
      const cos = Math.cos(previousRotation);
      const sin = Math.sin(previousRotation);
      const widthVector = {
        x: transform.a * (cos * object.width) + transform.c * (sin * object.width),
        y: transform.b * (cos * object.width) + transform.d * (sin * object.width),
      };
      const heightVector = {
        x: transform.a * (-sin * object.height) + transform.c * (cos * object.height),
        y: transform.b * (-sin * object.height) + transform.d * (cos * object.height),
      };
      const width = Math.max(0, Math.hypot(widthVector.x, widthVector.y));
      const height = Math.max(0, Math.hypot(heightVector.x, heightVector.y));
      const rotation = width > 0
        ? Math.atan2(widthVector.y, widthVector.x)
        : previousRotation + similarityRotation(transform);
      const next = {
        ...object,
        x: clampCoordinate(center.x - width / 2),
        y: clampCoordinate(center.y - height / 2),
        width,
        height,
        rotation,
        bounds: undefined,
      };
      // Type size follows the box, or scaling a sticky note leaves its text
      // the same size in a bigger frame.
      if (next.type === 'text') {
        const widthScale = object.width > 0 ? width / object.width : scale;
        const heightScale = object.height > 0 ? height / object.height : scale;
        next.fontSize = Math.max(1, next.fontSize * Math.sqrt(widthScale * heightScale));
      }
      return next;
    }
    default:
      return object;
  }
}

/** The transform that maps one rectangle onto another. */
export function boundsToBounds(from: InkBounds, to: InkBounds): InkAffine {
  const fromWidth = from.maxX - from.minX;
  const fromHeight = from.maxY - from.minY;
  const scaleX = fromWidth === 0 ? 1 : (to.maxX - to.minX) / fromWidth;
  const scaleY = fromHeight === 0 ? 1 : (to.maxY - to.minY) / fromHeight;
  return {
    a: scaleX,
    b: 0,
    c: 0,
    d: scaleY,
    e: to.minX - from.minX * scaleX,
    f: to.minY - from.minY * scaleY,
  };
}

/** Which handle of a selection box a resize is dragging. */
export type InkResizeHandle =
  | 'nw' | 'n' | 'ne'
  | 'w' | 'e'
  | 'sw' | 's' | 'se';

/**
 * The bounds a resize drag produces.
 *
 * The handle opposite the one being dragged stays fixed, which is what makes a
 * resize feel anchored. `uniform` locks the aspect ratio.
 */
export function resizeBounds(
  bounds: InkBounds,
  handle: InkResizeHandle,
  dx: number,
  dy: number,
  uniform = false,
): InkBounds {
  let { minX, minY, maxX, maxY } = bounds;

  if (handle.includes('w')) minX += dx;
  if (handle.includes('e')) maxX += dx;
  if (handle.includes('n')) minY += dy;
  if (handle.includes('s')) maxY += dy;

  if (uniform) {
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width > 0 && height > 0) {
      const ratio = Math.max(
        Math.abs(maxX - minX) / width,
        Math.abs(maxY - minY) / height,
      );
      const nextWidth = width * ratio;
      const nextHeight = height * ratio;
      if (handle.includes('w')) minX = maxX - nextWidth;
      else maxX = minX + nextWidth;
      if (handle.includes('n')) minY = maxY - nextHeight;
      else maxY = minY + nextHeight;
    }
  }

  // A drag past the opposite edge flips the box rather than inverting it: an
  // inverted rectangle would make every downstream bounds check silently false.
  return {
    minX: Math.min(minX, maxX),
    minY: Math.min(minY, maxY),
    maxX: Math.max(minX, maxX),
    maxY: Math.max(minY, maxY),
  };
}
