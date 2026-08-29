/**
 * Phase 9 contrast, zoom, and reduced-motion validation for the grid.
 *
 * The grid paints on a canvas, so it cannot inherit theme guarantees the way
 * DOM text does. These tests pin the two things that could break them: the
 * tints the grid paints behind theme-colored text, and the app-wide motion
 * suppression that the sheet's own spinners rely on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHEET_DEFAULTS } from '../../types/sheet';

import { SHEET_GRID_LINES, SHEET_INDICATOR_COLORS, SHEET_SURFACE_TINTS } from './SheetGrid';

/** Reads a project file relative to the repository root. */
function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

function alphaOf(color: string): number {
  const match = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/.exec(color);
  expect(match, `${color} must be an rgba() tint`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

describe('contrast', () => {
  it('keeps every painted tint faint enough not to fight theme text', () => {
    // The theme owns the text color; a tint is only a hint of state. Above
    // roughly 20% alpha a tint starts to move the effective background far
    // enough to cost measurable contrast in one of the four themes.
    for (const [name, color] of Object.entries(SHEET_SURFACE_TINTS)) {
      expect(alphaOf(color), `${name} tint is too strong`).toBeLessThanOrEqual(0.2);
    }
  });

  it('uses neutral grid lines that read on both light and dark themes', () => {
    // A mid grey at partial alpha is visible against a light and a dark
    // background alike, so grid lines never disappear on one theme.
    for (const color of Object.values(SHEET_GRID_LINES)) {
      expect(color).toMatch(/rgba\(\s*127\s*,\s*127\s*,\s*127/);
    }
    expect(alphaOf(SHEET_GRID_LINES.frozen)).toBeGreaterThan(alphaOf(SHEET_GRID_LINES.cell));
  });

  it('routes every fixed color through the documented indicator tokens', () => {
    const source = readSource('src/components/sheet/SheetGrid.tsx');
    // Anything painted with a literal hex has escaped the theme. The only
    // allowed literals are the declarations of the indicator tokens
    // themselves, which are theme-independent by design.
    const hexLiterals = new Set(source.match(/#[0-9a-fA-F]{6}\b/g) ?? []);
    expect(hexLiterals).toEqual(new Set(Object.values(SHEET_INDICATOR_COLORS)));
  });
});

describe('zoom', () => {
  it('expresses default track sizes in CSS pixels so app zoom scales them', () => {
    // The grid must not carry a private scale factor: zoom is applied by the
    // app (and by device pixel ratio at paint time) to CSS-pixel geometry.
    expect(SHEET_DEFAULTS.rowHeight).toBeGreaterThan(0);
    expect(SHEET_DEFAULTS.columnWidth).toBeGreaterThan(0);
    expect(SHEET_DEFAULTS.headerHeight).toBeGreaterThan(0);
    expect(SHEET_DEFAULTS.headerWidth).toBeGreaterThan(0);
    for (const value of Object.values(SHEET_DEFAULTS)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('scales the canvas backing store by device pixel ratio', () => {
    const source = readSource('src/components/sheet/SheetGrid.tsx');
    // Without this the grid renders blurry at any zoom level or on a HiDPI
    // display, which is a legibility problem, not only a cosmetic one.
    expect(source).toContain('window.devicePixelRatio');
    expect(source).toContain('context.setTransform(ratio, 0, 0, ratio, 0, 0)');
  });
});

describe('reduced motion', () => {
  it('is covered by the app-wide motion suppression the sheet relies on', () => {
    const css = readSource('src/App.css');
    // `App.tsx` sets `data-motion="off"` for both the app setting and the OS
    // `prefers-reduced-motion` preference. The sheet's only animation is the
    // shared `animate-spin` save/loading indicator, which this rule stops.
    expect(css).toMatch(/\[data-motion='off'\] \*,/);
    expect(css).toMatch(/animation-duration: 1ms !important;/);
    expect(css).toMatch(/animation-iteration-count: 1 !important;/);
    expect(css).toMatch(/scroll-behavior: auto !important;/);
  });

  it('does not animate the grid itself', () => {
    const source = readSource('src/components/sheet/SheetGrid.tsx');
    // Scrolling and selection are the grid's whole interaction model; animating
    // them would both fight reduced motion and blow the scroll frame budget.
    expect(source).not.toMatch(/animate-|transition-|scrollBehavior/);
  });
});
