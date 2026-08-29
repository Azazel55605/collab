import type {
  SvgEditableType,
  SvgNode,
  SvgPrimitiveType,
  SvgRect,
  SvgScene,
  SvgSlot,
  SvgStyle,
} from '../types/svg';

/**
 * Pure parse/serialize/geometry helpers for the SVG vector editor. Everything
 * here is DOM-light (uses the platform `DOMParser`/`XMLSerializer`, available
 * in the app and in jsdom tests) and holds no React state, so the geometry math
 * and round-trip guarantees can be unit-tested directly.
 *
 * Design: "preserve & passthrough". Only recognized *top-level* primitives
 * become editable {@link SvgNode}s; `<defs>`, gradients, filters, `<style>`,
 * groups, `<use>`, and anything else are kept verbatim as raw slots and emitted
 * unchanged. Geometry is always in the SVG's own user units.
 */

const EDITABLE_TAGS: Record<string, SvgEditableType> = {
  rect: 'rect',
  ellipse: 'ellipse',
  circle: 'circle',
  line: 'line',
  text: 'text',
  polyline: 'polyline',
  polygon: 'polygon',
  path: 'path',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_VIEWBOX: SvgRect = { x: 0, y: 0, width: 300, height: 150 };

let idCounter = 0;
export function makeSvgId(): string {
  idCounter += 1;
  return `s${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function num(value: string | null | undefined, fallback = 0): number {
  if (value == null) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse a unitless (or `px`) length; returns null for %, em, or missing. */
function pxLength(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (/^-?\d*\.?\d+(px)?$/.test(trimmed)) return Number.parseFloat(trimmed);
  return null;
}

function parseStyleAttr(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const key = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function styleMapToString(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([key, val]) => `${key}: ${val}`)
    .join('; ');
}

/**
 * Read fill/stroke/stroke-width/opacity from presentation attributes, falling
 * back to inline `style` props. Returns the extracted style plus the remaining
 * inline-style declarations (so unrelated CSS is preserved on serialize).
 */
function extractStyle(el: Element): { style: SvgStyle; leftoverStyle: string } {
  const inline = parseStyleAttr(el.getAttribute('style'));
  const read = (prop: string): string | null => {
    if (inline[prop] != null) {
      const value = inline[prop];
      delete inline[prop];
      return value;
    }
    return el.getAttribute(prop);
  };
  const fill = read('fill');
  const stroke = read('stroke');
  const strokeWidthRaw = read('stroke-width');
  const opacityRaw = read('opacity');
  return {
    style: {
      fill: fill,
      stroke: stroke,
      strokeWidth: strokeWidthRaw != null ? num(strokeWidthRaw, 0) : null,
      opacity: opacityRaw != null ? num(opacityRaw, 1) : null,
    },
    leftoverStyle: styleMapToString(inline),
  };
}

/** Attributes consumed directly per type; everything else lands in extraAttrs. */
const GEOMETRY_ATTRS: Record<SvgEditableType, string[]> = {
  rect: ['x', 'y', 'width', 'height'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  text: ['x', 'y', 'font-size'],
  polyline: ['points'],
  polygon: ['points'],
  path: ['d'],
};

const HANDLED_ATTRS = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'opacity',
  'transform',
  'style',
  'data-cid',
]);

function parseNode(el: Element, type: SvgEditableType): SvgNode {
  const { style, leftoverStyle } = extractStyle(el);
  const consumed = new Set([...GEOMETRY_ATTRS[type], ...HANDLED_ATTRS]);
  const extraAttrs: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (consumed.has(attr.name)) continue;
    extraAttrs[attr.name] = attr.value;
  }
  if (leftoverStyle) extraAttrs.style = leftoverStyle;

  const node: SvgNode = {
    id: el.getAttribute('data-cid') || makeSvgId(),
    type,
    style,
    extraAttrs,
    transform: el.getAttribute('transform') ?? undefined,
  };

  switch (type) {
    case 'rect':
      node.x = num(el.getAttribute('x'));
      node.y = num(el.getAttribute('y'));
      node.width = num(el.getAttribute('width'));
      node.height = num(el.getAttribute('height'));
      break;
    case 'circle':
      node.cx = num(el.getAttribute('cx'));
      node.cy = num(el.getAttribute('cy'));
      node.r = num(el.getAttribute('r'));
      break;
    case 'ellipse':
      node.cx = num(el.getAttribute('cx'));
      node.cy = num(el.getAttribute('cy'));
      node.rx = num(el.getAttribute('rx'));
      node.ry = num(el.getAttribute('ry'));
      break;
    case 'line':
      node.x1 = num(el.getAttribute('x1'));
      node.y1 = num(el.getAttribute('y1'));
      node.x2 = num(el.getAttribute('x2'));
      node.y2 = num(el.getAttribute('y2'));
      break;
    case 'text':
      node.x = num(el.getAttribute('x'));
      node.y = num(el.getAttribute('y'));
      node.fontSize = pxLength(el.getAttribute('font-size')) ?? 16;
      node.text = el.textContent ?? '';
      break;
    case 'polyline':
    case 'polygon':
      node.points = el.getAttribute('points') ?? '';
      break;
    case 'path':
      node.d = el.getAttribute('d') ?? '';
      break;
  }
  return node;
}

function parseViewBox(root: Element): SvgRect {
  const raw = root.getAttribute('viewBox');
  if (raw) {
    const parts = raw.split(/[\s,]+/).map((p) => Number.parseFloat(p));
    if (
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n)) &&
      parts[2] > 0 &&
      parts[3] > 0
    ) {
      return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  }
  const w = pxLength(root.getAttribute('width'));
  const h = pxLength(root.getAttribute('height'));
  if (w && h && w > 0 && h > 0) return { x: 0, y: 0, width: w, height: h };
  return { ...DEFAULT_VIEWBOX };
}

export class SvgParseError extends Error {}

export function parseSvg(text: string): SvgScene {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  const root = doc.documentElement;
  if (parseError || !root || root.tagName.toLowerCase() !== 'svg') {
    throw new SvgParseError('File is not valid SVG markup.');
  }

  const viewBox = parseViewBox(root);
  const rootAttrs: Record<string, string> = {};
  for (const attr of Array.from(root.attributes)) {
    if (attr.name === 'viewBox' || attr.name === 'width' || attr.name === 'height') continue;
    rootAttrs[attr.name] = attr.value;
  }
  if (!rootAttrs.xmlns) rootAttrs.xmlns = SVG_NS;

  const serializer = new XMLSerializer();
  const slots: SvgSlot[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      if ((child.textContent ?? '').trim().length === 0) continue;
      slots.push({ kind: 'raw', markup: serializer.serializeToString(child) });
      continue;
    }
    if (child.nodeType !== 1 /* element */) {
      // comments, CDATA, etc. — preserve verbatim
      slots.push({ kind: 'raw', markup: serializer.serializeToString(child) });
      continue;
    }
    const el = child as Element;
    const type = EDITABLE_TAGS[el.tagName.toLowerCase()];
    if (type) {
      slots.push({ kind: 'node', node: parseNode(el, type) });
    } else {
      slots.push({ kind: 'raw', markup: serializer.serializeToString(el) });
    }
  }

  return {
    viewBox,
    width: pxLength(root.getAttribute('width')),
    height: pxLength(root.getAttribute('height')),
    rootAttrs,
    slots,
  };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n: number): string {
  // Trim floating noise while keeping precision for real edits.
  return Number.parseFloat(n.toFixed(3)).toString();
}

function geometryAttrs(node: SvgNode): Record<string, string> {
  switch (node.type) {
    case 'rect':
      return {
        x: fmt(node.x ?? 0),
        y: fmt(node.y ?? 0),
        width: fmt(node.width ?? 0),
        height: fmt(node.height ?? 0),
      };
    case 'circle':
      return { cx: fmt(node.cx ?? 0), cy: fmt(node.cy ?? 0), r: fmt(node.r ?? 0) };
    case 'ellipse':
      return {
        cx: fmt(node.cx ?? 0),
        cy: fmt(node.cy ?? 0),
        rx: fmt(node.rx ?? 0),
        ry: fmt(node.ry ?? 0),
      };
    case 'line':
      return {
        x1: fmt(node.x1 ?? 0),
        y1: fmt(node.y1 ?? 0),
        x2: fmt(node.x2 ?? 0),
        y2: fmt(node.y2 ?? 0),
      };
    case 'text':
      return { x: fmt(node.x ?? 0), y: fmt(node.y ?? 0), 'font-size': fmt(node.fontSize ?? 16) };
    case 'polyline':
    case 'polygon':
      return { points: node.points ?? '' };
    case 'path':
      return { d: node.d ?? '' };
  }
}

function styleAttrs(style: SvgStyle): Record<string, string> {
  const out: Record<string, string> = {};
  if (style.fill != null) out.fill = style.fill;
  if (style.stroke != null) out.stroke = style.stroke;
  if (style.strokeWidth != null) out['stroke-width'] = fmt(style.strokeWidth);
  if (style.opacity != null) out.opacity = fmt(style.opacity);
  return out;
}

export function serializeNode(node: SvgNode, indent = '  '): string {
  const attrs: Record<string, string> = {
    ...geometryAttrs(node),
    ...styleAttrs(node.style),
  };
  if (node.transform) attrs.transform = node.transform;
  Object.assign(attrs, node.extraAttrs);

  const attrStr = Object.entries(attrs)
    .map(([key, val]) => `${key}="${escapeAttr(val)}"`)
    .join(' ');
  const open = `${node.type}${attrStr ? ` ${attrStr}` : ''}`;
  if (node.type === 'text') {
    return `${indent}<${open}>${escapeText(node.text ?? '')}</text>`;
  }
  return `${indent}<${open} />`;
}

export function serializeScene(scene: SvgScene): string {
  const rootAttrs = { ...scene.rootAttrs };
  const parts: string[] = [
    `viewBox="${fmt(scene.viewBox.x)} ${fmt(scene.viewBox.y)} ${fmt(scene.viewBox.width)} ${fmt(scene.viewBox.height)}"`,
  ];
  if (scene.width != null) parts.push(`width="${fmt(scene.width)}"`);
  if (scene.height != null) parts.push(`height="${fmt(scene.height)}"`);
  const rootAttrStr = Object.entries(rootAttrs)
    .map(([key, val]) => `${key}="${escapeAttr(val)}"`)
    .join(' ');

  const body = scene.slots
    .map((slot) => (slot.kind === 'node' ? serializeNode(slot.node) : `  ${slot.markup}`))
    .join('\n');

  return `<svg ${rootAttrStr} ${parts.join(' ')}>\n${body}\n</svg>\n`;
}

// ---------------------------------------------------------------------------
// Geometry operations (pure — return the mutated field set; callers clone)
// ---------------------------------------------------------------------------

/**
 * Axis-aligned bounds in user units for primitives with known geometry.
 * Returns null for text (measured in the DOM) and path/polyline/polygon
 * (opaque geometry), whose bounds the caller derives from the rendered node.
 */
export function nodeBounds(node: SvgNode): SvgRect | null {
  switch (node.type) {
    case 'rect':
      return { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 };
    case 'circle': {
      const r = node.r ?? 0;
      return { x: (node.cx ?? 0) - r, y: (node.cy ?? 0) - r, width: r * 2, height: r * 2 };
    }
    case 'ellipse': {
      const rx = node.rx ?? 0;
      const ry = node.ry ?? 0;
      return { x: (node.cx ?? 0) - rx, y: (node.cy ?? 0) - ry, width: rx * 2, height: ry * 2 };
    }
    case 'line': {
      const x1 = node.x1 ?? 0;
      const y1 = node.y1 ?? 0;
      const x2 = node.x2 ?? 0;
      const y2 = node.y2 ?? 0;
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
    default:
      return null;
  }
}

function composeTranslate(transform: string | undefined, dx: number, dy: number): string {
  const translate = `translate(${fmt(dx)}, ${fmt(dy)})`;
  return transform ? `${translate} ${transform}` : translate;
}

export function translateNode(node: SvgNode, dx: number, dy: number): SvgNode {
  const next = { ...node };
  switch (node.type) {
    case 'rect':
    case 'text':
      next.x = (node.x ?? 0) + dx;
      next.y = (node.y ?? 0) + dy;
      break;
    case 'circle':
    case 'ellipse':
      next.cx = (node.cx ?? 0) + dx;
      next.cy = (node.cy ?? 0) + dy;
      break;
    case 'line':
      next.x1 = (node.x1 ?? 0) + dx;
      next.y1 = (node.y1 ?? 0) + dy;
      next.x2 = (node.x2 ?? 0) + dx;
      next.y2 = (node.y2 ?? 0) + dy;
      break;
    default:
      // path / polyline / polygon: move via transform composition
      next.transform = composeTranslate(node.transform, dx, dy);
      break;
  }
  return next;
}

/** Resize a box-shaped primitive (rect/ellipse/circle) to new bounds. */
export function resizeNodeToBounds(node: SvgNode, box: SvgRect): SvgNode {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const next = { ...node };
  switch (node.type) {
    case 'rect':
      next.x = box.x;
      next.y = box.y;
      next.width = width;
      next.height = height;
      break;
    case 'ellipse':
      next.rx = width / 2;
      next.ry = height / 2;
      next.cx = box.x + width / 2;
      next.cy = box.y + height / 2;
      break;
    case 'circle':
      next.r = Math.min(width, height) / 2;
      next.cx = box.x + width / 2;
      next.cy = box.y + height / 2;
      break;
    default:
      break;
  }
  return next;
}

export function setLineEndpoint(
  node: SvgNode,
  which: 'start' | 'end',
  x: number,
  y: number,
): SvgNode {
  if (node.type !== 'line') return node;
  return which === 'start' ? { ...node, x1: x, y1: y } : { ...node, x2: x, y2: y };
}

export function setNodeStyle(node: SvgNode, patch: Partial<SvgStyle>): SvgNode {
  return { ...node, style: { ...node.style, ...patch } };
}

export function setNodeText(node: SvgNode, text: string): SvgNode {
  return node.type === 'text' ? { ...node, text } : node;
}

export function setNodeFontSize(node: SvgNode, fontSize: number): SvgNode {
  return node.type === 'text' ? { ...node, fontSize: Math.max(1, fontSize) } : node;
}

const DEFAULT_STYLE_FOR: Record<SvgPrimitiveType, SvgStyle> = {
  rect: { fill: '#38bdf8', stroke: null, strokeWidth: null, opacity: null },
  ellipse: { fill: '#38bdf8', stroke: null, strokeWidth: null, opacity: null },
  circle: { fill: '#38bdf8', stroke: null, strokeWidth: null, opacity: null },
  line: { fill: null, stroke: '#38bdf8', strokeWidth: 3, opacity: null },
  text: { fill: '#f8fafc', stroke: null, strokeWidth: null, opacity: null },
};

/** Create a primitive filling the given box, using a sensible default style. */
export function createNode(type: SvgPrimitiveType, box: SvgRect, style?: SvgStyle): SvgNode {
  const id = makeSvgId();
  const s = style ?? DEFAULT_STYLE_FOR[type];
  const base: SvgNode = { id, type, style: { ...s }, extraAttrs: {} };
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  switch (type) {
    case 'rect':
      return { ...base, x: box.x, y: box.y, width, height };
    case 'ellipse':
      return {
        ...base,
        cx: box.x + width / 2,
        cy: box.y + height / 2,
        rx: width / 2,
        ry: height / 2,
      };
    case 'circle':
      return {
        ...base,
        cx: box.x + width / 2,
        cy: box.y + height / 2,
        r: Math.min(width, height) / 2,
      };
    case 'line':
      return { ...base, x1: box.x, y1: box.y, x2: box.x + width, y2: box.y + height };
    case 'text':
      return {
        ...base,
        x: box.x,
        y: box.y + Math.max(12, height),
        fontSize: Math.max(12, Math.round(height)),
        text: 'Text',
      };
  }
}

// ---------------------------------------------------------------------------
// Scene-level helpers
// ---------------------------------------------------------------------------

export function findNode(scene: SvgScene, id: string): SvgNode | null {
  for (const slot of scene.slots) {
    if (slot.kind === 'node' && slot.node.id === id) return slot.node;
  }
  return null;
}

export function updateNode(
  scene: SvgScene,
  id: string,
  updater: (node: SvgNode) => SvgNode,
): SvgScene {
  return {
    ...scene,
    slots: scene.slots.map((slot) =>
      slot.kind === 'node' && slot.node.id === id
        ? { kind: 'node', node: updater(slot.node) }
        : slot,
    ),
  };
}

export function addNode(scene: SvgScene, node: SvgNode): SvgScene {
  return { ...scene, slots: [...scene.slots, { kind: 'node', node }] };
}

export function removeNode(scene: SvgScene, id: string): SvgScene {
  return {
    ...scene,
    slots: scene.slots.filter((slot) => !(slot.kind === 'node' && slot.node.id === id)),
  };
}

/** Move a node one step forward/backward in paint order among all slots. */
export function reorderNode(
  scene: SvgScene,
  id: string,
  direction: 'forward' | 'backward',
): SvgScene {
  const index = scene.slots.findIndex((slot) => slot.kind === 'node' && slot.node.id === id);
  if (index === -1) return scene;
  const target = direction === 'forward' ? index + 1 : index - 1;
  if (target < 0 || target >= scene.slots.length) return scene;
  const slots = [...scene.slots];
  [slots[index], slots[target]] = [slots[target], slots[index]];
  return { ...scene, slots };
}
