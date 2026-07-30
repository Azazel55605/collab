import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface OpenTab {
  relativePath: string;
  title: string;
  isDirty: boolean;
  savedHash: string | null;
  type: 'note' | 'canvas' | 'kanban' | 'logic' | 'sheet' | 'graph' | 'settings' | 'image' | 'pdf';
}

export interface NoteEditorViewState {
  scrollTop: number;
  selectionAnchor: number;
  selectionHead: number;
}

/** Per-tab spreadsheet view state, restored when a `.sheet` tab is reopened. */
export interface SheetViewState {
  activeWorksheetId: string | null;
  scrollTop: number;
  scrollLeft: number;
  activeRow: number;
  activeColumn: number;
}

export interface PendingSearchJump {
  relativePath: string;
  query: string;
}

export interface PendingSheetJump {
  relativePath: string;
  range: string;
}

interface EditorState {
  sessionVaultPath: string | null;
  openTabs: OpenTab[];
  activeTabPath: string | null;
  forceReloadPath: string | null;
  revealEditorPath: string | null;
  pendingSearchJump: PendingSearchJump | null;
  pendingSheetJump: PendingSheetJump | null;
  noteViewStates: Record<string, NoteEditorViewState>;
  sheetViewStates: Record<string, SheetViewState>;
  setSessionVaultPath: (vaultPath: string | null) => void;
  resetSession: (vaultPath?: string | null) => void;
  openTab: (relativePath: string, title: string, type?: OpenTab['type']) => void;
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
  setPendingSearchJump: (target: PendingSearchJump | null) => void;
  setPendingSheetJump: (target: PendingSheetJump | null) => void;
  setNoteViewState: (relativePath: string, viewState: NoteEditorViewState) => void;
  setSheetViewState: (relativePath: string, viewState: SheetViewState) => void;
}

function remapViewStates<T>(
  viewStates: Record<string, T>,
  oldPath: string,
  newPath: string,
) {
  return Object.fromEntries(
    Object.entries(viewStates).map(([path, viewState]) => [
      path === oldPath
        ? newPath
        : path.startsWith(`${oldPath}/`)
        ? `${newPath}${path.slice(oldPath.length)}`
        : path,
      viewState,
    ]),
  );
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set, get) => ({
  sessionVaultPath: null,
  openTabs: [],
  activeTabPath: null,
  forceReloadPath: null,
  revealEditorPath: null,
  pendingSearchJump: null,
  pendingSheetJump: null,
  noteViewStates: {},
  sheetViewStates: {},

  setSessionVaultPath: (sessionVaultPath) => set({ sessionVaultPath }),

  resetSession: (vaultPath = null) => set({
    sessionVaultPath: vaultPath,
    openTabs: [],
    activeTabPath: null,
    forceReloadPath: null,
    revealEditorPath: null,
    pendingSearchJump: null,
    pendingSheetJump: null,
    noteViewStates: {},
    sheetViewStates: {},
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
    set((state) => {
      let changed = false;
      const openTabs = state.openTabs.map((tab) => {
        if (tab.relativePath !== relativePath || tab.isDirty) return tab;
        changed = true;
        return { ...tab, isDirty: true };
      });
      return changed ? { openTabs } : state;
    });
  },

  markSaved: (relativePath, hash) => {
    set((state) => {
      let changed = false;
      const openTabs = state.openTabs.map((tab) => {
        if (tab.relativePath !== relativePath) return tab;
        if (!tab.isDirty && tab.savedHash === hash) return tab;
        changed = true;
        return { ...tab, isDirty: false, savedHash: hash };
      });
      return changed ? { openTabs } : state;
    });
  },

  setSavedHash: (relativePath, hash) => {
    set((state) => {
      let changed = false;
      const openTabs = state.openTabs.map((tab) => {
        if (tab.relativePath !== relativePath || tab.savedHash === hash) return tab;
        changed = true;
        return { ...tab, savedHash: hash };
      });
      return changed ? { openTabs } : state;
    });
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
      noteViewStates: remapViewStates(state.noteViewStates, oldPath, newPath),
      sheetViewStates: remapViewStates(state.sheetViewStates, oldPath, newPath),
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
  setPendingSearchJump: (pendingSearchJump) => set({ pendingSearchJump }),
  setPendingSheetJump: (pendingSheetJump) => set({ pendingSheetJump }),
  setNoteViewState: (relativePath, viewState) => set((state) => ({
    noteViewStates: {
      ...state.noteViewStates,
      [relativePath]: viewState,
    },
  })),

  setSheetViewState: (relativePath, viewState) => set((state) => ({
    sheetViewStates: {
      ...state.sheetViewStates,
      [relativePath]: viewState,
    },
  })),
}),
    {
      name: 'editor-storage',
      partialize: (state) => ({
        sessionVaultPath: state.sessionVaultPath,
        openTabs: state.openTabs,
        activeTabPath: state.activeTabPath,
        noteViewStates: state.noteViewStates,
        sheetViewStates: state.sheetViewStates,
      }),
    }
  )
);
