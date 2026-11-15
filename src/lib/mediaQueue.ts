import { toast } from 'sonner';
import { create } from 'zustand';

import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type { VaultMeta } from '../types/vault';

import { documentVaultIdentity } from './documentPaneContext';
import { mediaKindForPath } from './mediaFiles';
import { registerMediaCleanup } from './mediaLifecycle';
import { mediaResumeAccount } from './mediaResume';
import { vaultTreeIndex } from './vaultTreeIndex';

interface Queue {
  scope: string | null;
  paths: string[];
  requested: string | null;
  current: string | null;
}

const emptyQueue: Queue = { scope: null, paths: [], requested: null, current: null };
export const useMediaQueue = create<Queue>(() => emptyQueue);

function scopeFor(vault: VaultMeta | null) {
  return vault
    ? JSON.stringify([documentVaultIdentity(vault), vault.id, mediaResumeAccount(vault)])
    : null;
}

function isActive(vault: VaultMeta) {
  const state = useVaultStore.getState();
  return !state.isVaultLocked && !vault.isEncrypted && scopeFor(state.vault) === scopeFor(vault);
}

registerMediaCleanup(() => useMediaQueue.setState(emptyQueue));

export function enqueueMedia(vault: VaultMeta, path: string) {
  if (!isActive(vault) || !mediaKindForPath(path)) return;
  const scope = scopeFor(vault);
  const queue = useMediaQueue.getState();
  const paths = queue.scope === scope ? queue.paths : [];
  if (paths.includes(path) || paths.length >= 100) return;
  useMediaQueue.setState({
    scope,
    paths: [...paths, path],
    requested: queue.scope === scope ? queue.requested : null,
    current: queue.scope === scope ? queue.current : null,
  });
}

export function editMediaQueue(vault: VaultMeta, path: string, direction: -1 | 0 | 1) {
  const queue = useMediaQueue.getState();
  if (!isActive(vault) || queue.scope !== scopeFor(vault)) return;
  const index = queue.paths.indexOf(path);
  if (index < 0) return;
  if (direction === 0) {
    useMediaQueue.setState({
      paths: queue.paths.filter((item) => item !== path),
      requested: queue.requested === path ? null : queue.requested,
      current: queue.current === path ? null : queue.current,
    });
    return;
  }
  const next = index + direction;
  if (next < 0 || next >= queue.paths.length) return;
  const paths = [...queue.paths];
  [paths[index], paths[next]] = [paths[next], paths[index]];
  useMediaQueue.setState({ paths });
}

export async function playQueuedMedia(vault: VaultMeta, path: string) {
  const scope = scopeFor(vault);
  function queuedFile() {
    const queue = useMediaQueue.getState();
    if (!isActive(vault) || queue.scope !== scope || !queue.paths.includes(path)) return undefined;
    const file = vaultTreeIndex(useVaultStore.getState().fileTree).byPath.get(path);
    return file && !file.isFolder && mediaKindForPath(path) ? file : undefined;
  }
  if (!queuedFile()) {
    toast.error('That queued file is no longer available.');
    return;
  }
  if (!(await useUiStore.getState().setActiveView('editor'))) return;
  const file = queuedFile();
  if (!file) return;
  useEditorStore.getState().openTab(path, file.name, 'media');
  useMediaQueue.setState({ requested: path });
}

export function adjacentQueuedMedia(vault: VaultMeta, path: string, direction: -1 | 1) {
  const queue = useMediaQueue.getState();
  if (!isActive(vault) || queue.scope !== scopeFor(vault)) return undefined;
  const index = queue.paths.indexOf(path);
  if (index < 0) return undefined;
  const files = vaultTreeIndex(useVaultStore.getState().fileTree).byPath;
  for (let i = index + direction; i >= 0 && i < queue.paths.length; i += direction) {
    const candidate = queue.paths[i];
    const file = files.get(candidate);
    if (file && !file.isFolder) return candidate;
  }
  return undefined;
}

export function consumeQueuedPlayback(vault: VaultMeta, path: string) {
  const queue = useMediaQueue.getState();
  if (!isActive(vault) || queue.scope !== scopeFor(vault) || queue.requested !== path) return false;
  useMediaQueue.setState({ requested: null, current: path });
  return true;
}

export interface MediaPlaylist {
  name: string;
  paths: string[];
}

const PLAYLIST_PREFIX = 'collab.media-playlists.v1:';

function playlistKey(vault: VaultMeta) {
  if (!isActive(vault) || !mediaResumeAccount(vault)) return null;
  return PLAYLIST_PREFIX + scopeFor(vault);
}

export function readMediaPlaylists(vault: VaultMeta) {
  const key = playlistKey(vault);
  if (!key) return [];
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data
      .slice(0, 20)
      .filter(
        (item): item is MediaPlaylist =>
          item &&
          typeof item.name === 'string' &&
          item.name.length <= 80 &&
          Array.isArray(item.paths) &&
          item.paths.length <= 100 &&
          item.paths.every((path: unknown) => typeof path === 'string' && !!mediaKindForPath(path)),
      );
  } catch {
    return [];
  }
}

export function writeMediaPlaylists(vault: VaultMeta, playlists: MediaPlaylist[]) {
  const key = playlistKey(vault);
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify(playlists.slice(0, 20)));
    return true;
  } catch {
    return false;
  }
}

export function loadMediaPlaylist(vault: VaultMeta, playlist: MediaPlaylist) {
  if (!isActive(vault)) return;
  useMediaQueue.setState({
    ...emptyQueue,
    scope: scopeFor(vault),
    paths: [...new Set(playlist.paths)],
  });
}
