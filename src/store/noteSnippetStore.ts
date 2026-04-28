import { create } from 'zustand';

import { tauriCommands } from '../lib/tauri';
import type { NoteSnippet, NoteSnippetDraft } from '../types/noteSnippet';

interface NoteSnippetState {
  snippets: NoteSnippet[];
  isLoading: boolean;
  loadSnippets: (vaultPath?: string | null) => Promise<void>;
  saveSnippet: (vaultPath: string | null | undefined, snippet: NoteSnippetDraft) => Promise<NoteSnippet>;
  deleteSnippet: (vaultPath: string | null | undefined, snippet: NoteSnippet) => Promise<void>;
}

export const useNoteSnippetStore = create<NoteSnippetState>((set) => ({
  snippets: [],
  isLoading: false,
  async loadSnippets(vaultPath) {
    set({ isLoading: true });
    try {
      const snippets = await tauriCommands.listNoteSnippets(vaultPath ?? null);
      set({ snippets });
    } finally {
      set({ isLoading: false });
    }
  },
  async saveSnippet(vaultPath, snippet) {
    const saved = await tauriCommands.saveNoteSnippet(vaultPath ?? null, snippet);
    set((state) => {
      const next = state.snippets.filter((entry) => entry.id !== saved.id);
      next.push(saved);
      next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return { snippets: next };
    });
    return saved;
  },
  async deleteSnippet(vaultPath, snippet) {
    await tauriCommands.deleteNoteSnippet(vaultPath ?? null, snippet.scope, snippet.id);
    set((state) => ({
      snippets: state.snippets.filter((entry) => entry.id !== snippet.id),
    }));
  },
}));
