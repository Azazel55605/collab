import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { SchematicSymbolSet } from '../types/logicDiagram';

export type ActiveView = 'editor' | 'graph' | 'canvas' | 'kanban' | 'calendar' | 'grid';
export type SidebarPanel =
  'files' | 'search' | 'tags' | 'canvas-boards' | 'kanban-boards' | 'collab';
export type CollabTab = 'peers' | 'chat' | 'history';
export type Theme = 'dark' | 'midnight' | 'warm' | 'light';
export type AccentColor = 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan';
export type InterfaceFont = 'geist' | 'inter' | 'serif' | 'mono';
export type EditorFont = 'firaCode' | 'jetbrainsMono' | 'codingMono';
export type IndentStyle = 'spaces' | 'tabs';
export type ColorPreviewFormat = 'hex' | 'rgb' | 'hsl' | 'oklch' | 'oklab';
export type DateFormat = 'MMM_D_YYYY' | 'D_MMM_YYYY' | 'YYYY_MM_DD' | 'MM_DD_YYYY' | 'DD_MM_YYYY';
export type WeekStart = 0 | 1; // 0 = Sunday, 1 = Monday
export type TimeFormat = 'system' | '12-hour' | '24-hour';
export type CalendarDefaultDuration = 15 | 30 | 45 | 60 | 90 | 120;
export type AnimationSpeed = 'slow' | 'normal' | 'fast';
export type CanvasWebCardDefaultMode = 'preview' | 'embed';
export type OcrModelSource = 'official-fast';
export type OcrRenderScale = 1 | 2 | 3;
export type OcrPreprocessingMode = 'none' | 'grayscale' | 'contrast' | 'threshold' | 'invert';

/** Map accent name → oklch(L C H) string (used for --primary in dark/light) */
export const ACCENT_COLORS: Record<AccentColor, { label: string; oklch: string; hex: string }> = {
  violet: { label: 'Violet', oklch: '0.68 0.22 293', hex: '#a78bfa' },
  blue: { label: 'Blue', oklch: '0.65 0.19 237', hex: '#60a5fa' },
  emerald: { label: 'Emerald', oklch: '0.72 0.17 162', hex: '#34d399' },
  rose: { label: 'Rose', oklch: '0.66 0.22 13', hex: '#fb7185' },
  orange: { label: 'Orange', oklch: '0.72 0.18 50', hex: '#fb923c' },
  cyan: { label: 'Cyan', oklch: '0.74 0.14 200', hex: '#22d3ee' },
};

export const INTERFACE_FONTS: Record<InterfaceFont, { label: string; css: string }> = {
  geist: { label: 'Geist (default)', css: "'Geist Variable', sans-serif" },
  inter: { label: 'Inter', css: "'Inter Variable', 'Inter', system-ui, sans-serif" },
  serif: { label: 'Serif', css: "'Georgia', 'Times New Roman', serif" },
  mono: {
    label: 'Monospace',
    css: "'JetBrains Mono', 'Fira Code', 'Geist Mono Variable', 'Courier New', monospace",
  },
};

export const EDITOR_FONTS: Record<EditorFont, { label: string; css: string }> = {
  codingMono: {
    label: 'Coding Mono',
    css: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Pure Nerd Font', PureNerdFont, 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CaskaydiaCove Nerd Font', 'Symbols Nerd Font Mono', monospace",
  },
  jetbrainsMono: {
    label: 'JetBrains Mono',
    css: "'JetBrains Mono', 'Pure Nerd Font', PureNerdFont, 'JetBrainsMono Nerd Font', 'Symbols Nerd Font Mono', monospace",
  },
  firaCode: {
    label: 'Fira Code',
    css: "'Fira Code', 'Pure Nerd Font', PureNerdFont, 'FiraCode Nerd Font', 'Symbols Nerd Font Mono', monospace",
  },
};

export const SCALE_OPTIONS = [75, 90, 100, 110, 125, 150, 175, 200] as const;
export const INTERFACE_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16] as const;
export const EDITOR_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16] as const;
export const ANIMATION_SPEED_OPTIONS: AnimationSpeed[] = ['slow', 'normal', 'fast'];
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

const DEFAULT_INTERFACE_FONT: InterfaceFont = 'geist';
const DEFAULT_EDITOR_FONT: EditorFont = 'codingMono';
const DEFAULT_INTERFACE_FONT_SIZE = 14;
const DEFAULT_EDITOR_FONT_SIZE = 14;

function isInterfaceFont(value: unknown): value is InterfaceFont {
  return typeof value === 'string' && value in INTERFACE_FONTS;
}

function isEditorFont(value: unknown): value is EditorFont {
  return typeof value === 'string' && value in EDITOR_FONTS;
}

function isOcrModelSource(value: unknown): value is OcrModelSource {
  return value === 'official-fast';
}

function isOcrPreprocessingMode(value: unknown): value is OcrPreprocessingMode {
  return (
    value === 'none' ||
    value === 'grayscale' ||
    value === 'contrast' ||
    value === 'threshold' ||
    value === 'invert'
  );
}

function isSchematicSymbolSet(value: unknown): value is SchematicSymbolSet {
  return value === 'ansi' || value === 'iec';
}

function isTimeFormat(value: unknown): value is TimeFormat {
  return value === 'system' || value === '12-hour' || value === '24-hour';
}

function isCalendarDefaultDuration(value: unknown): value is CalendarDefaultDuration {
  return (
    value === 15 || value === 30 || value === 45 || value === 60 || value === 90 || value === 120
  );
}

function isClockTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeDefaultReminder(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 525_600
    ? value
    : 10;
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizeFontSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizePersistedUiState(persisted: unknown): Partial<UiState> {
  if (!persisted || typeof persisted !== 'object') return {};
  const state = persisted as Record<string, unknown>;
  const legacyFont = state.editorFont;
  const legacyFontSize = state.fontSize;

  const interfaceFont = isInterfaceFont(state.interfaceFont)
    ? state.interfaceFont
    : isInterfaceFont(legacyFont)
      ? legacyFont
      : DEFAULT_INTERFACE_FONT;
  const editorFont = isEditorFont(state.editorFont) ? state.editorFont : DEFAULT_EDITOR_FONT;
  const fileTreeCollapsedPathsByVault =
    state.fileTreeCollapsedPathsByVault && typeof state.fileTreeCollapsedPathsByVault === 'object'
      ? (state.fileTreeCollapsedPathsByVault as Record<string, string[]>)
      : {};
  const legacyCollapsedPaths = Array.isArray(state.fileTreeCollapsedPaths)
    ? state.fileTreeCollapsedPaths.filter((value): value is string => typeof value === 'string')
    : [];
  const lastOpenedVaultPath =
    typeof state.lastOpenedVaultPath === 'string' ? state.lastOpenedVaultPath : null;

  return {
    ...state,
    interfaceFont,
    interfaceFontSize: normalizeFontSize(
      state.interfaceFontSize ?? legacyFontSize,
      DEFAULT_INTERFACE_FONT_SIZE,
    ),
    editorFont,
    editorFontSize: normalizeFontSize(state.editorFontSize, DEFAULT_EDITOR_FONT_SIZE),
    schematicSymbolSet: isSchematicSymbolSet(state.schematicSymbolSet)
      ? state.schematicSymbolSet
      : 'ansi',
    timeFormat: isTimeFormat(state.timeFormat) ? state.timeFormat : 'system',
    calendarDefaultTimeZone: isSupportedTimeZone(state.calendarDefaultTimeZone)
      ? state.calendarDefaultTimeZone
      : systemTimeZone(),
    calendarDefaultDurationMinutes: isCalendarDefaultDuration(state.calendarDefaultDurationMinutes)
      ? state.calendarDefaultDurationMinutes
      : 60,
    calendarWorkingHoursStart: isClockTime(state.calendarWorkingHoursStart)
      ? state.calendarWorkingHoursStart
      : '08:00',
    calendarWorkingHoursEnd: isClockTime(state.calendarWorkingHoursEnd)
      ? state.calendarWorkingHoursEnd
      : '17:00',
    calendarDefaultReminderMinutes: normalizeDefaultReminder(state.calendarDefaultReminderMinutes),
    calendarHideWeekends:
      typeof state.calendarHideWeekends === 'boolean' ? state.calendarHideWeekends : false,
    calendarShowDeclined:
      typeof state.calendarShowDeclined === 'boolean' ? state.calendarShowDeclined : true,
    ocrLanguage:
      typeof state.ocrLanguage === 'string' && state.ocrLanguage.length > 0
        ? state.ocrLanguage
        : 'eng',
    ocrModelSource: isOcrModelSource(state.ocrModelSource) ? state.ocrModelSource : 'official-fast',
    ocrRenderScale:
      state.ocrRenderScale === 1 || state.ocrRenderScale === 2 || state.ocrRenderScale === 3
        ? state.ocrRenderScale
        : 2,
    ocrPreprocessingMode: isOcrPreprocessingMode(state.ocrPreprocessingMode)
      ? state.ocrPreprocessingMode
      : 'none',
    ocrOverlayVisible:
      typeof state.ocrOverlayVisible === 'boolean' ? state.ocrOverlayVisible : true,
    fileTreeCollapsedPathsByVault:
      legacyCollapsedPaths.length > 0 &&
      lastOpenedVaultPath &&
      !fileTreeCollapsedPathsByVault[lastOpenedVaultPath]
        ? { ...fileTreeCollapsedPathsByVault, [lastOpenedVaultPath]: legacyCollapsedPaths }
        : fileTreeCollapsedPathsByVault,
  } as Partial<UiState>;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const persistedUiStorage = createJSONStorage(() => {
  const cache = new Map<string, string | null>();
  return {
    getItem: (name) => {
      const value = localStorage.getItem(name);
      cache.set(name, value);
      return value;
    },
    setItem: (name, value) => {
      if (cache.get(name) === value) return;
      cache.set(name, value);
      localStorage.setItem(name, value);
    },
    removeItem: (name) => {
      cache.delete(name);
      localStorage.removeItem(name);
    },
  };
});

export function formatDate(date: Date, fmt: DateFormat): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  switch (fmt) {
    case 'MMM_D_YYYY':
      return `${MONTHS_SHORT[m]} ${d}, ${y}`;
    case 'D_MMM_YYYY':
      return `${d} ${MONTHS_SHORT[m]} ${y}`;
    case 'YYYY_MM_DD':
      return `${y}-${mm}-${dd}`;
    case 'MM_DD_YYYY':
      return `${mm}/${dd}/${y}`;
    case 'DD_MM_YYYY':
      return `${dd}/${mm}/${y}`;
  }
}

export function formatTime(date: Date, format: TimeFormat): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: format === 'system' ? undefined : format === '12-hour',
  }).format(date);
}

export const DATE_FORMAT_OPTIONS: Record<DateFormat, { label: string; description: string }> = {
  MMM_D_YYYY: { label: 'Apr 1, 2026', description: 'Month Day, Year' },
  D_MMM_YYYY: { label: '1 Apr 2026', description: 'Day Month Year' },
  YYYY_MM_DD: { label: '2026-04-01', description: 'ISO 8601' },
  MM_DD_YYYY: { label: '04/01/2026', description: 'MM/DD/YYYY (US)' },
  DD_MM_YYYY: { label: '01/04/2026', description: 'DD/MM/YYYY (EU)' },
};

interface UiState {
  activeView: ActiveView;
  sidebarPanel: SidebarPanel;
  collabTab: CollabTab;
  fileTreeCollapsedPathsByVault: Record<string, string[]>;
  sidebarWidth: number;
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isVaultManagerOpen: boolean;

  // Appearance
  theme: Theme;
  accentColor: AccentColor;
  interfaceFont: InterfaceFont;
  interfaceFontSize: number;
  editorFont: EditorFont;
  editorFontSize: number;
  indentStyle: IndentStyle;
  tabWidth: number;
  showIndentMarkers: boolean;
  showColoredIndents: boolean;
  showInlineColorPreviews: boolean;
  colorPreviewShowSwatch: boolean;
  colorPreviewTintText: boolean;
  colorPreviewFormats: Record<ColorPreviewFormat, boolean>;
  restorePreviousSession: boolean;
  scale: number;

  // Calendar
  dateFormat: DateFormat;
  weekStart: WeekStart;
  timeFormat: TimeFormat;
  calendarDefaultTimeZone: string;
  calendarDefaultDurationMinutes: CalendarDefaultDuration;
  calendarWorkingHoursStart: string;
  calendarWorkingHoursEnd: string;
  calendarDefaultReminderMinutes: number | null;
  calendarHideWeekends: boolean;
  calendarShowDeclined: boolean;

  // Behavior
  confirmDelete: boolean;
  animationsEnabled: boolean;
  animationSpeed: AnimationSpeed;
  canvasWebCardDefaultMode: CanvasWebCardDefaultMode;
  canvasWebCardAutoLoad: boolean;
  webPreviewsEnabled: boolean;
  hoverWebLinkPreviewsEnabled: boolean;
  backgroundWebPreviewPrefetchEnabled: boolean;
  fileTreeHoverPreviewsEnabled: boolean;
  /** Enables verbose live-collaboration tracing (in-app Live Debug panel + console). */
  liveCollabDebug: boolean;
  ocrLanguage: string;
  ocrModelSource: OcrModelSource;
  ocrRenderScale: OcrRenderScale;
  ocrPreprocessingMode: OcrPreprocessingMode;
  ocrOverlayVisible: boolean;
  schematicSymbolSet: SchematicSymbolSet;

  // Actions
  setActiveView: (view: ActiveView) => void;
  setSidebarPanel: (panel: SidebarPanel) => void;
  setCollabTab: (tab: CollabTab) => void;
  setFileTreeCollapsedPathsForVault: (vaultPath: string, paths: string[]) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebar: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openVaultManager: () => void;
  closeVaultManager: () => void;

  setTheme: (theme: Theme) => void;
  setAccentColor: (color: AccentColor) => void;
  setInterfaceFont: (font: InterfaceFont) => void;
  setInterfaceFontSize: (size: number) => void;
  setEditorFont: (font: EditorFont) => void;
  setEditorFontSize: (size: number) => void;
  setIndentStyle: (style: IndentStyle) => void;
  setTabWidth: (size: number) => void;
  setShowIndentMarkers: (value: boolean) => void;
  setShowColoredIndents: (value: boolean) => void;
  setShowInlineColorPreviews: (value: boolean) => void;
  setColorPreviewShowSwatch: (value: boolean) => void;
  setColorPreviewTintText: (value: boolean) => void;
  setColorPreviewFormatEnabled: (format: ColorPreviewFormat, value: boolean) => void;
  setRestorePreviousSession: (value: boolean) => void;
  setScale: (scale: number) => void;
  setDateFormat: (fmt: DateFormat) => void;
  setWeekStart: (day: WeekStart) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setCalendarDefaultTimeZone: (timeZone: string) => void;
  setCalendarDefaultDurationMinutes: (minutes: CalendarDefaultDuration) => void;
  setCalendarWorkingHoursStart: (time: string) => void;
  setCalendarWorkingHoursEnd: (time: string) => void;
  setCalendarDefaultReminderMinutes: (minutes: number | null) => void;
  setCalendarHideWeekends: (hidden: boolean) => void;
  setCalendarShowDeclined: (visible: boolean) => void;
  setConfirmDelete: (v: boolean) => void;
  setAnimationsEnabled: (v: boolean) => void;
  setAnimationSpeed: (speed: AnimationSpeed) => void;
  setCanvasWebCardDefaultMode: (mode: CanvasWebCardDefaultMode) => void;
  setCanvasWebCardAutoLoad: (value: boolean) => void;
  setWebPreviewsEnabled: (value: boolean) => void;
  setHoverWebLinkPreviewsEnabled: (value: boolean) => void;
  setBackgroundWebPreviewPrefetchEnabled: (value: boolean) => void;
  setFileTreeHoverPreviewsEnabled: (value: boolean) => void;
  setLiveCollabDebug: (value: boolean) => void;
  setOcrLanguage: (language: string) => void;
  setOcrModelSource: (source: OcrModelSource) => void;
  setOcrRenderScale: (scale: OcrRenderScale) => void;
  setOcrPreprocessingMode: (mode: OcrPreprocessingMode) => void;
  setOcrOverlayVisible: (visible: boolean) => void;
  setSchematicSymbolSet: (symbolSet: SchematicSymbolSet) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeView: 'editor',
      sidebarPanel: 'files',
      collabTab: 'peers',
      fileTreeCollapsedPathsByVault: {},
      sidebarWidth: 240,
      isSidebarOpen: true,
      isSettingsOpen: false,
      isVaultManagerOpen: false,

      theme: 'dark',
      accentColor: 'violet',
      interfaceFont: 'geist',
      interfaceFontSize: 14,
      editorFont: 'codingMono',
      editorFontSize: 14,
      indentStyle: 'spaces',
      tabWidth: 2,
      showIndentMarkers: false,
      showColoredIndents: false,
      showInlineColorPreviews: true,
      colorPreviewShowSwatch: true,
      colorPreviewTintText: true,
      colorPreviewFormats: { ...DEFAULT_COLOR_PREVIEW_FORMATS },
      restorePreviousSession: false,
      scale: 100,

      dateFormat: 'MMM_D_YYYY',
      weekStart: 1,
      timeFormat: 'system',
      calendarDefaultTimeZone: systemTimeZone(),
      calendarDefaultDurationMinutes: 60,
      calendarWorkingHoursStart: '08:00',
      calendarWorkingHoursEnd: '17:00',
      calendarDefaultReminderMinutes: 10,
      calendarHideWeekends: false,
      calendarShowDeclined: true,

      confirmDelete: true,
      animationsEnabled: true,
      animationSpeed: 'normal',
      canvasWebCardDefaultMode: 'preview',
      canvasWebCardAutoLoad: true,
      webPreviewsEnabled: true,
      hoverWebLinkPreviewsEnabled: true,
      backgroundWebPreviewPrefetchEnabled: true,
      fileTreeHoverPreviewsEnabled: true,
      liveCollabDebug: false,
      ocrLanguage: 'eng',
      ocrModelSource: 'official-fast',
      ocrRenderScale: 2,
      ocrPreprocessingMode: 'none',
      ocrOverlayVisible: true,
      schematicSymbolSet: 'ansi',

      setActiveView: (activeView) => set({ activeView }),
      setSidebarPanel: (sidebarPanel) => set({ sidebarPanel }),
      setCollabTab: (collabTab) => set({ collabTab }),
      setFileTreeCollapsedPathsForVault: (vaultPath, paths) =>
        set((state) => ({
          fileTreeCollapsedPathsByVault: {
            ...state.fileTreeCollapsedPathsByVault,
            [vaultPath]: paths,
          },
        })),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      toggleSidebar: () => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),
      openSettings: () => set({ isSettingsOpen: true }),
      closeSettings: () => set({ isSettingsOpen: false }),
      openVaultManager: () => set({ isVaultManagerOpen: true }),
      closeVaultManager: () => set({ isVaultManagerOpen: false }),

      setTheme: (theme) => set({ theme }),
      setAccentColor: (accentColor) => set({ accentColor }),
      setInterfaceFont: (interfaceFont) => set({ interfaceFont }),
      setInterfaceFontSize: (interfaceFontSize) => set({ interfaceFontSize }),
      setEditorFont: (editorFont) => set({ editorFont }),
      setEditorFontSize: (editorFontSize) => set({ editorFontSize }),
      setIndentStyle: (indentStyle) => set({ indentStyle }),
      setTabWidth: (tabWidth) => set({ tabWidth }),
      setShowIndentMarkers: (showIndentMarkers) => set({ showIndentMarkers }),
      setShowColoredIndents: (showColoredIndents) => set({ showColoredIndents }),
      setShowInlineColorPreviews: (showInlineColorPreviews) => set({ showInlineColorPreviews }),
      setColorPreviewShowSwatch: (colorPreviewShowSwatch) => set({ colorPreviewShowSwatch }),
      setColorPreviewTintText: (colorPreviewTintText) => set({ colorPreviewTintText }),
      setColorPreviewFormatEnabled: (format, value) =>
        set((state) => ({
          colorPreviewFormats: { ...state.colorPreviewFormats, [format]: value },
        })),
      setRestorePreviousSession: (restorePreviousSession) => set({ restorePreviousSession }),
      setScale: (scale) => set({ scale }),
      setDateFormat: (dateFormat) => set({ dateFormat }),
      setWeekStart: (weekStart) => set({ weekStart }),
      setTimeFormat: (timeFormat) => set({ timeFormat }),
      setCalendarDefaultTimeZone: (calendarDefaultTimeZone) => {
        if (isSupportedTimeZone(calendarDefaultTimeZone)) set({ calendarDefaultTimeZone });
      },
      setCalendarDefaultDurationMinutes: (calendarDefaultDurationMinutes) => {
        if (isCalendarDefaultDuration(calendarDefaultDurationMinutes)) {
          set({ calendarDefaultDurationMinutes });
        }
      },
      setCalendarWorkingHoursStart: (calendarWorkingHoursStart) => {
        if (isClockTime(calendarWorkingHoursStart)) set({ calendarWorkingHoursStart });
      },
      setCalendarWorkingHoursEnd: (calendarWorkingHoursEnd) => {
        if (isClockTime(calendarWorkingHoursEnd)) set({ calendarWorkingHoursEnd });
      },
      setCalendarDefaultReminderMinutes: (calendarDefaultReminderMinutes) => {
        if (
          calendarDefaultReminderMinutes === null ||
          (Number.isInteger(calendarDefaultReminderMinutes) &&
            calendarDefaultReminderMinutes >= 0 &&
            calendarDefaultReminderMinutes <= 525_600)
        ) {
          set({ calendarDefaultReminderMinutes });
        }
      },
      setCalendarHideWeekends: (calendarHideWeekends) => set({ calendarHideWeekends }),
      setCalendarShowDeclined: (calendarShowDeclined) => set({ calendarShowDeclined }),
      setConfirmDelete: (confirmDelete) => set({ confirmDelete }),
      setAnimationsEnabled: (animationsEnabled) => set({ animationsEnabled }),
      setAnimationSpeed: (animationSpeed) => set({ animationSpeed }),
      setCanvasWebCardDefaultMode: (canvasWebCardDefaultMode) => set({ canvasWebCardDefaultMode }),
      setCanvasWebCardAutoLoad: (canvasWebCardAutoLoad) => set({ canvasWebCardAutoLoad }),
      setWebPreviewsEnabled: (webPreviewsEnabled) => set({ webPreviewsEnabled }),
      setHoverWebLinkPreviewsEnabled: (hoverWebLinkPreviewsEnabled) =>
        set({ hoverWebLinkPreviewsEnabled }),
      setBackgroundWebPreviewPrefetchEnabled: (backgroundWebPreviewPrefetchEnabled) =>
        set({ backgroundWebPreviewPrefetchEnabled }),
      setFileTreeHoverPreviewsEnabled: (fileTreeHoverPreviewsEnabled) =>
        set({ fileTreeHoverPreviewsEnabled }),
      setLiveCollabDebug: (liveCollabDebug) => set({ liveCollabDebug }),
      setOcrLanguage: (ocrLanguage) => set({ ocrLanguage }),
      setOcrModelSource: (ocrModelSource) => set({ ocrModelSource }),
      setOcrRenderScale: (ocrRenderScale) => set({ ocrRenderScale }),
      setOcrPreprocessingMode: (ocrPreprocessingMode) => set({ ocrPreprocessingMode }),
      setOcrOverlayVisible: (ocrOverlayVisible) => set({ ocrOverlayVisible }),
      setSchematicSymbolSet: (schematicSymbolSet) => set({ schematicSymbolSet }),
    }),
    {
      name: 'ui-storage',
      storage: persistedUiStorage,
      merge: (persisted, current) => ({
        ...current,
        ...normalizePersistedUiState(persisted),
      }),
      // Don't persist transient state
      partialize: (s) => ({
        collabTab: s.collabTab,
        fileTreeCollapsedPathsByVault: s.fileTreeCollapsedPathsByVault,
        sidebarWidth: s.sidebarWidth,
        isSidebarOpen: s.isSidebarOpen,
        theme: s.theme,
        accentColor: s.accentColor,
        interfaceFont: s.interfaceFont,
        interfaceFontSize: s.interfaceFontSize,
        editorFont: s.editorFont,
        editorFontSize: s.editorFontSize,
        indentStyle: s.indentStyle,
        tabWidth: s.tabWidth,
        showIndentMarkers: s.showIndentMarkers,
        showColoredIndents: s.showColoredIndents,
        showInlineColorPreviews: s.showInlineColorPreviews,
        colorPreviewShowSwatch: s.colorPreviewShowSwatch,
        colorPreviewTintText: s.colorPreviewTintText,
        colorPreviewFormats: s.colorPreviewFormats,
        restorePreviousSession: s.restorePreviousSession,
        scale: s.scale,
        dateFormat: s.dateFormat,
        weekStart: s.weekStart,
        timeFormat: s.timeFormat,
        calendarDefaultTimeZone: s.calendarDefaultTimeZone,
        calendarDefaultDurationMinutes: s.calendarDefaultDurationMinutes,
        calendarWorkingHoursStart: s.calendarWorkingHoursStart,
        calendarWorkingHoursEnd: s.calendarWorkingHoursEnd,
        calendarDefaultReminderMinutes: s.calendarDefaultReminderMinutes,
        calendarHideWeekends: s.calendarHideWeekends,
        calendarShowDeclined: s.calendarShowDeclined,
        confirmDelete: s.confirmDelete,
        animationsEnabled: s.animationsEnabled,
        animationSpeed: s.animationSpeed,
        canvasWebCardDefaultMode: s.canvasWebCardDefaultMode,
        canvasWebCardAutoLoad: s.canvasWebCardAutoLoad,
        webPreviewsEnabled: s.webPreviewsEnabled,
        hoverWebLinkPreviewsEnabled: s.hoverWebLinkPreviewsEnabled,
        backgroundWebPreviewPrefetchEnabled: s.backgroundWebPreviewPrefetchEnabled,
        fileTreeHoverPreviewsEnabled: s.fileTreeHoverPreviewsEnabled,
        liveCollabDebug: s.liveCollabDebug,
        ocrLanguage: s.ocrLanguage,
        ocrModelSource: s.ocrModelSource,
        ocrRenderScale: s.ocrRenderScale,
        ocrPreprocessingMode: s.ocrPreprocessingMode,
        ocrOverlayVisible: s.ocrOverlayVisible,
        schematicSymbolSet: s.schematicSymbolSet,
      }),
    },
  ),
);
