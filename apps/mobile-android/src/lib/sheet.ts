/**
 * Mobile `.sheet` workbook model (Phase 8, Advanced Tables).
 *
 * A `.sheet` file is a JSON text document holding a {@link SheetDocument}. It is
 * read and written through the same hosted text-document + offline-replica path
 * the note, Kanban, and logic screens use, so workbook edits queue and replay
 * through the shared native pending-operation store.
 *
 * Everything about the document itself — schema, parsing, normalization,
 * repairs, serialization, structural operations, formatting, validation, and
 * filtering — is reused from `src/lib/sheet/`. Only mobile-shaped helpers live
 * here: the file predicate, the read/save wrappers, and the bounded row/column
 * windowing a touch grid needs. The two clients must never fork the workbook
 * model.
 */
import {
  inspectSheetDocumentText,
  serializeSheetDocument,
  type SheetSchemaSupport,
} from '../../../../src/lib/sheet/document';
import { SHEET_DEFAULTS } from '../../../../src/types/sheet';
import type { SheetDocument, SheetWorksheet } from '../../../../src/types/sheet';
import {
  type HostedFileEntry,
  type HostedTextDocument,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
  writeHostedDocument,
} from '../mobileTauri';

import { fileEntryExtension } from './format';

export type { SheetDocument, SheetWorksheet };

export function isSheetFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  if (file.documentType === 'sheet') return true;
  return fileEntryExtension(file) === 'sheet';
}

export interface InspectedWorkbook {
  document: SheetDocument;
  /** `newer` means this build must not rewrite the file (Phase 1 rule). */
  support: SheetSchemaSupport;
  schemaVersion: number;
  /** Non-fatal repairs applied while opening. Surfaced, never silent. */
  warnings: string[];
}

/**
 * Parse `.sheet` content for display. Unlike the Kanban/logic parsers this
 * never swallows a failure into an empty document: a malformed workbook must
 * surface as an error rather than silently presenting an empty grid the user
 * could then save over.
 */
export function inspectSheetContent(content: string, name: string): InspectedWorkbook {
  const inspection = inspectSheetDocumentText(content, name);
  return {
    document: inspection.document,
    support: inspection.support,
    schemaVersion: inspection.schemaVersion,
    warnings: inspection.warnings,
  };
}

export function serializeSheet(document: SheetDocument): string {
  return serializeSheetDocument(document);
}

export interface LoadedWorkbook extends InspectedWorkbook {
  file: HostedFileEntry;
  content: string;
  source: 'network' | 'cache';
}

/**
 * Read a workbook online (warming the replica cache) and fall back to the
 * offline replica when the server is unreachable. Mirrors `readKanbanDocument`.
 */
export async function readSheetWorkbook(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<LoadedWorkbook> {
  const inspect = (content: string, entry: HostedFileEntry, source: 'network' | 'cache') => ({
    ...inspectSheetContent(content, workbookName(entry)),
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
    throw new Error('This workbook is not cached for offline reading.');
  }
  return inspect(cached, file, 'cache');
}

/** Persist a workbook as a new revision and warm the replica cache. */
export async function saveSheetWorkbook(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  document: SheetDocument,
): Promise<HostedTextDocument> {
  const content = serializeSheet(document);
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

/** Display name for a workbook, without its extension. */
export function workbookName(file: HostedFileEntry): string {
  return file.name.replace(/\.sheet$/i, '') || file.name;
}

// ── Touch zoom ───────────────────────────────────────────────────────────────

/**
 * Pinch-zoom bounds for the mobile grid. The lower bound keeps a cell tappable
 * (roughly a 24 px row at the default 24 px row height) and the upper bound
 * keeps a single cell from filling the screen.
 */
export const SHEET_MOBILE_SCALE = { min: 0.6, max: 2.4, default: 1 } as const;

export function clampSheetScale(scale: number): number {
  if (!Number.isFinite(scale)) return SHEET_MOBILE_SCALE.default;
  return Math.max(SHEET_MOBILE_SCALE.min, Math.min(SHEET_MOBILE_SCALE.max, scale));
}

/** Default row height and column width at the current pinch scale. */
export function scaledDefaults(worksheet: SheetWorksheet, scale: number) {
  return {
    rowHeight: (worksheet.defaultRowHeight ?? SHEET_DEFAULTS.rowHeight) * scale,
    columnWidth: (worksheet.defaultColumnWidth ?? SHEET_DEFAULTS.columnWidth) * scale,
  };
}
