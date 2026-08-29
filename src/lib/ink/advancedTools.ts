import type {
  InkArrowhead,
  InkBrushParameters,
  InkConnector,
  InkObject,
  InkSample,
  InkShape,
  InkShapeKind,
  InkStamp,
  InkStroke,
} from '../../types/ink';
import { INK_LIMITS } from '../../types/ink';

import { decodeSamples, encodeSamples } from './codec';

export interface InkPoint {
  x: number;
  y: number;
}

export interface InkShapeStyle {
  stroke: InkBrushParameters;
  fill?: string;
  fillOpacity?: number;
  arrowStart?: InkArrowhead;
  arrowEnd?: InkArrowhead;
}

export interface InkSnapOptions {
  enabled: boolean;
  spacing: number;
}

export const INK_SHAPE_ORDER: InkShapeKind[] = [
  'line',
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'star',
];

export const INK_STAMP_CATALOG = [
  { id: 'check', label: 'Check', glyph: '✓' },
  { id: 'cross', label: 'Cross', glyph: '✕' },
  { id: 'question', label: 'Question', glyph: '?' },
  { id: 'important', label: 'Important', glyph: '!' },
  { id: 'star', label: 'Star', glyph: '★' },
  { id: 'heart', label: 'Heart', glyph: '♥' },
  { id: 'idea', label: 'Idea', glyph: '✦' },
] as const;

export function stampGlyph(symbolId: string): string {
  return INK_STAMP_CATALOG.find((stamp) => stamp.id === symbolId)?.glyph ?? '•';
}

export function snapInkPoint(point: InkPoint, options: InkSnapOptions): InkPoint {
  if (!options.enabled || !Number.isFinite(options.spacing) || options.spacing <= 0) {
    return point;
  }
  return {
    x: clamp(Math.round(point.x / options.spacing) * options.spacing),
    y: clamp(Math.round(point.y / options.spacing) * options.spacing),
  };
}

export function shapePoints(
  kind: InkShapeKind,
  from: InkPoint,
  to: InkPoint,
  uniform = false,
): number[] {
  const end = uniform ? squareEnd(from, to) : to;
  const minX = Math.min(from.x, end.x);
  const minY = Math.min(from.y, end.y);
  const maxX = Math.max(from.x, end.x);
  const maxY = Math.max(from.y, end.y);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  switch (kind) {
    case 'line':
      return [from.x, from.y, end.x, end.y];
    case 'rectangle':
      return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
    case 'triangle':
      return [midX, minY, maxX, maxY, minX, maxY];
    case 'diamond':
      return [midX, minY, maxX, midY, midX, maxY, minX, midY];
    case 'ellipse':
      return radialPoints(midX, midY, (maxX - minX) / 2, (maxY - minY) / 2, 32);
    case 'star':
      return radialPoints(midX, midY, (maxX - minX) / 2, (maxY - minY) / 2, 10, true);
    default:
      return [from.x, from.y, end.x, end.y];
  }
}

export function createInkShape(options: {
  id: string;
  layerId: string;
  kind: InkShapeKind;
  from: InkPoint;
  to: InkPoint;
  style: InkShapeStyle;
  uniform?: boolean;
  sourceStrokeId?: string;
}): InkShape {
  return {
    id: options.id,
    type: 'shape',
    layerId: options.layerId,
    shape: options.kind,
    points: shapePoints(options.kind, options.from, options.to, options.uniform),
    stroke: { ...options.style.stroke },
    ...(options.style.fill ? { fill: options.style.fill } : {}),
    ...(options.style.fillOpacity === undefined ? {} : { fillOpacity: options.style.fillOpacity }),
    ...(options.style.arrowStart ? { arrowStart: options.style.arrowStart } : {}),
    ...(options.style.arrowEnd ? { arrowEnd: options.style.arrowEnd } : {}),
    ...(options.sourceStrokeId ? { sourceStrokeId: options.sourceStrokeId } : {}),
    createdAt: Date.now(),
  };
}

export function createInkConnector(options: {
  id: string;
  layerId: string;
  from: InkPoint;
  to: InkPoint;
  stroke: InkBrushParameters;
  routing?: InkConnector['routing'];
  arrowStart?: InkArrowhead;
  arrowEnd?: InkArrowhead;
}): InkConnector {
  return {
    id: options.id,
    type: 'connector',
    layerId: options.layerId,
    from: { ...options.from },
    to: { ...options.to },
    routing: options.routing ?? 'straight',
    stroke: { ...options.stroke },
    arrowStart: options.arrowStart ?? 'none',
    arrowEnd: options.arrowEnd ?? 'arrow',
    createdAt: Date.now(),
  };
}

export function createInkStamp(options: {
  id: string;
  layerId: string;
  symbolId: string;
  from: InkPoint;
  to: InkPoint;
  color: string;
}): InkStamp {
  return {
    id: options.id,
    type: 'stamp',
    layerId: options.layerId,
    x: Math.min(options.from.x, options.to.x),
    y: Math.min(options.from.y, options.to.y),
    width: Math.max(768, Math.abs(options.to.x - options.from.x)),
    height: Math.max(768, Math.abs(options.to.y - options.from.y)),
    symbolId: options.symbolId,
    color: options.color,
    createdAt: Date.now(),
  };
}

export function snapPointToAngle(from: InkPoint, to: InkPoint, stepDegrees = 15): InkPoint {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) return to;
  const step = (Math.PI / 180) * stepDegrees;
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return {
    x: Math.round(from.x + Math.cos(angle) * length),
    y: Math.round(from.y + Math.sin(angle) * length),
  };
}

export function inkObjectColor(object: InkObject): string | null {
  switch (object.type) {
    case 'stroke':
      return object.brush.color;
    case 'shape':
    case 'connector':
      return object.stroke.color;
    case 'text':
      return object.color;
    case 'stamp':
      return object.color ?? null;
    default:
      return null;
  }
}

/**
 * Returns a line proposal only when the samples are convincingly straight.
 * Recognition never runs implicitly: callers either invoke it explicitly or
 * opt into hold-to-straighten, and undo restores the source stroke.
 */
export function recognizeStraightStroke(stroke: InkStroke, tolerance = 0.035): InkShape | null {
  const samples = decodeSamples(stroke.samples);
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const length = Math.hypot(last.x - first.x, last.y - first.y);
  if (length < 64) return null;

  let furthest = 0;
  for (const sample of samples.slice(1, -1)) {
    furthest = Math.max(furthest, pointLineDistance(sample, first, last));
  }
  if (furthest / length > tolerance) return null;

  return {
    ...createInkShape({
      id: stroke.id,
      layerId: stroke.layerId,
      kind: 'line',
      from: first,
      to: last,
      style: { stroke: stroke.brush },
      sourceStrokeId: stroke.id,
    }),
    ...(stroke.authorId ? { authorId: stroke.authorId } : {}),
    ...(stroke.createdAt === undefined ? {} : { createdAt: stroke.createdAt }),
    updatedAt: Date.now(),
  };
}

/**
 * Proposes a canonical line, rectangle, or ellipse for an explicitly selected
 * stroke. The source object is left untouched until the caller commits the
 * proposal, which keeps recognition reversible through the normal undo stack.
 */
export function recognizeInkShape(stroke: InkStroke): InkShape | null {
  const line = recognizeStraightStroke(stroke);
  if (line) return line;

  const samples = decodeSamples(stroke.samples);
  if (samples.length < 8) return null;
  const xs = samples.map((sample) => sample.x);
  const ys = samples.map((sample) => sample.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  const diagonal = Math.hypot(width, height);
  if (width < 64 || height < 64 || diagonal === 0) return null;
  const last = samples[samples.length - 1];
  if (Math.hypot(samples[0].x - last.x, samples[0].y - last.y) / diagonal > 0.2) {
    return null;
  }

  const edgeScale = Math.min(width, height);
  const rectangleError =
    samples.reduce(
      (total, sample) =>
        total +
        Math.min(
          Math.abs(sample.x - minX),
          Math.abs(sample.x - maxX),
          Math.abs(sample.y - minY),
          Math.abs(sample.y - maxY),
        ) /
          edgeScale,
      0,
    ) / samples.length;

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const ellipseError =
    samples.reduce((total, sample) => {
      const normalizedX = (sample.x - centerX) / radiusX;
      const normalizedY = (sample.y - centerY) / radiusY;
      return total + Math.abs(Math.hypot(normalizedX, normalizedY) - 1);
    }, 0) / samples.length;

  const kind: InkShapeKind | null =
    rectangleError <= 0.08 && rectangleError <= ellipseError
      ? 'rectangle'
      : ellipseError <= 0.16
        ? 'ellipse'
        : null;
  if (!kind) return null;

  return recognizedShape(stroke, kind, { x: minX, y: minY }, { x: maxX, y: maxY });
}

export function smoothInkStroke(stroke: InkStroke, strength = 0.5): InkStroke {
  const samples = decodeSamples(stroke.samples);
  if (samples.length < 3) return stroke;
  const amount = Math.max(0, Math.min(1, strength));
  const smoothed = samples.map((sample, index) => {
    if (index === 0 || index === samples.length - 1) return sample;
    const previous = samples[index - 1];
    const next = samples[index + 1];
    return {
      ...sample,
      x: Math.round(sample.x * (1 - amount) + ((previous.x + sample.x + next.x) / 3) * amount),
      y: Math.round(sample.y * (1 - amount) + ((previous.y + sample.y + next.y) / 3) * amount),
    };
  });
  return { ...stroke, samples: encodeSamples(smoothed), bounds: undefined, updatedAt: Date.now() };
}

export function recolorInkObject(object: InkObject, color: string): InkObject {
  switch (object.type) {
    case 'stroke':
      return { ...object, brush: { ...object.brush, color }, updatedAt: Date.now() };
    case 'shape':
    case 'connector':
      return { ...object, stroke: { ...object.stroke, color }, updatedAt: Date.now() };
    case 'text':
      return { ...object, color, updatedAt: Date.now() };
    case 'stamp':
      return { ...object, color, updatedAt: Date.now() };
    default:
      return object;
  }
}

export function shouldHoldToStraighten(samples: InkSample[], durationMs: number): boolean {
  if (durationMs < 500 || samples.length < 2) return false;
  const temporary: InkStroke = {
    id: 'recognition-probe',
    type: 'stroke',
    layerId: 'recognition-probe',
    brush: {
      kind: 'ballpoint',
      color: '#000',
      opacity: 1,
      width: 64,
      thinning: 0,
      smoothing: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
    },
    samples: encodeSamples(samples),
  };
  return recognizeStraightStroke(temporary) !== null;
}

function squareEnd(from: InkPoint, to: InkPoint): InkPoint {
  const size = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  return {
    x: from.x + Math.sign(to.x - from.x || 1) * size,
    y: from.y + Math.sign(to.y - from.y || 1) * size,
  };
}

function radialPoints(
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  count: number,
  star = false,
): number[] {
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    const scale = star && index % 2 === 1 ? 0.42 : 1;
    points.push(
      clamp(Math.round(cx + Math.cos(angle) * radiusX * scale)),
      clamp(Math.round(cy + Math.sin(angle) * radiusY * scale)),
    );
  }
  return points;
}

function pointLineDistance(point: InkPoint, from: InkPoint, to: InkPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / denominator),
  );
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

function recognizedShape(
  stroke: InkStroke,
  kind: InkShapeKind,
  from: InkPoint,
  to: InkPoint,
): InkShape {
  return {
    ...createInkShape({
      id: stroke.id,
      layerId: stroke.layerId,
      kind,
      from,
      to,
      style: { stroke: stroke.brush },
      sourceStrokeId: stroke.id,
    }),
    ...(stroke.authorId ? { authorId: stroke.authorId } : {}),
    ...(stroke.createdAt === undefined ? {} : { createdAt: stroke.createdAt }),
    updatedAt: Date.now(),
  };
}

function clamp(value: number): number {
  return Math.max(-INK_LIMITS.worldExtent, Math.min(INK_LIMITS.worldExtent, Math.round(value)));
}
