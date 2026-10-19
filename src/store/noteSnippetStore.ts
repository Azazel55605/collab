import { create } from 'zustand';

import { tauriCommands } from '../lib/tauri';
import type { NoteSnippet, NoteSnippetDraft } from '../types/noteSnippet';

interface NoteSnippetState {
  snippets: NoteSnippet[];
  isLoading: boolean;
  loadSnippets: (vaultPath?: string | null) => Promise<void>;
  saveSnippet: (
    vaultPath: string | null | undefined,
    snippet: NoteSnippetDraft,
  ) => Promise<NoteSnippet>;
  deleteSnippet: (vaultPath: string | null | undefined, snippet: NoteSnippet) => Promise<void>;
}

let activeScope: string | null | undefined;
let scopeEpoch = 0;
let loadRequest = 0;

export const useNoteSnippetStore = create<NoteSnippetState>((set) => ({
  snippets: [],
  isLoading: false,
  async loadSnippets(vaultPath) {
    const scope = vaultPath ?? null;
    if (activeScope !== scope) {
      activeScope = scope;
      scopeEpoch++;
      set({ snippets: [] });
    }
    const request = ++loadRequest;
    const current = () => request === loadRequest && activeScope === scope;
    set({ isLoading: true });
    try {
      const snippets = await tauriCommands.listNoteSnippets(vaultPath ?? null);
      if (current()) set({ snippets });
    } catch (error) {
      // Hosted vaults intentionally request app-scoped snippets without a
      // filesystem path. Older native backends rejected that app-only listing
      // while trying to resolve the unavailable vault scope.
      if (
        vaultPath == null &&
        String(error).includes('Vault path is required for vault note snippets')
      ) {
        if (current()) set({ snippets: [] });
        return;
      }
      if (current()) throw error;
    } finally {
      if (current()) set({ isLoading: false });
    }
  },
  async saveSnippet(vaultPath, snippet) {
    const scope = vaultPath ?? null;
    const epoch = scopeEpoch;
    const saved = await tauriCommands.saveNoteSnippet(scope, snippet);
    if (activeScope !== scope || epoch !== scopeEpoch) return saved;
    loadRequest++;
    set((state) => {
      const next = state.snippets.filter(
        (entry) => entry.id !== saved.id || entry.scope !== saved.scope,
      );
      next.push(saved);
      next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return { snippets: next, isLoading: false };
    });
    return saved;
  },
  async deleteSnippet(vaultPath, snippet) {
    const scope = vaultPath ?? null;
    const epoch = scopeEpoch;
    await tauriCommands.deleteNoteSnippet(scope, snippet.scope, snippet.id);
    if (activeScope !== scope || epoch !== scopeEpoch) return;
    loadRequest++;
    set((state) => ({
      snippets: state.snippets.filter(
        (entry) => entry.id !== snippet.id || entry.scope !== snippet.scope,
      ),
      isLoading: false,
    }));
  },
}));
