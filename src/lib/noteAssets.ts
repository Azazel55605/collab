import type { NoteFile } from '../types/vault';

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
  const relativeTarget = getRelativeMarkdownPath(currentDocumentRelativePath, targetRelativePath);
  return /\s/.test(relativeTarget) ? `<${relativeTarget}>` : relativeTarget;
}

export function isLikelyImagePath(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0];
  return IMAGE_EXT_RE.test(cleanPath);
}

export type NoteAssetTarget = { kind: 'direct'; value: string } | { kind: 'vault'; value: string };

function flattenVaultFiles(nodes: NoteFile[]): NoteFile[] {
  const flat: NoteFile[] = [];

  const visit = (items: NoteFile[]) => {
    for (const item of items) {
      if (item.isFolder) {
        if (item.children?.length) visit(item.children);
        continue;
      }
      flat.push(item);
    }
  };

  visit(nodes);
  return flat;
}

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

  const [rawPath, suffix = ''] = unwrapped.match(/^([^?#]*)(.*)$/)?.slice(1) ?? [unwrapped, ''];
  const vaultRelativePath = normalizeRelativePath(rawPath);
  if (fileTree?.length) {
    const noteDir = parentPath(_noteRelativePath);
    const noteRelativePath = normalizeRelativePath(noteDir ? `${noteDir}/${rawPath}` : rawPath);
    const candidates = Array.from(new Set([vaultRelativePath, noteRelativePath]));
    const exactVaultMatch = flattenVaultFiles(fileTree).find((file) =>
      candidates.some((candidate) => file.relativePath.toLowerCase() === candidate.toLowerCase()),
    );
    if (exactVaultMatch) {
      return {
        kind: 'vault',
        value: `${exactVaultMatch.relativePath}${suffix}`,
      };
    }
  }

  const relativeToVault = normalizeRelativePath(rawPath);

  return {
    kind: 'vault',
    value: `${relativeToVault}${suffix}`,
  };
}
