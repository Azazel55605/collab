import type { InkDocument, InkPage } from '../../types/ink';

import { inkExportPalette } from './colors';
import type {
  InkExportAsset,
  InkExportOptions,
  InkExportReport,
  InkExportResult,
  InkExportSource,
} from './export';
import {
  encodeInkExportMetadata,
  inkExportFileName,
  makeInkExportSource,
  planInkExportPages,
} from './export';
import { buildInkPdf } from './exportPdf';
import type { InkPdfImagePage } from './exportPdf';
import { INK_UNITS_PER_EXPORT_PIXEL, planRasterExport } from './raster';
import { sceneToSvg } from './svg';

export interface InkExportRuntimeRequest {
  document: InkDocument;
  relativePath: string;
  options: InkExportOptions;
  assets: Record<string, InkExportAsset>;
  report: InkExportReport;
}

export interface InkExportProgress {
  completed: number;
  total: number;
  label: string;
}

export class InkExportCancelledError extends Error {
  constructor() {
    super('Ink export was cancelled.');
    this.name = 'InkExportCancelledError';
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function textToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function exportSurface(page: InkPage, options: InkExportOptions): string | undefined {
  if (options.transparent) return undefined;
  if (options.background) return options.background;
  if (options.palette === 'dark') return '#111827';
  if (options.palette === 'page') return page.background.color ?? '#ffffff';
  return '#ffffff';
}

function pageForExport(page: InkPage, options: InkExportOptions): InkPage {
  const surface = exportSurface(page, options);
  if (!options.includePageBackground || !surface) return page;
  if (options.palette === 'page' && page.background.color) return page;
  return { ...page, background: { ...page.background, color: surface } };
}

function pageSvg(
  page: InkPage,
  bounds: InkExportSource['bounds'],
  source: InkExportSource,
  request: InkExportRuntimeRequest,
  objectIds?: string[],
  scale = request.options.scale / INK_UNITS_PER_EXPORT_PIXEL,
): string {
  const surface = exportSurface(page, request.options);
  const exportedPage = pageForExport(page, request.options);
  return sceneToSvg(page.scene, {
    bounds,
    objectIds,
    scale,
    background: request.options.includePageBackground ? undefined : surface,
    colors: inkExportPalette(surface ?? exportedPage.background.color),
    imageAssets: request.assets,
    page: exportedPage,
    includePageBackground: request.options.includePageBackground,
    metadata: encodeInkExportMetadata(source),
  });
}

async function svgToBitmap(svg: string, width: number, height: number) {
  const source = await createImageBitmap(new Blob([svg], { type: 'image/svg+xml' }));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    source.close();
    throw new Error('The export canvas is not available in this runtime.');
  }
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  source.close();
  return canvas;
}

async function canvasBytes(canvas: OffscreenCanvas, type: 'image/png' | 'image/jpeg') {
  const blob = await canvas.convertToBlob({
    type,
    quality: type === 'image/jpeg' ? 0.92 : undefined,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function renderInkExport(
  request: InkExportRuntimeRequest,
  onProgress: (progress: InkExportProgress) => void = () => undefined,
  isCancelled: () => boolean = () => false,
): Promise<InkExportResult> {
  const plans = planInkExportPages(request.document, request.options);
  if (plans.length === 0) throw new Error('The selected drawing page no longer exists.');
  const firstPlan = plans[0];
  const source = makeInkExportSource(request.relativePath, firstPlan.page.id, firstPlan.bounds);
  const fileName = inkExportFileName(
    request.relativePath,
    request.options.format,
    firstPlan.page,
    request.options.scope,
  );
  const report: InkExportReport = {
    missingAssets: [...request.report.missingAssets],
    missingFonts: [...request.report.missingFonts],
    warnings: [...request.report.warnings],
  };

  if (isCancelled()) throw new InkExportCancelledError();
  if (request.options.format === 'svg') {
    onProgress({ completed: 0, total: 1, label: 'Building SVG' });
    const svg = pageSvg(firstPlan.page, firstPlan.bounds, source, request, firstPlan.objectIds);
    if (isCancelled()) throw new InkExportCancelledError();
    onProgress({ completed: 1, total: 1, label: 'SVG ready' });
    return {
      mediaType: 'image/svg+xml',
      fileName,
      contentBase64: textToBase64(svg),
      report,
      source,
    };
  }

  if (request.options.format === 'png') {
    onProgress({ completed: 0, total: 1, label: 'Rendering PNG' });
    const raster = planRasterExport(firstPlan.page.scene, {
      bounds: firstPlan.bounds,
      scale: request.options.scale,
      objectIds: firstPlan.objectIds,
    });
    if (raster.clampedFrom) {
      report.warnings.push(
        `Scale was reduced from ${raster.clampedFrom}x to ${raster.scale.toFixed(2)}x to stay within the bitmap limit.`,
      );
    }
    const svg = pageSvg(
      firstPlan.page,
      firstPlan.bounds,
      source,
      request,
      firstPlan.objectIds,
      raster.width / (firstPlan.bounds.maxX - firstPlan.bounds.minX),
    );
    const canvas = await svgToBitmap(svg, raster.width, raster.height);
    if (isCancelled()) throw new InkExportCancelledError();
    const bytes = await canvasBytes(canvas, 'image/png');
    onProgress({ completed: 1, total: 1, label: 'PNG ready' });
    return {
      mediaType: 'image/png',
      fileName,
      contentBase64: bytesToBase64(bytes),
      report,
      source,
    };
  }

  const pdfPages: InkPdfImagePage[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    if (isCancelled()) throw new InkExportCancelledError();
    const plan = plans[index];
    onProgress({ completed: index, total: plans.length, label: `Rendering page ${index + 1}` });
    const raster = planRasterExport(plan.page.scene, {
      bounds: plan.bounds,
      scale: request.options.scale,
      objectIds: plan.objectIds,
    });
    if (raster.clampedFrom) {
      report.warnings.push(
        `Page ${index + 1} was reduced from ${raster.clampedFrom}x to ${raster.scale.toFixed(2)}x.`,
      );
    }
    const pageSource = makeInkExportSource(request.relativePath, plan.page.id, plan.bounds);
    const svg = pageSvg(
      plan.page,
      plan.bounds,
      pageSource,
      { ...request, options: { ...request.options, transparent: false } },
      plan.objectIds,
      raster.width / (plan.bounds.maxX - plan.bounds.minX),
    );
    const canvas = await svgToBitmap(svg, raster.width, raster.height);
    const jpeg = await canvasBytes(canvas, 'image/jpeg');
    pdfPages.push({
      jpeg,
      pixelWidth: raster.width,
      pixelHeight: raster.height,
      pointWidth: plan.pointWidth,
      pointHeight: plan.pointHeight,
    });
    onProgress({ completed: index + 1, total: plans.length, label: `Rendered page ${index + 1}` });
    await Promise.resolve();
  }
  if (isCancelled()) throw new InkExportCancelledError();
  const pdf = buildInkPdf(pdfPages);
  return {
    mediaType: 'application/pdf',
    fileName,
    contentBase64: bytesToBase64(pdf),
    report,
    source,
  };
}
