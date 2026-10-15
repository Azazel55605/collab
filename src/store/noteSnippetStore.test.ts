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
  const snippet = (name: string) => ({
    id: name,
    name,
    scope: 'vault' as const,
    body: name,
    updatedAt: 1,
  });
  it('ignores reversed vault listing responses and obsolete loading completions', async () => {
    let finishA!: (value: ReturnType<typeof snippet>[]) => void;
    let finishB!: (value: ReturnType<typeof snippet>[]) => void;
    vi.mocked(tauriCommands.listNoteSnippets)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishB = resolve;
          }),
      );
    const a = useNoteSnippetStore.getState().loadSnippets('/A');
    const b = useNoteSnippetStore.getState().loadSnippets('/B');
    finishA([snippet('a')]);
    await a;
    expect(useNoteSnippetStore.getState()).toMatchObject({ snippets: [], isLoading: true });
    finishB([snippet('b')]);
    await b;
    expect(useNoteSnippetStore.getState().snippets).toEqual([snippet('b')]);
  });
  it('does not insert a delayed save into a different vault scope', async () => {
    vi.mocked(tauriCommands.listNoteSnippets).mockResolvedValue([]);
    await useNoteSnippetStore.getState().loadSnippets('/A');
    let finish!: (value: ReturnType<typeof snippet>) => void;
    vi.mocked(tauriCommands.saveNoteSnippet).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = useNoteSnippetStore.getState().saveSnippet('/A', snippet('a'));
    await useNoteSnippetStore.getState().loadSnippets('/B');
    finish(snippet('a'));
    await saving;
    expect(useNoteSnippetStore.getState().snippets).toEqual([]);
  });
  it('does not let a stale listing replace a completed mutation', async () => {
    vi.mocked(tauriCommands.listNoteSnippets).mockResolvedValue([]);
    await useNoteSnippetStore.getState().loadSnippets('/A');
    let finish!: (value: ReturnType<typeof snippet>[]) => void;
    vi.mocked(tauriCommands.listNoteSnippets).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const listing = useNoteSnippetStore.getState().loadSnippets('/A');
    vi.mocked(tauriCommands.saveNoteSnippet).mockResolvedValue(snippet('new'));
    await useNoteSnippetStore.getState().saveSnippet('/A', snippet('new'));
    finish([snippet('old')]);
    await listing;
    expect(useNoteSnippetStore.getState()).toMatchObject({
      snippets: [snippet('new')],
      isLoading: false,
    });
  });
  it('keeps app and vault snippets with the same id separate', async () => {
    const local = snippet('same');
    const app = { ...local, scope: 'app' as const };
    vi.mocked(tauriCommands.listNoteSnippets).mockResolvedValue([local, app]);
    await useNoteSnippetStore.getState().loadSnippets('/A');
    vi.mocked(tauriCommands.saveNoteSnippet).mockResolvedValue({ ...app, name: 'edited app' });
    await useNoteSnippetStore.getState().saveSnippet('/A', app);
    expect(useNoteSnippetStore.getState().snippets).toContainEqual(local);
    vi.mocked(tauriCommands.deleteNoteSnippet).mockResolvedValue(undefined);
    await useNoteSnippetStore.getState().deleteSnippet('/A', app);
    expect(useNoteSnippetStore.getState().snippets).toEqual([local]);
  });
});
