/**
 * Deterministic SVG export from an ink scene.
 *
 * "From the scene" is the point: export walks the stored objects and generates
 * outlines, exactly as the editor does, rather than reading back a canvas. A
 * screenshot of the viewport would carry the current zoom, the device pixel
 * ratio, the selection handles, and whatever happened to be scrolled into view.
 *
 * Determinism is a requirement, not a nicety. Re-exporting an unchanged page
 * must produce byte-identical output, or the source-linked note embeds in
 * Phase 7 churn the vault on every re-export and every revision diff is noise.
 * That means: no clock reads, no `Math.random`, no iteration over unordered
 * maps, and fixed-precision coordinates.
 */

import type {
  InkBounds,
  InkLayer,
  InkObject,
  InkScene,
  InkStroke,
} from '../../types/ink';
import { decodeSamples } from './codec';
import { outlineStroke, strokeBounds } from './stroke';
import type { InkPoint, InkStrokeOutliner } from './stroke';
import { stampGlyph } from './advancedTools';

export interface InkSvgExportOptions {
  /** Region to export. Defaults to the scene's content bounds. */
  bounds?: InkBounds;
  /** Painted behind the content. Omit for a transparent background. */
  background?: string;
  /** Scale factor applied to the SVG's pixel size, not to its coordinates. */
  scale?: number;
  /** Restrict to these object ids, for exporting a selection. */
  objectIds?: string[];
  outliner?: InkStrokeOutliner;
  /** Decimal places for emitted coordinates. */
  precision?: number;
}

const DEFAULT_PRECISION = 2;

/** Fixed-precision formatting, with `-0` and `1.50` normalized away. */
function num(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(precision);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/**
 * Escapes text for an XML attribute or text node.
 *
 * Applied to every value that reaches the output, including colours and layer
 * names, because those come from documents that may have been authored
 * elsewhere.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pointsToPath(points: InkPoint[], precision: number): string {
  if (points.length === 0) return '';
  const parts: string[] = [`M${num(points[0].x, precision)} ${num(points[0].y, precision)}`];
  for (let index = 1; index < points.length; index += 1) {
    parts.push(`L${num(points[index].x, precision)} ${num(points[index].y, precision)}`);
  }
  parts.push('Z');
  return parts.join('');
}

function unionBounds(left: InkBounds | null, right: InkBounds): InkBounds {
  if (!left) return right;
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

/** Bounds of an object, computed rather than trusting a stored `bounds`. */
export function objectBounds(object: InkObject): InkBounds | null {
  switch (object.type) {
    case 'stroke':
      return strokeBounds(decodeSamples(object.samples), object.brush);
    case 'shape': {
      if (object.points.length < 2) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index + 1 < object.points.length; index += 2) {
        const x = object.points[index];
        const y = object.points[index + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const half = object.stroke.width / 2;
      return {
        minX: minX - half,
        minY: minY - half,
        maxX: maxX + half,
        maxY: maxY + half,
      };
    }
    case 'connector': {
      const half = object.stroke.width / 2;
      return {
        minX: Math.min(object.from.x, object.to.x) - half,
        minY: Math.min(object.from.y, object.to.y) - half,
        maxX: Math.max(object.from.x, object.to.x) + half,
        maxY: Math.max(object.from.y, object.to.y) + half,
      };
    }
    case 'text':
    case 'image':
    case 'stamp':
      return {
        minX: object.x,
        minY: object.y,
        maxX: object.x + object.width,
        maxY: object.y + object.height,
      };
    default:
      return null;
  }
}

/** Content bounds of every exportable object in the scene. */
export function sceneBounds(scene: InkScene): InkBounds {
  let bounds: InkBounds | null = null;
  for (const id of scene.objectOrder) {
    const object = scene.objects[id];
    if (!object) continue;
    if (object.type === 'shape' && object.guide) continue;
    const layer = scene.layers[object.layerId];
    if (layer && layer.exported === false) continue;
    const objectBound = objectBounds(object);
    if (objectBound) bounds = unionBounds(bounds, objectBound);
  }
  return bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

function layerIsVisible(layer: InkLayer | undefined): boolean {
  if (!layer) return true;
  return layer.visible && layer.exported !== false;
}

function strokeElement(
  stroke: InkStroke,
  outliner: InkStrokeOutliner,
  precision: number,
): string {
  const samples = decodeSamples(stroke.samples);
  const outline = outliner(samples, stroke.brush);
  if (outline.length === 0) return '';
  const path = pointsToPath(outline, precision);
  const opacity = stroke.brush.opacity;
  const opacityAttribute = opacity >= 1 ? '' : ` fill-opacity="${num(opacity, 3)}"`;
  return `<path d="${path}" fill="${escapeXml(stroke.brush.color)}"${opacityAttribute}/>`;
}

function shapeElement(object: Extract<InkObject, { type: 'shape' }>, precision: number): string {
  const points: string[] = [];
  for (let index = 0; index + 1 < object.points.length; index += 2) {
    points.push(`${num(object.points[index], precision)},${num(object.points[index + 1], precision)}`);
  }
  if (points.length === 0) return '';
  const closed = object.shape !== 'line' && object.shape !== 'polyline' && object.shape !== 'arc';
  const tag = closed ? 'polygon' : 'polyline';
  const fill = closed && object.fill ? escapeXml(object.fill) : 'none';
  const dash = object.stroke.dash === 'dashed'
    ? ` stroke-dasharray="${num(object.stroke.width * 4, precision)} ${num(object.stroke.width * 3, precision)}"`
    : object.stroke.dash === 'dotted'
      ? ` stroke-dasharray="${num(object.stroke.width, precision)} ${num(object.stroke.width * 2, precision)}"`
      : '';
  const fillOpacity = closed && object.fill && object.fillOpacity !== undefined
    ? ` fill-opacity="${num(object.fillOpacity, 3)}"`
    : '';
  const base = (
    `<${tag} points="${points.join(' ')}" fill="${fill}"` +
    fillOpacity +
    ` stroke="${escapeXml(object.stroke.color)}"` +
    ` stroke-width="${num(object.stroke.width, precision)}"` +
    dash + ' stroke-linecap="round" stroke-linejoin="round"/>'
  );
  const arrows = arrowElements(object.points, object.arrowStart, object.arrowEnd, object.stroke.color, object.stroke.width, precision);
  return arrows ? `<g>${base}${arrows}</g>` : base;
}

function connectorElement(object: Extract<InkObject, { type: 'connector' }>, precision: number): string {
  const points = object.routing === 'orthogonal'
    ? [object.from.x, object.from.y, (object.from.x + object.to.x) / 2, object.from.y,
      (object.from.x + object.to.x) / 2, object.to.y, object.to.x, object.to.y]
    : [object.from.x, object.from.y, object.to.x, object.to.y];
  const pairs: string[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    pairs.push(`${num(points[index], precision)},${num(points[index + 1], precision)}`);
  }
  const dash = object.stroke.dash === 'dashed'
    ? ` stroke-dasharray="${num(object.stroke.width * 4, precision)} ${num(object.stroke.width * 3, precision)}"`
    : object.stroke.dash === 'dotted'
      ? ` stroke-dasharray="${num(object.stroke.width, precision)} ${num(object.stroke.width * 2, precision)}"`
      : '';
  const base = `<polyline points="${pairs.join(' ')}" fill="none" stroke="${escapeXml(object.stroke.color)}" stroke-width="${num(object.stroke.width, precision)}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`;
  const arrows = arrowElements(points, object.arrowStart, object.arrowEnd, object.stroke.color, object.stroke.width, precision);
  return arrows ? `<g>${base}${arrows}</g>` : base;
}

function arrowElements(
  points: number[],
  start: 'none' | 'arrow' | 'open' | 'dot' | undefined,
  end: 'none' | 'arrow' | 'open' | 'dot' | undefined,
  color: string,
  width: number,
  precision: number,
): string {
  if (points.length < 4) return '';
  const elements: string[] = [];
  if (start && start !== 'none') {
    elements.push(arrowElement(points[0], points[1], points[2], points[3], start, color, width, precision));
  }
  if (end && end !== 'none') {
    const last = points.length - 2;
    elements.push(arrowElement(points[last], points[last + 1], points[last - 2], points[last - 1], end, color, width, precision));
  }
  return elements.join('');
}

function arrowElement(
  x: number,
  y: number,
  previousX: number,
  previousY: number,
  kind: 'arrow' | 'open' | 'dot',
  color: string,
  width: number,
  precision: number,
): string {
  const size = Math.max(width * 4, 160);
  if (kind === 'dot') {
    return `<circle cx="${num(x, precision)}" cy="${num(y, precision)}" r="${num(size * 0.45, precision)}" fill="${escapeXml(color)}"/>`;
  }
  const angle = Math.atan2(y - previousY, x - previousX);
  const left = [x - Math.cos(angle - Math.PI / 6) * size, y - Math.sin(angle - Math.PI / 6) * size];
  const right = [x - Math.cos(angle + Math.PI / 6) * size, y - Math.sin(angle + Math.PI / 6) * size];
  const path = `${num(left[0], precision)},${num(left[1], precision)} ${num(x, precision)},${num(y, precision)} ${num(right[0], precision)},${num(right[1], precision)}`;
  return kind === 'arrow'
    ? `<polygon points="${path}" fill="${escapeXml(color)}"/>`
    : `<polyline points="${path}" fill="none" stroke="${escapeXml(color)}" stroke-width="${num(width, precision)}"/>`;
}

function textElement(object: Extract<InkObject, { type: 'text' }>, precision: number): string {
  // Text is emitted as a single element with no markup: the schema stores plain
  // text, and anything richer would mean parsing document content into XML.
  const inset = object.sticky ? Math.max(32, object.fontSize * 0.35) : 0;
  const background = object.sticky || object.backgroundColor
    ? `<rect x="${num(object.x, precision)}" y="${num(object.y, precision)}" width="${num(object.width, precision)}" height="${num(object.height, precision)}" fill="${escapeXml(object.backgroundColor ?? '#fef3a7')}"/>`
    : '';
  const lines = object.text.split('\n').map((line, index) =>
    `<tspan x="${num(object.x + inset, precision)}" y="${num(object.y + inset + object.fontSize * (index + 1), precision)}">${escapeXml(line)}</tspan>`,
  ).join('');
  const text = `<text fill="${escapeXml(object.color)}" font-size="${num(object.fontSize, precision)}"` +
    (object.fontFamily ? ` font-family="${escapeXml(object.fontFamily)}"` : '') +
    `>${lines}</text>`;
  return background ? `<g>${background}${text}</g>` : text;
}

/**
 * Renders a scene to a standalone SVG document.
 *
 * Images and stamps are emitted as placeholder rectangles here. Embedding them
 * needs asset bytes, which means an async vault read — that belongs to the
 * Phase 7 export job, not to this pure function.
 */
export function sceneToSvg(scene: InkScene, options: InkSvgExportOptions = {}): string {
  const precision = options.precision ?? DEFAULT_PRECISION;
  const outliner = options.outliner ?? outlineStroke;
  const bounds = options.bounds ?? sceneBounds(scene);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const scale = options.scale ?? 1;
  const only = options.objectIds ? new Set(options.objectIds) : null;

  const body: string[] = [];
  if (options.background) {
    body.push(
      `<rect x="${num(bounds.minX, precision)}" y="${num(bounds.minY, precision)}"` +
        ` width="${num(width, precision)}" height="${num(height, precision)}"` +
        ` fill="${escapeXml(options.background)}"/>`,
    );
  }

  // Walk `objectOrder`, never `Object.keys(objects)`: paint order is document
  // data, and key order is not something the format may depend on.
  for (const id of scene.objectOrder) {
    const object = scene.objects[id];
    if (!object) continue;
    if (object.type === 'shape' && object.guide) continue;
    if (only && !only.has(id)) continue;
    const layer = scene.layers[object.layerId];
    if (!layerIsVisible(layer)) continue;

    let element = '';
    switch (object.type) {
      case 'stroke':
        element = strokeElement(object, outliner, precision);
        break;
      case 'shape':
        element = shapeElement(object, precision);
        break;
      case 'connector':
        element = connectorElement(object, precision);
        break;
      case 'text':
        element = textElement(object, precision);
        break;
      case 'stamp':
        element = `<text x="${num(object.x, precision)}" y="${num(object.y + object.height, precision)}" fill="${escapeXml(object.color ?? '#1f2933')}" font-size="${num(object.height, precision)}">${escapeXml(stampGlyph(object.symbolId))}</text>`;
        break;
      default:
        element = '';
    }
    if (!element) continue;

    const layerOpacity = layer && layer.opacity < 1 ? ` opacity="${num(layer.opacity, 3)}"` : '';
    body.push(layerOpacity ? `<g${layerOpacity}>${element}</g>` : element);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width * scale, precision)}"` +
    ` height="${num(height * scale, precision)}"` +
    ` viewBox="${num(bounds.minX, precision)} ${num(bounds.minY, precision)}` +
    ` ${num(width, precision)} ${num(height, precision)}">` +
    body.join('') +
    '</svg>'
  );
}
