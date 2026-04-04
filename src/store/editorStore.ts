import { create } from 'zustand';

export interface OpenTab {
  relativePath: string;
  title: string;
  isDirty: boolean;
  savedHash: string | null;
  type: 'note' | 'canvas' | 'kanban' | 'graph' | 'settings';
}

interface EditorState {
  openTabs: OpenTab[];
  activeTabPath: string | null;
  forceReloadPath: string | null;
  openTab: (relativePath: string, title: string, type?: 'note' | 'canvas' | 'kanban' | 'graph' | 'settings') => void;
  closeTab: (relativePath: string) => void;
  setActiveTab: (relativePath: string) => void;
  markDirty: (relativePath: string) => void;
  markSaved: (relativePath: string, hash: string) => void;
  setSavedHash: (relativePath: string, hash: string) => void;
  updateTabTitle: (relativePath: string, title: string) => void;
  renameTab: (oldPath: string, newPath: string, newTitle: string) => void;
  reorderTabs: (fromPath: string, toPath: string, before: boolean) => void;
  setForceReloadPath: (path: string | null) => void;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  openTabs: [],
  activeTabPath: null,
  forceReloadPath: null,

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
          : t
      ),
      activeTabPath: state.activeTabPath === oldPath ? newPath : state.activeTabPath,
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
}));
