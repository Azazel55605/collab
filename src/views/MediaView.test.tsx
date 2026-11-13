import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../lib/tauri';
import { useVaultStore } from '../store/vaultStore';

import MediaView from './MediaView';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    openLocalPlayback: vi.fn(),
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
    localStorage.clear();
    vi.mocked(tauriCommands.checkLocalPlayback).mockResolvedValue(undefined);
    vi.mocked(tauriCommands.closeLocalPlayback).mockResolvedValue(undefined);
    vi.mocked(tauriCommands.openMediaExternally).mockResolvedValue(undefined);
    useVaultStore.setState({
      vault: { id: 'v', name: 'Vault', path: '/vault', lastOpened: 0, isEncrypted: false },
      isVaultLocked: false,
      fileTree: [],
    });
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
