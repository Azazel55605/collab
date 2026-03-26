import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ActiveView    = 'editor' | 'graph' | 'canvas' | 'kanban';
export type SidebarPanel  = 'files' | 'search' | 'tags';
export type Theme         = 'dark' | 'midnight' | 'warm' | 'light';
export type AccentColor   = 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan';
export type EditorFont    = 'geist' | 'inter' | 'serif' | 'mono';

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

interface UiState {
  activeView:    ActiveView;
  sidebarPanel:  SidebarPanel;
  sidebarWidth:  number;
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;

  // Appearance
  theme:       Theme;
  accentColor: AccentColor;
  editorFont:  EditorFont;
  fontSize:    number;
  scale:       number;

  // Behavior
  confirmDelete: boolean;

  // Actions
  setActiveView:    (view: ActiveView) => void;
  setSidebarPanel:  (panel: SidebarPanel) => void;
  setSidebarWidth:  (width: number) => void;
  toggleSidebar:    () => void;
  openSettings:     () => void;
  closeSettings:    () => void;

  setTheme:         (theme: Theme) => void;
  setAccentColor:   (color: AccentColor) => void;
  setEditorFont:    (font: EditorFont) => void;
  setFontSize:      (size: number) => void;
  setScale:         (scale: number) => void;
  setConfirmDelete: (v: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeView:     'editor',
      sidebarPanel:   'files',
      sidebarWidth:   240,
      isSidebarOpen:  true,
      isSettingsOpen: false,

      theme:       'dark',
      accentColor: 'violet',
      editorFont:  'geist',
      fontSize:    14,
      scale:       100,

      confirmDelete: true,

      setActiveView:   (activeView)   => set({ activeView }),
      setSidebarPanel: (sidebarPanel) => set({ sidebarPanel }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      toggleSidebar:   ()             => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),
      openSettings:    ()             => set({ isSettingsOpen: true }),
      closeSettings:   ()             => set({ isSettingsOpen: false }),

      setTheme:         (theme)         => set({ theme }),
      setAccentColor:   (accentColor)   => set({ accentColor }),
      setEditorFont:    (editorFont)    => set({ editorFont }),
      setFontSize:      (fontSize)      => set({ fontSize }),
      setScale:         (scale)         => set({ scale }),
      setConfirmDelete: (confirmDelete) => set({ confirmDelete }),
    }),
    {
      name: 'ui-storage',
      // Don't persist transient state
      partialize: (s) => ({
        activeView:    s.activeView,
        sidebarPanel:  s.sidebarPanel,
        sidebarWidth:  s.sidebarWidth,
        isSidebarOpen: s.isSidebarOpen,
        theme:         s.theme,
        accentColor:   s.accentColor,
        editorFont:    s.editorFont,
        fontSize:      s.fontSize,
        scale:         s.scale,
        confirmDelete: s.confirmDelete,
      }),
    }
  )
);
