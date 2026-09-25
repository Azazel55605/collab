import type { ImageOverlayDocument } from '../types/image';
import type {
  InkAnnotationAnchor,
  InkAnnotationDocument,
  InkAnnotationSurface,
  InkBrushParameters,
  InkDocument,
  InkObject,
  InkPage,
  InkScene,
} from '../types/ink';
import {
  INK_ANNOTATION_DOCUMENT_KIND,
  INK_ANNOTATION_SCHEMA_VERSION,
  INK_UNITS_PER_PX,
} from '../types/ink';

import { encodeSamples } from './ink/codec';
import { createInkScene, parseInkDocument } from './ink/document';

export interface AnchoredAnnotationCapability {
  anchorKind: InkAnnotationAnchor['kind'];
  capability: string;
  surfaceId: (frameId?: string) => string;
}

/**
 * Explicit opt-in contract for immutable viewers. Extensions never enable
 * annotations by accident: a viewer must register an anchor and permission.
 */
export const ANCHORED_ANNOTATION_CAPABILITIES = {
  image: {
    anchorKind: 'image',
    capability: 'view.annotate',
    surfaceId: () => 'image',
  },
  deckReview: {
    anchorKind: 'deck-slide',
    capability: 'view.annotate',
    surfaceId: (slideId = '') => `deck-slide-${slideId}`,
  },
  genericFrame: {
    anchorKind: 'generic-frame',
    capability: 'view.annotate',
    surfaceId: (frameId = '') => `frame-${frameId}`,
  },
} as const satisfies Record<string, AnchoredAnnotationCapability>;

export function createAnchoredAnnotationDocument(relativePath: string): InkAnnotationDocument {
  return {
    kind: INK_ANNOTATION_DOCUMENT_KIND,
    schemaVersion: INK_ANNOTATION_SCHEMA_VERSION,
    source: { relativePath },
    surfaces: {},
    surfaceOrder: [],
  };
}

export function createAnchoredSurface(id: string, anchor: InkAnnotationAnchor) {
  return { id, anchor, scene: createInkScene(`${id}-layer-1`) } satisfies InkAnnotationSurface;
}

export function findAnchoredSurface(
  document: InkAnnotationDocument | null | undefined,
  predicate: (anchor: InkAnnotationAnchor) => boolean,
): InkAnnotationSurface | null {
  if (!document || typeof document !== 'object') return null;
  const surfaces =
    document.surfaces && typeof document.surfaces === 'object' ? document.surfaces : {};
  const order = Array.isArray(document.surfaceOrder) ? document.surfaceOrder : [];
  for (const id of order) {
    const surface = surfaces[id];
    if (surface?.anchor && predicate(surface.anchor)) return surface;
  }
  return null;
}

export function putAnchoredSurface(
  document: InkAnnotationDocument,
  surface: InkAnnotationSurface,
): InkAnnotationDocument {
  const exists = Boolean(document.surfaces[surface.id]);
  return {
    ...document,
    surfaces: { ...document.surfaces, [surface.id]: surface },
    surfaceOrder: exists ? document.surfaceOrder : [...document.surfaceOrder, surface.id],
  };
}

export function updateAnchoredSurface(
  document: InkAnnotationDocument,
  surface: InkAnnotationSurface,
  update: (scene: InkScene) => InkScene,
): InkAnnotationDocument {
  const scene = update(surface.scene);
  return scene === surface.scene ? document : putAnchoredSurface(document, { ...surface, scene });
}

export function anchoredSurfacePage(surface: InkAnnotationSurface): InkPage {
  return {
    id: surface.id,
    name: 'Anchored annotations',
    mode: 'fixed',
    width: Math.round(surface.anchor.width * INK_UNITS_PER_PX),
    height: Math.round(surface.anchor.height * INK_UNITS_PER_PX),
    background: { pattern: 'blank' },
    scene: surface.scene,
  };
}

function legacyBrush(
  color: string,
  widthPx: number,
  dash: InkBrushParameters['dash'] = 'solid',
): InkBrushParameters {
  return {
    kind: 'technical',
    color,
    opacity: 1,
    width: Math.max(INK_UNITS_PER_PX, widthPx * INK_UNITS_PER_PX),
    thinning: 0,
    smoothing: 0.65,
    streamline: 0.45,
    taperStart: 0,
    taperEnd: 0,
    dash,
  };
}

export interface ImageAnnotationMigration {
  document: InkAnnotationDocument;
  migrated: boolean;
  warnings: string[];
}

export function createImageAnnotationSurface(width: number, height: number) {
  return createAnchoredSurface('image', { kind: 'image', width, height });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeImageScene(
  value: unknown,
  width: number,
  height: number,
  warnings: string[],
): InkScene {
  const page = {
    id: 'image',
    name: 'Image annotations',
    mode: 'fixed' as const,
    width: Math.round(width * INK_UNITS_PER_PX),
    height: Math.round(height * INK_UNITS_PER_PX),
    background: { pattern: 'blank' as const },
    scene: value as InkScene,
  };
  const container: InkDocument = {
    kind: 'collab-ink',
    schemaVersion: 1,
    id: 'image-annotations',
    name: 'Image annotations',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    settings: { defaultPageMode: 'fixed', defaultBackground: { pattern: 'blank' } },
    pages: { image: page },
    pageOrder: ['image'],
    brushes: {},
    swatches: [],
  };
  try {
    const inspection = parseInkDocument(JSON.stringify(container));
    warnings.push(...inspection.warnings.map((warning) => `Image ink: ${warning}`));
    return inspection.document.pages.image.scene;
  } catch (error) {
    warnings.push(`Stored image ink was invalid and was reset: ${(error as Error).message}`);
    return createInkScene('image-layer-1');
  }
}

export function imageAnnotationSurface(
  document: InkAnnotationDocument | null | undefined,
): InkAnnotationSurface | null {
  return findAnchoredSurface(document, (anchor) => anchor.kind === 'image');
}

/** Converts the local image-overlay v1 objects into the shared InkScene. */
export function migrateImageAnnotations(
  value: unknown,
  relativePath: string,
  width: number,
  height: number,
): ImageAnnotationMigration {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (
    source?.kind === INK_ANNOTATION_DOCUMENT_KIND &&
    typeof source.schemaVersion === 'number' &&
    source.schemaVersion <= INK_ANNOTATION_SCHEMA_VERSION
  ) {
    const rawSurfaces = record(source.surfaces) ?? {};
    const rawSurface = record(rawSurfaces.image);
    const warnings: string[] = [];
    const surface = createImageAnnotationSurface(width, height);
    const normalizedDocument: InkAnnotationDocument = {
      kind: INK_ANNOTATION_DOCUMENT_KIND,
      schemaVersion: INK_ANNOTATION_SCHEMA_VERSION,
      source: { relativePath },
      surfaces: {},
      surfaceOrder: [],
    };
    const updated = putAnchoredSurface(normalizedDocument, {
      ...surface,
      anchor: { kind: 'image', width, height },
      scene: rawSurface
        ? normalizeImageScene(rawSurface.scene, width, height, warnings)
        : createInkScene('image-layer-1'),
    });
    return {
      document: updated,
      migrated: false,
      warnings,
    };
  }

  const document = createAnchoredAnnotationDocument(relativePath);
  const surface = createImageAnnotationSurface(width, height);
  if (!source || source.version !== 1 || !Array.isArray(source.items)) {
    return {
      document: putAnchoredSurface(document, surface),
      migrated: source !== null,
      warnings: source ? ['The image annotation sidecar was invalid and was reset.'] : [],
    };
  }

  const legacy = source as unknown as ImageOverlayDocument;
  const layerId = surface.scene.layerOrder[0];
  const objects: Record<string, InkObject> = {};
  const objectOrder: string[] = [];
  const warnings: string[] = [];
  const sx = Math.max(1, legacy.baseWidth || width) * INK_UNITS_PER_PX;
  const sy = Math.max(1, legacy.baseHeight || height) * INK_UNITS_PER_PX;
  for (const item of legacy.items) {
    try {
      let object: InkObject;
      if (item.type === 'pen') {
        object = {
          id: item.id,
          type: 'stroke',
          layerId,
          brush: legacyBrush(item.color, item.strokeWidth),
          samples: encodeSamples(
            item.points.map((point, index) => ({
              x: Math.round(point.x * sx),
              y: Math.round(point.y * sy),
              pressure: 0.5,
              elapsed: index * 8,
            })),
          ),
        };
      } else if (item.type === 'arrow') {
        object = {
          id: item.id,
          type: 'shape',
          layerId,
          shape: 'line',
          points: [item.start.x * sx, item.start.y * sy, item.end.x * sx, item.end.y * sy],
          stroke: legacyBrush(item.color, item.strokeWidth, item.lineStyle),
          arrowEnd: 'arrow',
        };
      } else if (item.type === 'text') {
        object = {
          id: item.id,
          type: 'text',
          layerId,
          x: item.x * sx,
          y: item.y * sy,
          width: item.width * sx,
          height: item.height * sy,
          text: item.text,
          color: item.color,
          fontSize: item.fontSize * INK_UNITS_PER_PX,
        };
      } else {
        throw new Error('unknown object type');
      }
      objects[object.id] = object;
      objectOrder.push(object.id);
    } catch {
      warnings.push('A malformed legacy image annotation was skipped.');
    }
  }

  const scene = normalizeImageScene(
    { ...surface.scene, objects, objectOrder },
    width,
    height,
    warnings,
  );

  return {
    document: putAnchoredSurface(document, {
      ...surface,
      scene,
    }),
    migrated: true,
    warnings,
  };
}

export function imageAnnotationObjectCount(document: InkAnnotationDocument | null | undefined) {
  return imageAnnotationSurface(document)?.scene.objectOrder.length ?? 0;
}
