import { SHEET_LIMITS, sheetCellKey } from '../../types/sheet';
import type { SheetDocument, SheetProtectedRange, SheetWorksheet } from '../../types/sheet';

import { createSheetProtectedRangeId, SheetDocumentError } from './document';
import { normalizeRange, selectedPositions, type SheetSelection } from './selection';
import { stableRangeFromSelection } from './validation';

function rangeIndices(worksheet: SheetWorksheet, range: SheetProtectedRange['range']) {
  const rows = [
    worksheet.rowOrder.indexOf(range.startRowId),
    worksheet.rowOrder.indexOf(range.endRowId),
  ];
  const columns = [
    worksheet.columnOrder.indexOf(range.startColumnId),
    worksheet.columnOrder.indexOf(range.endColumnId),
  ];
  if ([...rows, ...columns].some((index) => index < 0)) return null;
  return {
    top: Math.min(...rows),
    bottom: Math.max(...rows),
    left: Math.min(...columns),
    right: Math.max(...columns),
  };
}

export function protectSheetSelection(
  document: SheetDocument,
  worksheetId: string,
  selection: SheetSelection,
  name?: string,
): SheetDocument {
  const worksheet = document.worksheets.find((candidate) => candidate.id === worksheetId);
  if (!worksheet) return document;
  if ((worksheet.protectedRanges?.length ?? 0) >= SHEET_LIMITS.protectedRangesPerWorksheet) {
    throw new SheetDocumentError('limit-exceeded', 'This worksheet has too many protected ranges.');
  }
  const range = stableRangeFromSelection(worksheet, {
    ...selection,
    ranges: selection.ranges.slice(0, 1),
  });
  if (!range) return document;
  const protectedRange: SheetProtectedRange = {
    id: createSheetProtectedRangeId(),
    range,
    ...(name?.trim() ? { name: name.trim() } : {}),
  };
  return {
    ...document,
    worksheets: document.worksheets.map((candidate) =>
      candidate.id === worksheetId
        ? { ...candidate, protectedRanges: [...(candidate.protectedRanges ?? []), protectedRange] }
        : candidate,
    ),
  };
}

export function removeSheetProtection(
  document: SheetDocument,
  worksheetId: string,
  protectedRangeId: string,
): SheetDocument {
  return {
    ...document,
    worksheets: document.worksheets.map((worksheet) => {
      if (worksheet.id !== worksheetId) return worksheet;
      const protectedRanges = (worksheet.protectedRanges ?? []).filter(
        (range) => range.id !== protectedRangeId,
      );
      const next = { ...worksheet };
      if (protectedRanges.length > 0) next.protectedRanges = protectedRanges;
      else delete next.protectedRanges;
      return next;
    }),
  };
}

export function selectionTouchesProtection(
  worksheet: SheetWorksheet,
  selection: SheetSelection,
): boolean {
  return selectedPositions(selection).some((position) =>
    (worksheet.protectedRanges ?? []).some((range) => {
      const rectangle = rangeIndices(worksheet, range.range);
      return (
        rectangle &&
        position.row >= rectangle.top &&
        position.row <= rectangle.bottom &&
        position.column >= rectangle.left &&
        position.column <= rectangle.right
      );
    }),
  );
}

export function assertProtectedRangesUnchanged(before: SheetDocument, after: SheetDocument): void {
  for (const source of before.worksheets) {
    const target = after.worksheets.find((worksheet) => worksheet.id === source.id);
    for (const protectedRange of source.protectedRanges ?? []) {
      if (!target)
        throw new SheetDocumentError(
          'invalid-structure',
          'A protected worksheet cannot be removed.',
        );
      const sourceBounds = rangeIndices(source, protectedRange.range);
      const targetBounds = rangeIndices(target, protectedRange.range);
      if (!sourceBounds || !targetBounds) {
        throw new SheetDocumentError(
          'invalid-structure',
          'This edit would change a protected range.',
        );
      }
      const sourceRows = source.rowOrder.slice(sourceBounds.top, sourceBounds.bottom + 1);
      const targetRows = target.rowOrder.slice(targetBounds.top, targetBounds.bottom + 1);
      const sourceColumns = source.columnOrder.slice(sourceBounds.left, sourceBounds.right + 1);
      const targetColumns = target.columnOrder.slice(targetBounds.left, targetBounds.right + 1);
      if (
        sourceRows.join('\0') !== targetRows.join('\0') ||
        sourceColumns.join('\0') !== targetColumns.join('\0')
      ) {
        throw new SheetDocumentError(
          'invalid-structure',
          'This structural edit intersects a protected range.',
        );
      }
      for (const rowId of sourceRows) {
        for (const columnId of sourceColumns) {
          const key = sheetCellKey(rowId, columnId);
          if (JSON.stringify(source.cells[key]) !== JSON.stringify(target.cells[key])) {
            throw new SheetDocumentError(
              'invalid-structure',
              'This cell belongs to a protected range.',
            );
          }
        }
      }
    }
  }
}

export function protectedRangeLabel(worksheet: SheetWorksheet, range: SheetProtectedRange): string {
  const rectangle = rangeIndices(worksheet, range.range);
  if (!rectangle) return 'Invalid range';
  const normalized = normalizeRange({
    anchor: { row: rectangle.top, column: rectangle.left },
    focus: { row: rectangle.bottom, column: rectangle.right },
  });
  return `${normalized.bottom - normalized.top + 1}R × ${normalized.right - normalized.left + 1}C`;
}
