import type { ActiveView } from '../store/uiStore';
import type { NoteFile } from '../types/vault';

const ABSOLUTE_URL_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const IMAGE_EXT_RE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

export type VaultDocumentTabType = 'note' | 'canvas' | 'kanban' | 'image' | 'pdf';

export interface VaultLinkTarget {
  relativePath: string;
  title: string;
  type: VaultDocumentTabType;
}

function normalizeSeparators(path: string) {
  return path.replace(/\\/g, '/');
}

function normalizeRelativePath(path: string) {
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

function stripLinkSuffix(path: string) {
  return path.split(/[?#]/, 1)[0] ?? path;
}

export function flattenVaultFiles(nodes: NoteFile[]): NoteFile[] {
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

export function getVaultDocumentTabType(relativePath: string): VaultDocumentTabType {
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/i.test(relativePath)) return 'image';
  if (/\.pdf$/i.test(relativePath)) return 'pdf';
  if (/\.kanban$/i.test(relativePath)) return 'kanban';
  if (/\.canvas$/i.test(relativePath)) return 'canvas';
  return 'note';
}

export function getVaultDocumentView(type: VaultDocumentTabType): ActiveView {
  if (type === 'kanban') return 'kanban';
  if (type === 'canvas') return 'canvas';
  return 'editor';
}

export function getVaultDocumentTitle(relativePath: string) {
  return relativePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? relativePath;
}

function isImagePath(relativePath: string) {
  return IMAGE_EXT_RE.test(relativePath);
}

function isAbsoluteOrExternalLink(value: string) {
  return ABSOLUTE_URL_RE.test(value) || value.startsWith('data:') || value.startsWith('blob:');
}

function buildVaultLinkTarget(file: NoteFile): VaultLinkTarget {
  return {
    relativePath: file.relativePath,
    title: getVaultDocumentTitle(file.relativePath),
    type: getVaultDocumentTabType(file.relativePath),
  };
}

export function resolveVaultRelativeLinkTarget(
  rawLink: string,
  currentDocumentRelativePath: string,
  fileTree: NoteFile[],
): VaultLinkTarget | null {
  const trimmed = rawLink.trim();
  if (!trimmed || isAbsoluteOrExternalLink(trimmed)) return null;

  const filePath = stripLinkSuffix(trimmed);
  const noteDir = currentDocumentRelativePath.includes('/')
    ? currentDocumentRelativePath.split('/').slice(0, -1).join('/')
    : '';
  const relativeToVault = filePath.startsWith('/')
    ? normalizeRelativePath(filePath)
    : normalizeRelativePath(noteDir ? `${noteDir}/${filePath}` : filePath);

  const flatFiles = flattenVaultFiles(fileTree);
  const exactMatch = flatFiles.find((file) => file.relativePath.toLowerCase() === relativeToVault.toLowerCase());
  if (exactMatch) return buildVaultLinkTarget(exactMatch);

  if (!relativeToVault.includes('/')) {
    const basenameMatches = flatFiles.filter((file) => file.name.toLowerCase() === relativeToVault.toLowerCase());
    if (basenameMatches.length === 1) return buildVaultLinkTarget(basenameMatches[0]);
  }

  return null;
}

export function resolveVaultWikilinkTarget(rawLink: string, fileTree: NoteFile[]): VaultLinkTarget | null {
  const trimmed = rawLink.trim();
  if (!trimmed) return null;

  const flatFiles = flattenVaultFiles(fileTree).filter((file) => !isImagePath(file.relativePath));
  const normalized = normalizeRelativePath(stripLinkSuffix(trimmed));
  const normalizedLower = normalized.toLowerCase();

  const exactMatch = flatFiles.find((file) => file.relativePath.toLowerCase() === normalizedLower);
  if (exactMatch) return buildVaultLinkTarget(exactMatch);

  const baseNameMatch = flatFiles.find((file) => file.name.toLowerCase() === normalizedLower);
  if (baseNameMatch) return buildVaultLinkTarget(baseNameMatch);

  if (!/\.[a-z0-9]+$/i.test(normalized)) {
    const stemLower = normalizedLower;
    const noteMatch = flatFiles.find((file) => {
      if (getVaultDocumentTabType(file.relativePath) !== 'note') return false;
      return getVaultDocumentTitle(file.relativePath).toLowerCase() === stemLower;
    });
    if (noteMatch) return buildVaultLinkTarget(noteMatch);

    const otherDocMatches = flatFiles.filter((file) => getVaultDocumentTitle(file.relativePath).toLowerCase() === stemLower);
    if (otherDocMatches.length === 1) return buildVaultLinkTarget(otherDocMatches[0]);
  }

  return null;
}

export function getVaultWikilinkAutocompleteItems(fileTree: NoteFile[]) {
  return flattenVaultFiles(fileTree)
    .filter((file) => !isImagePath(file.relativePath))
    .map((file) => {
      const type = getVaultDocumentTabType(file.relativePath);
      const folder = file.relativePath.includes('/')
        ? file.relativePath.split('/').slice(0, -1).join('/')
        : undefined;
      const insertText = type === 'note'
        ? getVaultDocumentTitle(file.relativePath)
        : file.relativePath;

      return {
        label: type === 'note' ? getVaultDocumentTitle(file.relativePath) : file.name,
        detail: [folder, type === 'pdf' ? 'PDF' : type === 'canvas' ? 'Canvas' : type === 'kanban' ? 'Kanban' : undefined]
          .filter(Boolean)
          .join(' · ') || undefined,
        type: 'text' as const,
        insertText,
      };
    });
}
