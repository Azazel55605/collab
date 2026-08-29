/**
 * Mobile `.ink` drawing model (Phase 4, Digital Ink).
 *
 * A `.ink` file is a JSON text document holding an {@link InkDocument}. It is
 * read and written through the same hosted text-document + offline-replica path
 * the note, Kanban, and workbook screens use, so drawing edits queue and replay
 * through the shared native pending-operation store.
 *
 * Everything about the document itself — schema, parsing, normalization,
 * repairs, serialization, operations, erasing, transforms, hit testing,
 * rendering, and the tool model — is reused from `src/lib/ink/`. Only
 * mobile-shaped helpers live here: the file predicate, the read/save wrappers,
 * the touch zoom bounds, and the per-file view state that has to survive
 * Android recreating the process. The two clients must never fork the ink
 * model.
 */
import {
  type InkSchemaSupport,
  normalizeInkDocument,
  serializeInkDocument,
} from '../../../../src/lib/ink/document';
import { INK_LIMITS } from '../../../../src/types/ink';
import type { InkDocument } from '../../../../src/types/ink';
import {
  type HostedFileEntry,
  type HostedTextDocument,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
  writeHostedDocument,
} from '../mobileTauri';

import { fileEntryExtension } from './format';

export type { InkDocument };

export function isInkFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  if (file.documentType === 'ink') return true;
  return fileEntryExtension(file) === 'ink';
}

export interface InspectedDrawing {
  document: InkDocument;
  /** `newer` means this build must not rewrite the file (Phase 1 rule). */
  support: InkSchemaSupport;
  schemaVersion: number;
  /** Non-fatal repairs applied while opening. Surfaced, never silent. */
  warnings: string[];
}

/**
 * Parse `.ink` content for display.
 *
 * Never swallows a failure into an empty document: a malformed drawing must
 * surface as an error rather than silently presenting a blank page the user
 * could then draw on and save over the top of their work.
 */
export function inspectInkContent(content: string): InspectedDrawing {
  const inspection = normalizeInkDocument(JSON.parse(content));
  return {
    document: inspection.document,
    support: inspection.support,
    schemaVersion: inspection.schemaVersion,
    warnings: inspection.warnings,
  };
}

export function serializeInk(document: InkDocument): string {
  return serializeInkDocument(document);
}

export interface LoadedDrawing extends InspectedDrawing {
  file: HostedFileEntry;
  content: string;
  source: 'network' | 'cache';
}

/**
 * Read a drawing online (warming the replica cache) and fall back to the
 * offline replica when the server is unreachable. Mirrors `readSheetWorkbook`.
 */
export async function readInkDrawing(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<LoadedDrawing> {
  const inspect = (content: string, entry: HostedFileEntry, source: 'network' | 'cache') => ({
    ...inspectInkContent(content),
    file: entry,
    content,
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
    throw new Error('This drawing is not cached for offline reading.');
  }
  return inspect(cached, file, 'cache');
}

/** Persist a drawing as a new revision and warm the replica cache. */
export async function saveInkDrawing(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  document: InkDocument,
): Promise<HostedTextDocument> {
  const content = serializeInk(document);
  const saved = await writeHostedDocument(
    serverUrl,
    vaultId,
    file.id,
    file.revisionSequence ?? 0,
    content,
  );
  void replicaCacheDocument(serverUrl, vaultId, file.id, saved.content).catch(() => {});
  return saved;
}

/** Display name for a drawing, without its extension. */
export function drawingName(file: HostedFileEntry): string {
  return file.name.replace(/\.ink$/i, '') || file.name;
}

/* -------------------------------------------------------------------------
 * Touch zoom
 * ---------------------------------------------------------------------- */

/**
 * Pinch-zoom bounds for the mobile canvas.
 *
 * Tighter than the desktop range: a phone has no scroll wheel to recover from
 * an extreme zoom, and the shared world/tile limits still apply above these.
 */
export const INK_MOBILE_SCALE = {
  min: Math.max(INK_LIMITS.minZoom, 0.1),
  max: Math.min(INK_LIMITS.maxZoom, 8),
  default: 1,
} as const;

export function clampInkScale(scale: number): number {
  if (!Number.isFinite(scale)) return INK_MOBILE_SCALE.default;
  return Math.max(INK_MOBILE_SCALE.min, Math.min(INK_MOBILE_SCALE.max, scale));
}

/* -------------------------------------------------------------------------
 * View state across process recreation
 * ---------------------------------------------------------------------- */

/**
 * Per-file page and viewport state.
 *
 * Android destroys and recreates the activity freely — a rotation, a memory
 * reclaim, or the user switching apps. Losing which page you were on and where
 * you were zoomed makes a drawing feel like it reset, so this is persisted.
 *
 * It is **device-local**, exactly as on desktop: it lives in `sessionStorage`,
 * never in the document. One person's scroll position must not become a change
 * every collaborator merges.
 */
export interface InkViewState {
  pageId: string | null;
  originX: number;
  originY: number;
  zoom: number;
}

const VIEW_STATE_KEY = 'collab.ink.viewState';

function readViewStates(): Record<string, InkViewState> {
  try {
    const raw = globalThis.sessionStorage?.getItem(VIEW_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, InkViewState>) : {};
  } catch {
    // A corrupt or unavailable store must not stop a drawing opening.
    return {};
  }
}

export function loadInkViewState(fileId: string): InkViewState | null {
  const state = readViewStates()[fileId];
  if (!state || typeof state.zoom !== 'number' || !Number.isFinite(state.zoom)) return null;
  return {
    pageId: typeof state.pageId === 'string' ? state.pageId : null,
    originX: Number.isFinite(state.originX) ? state.originX : 0,
    originY: Number.isFinite(state.originY) ? state.originY : 0,
    zoom: clampInkScale(state.zoom),
  };
}

export function saveInkViewState(fileId: string, state: InkViewState): void {
  try {
    const all = readViewStates();
    all[fileId] = state;
    globalThis.sessionStorage?.setItem(VIEW_STATE_KEY, JSON.stringify(all));
  } catch {
    // Best-effort: a full or disabled store costs a restored viewport, nothing
    // more, and must never surface as a save failure.
  }
}

export function clearInkViewState(fileId: string): void {
  try {
    const all = readViewStates();
    delete all[fileId];
    globalThis.sessionStorage?.setItem(VIEW_STATE_KEY, JSON.stringify(all));
  } catch {
    // Ignored for the same reason.
  }
}
