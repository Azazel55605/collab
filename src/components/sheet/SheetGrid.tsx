import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { SHEET_DEFAULTS } from '../../types/sheet';
import type {
  SheetDocument,
  SheetNamedRange,
  SheetStyle,
  SheetWorksheet,
} from '../../types/sheet';
import {
  sheetFormulaResultKey,
  type SheetFormulaComputedValue,
  type SheetFormulaValueMap,
} from '../../types/sheetFormula';
import { columnLabel } from '../../lib/sheet/address';
import type { SheetPosition } from '../../lib/sheet/address';
import {
  cellAlignment,
  formatCellDisplay,
  type SheetDisplayFormatOptions,
} from '../../lib/sheet/cellValue';
import {
  formulaAutocompleteContext,
  SHEET_FUNCTIONS,
} from '../../lib/sheet/formulaFunctions';
import { getCell, mergedRangeAt } from '../../lib/sheet/operations';
import { resolveCellStyle } from '../../lib/sheet/styles';
import { tableRectangle } from '../../lib/sheet/dataTools';
import { createConditionalFormatEvaluator } from '../../lib/sheet/conditionalFormatting';
import {
  addSelectionRange,
  createSelection,
  extendSelection,
  isColumnSelected,
  isRowSelected,
  moveSelection,
  moveToEdge,
  normalizeRange,
  selectAll,
  selectColumns,
  selectRows,
  type SheetSelection,
} from '../../lib/sheet/selection';
import {
  buildColumnMetrics,
  buildRowMetrics,
  computeViewport,
  trackAtPaneOffset,
  trackOffset,
  trackPaneOffset,
  trackSize,
  type SheetAxisMetrics,
} from '../../lib/sheet/viewport';
import { cn } from '../../lib/utils';
import SheetFormulaIntellisense, {
  type SheetFormulaSuggestion,
} from './SheetFormulaIntellisense';

/**
 * Virtualized spreadsheet grid: a canvas cell layer under a DOM overlay.
 *
 * The canvas paints only the visible window plus overscan, so cost is bounded
 * by the viewport rather than by the logical grid (see
 * `src/lib/sheet/viewport.ts`). The overlay owns everything that needs to be a
 * real element — headers, resize handles, the cell editor, and the focusable
 * grid surface — which keeps selection and editing out of the paint path.
 *
 * Nothing here mutates the workbook: every change is reported through a
 * callback so the document stays owned by the session.
 */

export interface SheetGridEditing {
  position: SheetPosition;
  text: string;
  source?: 'grid' | 'formula-bar';
}

export interface SheetGridProps {
  worksheet: SheetWorksheet;
  selection: SheetSelection;
  onSelectionChange: (selection: SheetSelection) => void;
  /** Committed edit. `text` is raw user input; the caller parses and stores it. */
  onCommit: (position: SheetPosition, text: string) => void;
  editing: SheetGridEditing | null;
  onEditingChange: (editing: SheetGridEditing | null) => void;
  onClearSelection: () => void;
  onResizeTrack: (axis: 'row' | 'column', index: number, size: number) => void;
  onAutoSizeColumn: (index: number) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onFind?: () => void;
  onCopySelection?: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  onCutSelection?: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  onPasteSelection?: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  onFillSelection?: (target: SheetPosition) => void;
  scrollPosition?: { top: number; left: number };
  onScrollPositionChange?: (position: { top: number; left: number }) => void;
  readOnly?: boolean;
  computedValues?: SheetFormulaValueMap;
  formulaHighlights?: ReadonlyMap<string, 'precedent' | 'dependent'>;
  styles?: SheetDocument['styles'];
  displayFormat?: SheetDisplayFormatOptions;
  formulaReferenceMode?: boolean;
  onFormulaReferenceCommit?: (range: { anchor: SheetPosition; focus: SheetPosition }) => void;
  namedRanges?: readonly SheetNamedRange[];
  className?: string;
}

/** Fallback viewport used before measurement (and in jsdom, which has no layout). */
const FALLBACK_VIEWPORT = { width: 960, height: 540 };
const MIN_ROW_HEIGHT = 8;
const MIN_COLUMN_WIDTH = 24;

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(FALLBACK_VIEWPORT);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) setSize({ width, height });
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

interface PaintOptions {
  worksheet: SheetWorksheet;
  styles: SheetDocument['styles'];
  displayFormat?: SheetDisplayFormatOptions;
  rows: SheetAxisMetrics;
  columns: SheetAxisMetrics;
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
  frozenRows: number;
  frozenColumns: number;
  computedValues?: SheetFormulaValueMap;
  formulaHighlights?: ReadonlyMap<string, 'precedent' | 'dependent'>;
  theme: {
    text: string;
    mutedText: string;
    gridLine: string;
    frozenLine: string;
    background: string;
    font: string;
  };
}

function drawStyledCellText(
  context: CanvasRenderingContext2D,
  text: string,
  cell: ReturnType<typeof getCell>,
  computed: SheetFormulaComputedValue | undefined,
  style: SheetStyle,
  theme: PaintOptions['theme'],
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const fontSize = Math.max(8, Math.min(72, style.fontSize ?? 13));
  const fontFamily = style.fontFamily || theme.font.replace(/^.*?px\s+/, '');
  context.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${fontSize}px ${fontFamily}`;
  context.fillStyle = computed?.type === 'error'
    ? '#ef4444'
    : style.color ?? (cell?.formula ? theme.mutedText : theme.text);
  context.save();
  context.beginPath();
  context.rect(x + 1, y + 1, width - 2, height - 2);
  context.clip();

  const align = style.horizontalAlign ?? cellAlignment(cell, computed);
  context.textAlign = align;
  const indent = Math.max(0, Math.min(20, style.indent ?? 0)) * 8;
  const textX = align === 'right'
    ? x + width - 6 - indent
    : align === 'center'
      ? x + width / 2
      : x + 6 + indent;
  const lines: string[] = [];
  if (style.wrap && text.length > 0) {
    const available = Math.max(8, width - 12 - indent);
    const words = text.split(/\s+/);
    let line = '';
    const measure = (candidate: string) => (
      typeof context.measureText === 'function'
        ? context.measureText(candidate).width
        : candidate.length * fontSize * 0.55
    );
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate) > available) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  } else {
    lines.push(text);
  }

  const lineHeight = fontSize + 2;
  const visibleLines = lines.slice(0, Math.max(1, Math.floor((height - 4) / lineHeight)));
  const blockHeight = visibleLines.length * lineHeight;
  const firstY = style.verticalAlign === 'top'
    ? y + 3 + lineHeight / 2
    : style.verticalAlign === 'bottom'
      ? y + height - 3 - blockHeight + lineHeight / 2
      : y + (height - blockHeight) / 2 + lineHeight / 2;
  visibleLines.forEach((line, index) => {
    const lineY = firstY + index * lineHeight;
    context.fillText(line, textX, lineY);
    if (style.underline || style.strikethrough) {
      const textWidth = typeof context.measureText === 'function'
        ? context.measureText(line).width
        : line.length * fontSize * 0.55;
      const left = align === 'right' ? textX - textWidth : align === 'center' ? textX - textWidth / 2 : textX;
      context.strokeStyle = context.fillStyle as string;
      context.lineWidth = 1;
      if (style.underline) {
        context.beginPath();
        context.moveTo(left, lineY + fontSize / 2 + 1);
        context.lineTo(left + textWidth, lineY + fontSize / 2 + 1);
        context.stroke();
      }
      if (style.strikethrough) {
        context.beginPath();
        context.moveTo(left, lineY);
        context.lineTo(left + textWidth, lineY);
        context.stroke();
      }
    }
  });
  context.restore();
}

function drawNoteIndicator(
  context: CanvasRenderingContext2D,
  cell: ReturnType<typeof getCell>,
  x: number,
  y: number,
  width: number,
) {
  if (!cell?.note) return;
  context.save();
  context.fillStyle = '#f59e0b';
  context.beginPath();
  context.moveTo(x + width - 8, y + 1);
  context.lineTo(x + width - 1, y + 1);
  context.lineTo(x + width - 1, y + 8);
  context.closePath();
  context.fill();
  context.restore();
}

function drawStyledBorders(
  context: CanvasRenderingContext2D,
  style: SheetStyle,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const segments = [
    ['top', x, y, x + width, y],
    ['right', x + width, y, x + width, y + height],
    ['bottom', x, y + height, x + width, y + height],
    ['left', x, y, x, y + height],
  ] as const;
  for (const [side, fromX, fromY, toX, toY] of segments) {
    const border = style.borders?.[side];
    if (!border || border.style === 'none') continue;
    context.strokeStyle = border.color ?? '#6b7280';
    context.lineWidth = border.style === 'thick' ? 3 : border.style === 'medium' ? 2 : 1;
    if (typeof context.setLineDash === 'function') {
      context.setLineDash(border.style === 'dashed' ? [5, 3] : border.style === 'dotted' ? [1, 2] : []);
    }
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }
  if (typeof context.setLineDash === 'function') context.setLineDash([]);
}

interface MergeRectangle {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function mergeRectangles(worksheet: SheetWorksheet): MergeRectangle[] {
  return (worksheet.mergedRanges ?? []).flatMap((range) => {
    const startRow = worksheet.rowOrder.indexOf(range.startRowId);
    const endRow = worksheet.rowOrder.indexOf(range.endRowId);
    const startColumn = worksheet.columnOrder.indexOf(range.startColumnId);
    const endColumn = worksheet.columnOrder.indexOf(range.endColumnId);
    if (startRow < 0 || endRow < 0 || startColumn < 0 || endColumn < 0) return [];
    return [{
      top: Math.min(startRow, endRow),
      bottom: Math.max(startRow, endRow),
      left: Math.min(startColumn, endColumn),
      right: Math.max(startColumn, endColumn),
    }];
  });
}

function rectangleContainsPosition(rectangle: MergeRectangle, row: number, column: number): boolean {
  return row >= rectangle.top
    && row <= rectangle.bottom
    && column >= rectangle.left
    && column <= rectangle.right;
}

function paneTrackOffset(
  metrics: SheetAxisMetrics,
  index: number,
  scroll: number,
  frozen: number,
): number {
  return index < frozen ? trackOffset(metrics, index) : trackOffset(metrics, index) - scroll;
}

function rectangleTrackSize(metrics: SheetAxisMetrics, from: number, to: number): number {
  let size = 0;
  for (let index = from; index <= to; index += 1) size += trackSize(metrics, index);
  return size;
}

/**
 * Paints the visible cells. Returns the number of cells drawn so tests and the
 * status bar can assert the window stays bounded.
 */
function paintCells(context: CanvasRenderingContext2D, options: PaintOptions): number {
  const { worksheet, rows, columns, theme } = options;
  const viewport = computeViewport({
    rows,
    columns,
    scrollTop: options.scrollTop,
    scrollLeft: options.scrollLeft,
    viewportHeight: options.height,
    viewportWidth: options.width,
    frozenRows: options.frozenRows,
    frozenColumns: options.frozenColumns,
  });

  context.clearRect(0, 0, options.width, options.height);
  context.fillStyle = theme.background;
  context.fillRect(0, 0, options.width, options.height);
  context.font = theme.font;
  context.textBaseline = 'middle';

  const rowIndices: number[] = [];
  for (let index = 0; index < viewport.rows.frozen; index += 1) rowIndices.push(index);
  for (let index = viewport.rows.start; index < viewport.rows.end; index += 1) rowIndices.push(index);
  const columnIndices: number[] = [];
  for (let index = 0; index < viewport.columns.frozen; index += 1) columnIndices.push(index);
  for (let index = viewport.columns.start; index < viewport.columns.end; index += 1) columnIndices.push(index);
  const merges = mergeRectangles(worksheet);
  const tables = (worksheet.tables ?? []).flatMap((table) => {
    const rectangle = tableRectangle(worksheet, table);
    return rectangle ? [{ table, rectangle }] : [];
  });
  const conditionalStyleAt = createConditionalFormatEvaluator(
    options.styles,
    worksheet,
    options.computedValues,
  );
  const styleAt = (row: number, column: number): SheetStyle => {
    const explicit = resolveCellStyle(options.styles, worksheet, { row, column });
    const conditional = conditionalStyleAt({ row, column });
    const table = tables.find(({ rectangle }) => (
      row >= rectangle.top && row <= rectangle.bottom
      && column >= rectangle.left && column <= rectangle.right
    ));
    if (!table) return { ...explicit, ...conditional };
    const header = table.table.hasHeaderRow && row === table.rectangle.top;
    return {
      backgroundColor: header
        ? 'rgba(139, 92, 246, 0.18)'
        : (row - table.rectangle.top) % 2 === 0
          ? 'rgba(127, 127, 127, 0.045)'
          : undefined,
      bold: header || undefined,
      ...explicit,
      ...conditional,
    };
  };

  let painted = 0;
  for (const row of rowIndices) {
    const y = trackPaneOffset(rows, row, options.scrollTop, options.frozenRows);
    if (y === null) continue;
    const rowHeight = trackSize(rows, row);
    if (rowHeight === 0 || y > options.height) continue;

    for (const column of columnIndices) {
      if (merges.some((merge) => rectangleContainsPosition(merge, row, column))) continue;
      const x = trackPaneOffset(columns, column, options.scrollLeft, options.frozenColumns);
      if (x === null) continue;
      const columnWidth = trackSize(columns, column);
      if (columnWidth === 0 || x > options.width) continue;

      const style = styleAt(row, column);
      if (style.backgroundColor) {
        context.fillStyle = style.backgroundColor;
        context.fillRect(x + 1, y + 1, columnWidth - 1, rowHeight - 1);
      }

      // Grid lines are drawn per cell so hidden tracks collapse cleanly.
      context.strokeStyle = theme.gridLine;
      context.lineWidth = 1;
      context.strokeRect(Math.floor(x) + 0.5, Math.floor(y) + 0.5, columnWidth, rowHeight);

      const cell = getCell(worksheet, { row, column });
      const rowId = worksheet.rowOrder[row];
      const columnId = worksheet.columnOrder[column];
      const cellKey = `${rowId}:${columnId}`;
      const highlight = options.formulaHighlights?.get(cellKey);
      if (highlight) {
        context.fillStyle = highlight === 'precedent'
          ? 'rgba(34, 211, 238, 0.14)'
          : 'rgba(249, 115, 22, 0.13)';
        context.fillRect(x + 1, y + 1, columnWidth - 1, rowHeight - 1);
      }
      painted += 1;
      const computed = rowId && columnId
        ? options.computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
        : undefined;
      drawStyledBorders(context, style, x, y, columnWidth, rowHeight);
      const text = formatCellDisplay(cell, computed, style, options.displayFormat);
      if (text) {
        drawStyledCellText(
          context,
          text,
          cell,
          computed,
          style,
          theme,
          x,
          y,
          columnWidth,
          rowHeight,
        );
      }
      drawNoteIndicator(context, cell, x, y, columnWidth);
    }
  }

  // Merged ranges are painted after ordinary cells so one outer rectangle
  // replaces all internal cell lines. Only the top-left cell owns content.
  for (const merge of merges) {
    const intersectsViewport = rowIndices.some(
      (row) => row >= merge.top && row <= merge.bottom,
    ) && columnIndices.some(
      (column) => column >= merge.left && column <= merge.right,
    );
    if (!intersectsViewport) continue;

    const x = paneTrackOffset(columns, merge.left, options.scrollLeft, options.frozenColumns);
    const y = paneTrackOffset(rows, merge.top, options.scrollTop, options.frozenRows);
    const width = rectangleTrackSize(columns, merge.left, merge.right);
    const height = rectangleTrackSize(rows, merge.top, merge.bottom);
    if (width <= 0 || height <= 0 || x >= options.width || y >= options.height
      || x + width <= 0 || y + height <= 0) {
      continue;
    }

    const rowId = worksheet.rowOrder[merge.top];
    const columnId = worksheet.columnOrder[merge.left];
    const cell = getCell(worksheet, { row: merge.top, column: merge.left });
    const computed = rowId && columnId
      ? options.computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
      : undefined;
    const highlight = rowId && columnId
      ? options.formulaHighlights?.get(`${rowId}:${columnId}`)
      : undefined;
    const style = styleAt(merge.top, merge.left);

    context.fillStyle = style.backgroundColor ?? theme.background;
    context.fillRect(x, y, width, height);
    if (highlight) {
      context.fillStyle = highlight === 'precedent'
        ? 'rgba(34, 211, 238, 0.14)'
        : 'rgba(249, 115, 22, 0.13)';
      context.fillRect(x + 1, y + 1, width - 1, height - 1);
    }
    context.strokeStyle = theme.gridLine;
    context.lineWidth = 1;
    context.strokeRect(Math.floor(x) + 0.5, Math.floor(y) + 0.5, width, height);
    painted += 1;

    drawStyledBorders(context, style, x, y, width, height);
    const text = formatCellDisplay(cell, computed, style, options.displayFormat);
    if (text) {
      drawStyledCellText(context, text, cell, computed, style, theme, x, y, width, height);
    }
    drawNoteIndicator(context, cell, x, y, width);
  }

  // Frozen pane dividers, so a pinned region reads as pinned.
  context.strokeStyle = theme.frozenLine;
  context.lineWidth = 1;
  if (options.frozenRows > 0) {
    const y = trackPaneOffset(rows, options.frozenRows, options.scrollTop, options.frozenRows) ?? 0;
    context.beginPath();
    context.moveTo(0, Math.floor(y) + 0.5);
    context.lineTo(options.width, Math.floor(y) + 0.5);
    context.stroke();
  }
  if (options.frozenColumns > 0) {
    const x = trackPaneOffset(columns, options.frozenColumns, options.scrollLeft, options.frozenColumns) ?? 0;
    context.beginPath();
    context.moveTo(Math.floor(x) + 0.5, 0);
    context.lineTo(Math.floor(x) + 0.5, options.height);
    context.stroke();
  }

  return painted;
}

export default function SheetGrid({
  worksheet,
  selection,
  onSelectionChange,
  onCommit,
  editing,
  onEditingChange,
  onClearSelection,
  onResizeTrack,
  onAutoSizeColumn,
  onUndo,
  onRedo,
  onFind,
  onCopySelection,
  onCutSelection,
  onPasteSelection,
  onFillSelection,
  scrollPosition,
  onScrollPositionChange,
  readOnly = false,
  computedValues,
  formulaHighlights,
  styles = {},
  displayFormat,
  formulaReferenceMode = false,
  onFormulaReferenceCommit,
  namedRanges = [],
  className,
}: SheetGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const pendingEditorCursorRef = useRef<number | null>(null);
  const dragRef = useRef<'select' | 'formula-reference' | null>(null);
  const formulaReferenceRef = useRef<{ anchor: SheetPosition; focus: SheetPosition } | null>(null);
  const [formulaReferenceRange, setFormulaReferenceRange] = useState<
    { anchor: SheetPosition; focus: SheetPosition } | null
  >(null);
  const [editorCursor, setEditorCursor] = useState(0);
  const [editorSuggestionsOpen, setEditorSuggestionsOpen] = useState(true);
  const [selectedEditorSuggestion, setSelectedEditorSuggestion] = useState(0);
  const resizeRef = useRef<
    { axis: 'row' | 'column'; index: number; origin: number; size: number } | null
  >(null);
  const fillTargetRef = useRef<SheetPosition | null>(null);
  const [fillTarget, setFillTarget] = useState<SheetPosition | null>(null);

  const [scroll, setScroll] = useState(() => ({
    top: scrollPosition?.top ?? 0,
    left: scrollPosition?.left ?? 0,
  }));

  const headerWidth = SHEET_DEFAULTS.headerWidth;
  const headerHeight = SHEET_DEFAULTS.headerHeight;

  const size = useElementSize(scrollRef);
  const paneWidth = Math.max(0, size.width - headerWidth);
  const paneHeight = Math.max(0, size.height - headerHeight);

  const rows = useMemo(() => buildRowMetrics(worksheet), [worksheet]);
  const columns = useMemo(() => buildColumnMetrics(worksheet), [worksheet]);
  const frozenRows = Math.min(worksheet.frozen?.rows ?? 0, rows.count);
  const frozenColumns = Math.min(worksheet.frozen?.columns ?? 0, columns.count);

  const bounds = useMemo(
    () => ({ rowCount: rows.count, columnCount: columns.count }),
    [rows.count, columns.count],
  );

  const viewport = useMemo(() => computeViewport({
    rows,
    columns,
    scrollTop: scroll.top,
    scrollLeft: scroll.left,
    viewportHeight: paneHeight,
    viewportWidth: paneWidth,
    frozenRows,
    frozenColumns,
  }), [rows, columns, scroll.top, scroll.left, paneHeight, paneWidth, frozenRows, frozenColumns]);

  // ── Painting ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || paneWidth <= 0 || paneHeight <= 0) return;

    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d');
    } catch {
      // jsdom and headless environments have no 2D context. The DOM overlay
      // still renders, so the grid stays usable and testable without pixels.
      context = null;
    }
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(paneWidth * ratio);
    canvas.height = Math.floor(paneHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const canvasStyles = getComputedStyle(canvas);
    paintCells(context, {
      worksheet,
      styles,
      displayFormat,
      rows,
      columns,
      scrollTop: scroll.top,
      scrollLeft: scroll.left,
      width: paneWidth,
      height: paneHeight,
      frozenRows,
      frozenColumns,
      computedValues,
      formulaHighlights,
      theme: {
        text: canvasStyles.getPropertyValue('color') || '#e5e7eb',
        mutedText: canvasStyles.getPropertyValue('color') || '#9ca3af',
        gridLine: 'rgba(127,127,127,0.22)',
        frozenLine: 'rgba(127,127,127,0.65)',
        background: 'transparent',
        font: `13px ${canvasStyles.getPropertyValue('font-family') || 'sans-serif'}`,
      },
    });
  }, [
    worksheet,
    rows,
    columns,
    scroll,
    paneWidth,
    paneHeight,
    frozenRows,
    frozenColumns,
    computedValues,
    formulaHighlights,
    styles,
    displayFormat,
  ]);

  // ── Scrolling ──────────────────────────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = { top: element.scrollTop, left: element.scrollLeft };
    setScroll(next);
    onScrollPositionChange?.(next);
  }, [onScrollPositionChange]);

  // Restore a persisted scroll position when the tab reopens.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !scrollPosition) return;
    if (element.scrollTop !== scrollPosition.top) element.scrollTop = scrollPosition.top;
    if (element.scrollLeft !== scrollPosition.left) element.scrollLeft = scrollPosition.left;
    // Only on mount: later changes come from the user scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hit testing ────────────────────────────────────────────────────────────
  const positionFromEvent = useCallback((clientX: number, clientY: number): SheetPosition | null => {
    const pane = paneRef.current;
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    const x = clientX - rect.left - headerWidth;
    const y = clientY - rect.top - headerHeight;
    if (x < 0 || y < 0) return null;
    const position = {
      row: trackAtPaneOffset(rows, y, scroll.top, frozenRows),
      column: trackAtPaneOffset(columns, x, scroll.left, frozenColumns),
    };
    const merge = mergedRangeAt(worksheet, position);
    if (!merge) return position;
    const row = Math.min(
      worksheet.rowOrder.indexOf(merge.startRowId),
      worksheet.rowOrder.indexOf(merge.endRowId),
    );
    const column = Math.min(
      worksheet.columnOrder.indexOf(merge.startColumnId),
      worksheet.columnOrder.indexOf(merge.endColumnId),
    );
    return row >= 0 && column >= 0 ? { row, column } : position;
  }, [
    columns,
    frozenColumns,
    frozenRows,
    headerHeight,
    headerWidth,
    rows,
    scroll.left,
    scroll.top,
    worksheet,
  ]);

  const commitEditing = useCallback((advance: 'down' | 'right' | null) => {
    if (!editing) return;
    onCommit(editing.position, editing.text);
    onEditingChange(null);
    if (advance) onSelectionChange(moveSelection(selection, advance, bounds));
  }, [bounds, editing, onCommit, onEditingChange, onSelectionChange, selection]);

  const beginEditing = useCallback((position: SheetPosition, text: string) => {
    if (readOnly) return;
    onEditingChange({ position, text, source: 'grid' });
  }, [onEditingChange, readOnly]);

  useEffect(() => {
    if (!editing || editing.source === 'formula-bar') return;
    const cursor = editing.text.length;
    setEditorCursor(cursor);
    setEditorSuggestionsOpen(true);
    editorRef.current?.focus();
    editorRef.current?.setSelectionRange(cursor, cursor);
  }, [editing?.position.column, editing?.position.row, editing?.source]);

  const editorAutocomplete = useMemo(
    () => editing?.source === 'grid'
      ? formulaAutocompleteContext(editing.text, editorCursor)
      : null,
    [editing, editorCursor],
  );
  const editorSuggestions = useMemo(() => {
    if (!editorSuggestionsOpen || !editorAutocomplete) return [];
    const query = editorAutocomplete.query.toLocaleUpperCase();
    const functions: SheetFormulaSuggestion[] = SHEET_FUNCTIONS
      .filter((definition) => definition.name.startsWith(query))
      .map((definition) => ({ ...definition, kind: 'function' }));
    const names: SheetFormulaSuggestion[] = namedRanges
      .filter((namedRange) => namedRange.name.toLocaleUpperCase().startsWith(query))
      .map((namedRange) => ({
        name: namedRange.name,
        signature: namedRange.scopeWorksheetId ? 'Worksheet named range' : 'Workbook named range',
        kind: 'named-range',
      }));
    return [...functions, ...names]
      .slice(0, 8);
  }, [editorAutocomplete, editorSuggestionsOpen, namedRanges]);

  useEffect(() => {
    setSelectedEditorSuggestion(0);
  }, [editorAutocomplete?.query]);

  const placeEditorCursor = useCallback((cursor: number) => {
    pendingEditorCursorRef.current = cursor;
    setEditorCursor(cursor);
    window.requestAnimationFrame(() => {
      editorRef.current?.setSelectionRange(cursor, cursor);
      pendingEditorCursorRef.current = null;
    });
  }, []);

  const chooseEditorSuggestion = useCallback((index: number) => {
    const definition = editorSuggestions[index];
    if (!definition || !editing || !editorAutocomplete) return;
    const suffix = definition.kind === 'function' ? '(' : '';
    const next = `${editing.text.slice(0, editorAutocomplete.start)}${definition.name}${suffix}${editing.text.slice(editorAutocomplete.end)}`;
    const cursor = editorAutocomplete.start + definition.name.length + suffix.length;
    onEditingChange({ ...editing, text: next, source: 'grid' });
    setEditorSuggestionsOpen(false);
    placeEditorCursor(cursor);
    editorRef.current?.focus();
  }, [
    editing,
    editorAutocomplete,
    editorSuggestions,
    onEditingChange,
    placeEditorCursor,
  ]);

  // ── Pointer interaction ────────────────────────────────────────────────────
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const position = positionFromEvent(event.clientX, event.clientY);
    if (!position) return;

    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (formulaReferenceMode) {
      const range = { anchor: position, focus: position };
      formulaReferenceRef.current = range;
      setFormulaReferenceRange(range);
      dragRef.current = 'formula-reference';
      event.preventDefault();
      return;
    }
    if (editing) commitEditing(null);
    dragRef.current = 'select';

    if (event.shiftKey) onSelectionChange(extendSelection(selection, position));
    else if (event.ctrlKey || event.metaKey) onSelectionChange(addSelectionRange(selection, position));
    else onSelectionChange(createSelection(position));
  }, [
    commitEditing,
    editing,
    formulaReferenceMode,
    onSelectionChange,
    positionFromEvent,
    selection,
  ]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const position = positionFromEvent(event.clientX, event.clientY);
    if (!position) return;
    if (dragRef.current === 'formula-reference') {
      const current = formulaReferenceRef.current;
      if (!current) return;
      const range = { anchor: current.anchor, focus: position };
      formulaReferenceRef.current = range;
      setFormulaReferenceRange(range);
      return;
    }
    onSelectionChange(extendSelection(selection, position));
  }, [onSelectionChange, positionFromEvent, selection]);

  const endDrag = useCallback((event?: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === 'formula-reference' && formulaReferenceRef.current) {
      const focus = event ? positionFromEvent(event.clientX, event.clientY) : null;
      const completed = focus
        ? { anchor: formulaReferenceRef.current.anchor, focus }
        : formulaReferenceRef.current;
      onFormulaReferenceCommit?.(completed);
      formulaReferenceRef.current = null;
      setFormulaReferenceRange(null);
    }
    dragRef.current = null;
  }, [onFormulaReferenceCommit, positionFromEvent]);

  const cancelDrag = useCallback(() => {
    formulaReferenceRef.current = null;
    setFormulaReferenceRange(null);
    dragRef.current = null;
  }, []);

  const handleDoubleClick = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const position = positionFromEvent(event.clientX, event.clientY);
    if (!position) return;
    onSelectionChange(createSelection(position));
    const cell = getCell(worksheet, position);
    beginEditing(position, cell?.formula ?? (cell?.value === undefined || cell?.value === null ? '' : String(cell.value)));
  }, [beginEditing, onSelectionChange, positionFromEvent, worksheet]);

  // ── Keyboard interaction ───────────────────────────────────────────────────
  const isPopulated = useCallback(
    (position: SheetPosition) => getCell(worksheet, position) !== undefined,
    [worksheet],
  );

  const pageDistance = Math.max(1, Math.floor(paneHeight / SHEET_DEFAULTS.rowHeight) - 1);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const extend = event.shiftKey;
    const jump = event.ctrlKey || event.metaKey;

    if (jump && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) onRedo?.();
      else onUndo?.();
      return;
    }
    if (jump && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      onRedo?.();
      return;
    }
    if (jump && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      onFind?.();
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? 'up'
          : event.key === 'ArrowDown' ? 'down'
          : event.key === 'ArrowLeft' ? 'left'
          : 'right';
        onSelectionChange(moveSelection(selection, direction, bounds, { extend, jump, isPopulated }));
        return;
      }
      case 'PageUp':
      case 'PageDown': {
        event.preventDefault();
        onSelectionChange(moveSelection(
          selection,
          event.key === 'PageUp' ? 'up' : 'down',
          bounds,
          { extend, distance: pageDistance },
        ));
        return;
      }
      case 'Home': {
        event.preventDefault();
        onSelectionChange(moveToEdge(selection, jump ? 'grid-start' : 'row-start', bounds, extend));
        return;
      }
      case 'End': {
        event.preventDefault();
        onSelectionChange(moveToEdge(selection, jump ? 'grid-end' : 'row-end', bounds, extend));
        return;
      }
      case 'Tab': {
        event.preventDefault();
        onSelectionChange(moveSelection(selection, extend ? 'left' : 'right', bounds));
        return;
      }
      case 'Enter': {
        event.preventDefault();
        if (readOnly) return;
        const cell = getCell(worksheet, selection.active);
        beginEditing(
          selection.active,
          cell?.formula ?? (cell?.value === undefined || cell?.value === null ? '' : String(cell.value)),
        );
        return;
      }
      case 'F2': {
        event.preventDefault();
        if (readOnly) return;
        const cell = getCell(worksheet, selection.active);
        beginEditing(
          selection.active,
          cell?.formula ?? (cell?.value === undefined || cell?.value === null ? '' : String(cell.value)),
        );
        return;
      }
      case 'Delete':
      case 'Backspace': {
        event.preventDefault();
        if (!readOnly) onClearSelection();
        return;
      }
      case 'Escape': {
        onSelectionChange(createSelection(selection.active));
        return;
      }
      default:
        break;
    }

    if (jump && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      onSelectionChange(selectAll(bounds));
      return;
    }

    // Any printable character starts an edit with that character, the way a
    // spreadsheet does — no need to press Enter first.
    if (!readOnly && !jump && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      beginEditing(selection.active, event.key);
    }
  }, [
    beginEditing, bounds, editing, isPopulated, onClearSelection, onFind, onRedo,
    onSelectionChange, onUndo, pageDistance, readOnly, selection, worksheet,
  ]);

  // ── Header resize ──────────────────────────────────────────────────────────
  const startResize = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    axis: 'row' | 'column',
    index: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const metrics = axis === 'row' ? rows : columns;
    resizeRef.current = {
      axis,
      index,
      origin: axis === 'row' ? event.clientY : event.clientX,
      size: trackSize(metrics, index),
    };

    const move = (moveEvent: PointerEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      const delta = (state.axis === 'row' ? moveEvent.clientY : moveEvent.clientX) - state.origin;
      const minimum = state.axis === 'row' ? MIN_ROW_HEIGHT : MIN_COLUMN_WIDTH;
      onResizeTrack(state.axis, state.index, Math.max(minimum, state.size + delta));
    };
    const up = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [columns, onResizeTrack, rows]);

  const startFill = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (readOnly || !onFillSelection) return;
    event.preventDefault();
    event.stopPropagation();
    fillTargetRef.current = null;
    setFillTarget(null);

    const move = (moveEvent: PointerEvent) => {
      const target = positionFromEvent(moveEvent.clientX, moveEvent.clientY);
      if (!target) return;
      fillTargetRef.current = target;
      setFillTarget(target);
    };
    const up = (upEvent: PointerEvent) => {
      const target = positionFromEvent(upEvent.clientX, upEvent.clientY) ?? fillTargetRef.current;
      fillTargetRef.current = null;
      setFillTarget(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (target) onFillSelection(target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [onFillSelection, positionFromEvent, readOnly]);

  // ── Overlay geometry ───────────────────────────────────────────────────────
  const visibleRows = useMemo(() => {
    const indices: number[] = [];
    for (let index = 0; index < viewport.rows.frozen; index += 1) indices.push(index);
    for (let index = viewport.rows.start; index < viewport.rows.end; index += 1) indices.push(index);
    return indices;
  }, [viewport.rows]);

  const visibleColumns = useMemo(() => {
    const indices: number[] = [];
    for (let index = 0; index < viewport.columns.frozen; index += 1) indices.push(index);
    for (let index = viewport.columns.start; index < viewport.columns.end; index += 1) indices.push(index);
    return indices;
  }, [viewport.columns]);

  const rectangleStyle = useCallback((
    top: number,
    left: number,
    bottom: number,
    right: number,
  ): CSSProperties | null => {
    const y = trackPaneOffset(rows, top, scroll.top, frozenRows);
    const x = trackPaneOffset(columns, left, scroll.left, frozenColumns);
    if (y === null || x === null) return null;
    let height = 0;
    for (let index = top; index <= bottom; index += 1) height += trackSize(rows, index);
    let width = 0;
    for (let index = left; index <= right; index += 1) width += trackSize(columns, index);
    return {
      top: y + headerHeight,
      left: x + headerWidth,
      width,
      height,
    };
  }, [columns, frozenColumns, frozenRows, headerHeight, headerWidth, rows, scroll.left, scroll.top]);

  const activeMerge = mergedRangeAt(worksheet, selection.active);
  const fillSourceRectangle = selection.kind === 'cells' && selection.ranges.length > 0
    ? normalizeRange(selection.ranges[selection.ranges.length - 1])
    : null;
  const fillSourceStyle = fillSourceRectangle
    ? rectangleStyle(
      fillSourceRectangle.top,
      fillSourceRectangle.left,
      fillSourceRectangle.bottom,
      fillSourceRectangle.right,
    )
    : null;
  const fillPreviewStyle = fillTarget && fillSourceRectangle
    ? rectangleStyle(
      Math.min(fillSourceRectangle.top, fillTarget.row),
      Math.min(fillSourceRectangle.left, fillTarget.column),
      Math.max(fillSourceRectangle.bottom, fillTarget.row),
      Math.max(fillSourceRectangle.right, fillTarget.column),
    )
    : null;
  const activeStyle = useMemo(() => {
    if (activeMerge) {
      const top = worksheet.rowOrder.indexOf(activeMerge.startRowId);
      const bottom = worksheet.rowOrder.indexOf(activeMerge.endRowId);
      const left = worksheet.columnOrder.indexOf(activeMerge.startColumnId);
      const right = worksheet.columnOrder.indexOf(activeMerge.endColumnId);
      if (top >= 0 && bottom >= 0 && left >= 0 && right >= 0) {
        return rectangleStyle(Math.min(top, bottom), Math.min(left, right), Math.max(top, bottom), Math.max(left, right));
      }
    }
    return rectangleStyle(selection.active.row, selection.active.column, selection.active.row, selection.active.column);
  }, [activeMerge, rectangleStyle, selection.active, worksheet.columnOrder, worksheet.rowOrder]);

  const editorStyle = useMemo(() => (
    editing
      ? (() => {
        const merge = mergedRangeAt(worksheet, editing.position);
        if (!merge) {
          return rectangleStyle(
            editing.position.row,
            editing.position.column,
            editing.position.row,
            editing.position.column,
          );
        }
        const top = worksheet.rowOrder.indexOf(merge.startRowId);
        const bottom = worksheet.rowOrder.indexOf(merge.endRowId);
        const left = worksheet.columnOrder.indexOf(merge.startColumnId);
        const right = worksheet.columnOrder.indexOf(merge.endColumnId);
        return rectangleStyle(
          Math.min(top, bottom),
          Math.min(left, right),
          Math.max(top, bottom),
          Math.max(left, right),
        );
      })()
      : null
  ), [editing, rectangleStyle, worksheet]);
  const editorIntellisenseStyle = useMemo<CSSProperties | undefined>(() => {
    if (!editorStyle || editing?.source !== 'grid' || !editing.text.startsWith('=')) {
      return undefined;
    }
    const editorTop = Number(editorStyle.top ?? 0);
    const editorLeft = Number(editorStyle.left ?? headerWidth);
    const editorHeight = Number(editorStyle.height ?? 0);
    const availableWidth = Math.max(0, size.width - headerWidth);
    const width = Math.min(360, Math.max(240, availableWidth));
    const left = Math.min(
      Math.max(headerWidth, editorLeft),
      Math.max(headerWidth, size.width - width),
    );
    const belowTop = editorTop + editorHeight + 2;
    const top = size.height - belowTop >= 150
      ? belowTop
      : Math.max(headerHeight, editorTop - 220);
    return { top, left, width };
  }, [editing, editorStyle, headerHeight, headerWidth, size.height, size.width]);

  return (
    <div
      ref={scrollRef}
      className={cn('relative flex-1 overflow-auto outline-none', className)}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      onCopy={onCopySelection}
      onCut={onCutSelection}
      onPaste={onPasteSelection}
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.count}
      aria-colcount={columns.count}
      aria-readonly={readOnly || undefined}
      aria-label={`${worksheet.name} grid`}
      data-testid="sheet-grid"
    >
      {/* Spacer drives native scrollbars for the full logical grid. */}
      <div
        style={{
          width: columns.totalSize + headerWidth,
          height: rows.totalSize + headerHeight,
          position: 'relative',
        }}
      >
        {/* Sticky pane stays glued to the viewport corner while the spacer scrolls. */}
        <div
          ref={paneRef}
          className="sticky left-0 top-0 overflow-hidden"
          style={{ width: size.width, height: size.height }}
        >
          <canvas
            ref={canvasRef}
            className="absolute text-foreground"
            style={{
              top: headerHeight,
              left: headerWidth,
              width: paneWidth,
              height: paneHeight,
            }}
            aria-hidden
          />

          {/* Corner: select-all */}
          <button
            type="button"
            aria-label="Select all cells"
            onClick={() => onSelectionChange(selectAll(bounds))}
            className="absolute left-0 top-0 border-b border-r border-border/60 bg-muted/40 text-[10px] text-muted-foreground"
            style={{ width: headerWidth, height: headerHeight }}
          />

          {/* Column headers */}
          <div
            className="absolute overflow-hidden"
            style={{ left: headerWidth, top: 0, width: paneWidth, height: headerHeight }}
          >
            {visibleColumns.map((index) => {
              const x = trackPaneOffset(columns, index, scroll.left, frozenColumns);
              const width = trackSize(columns, index);
              if (x === null || width === 0) return null;
              return (
                <div
                  key={worksheet.columnOrder[index]}
                  role="columnheader"
                  aria-label={columnLabel(index)}
                  onPointerDown={(event) => {
                    if (event.shiftKey) {
                      onSelectionChange(extendSelection(selection, { row: bounds.rowCount - 1, column: index }));
                    } else {
                      onSelectionChange(selectColumns(index, index, bounds));
                    }
                  }}
                  onDoubleClick={() => onAutoSizeColumn(index)}
                  className={cn(
                    'absolute flex h-full items-center justify-center border-b border-r border-border/60 text-[11px] select-none',
                    isColumnSelected(selection, index)
                      ? 'bg-primary/20 text-foreground'
                      : 'bg-muted/40 text-muted-foreground',
                  )}
                  style={{ left: x, width }}
                >
                  {columnLabel(index)}
                  <span
                    role="separator"
                    aria-label={`Resize column ${columnLabel(index)}`}
                    onPointerDown={(event) => startResize(event, 'column', index)}
                    className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/60"
                  />
                </div>
              );
            })}
          </div>

          {/* Row headers */}
          <div
            className="absolute overflow-hidden"
            style={{ left: 0, top: headerHeight, width: headerWidth, height: paneHeight }}
          >
            {visibleRows.map((index) => {
              const y = trackPaneOffset(rows, index, scroll.top, frozenRows);
              const height = trackSize(rows, index);
              if (y === null || height === 0) return null;
              return (
                <div
                  key={worksheet.rowOrder[index]}
                  role="rowheader"
                  aria-label={`Row ${index + 1}`}
                  onPointerDown={(event) => {
                    if (event.shiftKey) {
                      onSelectionChange(extendSelection(selection, { row: index, column: bounds.columnCount - 1 }));
                    } else {
                      onSelectionChange(selectRows(index, index, bounds));
                    }
                  }}
                  className={cn(
                    'absolute flex w-full items-center justify-center border-b border-r border-border/60 text-[11px] select-none',
                    isRowSelected(selection, index)
                      ? 'bg-primary/20 text-foreground'
                      : 'bg-muted/40 text-muted-foreground',
                  )}
                  style={{ top: y, height }}
                >
                  {index + 1}
                  <span
                    role="separator"
                    aria-label={`Resize row ${index + 1}`}
                    onPointerDown={(event) => startResize(event, 'row', index)}
                    className="absolute bottom-0 left-0 h-1 w-full cursor-row-resize hover:bg-primary/60"
                  />
                </div>
              );
            })}
          </div>

          {/* Cell surface: pointer target and selection overlay */}
          <div
            className="absolute"
            style={{ left: headerWidth, top: headerHeight, width: paneWidth, height: paneHeight }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
            onDoubleClick={handleDoubleClick}
            data-testid="sheet-cell-surface"
          />

          {selection.ranges.map((range, index) => {
            const rectangle = normalizeRange(range);
            const style = rectangleStyle(rectangle.top, rectangle.left, rectangle.bottom, rectangle.right);
            if (!style) return null;
            return (
              <div
                key={index}
                aria-hidden
                className="pointer-events-none absolute border border-primary/70 bg-primary/10"
                style={style}
              />
            );
          })}

          {formulaReferenceRange && (() => {
            const rectangle = normalizeRange(formulaReferenceRange);
            const style = rectangleStyle(
              rectangle.top,
              rectangle.left,
              rectangle.bottom,
              rectangle.right,
            );
            return style ? (
              <div
                aria-hidden
                className="pointer-events-none absolute border-2 border-cyan-400 bg-cyan-400/10"
                style={style}
              />
            ) : null;
          })()}

          {activeStyle && !editing && (
            <div
              aria-hidden
              className="pointer-events-none absolute border-2 border-primary"
              style={activeStyle}
            />
          )}

          {fillPreviewStyle && (
            <div
              aria-hidden
              className="pointer-events-none absolute border-2 border-dashed border-primary/80 bg-primary/5"
              style={fillPreviewStyle}
            />
          )}

          {!readOnly && !editing && onFillSelection && fillSourceStyle && (
            <button
              type="button"
              aria-label="Fill selection"
              title="Drag to fill cells"
              onPointerDown={startFill}
              className="absolute z-20 size-2 cursor-crosshair border border-background bg-primary p-0"
              style={{
                left: Number(fillSourceStyle.left) + Number(fillSourceStyle.width) - 4,
                top: Number(fillSourceStyle.top) + Number(fillSourceStyle.height) - 4,
              }}
            />
          )}

          {editing && editorStyle && (
            <>
              <input
                ref={editorRef}
                value={editing.text}
                aria-label="Cell editor"
                onClick={(event) => {
                  pendingEditorCursorRef.current = null;
                  setEditorCursor(event.currentTarget.selectionStart ?? editing.text.length);
                }}
                onSelect={(event) => {
                  setEditorCursor(
                    pendingEditorCursorRef.current
                      ?? event.currentTarget.selectionStart
                      ?? editing.text.length,
                  );
                }}
                onChange={(event) => {
                  pendingEditorCursorRef.current = null;
                  onEditingChange({ ...editing, text: event.target.value, source: 'grid' });
                  setEditorCursor(event.currentTarget.selectionStart ?? event.target.value.length);
                  setEditorSuggestionsOpen(true);
                }}
                onKeyDown={(event) => {
                  if (editorSuggestions.length > 0 && event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelectedEditorSuggestion(
                      (current) => (current + 1) % editorSuggestions.length,
                    );
                  } else if (editorSuggestions.length > 0 && event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelectedEditorSuggestion(
                      (current) => (
                        current - 1 + editorSuggestions.length
                      ) % editorSuggestions.length,
                    );
                  } else if (
                    editorSuggestions.length > 0
                    && (event.key === 'Enter' || event.key === 'Tab')
                  ) {
                    event.preventDefault();
                    chooseEditorSuggestion(selectedEditorSuggestion);
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    commitEditing('down');
                  } else if (event.key === 'Tab') {
                    event.preventDefault();
                    commitEditing('right');
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    if (editorSuggestionsOpen && editorSuggestions.length > 0) {
                      setEditorSuggestionsOpen(false);
                    } else {
                      onEditingChange(null);
                    }
                  }
                  event.stopPropagation();
                }}
                onBlur={() => commitEditing(null)}
                className="absolute z-10 border-2 border-primary bg-background px-1 font-mono text-[13px] outline-none"
                style={editorStyle}
              />
              {editorIntellisenseStyle && (
                <SheetFormulaIntellisense
                  value={editing.text}
                  cursor={editorCursor}
                  suggestions={editorSuggestions}
                  selectedSuggestion={selectedEditorSuggestion}
                  onSelectSuggestion={setSelectedEditorSuggestion}
                  onChooseSuggestion={chooseEditorSuggestion}
                  className="absolute z-30"
                  style={editorIntellisenseStyle}
                  label="Cell formula IntelliSense"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
