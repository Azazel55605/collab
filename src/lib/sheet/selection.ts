/**
 * Selection model for the spreadsheet grid.
 *
 * Selection is positional (row/column indices into `rowOrder`/`columnOrder`),
 * not identity-based: it describes what the user is pointing at right now, and
 * a structural edit rebuilds it rather than migrating it. Keeping it pure and
 * renderer-free means the canvas layer, the overlay, and the keyboard handler
 * all read the same source of truth.
 */
import type { SheetPosition } from './address';

export type SheetSelectionKind = 'cells' | 'rows' | 'columns' | 'all';

/** An anchor/focus pair. Anchor is where the drag started; focus is the live end. */
export interface SheetSelectionRange {
  anchor: SheetPosition;
  focus: SheetPosition;
}

export interface SheetSelection {
  /** Every selected block. The last entry owns the active cell. */
  ranges: SheetSelectionRange[];
  /** The cell that receives typing and that navigation moves from. */
  active: SheetPosition;
  kind: SheetSelectionKind;
}

/** A range normalized to inclusive top/left/bottom/right bounds. */
export interface SheetRectangle {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetGridBounds {
  rowCount: number;
  columnCount: number;
}

export function samePosition(a: SheetPosition, b: SheetPosition): boolean {
  return a.row === b.row && a.column === b.column;
}

export function clampPosition(position: SheetPosition, bounds: SheetGridBounds): SheetPosition {
  return {
    row: Math.max(0, Math.min(position.row, bounds.rowCount - 1)),
    column: Math.max(0, Math.min(position.column, bounds.columnCount - 1)),
  };
}

export function normalizeRange(range: SheetSelectionRange): SheetRectangle {
  return {
    top: Math.min(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.column, range.focus.column),
    bottom: Math.max(range.anchor.row, range.focus.row),
    right: Math.max(range.anchor.column, range.focus.column),
  };
}

export function rectangleContains(rectangle: SheetRectangle, position: SheetPosition): boolean {
  return (
    position.row >= rectangle.top &&
    position.row <= rectangle.bottom &&
    position.column >= rectangle.left &&
    position.column <= rectangle.right
  );
}

export function createSelection(position: SheetPosition): SheetSelection {
  return {
    ranges: [{ anchor: position, focus: position }],
    active: position,
    kind: 'cells',
  };
}

/** Replaces the selection with a single cell. */
export function selectCell(position: SheetPosition): SheetSelection {
  return createSelection(position);
}

/** Adds a disjoint single-cell range, keeping the existing ones (Ctrl-click). */
export function addSelectionRange(
  selection: SheetSelection,
  position: SheetPosition,
): SheetSelection {
  return {
    ranges: [...selection.ranges, { anchor: position, focus: position }],
    active: position,
    kind: 'cells',
  };
}

/** Extends the active range to `position` (Shift-click, Shift-drag, Shift-arrow). */
export function extendSelection(
  selection: SheetSelection,
  position: SheetPosition,
): SheetSelection {
  const ranges =
    selection.ranges.length > 0 ? [...selection.ranges] : [{ anchor: position, focus: position }];
  const last = ranges[ranges.length - 1];
  ranges[ranges.length - 1] = { anchor: last.anchor, focus: position };
  return {
    ranges,
    active: selection.active,
    kind: selection.kind === 'all' ? 'cells' : selection.kind,
  };
}

export function selectRows(from: number, to: number, bounds: SheetGridBounds): SheetSelection {
  const top = Math.min(from, to);
  const bottom = Math.max(from, to);
  return {
    ranges: [
      {
        anchor: { row: top, column: 0 },
        focus: { row: bottom, column: Math.max(0, bounds.columnCount - 1) },
      },
    ],
    active: { row: top, column: 0 },
    kind: 'rows',
  };
}

export function selectColumns(from: number, to: number, bounds: SheetGridBounds): SheetSelection {
  const left = Math.min(from, to);
  const right = Math.max(from, to);
  return {
    ranges: [
      {
        anchor: { row: 0, column: left },
        focus: { row: Math.max(0, bounds.rowCount - 1), column: right },
      },
    ],
    active: { row: 0, column: left },
    kind: 'columns',
  };
}

export function selectAll(bounds: SheetGridBounds): SheetSelection {
  return {
    ranges: [
      {
        anchor: { row: 0, column: 0 },
        focus: {
          row: Math.max(0, bounds.rowCount - 1),
          column: Math.max(0, bounds.columnCount - 1),
        },
      },
    ],
    active: { row: 0, column: 0 },
    kind: 'all',
  };
}

export function isCellSelected(selection: SheetSelection, position: SheetPosition): boolean {
  return selection.ranges.some((range) => rectangleContains(normalizeRange(range), position));
}

export function isRowSelected(selection: SheetSelection, row: number): boolean {
  return selection.ranges.some((range) => {
    const rectangle = normalizeRange(range);
    return row >= rectangle.top && row <= rectangle.bottom;
  });
}

export function isColumnSelected(selection: SheetSelection, column: number): boolean {
  return selection.ranges.some((range) => {
    const rectangle = normalizeRange(range);
    return column >= rectangle.left && column <= rectangle.right;
  });
}

/** Every position in the selection, de-duplicated across overlapping ranges. */
export function selectedPositions(selection: SheetSelection): SheetPosition[] {
  const seen = new Set<string>();
  const positions: SheetPosition[] = [];
  for (const range of selection.ranges) {
    const rectangle = normalizeRange(range);
    for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
      for (let column = rectangle.left; column <= rectangle.right; column += 1) {
        const key = `${row}:${column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        positions.push({ row, column });
      }
    }
  }
  return positions;
}

/** Total selected cell count without materializing the positions. */
export function selectedCellCount(selection: SheetSelection): number {
  return selectedPositions(selection).length;
}

export type SheetNavigationDirection = 'up' | 'down' | 'left' | 'right';

const DELTAS: Record<SheetNavigationDirection, SheetPosition> = {
  up: { row: -1, column: 0 },
  down: { row: 1, column: 0 },
  left: { row: 0, column: -1 },
  right: { row: 0, column: 1 },
};

export interface MoveOptions {
  /** Shift: extend the active range instead of collapsing to one cell. */
  extend?: boolean;
  /** Ctrl/Cmd: jump to the far edge of the current block of populated cells. */
  jump?: boolean;
  /** Distance for PageUp/PageDown-style movement. Defaults to 1. */
  distance?: number;
  /** Whether a cell holds content, used for jump navigation. */
  isPopulated?: (position: SheetPosition) => boolean;
}

/**
 * Ctrl+Arrow behavior, matching what spreadsheet users expect: from a populated
 * cell, run to the last populated cell in that direction; from a blank cell,
 * skip to the next populated one; if nothing is found, land on the grid edge.
 */
function jumpTarget(
  from: SheetPosition,
  direction: SheetNavigationDirection,
  bounds: SheetGridBounds,
  isPopulated: (position: SheetPosition) => boolean,
): SheetPosition {
  const delta = DELTAS[direction];
  const inBounds = (position: SheetPosition) =>
    position.row >= 0 &&
    position.row < bounds.rowCount &&
    position.column >= 0 &&
    position.column < bounds.columnCount;

  const step = (position: SheetPosition) => ({
    row: position.row + delta.row,
    column: position.column + delta.column,
  });

  let current = step(from);
  if (!inBounds(current)) return from;

  if (isPopulated(from) && isPopulated(current)) {
    // Inside a block: stop at its last populated cell.
    let last = current;
    while (inBounds(current) && isPopulated(current)) {
      last = current;
      current = step(current);
    }
    return last;
  }

  // Outside a block: find the next populated cell, else the grid edge.
  let lastInBounds = from;
  while (inBounds(current)) {
    if (isPopulated(current)) return current;
    lastInBounds = current;
    current = step(current);
  }
  return lastInBounds;
}

/** Moves (or extends) the selection in a direction, clamped to the grid. */
export function moveSelection(
  selection: SheetSelection,
  direction: SheetNavigationDirection,
  bounds: SheetGridBounds,
  options: MoveOptions = {},
): SheetSelection {
  const origin = options.extend
    ? (selection.ranges[selection.ranges.length - 1]?.focus ?? selection.active)
    : selection.active;

  let target: SheetPosition;
  if (options.jump && options.isPopulated) {
    target = jumpTarget(origin, direction, bounds, options.isPopulated);
  } else {
    const delta = DELTAS[direction];
    const distance = options.distance ?? 1;
    target = clampPosition(
      {
        row: origin.row + delta.row * distance,
        column: origin.column + delta.column * distance,
      },
      bounds,
    );
  }

  if (options.extend) return extendSelection(selection, target);
  return createSelection(target);
}

/** Home/End/Ctrl+Home/Ctrl+End targets. */
export function moveToEdge(
  selection: SheetSelection,
  edge: 'row-start' | 'row-end' | 'grid-start' | 'grid-end',
  bounds: SheetGridBounds,
  extend = false,
): SheetSelection {
  const origin = extend
    ? (selection.ranges[selection.ranges.length - 1]?.focus ?? selection.active)
    : selection.active;
  const target = clampPosition(
    edge === 'row-start'
      ? { row: origin.row, column: 0 }
      : edge === 'row-end'
        ? { row: origin.row, column: bounds.columnCount - 1 }
        : edge === 'grid-start'
          ? { row: 0, column: 0 }
          : { row: bounds.rowCount - 1, column: bounds.columnCount - 1 },
    bounds,
  );
  return extend ? extendSelection(selection, target) : createSelection(target);
}

/**
 * Advances after a commit (Enter/Tab). Wraps within the selection when more
 * than one cell is selected — otherwise it just steps in the given direction.
 */
export function advanceAfterCommit(
  selection: SheetSelection,
  direction: SheetNavigationDirection,
  bounds: SheetGridBounds,
): SheetSelection {
  const rectangle = selection.ranges.length === 1 ? normalizeRange(selection.ranges[0]) : null;
  const multiCell =
    rectangle && (rectangle.top !== rectangle.bottom || rectangle.left !== rectangle.right);

  if (!multiCell) return moveSelection(selection, direction, bounds);

  const { active } = selection;
  let next: SheetPosition;
  if (direction === 'down' || direction === 'up') {
    const step = direction === 'down' ? 1 : -1;
    next = { row: active.row + step, column: active.column };
    if (next.row > rectangle.bottom) next = { row: rectangle.top, column: active.column + 1 };
    if (next.row < rectangle.top) next = { row: rectangle.bottom, column: active.column - 1 };
    if (next.column > rectangle.right) next = { row: rectangle.top, column: rectangle.left };
    if (next.column < rectangle.left) next = { row: rectangle.bottom, column: rectangle.right };
  } else {
    const step = direction === 'right' ? 1 : -1;
    next = { row: active.row, column: active.column + step };
    if (next.column > rectangle.right) next = { row: active.row + 1, column: rectangle.left };
    if (next.column < rectangle.left) next = { row: active.row - 1, column: rectangle.right };
    if (next.row > rectangle.bottom) next = { row: rectangle.top, column: rectangle.left };
    if (next.row < rectangle.top) next = { row: rectangle.bottom, column: rectangle.right };
  }

  return { ...selection, active: next };
}
