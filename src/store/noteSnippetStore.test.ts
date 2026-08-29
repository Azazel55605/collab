import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../lib/tauri';

import { useNoteSnippetStore } from './noteSnippetStore';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    listNoteSnippets: vi.fn(),
    saveNoteSnippet: vi.fn(),
    deleteNoteSnippet: vi.fn(),
  },
}));

describe('noteSnippetStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNoteSnippetStore.setState({ snippets: [], isLoading: false });
  });

  it('treats the legacy missing vault-path response as an empty app-only listing', async () => {
    vi.mocked(tauriCommands.listNoteSnippets).mockRejectedValue(
      new Error('Vault path is required for vault note snippets'),
    );

    await expect(useNoteSnippetStore.getState().loadSnippets(null)).resolves.toBeUndefined();

    expect(tauriCommands.listNoteSnippets).toHaveBeenCalledWith(null);
    expect(useNoteSnippetStore.getState()).toMatchObject({ snippets: [], isLoading: false });
  });

  it('still surfaces snippet failures for local vaults', async () => {
    vi.mocked(tauriCommands.listNoteSnippets).mockRejectedValue(new Error('disk unavailable'));

    await expect(useNoteSnippetStore.getState().loadSnippets('/vault')).rejects.toThrow(
      'disk unavailable',
    );
    expect(useNoteSnippetStore.getState().isLoading).toBe(false);
  });
});
