/**
 * `.ink` document domain: creation, parsing, validation, normalization,
 * migration, and deterministic serialization.
 *
 * Rules this module enforces, from
 * `docs/plans/digital-ink-phase0-contract.md`:
 *
 * - Page, layer, object, and brush identities are stable and unique.
 * - An object referencing a layer the page no longer has is **repaired onto the
 *   bottom layer, not dropped**. Ink is the user's handwriting; losing a stroke
 *   because a layer record went missing is the worst outcome available.
 * - Non-finite and out-of-world geometry is rejected. A NaN coordinate is not a
 *   point at the origin.
 * - Unknown fields are preserved verbatim at document, page, layer, and object
 *   level, so a file written by a newer build survives a round trip here.
 * - A document from a newer schema version is never silently downgraded: it is
 *   reported as read-only rather than normalized into this build's shape.
 * - Serialization is deterministic — same document in, same bytes out.
 *
 * The bounded structural counterpart on the Rust side is
 * `crates/collab-documents/src/ink.rs`; keep the limits in step.
 */
import {
  INK_DOCUMENT_KIND,
  INK_LIMITS,
  INK_PAGE_PRESETS,
  INK_SAMPLE_RANGES,
  INK_SCHEMA_VERSION,
} from '../../types/ink';
import type {
  InkArrowhead,
  InkBrushKind,
  InkBrushParameters,
  InkBrushPreset,
  InkConnector,
  InkDocument,
  InkLayer,
  InkObject,
  InkObjectLink,
  InkPage,
  InkPageBackground,
  InkSampleChannels,
  InkScene,
  InkShapeKind,
  InkStroke,
  InkSwatch,
} from '../../types/ink';

import { sampleCount } from './codec';
import { INK_COLOR_TOKENS } from './colors';

export type InkDocumentErrorCode =
  | 'invalid-json'
  | 'not-an-object'
  | 'wrong-kind'
  | 'invalid-schema-version'
  | 'invalid-structure'
  | 'limit-exceeded';

export class InkDocumentError extends Error {
  readonly code: InkDocumentErrorCode;

  constructor(code: InkDocumentErrorCode, message: string) {
    super(message);
    this.name = 'InkDocumentError';
    this.code = code;
  }
}

/**
 * How this build can handle a stored document.
 * - `supported`: normalize and edit freely.
 * - `newer`: readable identity only — open read-only so this build cannot strip
 *   fields it does not understand.
 */
export type InkSchemaSupport = 'supported' | 'newer';

export interface InkDocumentInspection {
  support: InkSchemaSupport;
  schemaVersion: number;
  document: InkDocument;
  /** Non-fatal repairs applied while normalizing. Surfaced, never silent. */
  warnings: string[];
}

const BRUSH_KINDS: ReadonlySet<string> = new Set<InkBrushKind>([
  'ballpoint',
  'fountain',
  'technical',
  'pencil',
  'marker',
  'brush',
  'highlighter',
]);

const OBJECT_TYPES: ReadonlySet<string> = new Set([
  'stroke',
  'shape',
  'connector',
  'text',
  'image',
  'stamp',
  'group',
]);

const BACKGROUND_PATTERNS: ReadonlySet<string> = new Set([
  'blank',
  'ruled',
  'grid',
  'dotted',
  'staff',
  'storyboard',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** A finite number inside the world bounds. */
function isDrawableCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= INK_LIMITS.worldExtent
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Fields this build understands, so everything else can be carried through. */
const KNOWN_DOCUMENT_FIELDS = new Set([
  'kind',
  'schemaVersion',
  'id',
  'name',
  'createdAt',
  'updatedAt',
  'settings',
  'pages',
  'pageOrder',
  'brushes',
  'swatches',
  'metadata',
]);

const KNOWN_PAGE_FIELDS = new Set(['id', 'name', 'mode', 'width', 'height', 'background', 'scene']);

const KNOWN_LAYER_FIELDS = new Set(['id', 'name', 'visible', 'locked', 'opacity', 'exported']);

/** Copies fields this build does not know, so a newer file round-trips. */
function preserveUnknown(
  source: Record<string, unknown>,
  known: ReadonlySet<string>,
  target: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    if (!known.has(key)) target[key] = source[key];
  }
}

/* -------------------------------------------------------------------------
 * Creation
 * ---------------------------------------------------------------------- */

export const INK_DEFAULT_BRUSHES: Readonly<Record<string, InkBrushPreset>> = {
  ballpoint: {
    id: 'ballpoint',
    name: 'Ballpoint',
    kind: 'ballpoint',
    color: INK_COLOR_TOKENS.foreground,
    opacity: 1,
    width: 96,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    taperStart: 0,
    taperEnd: 0,
  },
  fountain: {
    id: 'fountain',
    name: 'Fountain pen',
    kind: 'fountain',
    color: INK_COLOR_TOKENS.blue,
    opacity: 1,
    width: 128,
    thinning: 0.75,
    smoothing: 0.6,
    streamline: 0.5,
    taperStart: 64,
    taperEnd: 128,
  },
  pencil: {
    id: 'pencil',
    name: 'Pencil',
    kind: 'pencil',
    color: INK_COLOR_TOKENS.foreground,
    opacity: 0.85,
    width: 80,
    thinning: 0.6,
    smoothing: 0.35,
    streamline: 0.25,
    taperStart: 0,
    taperEnd: 0,
    simulatePressure: true,
  },
  marker: {
    id: 'marker',
    name: 'Marker',
    kind: 'marker',
    color: INK_COLOR_TOKENS.red,
    opacity: 1,
    width: 224,
    thinning: 0.15,
    smoothing: 0.6,
    streamline: 0.45,
    taperStart: 0,
    taperEnd: 0,
  },
  highlighter: {
    id: 'highlighter',
    name: 'Highlighter',
    kind: 'highlighter',
    color: '#ffd23f',
    opacity: 0.4,
    width: 384,
    thinning: 0,
    smoothing: 0.5,
    streamline: 0.5,
    taperStart: 0,
    taperEnd: 0,
  },
  technical: {
    id: 'technical',
    name: 'Technical pen',
    kind: 'technical',
    color: INK_COLOR_TOKENS.foreground,
    opacity: 1,
    width: 48,
    thinning: 0,
    smoothing: 0.7,
    streamline: 0.6,
    taperStart: 0,
    taperEnd: 0,
  },
};

export interface CreateInkDocumentOptions {
  name: string;
  id?: string;
  mode?: 'fixed' | 'infinite';
  preset?: keyof typeof INK_PAGE_PRESETS;
  background?: InkPageBackground;
  landscape?: boolean;
  /** Fixed timestamp, for deterministic tests and fixtures. */
  timestamp?: string;
}

/** A blank scene with one layer. Every page needs at least one. */
export function createInkScene(layerId = 'layer-1'): InkScene {
  return {
    layers: {
      [layerId]: { id: layerId, name: 'Layer 1', visible: true, locked: false, opacity: 1 },
    },
    layerOrder: [layerId],
    objects: {},
    objectOrder: [],
  };
}

export function createInkPage(
  id: string,
  options: Pick<CreateInkDocumentOptions, 'mode' | 'preset' | 'background' | 'landscape'> = {},
): InkPage {
  const preset = INK_PAGE_PRESETS[options.preset ?? 'a4'];
  const landscape = options.landscape === true;
  return {
    id,
    mode: options.mode ?? 'fixed',
    width: landscape ? preset.height : preset.width,
    height: landscape ? preset.width : preset.height,
    background: options.background ?? { pattern: 'blank' },
    scene: createInkScene(`${id}-layer-1`),
  };
}

export function createInkDocument(options: CreateInkDocumentOptions): InkDocument {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const page = createInkPage('page-1', options);
  return {
    kind: INK_DOCUMENT_KIND,
    schemaVersion: INK_SCHEMA_VERSION,
    id: options.id ?? `ink-${timestamp}`,
    name: options.name,
    createdAt: timestamp,
    updatedAt: timestamp,
    settings: {
      defaultPageMode: options.mode ?? 'fixed',
      defaultBackground: options.background ?? { pattern: 'blank' },
      defaultBrushId: 'ballpoint',
    },
    pages: { [page.id]: page },
    pageOrder: [page.id],
    brushes: { ...INK_DEFAULT_BRUSHES },
    swatches: [
      { id: 'ink', color: INK_COLOR_TOKENS.foreground },
      { id: 'blue', color: INK_COLOR_TOKENS.blue },
      { id: 'red', color: INK_COLOR_TOKENS.red },
      { id: 'green', color: INK_COLOR_TOKENS.green },
    ],
  };
}

/* -------------------------------------------------------------------------
 * Normalization
 * ---------------------------------------------------------------------- */

function normalizeBrush(value: unknown, warnings: string[], context: string): InkBrushParameters {
  const source = isObject(value) ? value : {};
  if (!isObject(value)) warnings.push(`${context}: brush was missing; used the default`);

  const kind = BRUSH_KINDS.has(source.kind as string) ? (source.kind as InkBrushKind) : 'ballpoint';

  const brush: InkBrushParameters = {
    kind,
    color: stringOr(source.color, '#1f2933'),
    opacity: clamp(numberOr(source.opacity, 1), 0, 1),
    width: clamp(numberOr(source.width, 96), 1, INK_LIMITS.fixedPageExtent),
    thinning: clamp(numberOr(source.thinning, 0), -1, 1),
    smoothing: clamp(numberOr(source.smoothing, 0.5), 0, 1),
    streamline: clamp(numberOr(source.streamline, 0), 0, 1),
    taperStart: Math.max(0, numberOr(source.taperStart, 0)),
    taperEnd: Math.max(0, numberOr(source.taperEnd, 0)),
  };
  if (typeof source.presetId === 'string') brush.presetId = source.presetId;
  if (source.dash === 'dashed' || source.dash === 'dotted' || source.dash === 'solid') {
    brush.dash = source.dash;
  }
  if (typeof source.simulatePressure === 'boolean') {
    brush.simulatePressure = source.simulatePressure;
  }
  return brush;
}

/**
 * Validates the delta arrays of a stroke.
 *
 * Returns null when the samples cannot be trusted at all. Channels shorter than
 * `x`/`y` are dropped rather than partially applied — a truncated channel is
 * corruption, and half-applying it yields a stroke that looks plausible and is
 * wrong.
 */
function normalizeSamples(
  value: unknown,
  warnings: string[],
  context: string,
): InkSampleChannels | null {
  if (!isObject(value)) return null;
  const xs = value.x;
  const ys = value.y;
  if (!Array.isArray(xs) || !Array.isArray(ys)) return null;
  if (xs.length === 0 || ys.length === 0) return null;

  const count = Math.min(xs.length, ys.length);
  if (count > INK_LIMITS.samplesPerStroke) {
    throw new InkDocumentError(
      'limit-exceeded',
      `${context}: ${count} samples exceeds the ${INK_LIMITS.samplesPerStroke} limit`,
    );
  }

  // Deltas must reconstruct to drawable absolute positions.
  let x = 0;
  let y = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = xs[index];
    const dy = ys[index];
    if (typeof dx !== 'number' || typeof dy !== 'number') return null;
    x += dx;
    y += dy;
    if (!isDrawableCoordinate(x) || !isDrawableCoordinate(y)) return null;
  }

  const channels: InkSampleChannels = {
    x: (xs as number[]).slice(0, count),
    y: (ys as number[]).slice(0, count),
  };

  for (const key of ['p', 'tx', 'ty', 'tw', 't'] as const) {
    const channel = value[key];
    if (!Array.isArray(channel)) continue;
    if (channel.length < count) {
      warnings.push(`${context}: dropped a truncated '${key}' channel`);
      continue;
    }
    if (!channel.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      warnings.push(`${context}: dropped a non-numeric '${key}' channel`);
      continue;
    }
    channels[key] = (channel as number[]).slice(0, count);
  }

  return channels;
}

function normalizeObject(value: unknown, warnings: string[], context: string): InkObject | null {
  if (!isObject(value)) return null;
  const type = value.type;
  if (typeof type !== 'string' || !OBJECT_TYPES.has(type)) {
    warnings.push(`${context}: dropped an object of unknown type`);
    return null;
  }
  if (!isValidId(value.id)) {
    warnings.push(`${context}: dropped an object with no usable id`);
    return null;
  }

  const base = {
    id: value.id,
    layerId: typeof value.layerId === 'string' ? value.layerId : '',
    ...(typeof value.authorId === 'string' ? { authorId: value.authorId } : {}),
    ...(typeof value.createdAt === 'number' ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.rotation === 'number' && Number.isFinite(value.rotation)
      ? { rotation: value.rotation }
      : {}),
    ...(value.locked === true ? { locked: true } : {}),
    ...(normalizeInkObjectLink(value.link) ? { link: normalizeInkObjectLink(value.link)! } : {}),
  };

  switch (type) {
    case 'stroke': {
      const samples = normalizeSamples(value.samples, warnings, `${context} ${value.id}`);
      if (!samples) {
        warnings.push(`${context}: dropped stroke '${value.id}' with unusable samples`);
        return null;
      }
      const stroke: InkObject = {
        ...base,
        type: 'stroke',
        brush: normalizeBrush(value.brush, warnings, `${context} ${value.id}`),
        samples,
      };
      if (typeof value.continuationId === 'string') {
        stroke.continuationId = value.continuationId;
        stroke.continuationIndex = Math.max(0, numberOr(value.continuationIndex, 0));
      }
      if (typeof value.classification === 'string') {
        stroke.classification = value.classification;
      }
      return stroke;
    }
    case 'text': {
      const text = typeof value.text === 'string' ? value.text : '';
      if (text.length > INK_LIMITS.textLength) {
        throw new InkDocumentError(
          'limit-exceeded',
          `${context}: text object '${value.id}' exceeds the ${INK_LIMITS.textLength}-character limit`,
        );
      }
      if (!isDrawableCoordinate(value.x) || !isDrawableCoordinate(value.y)) {
        warnings.push(`${context}: dropped text '${value.id}' with unusable geometry`);
        return null;
      }
      return {
        ...base,
        type: 'text',
        x: value.x,
        y: value.y,
        width: Math.max(0, numberOr(value.width, 0)),
        height: Math.max(0, numberOr(value.height, 0)),
        text,
        color: stringOr(value.color, '#1f2933'),
        fontSize: Math.max(1, numberOr(value.fontSize, 96)),
        ...(typeof value.fontFamily === 'string' ? { fontFamily: value.fontFamily } : {}),
        ...(value.align === 'start' || value.align === 'center' || value.align === 'end'
          ? { align: value.align }
          : {}),
        ...(value.sticky === true ? { sticky: true } : {}),
        ...(typeof value.backgroundColor === 'string'
          ? { backgroundColor: value.backgroundColor }
          : {}),
        ...(value.equation === true ? { equation: true } : {}),
      };
    }
    case 'image': {
      // A path is required and must stay vault-relative; an absolute path or a
      // URL would make document content able to drive a fetch.
      const relativePath = typeof value.relativePath === 'string' ? value.relativePath : '';
      if (!relativePath || !isVaultRelativePath(relativePath)) {
        warnings.push(`${context}: dropped image '${value.id}' with an unusable path`);
        return null;
      }
      if (!isDrawableCoordinate(value.x) || !isDrawableCoordinate(value.y)) {
        warnings.push(`${context}: dropped image '${value.id}' with unusable geometry`);
        return null;
      }
      return {
        ...base,
        type: 'image',
        x: value.x,
        y: value.y,
        width: Math.max(0, numberOr(value.width, 0)),
        height: Math.max(0, numberOr(value.height, 0)),
        relativePath,
        ...(typeof value.opacity === 'number' ? { opacity: clamp(value.opacity, 0, 1) } : {}),
      };
    }
    case 'group': {
      const childIds = Array.isArray(value.childIds) ? value.childIds.filter(isValidId) : [];
      return { ...base, type: 'group', childIds };
    }
    case 'shape': {
      const points =
        Array.isArray(value.points) && value.points.every(isDrawableCoordinate)
          ? (value.points as number[])
          : [];
      if (points.length < 4 || points.length % 2 !== 0) {
        warnings.push(`${context}: dropped shape '${value.id}' with unusable geometry`);
        return null;
      }
      const shape = SHAPE_KINDS.has(value.shape as InkShapeKind)
        ? (value.shape as InkShapeKind)
        : 'line';
      return {
        ...base,
        type: 'shape',
        shape,
        points,
        stroke: normalizeBrush(value.stroke, warnings, `${context}: shape '${value.id}'`),
        ...(typeof value.fill === 'string' ? { fill: value.fill } : {}),
        ...(typeof value.fillOpacity === 'number'
          ? { fillOpacity: clamp(value.fillOpacity, 0, 1) }
          : {}),
        ...(isArrowhead(value.arrowStart) ? { arrowStart: value.arrowStart } : {}),
        ...(isArrowhead(value.arrowEnd) ? { arrowEnd: value.arrowEnd } : {}),
        ...(typeof value.sourceStrokeId === 'string'
          ? { sourceStrokeId: value.sourceStrokeId }
          : {}),
        ...(value.guide === true ? { guide: true } : {}),
        ...(typeof value.rotation === 'number' && Number.isFinite(value.rotation)
          ? { rotation: value.rotation }
          : {}),
      };
    }
    case 'connector': {
      if (!isInkEndpoint(value.from) || !isInkEndpoint(value.to)) {
        warnings.push(`${context}: dropped connector '${value.id}' with unusable geometry`);
        return null;
      }
      return {
        ...base,
        type: 'connector',
        from: normalizeInkEndpoint(value.from),
        to: normalizeInkEndpoint(value.to),
        routing:
          value.routing === 'orthogonal' || value.routing === 'curved' ? value.routing : 'straight',
        stroke: normalizeBrush(value.stroke, warnings, `${context}: connector '${value.id}'`),
        ...(isArrowhead(value.arrowStart) ? { arrowStart: value.arrowStart } : {}),
        ...(isArrowhead(value.arrowEnd) ? { arrowEnd: value.arrowEnd } : {}),
        ...(typeof value.label === 'string'
          ? { label: value.label.slice(0, INK_LIMITS.textLength) }
          : {}),
        ...(typeof value.rotation === 'number' && Number.isFinite(value.rotation)
          ? { rotation: value.rotation }
          : {}),
      };
    }
    case 'stamp': {
      if (
        !isDrawableCoordinate(value.x) ||
        !isDrawableCoordinate(value.y) ||
        typeof value.symbolId !== 'string'
      ) {
        warnings.push(`${context}: dropped stamp '${value.id}' with unusable geometry`);
        return null;
      }
      return {
        ...base,
        type: 'stamp',
        x: value.x,
        y: value.y,
        width: Math.max(0, numberOr(value.width, 0)),
        height: Math.max(0, numberOr(value.height, 0)),
        symbolId: value.symbolId,
        ...(typeof value.color === 'string' ? { color: value.color } : {}),
      };
    }
  }
  return null;
}

const SHAPE_KINDS = new Set<InkShapeKind>([
  'line',
  'polyline',
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'polygon',
  'star',
  'arc',
]);

function isArrowhead(value: unknown): value is InkArrowhead {
  return value === 'none' || value === 'arrow' || value === 'open' || value === 'dot';
}

function isInkEndpoint(value: unknown): value is InkConnector['from'] {
  return isObject(value) && isDrawableCoordinate(value.x) && isDrawableCoordinate(value.y);
}

function normalizeInkEndpoint(value: InkConnector['from']): InkConnector['from'] {
  return {
    x: value.x,
    y: value.y,
    ...(typeof value.objectId === 'string' ? { objectId: value.objectId } : {}),
    ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}),
  };
}

function normalizeInkObjectLink(value: unknown): InkObjectLink | null {
  if (!isObject(value) || typeof value.target !== 'string') return null;
  if (value.kind === 'vault' && isVaultRelativePath(value.target)) {
    return { kind: 'vault', target: value.target };
  }
  if (value.kind === 'url') {
    try {
      const parsed = new URL(value.target);
      if (parsed.protocol === 'https:') return { kind: 'url', target: parsed.toString() };
    } catch {
      return null;
    }
  }
  return null;
}

/** Rejects absolute paths, parent traversal, and anything URL-shaped. */
export function isVaultRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  if (path.includes('\0')) return false;
  return !path.split(/[\\/]/).some((segment) => segment === '..');
}

function normalizeLayer(value: unknown, fallbackId: string): InkLayer {
  const source = isObject(value) ? value : {};
  const layer: InkLayer = {
    id: isValidId(source.id) ? source.id : fallbackId,
    name: stringOr(source.name, 'Layer'),
    visible: booleanOr(source.visible, true),
    locked: booleanOr(source.locked, false),
    opacity: clamp(numberOr(source.opacity, 1), 0, 1),
  };
  if (source.exported === false) layer.exported = false;
  preserveUnknown(source, KNOWN_LAYER_FIELDS, layer as unknown as Record<string, unknown>);
  return layer;
}

function normalizeScene(value: unknown, warnings: string[], context: string): InkScene {
  const source = isObject(value) ? value : {};

  const layers: Record<string, InkLayer> = {};
  const layerOrder: string[] = [];
  const rawLayers = isObject(source.layers) ? source.layers : {};
  const rawLayerOrder = Array.isArray(source.layerOrder) ? source.layerOrder : [];

  for (const id of rawLayerOrder) {
    if (!isValidId(id) || layers[id]) continue;
    layers[id] = normalizeLayer(rawLayers[id], id);
    layerOrder.push(id);
  }
  // A layer present in the map but missing from the order is still a layer the
  // user made; append it rather than losing everything drawn on it.
  for (const id of Object.keys(rawLayers)) {
    if (layers[id] || !isValidId(id)) continue;
    layers[id] = normalizeLayer(rawLayers[id], id);
    layerOrder.push(id);
    warnings.push(`${context}: layer '${id}' was missing from layerOrder and was appended`);
  }
  if (layerOrder.length === 0) {
    const fallback = `${context}-layer-1`;
    layers[fallback] = {
      id: fallback,
      name: 'Layer 1',
      visible: true,
      locked: false,
      opacity: 1,
    };
    layerOrder.push(fallback);
  }
  if (layerOrder.length > INK_LIMITS.layersPerPage) {
    throw new InkDocumentError(
      'limit-exceeded',
      `${context}: ${layerOrder.length} layers exceeds the ${INK_LIMITS.layersPerPage} limit`,
    );
  }

  const objects: Record<string, InkObject> = {};
  const objectOrder: string[] = [];
  const rawObjects = isObject(source.objects) ? source.objects : {};
  const rawOrder = Array.isArray(source.objectOrder) ? source.objectOrder : [];

  const addObject = (id: unknown, appended: boolean): void => {
    if (!isValidId(id) || objects[id]) return;
    const normalized = normalizeObject(rawObjects[id], warnings, context);
    if (!normalized) return;
    // Repair, never drop: an object whose layer vanished goes to the bottom
    // layer. This is somebody's handwriting.
    if (!layers[normalized.layerId]) {
      warnings.push(
        `${context}: object '${normalized.id}' referenced a missing layer and was moved to '${layerOrder[0]}'`,
      );
      normalized.layerId = layerOrder[0];
    }
    objects[id] = normalized;
    objectOrder.push(id);
    if (appended) {
      warnings.push(`${context}: object '${id}' was missing from objectOrder and was appended`);
    }
  };

  for (const id of rawOrder) addObject(id, false);
  for (const id of Object.keys(rawObjects)) addObject(id, true);

  if (objectOrder.length > INK_LIMITS.objectsPerPage) {
    throw new InkDocumentError(
      'limit-exceeded',
      `${context}: ${objectOrder.length} objects exceeds the ${INK_LIMITS.objectsPerPage} limit`,
    );
  }

  return { layers, layerOrder, objects, objectOrder };
}

function normalizeBackground(value: unknown): InkPageBackground {
  const source = isObject(value) ? value : {};
  const background: InkPageBackground = {
    pattern: BACKGROUND_PATTERNS.has(source.pattern as string)
      ? (source.pattern as InkPageBackground['pattern'])
      : 'blank',
  };
  if (typeof source.spacing === 'number' && Number.isFinite(source.spacing)) {
    background.spacing = clamp(source.spacing, 1, INK_LIMITS.fixedPageExtent);
  }
  if (typeof source.color === 'string') background.color = source.color;
  if (typeof source.lineColor === 'string') background.lineColor = source.lineColor;
  return background;
}

function normalizePage(value: unknown, id: string, warnings: string[]): InkPage {
  const source = isObject(value) ? value : {};
  const mode = source.mode === 'infinite' ? 'infinite' : 'fixed';
  const maxExtent = mode === 'fixed' ? INK_LIMITS.fixedPageExtent : INK_LIMITS.worldExtent;

  const page: InkPage = {
    id,
    mode,
    width: clamp(numberOr(source.width, INK_PAGE_PRESETS.a4.width), 1, maxExtent),
    height: clamp(numberOr(source.height, INK_PAGE_PRESETS.a4.height), 1, maxExtent),
    background: normalizeBackground(source.background),
    scene: normalizeScene(source.scene, warnings, `page ${id}`),
  };
  if (typeof source.name === 'string') page.name = source.name;
  preserveUnknown(source, KNOWN_PAGE_FIELDS, page as unknown as Record<string, unknown>);
  return page;
}

function normalizeSwatches(value: unknown): InkSwatch[] {
  if (!Array.isArray(value)) return [];
  const swatches: InkSwatch[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !isValidId(entry.id) || typeof entry.color !== 'string') continue;
    swatches.push({
      id: entry.id,
      color: entry.color,
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
    });
    if (swatches.length >= INK_LIMITS.swatchesPerDocument) break;
  }
  return swatches;
}

function normalizeBrushes(value: unknown, warnings: string[]): Record<string, InkBrushPreset> {
  const source = isObject(value) ? value : {};
  const brushes: Record<string, InkBrushPreset> = {};
  let count = 0;
  for (const [id, raw] of Object.entries(source)) {
    if (!isValidId(id) || count >= INK_LIMITS.brushesPerDocument) continue;
    const parameters = normalizeBrush(raw, warnings, `brush ${id}`);
    const name = isObject(raw) && typeof raw.name === 'string' ? raw.name : id;
    brushes[id] = { ...parameters, id, name };
    count += 1;
  }
  if (Object.keys(brushes).length === 0) return { ...INK_DEFAULT_BRUSHES };
  return brushes;
}

/**
 * Normalizes a parsed value into a document this build can edit.
 *
 * Throws only for conditions that make the file unusable — wrong kind, missing
 * schema version, a limit exceeded. Everything else is repaired and reported as
 * a warning, because refusing to open somebody's notebook over a malformed
 * layer record is worse than opening it with the layer rebuilt.
 */
export function normalizeInkDocument(value: unknown): InkDocumentInspection {
  if (!isObject(value)) {
    throw new InkDocumentError('not-an-object', 'Ink document must be a JSON object');
  }
  if (value.kind !== INK_DOCUMENT_KIND) {
    throw new InkDocumentError(
      'wrong-kind',
      `Ink document must declare kind "${INK_DOCUMENT_KIND}"`,
    );
  }
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new InkDocumentError(
      'invalid-schema-version',
      'Ink document must declare a positive integer schemaVersion',
    );
  }

  const warnings: string[] = [];

  if (schemaVersion > INK_SCHEMA_VERSION) {
    // Identity only. Normalizing would strip fields this build cannot see, and
    // writing that back would corrupt the file for the build that made it.
    return {
      support: 'newer',
      schemaVersion,
      document: value as unknown as InkDocument,
      warnings,
    };
  }

  const rawPages = isObject(value.pages) ? value.pages : {};
  const rawPageOrder = Array.isArray(value.pageOrder) ? value.pageOrder : [];

  const pages: Record<string, InkPage> = {};
  const pageOrder: string[] = [];
  for (const id of rawPageOrder) {
    if (!isValidId(id) || pages[id]) continue;
    pages[id] = normalizePage(rawPages[id], id, warnings);
    pageOrder.push(id);
  }
  for (const id of Object.keys(rawPages)) {
    if (pages[id] || !isValidId(id)) continue;
    pages[id] = normalizePage(rawPages[id], id, warnings);
    pageOrder.push(id);
    warnings.push(`page '${id}' was missing from pageOrder and was appended`);
  }
  if (pageOrder.length === 0) {
    const page = createInkPage('page-1');
    pages[page.id] = page;
    pageOrder.push(page.id);
    warnings.push('document had no pages; created a blank one');
  }
  if (pageOrder.length > INK_LIMITS.pagesPerDocument) {
    throw new InkDocumentError(
      'limit-exceeded',
      `${pageOrder.length} pages exceeds the ${INK_LIMITS.pagesPerDocument} limit`,
    );
  }

  let objectTotal = 0;
  let sampleTotal = 0;
  for (const id of pageOrder) {
    const scene = pages[id].scene;
    objectTotal += scene.objectOrder.length;
    for (const objectId of scene.objectOrder) {
      const object = scene.objects[objectId];
      if (object.type === 'stroke') sampleTotal += sampleCount(object.samples);
    }
  }
  if (objectTotal > INK_LIMITS.objectsPerDocument) {
    throw new InkDocumentError(
      'limit-exceeded',
      `${objectTotal} objects exceeds the ${INK_LIMITS.objectsPerDocument} limit`,
    );
  }
  if (sampleTotal > INK_LIMITS.samplesPerDocument) {
    throw new InkDocumentError(
      'limit-exceeded',
      `${sampleTotal} samples exceeds the ${INK_LIMITS.samplesPerDocument} limit`,
    );
  }

  const settingsSource = isObject(value.settings) ? value.settings : {};
  const document: InkDocument = {
    kind: INK_DOCUMENT_KIND,
    schemaVersion: INK_SCHEMA_VERSION,
    id: isValidId(value.id) ? value.id : 'ink-document',
    name: stringOr(value.name, 'Drawing'),
    createdAt: stringOr(value.createdAt, ''),
    updatedAt: stringOr(value.updatedAt, ''),
    settings: {
      defaultPageMode: settingsSource.defaultPageMode === 'infinite' ? 'infinite' : 'fixed',
      defaultBackground: normalizeBackground(settingsSource.defaultBackground),
      ...(typeof settingsSource.defaultBrushId === 'string'
        ? { defaultBrushId: settingsSource.defaultBrushId }
        : {}),
    },
    pages,
    pageOrder,
    brushes: normalizeBrushes(value.brushes, warnings),
    swatches: normalizeSwatches(value.swatches),
  };
  if (isObject(value.metadata)) document.metadata = value.metadata;
  preserveUnknown(value, KNOWN_DOCUMENT_FIELDS, document as unknown as Record<string, unknown>);

  return { support: 'supported', schemaVersion, document, warnings };
}

/** Parses stored text into an editable document. */
export function parseInkDocument(text: string): InkDocumentInspection {
  if (text.length > INK_LIMITS.documentBytes) {
    throw new InkDocumentError(
      'limit-exceeded',
      `Ink document exceeds the ${INK_LIMITS.documentBytes}-byte limit`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InkDocumentError(
      'invalid-json',
      `Ink document is not valid JSON: ${(error as Error).message}`,
    );
  }
  return normalizeInkDocument(parsed);
}

/* -------------------------------------------------------------------------
 * Serialization
 * ---------------------------------------------------------------------- */

/**
 * Serializes a document deterministically.
 *
 * Keys are emitted in a fixed order rather than in insertion order, so two
 * documents with the same content produce the same bytes regardless of how they
 * were built. Without this, a save after a reorder would rewrite the whole file
 * and every revision diff would be noise.
 */
export function serializeInkDocument(document: InkDocument): string {
  return `${JSON.stringify(document, sortedKeyReplacer, 2)}\n`;
}

function sortedKeyReplacer(_key: string, value: unknown): unknown {
  if (!isObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

/* -------------------------------------------------------------------------
 * Migration
 * ---------------------------------------------------------------------- */

/**
 * Migrates an older document forward.
 *
 * Version 1 is the first schema, so there is nothing to migrate yet. The
 * function exists now, with its dispatch and its test, so that adding version 2
 * is a matter of adding a step rather than retrofitting the mechanism — and so
 * the "newer document opens read-only" rule has a home from the start.
 */
export function migrateInkDocument(
  document: InkDocument,
  fromVersion: number,
): { document: InkDocument; warnings: string[] } {
  const warnings: string[] = [];
  let current = document;

  for (let version = fromVersion; version < INK_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) {
      warnings.push(`no migration from schema version ${version}; left unchanged`);
      break;
    }
    current = step(current, warnings);
  }

  return { document: { ...current, schemaVersion: INK_SCHEMA_VERSION }, warnings };
}

/** Keyed by the version being migrated *from*. */
const MIGRATIONS: Record<number, (document: InkDocument, warnings: string[]) => InkDocument> = {};

/* -------------------------------------------------------------------------
 * Validation helpers
 * ---------------------------------------------------------------------- */

export interface InkDocumentStats {
  pages: number;
  layers: number;
  objects: number;
  strokes: number;
  samples: number;
}

export function inkDocumentStats(document: InkDocument): InkDocumentStats {
  const stats: InkDocumentStats = { pages: 0, layers: 0, objects: 0, strokes: 0, samples: 0 };
  for (const pageId of document.pageOrder) {
    const page = document.pages[pageId];
    if (!page) continue;
    stats.pages += 1;
    stats.layers += page.scene.layerOrder.length;
    stats.objects += page.scene.objectOrder.length;
    for (const objectId of page.scene.objectOrder) {
      const object = page.scene.objects[objectId];
      if (object?.type === 'stroke') {
        stats.strokes += 1;
        stats.samples += sampleCount(object.samples);
      }
    }
  }
  return stats;
}

/** Narrows an object to a stroke. */
export function isInkStroke(object: InkObject | undefined): object is InkStroke {
  return object?.type === 'stroke';
}

/** The stroke with this id, or undefined if it is absent or another type. */
export function strokeOf(scene: InkScene, objectId: string): InkStroke | undefined {
  const object = scene.objects[objectId];
  return isInkStroke(object) ? object : undefined;
}

/** True when a stored pressure value is inside the quantized range. */
export function isStoredPressureInRange(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= INK_SAMPLE_RANGES.pressureMax;
}
