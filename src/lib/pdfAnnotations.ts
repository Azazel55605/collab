import {
  INK_ANNOTATION_DOCUMENT_KIND,
  INK_ANNOTATION_SCHEMA_VERSION,
  INK_UNITS_PER_POINT,
} from '../types/ink';
import type {
  InkAnnotationDocument,
  InkAnnotationSurface,
  InkDocument,
  InkPage,
  InkScene,
} from '../types/ink';
import { PDF_SIDECAR_SCHEMA_VERSION } from '../types/pdf';
import type { PdfSidecarState } from '../types/pdf';

import { createInkScene, parseInkDocument } from './ink/document';

export interface PdfSidecarMigration {
  state: PdfSidecarState;
  migrated: boolean;
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeStoredSurfaces(
  storedInk: Record<string, unknown>,
  warnings: string[],
): Pick<InkAnnotationDocument, 'surfaces' | 'surfaceOrder'> {
  const rawSurfaces = record(storedInk.surfaces) ?? {};
  const surfaceOrder = array<string>(storedInk.surfaceOrder).filter((id) => id in rawSurfaces);
  const anchors = new Map<string, InkAnnotationSurface['anchor']>();
  const pages: Record<string, InkPage> = {};
  for (const id of surfaceOrder) {
    const surface = record(rawSurfaces[id]);
    const anchor = record(surface?.anchor);
    if (
      !surface ||
      anchor?.kind !== 'pdf-page' ||
      typeof anchor.page !== 'number' ||
      !Number.isInteger(anchor.page) ||
      anchor.page < 1 ||
      typeof anchor.width !== 'number' ||
      !Number.isFinite(anchor.width) ||
      anchor.width <= 0 ||
      typeof anchor.height !== 'number' ||
      !Number.isFinite(anchor.height) ||
      anchor.height <= 0
    ) {
      warnings.push(`PDF ink surface '${id}' had an invalid page anchor and was skipped.`);
      continue;
    }
    anchors.set(id, anchor as unknown as InkAnnotationSurface['anchor']);
    pages[id] = {
      id,
      mode: 'fixed',
      width: Math.round(anchor.width * INK_UNITS_PER_POINT),
      height: Math.round(anchor.height * INK_UNITS_PER_POINT),
      background: { pattern: 'blank' },
      scene: surface.scene as InkScene,
    };
  }
  const pageOrder = surfaceOrder.filter((id) => id in pages);
  const container: InkDocument = {
    kind: 'collab-ink',
    schemaVersion: 1,
    id: 'pdf-annotations',
    name: 'PDF annotations',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    settings: { defaultPageMode: 'fixed', defaultBackground: { pattern: 'blank' } },
    pages,
    pageOrder,
    brushes: {},
    swatches: [],
  };
  try {
    const inspection = parseInkDocument(JSON.stringify(container));
    warnings.push(...inspection.warnings.map((warning) => `PDF ink: ${warning}`));
    return {
      surfaces: Object.fromEntries(
        inspection.document.pageOrder.map((id) => [
          id,
          { id, anchor: anchors.get(id)!, scene: inspection.document.pages[id].scene },
        ]),
      ),
      surfaceOrder: inspection.document.pageOrder,
    };
  } catch (error) {
    warnings.push(
      `Stored PDF ink was invalid and could not be opened: ${(error as Error).message}`,
    );
    return { surfaces: {}, surfaceOrder: [] };
  }
}

export function createPdfInkDocument(
  relativePath: string,
  pageCount?: number,
): InkAnnotationDocument {
  return {
    kind: INK_ANNOTATION_DOCUMENT_KIND,
    schemaVersion: INK_ANNOTATION_SCHEMA_VERSION,
    source: {
      relativePath,
      ...(pageCount && pageCount > 0 ? { pageCount } : {}),
    },
    surfaces: {},
    surfaceOrder: [],
  };
}

/**
 * Migrates the pre-ink PDF sidecar without translating or dropping its semantic
 * annotations. Bookmarks, text highlights, text boxes, and comments keep their
 * original identities and timestamps; v2 adds the anchored ink container next
 * to them.
 */
export function migratePdfSidecar(
  value: unknown,
  relativePath: string,
  pageCount?: number,
): PdfSidecarMigration {
  const source = record(value) ?? {};
  const warnings: string[] = [];
  const storedInk = record(source.ink);
  let ink = createPdfInkDocument(relativePath, pageCount);

  if (
    storedInk?.kind === INK_ANNOTATION_DOCUMENT_KIND &&
    typeof storedInk.schemaVersion === 'number' &&
    storedInk.schemaVersion <= INK_ANNOTATION_SCHEMA_VERSION
  ) {
    const storedSource = record(storedInk.source) ?? {};
    const normalizedSurfaces = normalizeStoredSurfaces(storedInk, warnings);
    ink = {
      ...(storedInk as unknown as InkAnnotationDocument),
      source: {
        ...storedSource,
        relativePath,
        ...(pageCount && pageCount > 0 ? { pageCount } : {}),
      } as InkAnnotationDocument['source'],
      ...normalizedSurfaces,
    };
  } else if (source.ink !== undefined) {
    warnings.push(
      'The stored PDF ink container was invalid and was repaired as an empty document.',
    );
  }

  const schemaVersion = typeof source.schemaVersion === 'number' ? source.schemaVersion : 1;
  if (schemaVersion > PDF_SIDECAR_SCHEMA_VERSION) {
    warnings.push(
      `This PDF sidecar uses schema ${schemaVersion}; unsupported fields were preserved where possible.`,
    );
  }

  return {
    state: {
      ...(source as unknown as PdfSidecarState),
      schemaVersion: PDF_SIDECAR_SCHEMA_VERSION,
      bookmarks: array(source.bookmarks),
      highlights: array(source.highlights),
      textAnnotations: array(source.textAnnotations),
      pageComments: array(source.pageComments),
      ink,
      viewerState: record(source.viewerState) as PdfSidecarState['viewerState'],
    },
    migrated: schemaVersion < PDF_SIDECAR_SCHEMA_VERSION || !storedInk,
    warnings,
  };
}

export function pdfInkSurfaceId(page: number): string {
  return `pdf-page-${page}`;
}

export function createPdfInkSurface(
  page: number,
  widthPoints: number,
  heightPoints: number,
): InkAnnotationSurface {
  const id = pdfInkSurfaceId(page);
  return {
    id,
    anchor: {
      kind: 'pdf-page',
      page,
      width: widthPoints,
      height: heightPoints,
    },
    scene: createInkScene(`${id}-layer-1`),
  };
}

export function pdfInkSurface(
  document: InkAnnotationDocument,
  page: number,
): InkAnnotationSurface | null {
  const direct = document.surfaces[pdfInkSurfaceId(page)];
  if (direct?.anchor.kind === 'pdf-page' && direct.anchor.page === page) return direct;
  return (
    document.surfaceOrder
      .map((id) => document.surfaces[id])
      .find((surface) => surface?.anchor.kind === 'pdf-page' && surface.anchor.page === page) ??
    null
  );
}

export function putPdfInkSurface(
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

export function updatePdfInkSurface(
  document: InkAnnotationDocument,
  page: number,
  widthPoints: number,
  heightPoints: number,
  update: (scene: InkScene) => InkScene,
): InkAnnotationDocument {
  const current =
    pdfInkSurface(document, page) ?? createPdfInkSurface(page, widthPoints, heightPoints);
  const nextScene = update(current.scene);
  if (nextScene === current.scene) return document;
  return putPdfInkSurface(document, {
    ...current,
    anchor: { kind: 'pdf-page', page, width: widthPoints, height: heightPoints },
    scene: nextScene,
  });
}

export function pdfInkPage(surface: InkAnnotationSurface): InkPage {
  if (surface.anchor.kind !== 'pdf-page') {
    throw new Error('The annotation surface is not anchored to a PDF page.');
  }
  return {
    id: surface.id,
    name: `PDF page ${surface.anchor.page}`,
    mode: 'fixed',
    width: Math.round(surface.anchor.width * INK_UNITS_PER_POINT),
    height: Math.round(surface.anchor.height * INK_UNITS_PER_POINT),
    background: { pattern: 'blank' },
    scene: surface.scene,
  };
}

export function pdfInkObjectCount(document: InkAnnotationDocument): number {
  return document.surfaceOrder.reduce(
    (count, id) => count + (document.surfaces[id]?.scene.objectOrder.length ?? 0),
    0,
  );
}
