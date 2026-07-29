import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { SHEET_DEFAULTS } from '../../types/sheet';
import type { SheetWorksheet } from '../../types/sheet';
import { columnLabel } from '../../lib/sheet/address';
import type { SheetPosition } from '../../lib/sheet/address';
import { cellAlignment, formatCellDisplay } from '../../lib/sheet/cellValue';
import { getCell, mergedRangeAt } from '../../lib/sheet/operations';
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
  trackPaneOffset,
  trackSize,
  type SheetAxisMetrics,
} from '../../lib/sheet/viewport';
import { cn } from '../../lib/utils';

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
  scrollPosition?: { top: number; left: number };
  onScrollPositionChange?: (position: { top: number; left: number }) => void;
  readOnly?: boolean;
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
  rows: SheetAxisMetrics;
  columns: SheetAxisMetrics;
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
  frozenRows: number;
  frozenColumns: number;
  theme: {
    text: string;
    mutedText: string;
    gridLine: string;
    frozenLine: string;
    background: string;
    font: string;
  };
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

  let painted = 0;
  for (const row of rowIndices) {
    const y = trackPaneOffset(rows, row, options.scrollTop, options.frozenRows);
    if (y === null) continue;
    const rowHeight = trackSize(rows, row);
    if (rowHeight === 0 || y > options.height) continue;

    for (const column of columnIndices) {
      const x = trackPaneOffset(columns, column, options.scrollLeft, options.frozenColumns);
      if (x === null) continue;
      const columnWidth = trackSize(columns, column);
      if (columnWidth === 0 || x > options.width) continue;

      // Grid lines are drawn per cell so hidden tracks collapse cleanly.
      context.strokeStyle = theme.gridLine;
      context.lineWidth = 1;
      context.strokeRect(Math.floor(x) + 0.5, Math.floor(y) + 0.5, columnWidth, rowHeight);

      const cell = getCell(worksheet, { row, column });
      painted += 1;
      const text = formatCellDisplay(cell);
      if (!text) continue;

      const align = cellAlignment(cell);
      context.fillStyle = cell?.formula ? theme.mutedText : theme.text;
      context.save();
      context.beginPath();
      context.rect(x + 1, y + 1, columnWidth - 2, rowHeight - 2);
      context.clip();
      const centerY = y + rowHeight / 2;
      if (align === 'right') {
        context.textAlign = 'right';
        context.fillText(text, x + columnWidth - 6, centerY);
      } else if (align === 'center') {
        context.textAlign = 'center';
        context.fillText(text, x + columnWidth / 2, centerY);
      } else {
        context.textAlign = 'left';
        context.fillText(text, x + 6, centerY);
      }
      context.restore();
    }
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
  scrollPosition,
  onScrollPositionChange,
  readOnly = false,
  className,
}: SheetGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<'select' | null>(null);
  const resizeRef = useRef<
    { axis: 'row' | 'column'; index: number; origin: number; size: number } | null
  >(null);

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

    const styles = getComputedStyle(canvas);
    paintCells(context, {
      worksheet,
      rows,
      columns,
      scrollTop: scroll.top,
      scrollLeft: scroll.left,
      width: paneWidth,
      height: paneHeight,
      frozenRows,
      frozenColumns,
      theme: {
        text: styles.getPropertyValue('color') || '#e5e7eb',
        mutedText: styles.getPropertyValue('color') || '#9ca3af',
        gridLine: 'rgba(127,127,127,0.22)',
        frozenLine: 'rgba(127,127,127,0.65)',
        background: 'transparent',
        font: `13px ${styles.getPropertyValue('font-family') || 'sans-serif'}`,
      },
    });
  }, [worksheet, rows, columns, scroll, paneWidth, paneHeight, frozenRows, frozenColumns]);

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
    return {
      row: trackAtPaneOffset(rows, y, scroll.top, frozenRows),
      column: trackAtPaneOffset(columns, x, scroll.left, frozenColumns),
    };
  }, [columns, frozenColumns, frozenRows, headerHeight, headerWidth, rows, scroll.left, scroll.top]);

  const commitEditing = useCallback((advance: 'down' | 'right' | null) => {
    if (!editing) return;
    onCommit(editing.position, editing.text);
    onEditingChange(null);
    if (advance) onSelectionChange(moveSelection(selection, advance, bounds));
  }, [bounds, editing, onCommit, onEditingChange, onSelectionChange, selection]);

  const beginEditing = useCallback((position: SheetPosition, text: string) => {
    if (readOnly) return;
    onEditingChange({ position, text });
  }, [onEditingChange, readOnly]);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  // ── Pointer interaction ────────────────────────────────────────────────────
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const position = positionFromEvent(event.clientX, event.clientY);
    if (!position) return;

    if (editing) commitEditing(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = 'select';

    if (event.shiftKey) onSelectionChange(extendSelection(selection, position));
    else if (event.ctrlKey || event.metaKey) onSelectionChange(addSelectionRange(selection, position));
    else onSelectionChange(createSelection(position));
  }, [commitEditing, editing, onSelectionChange, positionFromEvent, selection]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current !== 'select') return;
    const position = positionFromEvent(event.clientX, event.clientY);
    if (!position) return;
    onSelectionChange(extendSelection(selection, position));
  }, [onSelectionChange, positionFromEvent, selection]);

  const endDrag = useCallback(() => {
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
    beginEditing, bounds, editing, isPopulated, onClearSelection, onSelectionChange,
    pageDistance, readOnly, selection, worksheet,
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
      ? rectangleStyle(editing.position.row, editing.position.column, editing.position.row, editing.position.column)
      : null
  ), [editing, rectangleStyle]);

  return (
    <div
      ref={scrollRef}
      className={cn('relative flex-1 overflow-auto outline-none', className)}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
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
            onPointerCancel={endDrag}
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

          {activeStyle && !editing && (
            <div
              aria-hidden
              className="pointer-events-none absolute border-2 border-primary"
              style={activeStyle}
            />
          )}

          {editing && editorStyle && (
            <input
              ref={editorRef}
              value={editing.text}
              aria-label="Cell editor"
              onChange={(event) => onEditingChange({ ...editing, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitEditing('down');
                } else if (event.key === 'Tab') {
                  event.preventDefault();
                  commitEditing('right');
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onEditingChange(null);
                }
                event.stopPropagation();
              }}
              onBlur={() => commitEditing(null)}
              className="absolute z-10 border-2 border-primary bg-background px-1 text-[13px] outline-none"
              style={editorStyle}
            />
          )}
        </div>
      </div>
    </div>
  );
}
