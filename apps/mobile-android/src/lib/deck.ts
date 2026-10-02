/**
 * Mobile `.deck` presentation model (Phase 8, presentation companion).
 *
 * The phone views and presents a deck; it never composes slides. Everything
 * about the document itself — schema, parsing, normalization, the resolved
 * scene, SVG rendering, playback rules, and the remote-control protocol — is
 * reused from `src/lib/deck/`. Only mobile-shaped helpers live here: the file
 * predicate, the network-then-replica read, vault-path asset lookup, touch zoom
 * and pan bounds, thumbnail windowing, and the per-file view state that has to
 * survive Android recreating the process.
 */
import { collectDeckAssetPaths } from '../../../../src/lib/deck/assets';
import {
  type DeckDocumentInspection,
  normalizeDeckDocument,
  parseDeckDocument,
} from '../../../../src/lib/deck/document';
import type { DeckDocument } from '../../../../src/types/deck';
import {
  type HostedFileEntry,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
} from '../mobileTauri';

import { fileEntryExtension } from './format';

export type { DeckDocument };

export function isDeckFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  if (file.documentType === 'deck') return true;
  return fileEntryExtension(file) === 'deck';
}

/** Display name for a presentation, without its extension. */
export function deckName(file: HostedFileEntry): string {
  return file.name.replace(/\.deck$/i, '') || file.name;
}

/**
 * Parse stored `.deck` text. A malformed deck throws: the viewer shows the
 * error rather than an empty presentation.
 */
export function inspectDeckContent(content: string): DeckDocumentInspection {
  return parseDeckDocument(content);
}

/** Normalize the live room's deck the same way the desktop does. */
export function inspectLiveDeck(value: Record<string, unknown>): DeckDocumentInspection {
  return normalizeDeckDocument(value);
}

export interface LoadedDeck extends DeckDocumentInspection {
  file: HostedFileEntry;
  source: 'network' | 'cache';
}

/**
 * Read a presentation online (warming the replica cache) and fall back to the
 * offline replica when the server is unreachable. Mirrors `readInkDrawing`.
 */
export async function readDeckPresentation(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<LoadedDeck> {
  const inspect = (content: string, entry: HostedFileEntry, source: 'network' | 'cache') => ({
    ...inspectDeckContent(content),
    file: entry,
    source,
  });

  if (connected) {
    try {
      const document = await readHostedDocument(serverUrl, vaultId, file.id);
      void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
      return inspect(document.content, document.file, 'network');
    } catch (error) {
      const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id).catch(() => null);
      if (cached !== null) return inspect(cached, file, 'cache');
      throw error;
    }
  }

  const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id);
  if (cached === null) {
    throw new Error('This presentation is not cached for offline viewing.');
  }
  return inspect(cached, file, 'cache');
}

/* -------------------------------------------------------------------------
 * Assets
 * ---------------------------------------------------------------------- */

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/**
 * The vault file behind each image the deck draws, by vault path. Paths the
 * vault no longer has are listed as missing; the renderer draws a placeholder
 * for them, so a deleted image never stops the deck opening.
 */
export function deckAssetFiles(
  deck: DeckDocument,
  files: readonly HostedFileEntry[],
): { found: Map<string, HostedFileEntry>; missing: string[] } {
  const byPath = new Map<string, HostedFileEntry>();
  for (const file of files) {
    if (file.kind !== 'folder') byPath.set(normalizePath(file.relativePath || file.name), file);
  }
  const found = new Map<string, HostedFileEntry>();
  const missing: string[] = [];
  for (const path of collectDeckAssetPaths(deck)) {
    const file = byPath.get(normalizePath(path));
    if (file) found.set(path, file);
    else missing.push(path);
  }
  return { found, missing };
}

/* -------------------------------------------------------------------------
 * Touch zoom and pan
 * ---------------------------------------------------------------------- */

/** Zoom relative to fit-to-screen: 1 is the whole slide, never smaller. */
export const DECK_MOBILE_ZOOM = { min: 1, max: 5, doubleTap: 2.5 } as const;

export function clampDeckZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DECK_MOBILE_ZOOM.min;
  return Math.max(DECK_MOBILE_ZOOM.min, Math.min(DECK_MOBILE_ZOOM.max, zoom));
}

export interface DeckViewport {
  zoom: number;
  /** Offset of the zoomed slide's centre from the frame's centre, in CSS pixels. */
  panX: number;
  panY: number;
}

export const FIT_VIEWPORT: DeckViewport = { zoom: 1, panX: 0, panY: 0 };

/**
 * Keep the zoomed slide covering the frame: it can be panned until an edge
 * reaches the frame's edge, no further, and at fit it is centred.
 */
export function clampDeckPan(
  viewport: DeckViewport,
  fitWidth: number,
  fitHeight: number,
): DeckViewport {
  const zoom = clampDeckZoom(viewport.zoom);
  const limitX = (fitWidth * (zoom - 1)) / 2;
  const limitY = (fitHeight * (zoom - 1)) / 2;
  const clamp = (value: number, limit: number) =>
    // `+ 0` turns -0 into 0, so a centred slide compares equal to fit.
    Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) + 0 : 0;
  return { zoom, panX: clamp(viewport.panX, limitX), panY: clamp(viewport.panY, limitY) };
}

/**
 * Zoom about a point (a pinch centre or a double tap), given relative to the
 * frame's centre, so the content under the fingers stays under them.
 */
export function zoomDeckAbout(
  viewport: DeckViewport,
  nextZoom: number,
  pointX: number,
  pointY: number,
  fitWidth: number,
  fitHeight: number,
): DeckViewport {
  const zoom = clampDeckZoom(nextZoom);
  const ratio = zoom / viewport.zoom;
  return clampDeckPan(
    {
      zoom,
      panX: pointX - (pointX - viewport.panX) * ratio,
      panY: pointY - (pointY - viewport.panY) * ratio,
    },
    fitWidth,
    fitHeight,
  );
}

/** The largest slide size that fits the frame, keeping the slide's aspect. */
export function fitDeckSlide(
  frameWidth: number,
  frameHeight: number,
  aspect: number,
): { width: number; height: number } {
  if (frameWidth <= 0 || frameHeight <= 0 || !(aspect > 0)) return { width: 0, height: 0 };
  const width = Math.min(frameWidth, frameHeight * aspect);
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}

/* -------------------------------------------------------------------------
 * Thumbnail windowing
 * ---------------------------------------------------------------------- */

/**
 * Which thumbnail rows to mount for a scroll position. Only these render an
 * SVG, so a 500-slide deck costs a screenful of thumbnails, not 500.
 */
export function visibleThumbnailRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 2,
): { start: number; end: number } {
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight);
  return {
    start: Math.max(0, Math.min(rowCount, first - overscan)),
    end: Math.max(0, Math.min(rowCount, last + overscan)),
  };
}

/** Thumbnail columns for a width: one on a narrow phone, more on tablets and in landscape. */
export function thumbnailColumns(width: number): number {
  if (width >= 900) return 4;
  if (width >= 600) return 3;
  if (width >= 360) return 2;
  return 1;
}

/* -------------------------------------------------------------------------
 * View state across process recreation
 * ---------------------------------------------------------------------- */

export type DeckMobileMode = 'slides' | 'slide';

/**
 * Per-file position, zoom, and panel state. Device-local, exactly as on
 * desktop: it lives in `sessionStorage`, never in the document.
 */
export interface DeckViewState {
  slideId: string | null;
  mode: DeckMobileMode;
  notes: boolean;
  viewport: DeckViewport;
}

const VIEW_STATE_KEY = 'collab.deck.viewState';

function readViewStates(): Record<string, DeckViewState> {
  try {
    const raw = globalThis.sessionStorage?.getItem(VIEW_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DeckViewState>) : {};
  } catch {
    // A corrupt or unavailable store must not stop a presentation opening.
    return {};
  }
}

export function loadDeckViewState(fileId: string): DeckViewState | null {
  const state = readViewStates()[fileId];
  if (!state || typeof state !== 'object') return null;
  const viewport = state.viewport ?? FIT_VIEWPORT;
  return {
    slideId: typeof state.slideId === 'string' ? state.slideId : null,
    mode: state.mode === 'slide' ? 'slide' : 'slides',
    notes: state.notes === true,
    viewport: {
      zoom: clampDeckZoom(Number(viewport.zoom)),
      panX: Number.isFinite(viewport.panX) ? viewport.panX : 0,
      panY: Number.isFinite(viewport.panY) ? viewport.panY : 0,
    },
  };
}

export function saveDeckViewState(fileId: string, state: DeckViewState): void {
  try {
    const all = readViewStates();
    all[fileId] = state;
    globalThis.sessionStorage?.setItem(VIEW_STATE_KEY, JSON.stringify(all));
  } catch {
    // Best-effort: a full or disabled store costs a restored position, nothing more.
  }
}
