import {
  hostedAssetDataUrl,
  type HostedFileEntry,
  readHostedDocument,
  replicaCacheAsset,
  replicaCacheDocument,
  replicaReadCachedAsset,
  replicaReadCachedDocument,
} from '../mobileTauri';

import { fileExtension } from './format';

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export function dataUrlToBase64(value: string): string | null {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index === -1 ? null : value.slice(index + marker.length);
}

export function svgDataUrl(content: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
}

export function base64DataUrl(base64: string, mediaType: string): string {
  return `data:${mediaType};base64,${base64}`;
}

export function mediaTypeForFile(file: HostedFileEntry | string): string {
  const name = typeof file === 'string' ? file : file.relativePath || file.name;
  const ext = fileExtension(name);
  if (ext === 'pdf') return 'application/pdf';
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function isImageFile(file: HostedFileEntry): boolean {
  if (file.kind === 'folder') return false;
  return !!IMAGE_MIME_BY_EXT[fileExtension(file.name)];
}

export function isPdfFile(file: HostedFileEntry): boolean {
  return file.kind !== 'folder' && fileExtension(file.name) === 'pdf';
}

export function isRichViewableFile(file: HostedFileEntry): boolean {
  return isImageFile(file) || isPdfFile(file);
}

export function uint8ArrayFromDataUrl(dataUrl: string): Uint8Array {
  const base64 = dataUrlToBase64(dataUrl);
  if (!base64) throw new Error('The file content is not a base64 data URL.');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function uint8ArrayFromDataUrlChunked(dataUrl: string): Promise<Uint8Array> {
  const base64 = dataUrlToBase64(dataUrl);
  if (!base64) throw new Error('The file content is not a base64 data URL.');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  const chunkSize = 256 * 1024;
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, binary.length);
    for (let index = offset; index < end; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  return bytes;
}

function shouldWarmAssetCacheOnOpen(file: HostedFileEntry): boolean {
  // Large PDFs/images are expensive to shuttle back over IPC as base64 just for
  // a passive open. Explicit offline availability still caches them.
  return (file.sizeBytes ?? 0) <= 5 * 1024 * 1024;
}

export interface ReadMobileAssetOptions {
  serverUrl: string;
  vaultId: string;
  file: HostedFileEntry;
  connected: boolean;
}

export async function readMobileAssetDataUrl({
  serverUrl,
  vaultId,
  file,
  connected,
}: ReadMobileAssetOptions): Promise<{ dataUrl: string; source: 'network' | 'cache' }> {
  if (file.kind === 'document' && /\.svg$/i.test(file.name)) {
    if (connected) {
      try {
        const document = await readHostedDocument(serverUrl, vaultId, file.id);
        void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
        return { dataUrl: svgDataUrl(document.content), source: 'network' };
      } catch {
        // Fall back to the cached SVG document below.
      }
    }
    const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id).catch(() => null);
    if (cached) return { dataUrl: svgDataUrl(cached), source: 'cache' };
    throw new Error('This SVG is not cached on this device.');
  }

  if (file.kind !== 'asset') {
    throw new Error('This file is not available through the mobile asset viewer yet.');
  }

  if (connected) {
    try {
      const dataUrl = await hostedAssetDataUrl(serverUrl, vaultId, file.id);
      const base64 = dataUrlToBase64(dataUrl);
      if (base64 && shouldWarmAssetCacheOnOpen(file)) {
        void replicaCacheAsset(serverUrl, vaultId, file.id, base64).catch(() => {});
      }
      return { dataUrl, source: 'network' };
    } catch {
      // Fall back to cached bytes below.
    }
  }

  const cached = await replicaReadCachedAsset(serverUrl, vaultId, file.id).catch(() => null);
  if (cached) return { dataUrl: base64DataUrl(cached, mediaTypeForFile(file)), source: 'cache' };
  throw new Error('This file is not cached on this device.');
}
