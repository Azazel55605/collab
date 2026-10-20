import { create } from 'zustand';

import type { NoteIndexDelta, NoteMetadata } from '../types/note';

interface NoteIndexState {
  notes: NoteMetadata[];
  isIndexing: boolean;
  indexedCount: number;
  applyDelta: (delta: NoteIndexDelta) => void;
  setNotes: (notes: NoteMetadata[]) => void;
  updateNote: (relativePath: string, meta: NoteMetadata) => void;
  removeNote: (relativePath: string) => void;
  setIndexing: (v: boolean) => void;
}

export const useNoteIndexStore = create<NoteIndexState>()((set) => ({
  notes: [],
  applyDelta: ({ upserted, removed, reconciledPaths = [] }) =>
    set((state) => {
      const updates = new Map(upserted.map((note) => [note.relativePath, note]));
      const deleted = new Set(removed);
      const notes = state.notes
        .filter(
          (note) =>
            updates.has(note.relativePath) ||
            (!deleted.has(note.relativePath) &&
              !reconciledPaths.some(
                (path) => note.relativePath === path || note.relativePath.startsWith(`${path}/`),
              )),
        )
        .map((note) => {
          const next = updates.get(note.relativePath);
          updates.delete(note.relativePath);
          return next ?? note;
        });
      return { notes: [...notes, ...updates.values()] };
    }),
  isIndexing: false,
  indexedCount: 0,
  setNotes: (notes) => set({ notes }),
  updateNote: (relativePath, meta) =>
    set((state) => ({
      notes: state.notes.find((n) => n.relativePath === relativePath)
        ? state.notes.map((n) => (n.relativePath === relativePath ? meta : n))
        : [...state.notes, meta],
    })),
  removeNote: (relativePath) =>
    set((state) => ({ notes: state.notes.filter((n) => n.relativePath !== relativePath) })),
  setIndexing: (isIndexing) => set({ isIndexing, indexedCount: 0 }),
}));
