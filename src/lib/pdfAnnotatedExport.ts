import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { InkPage } from '../types/ink';
import type { PdfSidecarState } from '../types/pdf';

import { buildInkPdf } from './ink/exportPdf';
import type { InkPdfImagePage } from './ink/exportPdf';
import { sceneToSvg } from './ink/svg';
import { pdfInkPage, pdfInkSurface } from './pdfAnnotations';

const MAX_EXPORT_PIXELS = 24_000_000;
const DEFAULT_EXPORT_SCALE = 2;

export interface PdfAnnotatedExportProgress {
  completed: number;
  total: number;
  label: string;
}

export class PdfAnnotatedExportCancelledError extends Error {
  constructor() {
    super('Annotated PDF export was cancelled.');
    this.name = 'PdfAnnotatedExportCancelledError';
  }
}

function blobBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('The annotated PDF page could not be encoded.'));
          return;
        }
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      'image/jpeg',
      0.92,
    );
  });
}

async function drawSvg(
  context: CanvasRenderingContext2D,
  svg: string,
  width: number,
  height: number,
) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The PDF ink overlay could not be decoded.'));
      image.src = url;
    });
    context.drawImage(image, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function annotatedPdfFileName(relativePath: string): string {
  const base =
    relativePath
      .split('/')
      .pop()
      ?.replace(/\.pdf$/i, '') || 'document';
  return `${base}-annotated.pdf`;
}

export function pdfExportScale(width: number, height: number, requested = DEFAULT_EXPORT_SCALE) {
  const pixels = width * height * requested * requested;
  return pixels > MAX_EXPORT_PIXELS ? requested * Math.sqrt(MAX_EXPORT_PIXELS / pixels) : requested;
}

function renderSemanticAnnotations(
  context: CanvasRenderingContext2D,
  state: PdfSidecarState,
  pageNumber: number,
  width: number,
  height: number,
) {
  context.save();
  context.globalCompositeOperation = 'multiply';
  for (const highlight of state.highlights) {
    if (highlight.page !== pageNumber) continue;
    context.fillStyle = highlight.color ?? 'rgba(250, 204, 21, 0.35)';
    context.globalAlpha = highlight.color ? 0.35 : 1;
    for (const rect of highlight.rects) {
      context.fillRect(
        rect.left * width,
        rect.top * height,
        rect.width * width,
        rect.height * height,
      );
    }
  }
  context.restore();

  for (const annotation of state.textAnnotations) {
    if (annotation.page !== pageNumber) continue;
    const x = annotation.left * width;
    const y = annotation.top * height;
    const boxWidth = annotation.width * width;
    const boxHeight = annotation.height * height;
    context.fillStyle = annotation.backgroundColor ?? annotation.color ?? '#fef3c7';
    context.fillRect(x, y, boxWidth, boxHeight);
    context.strokeStyle = annotation.color ?? '#d97706';
    context.strokeRect(x, y, boxWidth, boxHeight);
    context.save();
    context.beginPath();
    context.rect(x + 4, y + 4, Math.max(0, boxWidth - 8), Math.max(0, boxHeight - 8));
    context.clip();
    context.fillStyle = annotation.textColor ?? '#422006';
    context.font = `${Math.max(10, Math.min(16, height / 60))}px sans-serif`;
    context.textBaseline = 'top';
    const lineHeight = Math.max(12, Math.min(19, height / 50));
    annotation.text.split(/\r?\n/).forEach((line, index) => {
      context.fillText(line, x + 6, y + 6 + index * lineHeight, Math.max(0, boxWidth - 12));
    });
    context.restore();
  }
}

function inkSvg(page: InkPage, pixelWidth: number): string {
  return sceneToSvg(page.scene, {
    bounds: { minX: 0, minY: 0, maxX: page.width, maxY: page.height },
    scale: pixelWidth / page.width,
    background: undefined,
    includePageBackground: false,
  });
}

/**
 * Produces a new, raster-flattened annotated PDF. The source PDF and editable
 * sidecar are never mutated. Rendering one page at a time bounds peak memory.
 */
export async function exportAnnotatedPdf(
  documentProxy: PDFDocumentProxy,
  state: PdfSidecarState,
  onProgress: (progress: PdfAnnotatedExportProgress) => void = () => undefined,
  isCancelled: () => boolean = () => false,
): Promise<Uint8Array> {
  const output: InkPdfImagePage[] = [];
  for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
    if (isCancelled()) throw new PdfAnnotatedExportCancelledError();
    onProgress({
      completed: pageNumber - 1,
      total: documentProxy.numPages,
      label: `Rendering page ${pageNumber}`,
    });
    const pdfPage = await documentProxy.getPage(pageNumber);
    const base = pdfPage.getViewport({ scale: 1, rotation: 0 });
    const scale = pdfExportScale(base.width, base.height);
    const viewport = pdfPage.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The annotated PDF export canvas is unavailable.');
    await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
    renderSemanticAnnotations(context, state, pageNumber, canvas.width, canvas.height);

    const surface = state.ink ? pdfInkSurface(state.ink, pageNumber) : null;
    if (surface && surface.scene.objectOrder.length > 0) {
      await drawSvg(
        context,
        inkSvg(pdfInkPage(surface), canvas.width),
        canvas.width,
        canvas.height,
      );
    }
    output.push({
      jpeg: await blobBytes(canvas),
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      pointWidth: base.width,
      pointHeight: base.height,
    });
    onProgress({
      completed: pageNumber,
      total: documentProxy.numPages,
      label: `Rendered page ${pageNumber}`,
    });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  if (isCancelled()) throw new PdfAnnotatedExportCancelledError();
  return buildInkPdf(output);
}
