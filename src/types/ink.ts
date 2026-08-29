/**
 * `.ink` document schema — frozen in Phase 0 of the Digital Ink plan.
 *
 * See `docs/plans/digital-ink-phase0-contract.md` for the reasoning. The short
 * version:
 *
 * - Geometry is stored in **integer ink units**, not CSS pixels. One unit is
 *   1/64 pt, which is finer than any drawing hardware Collab can read, so
 *   quantization is invisible while keeping every coordinate a small integer.
 * - Stroke samples are stored as parallel delta-encoded arrays, not one object
 *   per sample. A handwritten page is tens of thousands of samples; an object
 *   apiece is what makes naive ink formats enormous.
 * - Captured samples are authoritative. Outlines, tiles, and spatial indexes
 *   are derived and may be rebuilt at any time.
 * - A stroke carries a snapshot of the brush parameters it was drawn with, not
 *   a pointer to a mutable preset. Editing a favourite must not restyle old
 *   ink.
 * - No field may carry executable content, raw HTML, or an external URL that
 *   the renderer would fetch.
 */

export const INK_EXTENSION = 'ink';
export const INK_MEDIA_TYPE = 'application/vnd.collab.ink+json';
export const INK_DOCUMENT_KIND = 'collab-ink';
export const INK_SCHEMA_VERSION = 1;

/**
 * Ink units per PostScript point (1/72 inch).
 *
 * 1/64 pt is ~0.0055 mm. Professional tablets resolve about 0.005 mm and
 * report in their own device units, which the browser has already reduced to
 * CSS pixels by the time we see it, so this grid is below the resolution of
 * the input we can actually observe.
 */
export const INK_UNITS_PER_POINT = 64;

/** Ink units per CSS pixel at 100% zoom (1 px = 0.75 pt). */
export const INK_UNITS_PER_PX = INK_UNITS_PER_POINT * 0.75;

/** Ink units per millimetre, for rulers and physical-size presets. */
export const INK_UNITS_PER_MM = (INK_UNITS_PER_POINT * 72) / 25.4;

/**
 * Quantization ranges for the per-sample channels.
 *
 * Pressure is the only channel we reduce: `PointerEvent.pressure` is a float
 * in 0..1, and 4096 steps is finer than the levels browsers deliver in
 * practice. Tilt and twist are already integer degrees in the spec, so they
 * are stored exactly as reported.
 */
export const INK_SAMPLE_RANGES = {
  /** 0..1 float mapped onto 0..4095. */
  pressureMax: 4095,
  /** Degrees from the surface normal, per the Pointer Events spec. */
  tiltMin: -90,
  tiltMax: 90,
  /** Clockwise degrees of barrel rotation, per the Pointer Events spec. */
  twistMin: 0,
  twistMax: 359,
} as const;

/**
 * Hard structural limits. These bound parsing, import, paste, collaboration,
 * and export; they are not UI preferences. A document exceeding a limit is
 * rejected with a specific error rather than silently truncated.
 */
export const INK_LIMITS = {
  documentBytes: 64 * 1024 * 1024,
  pagesPerDocument: 500,
  layersPerPage: 50,
  objectsPerPage: 50_000,
  objectsPerDocument: 500_000,
  /**
   * Samples in one committed stroke. A stroke that reaches this while the pen
   * is still down commits and continues into a linked segment, so the limit
   * bounds a transaction without bounding how long a person may draw.
   */
  samplesPerStroke: 4_096,
  samplesPerDocument: 20_000_000,
  /** Wall-clock length of one stroke segment before the same split happens. */
  strokeSegmentMs: 30_000,
  /** Nesting depth of groups, to bound recursive transform and hit testing. */
  groupDepth: 8,
  textLength: 16_384,
  /** Decoded pixels of an embedded or referenced raster image. */
  imagePixels: 40_000_000,
  imageBytes: 16 * 1024 * 1024,
  /** Half-extent of the infinite world, in ink units (2^24 = ~92 m). */
  worldExtent: 16_777_216,
  /** Longest side of a fixed page, in ink units (200 in, matching PDF). */
  fixedPageExtent: 200 * 72 * INK_UNITS_PER_POINT,
  brushesPerDocument: 200,
  swatchesPerDocument: 200,
  /** Zoom range the viewport may reach. */
  minZoom: 0.05,
  maxZoom: 64,
} as const;

/** A page is either a bounded sheet or a bounded region of an endless surface. */
export type InkPageMode = 'fixed' | 'infinite';

export type InkBackgroundPattern = 'blank' | 'ruled' | 'grid' | 'dotted' | 'staff' | 'storyboard';

export interface InkPageBackground {
  pattern: InkBackgroundPattern;
  /** Line/dot spacing in ink units. Ignored by `blank`. */
  spacing?: number;
  color?: string;
  lineColor?: string;
}

export interface InkLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0..1. */
  opacity: number;
  /** Excluded from PNG/SVG/PDF export while false. */
  exported?: boolean;
}

/**
 * Stroke samples, stored structure-of-arrays with the first value absolute and
 * the rest as deltas.
 *
 * Absent channels mean the hardware did not report them. An absent channel is
 * never filled in with a default, because "no pressure data" and "pressure was
 * exactly half" must render differently.
 */
export interface InkSampleChannels {
  /** Delta-encoded x, in ink units. Length is the sample count. */
  x: number[];
  /** Delta-encoded y, in ink units. */
  y: number[];
  /** Delta-encoded pressure, 0..`pressureMax`. */
  p?: number[];
  /** Delta-encoded tilt about the x axis, in degrees. */
  tx?: number[];
  /** Delta-encoded tilt about the y axis, in degrees. */
  ty?: number[];
  /** Delta-encoded barrel rotation, in degrees. */
  tw?: number[];
  /** Delta-encoded milliseconds since the first sample of the stroke. */
  t?: number[];
}

/** A decoded sample. This is the working shape; it is never what is stored. */
export interface InkSample {
  x: number;
  y: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  elapsed?: number;
}

export type InkBrushKind =
  'ballpoint' | 'fountain' | 'technical' | 'pencil' | 'marker' | 'brush' | 'highlighter';

export type InkDashStyle = 'solid' | 'dashed' | 'dotted';

/**
 * The visual parameters a stroke was drawn with.
 *
 * This is snapshotted onto every stroke. `presetId` is provenance only — it
 * records which preset the values came from and is never dereferenced at
 * render time.
 */
export interface InkBrushParameters {
  kind: InkBrushKind;
  presetId?: string;
  color: string;
  /** 0..1. */
  opacity: number;
  /** Nominal width in ink units, before pressure. */
  width: number;
  /** 0..1: how much pressure narrows the stroke. */
  thinning: number;
  /** 0..1: outline smoothing. */
  smoothing: number;
  /** 0..1: input stabilization applied during capture. */
  streamline: number;
  taperStart: number;
  taperEnd: number;
  dash?: InkDashStyle;
  /**
   * Simulate pressure from velocity when the device reports none. Off by
   * default: a mouse line that fakes pressure looks wrong more often than a
   * uniform one does.
   */
  simulatePressure?: boolean;
}

export interface InkBrushPreset extends InkBrushParameters {
  id: string;
  name: string;
}

export interface InkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 2D affine transform, row-major `[a, b, c, d, e, f]`. */
export type InkTransform = [number, number, number, number, number, number];

export type InkObjectLink = { kind: 'vault'; target: string } | { kind: 'url'; target: string };

interface InkObjectBase {
  id: string;
  layerId: string;
  /** Collaboration identity of the author, never a hardware identifier. */
  authorId?: string;
  createdAt?: number;
  updatedAt?: number;
  transform?: InkTransform;
  /** Clockwise rotation in radians for box-backed text, image, and stamp objects. */
  rotation?: number;
  /** Derived from geometry; rebuilt on load rather than trusted. */
  bounds?: InkBounds;
  locked?: boolean;
  /** Optional click-through destination. Never interpreted as renderable content. */
  link?: InkObjectLink;
}

export interface InkStroke extends InkObjectBase {
  type: 'stroke';
  brush: InkBrushParameters;
  samples: InkSampleChannels;
  /**
   * Shared identity of a stroke that outgrew `samplesPerStroke` or
   * `strokeSegmentMs` and was committed as linked segments. Segments render as
   * one line and select as one object.
   */
  continuationId?: string;
  /** Position within a continuation, ascending. */
  continuationIndex?: number;
  /**
   * Set only by an explicit user action such as accepting a recognition
   * result. Nothing infers this from the ink.
   */
  classification?: string;
}

export type InkShapeKind =
  | 'line'
  | 'polyline'
  | 'rectangle'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'polygon'
  | 'star'
  | 'arc';

export type InkArrowhead = 'none' | 'arrow' | 'open' | 'dot';

export interface InkShape extends InkObjectBase {
  type: 'shape';
  shape: InkShapeKind;
  /** Geometry points in ink units, flat `[x0, y0, x1, y1, ...]`. */
  points: number[];
  stroke: InkBrushParameters;
  fill?: string;
  fillOpacity?: number;
  arrowStart?: InkArrowhead;
  arrowEnd?: InkArrowhead;
  cornerRadius?: number;
  /** Retained until an ink-to-shape conversion is committed, so it can undo. */
  sourceStrokeId?: string;
  /** Alignment aid. Guides paint on screen but are omitted from export. */
  guide?: boolean;
  /** Editor selection-frame orientation. Geometry remains baked into `points`. */
  rotation?: number;
}

export interface InkConnector extends InkObjectBase {
  type: 'connector';
  from: { objectId?: string; anchor?: string; x: number; y: number };
  to: { objectId?: string; anchor?: string; x: number; y: number };
  routing: 'straight' | 'orthogonal' | 'curved';
  stroke: InkBrushParameters;
  arrowStart?: InkArrowhead;
  arrowEnd?: InkArrowhead;
  label?: string;
  /** Editor selection-frame orientation. Endpoints remain authoritative. */
  rotation?: number;
}

export interface InkText extends InkObjectBase {
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Plain text plus bounded marks. Never HTML. */
  text: string;
  color: string;
  fontSize: number;
  fontFamily?: string;
  align?: 'start' | 'center' | 'end';
  sticky?: boolean;
  backgroundColor?: string;
  /** When true, `text` is bounded LaTeX rendered through KaTeX on screen. */
  equation?: boolean;
}

export interface InkImage extends InkObjectBase {
  type: 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Vault-relative path, validated on load. Never an external URL. */
  relativePath: string;
  opacity?: number;
  /** Source crop in the image's own pixel space. */
  crop?: { x: number; y: number; width: number; height: number };
}

export interface InkStamp extends InkObjectBase {
  type: 'stamp';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Catalog identity of a bundled glyph or symbol. */
  symbolId: string;
  color?: string;
}

export interface InkGroup extends InkObjectBase {
  type: 'group';
  childIds: string[];
}

export type InkObject =
  InkStroke | InkShape | InkConnector | InkText | InkImage | InkStamp | InkGroup;

/**
 * The renderable content of one surface.
 *
 * A `.ink` page and a PDF-page or image annotation surface both hold one of
 * these, which is what lets the whole tool set, renderer, hit tester, and
 * exporter serve both without a second implementation.
 */
export interface InkScene {
  layers: Record<string, InkLayer>;
  layerOrder: string[];
  objects: Record<string, InkObject>;
  /** Paint order, back to front. */
  objectOrder: string[];
}

export interface InkPage {
  id: string;
  name?: string;
  mode: InkPageMode;
  /** Ink units. For an infinite page this is the initial viewport extent. */
  width: number;
  height: number;
  background: InkPageBackground;
  scene: InkScene;
}

export interface InkSwatch {
  id: string;
  color: string;
  name?: string;
}

export interface InkDocumentSettings {
  defaultPageMode: InkPageMode;
  defaultBackground: InkPageBackground;
  /** Preset id used by the pen tool when the document opens. */
  defaultBrushId?: string;
}

export interface InkDocument {
  kind: typeof INK_DOCUMENT_KIND;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: InkDocumentSettings;
  pages: Record<string, InkPage>;
  pageOrder: string[];
  brushes: Record<string, InkBrushPreset>;
  swatches: InkSwatch[];
  metadata?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------
 * Anchored annotations
 * ---------------------------------------------------------------------- */

/**
 * Where an annotation surface sits on an immutable source document.
 *
 * The anchor carries the source surface's own dimensions so the scene can be
 * placed correctly at any zoom, rotation, crop, or fit mode. Annotations are
 * stored in source coordinates and never in viewport pixels.
 */
export type InkAnnotationAnchor =
  | { kind: 'pdf-page'; page: number; width: number; height: number }
  | { kind: 'image'; width: number; height: number }
  | { kind: 'deck-slide'; slideId: string; width: number; height: number }
  | { kind: 'generic-frame'; frameId: string; width: number; height: number };

export interface InkAnnotationSurface {
  id: string;
  anchor: InkAnnotationAnchor;
  scene: InkScene;
}

export const INK_ANNOTATION_DOCUMENT_KIND = 'collab-annotations';
export const INK_ANNOTATION_SCHEMA_VERSION = 1;

export interface InkAnnotationDocument {
  kind: typeof INK_ANNOTATION_DOCUMENT_KIND;
  schemaVersion: number;
  source: {
    stableFileId?: string;
    relativePath: string;
    contentHash?: string;
    pageCount?: number;
  };
  surfaces: Record<string, InkAnnotationSurface>;
  surfaceOrder: string[];
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

export function inkUnitsFromPoints(points: number): number {
  return Math.round(points * INK_UNITS_PER_POINT);
}

export function inkUnitsFromMm(mm: number): number {
  return Math.round(mm * INK_UNITS_PER_MM);
}

export function inkUnitsFromInches(inches: number): number {
  return Math.round(inches * 72 * INK_UNITS_PER_POINT);
}

/** Fixed-page presets, in ink units. */
export const INK_PAGE_PRESETS = {
  a4: { width: inkUnitsFromMm(210), height: inkUnitsFromMm(297) },
  a5: { width: inkUnitsFromMm(148), height: inkUnitsFromMm(210) },
  letter: { width: inkUnitsFromInches(8.5), height: inkUnitsFromInches(11) },
  legal: { width: inkUnitsFromInches(8.5), height: inkUnitsFromInches(14) },
  ratio4x3: { width: inkUnitsFromPoints(1024), height: inkUnitsFromPoints(768) },
  ratio16x9: { width: inkUnitsFromPoints(1280), height: inkUnitsFromPoints(720) },
} as const;

export type InkPagePresetId = keyof typeof INK_PAGE_PRESETS;
