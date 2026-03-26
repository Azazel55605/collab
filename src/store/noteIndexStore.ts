import { create } from 'zustand';
import type { NoteMetadata } from '../types/note';

interface NoteIndexState {
  notes: NoteMetadata[];
  isIndexing: boolean;
  setNotes: (notes: NoteMetadata[]) => void;
  updateNote: (relativePath: string, meta: NoteMetadata) => void;
  removeNote: (relativePath: string) => void;
  setIndexing: (v: boolean) => void;
}

export const useNoteIndexStore = create<NoteIndexState>()((set) => ({
  notes: [],
  isIndexing: false,
  setNotes: (notes) => set({ notes }),
  updateNote: (relativePath, meta) =>
    set((state) => ({
      notes: state.notes.find((n) => n.relativePath === relativePath)
        ? state.notes.map((n) => (n.relativePath === relativePath ? meta : n))
        : [...state.notes, meta],
    })),
  removeNote: (relativePath) =>
    set((state) => ({ notes: state.notes.filter((n) => n.relativePath !== relativePath) })),
  setIndexing: (isIndexing) => set({ isIndexing }),
}));
