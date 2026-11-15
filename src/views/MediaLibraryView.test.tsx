import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMediaResources } from '../lib/mediaLifecycle';
import { mediaFileVersion, rememberMediaResume } from '../lib/mediaResume';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type { NoteFile, VaultMeta } from '../types/vault';

import MediaLibraryView from './MediaLibraryView';

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('../lib/libraryMediaPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/libraryMediaPreview')>()),
  loadLibraryMediaDetails: preview,
  canPreviewInGallery: () => false,
}));

function file(relativePath: string): NoteFile {
  return {
    relativePath,
    name: relativePath.split('/').pop()!,
    extension: relativePath.split('.').pop()!,
    modifiedAt: 1,
    size: 42,
    isFolder: false,
  };
}

const vault: VaultMeta = {
  id: 'media-vault',
  path: '/media-vault',
  name: 'Fixtures',
  lastOpened: 0,
  isEncrypted: false,
};
const clip = file('Trips/Berlin.webm');
const tree = [
  clip,
  file('Trips/Map.svg'),
  file('Cover.png'),
  file('Music/Song.flac'),
  file('Notes.md'),
  file('Song.lrc'),
];

beforeEach(() => {
  clearMediaResources();
  localStorage.clear();
  preview.mockReset();
  useVaultStore.setState({ vault, fileTree: tree, isVaultLocked: false });
  useUiStore.setState({ activeView: 'media' });
  useEditorStore.setState({ openTabs: [], activeTabPath: null });
});

describe('MediaLibraryView', () => {
  it('filters and groups indexed files, and opens the existing tab for a selection', async () => {
    render(<MediaLibraryView />);
    expect(screen.getByText('4 files')).toBeTruthy();
    expect(screen.queryByText('Notes.md')).toBeNull();
    expect(screen.queryByText('Song.lrc')).toBeNull();
    expect(preview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'List layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Group by folder' }));
    const trips = screen.getByRole('region', { name: 'Trips' });
    expect(within(trips).getByText('Map.svg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Videos' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'trips/berlin' } });
    expect(await screen.findByText('1 file')).toBeTruthy();
    expect(screen.queryByText('Map.svg')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Berlin.webm' }));
    expect(useUiStore.getState().activeView).toBe('editor');
    fireEvent.click(screen.getByRole('button', { name: 'Open Berlin.webm' }));
    expect(useEditorStore.getState().openTabs).toMatchObject([
      { relativePath: clip.relativePath, type: 'media' },
    ]);
  });

  it('loads a preview only on request and cancels it when the vault locks', async () => {
    preview.mockImplementation(() => new Promise(() => {}));
    render(<MediaLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview Berlin.webm' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const signal = preview.mock.calls[0][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => useVaultStore.setState({ isVaultLocked: true }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Unlock the vault to browse media.')).toBeTruthy();
  });

  it('shows an unfinished playback position until the indexed revision changes', () => {
    rememberMediaResume(vault, clip.relativePath, {
      revision: 'first',
      position: 30,
      duration: 100,
      fileVersion: mediaFileVersion(clip),
      rate: 1,
      volume: 1,
      muted: false,
      caption: 'off',
      captionPath: null,
      audio: '0',
      compatibility: false,
      isolatedAudio: null,
    });
    render(<MediaLibraryView />);
    const section = screen.getByRole('region', { name: 'Continue watching and listening' });
    expect(within(section).getByText('0:30 / 1:40')).toBeTruthy();
    act(() => useVaultStore.setState({ fileTree: [{ ...clip, modifiedAt: 2 }, ...tree.slice(1)] }));
    expect(screen.queryByRole('region', { name: 'Continue watching and listening' })).toBeNull();
  });

  it('saves a queue as a playlist, clears the session on lock and reloads it without opening a player', async () => {
    preview.mockImplementation(() => new Promise(() => {}));
    render(<MediaLibraryView />);
    for (const name of ['Berlin.webm', 'Song.flac']) {
      fireEvent.click(screen.getByRole('button', { name: `Add ${name} to queue` }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Move Music/Song.flac up' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Playlist name' }), {
      target: { value: 'Trip' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save playlist' }));
    act(() => useVaultStore.setState({ isVaultLocked: true }));
    act(() => useVaultStore.setState({ isVaultLocked: false }));
    expect(screen.queryByRole('button', { name: 'Play Music/Song.flac' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Trip' }));
    const queue = screen.getByRole('region', { name: 'Playback queue' });
    expect(within(queue).getAllByRole('listitem')[0].textContent).toContain('Music/Song.flac');
    expect(useEditorStore.getState().openTabs).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Play Trips/Berlin.webm' }));
    await waitFor(() => expect(useEditorStore.getState().activeTabPath).toBe(clip.relativePath));
  });
});
