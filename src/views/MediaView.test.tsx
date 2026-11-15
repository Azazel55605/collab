import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearMediaResources } from '../lib/mediaLifecycle';
import { mediaFileVersion, readMediaResume, rememberMediaResume } from '../lib/mediaResume';
import { tauriCommands } from '../lib/tauri';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

import MediaView from './MediaView';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    openLocalPlayback: vi.fn(),
    openHostedPlayback: vi.fn(),
    downloadHostedPlayback: vi.fn(),
    hostedVaultRequest: vi.fn(),
    clearHostedPlayback: vi.fn(),

    checkLocalPlayback: vi.fn(),
    closeLocalPlayback: vi.fn(),
    openMediaExternally: vi.fn(),
    enterMediaFullscreen: vi.fn(),
  },
}));
vi.mock('../lib/nativeSubscription', () => ({ listenSafely: () => () => {} }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const emptyTrackList = () =>
  Object.assign(new EventTarget(), { length: 0 }) as unknown as TextTrackList;

const prototype = HTMLMediaElement.prototype;
const original = {
  play: prototype.play,
  pause: prototype.pause,
  load: prototype.load,
  textTracks: Object.getOwnPropertyDescriptor(prototype, 'textTracks'),
  audioTracks: Object.getOwnPropertyDescriptor(prototype, 'audioTracks'),
  duration: Object.getOwnPropertyDescriptor(prototype, 'duration'),
};

beforeAll(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  Element.prototype.scrollTo ??= vi.fn();
  prototype.play = vi.fn(async () => {});
  prototype.pause = vi.fn();
  prototype.load = vi.fn();
  Object.defineProperty(prototype, 'textTracks', { configurable: true, get: emptyTrackList });
  Object.defineProperty(prototype, 'audioTracks', { configurable: true, get: emptyTrackList });
  Object.defineProperty(prototype, 'duration', { configurable: true, get: () => 120 });
});

afterAll(() => {
  vi.unstubAllGlobals();
  prototype.play = original.play;
  prototype.pause = original.pause;
  prototype.load = original.load;
  if (original.textTracks) Object.defineProperty(prototype, 'textTracks', original.textTracks);
  if (original.audioTracks) Object.defineProperty(prototype, 'audioTracks', original.audioTracks);
  else delete (prototype as { audioTracks?: unknown }).audioTracks;
  if (original.duration) Object.defineProperty(prototype, 'duration', original.duration);
});

function source(extra: Record<string, unknown> = {}) {
  return {
    id: 'playback-1',
    url: 'http://media.test/1',
    revision: 'r1',
    captions: [],
    audioTracks: [],
    ...extra,
  };
}

async function loadMetadata(selector: 'video' | 'audio') {
  const media = await waitFor(() => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`no ${selector}`);
    return element;
  });
  act(() => {
    fireEvent.loadedMetadata(media);
  });
  return media as HTMLMediaElement;
}

describe('MediaView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriCommands.openLocalPlayback).mockReset();
    localStorage.clear();
    clearMediaResources();
    useUiStore.getState().setRememberMediaOnRestart(true);
    vi.mocked(tauriCommands.checkLocalPlayback).mockResolvedValue(undefined);
    vi.mocked(tauriCommands.closeLocalPlayback).mockResolvedValue(undefined);
    vi.mocked(tauriCommands.clearHostedPlayback).mockResolvedValue(undefined);
    vi.mocked(tauriCommands.openMediaExternally).mockResolvedValue(undefined);
    useVaultStore.setState({
      vault: { id: 'v', name: 'Vault', path: '/vault', lastOpened: 0, isEncrypted: false },
      isVaultLocked: false,
      fileTree: [],
    });
  });

  it('pauses a hidden tab and keeps the same playback session and position when shown again', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValueOnce(source());
    const { rerender } = render(<MediaView relativePath="clip.webm" />);
    const media = await loadMetadata('video');
    Object.defineProperty(media, 'paused', { get: () => false });
    media.currentTime = 42;
    fireEvent.timeUpdate(media);
    rerender(<MediaView relativePath="clip.webm" visible={false} />);
    expect(prototype.pause).toHaveBeenCalledOnce();
    expect(tauriCommands.closeLocalPlayback).not.toHaveBeenCalled();

    rerender(<MediaView relativePath="clip.webm" />);
    expect(document.querySelector('video')).toBe(media);
    expect(media.currentTime).toBe(42);
    expect(tauriCommands.openLocalPlayback).toHaveBeenCalledOnce();
    expect(prototype.play).not.toHaveBeenCalled();
  });

  it('keeps a keyboard seek synchronized with playback and resumes on tab reopen', async () => {
    vi.mocked(tauriCommands.openLocalPlayback)
      .mockResolvedValueOnce(source())
      .mockResolvedValueOnce(source({ id: 'reopened' }));
    const first = render(<MediaView relativePath="clip.webm" />);
    const media = await loadMetadata('video');
    const timeline = screen.getByRole('slider', { name: 'Playback position' });
    fireEvent.keyDown(timeline, { key: 'End' });
    expect(media.currentTime).toBe(120);
    media.currentTime = 42;
    fireEvent.timeUpdate(media);
    expect(timeline.getAttribute('aria-valuetext')).toBe('0:42 of 2:00');

    first.unmount();
    expect(tauriCommands.closeLocalPlayback).toHaveBeenCalledWith('playback-1');
    render(<MediaView relativePath="clip.webm" />);
    const reopened = await loadMetadata('video');
    expect(reopened.currentTime).toBe(42);
    expect(prototype.play).not.toHaveBeenCalled();
  });

  it('restores a paused player from local storage after a window closes', async () => {
    vi.mocked(tauriCommands.openLocalPlayback)
      .mockResolvedValueOnce(source())
      .mockResolvedValueOnce(source({ id: 'reopened' }));
    const first = render(<MediaView relativePath="clip.webm" />);
    const media = await loadMetadata('video');
    media.currentTime = 47;
    media.playbackRate = 1.5;
    media.volume = 0.5;
    window.dispatchEvent(new Event('pagehide'));
    clearMediaResources();
    expect(readMediaResume(useVaultStore.getState().vault!, 'clip.webm')?.position).toBe(47);
    first.unmount();
    clearMediaResources();

    render(<MediaView relativePath="clip.webm" />);
    const reopened = await loadMetadata('video');
    expect(reopened.currentTime).toBe(47);
    expect(reopened.playbackRate).toBe(1.5);
    expect(reopened.volume).toBe(0.5);
    expect(prototype.play).not.toHaveBeenCalled();
  });

  it('clears saved playback when restart resume is turned off', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValueOnce(source());
    const first = render(<MediaView relativePath="clip.webm" />);
    const media = await loadMetadata('video');
    media.currentTime = 47;
    fireEvent.seeked(media);
    first.unmount();
    useUiStore.getState().setRememberMediaOnRestart(false);
    const vault = useVaultStore.getState().vault!;
    expect(readMediaResume(vault, 'clip.webm')?.position).toBe(47);
    clearMediaResources();
    useUiStore.getState().setRememberMediaOnRestart(true);
    expect(readMediaResume(vault, 'clip.webm')).toBeUndefined();
  });

  it('discards old track choices and position when reopening replaced media', async () => {
    const vault = useVaultStore.getState().vault!;
    rememberMediaResume(vault, 'clip.mp4', {
      revision: 'r1',
      position: 35,
      duration: 120,
      fileVersion: mediaFileVersion(undefined),
      rate: 1.5,
      volume: 1,
      muted: false,
      caption: '0',
      captionPath: 'old.srt',
      audio: '0',
      isolatedAudio: 2,
      compatibility: true,
    });
    clearMediaResources();
    vi.mocked(tauriCommands.openLocalPlayback)
      .mockResolvedValueOnce(source({ revision: 'r2' }))
      .mockResolvedValueOnce(source({ id: 'new-source', revision: 'r2' }));
    render(<MediaView relativePath="clip.mp4" />);
    const media = await loadMetadata('video');
    expect(tauriCommands.openLocalPlayback).toHaveBeenNthCalledWith(
      1,
      '/vault',
      'clip.mp4',
      'old.srt',
      true,
      2,
      false,
      'r1',
    );
    expect(tauriCommands.openLocalPlayback).toHaveBeenNthCalledWith(
      2,
      '/vault',
      'clip.mp4',
      null,
      false,
      null,
      false,
      undefined,
    );
    expect(tauriCommands.closeLocalPlayback).toHaveBeenCalledWith('playback-1');
    expect(media.currentTime).toBe(0);
    expect(media.playbackRate).toBe(1);
  });

  it('clears revoked local resume state and closes a late open after leaving the vault', async () => {
    const path = 'clip.webm';
    const vault = useVaultStore.getState().vault!;
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValueOnce(source());
    const first = render(<MediaView relativePath={path} />);
    const media = await loadMetadata('video');
    media.currentTime = 42;
    fireEvent.seeked(media);
    expect(readMediaResume(vault, path)?.position).toBe(42);
    vi.mocked(tauriCommands.checkLocalPlayback).mockRejectedValueOnce(
      'The media file is no longer accessible.',
    );
    fireEvent.error(media);
    expect(await screen.findByText('The media file is no longer accessible.')).toBeTruthy();
    expect(readMediaResume(vault, path)).toBeUndefined();
    first.unmount();

    let complete!: (value: ReturnType<typeof source>) => void;
    vi.mocked(tauriCommands.openLocalPlayback).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    render(<MediaView relativePath={path} />);
    act(() => useVaultStore.setState({ vault: null }));
    await act(async () => complete(source({ id: 'late-open' })));
    expect(tauriCommands.closeLocalPlayback).toHaveBeenCalledWith('late-open');
    expect(document.querySelector('video')).toBeNull();
  });

  it('saves a hosted revision for offline use and reloads at the same position', async () => {
    useVaultStore.setState({
      vault: {
        kind: 'hosted',
        name: 'Hosted',
        id: 'v',
        path: 'hosted://v',
        lastOpened: 0,
        isEncrypted: false,
        hostedVaultId: 'v',
        serverUrl: 'http://localhost:4000',
        role: 'editor',
      },
    });
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue({
      vaultId: 'v',
      sequence: 1,
      files: [
        {
          id: 'clip',
          kind: 'asset',
          relativePath: 'clip.webm',
          state: 'active',
          currentRevision: { id: 'r1', contentHash: 'f'.repeat(64), sizeBytes: 123 },
        },
      ],
    });
    vi.mocked(tauriCommands.openHostedPlayback)
      .mockResolvedValueOnce(source({ canDownloadOffline: true }))
      .mockResolvedValueOnce(source({ id: 'playback-2', offline: true }));
    vi.mocked(tauriCommands.downloadHostedPlayback).mockResolvedValue(undefined);

    const { unmount } = render(<MediaView relativePath="clip.webm" />);
    const media = await loadMetadata('video');
    expect(screen.getByRole('button', { name: 'Save a copy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make available offline' }));
    expect(await screen.findByRole('button', { name: 'Offline copy saved' })).toBeTruthy();
    expect(tauriCommands.downloadHostedPlayback).toHaveBeenCalledWith('playback-1');

    media.currentTime = 44;
    vi.mocked(tauriCommands.checkLocalPlayback).mockRejectedValueOnce(
      'Connection lost. Reload to reconnect.',
    );
    fireEvent.error(media);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Reload to reconnect');
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload' }));
    await screen.findByText('Playing offline copy');
    expect((await loadMetadata('video')).currentTime).toBe(44);
    expect(tauriCommands.openLocalPlayback).not.toHaveBeenCalled();
    unmount();
    expect(tauriCommands.closeLocalPlayback).toHaveBeenCalledWith('playback-2');
  });

  it('draws video controls over the picture with one settings menu', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(source() as never);
    render(<MediaView relativePath="Videos/trip.webm" />);
    await loadMetadata('video');

    const player = screen.getByRole('region', { name: 'Video player' });
    const controls = within(player).getByRole('group', { name: 'Playback controls' });
    expect(within(controls).getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(within(controls).getByRole('button', { name: 'Back 10 seconds' })).toBeTruthy();
    expect(within(controls).getByRole('button', { name: 'Enter fullscreen' })).toBeTruthy();
    // No captions in this file, so no subtitles toggle.
    expect(within(controls).queryByRole('button', { name: 'Subtitles' })).toBeNull();
    // Old per-setting dropdowns are gone.
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.keyDown(within(controls).getByRole('button', { name: 'Playback settings' }), {
      key: 'Enter',
    });
    expect(await screen.findByRole('menuitem', { name: /Speed\s*Normal/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Audio track/ })).toBeNull();
  });

  it('lets ambient video fill the pane edge to edge, without a padded rounded frame', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(source() as never);
    localStorage.setItem('collab-media-ambiance', 'true');
    render(<MediaView relativePath="Videos/trip.webm" />);
    const player = screen.getByRole('region', { name: 'Video player' });
    expect(player.parentElement?.className).toContain('p-0');
    expect(player.className).not.toContain('rounded-xl');

    fireEvent.click(screen.getByRole('button', { name: 'Ambiance mode' }));
    expect(player.parentElement?.className).toContain('p-4');
    expect(player.className).toContain('rounded-xl');
  });

  it('pins the video controls to the visible picture, not the letterboxed stage', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(source() as never);
    const stubs: [object, string, number][] = [
      [HTMLElement.prototype, 'clientWidth', 1600],
      [HTMLElement.prototype, 'clientHeight', 900],
      [HTMLVideoElement.prototype, 'videoWidth', 1920],
      [HTMLVideoElement.prototype, 'videoHeight', 800],
    ];
    const restore = stubs.map(([target, key, value]) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, get: () => value });
      return () => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      };
    });
    try {
      render(<MediaView relativePath="Videos/trip.webm" />);
      await loadMetadata('video');
      const controls = screen.getByRole('group', { name: 'Playback controls' });
      // 1920×800 contained in 1600×900: 1600×666.67, 116.67 px bars top and bottom.
      await waitFor(() => expect(controls.style.bottom).toMatch(/^116\.6/));
      expect(controls.style.left).toBe('0px');
      expect(controls.style.width).toBe('1600px');
    } finally {
      restore.forEach((undo) => undo());
    }
  });

  it('offers Open externally in the document top bar', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(source() as never);
    render(<MediaView relativePath="Videos/trip.webm" />);
    const player = screen.getByRole('region', { name: 'Video player' });
    const button = screen.getByRole('button', { name: 'Open externally' });
    expect(player.contains(button)).toBe(false);
    fireEvent.click(button);
    expect(tauriCommands.openMediaExternally).toHaveBeenCalledWith('/vault', 'Videos/trip.webm');
  });

  it('shows playback failures as a card on the picture', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockRejectedValue('Codec missing');
    render(<MediaView relativePath="Videos/trip.webm" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Codec missing');
    expect(within(alert).getByRole('button', { name: /Reload/ })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: /Open externally/ }));
    expect(tauriCommands.openMediaExternally).toHaveBeenCalled();
  });

  it('toggles the keyboard shortcut list with ?', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(source() as never);
    render(<MediaView relativePath="Videos/trip.webm" />);
    await loadMetadata('video');
    const player = screen.getByRole('region', { name: 'Video player' });

    fireEvent.keyDown(player, { key: '?' });
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy();
    fireEvent.keyDown(player, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('plays and pauses with the keyboard', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(source() as never);
    render(<MediaView relativePath="Videos/trip.webm" />);
    await loadMetadata('video');
    fireEvent.keyDown(screen.getByRole('region', { name: 'Video player' }), { key: 'k' });
    expect(prototype.play).toHaveBeenCalled();
  });

  it('centres the audio player and hints at .lrc files when a track has no lyrics', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(
      source({
        audioMetadata: { title: 'Song', artist: 'Band', album: null, artworkUrl: null, lyrics: [] },
      }) as never,
    );
    render(<MediaView relativePath="Music/song.mp3" />);
    await loadMetadata('audio');

    expect(screen.getByRole('heading', { name: 'Song' })).toBeTruthy();
    expect(screen.getByText(/Add a matching \.lrc file/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Lyrics' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Playback speed, Normal' })).toBeTruthy();
  });

  it('shows synced lyrics beside the audio player and seeks when a line is clicked', async () => {
    vi.mocked(tauriCommands.openLocalPlayback).mockResolvedValue(
      source({
        audioMetadata: {
          title: 'Song',
          artist: null,
          album: null,
          artworkUrl: null,
          lyrics: [{ label: 'Synced', text: '[00:05.00]First line\n[00:10.00]Second line' }],
        },
      }) as never,
    );
    render(<MediaView relativePath="Music/song.mp3" />);
    const media = await loadMetadata('audio');

    const lyrics = screen.getByRole('region', { name: 'Lyrics' });
    fireEvent.click(within(lyrics).getByRole('button', { name: 'Second line' }));
    expect(media.currentTime).toBe(10);
  });
});
