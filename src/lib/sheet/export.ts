import { SHEET_DEFAULTS } from '../../types/sheet';
import type { SheetDocument, SheetStyle, SheetWorksheet } from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';

import { columnLabel } from './address';
import { formatCellDisplay, type SheetDisplayFormatOptions } from './cellValue';
import { getCell } from './operations';
import { normalizeRange, type SheetRectangle, type SheetSelection } from './selection';
import { resolveCellStyle } from './styles';

interface ExportCell {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetRangeExportOptions {
  computedValues?: SheetFormulaValueMap;
  displayFormat?: SheetDisplayFormatOptions;
  title?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function exportRectangle(selection: SheetSelection): SheetRectangle {
  return normalizeRange(selection.ranges[selection.ranges.length - 1]);
}

function rowHeight(worksheet: SheetWorksheet, row: number): number {
  return worksheet.rows?.[worksheet.rowOrder[row]]?.height ?? SHEET_DEFAULTS.rowHeight;
}

function columnWidth(worksheet: SheetWorksheet, column: number): number {
  return worksheet.columns?.[worksheet.columnOrder[column]]?.width ?? SHEET_DEFAULTS.columnWidth;
}

function mergedRectangle(
  worksheet: SheetWorksheet,
  row: number,
  column: number,
): SheetRectangle | null {
  for (const merge of worksheet.mergedRanges ?? []) {
    const top = worksheet.rowOrder.indexOf(merge.startRowId);
    const bottom = worksheet.rowOrder.indexOf(merge.endRowId);
    const left = worksheet.columnOrder.indexOf(merge.startColumnId);
    const right = worksheet.columnOrder.indexOf(merge.endColumnId);
    if (top < 0 || bottom < 0 || left < 0 || right < 0) continue;
    const rectangle = {
      top: Math.min(top, bottom),
      bottom: Math.max(top, bottom),
      left: Math.min(left, right),
      right: Math.max(left, right),
    };
    if (
      row >= rectangle.top &&
      row <= rectangle.bottom &&
      column >= rectangle.left &&
      column <= rectangle.right
    )
      return rectangle;
  }
  return null;
}

function layoutCells(worksheet: SheetWorksheet, rectangle: SheetRectangle) {
  const rowOffsets = [0];
  const columnOffsets = [0];
  for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
    rowOffsets.push(rowOffsets[rowOffsets.length - 1] + rowHeight(worksheet, row));
  }
  for (let column = rectangle.left; column <= rectangle.right; column += 1) {
    columnOffsets.push(columnOffsets[columnOffsets.length - 1] + columnWidth(worksheet, column));
  }
  const cells: ExportCell[] = [];
  for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
    for (let column = rectangle.left; column <= rectangle.right; column += 1) {
      const merge = mergedRectangle(worksheet, row, column);
      if (merge && (row !== merge.top || column !== merge.left)) continue;
      const boundedMerge =
        merge &&
        merge.top >= rectangle.top &&
        merge.left >= rectangle.left &&
        merge.bottom <= rectangle.bottom &&
        merge.right <= rectangle.right
          ? merge
          : null;
      const bottom = boundedMerge?.bottom ?? row;
      const right = boundedMerge?.right ?? column;
      const localRow = row - rectangle.top;
      const localColumn = column - rectangle.left;
      cells.push({
        row,
        column,
        rowSpan: bottom - row + 1,
        columnSpan: right - column + 1,
        x: columnOffsets[localColumn],
        y: rowOffsets[localRow],
        width: columnOffsets[right - rectangle.left + 1] - columnOffsets[localColumn],
        height: rowOffsets[bottom - rectangle.top + 1] - rowOffsets[localRow],
      });
    }
  }
  return {
    cells,
    width: columnOffsets[columnOffsets.length - 1],
    height: rowOffsets[rowOffsets.length - 1],
  };
}

function cellText(
  worksheet: SheetWorksheet,
  position: { row: number; column: number },
  style: SheetStyle,
  options: SheetRangeExportOptions,
): string {
  const rowId = worksheet.rowOrder[position.row];
  const columnId = worksheet.columnOrder[position.column];
  const computed =
    rowId && columnId
      ? options.computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
      : undefined;
  return formatCellDisplay(getCell(worksheet, position), computed, style, options.displayFormat);
}

function textAnchor(style: SheetStyle): 'start' | 'middle' | 'end' {
  if (style.horizontalAlign === 'center') return 'middle';
  if (style.horizontalAlign === 'right') return 'end';
  return 'start';
}

/** Builds a self-contained vector snapshot of the active selection. */
export function buildSheetRangeSvg(
  document: SheetDocument,
  worksheet: SheetWorksheet,
  selection: SheetSelection,
  options: SheetRangeExportOptions = {},
): string {
  const rectangle = exportRectangle(selection);
  const layout = layoutCells(worksheet, rectangle);
  const headerHeight = options.title ? 34 : 0;
  const body = layout.cells
    .map((cell, index) => {
      const position = { row: cell.row, column: cell.column };
      const style = resolveCellStyle(document.styles, worksheet, position);
      const value = cellText(worksheet, position, style, options);
      const anchor = textAnchor(style);
      const indent = Math.max(0, Math.min(20, style.indent ?? 0)) * 8;
      const textX =
        anchor === 'end'
          ? cell.x + cell.width - 6 - indent
          : anchor === 'middle'
            ? cell.x + cell.width / 2
            : cell.x + 6 + indent;
      const fontSize = Math.max(8, Math.min(72, style.fontSize ?? 13));
      const maxCharacters = Math.max(1, Math.floor((cell.width - 12) / (fontSize * 0.55)));
      const clipped =
        value.length > maxCharacters ? `${value.slice(0, Math.max(1, maxCharacters - 1))}…` : value;
      const cellValue = getCell(worksheet, position);
      return `<g><rect x="${cell.x}" y="${cell.y + headerHeight}" width="${cell.width}" height="${cell.height}" fill="${escapeXml(style.backgroundColor ?? '#ffffff')}" stroke="#cbd5e1"/><clipPath id="cell-${index}"><rect x="${cell.x + 2}" y="${cell.y + headerHeight + 2}" width="${Math.max(0, cell.width - 4)}" height="${Math.max(0, cell.height - 4)}"/></clipPath><text x="${textX}" y="${cell.y + headerHeight + cell.height / 2}" text-anchor="${anchor}" dominant-baseline="middle" clip-path="url(#cell-${index})" fill="${escapeXml(style.color ?? '#111827')}" font-family="${escapeXml(style.fontFamily ?? 'system-ui, sans-serif')}" font-size="${fontSize}" font-weight="${style.bold ? 700 : 400}" font-style="${style.italic ? 'italic' : 'normal'}" text-decoration="${[style.underline && 'underline', style.strikethrough && 'line-through'].filter(Boolean).join(' ')}">${escapeXml(clipped)}</text>${cellValue?.note ? `<path d="M ${cell.x + cell.width - 8} ${cell.y + headerHeight + 1} H ${cell.x + cell.width - 1} V ${cell.y + headerHeight + 8} Z" fill="#f59e0b"/>` : ''}</g>`;
    })
    .join('');
  const title = options.title
    ? `<rect width="${layout.width}" height="${headerHeight}" fill="#f8fafc"/><text x="8" y="21" font-family="system-ui,sans-serif" font-size="14" font-weight="600" fill="#111827">${escapeXml(options.title)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height + headerHeight}" viewBox="0 0 ${layout.width} ${layout.height + headerHeight}">${title}${body}</svg>`;
}

function htmlStyle(style: SheetStyle): string {
  return [
    `background:${style.backgroundColor ?? '#ffffff'}`,
    `color:${style.color ?? '#111827'}`,
    `font-family:${style.fontFamily ?? 'system-ui,sans-serif'}`,
    `font-size:${Math.max(8, Math.min(72, style.fontSize ?? 13))}px`,
    style.bold ? 'font-weight:700' : '',
    style.italic ? 'font-style:italic' : '',
    style.underline ? 'text-decoration:underline' : '',
    style.strikethrough ? 'text-decoration:line-through' : '',
    `text-align:${style.horizontalAlign ?? 'left'}`,
    `vertical-align:${style.verticalAlign ?? 'middle'}`,
    style.wrap ? 'white-space:normal' : 'white-space:nowrap',
    `padding-left:${6 + Math.max(0, Math.min(20, style.indent ?? 0)) * 8}px`,
  ]
    .filter(Boolean)
    .join(';');
}

/** Builds a complete print document for an iframe without exposing app chrome. */
export function buildSheetRangePrintHtml(
  document: SheetDocument,
  worksheet: SheetWorksheet,
  selection: SheetSelection,
  options: SheetRangeExportOptions = {},
): string {
  const rectangle = exportRectangle(selection);
  const layout = layoutCells(worksheet, rectangle);
  const byRow = new Map<number, ExportCell[]>();
  for (const cell of layout.cells) {
    const row = byRow.get(cell.row) ?? [];
    row.push(cell);
    byRow.set(cell.row, row);
  }
  const rows: string[] = [];
  for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
    const cells = (byRow.get(row) ?? [])
      .map((cell) => {
        const position = { row: cell.row, column: cell.column };
        const style = resolveCellStyle(document.styles, worksheet, position);
        return `<td${cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : ''}${cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : ''} style="${escapeXml(htmlStyle(style))}">${escapeXml(cellText(worksheet, position, style, options))}</td>`;
      })
      .join('');
    rows.push(`<tr style="height:${rowHeight(worksheet, row)}px">${cells}</tr>`);
  }
  const columns = Array.from(
    { length: rectangle.right - rectangle.left + 1 },
    (_, index) => `<col style="width:${columnWidth(worksheet, rectangle.left + index)}px">`,
  ).join('');
  const orientation = layout.width > layout.height ? 'landscape' : 'portrait';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeXml(options.title ?? worksheet.name)}</title><style>@page{size:${orientation};margin:12mm}*{box-sizing:border-box}body{margin:0;color:#111827;background:#fff;font-family:system-ui,sans-serif}h1{margin:0 0 10px;font-size:16px;letter-spacing:0}table{border-collapse:collapse;table-layout:fixed}td{overflow:hidden;border:1px solid #cbd5e1;padding:3px 6px}</style></head><body><h1>${escapeXml(options.title ?? worksheet.name)}</h1><table><colgroup>${columns}</colgroup><tbody>${rows.join('')}</tbody></table></body></html>`;
}

export async function sheetSvgToPngBase64(svg: string): Promise<string> {
  const image = new Image();
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The exported sheet image could not be rendered.'));
      image.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, image.naturalWidth);
    canvas.height = Math.max(1, image.naturalHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas export is not available in this runtime.');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('PNG encoding failed.'))),
        'image/png',
      );
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  } finally {
    URL.revokeObjectURL(source);
  }
}

export function printSheetRange(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 1_000);
  };
  frame.srcdoc = html;
  document.body.appendChild(frame);
}

export function sheetRangeLabel(selection: SheetSelection): string {
  const rectangle = exportRectangle(selection);
  return `${columnLabel(rectangle.left)}${rectangle.top + 1}-${columnLabel(rectangle.right)}${rectangle.bottom + 1}`;
}
