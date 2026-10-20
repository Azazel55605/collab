import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDeferredPersistence } from '../lib/deferredPersistence';
import { runDocumentNavigation } from '../lib/documentNavigation';
import { documentSessionRetention } from '../lib/documentSessionRetention';

export interface OpenTab {
  relativePath: string;
  title: string;
  isDirty: boolean;
  savedHash: string | null;
  type:
    | 'note'
    | 'canvas'
    | 'kanban'
    | 'logic'
    | 'sheet'
    | 'ink'
    | 'deck'
    | 'graph'
    | 'settings'
    | 'image'
    | 'pdf';
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

/**
 * Per-tab drawing view state, restored when an `.ink` tab is reopened.
 *
 * Device-local by design: which page you were on and where you were zoomed are
 * properties of this editor session, not of the shared document. Persisting
 * them into `.ink` would make one person's scroll position a change every
 * collaborator has to merge.
 */
export interface InkViewState {
  pageId: string | null;
  /** Ink-unit coordinate at the top-left of the surface. */
  originX: number;
  originY: number;
  zoom: number;
}

/**
 * Per-tab presentation view state, restored when a `.deck` tab is reopened.
 * Device-local for the same reason as `InkViewState`: which slide you were on
 * and how the panels were arranged is not a change collaborators should merge.
 */
export interface DeckViewState {
  slideId: string | null;
  /** `fit`, or an explicit stage zoom factor. */
  zoom: 'fit' | number;
  slideRailOpen: boolean;
  notesOpen: boolean;
  selectedElementIds: string[];
  /** Editor aids; optional so view states saved before Phase 2 still load. */
  showRulers?: boolean;
  snapToObjects?: boolean;
  showGrid?: boolean;
  /** The design panel (Phase 3); optional for the same reason. */
  inspectorOpen?: boolean;
  /** Dedicated animation sequence pane; optional for older saved view state. */
  animationPaneOpen?: boolean;
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
  inkViewStates: Record<string, InkViewState>;
  deckViewStates: Record<string, DeckViewState>;
  setSessionVaultPath: (vaultPath: string | null) => void;
  resetSession: (vaultPath?: string | null) => void;
  openTab: (relativePath: string, title: string, type?: OpenTab['type']) => void;
  closeTab: (relativePath: string) => void;
  closeTabs: (relativePaths: string[]) => Promise<boolean>;
  removeViewStates: (relativePath: string) => void;
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
  setInkViewState: (relativePath: string, viewState: InkViewState) => void;
  setDeckViewState: (relativePath: string, viewState: DeckViewState) => void;
}

export const RECENT_VIEW_STATE_LIMIT = 128;
const viewPath = (key: string) => key.split('\0')[0];
function remapViewStates<T>(viewStates: Record<string, T>, oldPath: string, newPath: string) {
  return Object.fromEntries(
    Object.entries(viewStates).map(([key, value]) => {
      const path = viewPath(key);
      const renamed =
        path === oldPath
          ? newPath
          : path.startsWith(`${oldPath}/`)
            ? `${newPath}${path.slice(oldPath.length)}`
            : path;
      return [renamed + key.slice(path.length), value];
    }),
  );
}
function trimViewStates<T>(states: Record<string, T>, openTabs: OpenTab[]) {
  const pinned = new Set(openTabs.map((tab) => tab.relativePath));
  const entries = Object.entries(states);
  const recent = entries
    .filter(([key]) => !pinned.has(viewPath(key)))
    .slice(-RECENT_VIEW_STATE_LIMIT);
  return Object.fromEntries([...recent, ...entries.filter(([key]) => pinned.has(viewPath(key)))]);
}
function recentViewState<T extends object>(
  states: Record<string, T>,
  path: string,
  value: T,
  tabs: OpenTab[],
) {
  const previous = states[path];
  if (
    previous &&
    Object.keys(value).every((key) => {
      const a = previous[key as keyof T],
        b = value[key as keyof T];
      return (
        Object.is(a, b) ||
        (Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((v, i) => v === b[i]))
      );
    }) &&
    Object.keys(previous).length === Object.keys(value).length
  )
    return states;
  const { [path]: _old, ...rest } = states;
  return trimViewStates({ ...rest, [path]: value }, tabs);
}
type DurableEditorState = Pick<
  EditorState,
  | 'sessionVaultPath'
  | 'openTabs'
  | 'activeTabPath'
  | 'noteViewStates'
  | 'sheetViewStates'
  | 'inkViewStates'
  | 'deckViewStates'
>;
const editorPersistence = createDeferredPersistence<DurableEditorState>('editor-storage');
export const flushEditorPersistence = editorPersistence.flush;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushEditorPersistence);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEditorPersistence();
  });
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
      inkViewStates: {},
      deckViewStates: {},

      setSessionVaultPath: (sessionVaultPath) => set({ sessionVaultPath }),

      resetSession: (vaultPath = null) => {
        documentSessionRetention.clear();
        set({
          sessionVaultPath: vaultPath,
          openTabs: [],
          activeTabPath: null,
          forceReloadPath: null,
          revealEditorPath: null,
          pendingSearchJump: null,
          pendingSheetJump: null,
          noteViewStates: {},
          sheetViewStates: {},
          inkViewStates: {},
          deckViewStates: {},
        });
        flushEditorPersistence();
      },

      openTab: (relativePath, title, type = 'note') =>
        runDocumentNavigation(() => {
          const { openTabs, activeTabPath } = get();
          const exists = openTabs.some((tab) => tab.relativePath === relativePath);
          if (exists && activeTabPath === relativePath) return;
          const touch = <T>(states: Record<string, T>) =>
            Object.fromEntries([
              ...Object.entries(states).filter(([key]) => viewPath(key) !== relativePath),
              ...Object.entries(states).filter(([key]) => viewPath(key) === relativePath),
            ]);
          set({
            openTabs: exists
              ? openTabs
              : [...openTabs, { relativePath, title, isDirty: false, savedHash: null, type }],
            activeTabPath: relativePath,
            noteViewStates: touch(get().noteViewStates),
            sheetViewStates: touch(get().sheetViewStates),
            inkViewStates: touch(get().inkViewStates),
            deckViewStates: touch(get().deckViewStates),
          });
        }),

      closeTab: (relativePath) => {
        void get().closeTabs([relativePath]);
      },
      closeTabs: (relativePaths) =>
        runDocumentNavigation(() => {
          const paths = new Set(relativePaths);
          const state = get();
          const openTabs = state.openTabs.filter((tab) => !paths.has(tab.relativePath));
          if (openTabs.length === state.openTabs.length) return;
          set({
            openTabs,
            activeTabPath:
              state.activeTabPath && paths.has(state.activeTabPath)
                ? (openTabs[openTabs.length - 1]?.relativePath ?? null)
                : state.activeTabPath,
            noteViewStates: trimViewStates(state.noteViewStates, openTabs),
            sheetViewStates: trimViewStates(state.sheetViewStates, openTabs),
            inkViewStates: trimViewStates(state.inkViewStates, openTabs),
            deckViewStates: trimViewStates(state.deckViewStates, openTabs),
          });
        }),
      removeViewStates: (relativePath) => {
        const remove = <T>(states: Record<string, T>) =>
          Object.fromEntries(
            Object.entries(states).filter(
              ([key]) =>
                viewPath(key) !== relativePath && !viewPath(key).startsWith(`${relativePath}/`),
            ),
          );
        set((state) => ({
          noteViewStates: remove(state.noteViewStates),
          sheetViewStates: remove(state.sheetViewStates),
          inkViewStates: remove(state.inkViewStates),
          deckViewStates: remove(state.deckViewStates),
        }));
      },

      setActiveTab: (relativePath) =>
        runDocumentNavigation(() => set({ activeTabPath: relativePath })),

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
            t.relativePath === relativePath ? { ...t, title } : t,
          ),
        }));
      },

      renameTab: (oldPath, newPath, newTitle) => {
        documentSessionRetention.clear();
        set((state) => ({
          openTabs: state.openTabs.map((t) =>
            t.relativePath === oldPath
              ? { ...t, relativePath: newPath, title: newTitle }
              : t.relativePath.startsWith(`${oldPath}/`)
                ? { ...t, relativePath: `${newPath}${t.relativePath.slice(oldPath.length)}` }
                : t,
          ),
          activeTabPath:
            state.activeTabPath === oldPath
              ? newPath
              : state.activeTabPath?.startsWith(`${oldPath}/`)
                ? `${newPath}${state.activeTabPath.slice(oldPath.length)}`
                : state.activeTabPath,
          noteViewStates: remapViewStates(state.noteViewStates, oldPath, newPath),
          sheetViewStates: remapViewStates(state.sheetViewStates, oldPath, newPath),
          inkViewStates: remapViewStates(state.inkViewStates, oldPath, newPath),
          deckViewStates: remapViewStates(state.deckViewStates, oldPath, newPath),
        }));
      },

      reorderTabs: (fromPath, toPath, before) => {
        set((state) => {
          const tabs = [...state.openTabs];
          const fromIdx = tabs.findIndex((t) => t.relativePath === fromPath);
          let toIdx = tabs.findIndex((t) => t.relativePath === toPath);
          if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return state;
          const [tab] = tabs.splice(fromIdx, 1);
          // Recalculate toIdx after splice
          toIdx = tabs.findIndex((t) => t.relativePath === toPath);
          tabs.splice(before ? toIdx : toIdx + 1, 0, tab);
          return { openTabs: tabs };
        });
      },

      setForceReloadPath: (forceReloadPath) => set({ forceReloadPath }),
      setRevealEditorPath: (revealEditorPath) => set({ revealEditorPath }),
      setPendingSearchJump: (pendingSearchJump) => set({ pendingSearchJump }),
      setPendingSheetJump: (pendingSheetJump) => set({ pendingSheetJump }),
      setNoteViewState: (relativePath, viewState) =>
        set((state) => {
          const next = recentViewState(
            state.noteViewStates,
            relativePath,
            viewState,
            state.openTabs,
          );
          return next === state.noteViewStates ? state : { noteViewStates: next };
        }),

      setSheetViewState: (relativePath, viewState) =>
        set((state) => {
          const next = recentViewState(
            state.sheetViewStates,
            relativePath,
            viewState,
            state.openTabs,
          );
          return next === state.sheetViewStates ? state : { sheetViewStates: next };
        }),

      setInkViewState: (relativePath, viewState) =>
        set((state) => {
          const next = recentViewState(
            state.inkViewStates,
            relativePath,
            viewState,
            state.openTabs,
          );
          return next === state.inkViewStates ? state : { inkViewStates: next };
        }),

      setDeckViewState: (relativePath, viewState) =>
        set((state) => {
          const next = recentViewState(
            state.deckViewStates,
            relativePath,
            viewState,
            state.openTabs,
          );
          return next === state.deckViewStates ? state : { deckViewStates: next };
        }),
    }),
    {
      name: 'editor-storage',
      storage: editorPersistence.storage,
      merge: (persisted, current) => {
        const restored = { ...current, ...(persisted as Partial<DurableEditorState>) };
        return {
          ...restored,
          noteViewStates: trimViewStates(restored.noteViewStates, restored.openTabs),
          sheetViewStates: trimViewStates(restored.sheetViewStates, restored.openTabs),
          inkViewStates: trimViewStates(restored.inkViewStates, restored.openTabs),
          deckViewStates: trimViewStates(restored.deckViewStates, restored.openTabs),
        };
      },
      partialize: (state) => ({
        sessionVaultPath: state.sessionVaultPath,
        openTabs: state.openTabs,
        activeTabPath: state.activeTabPath,
        noteViewStates: state.noteViewStates,
        sheetViewStates: state.sheetViewStates,
        inkViewStates: state.inkViewStates,
        deckViewStates: state.deckViewStates,
      }),
    },
  ),
);
