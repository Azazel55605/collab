import type { NoteFile } from '../types/vault';

/**
 * Text-backed document types that can be duplicated through the normal
 * create + write document path. Binary assets are excluded: copying them would
 * need a byte-level asset copy, which the Files sidebar exposes as Download
 * instead.
 */
const DUPLICABLE_EXTENSIONS = new Set(['md', 'markdown', 'canvas', 'kanban', 'logic', 'sheet', 'ink', 'svg']);

export function isTextDocumentPath(relativePath: string): boolean {
  const extension = relativePath.split('.').pop()?.toLowerCase() ?? '';
  return DUPLICABLE_EXTENSIONS.has(extension);
}

function splitExtension(relativePath: string): { stem: string; extension: string } {
  const lastSlash = relativePath.lastIndexOf('/');
  const name = relativePath.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: relativePath, extension: '' };
  return {
    stem: relativePath.slice(0, lastSlash + 1 + dot),
    extension: name.slice(dot),
  };
}

/**
 * Picks the first free `name copy.ext` / `name copy 2.ext` path next to the
 * source, comparing case-insensitively because vault paths are matched that way
 * elsewhere (and some filesystems are case-insensitive).
 */
export function nextAvailableCopyPath(relativePath: string, existing: NoteFile[]): string {
  const taken = new Set(existing.map((file) => file.relativePath.toLowerCase()));
  const { stem, extension } = splitExtension(relativePath);

  let candidate = `${stem} copy${extension}`;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${stem} copy ${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}
