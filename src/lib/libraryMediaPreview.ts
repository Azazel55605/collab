import type { NoteFile, VaultMeta } from '../types/vault';

import { bytesDataUrl } from './assetBytes';
import { documentVaultIdentity } from './documentPaneContext';
import { mediaGeneration, registerMediaCleanup } from './mediaLifecycle';
import { mediaFileVersion } from './mediaResume';
import { previewCancelled, PreviewScheduler } from './previewScheduler';
import { tauriCommands } from './tauri';
import { createVaultClient } from './vaultClient';

export type LibraryMediaKind = 'image' | 'svg' | 'video' | 'audio';

export interface LibraryMediaDetails {
  image?: string;
  duration?: number;
  artist?: string;
  album?: string;
}

const RENDERER = 'library:v1';
const INLINE_IMAGE_LIMIT = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const mediaDetails = new Map<string, LibraryMediaDetails>();
const scheduler = new PreviewScheduler(1, 8);
let cacheBytes = 0;

registerMediaCleanup(() => {
  scheduler.clear();
  mediaDetails.clear();
  cacheBytes = 0;
});

export function libraryPreviewKey(vault: VaultMeta, file: NoteFile) {
  return JSON.stringify([
    documentVaultIdentity(vault),
    file.relativePath,
    mediaFileVersion(file),
    RENDERER,
  ]);
}

export function cachedLibraryMediaDetails(key: string) {
  return mediaDetails.get(key);
}

export function canPreviewInGallery(vault: VaultMeta, file: NoteFile, kind: LibraryMediaKind) {
  return (
    vault.kind !== 'hosted' && kind === 'image' && file.size > 0 && file.size <= INLINE_IMAGE_LIMIT
  );
}

export async function loadLibraryImage(
  vault: VaultMeta,
  file: NoteFile,
  kind: 'image' | 'svg',
  signal: AbortSignal,
) {
  const client = createVaultClient(vault);
  const bytes = await client.readAssetBytes(file.relativePath, signal, true, 384);
  if (signal.aborted) throw previewCancelled();
  return bytesDataUrl(bytes, kind === 'svg' ? 'image/svg+xml' : 'image/png');
}

export function loadLibraryMediaDetails(
  vault: VaultMeta,
  file: NoteFile,
  kind: LibraryMediaKind,
  signal: AbortSignal,
): Promise<LibraryMediaDetails> {
  const key = libraryPreviewKey(vault, file);
  const hit = mediaDetails.get(key);
  if (hit) {
    mediaDetails.delete(key);
    mediaDetails.set(key, hit);
    return Promise.resolve(hit);
  }
  const generation = mediaGeneration();
  return scheduler.run(
    key,
    async (jobSignal) => {
      const details =
        kind === 'image' || kind === 'svg'
          ? { image: await loadLibraryImage(vault, file, kind, jobSignal) }
          : await inspectPlayable(vault, file.relativePath, kind, jobSignal);
      if (jobSignal.aborted || mediaGeneration() !== generation) throw previewCancelled();
      const cost = (details.image?.length ?? 0) * 2;
      while (
        mediaDetails.size &&
        (mediaDetails.size >= 32 || cacheBytes + cost > MAX_CACHE_BYTES)
      ) {
        const first = mediaDetails.keys().next().value!;
        cacheBytes -= (mediaDetails.get(first)?.image?.length ?? 0) * 2;
        mediaDetails.delete(first);
      }
      if (cost <= MAX_CACHE_BYTES) {
        cacheBytes += cost;
        mediaDetails.set(key, details);
      }
      return details;
    },
    { signal },
  );
}

async function inspectPlayable(
  vault: VaultMeta,
  path: string,
  kind: 'audio' | 'video',
  signal: AbortSignal,
): Promise<LibraryMediaDetails> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 12000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const active = controller.signal;
  const opening =
    vault.kind === 'hosted'
      ? createVaultClient(vault).runtime.hostedPlayback!.open(path, true)
      : tauriCommands.openLocalPlayback(vault.path, path, null, false, null, true);
  try {
    // IPC may finish after the preview dialog is dismissed.
    const source = await opening;
    try {
      if (active.aborted) throw previewCancelled();
      const metadata = source.audioMetadata;
      const [details, cover] = await Promise.all([
        captureFrame(source.url, kind, active),
        metadata?.artworkUrl ? loadCover(metadata.artworkUrl, active) : Promise.resolve(undefined),
      ]);
      return {
        ...details,
        image: details.image ?? cover,
        artist: metadata?.artist ?? undefined,
        album: metadata?.album ?? undefined,
      };
    } finally {
      void tauriCommands.closeLocalPlayback(source.id).catch(() => {});
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

async function loadCover(url: string, signal: AbortSignal) {
  try {
    const response = await fetch(url, { signal });
    const length = Number(response.headers.get('content-length'));
    if (
      !response.ok ||
      response.headers.get('content-type') !== 'image/png' ||
      length < 1 ||
      length > 2 * 1024 * 1024
    )
      return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) return undefined;
    return await bytesDataUrl(bytes, 'image/png');
  } catch {
    return undefined;
  }
}

function captureFrame(url: string, kind: 'video' | 'audio', signal: AbortSignal) {
  const media = document.createElement(kind);
  media.preload = kind === 'video' ? 'auto' : 'metadata';
  media.crossOrigin = 'anonymous';
  media.muted = true;
  media.tabIndex = -1;
  media.setAttribute('aria-hidden', 'true');
  media.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
  const video = kind === 'video' ? (media as HTMLVideoElement) : null;
  if (video) video.playsInline = true;
  const event = video ? 'loadeddata' : 'loadedmetadata';

  return new Promise<LibraryMediaDetails>((resolve, reject) => {
    function cleanup() {
      signal.removeEventListener('abort', stop);
      media.removeEventListener('error', fail);
      media.removeEventListener(event, loaded);
      media.removeAttribute('src');
      media.load();
      media.remove();
    }
    function stop() {
      cleanup();
      reject(previewCancelled());
    }
    function fail() {
      const duration = Number.isFinite(media.duration) ? media.duration : undefined;
      cleanup();
      if (duration !== undefined) resolve({ duration });
      else reject(new Error('Media preview unavailable.'));
    }
    function loaded() {
      const duration = Number.isFinite(media.duration) ? media.duration : undefined;
      let image: string | undefined;
      if (video?.videoWidth && video.videoHeight) {
        try {
          const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext('2d');
          if (context) {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            image = canvas.toDataURL('image/jpeg', 0.82);
          }
        } catch {
          // Some WebViews expose duration even when frame capture is unavailable.
        }
      }
      cleanup();
      resolve({ duration, image });
    }
    signal.addEventListener('abort', stop, { once: true });
    media.addEventListener('error', fail, { once: true });
    media.addEventListener(event, loaded, { once: true });
    if (signal.aborted) stop();
    else {
      document.body.append(media);
      media.src = url;
    }
  });
}
