import type { NoteFile } from '../types/vault';

import { vaultTreeIndex } from './vaultTreeIndex';

const IMAGE_EXT_RE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function normalizeRelativePath(path: string): string {
  const parts = normalizeSeparators(path).split('/');
  const out: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }

  return out.join('/');
}

function parentPath(path: string): string {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

export function getRelativeMarkdownPath(
  currentDocumentRelativePath: string,
  targetRelativePath: string,
) {
  const currentDir = normalizeRelativePath(currentDocumentRelativePath).includes('/')
    ? normalizeRelativePath(currentDocumentRelativePath).split('/').slice(0, -1)
    : [];
  const targetParts = normalizeRelativePath(targetRelativePath).split('/');

  let common = 0;
  while (
    common < currentDir.length &&
    common < targetParts.length &&
    currentDir[common] === targetParts[common]
  ) {
    common += 1;
  }

  const up = Array.from({ length: currentDir.length - common }, () => '..');
  const down = targetParts.slice(common);
  return [...up, ...down].join('/') || '.';
}

export function getMarkdownImageTarget(
  currentDocumentRelativePath: string,
  targetRelativePath: string,
) {
  return formatMarkdownImageDestination(
    getRelativeMarkdownPath(currentDocumentRelativePath, targetRelativePath),
  );
}

export function formatMarkdownImageDestination(path: string): string {
  return /\s/.test(path) && !(path.startsWith('<') && path.endsWith('>')) ? `<${path}>` : path;
}

export function isLikelyImagePath(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0];
  return IMAGE_EXT_RE.test(cleanPath);
}

export type NoteAssetTarget = { kind: 'direct'; value: string } | { kind: 'vault'; value: string };

export function resolveNoteAssetTarget(
  assetPath: string,
  _noteRelativePath: string,
  fileTree?: NoteFile[],
): NoteAssetTarget | null {
  const trimmed = assetPath.trim();
  if (!trimmed) return null;
  const unwrapped =
    trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
  if (
    ABSOLUTE_URL_RE.test(unwrapped) ||
    unwrapped.startsWith('data:') ||
    unwrapped.startsWith('blob:')
  ) {
    return { kind: 'direct', value: unwrapped };
  }

  const rawPath = unwrapped.split(/[?#]/, 1)[0];
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // A literal percent sign can be part of a vault filename.
  }
  if (fileTree?.length) {
    const noteDir = parentPath(_noteRelativePath);
    const index = vaultTreeIndex(fileTree);
    // Preserve existing literal matches and accept percent-encoded Markdown URLs.
    for (const path of new Set([rawPath, decodedPath])) {
      const candidates = new Set([
        normalizeRelativePath(path),
        normalizeRelativePath(noteDir ? `${noteDir}/${path}` : path),
      ]);
      const exactVaultMatch = Array.from(candidates)
        .map((candidate) => index.foldedFiles.get(candidate.toLowerCase()))
        .filter((file): file is NoteFile => !!file)
        .sort((a, b) => index.order.get(a)! - index.order.get(b)!)[0];
      if (exactVaultMatch) return { kind: 'vault', value: exactVaultMatch.relativePath };
    }
  }

  return { kind: 'vault', value: normalizeRelativePath(decodedPath) };
}

export function waitForNoteImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  if (typeof image.decode === 'function') return image.decode().catch(() => undefined);
  return new Promise((resolve) => {
    const done = () => {
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
      resolve();
    };
    image.addEventListener('load', done);
    image.addEventListener('error', done);
  });
}
