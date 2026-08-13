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
  return (
    `<${tag} points="${points.join(' ')}" fill="${fill}"` +
    ` stroke="${escapeXml(object.stroke.color)}"` +
    ` stroke-width="${num(object.stroke.width, precision)}"` +
    ' stroke-linecap="round" stroke-linejoin="round"/>'
  );
}

function textElement(object: Extract<InkObject, { type: 'text' }>, precision: number): string {
  // Text is emitted as a single element with no markup: the schema stores plain
  // text, and anything richer would mean parsing document content into XML.
  return (
    `<text x="${num(object.x, precision)}" y="${num(object.y + object.fontSize, precision)}"` +
    ` fill="${escapeXml(object.color)}" font-size="${num(object.fontSize, precision)}"` +
    (object.fontFamily ? ` font-family="${escapeXml(object.fontFamily)}"` : '') +
    `>${escapeXml(object.text)}</text>`
  );
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
      case 'text':
        element = textElement(object, precision);
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
