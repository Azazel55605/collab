import type { PdfViewerState } from '../types/pdf';

const VIEW_STATE_KEY = 'collab-pdf-view-states';
const MAX_VIEW_STATES = 128;
let states: Map<string, PdfViewerState> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function viewerStates() {
  if (!states) {
    states = new Map();
    try {
      const rows = JSON.parse(sessionStorage.getItem(VIEW_STATE_KEY) ?? '[]');
      if (Array.isArray(rows)) {
        for (const row of rows.slice(-MAX_VIEW_STATES)) {
          if (
            Array.isArray(row) &&
            typeof row[0] === 'string' &&
            row[1] &&
            typeof row[1] === 'object'
          ) {
            states.set(row[0], row[1]);
          }
        }
      }
    } catch {
      /* View state is optional when storage is denied. */
    }
  }
  return states;
}

export function readPdfViewerState(key: string): PdfViewerState | undefined {
  const state = viewerStates().get(key);
  if (
    state?.lastPage != null &&
    (typeof state.lastPage !== 'number' || !Number.isFinite(state.lastPage) || state.lastPage < 1)
  )
    return undefined;
  return state;
}

export function flushPdfViewerStates() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify([...viewerStates()]));
  } catch {
    /* Best effort. */
  }
}

export function rememberPdfViewerState(key: string, value: PdfViewerState) {
  const cache = viewerStates();
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_VIEW_STATES) cache.delete(cache.keys().next().value!);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPdfViewerStates, 500);
}

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
