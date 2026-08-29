/**
 * Mobile theming. Reuses the desktop visual language (theme palettes, accent
 * colors, base font size) but applies it through a small self-contained helper
 * instead of the desktop `uiStore`, which is coupled to desktop-only features.
 * Preferences persist in the companion app's localStorage.
 */

export type Theme = 'dark' | 'midnight' | 'warm' | 'light';
export type AccentColor = 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan';
export type IndentStyle = 'spaces' | 'tabs';
export type ColorPreviewFormat = 'hex' | 'rgb' | 'hsl' | 'oklch' | 'oklab';
export type SchematicSymbolSet = 'ansi' | 'iec';
export type CalendarTimeFormat = 'system' | '12-hour' | '24-hour';
export type CalendarDefaultDuration = 15 | 30 | 45 | 60 | 90 | 120;
export type CalendarDateFormat =
  'MMM_D_YYYY' | 'D_MMM_YYYY' | 'YYYY_MM_DD' | 'MM_DD_YYYY' | 'DD_MM_YYYY';

export interface ThemePrefs {
  theme: Theme;
  accent: AccentColor;
  fontScale: number;
  indentStyle: IndentStyle;
  tabWidth: number;
  showInlineColorPreviews: boolean;
  colorPreviewShowSwatch: boolean;
  colorPreviewTintText: boolean;
  colorPreviewFormats: Record<ColorPreviewFormat, boolean>;
  schematicSymbolSet: SchematicSymbolSet;
  calendarDateFormat: CalendarDateFormat;
  calendarWeekStart: 0 | 1;
  calendarTimeFormat: CalendarTimeFormat;
  calendarDefaultDurationMinutes: CalendarDefaultDuration;
  calendarWorkingHoursStart: string;
  calendarWorkingHoursEnd: string;
  calendarDefaultReminderMinutes: number | null;
  calendarHideWeekends: boolean;
  calendarShowDeclined: boolean;
}

export const TAB_WIDTH_OPTIONS = [2, 3, 4, 6, 8] as const;

export const COLOR_PREVIEW_FORMAT_OPTIONS: Record<
  ColorPreviewFormat,
  { label: string; description: string }
> = {
  hex: { label: 'Hex', description: '#rgb, #rgba, #rrggbb, #rrggbbaa' },
  rgb: { label: 'RGB / RGBA', description: 'rgb(...) and rgba(...)' },
  hsl: { label: 'HSL / HSLA', description: 'hsl(...) and hsla(...)' },
  oklch: { label: 'OKLCH', description: 'oklch(...) color strings' },
  oklab: { label: 'OKLAB', description: 'oklab(...) color strings' },
};

export const DEFAULT_COLOR_PREVIEW_FORMATS: Record<ColorPreviewFormat, boolean> = {
  hex: true,
  rgb: true,
  hsl: true,
  oklch: true,
  oklab: true,
};

export const DEFAULT_PREFS: ThemePrefs = {
  theme: 'dark',
  accent: 'violet',
  fontScale: 1,
  indentStyle: 'spaces',
  tabWidth: 2,
  showInlineColorPreviews: true,
  colorPreviewShowSwatch: true,
  colorPreviewTintText: true,
  colorPreviewFormats: { ...DEFAULT_COLOR_PREVIEW_FORMATS },
  schematicSymbolSet: 'ansi',
  calendarDateFormat: 'MMM_D_YYYY',
  calendarWeekStart: 1,
  calendarTimeFormat: 'system',
  calendarDefaultDurationMinutes: 60,
  calendarWorkingHoursStart: '08:00',
  calendarWorkingHoursEnd: '17:00',
  calendarDefaultReminderMinutes: 10,
  calendarHideWeekends: false,
  calendarShowDeclined: true,
};

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'warm', label: 'Warm' },
  { id: 'light', label: 'Light' },
];

export const ACCENTS: { id: AccentColor; label: string; oklch: string }[] = [
  { id: 'violet', label: 'Violet', oklch: '0.68 0.22 293' },
  { id: 'blue', label: 'Blue', oklch: '0.65 0.19 237' },
  { id: 'emerald', label: 'Emerald', oklch: '0.72 0.17 162' },
  { id: 'rose', label: 'Rose', oklch: '0.66 0.22 13' },
  { id: 'orange', label: 'Orange', oklch: '0.72 0.18 50' },
  { id: 'cyan', label: 'Cyan', oklch: '0.74 0.14 200' },
];

// Theme-base CSS variables, mirrored from the desktop `THEME_VARS` in App.tsx.
const THEME_VARS: Record<Theme, Record<string, string>> = {
  dark: {
    '--background': 'oklch(0.17 0.015 264)',
    '--foreground': 'oklch(0.93 0.01 264)',
    '--card': 'oklch(0.20 0.015 264)',
    '--muted': 'oklch(0.23 0.015 264)',
    '--muted-foreground': 'oklch(0.62 0.02 264)',
    '--surface': 'oklch(0.22 0.016 264)',
    '--border': 'oklch(1 0 0 / 11%)',
    '--sidebar': 'oklch(0.15 0.018 264)',
  },
  midnight: {
    '--background': 'oklch(0.07 0.00 0)',
    '--foreground': 'oklch(0.90 0.00 0)',
    '--card': 'oklch(0.10 0.00 0)',
    '--muted': 'oklch(0.14 0.00 0)',
    '--muted-foreground': 'oklch(0.55 0.01 264)',
    '--surface': 'oklch(0.12 0.005 264)',
    '--border': 'oklch(1 0 0 / 8%)',
    '--sidebar': 'oklch(0.08 0.00 0)',
  },
  warm: {
    '--background': 'oklch(0.11 0.02 60)',
    '--foreground': 'oklch(0.92 0.02 60)',
    '--card': 'oklch(0.14 0.02 60)',
    '--muted': 'oklch(0.18 0.02 60)',
    '--muted-foreground': 'oklch(0.60 0.03 60)',
    '--surface': 'oklch(0.16 0.022 60)',
    '--border': 'oklch(1 0 0 / 9%)',
    '--sidebar': 'oklch(0.12 0.025 60)',
  },
  light: {
    '--background': 'oklch(0.97 0 0)',
    '--foreground': 'oklch(0.14 0 0)',
    '--card': 'oklch(1 0 0)',
    '--muted': 'oklch(0.94 0 0)',
    '--muted-foreground': 'oklch(0.45 0.01 264)',
    '--surface': 'oklch(0.99 0 0)',
    '--border': 'oklch(0 0 0 / 10%)',
    '--sidebar': 'oklch(0.94 0 0)',
  },
};

const STORAGE_KEY = 'collab-mobile-theme';
const BASE_FONT_SIZE = 15;

function normalizeColorPreviewFormats(value: unknown): Record<ColorPreviewFormat, boolean> {
  const record =
    value && typeof value === 'object'
      ? (value as Partial<Record<ColorPreviewFormat, unknown>>)
      : {};
  return {
    hex: typeof record.hex === 'boolean' ? record.hex : DEFAULT_COLOR_PREVIEW_FORMATS.hex,
    rgb: typeof record.rgb === 'boolean' ? record.rgb : DEFAULT_COLOR_PREVIEW_FORMATS.rgb,
    hsl: typeof record.hsl === 'boolean' ? record.hsl : DEFAULT_COLOR_PREVIEW_FORMATS.hsl,
    oklch: typeof record.oklch === 'boolean' ? record.oklch : DEFAULT_COLOR_PREVIEW_FORMATS.oklch,
    oklab: typeof record.oklab === 'boolean' ? record.oklab : DEFAULT_COLOR_PREVIEW_FORMATS.oklab,
  };
}

function validClockTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validDuration(value: unknown): value is CalendarDefaultDuration {
  return (
    value === 15 || value === 30 || value === 45 || value === 60 || value === 90 || value === 120
  );
}

function validDateFormat(value: unknown): value is CalendarDateFormat {
  return (
    value === 'MMM_D_YYYY' ||
    value === 'D_MMM_YYYY' ||
    value === 'YYYY_MM_DD' ||
    value === 'MM_DD_YYYY' ||
    value === 'DD_MM_YYYY'
  );
}

export function loadPrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemePrefs>;
      return {
        theme: THEMES.some((t) => t.id === parsed.theme)
          ? (parsed.theme as Theme)
          : DEFAULT_PREFS.theme,
        accent: ACCENTS.some((a) => a.id === parsed.accent)
          ? (parsed.accent as AccentColor)
          : DEFAULT_PREFS.accent,
        fontScale:
          typeof parsed.fontScale === 'number' &&
          parsed.fontScale >= 0.85 &&
          parsed.fontScale <= 1.3
            ? parsed.fontScale
            : DEFAULT_PREFS.fontScale,
        indentStyle: parsed.indentStyle === 'tabs' ? 'tabs' : DEFAULT_PREFS.indentStyle,
        tabWidth:
          typeof parsed.tabWidth === 'number' &&
          TAB_WIDTH_OPTIONS.includes(parsed.tabWidth as (typeof TAB_WIDTH_OPTIONS)[number])
            ? parsed.tabWidth
            : DEFAULT_PREFS.tabWidth,
        showInlineColorPreviews:
          typeof parsed.showInlineColorPreviews === 'boolean'
            ? parsed.showInlineColorPreviews
            : DEFAULT_PREFS.showInlineColorPreviews,
        colorPreviewShowSwatch:
          typeof parsed.colorPreviewShowSwatch === 'boolean'
            ? parsed.colorPreviewShowSwatch
            : DEFAULT_PREFS.colorPreviewShowSwatch,
        colorPreviewTintText:
          typeof parsed.colorPreviewTintText === 'boolean'
            ? parsed.colorPreviewTintText
            : DEFAULT_PREFS.colorPreviewTintText,
        colorPreviewFormats: normalizeColorPreviewFormats(parsed.colorPreviewFormats),
        schematicSymbolSet: parsed.schematicSymbolSet === 'iec' ? 'iec' : 'ansi',
        calendarDateFormat: validDateFormat(parsed.calendarDateFormat)
          ? parsed.calendarDateFormat
          : DEFAULT_PREFS.calendarDateFormat,
        calendarWeekStart: parsed.calendarWeekStart === 0 ? 0 : 1,
        calendarTimeFormat:
          parsed.calendarTimeFormat === '12-hour' || parsed.calendarTimeFormat === '24-hour'
            ? parsed.calendarTimeFormat
            : 'system',
        calendarDefaultDurationMinutes: validDuration(parsed.calendarDefaultDurationMinutes)
          ? parsed.calendarDefaultDurationMinutes
          : DEFAULT_PREFS.calendarDefaultDurationMinutes,
        calendarWorkingHoursStart: validClockTime(parsed.calendarWorkingHoursStart)
          ? parsed.calendarWorkingHoursStart
          : DEFAULT_PREFS.calendarWorkingHoursStart,
        calendarWorkingHoursEnd: validClockTime(parsed.calendarWorkingHoursEnd)
          ? parsed.calendarWorkingHoursEnd
          : DEFAULT_PREFS.calendarWorkingHoursEnd,
        calendarDefaultReminderMinutes:
          parsed.calendarDefaultReminderMinutes === null ||
          (typeof parsed.calendarDefaultReminderMinutes === 'number' &&
            Number.isInteger(parsed.calendarDefaultReminderMinutes) &&
            parsed.calendarDefaultReminderMinutes >= 0)
            ? parsed.calendarDefaultReminderMinutes
            : DEFAULT_PREFS.calendarDefaultReminderMinutes,
        calendarHideWeekends:
          typeof parsed.calendarHideWeekends === 'boolean'
            ? parsed.calendarHideWeekends
            : DEFAULT_PREFS.calendarHideWeekends,
        calendarShowDeclined:
          typeof parsed.calendarShowDeclined === 'boolean'
            ? parsed.calendarShowDeclined
            : DEFAULT_PREFS.calendarShowDeclined,
      };
    }
  } catch {
    // Fall through to defaults.
  }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(prefs: ThemePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort persistence.
  }
}

export function applyTheme(prefs: ThemePrefs): void {
  const root = document.documentElement;
  const isLight = prefs.theme === 'light';
  root.classList.toggle('dark', !isLight);
  root.setAttribute('data-theme', prefs.theme);

  const vars = THEME_VARS[prefs.theme] ?? THEME_VARS.dark;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }

  const accent = ACCENTS.find((a) => a.id === prefs.accent) ?? ACCENTS[0];
  root.style.setProperty('--primary', `oklch(${accent.oklch})`);
  root.style.setProperty('--primary-foreground', isLight ? 'oklch(1 0 0)' : 'oklch(0.10 0 0)');
  root.style.setProperty('--glow', `oklch(${accent.oklch} / 28%)`);

  root.style.setProperty('--base-font-size', `${Math.round(BASE_FONT_SIZE * prefs.fontScale)}px`);
}
