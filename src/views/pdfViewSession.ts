import type { PdfViewerState } from '../types/pdf';

export interface PdfPageRenderCacheEntry {
  imageUrl: string;
  textLayerHtml: string;
  displayWidth: number;
  displayHeight: number;
  renderWidth: number;
  renderHeight: number;
  baseWidth: number;
  baseHeight: number;
}

export function buildPdfPageRenderCacheKey(
  documentCacheKey: string,
  pageNumber: number,
  scale: number,
  rotation: number,
) {
  return `${documentCacheKey}::${pageNumber}::${scale.toFixed(4)}::${rotation}`;
}

export function resolvePdfBookmarksOpen(viewerState: PdfViewerState | null | undefined) {
  return typeof viewerState?.lastBookmarksOpen === 'boolean' ? viewerState.lastBookmarksOpen : true;
}

export function buildPdfViewerState({
  pageNumber,
  zoomMode,
  zoom,
  layoutMode,
  rotation,
  bookmarksOpen,
}: {
  pageNumber: number;
  zoomMode: NonNullable<PdfViewerState['lastZoomMode']>;
  zoom: number;
  layoutMode: NonNullable<PdfViewerState['lastLayoutMode']>;
  rotation: number;
  bookmarksOpen: boolean;
}): PdfViewerState {
  return {
    lastPage: pageNumber,
    lastZoomMode: zoomMode,
    lastZoom: zoom,
    lastLayoutMode: layoutMode,
    lastRotation: rotation,
    lastBookmarksOpen: bookmarksOpen,
  };
}
