export type FilePreviewType = 'image' | 'pdf' | 'document';

const INTERNAL_EXTENSIONS = new Set(['md', 'sheet', 'deck', 'ink', 'canvas', 'kanban', 'logic']);

export function supportsDocumentPreview(path: string) {
  return INTERNAL_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
}

export function getFilePreviewType(path: string): FilePreviewType | null {
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(path)) return 'image';
  return supportsDocumentPreview(path) ? 'document' : null;
}
