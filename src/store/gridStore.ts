import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ─── Layout definitions ───────────────────────────────────────────────────────

export type GridLayoutId =
  | 'single'
  | 'split-h'
  | 'split-v'
  | '2x2'
  | 'cols-3'
  | 'cols-4'
  | 'main-side'
  | 'side-main';

export type CellContentType = 'empty' | 'note' | 'graph' | 'canvas' | 'kanban' | 'settings';

export interface GridCellContent {
  type: CellContentType;
  relativePath: string | null;
  title: string;
}

export interface GridCell {
  id: string;
  content: GridCellContent;
}

export interface LayoutDef {
  id: GridLayoutId;
  label: string;
  cellCount: number;
  colTemplate: string;
  rowTemplate: string;
  minWidth: number;
}

export const GRID_LAYOUTS: Record<GridLayoutId, LayoutDef> = {
  single:      { id: 'single',     label: '1 Panel',        cellCount: 1, colTemplate: '1fr',               rowTemplate: '1fr',     minWidth: 0    },
  'split-v':   { id: 'split-v',    label: '2 Rows',         cellCount: 2, colTemplate: '1fr',               rowTemplate: '1fr 1fr', minWidth: 0    },
  'split-h':   { id: 'split-h',    label: '2 Columns',      cellCount: 2, colTemplate: '1fr 1fr',           rowTemplate: '1fr',     minWidth: 560  },
  'main-side': { id: 'main-side',  label: 'Main + Sidebar', cellCount: 2, colTemplate: '2fr 1fr',           rowTemplate: '1fr',     minWidth: 560  },
  'side-main': { id: 'side-main',  label: 'Sidebar + Main', cellCount: 2, colTemplate: '1fr 2fr',           rowTemplate: '1fr',     minWidth: 560  },
  '2x2':       { id: '2x2',        label: '2×2 Grid',       cellCount: 4, colTemplate: '1fr 1fr',           rowTemplate: '1fr 1fr', minWidth: 560  },
  'cols-3':    { id: 'cols-3',     label: '3 Columns',      cellCount: 3, colTemplate: '1fr 1fr 1fr',       rowTemplate: '1fr',     minWidth: 840  },
  'cols-4':    { id: 'cols-4',     label: '4 Columns',      cellCount: 4, colTemplate: '1fr 1fr 1fr 1fr',   rowTemplate: '1fr',     minWidth: 1100 },
};

export const LAYOUT_ORDER: GridLayoutId[] = [
  'single', 'split-v', 'split-h', 'main-side', 'side-main', '2x2', 'cols-3', 'cols-4',
];

// ─── Workspace model ──────────────────────────────────────────────────────────

export interface GridWorkspace {
  id: string;
  name: string;
  layoutId: GridLayoutId;
  cells: GridCell[];
}

const MAX_CELLS = 4;

export const emptyCell = (id: string): GridCell => ({
  id,
  content: { type: 'empty', relativePath: null, title: '' },
});

const makeId = () => Math.random().toString(36).slice(2, 9);

const makeWorkspace = (name: string, id?: string): GridWorkspace => {
  const wsId = id ?? makeId();
  return {
    id: wsId,
    name,
    layoutId: 'split-h',
    cells: Array.from({ length: MAX_CELLS }, (_, i) => emptyCell(`${wsId}-c${i}`)),
  };
};

// ─── Store ────────────────────────────────────────────────────────────────────

interface GridState {
  workspaces: GridWorkspace[];
  activeWorkspaceId: string;

  // Workspace management
  createWorkspace: (name?: string) => string;
  deleteWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setActiveWorkspace: (id: string) => void;

  // Cell operations (act on the active workspace)
  setLayout: (layoutId: GridLayoutId) => void;
  setCellContent: (cellId: string, content: GridCellContent) => void;
  swapCells: (id1: string, id2: string) => void;
  reorderCells: (newOrder: string[]) => void;
  clearCell: (cellId: string) => void;

  /** Called when a tab is dragged onto an edge split zone. Sets up the active
   *  workspace to show a 2-panel split and switches to grid view. */
  activateSplit: (
    draggedContent: GridCellContent,
    currentContent: GridCellContent,
    direction: 'left' | 'right' | 'top' | 'bottom'
  ) => void;
}

/** Selector — always returns a valid workspace */
export const selectActiveWorkspace = (s: GridState): GridWorkspace =>
  s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0];

const DEFAULT_WS = makeWorkspace('Workspace 1', 'default');

export const useGridStore = create<GridState>()(
  persist(
    (set, get) => ({
      workspaces: [DEFAULT_WS],
      activeWorkspaceId: DEFAULT_WS.id,

      createWorkspace: (name) => {
        const count = get().workspaces.length + 1;
        const ws = makeWorkspace(name ?? `Workspace ${count}`);
        set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }));
        return ws.id;
      },

      deleteWorkspace: (id) =>
        set((s) => {
          if (s.workspaces.length <= 1) return s;
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          const activeWorkspaceId =
            s.activeWorkspaceId === id ? workspaces[workspaces.length - 1].id : s.activeWorkspaceId;
          return { workspaces, activeWorkspaceId };
        }),

      renameWorkspace: (id, name) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
        })),

      setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

      setLayout: (layoutId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === s.activeWorkspaceId ? { ...w, layoutId } : w
          ),
        })),

      setCellContent: (cellId, content) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === s.activeWorkspaceId
              ? { ...w, cells: w.cells.map((c) => (c.id === cellId ? { ...c, content } : c)) }
              : w
          ),
        })),

      swapCells: (id1, id2) =>
        set((s) => {
          const ws = selectActiveWorkspace(s);
          const c1 = ws.cells.find((c) => c.id === id1);
          const c2 = ws.cells.find((c) => c.id === id2);
          if (!c1 || !c2) return s;
          return {
            workspaces: s.workspaces.map((w) =>
              w.id === s.activeWorkspaceId
                ? {
                    ...w,
                    cells: w.cells.map((c) => {
                      if (c.id === id1) return { ...c, content: c2.content };
                      if (c.id === id2) return { ...c, content: c1.content };
                      return c;
                    }),
                  }
                : w
            ),
          };
        }),

      reorderCells: (newOrder) =>
        set((s) => {
          const ws = selectActiveWorkspace(s);
          const cellMap = Object.fromEntries(ws.cells.map((c) => [c.id, c]));
          const reordered = newOrder.map((id) => cellMap[id]).filter(Boolean);
          // Preserve any cells not in newOrder at the end
          const remaining = ws.cells.filter((c) => !newOrder.includes(c.id));
          return {
            workspaces: s.workspaces.map((w) =>
              w.id === s.activeWorkspaceId
                ? { ...w, cells: [...reordered, ...remaining] }
                : w
            ),
          };
        }),

      clearCell: (cellId) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === s.activeWorkspaceId
              ? { ...w, cells: w.cells.map((c) => (c.id === cellId ? emptyCell(cellId) : c)) }
              : w
          ),
        })),

      activateSplit: (draggedContent, currentContent, direction) =>
        set((s) => {
          const ws = selectActiveWorkspace(s);
          const layout: GridLayoutId =
            direction === 'top' || direction === 'bottom' ? 'split-v' : 'split-h';

          // direction determines which side the dragged tab lands on
          const [first, second] =
            direction === 'left' || direction === 'top'
              ? [draggedContent, currentContent]
              : [currentContent, draggedContent];

          const newCells = ws.cells.map((c, i) => {
            if (i === 0) return { ...c, content: first };
            if (i === 1) return { ...c, content: second };
            return emptyCell(c.id);
          });

          return {
            workspaces: s.workspaces.map((w) =>
              w.id === s.activeWorkspaceId ? { ...w, layoutId: layout, cells: newCells } : w
            ),
          };
        }),
    }),
    { name: 'grid-storage-v2' }
  )
);
