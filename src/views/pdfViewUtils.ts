import type { PdfHighlight } from '../types/pdf';
import type { NoteFile } from '../types/vault';

export function flattenPdfFiles(nodes: NoteFile[]): NoteFile[] {
  const flattened: NoteFile[] = [];

  for (const node of nodes) {
    flattened.push(node);
    if (node.children?.length) {
      flattened.push(...flattenPdfFiles(node.children));
    }
  }

  return flattened;
}

export function expandPdfHighlightRects(highlights: PdfHighlight[]) {
  return highlights.reduce<
    Array<{ highlight: PdfHighlight; rect: PdfHighlight['rects'][number]; index: number }>
  >((entries, highlight) => {
    highlight.rects.forEach((rect, index) => {
      entries.push({ highlight, rect, index });
    });
    return entries;
  }, []);
}
