/**
 * The editor's tool model.
 *
 * Framework-free so the tool state, the brush presets, and the keyboard map are
 * shared with the mobile editor in Phase 4 rather than reimplemented there.
 */

import type { InkArrowhead, InkBrushParameters, InkBrushKind, InkShapeKind } from '../../types/ink';
import { INK_DEFAULT_BRUSHES } from './document';
import type { InkEraserMode } from './erase';

export type InkToolId =
  | 'pen'
  | 'eraser'
  | 'select'
  | 'lasso'
  | 'shape'
  | 'connector'
  | 'text'
  | 'sticky'
  | 'image'
  | 'stamp'
  | 'equation'
  | 'ruler'
  | 'protractor'
  | 'compass'
  | 'guide'
  | 'loupe'
  | 'eyedropper'
  | 'pan';

export interface InkToolState {
  tool: InkToolId;
  /** Which brush preset the pen is using. */
  brushId: string;
  /** Live brush parameters, snapshotted onto each stroke as it commits. */
  brush: InkBrushParameters;
  eraserMode: InkEraserMode;
  /** Eraser radius in ink units. */
  eraserRadius: number;
  /** Active layer new objects land on. Null means the topmost layer. */
  activeLayerId: string | null;
  shapeKind: InkShapeKind;
  shapeFill: string | null;
  shapeFillOpacity: number;
  arrowStart: InkArrowhead;
  arrowEnd: InkArrowhead;
  snapToGrid: boolean;
  snapSpacing: number;
  holdToStraighten: boolean;
  stampSymbolId: string;
}

/** Eraser sizes, in ink units. 640 units is 10 pt, about a pencil rubber. */
export const INK_ERASER_SIZES = [160, 320, 640, 1_280, 2_560];

export function defaultToolState(): InkToolState {
  return {
    tool: 'pen',
    brushId: 'ballpoint',
    brush: { ...INK_DEFAULT_BRUSHES.ballpoint },
    eraserMode: 'stroke',
    eraserRadius: 640,
    activeLayerId: null,
    shapeKind: 'rectangle',
    shapeFill: null,
    shapeFillOpacity: 0.2,
    arrowStart: 'none',
    arrowEnd: 'none',
    snapToGrid: true,
    snapSpacing: 768,
    holdToStraighten: true,
    stampSymbolId: 'check',
  };
}

/**
 * Brush widths offered in the properties panel, in ink units.
 * 64 units is 1 pt; the range runs from a fine technical pen to a broad marker.
 */
export const INK_BRUSH_WIDTHS = [32, 64, 96, 160, 256, 384, 640];

/** The swatches the pen offers before the user picks their own. */
export const INK_DEFAULT_SWATCHES = [
  '#1f2933',
  '#1a2b6d',
  '#c0392b',
  '#1a7f37',
  '#b7791f',
  '#7c3aed',
  '#0e7490',
  '#e5e7eb',
];

/**
 * Highlighters render behind normal ink.
 *
 * Not a rendering special case bolted on later — it is what a highlighter *is*.
 * The scene has no separate layer for it, so a committed highlighter stroke is
 * inserted below the ink already on its layer.
 */
export function drawsBehindInk(brush: InkBrushParameters): boolean {
  return brush.kind === 'highlighter';
}

/** Preset ids in the order the tool rail shows them. */
export const INK_BRUSH_ORDER: InkBrushKind[] = [
  'ballpoint',
  'fountain',
  'technical',
  'pencil',
  'marker',
  'highlighter',
];

/* -------------------------------------------------------------------------
 * Keyboard
 * ---------------------------------------------------------------------- */

export interface InkShortcut {
  /** `KeyboardEvent.key`, so the binding is layout-independent. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  command: InkCommand;
  label: string;
}

export type InkCommand =
  | 'tool.pen'
  | 'tool.eraser'
  | 'tool.select'
  | 'tool.lasso'
  | 'tool.shape'
  | 'tool.connector'
  | 'tool.text'
  | 'tool.image'
  | 'tool.stamp'
  | 'tool.equation'
  | 'tool.ruler'
  | 'tool.protractor'
  | 'tool.compass'
  | 'tool.guide'
  | 'tool.loupe'
  | 'tool.eyedropper'
  | 'tool.pan'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.delete'
  | 'edit.selectAll'
  | 'edit.copy'
  | 'edit.cut'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.group'
  | 'edit.ungroup'
  | 'order.front'
  | 'order.back'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.fitPage'
  | 'view.focusMode'
  | 'page.next'
  | 'page.previous'
  | 'document.save';

/**
 * The keyboard map.
 *
 * Every binding uses `KeyboardEvent.key` for letters and named keys, per the
 * repo's layout-independence rule — no punctuation or symbol shortcuts, so a
 * non-US layout does not lose them.
 */
export const INK_SHORTCUTS: InkShortcut[] = [
  { key: 'p', command: 'tool.pen', label: 'Pen' },
  { key: 'e', command: 'tool.eraser', label: 'Eraser' },
  { key: 'v', command: 'tool.select', label: 'Select' },
  { key: 'l', command: 'tool.lasso', label: 'Lasso' },
  { key: 'u', command: 'tool.shape', label: 'Shape' },
  { key: 'c', command: 'tool.connector', label: 'Connector' },
  { key: 't', command: 'tool.text', label: 'Text' },
  { key: 'i', command: 'tool.image', label: 'Image' },
  { key: 'k', command: 'tool.stamp', label: 'Stamp' },
  { key: 'q', command: 'tool.equation', label: 'Equation' },
  { key: 'r', command: 'tool.ruler', label: 'Ruler' },
  { key: 'o', command: 'tool.protractor', label: 'Protractor' },
  { key: 'm', command: 'tool.compass', label: 'Compass' },
  { key: 'g', command: 'tool.guide', label: 'Guide' },
  { key: 'j', command: 'tool.loupe', label: 'Loupe' },
  { key: 'x', command: 'tool.eyedropper', label: 'Eyedropper' },
  { key: 'h', command: 'tool.pan', label: 'Pan' },

  { key: 'z', ctrl: true, command: 'edit.undo', label: 'Undo' },
  { key: 'z', ctrl: true, shift: true, command: 'edit.redo', label: 'Redo' },
  { key: 'y', ctrl: true, command: 'edit.redo', label: 'Redo' },
  { key: 'Delete', command: 'edit.delete', label: 'Delete selection' },
  { key: 'Backspace', command: 'edit.delete', label: 'Delete selection' },
  { key: 'a', ctrl: true, command: 'edit.selectAll', label: 'Select all' },
  { key: 'c', ctrl: true, command: 'edit.copy', label: 'Copy' },
  { key: 'x', ctrl: true, command: 'edit.cut', label: 'Cut' },
  { key: 'v', ctrl: true, command: 'edit.paste', label: 'Paste' },
  { key: 'd', ctrl: true, command: 'edit.duplicate', label: 'Duplicate' },
  { key: 'g', ctrl: true, command: 'edit.group', label: 'Group' },
  { key: 'g', ctrl: true, shift: true, command: 'edit.ungroup', label: 'Ungroup' },

  { key: 'ArrowUp', ctrl: true, shift: true, command: 'order.front', label: 'Bring to front' },
  { key: 'ArrowDown', ctrl: true, shift: true, command: 'order.back', label: 'Send to back' },

  { key: 'PageDown', command: 'page.next', label: 'Next page' },
  { key: 'PageUp', command: 'page.previous', label: 'Previous page' },

  { key: 'f', command: 'view.fitPage', label: 'Fit page' },
  { key: 'f', ctrl: true, shift: true, command: 'view.focusMode', label: 'Focus mode' },
  { key: 's', ctrl: true, command: 'document.save', label: 'Save' },
];

export interface InkKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Resolves a key event to a command.
 *
 * Ctrl and Meta are treated as the same modifier so macOS Cmd bindings work
 * without a separate table. Bindings are matched most-specific first, so
 * `Ctrl+Shift+Z` cannot be shadowed by `Ctrl+Z`.
 */
export function resolveInkCommand(event: InkKeyEvent): InkCommand | null {
  const ctrl = event.ctrlKey || event.metaKey;
  const candidates = INK_SHORTCUTS.filter(
    (shortcut) =>
      shortcut.key.toLowerCase() === event.key.toLowerCase() &&
      Boolean(shortcut.ctrl) === ctrl &&
      Boolean(shortcut.shift) === event.shiftKey &&
      Boolean(shortcut.alt) === event.altKey,
  );
  if (candidates.length === 0) return null;
  return candidates.sort(
    (left, right) => modifierCount(right) - modifierCount(left),
  )[0].command;
}

function modifierCount(shortcut: InkShortcut): number {
  return Number(!!shortcut.ctrl) + Number(!!shortcut.shift) + Number(!!shortcut.alt);
}

/* -------------------------------------------------------------------------
 * Pen buttons
 * ---------------------------------------------------------------------- */

export type InkPenButtonAction = 'erase' | 'lasso' | 'select' | 'none';

export interface InkPenButtonMapping {
  /** Barrel button held while drawing. */
  barrel: InkPenButtonAction;
  /** The inverted end of the pen, where the hardware reports one. */
  eraserEnd: InkPenButtonAction;
}

export const INK_DEFAULT_PEN_BUTTONS: InkPenButtonMapping = {
  barrel: 'erase',
  eraserEnd: 'erase',
};

/** The tool a pen button temporarily switches to, or null to keep the current one. */
export function penButtonTool(action: InkPenButtonAction): InkToolId | null {
  switch (action) {
    case 'erase':
      return 'eraser';
    case 'lasso':
      return 'lasso';
    case 'select':
      return 'select';
    default:
      return null;
  }
}
