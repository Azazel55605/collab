import type { HostedFileEntry } from './types';

/**
 * Which vault entries the Collab apps can actually open.
 *
 * The server stores whatever is uploaded, but the desktop and mobile clients
 * only have viewers for a fixed set. Anything else occupies quota and shows up
 * in the file tree as a dead end, which is what this classification exists to
 * find.
 *
 * The document set mirrors `collab_documents::classify_path`; the asset set
 * mirrors what the clients route to a viewer (raster images, SVG, PDF). Keep
 * them aligned when a new editor or viewer ships.
 */
const DOCUMENT_EXTENSIONS = ['md', 'markdown', 'kanban', 'canvas', 'logic', 'sheet', 'ink', 'svg'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];
const VIEWABLE_ASSET_EXTENSIONS = [...IMAGE_EXTENSIONS, 'pdf'];

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** True when a client has a viewer or editor for this entry. */
export function isOpenableInApp(file: HostedFileEntry): boolean {
  if (file.kind === 'folder') return true;
  const extension = fileExtension(file.name);
  if (file.kind === 'document') {
    // A server-classified document type is always openable; the extension check
    // covers document-backed kinds the manifest reports without one.
    return file.documentType !== null || DOCUMENT_EXTENSIONS.includes(extension);
  }
  return VIEWABLE_ASSET_EXTENSIONS.includes(extension);
}

/**
 * Why an entry cannot be opened, for the review list. Returns null when the
 * entry is fine, so callers can filter and explain in one pass.
 */
export function describeIncompatibility(file: HostedFileEntry): string | null {
  if (isOpenableInApp(file)) return null;
  const extension = fileExtension(file.name);
  if (!extension) return 'No file extension — no app can open it';
  if (file.kind === 'document') return `Unrecognized .${extension} document`;
  return `.${extension} has no viewer in the Collab apps`;
}

/**
 * The active entries no client can open, largest first so the biggest wins are
 * offered up front. Trashed and tombstoned entries are excluded: they are
 * already handled by the Trash section.
 */
export function findIncompatibleFiles(files: HostedFileEntry[]): HostedFileEntry[] {
  return files
    .filter((file) => file.state === 'active' && file.kind !== 'folder' && !isOpenableInApp(file))
    .sort((left, right) => (
      (right.currentRevision?.sizeBytes ?? 0) - (left.currentRevision?.sizeBytes ?? 0)
    ));
}

/**
 * Drops any entry whose ancestor folder is also selected.
 *
 * Trashing a folder takes its whole subtree, so a follow-up operation on a
 * descendant would target an entry that is already gone. Callers dedupe before
 * running a bulk operation rather than reporting avoidable failures.
 */
export function dedupeNestedSelection(
  files: HostedFileEntry[],
  selected: ReadonlySet<string>,
): HostedFileEntry[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const chosen = files.filter((file) => selected.has(file.id));
  return chosen.filter((file) => {
    let parentId = file.parentId;
    // Seeded with the entry itself so a malformed cyclic parent chain
    // terminates instead of concluding the entry is its own ancestor and
    // silently dropping it from the operation.
    const seen = new Set<string>([file.id]);
    while (parentId && !seen.has(parentId)) {
      if (selected.has(parentId)) return false;
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}
