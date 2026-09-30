/**
 * Images entering a deck: from the vault, a file, the clipboard, or a drop.
 *
 * A deck stores a vault-relative path plus the image's media type, pixel size,
 * and content hash (`DeckAssetRef`), recorded once at insert so layout never
 * waits on a decode. Files from outside the vault are imported into it first
 * — the deck never points anywhere else.
 */
import { DECK_LIMITS } from '../../types/deck';
import type { DeckAssetRef } from '../../types/deck';

import { DECK_ALLOWED_MEDIA_TYPES } from './validate';

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** The deck media type for a path, or null when a deck cannot hold it. */
export function imageMediaType(path: string): string | null {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return EXTENSION_TYPES[extension] ?? null;
}

export function isDeckImagePath(path: string): boolean {
  return imageMediaType(path) !== null;
}

function dataUrlParts(dataUrl: string): { mediaType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('That image could not be read.');
  const [, mediaType, base64, payload] = match;
  const bytes = base64
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return { mediaType: mediaType.toLowerCase(), bytes };
}

async function sha256(bytes: Uint8Array): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Decodes an image to learn its pixel size. Injected in tests. */
export type ImageDecoder = (dataUrl: string) => Promise<{ width: number; height: number }>;

export const decodeImage: ImageDecoder = (dataUrl) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    image.onerror = () => reject(new Error('That image could not be decoded.'));
    image.src = dataUrl;
  });

/**
 * Describes image bytes as a deck asset for `path`, enforcing the deck's
 * media types and its byte and decoded-pixel limits.
 */
export async function describeImage(
  path: string,
  dataUrl: string,
  decode: ImageDecoder = decodeImage,
): Promise<DeckAssetRef> {
  const { mediaType: declared, bytes } = dataUrlParts(dataUrl);
  const mediaType = imageMediaType(path) ?? declared;
  if (!DECK_ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new Error('Presentations can hold PNG, JPEG, GIF, WebP, and SVG images.');
  }
  if (bytes.length > DECK_LIMITS.imageBytes) {
    throw new Error(`That image is larger than ${DECK_LIMITS.imageBytes / 1024 / 1024} MiB.`);
  }
  let { width, height } = await decode(dataUrl);
  // An SVG without intrinsic size decodes as 0 × 0 or 300 × 150; give it a usable box.
  if (!width || !height) {
    width = 800;
    height = 600;
  }
  if (width * height > DECK_LIMITS.imagePixels) {
    throw new Error(
      `That image is ${width} × ${height} pixels; presentations hold at most ${(DECK_LIMITS.imagePixels / 1_000_000).toFixed(0)} megapixels.`,
    );
  }
  const hash = await sha256(bytes);
  return {
    path,
    mediaType,
    pixelWidth: Math.round(width),
    pixelHeight: Math.round(height),
    ...(hash ? { sha256: hash } : {}),
  };
}

/** Reads a browser `File` (a drop or a picked file) as a `data:` URL. */
export function fileDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}
