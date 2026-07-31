/**
 * `.xlsx` / `.csv` conversion contract.
 *
 * Mirrors `collab_sheet::convert` and `src-tauri/src/commands/sheet_convert.rs`;
 * keep all three in sync. `.sheet` remains the only editable and authoritative
 * workbook format — an import produces a new `.sheet` document and an export
 * produces a separate copy, never a live external backing model.
 */

/** What happened to one feature during a conversion. */
export type SheetConversionSeverity =
  /** Carried across with its meaning intact. */
  | 'imported'
  /** Carried across in a reduced form: a formula became its last value. */
  | 'flattened'
  /** Recognized and deliberately left out. */
  | 'skipped'
  /** Not understood by this build at all. */
  | 'unsupported';

export interface SheetConversionNote {
  severity: SheetConversionSeverity;
  feature: string;
  detail: string;
  /** Where it happened, e.g. `Budget!C4`. Never a filesystem path. */
  location?: string;
  /** How many occurrences this note was collapsed from. */
  count: number;
}

export interface SheetConversionReport {
  notes: SheetConversionNote[];
  /** True when content was dropped for hitting a limit, not for being unsupported. */
  truncated: boolean;
}

export type SheetExportFormat = 'xlsx' | 'csv';

export interface SheetImportOptions {
  /** CSV only. Omit to sniff. Use `\t` for tab. */
  delimiter?: string;
  /** CSV only. Defaults to on. */
  inferTypes?: boolean;
  /** CSV only. Defaults to on. */
  hasHeaderRow?: boolean;
}

export interface SheetImportResult {
  /** The new `.sheet` document, serialized. */
  document: string;
  /** Suggested file name, without an extension. */
  suggestedName: string;
  report: SheetConversionReport;
}

export interface SheetExportRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetExportComputedValue {
  /** `worksheetId:rowId:columnId`. */
  key: string;
  kind: 'number' | 'text' | 'boolean' | 'error';
  number?: number;
  text?: string;
  boolean?: boolean;
}

export interface SheetExportOptions {
  /** CSV only. Defaults to the first worksheet. */
  worksheetId?: string;
  /** CSV only. Zero-based inclusive rectangle. */
  range?: SheetExportRange;
  delimiter?: string;
  quoteAll?: boolean;
  /**
   * CSV only. Write formula source instead of values.
   *
   * Off by default: a consuming spreadsheet executes a leading `=`, so this is
   * always an explicit choice.
   */
  includeFormulas?: boolean;
  /**
   * CSV only. Prefix fields a spreadsheet would execute. Defaults to on, and
   * the UI must confirm before turning it off.
   */
  sanitizeFormulas?: boolean;
  /** Evaluated results so an exported file shows the numbers the editor shows. */
  computedValues?: SheetExportComputedValue[];
}

export interface SheetExportResult {
  path: string;
  bytesWritten: number;
  report: SheetConversionReport;
}

/** Extensions the importer converts into a new `.sheet` document. */
export const SHEET_IMPORT_EXTENSIONS = ['xlsx', 'xlsm', 'csv', 'tsv'] as const;

export function isSheetConvertibleFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  return (SHEET_IMPORT_EXTENSIONS as readonly string[]).includes(extension);
}

/** True when nothing was lost — every note is an `imported` one. */
export function isLosslessConversion(report: SheetConversionReport): boolean {
  return !report.truncated && report.notes.every((note) => note.severity === 'imported');
}

/** Notes grouped by severity, in the order a report should present them. */
export function groupConversionNotes(
  report: SheetConversionReport,
): { severity: SheetConversionSeverity; notes: SheetConversionNote[] }[] {
  const order: SheetConversionSeverity[] = ['unsupported', 'skipped', 'flattened', 'imported'];
  return order
    .map((severity) => ({
      severity,
      notes: report.notes.filter((note) => note.severity === severity),
    }))
    .filter((group) => group.notes.length > 0);
}

export const SHEET_CONVERSION_SEVERITY_LABELS: Record<SheetConversionSeverity, string> = {
  imported: 'Imported',
  flattened: 'Changed',
  skipped: 'Not carried across',
  unsupported: 'Not supported',
};
