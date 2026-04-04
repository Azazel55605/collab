import { create } from 'zustand';
import type { KanbanCard } from '../types/kanban';

/**
 * Tracks which Kanban card is currently being edited, including its in-progress
 * draft. Stored outside KanbanPage so state survives view switches — when the
 * user navigates away and returns, the card dialog reopens exactly as they left it.
 */
interface KanbanStore {
  boardPath:  string | null;
  cardId:     string | null;
  columnId:   string | null;
  draft:      KanbanCard | null;

  setEditing:   (boardPath: string, cardId: string, columnId: string, draft: KanbanCard) => void;
  updateDraft:  (draft: KanbanCard) => void;
  clearEditing: () => void;
}

export const useKanbanStore = create<KanbanStore>((set) => ({
  boardPath:  null,
  cardId:     null,
  columnId:   null,
  draft:      null,

  setEditing: (boardPath, cardId, columnId, draft) =>
    set({ boardPath, cardId, columnId, draft }),

  updateDraft: (draft) => set({ draft }),

  clearEditing: () => set({ boardPath: null, cardId: null, columnId: null, draft: null }),
}));
