/**
 * Theme-aware colours used by ink documents.
 *
 * Literal CSS colours remain literal. The `ink:*` values are document-level
 * semantic roles: they adapt to the surface they are viewed on and are resolved
 * to concrete colours before canvas painting or portable export.
 */

export type InkColorTheme = 'dark' | 'midnight' | 'warm' | 'light';

export interface InkColorPalette {
  foreground: string;
  blue: string;
  red: string;
  green: string;
  amber: string;
  violet: string;
  cyan: string;
  gray: string;
  grid: string;
}

export const INK_COLOR_TOKENS = {
  foreground: 'ink:foreground',
  blue: 'ink:blue',
  red: 'ink:red',
  green: 'ink:green',
  amber: 'ink:amber',
  violet: 'ink:violet',
  cyan: 'ink:cyan',
  gray: 'ink:gray',
} as const;

export const INK_THEME_SWATCHES = Object.values(INK_COLOR_TOKENS);

export const INK_LIGHT_PALETTE: Readonly<InkColorPalette> = {
  foreground: '#1f2933',
  blue: '#1a2b6d',
  red: '#c0392b',
  green: '#1a7f37',
  amber: '#9a6700',
  violet: '#7c3aed',
  cyan: '#0e7490',
  gray: '#6b7280',
  grid: '#c9d1dc',
};

export const INK_DARK_PALETTE: Readonly<InkColorPalette> = {
  foreground: '#f3f4f6',
  blue: '#a5b4fc',
  red: '#fca5a5',
  green: '#86efac',
  amber: '#fde68a',
  violet: '#c4b5fd',
  cyan: '#67e8f9',
  gray: '#d1d5db',
  grid: '#4b5563',
};

const LEGACY_THEME_COLORS: Readonly<Record<string, keyof InkColorPalette>> = {
  '#1f2933': 'foreground',
  '#111418': 'foreground',
  '#3f4650': 'foreground',
  '#1a2b6d': 'blue',
  '#c0392b': 'red',
  '#1a7f37': 'green',
  '#b7791f': 'amber',
  '#7c3aed': 'violet',
  '#0e7490': 'cyan',
  '#e5e7eb': 'gray',
};

const TOKEN_KEYS = new Map<string, keyof InkColorPalette>([
  [INK_COLOR_TOKENS.foreground, 'foreground'],
  [INK_COLOR_TOKENS.blue, 'blue'],
  [INK_COLOR_TOKENS.red, 'red'],
  [INK_COLOR_TOKENS.green, 'green'],
  [INK_COLOR_TOKENS.amber, 'amber'],
  [INK_COLOR_TOKENS.violet, 'violet'],
  [INK_COLOR_TOKENS.cyan, 'cyan'],
  [INK_COLOR_TOKENS.gray, 'gray'],
]);

const TOKENS_BY_KEY: Readonly<Record<Exclude<keyof InkColorPalette, 'grid'>, string>> = {
  foreground: INK_COLOR_TOKENS.foreground,
  blue: INK_COLOR_TOKENS.blue,
  red: INK_COLOR_TOKENS.red,
  green: INK_COLOR_TOKENS.green,
  amber: INK_COLOR_TOKENS.amber,
  violet: INK_COLOR_TOKENS.violet,
  cyan: INK_COLOR_TOKENS.cyan,
  gray: INK_COLOR_TOKENS.gray,
};

/** Collapses old built-in swatches onto their semantic role for editor state. */
export function canonicalInkColor(color: string): string {
  const normalized = color.trim().toLowerCase();
  if (TOKEN_KEYS.has(normalized)) return normalized;
  const legacyKey = LEGACY_THEME_COLORS[normalized];
  return legacyKey && legacyKey !== 'grid' ? TOKENS_BY_KEY[legacyKey] : color;
}

/** Resolves both current semantic roles and the original built-in swatches. */
export function resolveInkColor(color: string, palette: InkColorPalette): string {
  const normalized = color.trim().toLowerCase();
  const key = TOKEN_KEYS.get(normalized) ?? LEGACY_THEME_COLORS[normalized];
  return key ? palette[key] : color;
}

export function inkColorLabel(color: string): string {
  const normalized = color.trim().toLowerCase();
  const key = TOKEN_KEYS.get(normalized);
  if (!key) return color;
  return key === 'foreground' ? 'Automatic ink' : `Theme ${key}`;
}

function isDarkSurface(color: string | undefined): boolean | null {
  if (!color) return null;
  const normalized = color.trim();
  const oklch = normalized.match(/^oklch\(\s*([\d.]+)(%)?/i);
  if (oklch) {
    const lightness = Number(oklch[1]) / (oklch[2] ? 100 : 1);
    return Number.isFinite(lightness) ? lightness < 0.55 : null;
  }
  const hex = normalized.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  let channels: [number, number, number] | null = null;
  if (hex) {
    const rgbHex = hex.length === 3 || hex.length === 4
      ? [...hex.slice(0, 3)].map((part) => part + part).join('')
      : hex.slice(0, 6);
    channels = [0, 2, 4].map((offset) => Number.parseInt(rgbHex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  } else {
    const rgb = normalized.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) channels = [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  }
  if (!channels) return null;
  const [red, green, blue] = channels;
  const linear = (channel: number) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return luminance < 0.35;
}

/** Explicit page colours win over the app theme so white paper keeps dark ink. */
export function inkPaletteForTheme(
  theme: InkColorTheme,
  surfaceColor?: string,
): InkColorPalette {
  const surfaceIsDark = isDarkSurface(surfaceColor);
  if (surfaceIsDark !== null) return surfaceIsDark ? { ...INK_DARK_PALETTE } : { ...INK_LIGHT_PALETTE };
  return theme === 'light' ? { ...INK_LIGHT_PALETTE } : { ...INK_DARK_PALETTE };
}

/** Portable exports default to paper-safe colours unless a dark surface is explicit. */
export function inkExportPalette(background?: string): InkColorPalette {
  return inkPaletteForTheme('light', background);
}
