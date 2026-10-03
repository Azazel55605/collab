/**
 * Font choices and availability for the deck editor.
 *
 * A deck names fonts; it never embeds them. Whether a family is installed is a
 * property of the machine showing the deck, so the editor detects it and shows
 * which fallback will actually draw — the "font fallback" half of the
 * Phase 3 text work. Export reports list referenced fonts separately.
 */
import type { DeckDocument, DeckTheme, DeckThemeFont } from '../../types/deck';

/** Families offered in the font picker, besides the theme's own. */
export const COMMON_FONT_FAMILIES = [
  'Inter',
  'Arial',
  'Helvetica',
  'Calibri',
  'Segoe UI',
  'Roboto',
  'Open Sans',
  'Noto Sans',
  'Liberation Sans',
  'Verdana',
  'Georgia',
  'Times New Roman',
  'Palatino Linotype',
  'Garamond',
  'Noto Serif',
  'Liberation Serif',
  'Courier New',
  'Consolas',
  'JetBrains Mono',
  'Noto Sans CJK JP',
];

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/;

type Context = { font: string; measureText(text: string): { width: number } };

let context: Context | null | undefined;
const cache = new Map<string, boolean>();

function measuringContext(): Context | null {
  if (context !== undefined) return context;
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : typeof document !== 'undefined'
          ? document.createElement('canvas')
          : null;
    context = (canvas?.getContext('2d') as Context | null | undefined) ?? null;
  } catch {
    context = null;
  }
  return context;
}

/**
 * Whether a family is installed, by comparing its text width against two
 * generic fallbacks: a missing family measures exactly as the fallback does.
 * Returns true when it cannot tell (no canvas), so nothing is flagged falsely.
 */
export function isFontAvailable(family: string): boolean {
  if (GENERIC.test(family)) return true;
  const cached = cache.get(family);
  if (cached !== undefined) return cached;
  // A web font the app declares counts even before it has loaded.
  if (typeof document !== 'undefined' && document.fonts) {
    for (const face of document.fonts) {
      if (face.family.replace(/^["']|["']$/g, '').toLowerCase() === family.toLowerCase()) {
        cache.set(family, true);
        return true;
      }
    }
  }
  const ctx = measuringContext();
  if (!ctx) return true;
  const sample = 'mmmmmmmmmmlli1WQ@#';
  const quoted = `"${family.replace(/["\\]/g, '')}"`;
  let available = false;
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px ${quoted}, ${generic}`;
    if (ctx.measureText(sample).width !== base) {
      available = true;
      break;
    }
  }
  cache.set(family, available);
  return available;
}

/** The family that will actually draw: the first installed one in the stack. */
export function effectiveFamily(font: DeckThemeFont | { family: string; fallbacks: string[] }) {
  const stack = [font.family, ...(font.fallbacks ?? [])];
  return stack.find((family) => isFontAvailable(family)) ?? stack[stack.length - 1];
}

/** Every family a picker should offer: the theme's first, then the common list. */
export function fontChoices(theme: DeckTheme, current?: string): string[] {
  const families = [theme.fonts.heading.family, theme.fonts.body.family, ...COMMON_FONT_FAMILIES];
  if (current) families.unshift(current);
  return [...new Set(families)];
}

/** Test hook: forget measured availability. */
export function resetFontCache(): void {
  cache.clear();
  context = undefined;
}

/**
 * Font families the deck asks for that this machine lacks, each with the
 * family Collab draws instead. For the export report.
 */
export function missingDeckFonts(
  deck: DeckDocument,
  available: (family: string) => boolean = isFontAvailable,
): Record<string, string> {
  const missing: Record<string, string> = {};
  const theme = deck.themes[deck.themeId];
  const body = theme?.fonts.body;
  const check = (font: { family: string; fallbacks?: string[] }) => {
    if (missing[font.family] !== undefined || available(font.family)) return;
    const stack = [
      font.family,
      ...(font.fallbacks ?? []),
      ...(body?.fallbacks ?? []),
      'sans-serif',
    ];
    missing[font.family] = stack.find((family) => available(family)) ?? stack[stack.length - 1];
  };
  for (const entry of Object.values(deck.themes)) {
    check(entry.fonts.heading);
    check(entry.fonts.body);
  }
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'font' && typeof child === 'string') check({ family: child });
      else walk(child);
    }
  };
  walk([deck.masters, deck.layouts, deck.slides]);
  return missing;
}
