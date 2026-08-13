/**
 * What the mobile app can create.
 *
 * One table rather than a branch per call site, so adding a document type is a
 * row here and the Files screen, its tests, and any future create surface all
 * pick it up together.
 *
 * Only types with a **fully editable** mobile screen are offered. Creating a
 * document the app can then only stare at would be worse than not offering it:
 * `.canvas` and `.logic` open read-only on mobile, so they are not here.
 */

import { serializeInkDocument, createInkDocument } from '../../../../src/lib/ink/document';
import { createEmptySheetDocument, serializeSheetDocument } from '../../../../src/lib/sheet/document';
import { serializeBoard, createColumn, addColumn } from './kanban';
import { normalizeKanbanBoard } from '../../../../src/types/kanban';
import type { FileGlyph } from './format';
import type { ActiveSheet } from '../state/store';
import type { HostedFileEntry } from '../mobileTauri';

export type NewDocumentKind = 'note' | 'kanban' | 'sheet' | 'ink';

/** The hosted document type the server stores it as. */
type HostedDocumentType = 'note' | 'kanban' | 'canvas' | 'sheet' | 'ink';

export interface NewDocumentType {
  kind: NewDocumentKind;
  /** File-tree glyph, so the picker and the list agree on what a type looks like. */
  glyph: FileGlyph;
  /** Menu label. */
  label: string;
  extension: string;
  documentType: HostedDocumentType;
  placeholder: string;
  /** Initial file content. A note starts genuinely empty; the rest need a
   *  valid document, or the editor would open something it must refuse. */
  initialContent: (name: string) => string;
  /** Which screen opens once it exists. */
  open: (fileId: string) => ActiveSheet;
}

export const NEW_DOCUMENT_TYPES: NewDocumentType[] = [
  {
    kind: 'note',
    label: 'Note',
    glyph: 'note',
    extension: 'md',
    documentType: 'note',
    placeholder: 'Untitled',
    initialContent: () => '',
    open: (fileId) => ({ kind: 'note', fileId }),
  },
  {
    kind: 'kanban',
    label: 'Board',
    glyph: 'kanban',
    extension: 'kanban',
    documentType: 'kanban',
    placeholder: 'Untitled Board',
    // A board with no columns has nowhere to add a card, so a new one starts
    // with the three most people would have made themselves.
    initialContent: () => {
      let board = normalizeKanbanBoard({ columns: [] });
      for (const title of ['To do', 'In progress', 'Done']) {
        board = addColumn(board, createColumn(title));
      }
      return serializeBoard(board);
    },
    open: (fileId) => ({ kind: 'kanban', fileId }),
  },
  {
    kind: 'sheet',
    label: 'Spreadsheet',
    glyph: 'sheet',
    extension: 'sheet',
    documentType: 'sheet',
    placeholder: 'Untitled Spreadsheet',
    initialContent: (name) => serializeSheetDocument(createEmptySheetDocument(name)),
    open: (fileId) => ({ kind: 'workbook', fileId }),
  },
  {
    kind: 'ink',
    label: 'Drawing',
    glyph: 'ink',
    extension: 'ink',
    documentType: 'ink',
    placeholder: 'Untitled Drawing',
    initialContent: (name) => serializeInkDocument(createInkDocument({ name })),
    open: (fileId) => ({ kind: 'drawing', fileId }),
  },
];

export function newDocumentType(kind: NewDocumentKind): NewDocumentType {
  const found = NEW_DOCUMENT_TYPES.find((entry) => entry.kind === kind);
  if (!found) throw new Error(`Unknown document type "${kind}".`);
  return found;
}

/**
 * Applies the type's extension to a typed name.
 *
 * A name that already ends in the right extension is left alone, so typing
 * `Notes.md` does not produce `Notes.md.md`. Anything else keeps whatever the
 * user typed and gains the extension — `report.2026` becomes
 * `report.2026.sheet` rather than losing the part after the dot.
 */
export function newDocumentFileName(kind: NewDocumentKind, value: string): string {
  const type = newDocumentType(kind);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Enter a ${type.label.toLowerCase()} name.`);
  const suffix = `.${type.extension}`;
  return trimmed.toLowerCase().endsWith(suffix.toLowerCase()) ? trimmed : `${trimmed}${suffix}`;
}

/** The base name a document's initial content should be built from. */
export function newDocumentBaseName(kind: NewDocumentKind, fileName: string): string {
  const suffix = `.${newDocumentType(kind).extension}`;
  return fileName.toLowerCase().endsWith(suffix.toLowerCase())
    ? fileName.slice(0, -suffix.length)
    : fileName;
}

/** True when the vault's capabilities allow creating documents at all. */
export function canCreateDocuments(entry: { capabilities: string[] }): boolean {
  return entry.capabilities.includes('file.create');
}

export type { HostedFileEntry };
