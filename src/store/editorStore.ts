import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OpenTab {
  relativePath: string;
  title: string;
  isDirty: boolean;
  savedHash: string | null;
  type: 'note' | 'canvas' | 'kanban' | 'graph' | 'settings' | 'image' | 'pdf';
}

interface EditorState {
  sessionVaultPath: string | null;
  openTabs: OpenTab[];
  activeTabPath: string | null;
  forceReloadPath: string | null;
  revealEditorPath: string | null;
  setSessionVaultPath: (vaultPath: string | null) => void;
  resetSession: (vaultPath?: string | null) => void;
  openTab: (relativePath: string, title: string, type?: 'note' | 'canvas' | 'kanban' | 'graph' | 'settings' | 'image' | 'pdf') => void;
  closeTab: (relativePath: string) => void;
  setActiveTab: (relativePath: string) => void;
  markDirty: (relativePath: string) => void;
  markSaved: (relativePath: string, hash: string) => void;
  setSavedHash: (relativePath: string, hash: string) => void;
  updateTabTitle: (relativePath: string, title: string) => void;
  renameTab: (oldPath: string, newPath: string, newTitle: string) => void;
  reorderTabs: (fromPath: string, toPath: string, before: boolean) => void;
  setForceReloadPath: (path: string | null) => void;
  setRevealEditorPath: (path: string | null) => void;
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
  sessionVaultPath: null,
  openTabs: [],
  activeTabPath: null,
  forceReloadPath: null,
  revealEditorPath: null,

  setSessionVaultPath: (sessionVaultPath) => set({ sessionVaultPath }),

  resetSession: (vaultPath = null) => set({
    sessionVaultPath: vaultPath,
    openTabs: [],
    activeTabPath: null,
    forceReloadPath: null,
    revealEditorPath: null,
  }),

  openTab: (relativePath, title, type = 'note') => {
    const { openTabs } = get();
    if (!openTabs.find((t) => t.relativePath === relativePath)) {
      set({
        openTabs: [...openTabs, { relativePath, title, isDirty: false, savedHash: null, type }],
      });
    }
    set({ activeTabPath: relativePath });
  },

  closeTab: (relativePath) => {
    const { openTabs, activeTabPath } = get();
    const newTabs = openTabs.filter((t) => t.relativePath !== relativePath);
    const newActive =
      activeTabPath === relativePath
        ? newTabs.length > 0
          ? newTabs[newTabs.length - 1].relativePath
          : null
        : activeTabPath;
    set({ openTabs: newTabs, activeTabPath: newActive });
  },

  setActiveTab: (relativePath) => set({ activeTabPath: relativePath }),

  markDirty: (relativePath) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.relativePath === relativePath ? { ...t, isDirty: true } : t
      ),
    }));
  },

  markSaved: (relativePath, hash) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.relativePath === relativePath ? { ...t, isDirty: false, savedHash: hash } : t
      ),
    }));
  },

  setSavedHash: (relativePath, hash) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.relativePath === relativePath ? { ...t, savedHash: hash } : t
      ),
    }));
  },

  updateTabTitle: (relativePath, title) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.relativePath === relativePath ? { ...t, title } : t
      ),
    }));
  },

  renameTab: (oldPath, newPath, newTitle) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.relativePath === oldPath
          ? { ...t, relativePath: newPath, title: newTitle }
          : t.relativePath.startsWith(`${oldPath}/`)
          ? { ...t, relativePath: `${newPath}${t.relativePath.slice(oldPath.length)}` }
          : t
      ),
      activeTabPath:
        state.activeTabPath === oldPath
          ? newPath
          : state.activeTabPath?.startsWith(`${oldPath}/`)
          ? `${newPath}${state.activeTabPath.slice(oldPath.length)}`
          : state.activeTabPath,
    }));
  },

  reorderTabs: (fromPath, toPath, before) => {
    set((state) => {
      const tabs = [...state.openTabs];
      const fromIdx = tabs.findIndex(t => t.relativePath === fromPath);
      let   toIdx   = tabs.findIndex(t => t.relativePath === toPath);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return state;
      const [tab] = tabs.splice(fromIdx, 1);
      // Recalculate toIdx after splice
      toIdx = tabs.findIndex(t => t.relativePath === toPath);
      tabs.splice(before ? toIdx : toIdx + 1, 0, tab);
      return { openTabs: tabs };
    });
  },

  setForceReloadPath: (forceReloadPath) => set({ forceReloadPath }),
  setRevealEditorPath: (revealEditorPath) => set({ revealEditorPath }),
}),
    {
      name: 'editor-storage',
      partialize: (state) => ({
        sessionVaultPath: state.sessionVaultPath,
        openTabs: state.openTabs,
        activeTabPath: state.activeTabPath,
      }),
    }
  )
);
