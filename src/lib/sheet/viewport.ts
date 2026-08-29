/**
 * Virtualized viewport model for the spreadsheet grid.
 *
 * This is deliberately renderer-free: it answers "which rows and columns are on
 * screen, and where do they sit" for a canvas layer, a DOM overlay, or a test.
 * Phase 0 uses it to prove that a 1,000,000 x 16,384 logical grid can be
 * scrolled and hit-tested without materializing a cell per position.
 *
 * Sizes are cumulative-summed once per structural change so scrolling is a
 * binary search rather than a scan.
 */
import { SHEET_DEFAULTS } from '../../types/sheet';
import type { SheetWorksheet } from '../../types/sheet';

export interface SheetAxisMetrics {
  /** Number of tracks (rows or columns) on this axis. */
  count: number;
  /** `offsets[i]` is the pixel offset of track `i`; length is `count + 1`. */
  offsets: Float64Array;
  totalSize: number;
}

/** Builds cumulative offsets, skipping hidden tracks by giving them zero size. */
export function buildAxisMetrics(
  ids: readonly string[],
  sizeOf: (id: string) => number | undefined,
  defaultSize: number,
): SheetAxisMetrics {
  const offsets = new Float64Array(ids.length + 1);
  let running = 0;
  for (let index = 0; index < ids.length; index += 1) {
    offsets[index] = running;
    running += sizeOf(ids[index]) ?? defaultSize;
  }
  offsets[ids.length] = running;
  return { count: ids.length, offsets, totalSize: running };
}

export function buildRowMetrics(worksheet: SheetWorksheet): SheetAxisMetrics {
  const rows = worksheet.rows;
  const defaultSize = worksheet.defaultRowHeight ?? SHEET_DEFAULTS.rowHeight;
  return buildAxisMetrics(
    worksheet.rowOrder,
    (id) => {
      const row = rows?.[id];
      if (!row) return undefined;
      return row.hidden || row.filterHidden ? 0 : row.height;
    },
    defaultSize,
  );
}

export function buildColumnMetrics(worksheet: SheetWorksheet): SheetAxisMetrics {
  const columns = worksheet.columns;
  const defaultSize = worksheet.defaultColumnWidth ?? SHEET_DEFAULTS.columnWidth;
  return buildAxisMetrics(
    worksheet.columnOrder,
    (id) => {
      const column = columns?.[id];
      if (!column) return undefined;
      return column.hidden ? 0 : column.width;
    },
    defaultSize,
  );
}

export function trackOffset(metrics: SheetAxisMetrics, index: number): number {
  if (index <= 0) return 0;
  if (index >= metrics.count) return metrics.totalSize;
  return metrics.offsets[index];
}

export function trackSize(metrics: SheetAxisMetrics, index: number): number {
  if (index < 0 || index >= metrics.count) return 0;
  return metrics.offsets[index + 1] - metrics.offsets[index];
}

/**
 * Index of the track containing `offset`. Hidden (zero-size) tracks are never
 * returned; the first visible track at or after the offset wins.
 */
export function trackAtOffset(metrics: SheetAxisMetrics, offset: number): number {
  if (metrics.count === 0) return 0;
  if (offset <= 0) return 0;
  if (offset >= metrics.totalSize) return metrics.count - 1;

  let low = 0;
  let high = metrics.count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (metrics.offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  // Skip zero-height/width tracks so a hidden row is never "the" hit.
  while (low < metrics.count - 1 && trackSize(metrics, low) === 0) low += 1;
  return low;
}

export interface SheetAxisWindow {
  /** First track to render, including overscan. */
  start: number;
  /** Exclusive end track, including overscan. */
  end: number;
  /** Frozen tracks pinned at the axis origin (`[0, frozen)`). */
  frozen: number;
  /** Pixel offset of `start`, for positioning the rendered slice. */
  startOffset: number;
  /** Total pixel size of the axis, for scrollbar extent. */
  totalSize: number;
}

export interface SheetViewportRequest {
  rows: SheetAxisMetrics;
  columns: SheetAxisMetrics;
  scrollTop: number;
  scrollLeft: number;
  viewportHeight: number;
  viewportWidth: number;
  frozenRows?: number;
  frozenColumns?: number;
  overscan?: number;
}

export interface SheetViewport {
  rows: SheetAxisWindow;
  columns: SheetAxisWindow;
  /** Cells the renderer must draw, excluding frozen panes. */
  cellCount: number;
}

function axisWindow(
  metrics: SheetAxisMetrics,
  scroll: number,
  extent: number,
  frozen: number,
  overscan: number,
): SheetAxisWindow {
  const clampedFrozen = Math.max(0, Math.min(frozen, metrics.count));
  const frozenSize = trackOffset(metrics, clampedFrozen);
  const scrollableExtent = Math.max(0, extent - frozenSize);
  const first = trackAtOffset(metrics, Math.max(scroll, 0) + frozenSize);
  const last = trackAtOffset(metrics, Math.max(scroll, 0) + frozenSize + scrollableExtent);

  const start = Math.max(clampedFrozen, first - overscan);
  const end = Math.min(metrics.count, last + 1 + overscan);
  return {
    start,
    end: Math.max(start, end),
    frozen: clampedFrozen,
    startOffset: trackOffset(metrics, start),
    totalSize: metrics.totalSize,
  };
}

/**
 * Computes the render window for one frame. Pure and allocation-light: safe to
 * call on every scroll event.
 */
export function computeViewport(request: SheetViewportRequest): SheetViewport {
  const overscan = request.overscan ?? SHEET_DEFAULTS.overscan;
  const rows = axisWindow(
    request.rows,
    request.scrollTop,
    request.viewportHeight,
    request.frozenRows ?? 0,
    overscan,
  );
  const columns = axisWindow(
    request.columns,
    request.scrollLeft,
    request.viewportWidth,
    request.frozenColumns ?? 0,
    overscan,
  );
  return {
    rows,
    columns,
    cellCount: (rows.end - rows.start) * (columns.end - columns.start),
  };
}

/**
 * Converts a pixel offset inside a pane (measured from the pane origin, after
 * the header) into a track index, accounting for frozen tracks pinned at the
 * origin. Frozen tracks occupy the first `frozenSize` pixels and do not scroll.
 */
export function trackAtPaneOffset(
  metrics: SheetAxisMetrics,
  paneOffset: number,
  scroll: number,
  frozen: number,
): number {
  const frozenCount = Math.max(0, Math.min(frozen, metrics.count));
  const frozenSize = trackOffset(metrics, frozenCount);
  if (paneOffset < frozenSize) return trackAtOffset(metrics, paneOffset);
  const index = trackAtOffset(metrics, paneOffset + Math.max(0, scroll));
  return Math.max(frozenCount, index);
}

/**
 * Pixel offset of a track inside a pane, or `null` when it is hidden behind the
 * frozen region and therefore must not be drawn.
 */
export function trackPaneOffset(
  metrics: SheetAxisMetrics,
  index: number,
  scroll: number,
  frozen: number,
): number | null {
  const frozenCount = Math.max(0, Math.min(frozen, metrics.count));
  if (index < frozenCount) return trackOffset(metrics, index);
  const frozenSize = trackOffset(metrics, frozenCount);
  const offset = trackOffset(metrics, index) - Math.max(0, scroll);
  return offset < frozenSize ? null : offset;
}
