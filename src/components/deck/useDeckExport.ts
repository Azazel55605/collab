import { useCallback, useRef, useState } from 'react';

import { toast } from 'sonner';

import {
  canvasRasterizer,
  DeckExportCancelledError,
  pngRasterizer,
  rasterizeOutputPages,
  slideSvgDocument,
} from '../../lib/deck/exportPdf';
import type { DeckRasterizer } from '../../lib/deck/exportPdf';
import { buildOutputPages } from '../../lib/deck/output';
import type { DeckOutputPage } from '../../lib/deck/output';
import { buildDeckPdf } from '../../lib/deck/pdf';
import type { DeckTextMeasurer } from '../../lib/deck/textLayout';
import { tauriCommands } from '../../lib/tauri';
import type { DeckAssetRef, DeckDocument } from '../../types/deck';

import type { DeckExportRequest } from './DeckExportDialog';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Presentation';
}

export interface DeckExportRuntime {
  rasterize?: DeckRasterizer;
  rasterizePng?: DeckRasterizer;
}

interface UseDeckExportOptions {
  document: DeckDocument | null;
  /** The deck's name without extension, used for default file names and PDF titles. */
  title: string;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  runtime?: DeckExportRuntime;
}

/**
 * Export and print for a presentation: PDFs (slides or handouts), slide
 * images, and the print dialog. Reads the deck; never writes to it.
 */
export function useDeckExport({
  document,
  title,
  measurer,
  resolveAsset,
  runtime,
}: UseDeckExportOptions) {
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [printPages, setPrintPages] = useState<DeckOutputPage[] | null>(null);
  const cancelled = useRef(false);

  const slideIdsFor = useCallback(
    (request: DeckExportRequest): string[] | undefined =>
      document && request.slides
        ? request.slides
            .map((number) => document.slideOrder[number - 1])
            .filter((id): id is string => Boolean(id))
        : undefined,
    [document],
  );

  const pagesFor = useCallback(
    (request: DeckExportRequest): DeckOutputPage[] => {
      if (!document) return [];
      const slideIds = slideIdsFor(request);
      return buildOutputPages(document, request.layout, {
        measurer,
        resolveAsset,
        ...(slideIds ? { slideIds } : {}),
        includeHidden: request.includeHidden,
        title,
      });
    },
    [document, measurer, resolveAsset, slideIdsFor, title],
  );

  /** Returns true when the export finished (or was cancelled by the person). */
  const exportDeck = useCallback(
    async (request: DeckExportRequest): Promise<boolean> => {
      if (!document) return false;
      cancelled.current = false;
      try {
        if (request.format === 'pdf' || request.format === 'handouts') {
          const pages = pagesFor(request);
          if (pages.length === 0) throw new Error('There are no slides to export.');
          const suffix = request.format === 'handouts' ? ' handouts' : '';
          const destination = await tauriCommands.showExportDialog(
            `${safeFileName(title)}${suffix}.pdf`,
            { name: 'PDF', extensions: ['pdf'] },
          );
          if (!destination) return false;
          setProgress({ completed: 0, total: pages.length });
          const rendered = await rasterizeOutputPages(pages, {
            rasterize: runtime?.rasterize ?? canvasRasterizer,
            isCancelled: () => cancelled.current,
            onProgress: (completed, total) => setProgress({ completed, total }),
          });
          const pdf = buildDeckPdf(rendered, { title });
          await tauriCommands.writeDownloadedFile(destination, bytesToBase64(pdf));
          toast.success(
            `Exported ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} to PDF.`,
          );
          return true;
        }

        const slideIds =
          slideIdsFor(request) ??
          document.slideOrder.filter((id) => request.includeHidden || !document.slides[id]?.hidden);
        if (slideIds.length === 0) throw new Error('There are no slides to export.');
        const extension = request.format;
        const fileFor = (slideId: string) =>
          `${safeFileName(title)} - slide ${document.slideOrder.indexOf(slideId) + 1}.${extension}`;
        const render = async (slideId: string): Promise<string> => {
          const image = slideSvgDocument(document, slideId, {
            measurer,
            resolveAsset,
            scale: request.format === 'png' ? request.scale : 1,
          });
          if (request.format === 'svg') return utf8ToBase64(image.svg);
          const rasterize = runtime?.rasterizePng ?? pngRasterizer;
          return bytesToBase64(await rasterize(image.svg, image.pixelWidth, image.pixelHeight));
        };
        const filter =
          request.format === 'png'
            ? { name: 'PNG image', extensions: ['png'] }
            : { name: 'SVG image', extensions: ['svg'] };

        if (slideIds.length === 1) {
          const destination = await tauriCommands.showExportDialog(fileFor(slideIds[0]), filter);
          if (!destination) return false;
          await tauriCommands.writeDownloadedFile(destination, await render(slideIds[0]));
          toast.success('Slide exported.');
          return true;
        }
        const folder = await tauriCommands.showExportFolderDialog();
        if (!folder) return false;
        const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
        setProgress({ completed: 0, total: slideIds.length });
        for (const [index, slideId] of slideIds.entries()) {
          if (cancelled.current) throw new DeckExportCancelledError();
          await tauriCommands.writeDownloadedFile(
            `${folder.replace(/[\\/]+$/, '')}${separator}${fileFor(slideId)}`,
            await render(slideId),
          );
          setProgress({ completed: index + 1, total: slideIds.length });
        }
        toast.success(`Exported ${slideIds.length} slides to ${folder}.`);
        return true;
      } catch (error) {
        if (error instanceof DeckExportCancelledError) {
          toast.info('Export cancelled.');
          return true;
        }
        toast.error(
          `Could not export the presentation: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      } finally {
        setProgress(null);
      }
    },
    [document, measurer, pagesFor, resolveAsset, runtime, slideIdsFor, title],
  );

  const printDeck = useCallback(
    (request: DeckExportRequest): boolean => {
      const pages = pagesFor(request);
      if (pages.length === 0) {
        toast.error('There are no slides to print.');
        return false;
      }
      setPrintPages(pages);
      return true;
    },
    [pagesFor],
  );

  const finishPrint = useCallback(() => setPrintPages(null), []);
  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  return { progress, exportDeck, printDeck, printPages, finishPrint, cancel };
}
