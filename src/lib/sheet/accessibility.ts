/**
 * Screen-reader semantics for the canvas-painted `.sheet` grid.
 *
 * The grid paints cells to a canvas, so there is no DOM text for assistive
 * technology to read. Instead of mirroring the whole visible window into the
 * DOM — which would add hundreds of nodes to every scroll frame and blow the
 * Phase 9 scroll budget — the grid exposes:
 *
 * - one rendered `role="gridcell"` for the active cell, referenced through
 *   `aria-activedescendant`, so focus mode reads the cell under the cursor;
 * - a polite live region that announces the address, the content, and the
 *   shape of the selection whenever either changes.
 *
 * The functions here are pure so the wording is testable without a renderer.
 * `docs/desktop/sheet-reference.md` documents the resulting behavior, including
 * what this approach deliberately does not provide.
 */

import type { SheetCell, SheetStyle, SheetWorksheet } from '../../types/sheet';
import type { SheetFormulaComputedValue } from '../../types/sheetFormula';
import { columnLabel, formatA1 } from './address';
import type { SheetPosition } from './address';
import { formatCellDisplay, type SheetDisplayFormatOptions } from './cellValue';
import { getCell } from './operations';
import { normalizeRange, selectedCellCount } from './selection';
import type { SheetSelection } from './selection';

export interface SheetCellDescriptionOptions {
  worksheet: SheetWorksheet;
  position: SheetPosition;
  computed?: SheetFormulaComputedValue;
  style?: SheetStyle;
  displayFormat?: SheetDisplayFormatOptions;
}

/** Stable DOM id for the active-cell element an `aria-activedescendant` points at. */
export function sheetActiveCellDomId(gridId: string): string {
  return `${gridId}-active-cell`;
}

function cellContentPhrase(
  cell: SheetCell | undefined,
  options: SheetCellDescriptionOptions,
): string {
  const text = formatCellDisplay(cell, options.computed, options.style, options.displayFormat);
  if (cell?.formula) {
    // Both halves matter: the result is what the sheet shows, the source is
    // what an editor is about to change.
    return text && text !== '…'
      ? `${text}, formula ${cell.formula}`
      : `formula ${cell.formula}`;
  }
  return text || 'empty';
}

/** "B3, 1,240.00" — the address followed by what the cell reads as. */
export function describeSheetCell(options: SheetCellDescriptionOptions): string {
  const cell = getCell(options.worksheet, options.position);
  const parts = [formatA1(options.position), cellContentPhrase(cell, options)];
  if (cell?.note) parts.push('has note');
  if (cell?.link) parts.push('has link');
  if (cell?.attachments?.length) {
    parts.push(`${cell.attachments.length} attachment${cell.attachments.length === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

export interface SheetSelectionAnnouncementOptions extends SheetCellDescriptionOptions {
  selection: SheetSelection;
  readOnly?: boolean;
  /** Set when the active cell sits inside a range the editor protects. */
  protected?: boolean;
}

/**
 * What the live region says when the selection moves. Single cells announce
 * their content; larger selections announce their shape instead, because
 * reading thousands of cells aloud is worse than saying nothing useful.
 */
export function describeSheetSelection(options: SheetSelectionAnnouncementOptions): string {
  const { selection, worksheet } = options;
  const parts: string[] = [];

  if (selection.kind === 'all') {
    parts.push(`All cells selected, ${worksheet.rowOrder.length} rows by ${worksheet.columnOrder.length} columns`);
  } else if (selection.kind === 'rows' || selection.kind === 'columns') {
    const rectangle = normalizeRange(selection.ranges[selection.ranges.length - 1]);
    parts.push(selection.kind === 'rows'
      ? `Rows ${rectangle.top + 1} to ${rectangle.bottom + 1} selected`
      : `Columns ${columnLabel(rectangle.left)} to ${columnLabel(rectangle.right)} selected`);
  } else if (selection.ranges.length > 1) {
    parts.push(`${selection.ranges.length} ranges selected, ${selectedCellCount(selection)} cells`);
    parts.push(describeSheetCell(options));
  } else {
    const rectangle = normalizeRange(selection.ranges[0]);
    const height = rectangle.bottom - rectangle.top + 1;
    const width = rectangle.right - rectangle.left + 1;
    if (height === 1 && width === 1) {
      parts.push(describeSheetCell(options));
    } else {
      parts.push(`${height} by ${width} range selected, ${formatA1({ row: rectangle.top, column: rectangle.left })} to ${formatA1({ row: rectangle.bottom, column: rectangle.right })}`);
      parts.push(describeSheetCell(options));
    }
  }

  if (options.protected) parts.push('protected');
  if (options.readOnly) parts.push('read only');
  return parts.join('. ');
}
