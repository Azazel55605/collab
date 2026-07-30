/**
 * Touch spreadsheet grid for the mobile companion app (Phase 8).
 *
 * Geometry, selection, styling, and formatting all come from the shared
 * `src/lib/sheet/` modules — this component only decides how a phone renders and
 * touches that model:
 *
 * - Only the rows and columns inside the current viewport window (from
 *   `computeViewport`) become DOM nodes, so a 1,000,000 x 16,384 logical grid
 *   costs the same as a small one.
 * - Pinch zoom is a scale factor applied to the shared metrics rather than a
 *   second geometry model; the viewport request is converted into unscaled
 *   units so the shared window math stays authoritative.
 * - Frozen rows and columns are pinned with the live scroll offset instead of
 *   `position: sticky`, because every cell is absolutely positioned.
 * - Range selection uses two draggable handles rather than shift-click.
 *
 * Nothing here mutates the workbook: edits are reported through callbacks.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from 'react';

import { SHEET_DEFAULTS } from '../../../../src/types/sheet';
import type { SheetDocument, SheetWorksheet } from '../../../../src/types/sheet';
import {
  sheetFormulaResultKey,
  type SheetFormulaValueMap,
} from '../../../../src/types/sheetFormula';
import { columnLabel, formatA1, type SheetPosition } from '../../../../src/lib/sheet/address';
import {
  cellAlignment,
  formatCellDisplay,
  type SheetDisplayFormatOptions,
} from '../../../../src/lib/sheet/cellValue';
import { createConditionalFormatEvaluator } from '../../../../src/lib/sheet/conditionalFormatting';
import { getCell, mergedRangeAt, rangeRectangle } from '../../../../src/lib/sheet/operations';
import { resolveCellStyle } from '../../../../src/lib/sheet/styles';
import {
  isColumnSelected,
  isRowSelected,
  normalizeRange,
  selectCell,
  selectColumns,
  selectRows,
  type SheetSelection,
} from '../../../../src/lib/sheet/selection';
import {
  buildColumnMetrics,
  buildRowMetrics,
  computeViewport,
  trackAtPaneOffset,
  trackOffset,
  trackSize,
  type SheetAxisMetrics,
} from '../../../../src/lib/sheet/viewport';
import { clampSheetScale, SHEET_MOBILE_SCALE } from '../lib/sheet';

const HEADER_HEIGHT = 26;
const HEADER_WIDTH = 46;
const LONG_PRESS_MS = 420;
const TAP_MOVE_TOLERANCE = 12;
/** jsdom reports a zero-size element; fall back so tests still render a window. */
const FALLBACK_VIEWPORT = { width: 360, height: 480 };

export interface SheetTouchGridProps {
  document: SheetDocument;
  worksheet: SheetWorksheet;
  selection: SheetSelection;
  onSelectionChange: (selection: SheetSelection) => void;
  /** A tap on the already-active cell, i.e. "open the editor for this cell". */
  onActivateCell: (position: SheetPosition) => void;
  /** A long press anywhere in the grid, i.e. "show cell actions". */
  onLongPressCell?: (position: SheetPosition) => void;
  computedValues?: SheetFormulaValueMap;
  displayFormat?: SheetDisplayFormatOptions;
  scale?: number;
  onScaleChange?: (scale: number) => void;
}

interface PinchState {
  distance: number;
  scale: number;
}

interface TouchPoint {
  clientX: number;
  clientY: number;
}

function touchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function styleToCss(style: ReturnType<typeof resolveCellStyle>, scale: number): CSSProperties {
  const css: CSSProperties = {};
  if (style.backgroundColor) css.background = style.backgroundColor;
  if (style.color) css.color = style.color;
  if (style.bold) css.fontWeight = 700;
  if (style.italic) css.fontStyle = 'italic';
  if (style.fontFamily) css.fontFamily = style.fontFamily;
  const decorations = [
    style.underline ? 'underline' : '',
    style.strikethrough ? 'line-through' : '',
  ].filter(Boolean);
  if (decorations.length > 0) css.textDecoration = decorations.join(' ');
  const fontSize = Math.max(8, Math.min(72, style.fontSize ?? 12));
  css.fontSize = `${fontSize * scale}px`;
  if (style.verticalAlign === 'top') css.alignItems = 'flex-start';
  else if (style.verticalAlign === 'bottom') css.alignItems = 'flex-end';
  if (style.wrap) {
    css.whiteSpace = 'normal';
    css.overflowWrap = 'anywhere';
  }
  if (style.indent) css.paddingLeft = `${4 + style.indent * 8}px`;
  return css;
}

export function SheetTouchGrid({
  document: workbook,
  worksheet,
  selection,
  onSelectionChange,
  onActivateCell,
  onLongPressCell,
  computedValues,
  displayFormat,
  scale: scaleProp,
  onScaleChange,
}: SheetTouchGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [size, setSize] = useState(FALLBACK_VIEWPORT);
  const [internalScale, setInternalScale] = useState<number>(SHEET_MOBILE_SCALE.default);
  const scale = clampSheetScale(scaleProp ?? internalScale);
  const pinchRef = useRef<PinchState | null>(null);
  const tapRef = useRef<{ x: number; y: number; timer: number; consumed: boolean } | null>(null);
  const dragHandleRef = useRef<'anchor' | 'focus' | null>(null);

  const setScale = useCallback((next: number) => {
    const clamped = clampSheetScale(next);
    if (onScaleChange) onScaleChange(clamped);
    else setInternalScale(clamped);
  }, [onScaleChange]);

  const rows = useMemo<SheetAxisMetrics>(() => buildRowMetrics(worksheet), [worksheet]);
  const columns = useMemo<SheetAxisMetrics>(() => buildColumnMetrics(worksheet), [worksheet]);
  const frozenRows = Math.min(worksheet.frozen?.rows ?? 0, rows.count);
  const frozenColumns = Math.min(worksheet.frozen?.columns ?? 0, columns.count);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        setSize({ width: element.clientWidth, height: element.clientHeight });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewport = useMemo(() => computeViewport({
    rows,
    columns,
    scrollTop: scroll.top / scale,
    scrollLeft: scroll.left / scale,
    viewportHeight: Math.max(0, size.height - HEADER_HEIGHT) / scale,
    viewportWidth: Math.max(0, size.width - HEADER_WIDTH) / scale,
    frozenRows,
    frozenColumns,
    overscan: SHEET_DEFAULTS.overscan,
  }), [rows, columns, scroll, scale, size, frozenRows, frozenColumns]);

  const conditionalStyleAt = useMemo(
    () => createConditionalFormatEvaluator(workbook.styles, worksheet, computedValues),
    [workbook.styles, worksheet, computedValues],
  );

  // Content-space pixel geometry. Frozen tracks are pinned by adding the live
  // scroll offset, so they stay put while the rest of the grid scrolls under.
  const rowTop = useCallback((index: number) => (
    index < frozenRows
      ? scroll.top + HEADER_HEIGHT + trackOffset(rows, index) * scale
      : HEADER_HEIGHT + trackOffset(rows, index) * scale
  ), [frozenRows, rows, scale, scroll.top]);

  const columnLeft = useCallback((index: number) => (
    index < frozenColumns
      ? scroll.left + HEADER_WIDTH + trackOffset(columns, index) * scale
      : HEADER_WIDTH + trackOffset(columns, index) * scale
  ), [frozenColumns, columns, scale, scroll.left]);

  const positionAt = useCallback((clientX: number, clientY: number): SheetPosition | null => {
    const element = containerRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const paneX = clientX - rect.left - HEADER_WIDTH;
    const paneY = clientY - rect.top - HEADER_HEIGHT;
    if (paneX < 0 || paneY < 0) return null;
    const position = {
      row: trackAtPaneOffset(rows, paneY / scale, scroll.top / scale, frozenRows),
      column: trackAtPaneOffset(columns, paneX / scale, scroll.left / scale, frozenColumns),
    };
    // Touching anywhere inside a merge selects its origin, matching desktop.
    const mergedRange = mergedRangeAt(worksheet, position);
    const merged = mergedRange ? rangeRectangle(worksheet, mergedRange) : null;
    return merged ? { row: merged.top, column: merged.left } : position;
  }, [columns, frozenColumns, frozenRows, rows, scale, scroll.left, scroll.top, worksheet]);

  const clearTap = useCallback(() => {
    const pending = tapRef.current;
    if (pending) window.clearTimeout(pending.timer);
    tapRef.current = null;
  }, []);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 2) {
      clearTap();
      pinchRef.current = {
        distance: touchDistance(event.touches[0], event.touches[1]),
        scale,
      };
      return;
    }
    if (event.touches.length !== 1 || dragHandleRef.current) return;
    const touch = event.touches[0];
    const start = { x: touch.clientX, y: touch.clientY, timer: 0, consumed: false };
    start.timer = window.setTimeout(() => {
      start.consumed = true;
      const position = positionAt(start.x, start.y);
      if (!position) return;
      onSelectionChange(selectCell(position));
      onLongPressCell?.(position);
      navigator.vibrate?.(18);
    }, LONG_PRESS_MS);
    tapRef.current = start;
  }, [clearTap, onLongPressCell, onSelectionChange, positionAt, scale]);

  const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const pinch = pinchRef.current;
    if (pinch && event.touches.length === 2) {
      const distance = touchDistance(event.touches[0], event.touches[1]);
      if (pinch.distance > 0) setScale(pinch.scale * (distance / pinch.distance));
      return;
    }
    const pending = tapRef.current;
    if (!pending || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (
      Math.abs(touch.clientX - pending.x) > TAP_MOVE_TOLERANCE
      || Math.abs(touch.clientY - pending.y) > TAP_MOVE_TOLERANCE
    ) {
      clearTap();
    }
  }, [clearTap, setScale]);

  const handleTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 0) pinchRef.current = null;
    const pending = tapRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    tapRef.current = null;
    if (pending.consumed) return;
    const position = positionAt(pending.x, pending.y);
    if (!position) return;
    const active = selection.active;
    if (active.row === position.row && active.column === position.column) {
      onActivateCell(position);
      return;
    }
    onSelectionChange(selectCell(position));
  }, [onActivateCell, onSelectionChange, positionAt, selection.active]);

  // Range handles: dragging either end extends the selection cell by cell.
  const handleHandleTouchMove = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const which = dragHandleRef.current;
    if (!which || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const position = positionAt(touch.clientX, touch.clientY);
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    const range = selection.ranges[selection.ranges.length - 1] ?? {
      anchor: selection.active,
      focus: selection.active,
    };
    const next = which === 'anchor'
      ? { anchor: position, focus: range.focus }
      : { anchor: range.anchor, focus: position };
    onSelectionChange({
      kind: 'cells',
      active: which === 'anchor' ? position : next.focus,
      ranges: [next],
    });
  }, [onSelectionChange, positionAt, selection.active, selection.ranges]);

  const rectangle = useMemo(() => {
    const range = selection.ranges[selection.ranges.length - 1];
    return range
      ? normalizeRange(range)
      : normalizeRange({ anchor: selection.active, focus: selection.active });
  }, [selection.active, selection.ranges]);

  const contentWidth = HEADER_WIDTH + columns.totalSize * scale;
  const contentHeight = HEADER_HEIGHT + rows.totalSize * scale;

  const renderCell = (row: number, column: number) => {
    const height = trackSize(rows, row) * scale;
    const width = trackSize(columns, column) * scale;
    if (height <= 0 || width <= 0) return null;
    const position = { row, column };
    const mergedRange = mergedRangeAt(worksheet, position);
    const merged = mergedRange ? rangeRectangle(worksheet, mergedRange) : null;
    // Only the origin of a merge paints; the covered cells are skipped.
    if (merged && (merged.top !== row || merged.left !== column)) return null;
    const cell = getCell(worksheet, position);
    const rowId = worksheet.rowOrder[row];
    const columnId = worksheet.columnOrder[column];
    const computed = computedValues?.get(
      sheetFormulaResultKey(worksheet.id, rowId ?? '', columnId ?? ''),
    );
    const base = resolveCellStyle(workbook.styles, worksheet, position);
    // Conditional styles are derived at paint time and never overwrite the base.
    const style = { ...base, ...conditionalStyleAt(position) };
    const text = formatCellDisplay(cell, computed, style, displayFormat);
    const selected = row >= rectangle.top && row <= rectangle.bottom
      && column >= rectangle.left && column <= rectangle.right;
    const isActive = selection.active.row === row && selection.active.column === column;
    const spanWidth = merged
      ? (trackOffset(columns, merged.right + 1) - trackOffset(columns, merged.left)) * scale
      : width;
    const spanHeight = merged
      ? (trackOffset(rows, merged.bottom + 1) - trackOffset(rows, merged.top)) * scale
      : height;
    return (
      <div
        key={`${rowId ?? row}:${columnId ?? column}`}
        role="gridcell"
        aria-selected={selected}
        aria-label={`${formatA1(position)} ${text}`.trim()}
        data-cell={`${row},${column}`}
        className={[
          'workbook-cell',
          selected ? 'selected' : '',
          isActive ? 'active' : '',
          cell?.formula ? 'formula' : '',
          computed?.type === 'error' ? 'error' : '',
          cell?.validationId ? 'validated' : '',
        ].filter(Boolean).join(' ')}
        style={{
          top: rowTop(row),
          left: columnLeft(column),
          width: spanWidth,
          height: spanHeight,
          textAlign: style.horizontalAlign ?? cellAlignment(cell, computed),
          zIndex: (row < frozenRows ? 2 : 0) + (column < frozenColumns ? 2 : 0),
          ...styleToCss(style, scale),
        }}
      >
        <span className="workbook-cell-text">{text}</span>
        {cell?.note ? <span className="workbook-cell-note" aria-hidden /> : null}
      </div>
    );
  };

  const rowIndexes = [
    ...Array.from({ length: frozenRows }, (_, index) => index),
    ...Array.from({ length: viewport.rows.end - viewport.rows.start }, (_, index) => (
      viewport.rows.start + index
    )),
  ];
  const columnIndexes = [
    ...Array.from({ length: frozenColumns }, (_, index) => index),
    ...Array.from({ length: viewport.columns.end - viewport.columns.start }, (_, index) => (
      viewport.columns.start + index
    )),
  ];

  const handleStyle = (row: number, column: number): CSSProperties => ({
    top: rowTop(row) + trackSize(rows, row) * scale,
    left: columnLeft(column) + trackSize(columns, column) * scale,
  });

  return (
    <div
      ref={containerRef}
      className="workbook-grid"
      role="grid"
      aria-label={`${worksheet.name} grid`}
      aria-rowcount={rows.count}
      aria-colcount={columns.count}
      onScroll={(event) => {
        const target = event.currentTarget;
        setScroll({ top: target.scrollTop, left: target.scrollLeft });
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={clearTap}
    >
      <div className="workbook-content" style={{ width: contentWidth, height: contentHeight }}>
        {/* Header corner, pinned to both axes. */}
        <div
          className="workbook-corner"
          style={{ top: scroll.top, left: scroll.left, width: HEADER_WIDTH, height: HEADER_HEIGHT }}
        />

        {columnIndexes.map((column) => {
          const width = trackSize(columns, column) * scale;
          if (width <= 0) return null;
          return (
            <button
              type="button"
              key={`col-${worksheet.columnOrder[column] ?? column}`}
              className={`workbook-column-header ${isColumnSelected(selection, column) ? 'selected' : ''}`}
              style={{
                top: scroll.top,
                left: columnLeft(column),
                width,
                height: HEADER_HEIGHT,
              }}
              onClick={() => onSelectionChange(selectColumns(column, column, {
                rowCount: rows.count,
                columnCount: columns.count,
              }))}
            >
              {columnLabel(column)}
            </button>
          );
        })}

        {rowIndexes.map((row) => {
          const height = trackSize(rows, row) * scale;
          if (height <= 0) return null;
          return (
            <button
              type="button"
              key={`row-${worksheet.rowOrder[row] ?? row}`}
              className={`workbook-row-header ${isRowSelected(selection, row) ? 'selected' : ''}`}
              style={{
                top: rowTop(row),
                left: scroll.left,
                width: HEADER_WIDTH,
                height,
              }}
              onClick={() => onSelectionChange(selectRows(row, row, {
                rowCount: rows.count,
                columnCount: columns.count,
              }))}
            >
              {row + 1}
            </button>
          );
        })}

        {rowIndexes.flatMap((row) => columnIndexes.map((column) => renderCell(row, column)))}

        {/* Touch range handles at the two corners of the selected rectangle. */}
        {(['anchor', 'focus'] as const).map((which) => {
          const row = which === 'anchor' ? rectangle.top : rectangle.bottom;
          const column = which === 'anchor' ? rectangle.left : rectangle.right;
          return (
            <button
              type="button"
              key={which}
              className={`workbook-handle ${which}`}
              aria-label={which === 'anchor' ? 'Extend selection start' : 'Extend selection end'}
              style={which === 'anchor'
                ? { top: rowTop(row), left: columnLeft(column) }
                : handleStyle(row, column)}
              onTouchStart={(event) => {
                event.stopPropagation();
                clearTap();
                dragHandleRef.current = which;
              }}
              onTouchMove={handleHandleTouchMove}
              onTouchEnd={(event) => {
                event.stopPropagation();
                dragHandleRef.current = null;
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
