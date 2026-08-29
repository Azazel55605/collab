/**
 * Vault-level `.xlsx` / `.csv` conversion.
 *
 * The bytes never enter the webview: `sheetConvertImport` reads and parses the
 * source natively and hands back a finished `.sheet` document, which this
 * module creates as a normal vault document through the mode-agnostic
 * `VaultClient`. Export is the mirror image — the open document is serialized,
 * written natively, and left completely alone.
 *
 * The source file is never modified, and the exported copy never becomes the
 * backing file of the open workbook.
 */
import type { SheetDocument } from '../../types/sheet';
import type {
  SheetConversionReport,
  SheetExportComputedValue,
  SheetExportFormat,
  SheetExportOptions,
  SheetExportResult,
  SheetImportOptions,
} from '../../types/sheetConversion';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import type { NoteFile } from '../../types/vault';
import { tauriCommands } from '../tauri';
import type { VaultClient } from '../vaultClient';

import { serializeSheetDocument } from './document';

export interface SheetImportOutcome {
  /** Vault-relative path of the created `.sheet` document. */
  relativePath: string;
  report: SheetConversionReport;
}

function joinVaultPath(folder: string | undefined, name: string): string {
  return folder ? `${folder.replace(/\/+$/, '')}/${name}` : name;
}

/**
 * Picks a free `<name>.sheet` path, counting up rather than overwriting: a
 * conversion must never replace a workbook the user already has.
 */
export function nextAvailableWorkbookPath(
  folder: string | undefined,
  stem: string,
  existing: NoteFile[],
): string {
  const taken = new Set(existing.map((file) => file.relativePath.toLowerCase()));
  let candidate = joinVaultPath(folder, `${stem}.sheet`);
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = joinVaultPath(folder, `${stem} ${counter}.sheet`);
    counter += 1;
  }
  return candidate;
}

/**
 * Converts an external spreadsheet file into a new `.sheet` document in the
 * vault and returns where it landed plus what the conversion did.
 */
export async function importWorkbookFile(
  client: VaultClient,
  sourcePath: string,
  options: {
    targetFolder?: string;
    existingFiles?: NoteFile[];
    importOptions?: SheetImportOptions;
    /** Injectable so tests get a stable identity. */
    workbookId?: string;
    timestamp?: string;
  } = {},
): Promise<SheetImportOutcome> {
  const converted = await tauriCommands.sheetConvertImport(
    sourcePath,
    options.workbookId ?? crypto.randomUUID(),
    options.timestamp ?? new Date().toISOString(),
    options.importOptions,
  );

  const relativePath = nextAvailableWorkbookPath(
    options.targetFolder,
    converted.suggestedName,
    options.existingFiles ?? [],
  );

  await client.createDocument(relativePath);
  // A freshly created document starts empty; the converted workbook becomes its
  // first real revision, using the created version as the optimistic base.
  const created = await client.readDocument(relativePath);
  await client.writeDocument(relativePath, converted.document, created.version, created.content);

  return { relativePath, report: converted.report };
}

/**
 * Flattens the editor's computed values into the wire shape the exporter uses,
 * so an exported file shows the same numbers the grid shows.
 */
export function computedValuesForExport(
  document: SheetDocument,
  computed: SheetFormulaValueMap | undefined,
): SheetExportComputedValue[] {
  if (!computed) return [];
  const out: SheetExportComputedValue[] = [];
  for (const worksheet of document.worksheets) {
    for (const key of Object.keys(worksheet.cells)) {
      const separator = key.indexOf(':');
      if (separator < 0) continue;
      const rowId = key.slice(0, separator);
      const columnId = key.slice(separator + 1);
      if (!worksheet.cells[key]?.formula) continue;
      const value = computed.get(sheetFormulaResultKey(worksheet.id, rowId, columnId));
      if (!value) continue;
      const identity = `${worksheet.id}:${rowId}:${columnId}`;
      switch (value.type) {
        case 'number':
          out.push({ key: identity, kind: 'number', number: value.value });
          break;
        case 'text':
          out.push({ key: identity, kind: 'text', text: value.value });
          break;
        case 'boolean':
          out.push({ key: identity, kind: 'boolean', boolean: value.value });
          break;
        case 'error':
          out.push({ key: identity, kind: 'error', text: value.value });
          break;
        default:
          break;
      }
    }
  }
  return out;
}

export function defaultExportFileName(document: SheetDocument, format: SheetExportFormat): string {
  const stem = document.name.trim() || 'Workbook';
  return `${stem}.${format}`;
}

/**
 * Writes the workbook out as a separate copy. Returns null when the user
 * dismisses the destination dialog.
 */
export async function exportWorkbookFile(
  document: SheetDocument,
  format: SheetExportFormat,
  options: SheetExportOptions = {},
): Promise<SheetExportResult | null> {
  const target = await tauriCommands.showDownloadDialog(defaultExportFileName(document, format));
  if (!target) return null;
  return tauriCommands.sheetConvertExport(
    serializeSheetDocument(document),
    target,
    format,
    options,
  );
}
