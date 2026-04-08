import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ActiveView    = 'editor' | 'graph' | 'canvas' | 'kanban' | 'grid';
export type SidebarPanel  = 'files' | 'search' | 'tags' | 'canvas-boards' | 'kanban-boards' | 'collab';
export type Theme         = 'dark' | 'midnight' | 'warm' | 'light';
export type AccentColor   = 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan';
export type EditorFont    = 'geist' | 'inter' | 'serif' | 'mono';
export type DateFormat    = 'MMM_D_YYYY' | 'D_MMM_YYYY' | 'YYYY_MM_DD' | 'MM_DD_YYYY' | 'DD_MM_YYYY';
export type WeekStart     = 0 | 1; // 0 = Sunday, 1 = Monday
export type AnimationSpeed = 'slow' | 'normal' | 'fast';

/** Map accent name → oklch(L C H) string (used for --primary in dark/light) */
export const ACCENT_COLORS: Record<AccentColor, { label: string; oklch: string; hex: string }> = {
  violet:  { label: 'Violet',  oklch: '0.68 0.22 293', hex: '#a78bfa' },
  blue:    { label: 'Blue',    oklch: '0.65 0.19 237', hex: '#60a5fa' },
  emerald: { label: 'Emerald', oklch: '0.72 0.17 162', hex: '#34d399' },
  rose:    { label: 'Rose',    oklch: '0.66 0.22 13',  hex: '#fb7185' },
  orange:  { label: 'Orange',  oklch: '0.72 0.18 50',  hex: '#fb923c' },
  cyan:    { label: 'Cyan',    oklch: '0.74 0.14 200', hex: '#22d3ee' },
};

export const EDITOR_FONTS: Record<EditorFont, { label: string; css: string }> = {
  geist: { label: 'Geist (default)', css: "'Geist Variable', sans-serif" },
  inter: { label: 'Inter',           css: "'Inter', system-ui, sans-serif" },
  serif: { label: 'Serif',           css: "'Georgia', 'Times New Roman', serif" },
  mono:  { label: 'Monospace',       css: "'Geist Variable', 'Courier New', monospace" },
};

export const SCALE_OPTIONS = [75, 90, 100, 110, 125, 150, 175, 200] as const;
export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16] as const;
export const ANIMATION_SPEED_OPTIONS: AnimationSpeed[] = ['slow', 'normal', 'fast'];

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
  const y  = date.getFullYear();
  const m  = date.getMonth();
  const d  = date.getDate();
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  switch (fmt) {
    case 'MMM_D_YYYY': return `${MONTHS_SHORT[m]} ${d}, ${y}`;
    case 'D_MMM_YYYY': return `${d} ${MONTHS_SHORT[m]} ${y}`;
    case 'YYYY_MM_DD': return `${y}-${mm}-${dd}`;
    case 'MM_DD_YYYY': return `${mm}/${dd}/${y}`;
    case 'DD_MM_YYYY': return `${dd}/${mm}/${y}`;
  }
}

export const DATE_FORMAT_OPTIONS: Record<DateFormat, { label: string; description: string }> = {
  MMM_D_YYYY: { label: 'Apr 1, 2026',  description: 'Month Day, Year' },
  D_MMM_YYYY: { label: '1 Apr 2026',   description: 'Day Month Year' },
  YYYY_MM_DD: { label: '2026-04-01',   description: 'ISO 8601' },
  MM_DD_YYYY: { label: '04/01/2026',   description: 'MM/DD/YYYY (US)' },
  DD_MM_YYYY: { label: '01/04/2026',   description: 'DD/MM/YYYY (EU)' },
};

interface UiState {
  activeView:    ActiveView;
  sidebarPanel:  SidebarPanel;
  sidebarWidth:  number;
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isVaultManagerOpen: boolean;

  // Appearance
  theme:       Theme;
  accentColor: AccentColor;
  editorFont:  EditorFont;
  fontSize:    number;
  scale:       number;

  // Calendar
  dateFormat: DateFormat;
  weekStart:  WeekStart;

  // Behavior
  confirmDelete: boolean;
  animationsEnabled: boolean;
  animationSpeed: AnimationSpeed;

  // Actions
  setActiveView:    (view: ActiveView) => void;
  setSidebarPanel:  (panel: SidebarPanel) => void;
  setSidebarWidth:  (width: number) => void;
  toggleSidebar:    () => void;
  openSettings:     () => void;
  closeSettings:    () => void;
  openVaultManager:  () => void;
  closeVaultManager: () => void;

  setTheme:         (theme: Theme) => void;
  setAccentColor:   (color: AccentColor) => void;
  setEditorFont:    (font: EditorFont) => void;
  setFontSize:      (size: number) => void;
  setScale:         (scale: number) => void;
  setDateFormat:    (fmt: DateFormat) => void;
  setWeekStart:     (day: WeekStart) => void;
  setConfirmDelete: (v: boolean) => void;
  setAnimationsEnabled: (v: boolean) => void;
  setAnimationSpeed:    (speed: AnimationSpeed) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeView:     'editor',
      sidebarPanel:   'files',
      sidebarWidth:   240,
      isSidebarOpen:      true,
      isSettingsOpen:     false,
      isVaultManagerOpen: false,

      theme:       'dark',
      accentColor: 'violet',
      editorFont:  'geist',
      fontSize:    14,
      scale:       100,

      dateFormat: 'MMM_D_YYYY',
      weekStart:  1,

      confirmDelete: true,
      animationsEnabled: true,
      animationSpeed: 'normal',

      setActiveView:   (activeView)   => set({ activeView }),
      setSidebarPanel: (sidebarPanel) => set({ sidebarPanel }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      toggleSidebar:   ()             => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),
      openSettings:     ()             => set({ isSettingsOpen: true }),
      closeSettings:    ()             => set({ isSettingsOpen: false }),
      openVaultManager:  ()            => set({ isVaultManagerOpen: true }),
      closeVaultManager: ()            => set({ isVaultManagerOpen: false }),

      setTheme:         (theme)         => set({ theme }),
      setAccentColor:   (accentColor)   => set({ accentColor }),
      setEditorFont:    (editorFont)    => set({ editorFont }),
      setFontSize:      (fontSize)      => set({ fontSize }),
      setScale:         (scale)         => set({ scale }),
      setDateFormat:    (dateFormat)    => set({ dateFormat }),
      setWeekStart:     (weekStart)     => set({ weekStart }),
      setConfirmDelete: (confirmDelete) => set({ confirmDelete }),
      setAnimationsEnabled: (animationsEnabled) => set({ animationsEnabled }),
      setAnimationSpeed:    (animationSpeed)    => set({ animationSpeed }),
    }),
    {
      name: 'ui-storage',
      storage: persistedUiStorage,
      // Don't persist transient state
      partialize: (s) => ({
        sidebarWidth:  s.sidebarWidth,
        isSidebarOpen: s.isSidebarOpen,
        theme:         s.theme,
        accentColor:   s.accentColor,
        editorFont:    s.editorFont,
        fontSize:      s.fontSize,
        scale:         s.scale,
        dateFormat:    s.dateFormat,
        weekStart:     s.weekStart,
        confirmDelete: s.confirmDelete,
        animationsEnabled: s.animationsEnabled,
        animationSpeed:    s.animationSpeed,
      }),
    }
  )
);
