import type { InkBounds, InkDocument, InkPage } from '../../types/ink';
import { INK_UNITS_PER_POINT } from '../../types/ink';

import { isVaultRelativePath } from './document';
import { pageExportBounds } from './raster';
import { objectBounds, sceneBounds } from './svg';

export type InkExportFormat = 'png' | 'svg' | 'pdf';
export type InkExportScope = 'page' | 'selection' | 'region' | 'document';
export type InkExportCrop = 'page' | 'content';
export type InkExportPalette = 'light' | 'dark' | 'page';

export interface InkExportAsset {
  dataUrl: string;
  width: number;
  height: number;
}

export interface InkExportOptions {
  format: InkExportFormat;
  scope: InkExportScope;
  pageId: string;
  selectedObjectIds?: string[];
  region?: InkBounds;
  crop: InkExportCrop;
  scale: number;
  padding: number;
  transparent: boolean;
  includePageBackground: boolean;
  palette: InkExportPalette;
  background?: string;
}

export interface InkExportReport {
  missingAssets: string[];
  missingFonts: string[];
  warnings: string[];
}

export interface InkExportSource {
  marker: 'collab-ink-export';
  source: string;
  pageId: string;
  bounds: InkBounds;
}

export interface InkExportPagePlan {
  page: InkPage;
  bounds: InkBounds;
  objectIds?: string[];
  pointWidth: number;
  pointHeight: number;
}

export interface InkExportResult {
  mediaType: string;
  fileName: string;
  contentBase64: string;
  report: InkExportReport;
  source: InkExportSource;
}

const EXPORT_MARKER = 'collab-ink-export' as const;

function nonEmptyBounds(bounds: InkBounds): InkBounds {
  if (bounds.maxX > bounds.minX && bounds.maxY > bounds.minY) return bounds;
  return { minX: 0, minY: 0, maxX: INK_UNITS_PER_POINT, maxY: INK_UNITS_PER_POINT };
}

function paddedBounds(bounds: InkBounds, padding: number): InkBounds {
  const safePadding = Math.max(0, padding);
  return {
    minX: bounds.minX - safePadding,
    minY: bounds.minY - safePadding,
    maxX: bounds.maxX + safePadding,
    maxY: bounds.maxY + safePadding,
  };
}

export function selectionBounds(page: InkPage, objectIds: readonly string[]): InkBounds {
  let bounds: InkBounds | null = null;
  const selected = new Set(objectIds);
  for (const id of page.scene.objectOrder) {
    if (!selected.has(id)) continue;
    const object = page.scene.objects[id];
    if (!object) continue;
    const next = objectBounds(object);
    if (!next) continue;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, next.minX),
          minY: Math.min(bounds.minY, next.minY),
          maxX: Math.max(bounds.maxX, next.maxX),
          maxY: Math.max(bounds.maxY, next.maxY),
        }
      : next;
  }
  return nonEmptyBounds(bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 });
}

function contentBounds(page: InkPage): InkBounds {
  return nonEmptyBounds(sceneBounds(page.scene));
}

function boundsForPage(page: InkPage, options: InkExportOptions): InkBounds {
  if (options.scope === 'selection') {
    return selectionBounds(page, options.selectedObjectIds ?? []);
  }
  if (options.scope === 'region' && options.region) return nonEmptyBounds(options.region);
  if (options.crop === 'content') return contentBounds(page);
  return nonEmptyBounds(pageExportBounds(page));
}

export function planInkExportPages(
  document: InkDocument,
  options: InkExportOptions,
): InkExportPagePlan[] {
  const pageIds =
    options.scope === 'document' && options.format === 'pdf'
      ? document.pageOrder
      : [options.pageId];
  return pageIds.flatMap((pageId) => {
    const page = document.pages[pageId];
    if (!page) return [];
    const bounds = paddedBounds(boundsForPage(page, options), options.padding);
    return [
      {
        page,
        bounds,
        ...(options.scope === 'selection'
          ? { objectIds: [...(options.selectedObjectIds ?? [])] }
          : {}),
        pointWidth: Math.max(1, (bounds.maxX - bounds.minX) / INK_UNITS_PER_POINT),
        pointHeight: Math.max(1, (bounds.maxY - bounds.minY) / INK_UNITS_PER_POINT),
      },
    ];
  });
}

export function collectInkExportDependencies(document: InkDocument, pageIds: readonly string[]) {
  const paths = new Set<string>();
  const fonts = new Set<string>();
  for (const pageId of pageIds) {
    const page = document.pages[pageId];
    if (!page) continue;
    for (const object of Object.values(page.scene.objects)) {
      if (object.type === 'image') paths.add(object.relativePath);
      if (object.type === 'text' && object.fontFamily) fonts.add(object.fontFamily);
    }
  }
  return { assetPaths: [...paths].sort(), fontFamilies: [...fonts].sort() };
}

function safeStem(relativePath: string): string {
  const base =
    relativePath
      .split('/')
      .pop()
      ?.replace(/\.ink$/i, '') ?? 'drawing';
  return base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'drawing';
}

export function inkExportFileName(
  relativePath: string,
  format: InkExportFormat,
  page: InkPage,
  scope: InkExportScope,
): string {
  const pageSuffix = scope === 'document' ? '' : `-${page.name || page.id}`;
  const scopeSuffix = scope === 'selection' ? '-selection' : scope === 'region' ? '-region' : '';
  const raw = `${safeStem(relativePath)}${pageSuffix}${scopeSuffix}`;
  const stem = raw.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-');
  return `${stem}.${format}`;
}

export function stableInkEmbedPath(relativePath: string, page: InkPage): string {
  const sourceStem = safeStem(relativePath);
  let pathHash = 2166136261;
  for (const character of relativePath) {
    pathHash ^= character.charCodeAt(0);
    pathHash = Math.imul(pathHash, 16777619);
  }
  const pageStem = (page.name || page.id).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `Pictures/${sourceStem}-${(pathHash >>> 0).toString(16)}-${pageStem || 'page'}.svg`;
}

export function makeInkExportSource(
  relativePath: string,
  pageId: string,
  bounds: InkBounds,
): InkExportSource {
  return { marker: EXPORT_MARKER, source: relativePath, pageId, bounds };
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToUtf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeInkExportMetadata(source: InkExportSource): string {
  return utf8ToBase64(JSON.stringify(source));
}

export function extractInkExportSource(dataUrl: string): InkExportSource | null {
  const encodedSvg = /^data:image\/svg\+xml;base64,(.*)$/s.exec(dataUrl)?.[1];
  if (!encodedSvg) return null;
  try {
    const svg = base64ToUtf8(encodedSvg);
    const encodedMetadata = /<metadata id="collab-ink-export">([^<]+)<\/metadata>/.exec(svg)?.[1];
    if (!encodedMetadata) return null;
    const parsed = JSON.parse(base64ToUtf8(encodedMetadata)) as Partial<InkExportSource>;
    if (
      parsed.marker !== EXPORT_MARKER ||
      typeof parsed.source !== 'string' ||
      !isVaultRelativePath(parsed.source) ||
      !/\.ink$/i.test(parsed.source) ||
      typeof parsed.pageId !== 'string' ||
      parsed.pageId.length === 0 ||
      !parsed.bounds ||
      ![parsed.bounds.minX, parsed.bounds.minY, parsed.bounds.maxX, parsed.bounds.maxY].every(
        (value) => Number.isFinite(value),
      ) ||
      parsed.bounds.maxX! <= parsed.bounds.minX! ||
      parsed.bounds.maxY! <= parsed.bounds.minY!
    ) {
      return null;
    }
    return parsed as InkExportSource;
  } catch {
    return null;
  }
}
