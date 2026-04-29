import type { CanvasData, CanvasNode } from '../types/canvas';

export function buildPdfQuoteMarkdown(relativePath: string, page: number, text: string) {
  const trimmed = text.trim();
  const quoteBody = trimmed
    .split(/\r?\n/)
    .map((line) => `> ${line.trimEnd()}`)
    .join('\n');
  return `${quoteBody}\n> \n> Source: ${relativePath} (page ${page})\n`;
}

export function buildPdfSnapshotMarkdown(pdfRelativePath: string, page: number, imageRelativePath: string) {
  return `![PDF snapshot from ${pdfRelativePath} page ${page}](${imageRelativePath})\n\n_Source: ${pdfRelativePath} (page ${page})_\n`;
}

export function appendMarkdownBlock(content: string, block: string) {
  const trimmed = content.trimEnd();
  if (!trimmed) return `${block.trimEnd()}\n`;
  return `${trimmed}\n\n${block.trimEnd()}\n`;
}

function maxNodeExtent(nodes: CanvasNode[]) {
  return nodes.reduce(
    (max, node) => ({
      x: Math.max(max.x, node.position.x + node.width),
      y: Math.max(max.y, node.position.y + node.height),
    }),
    { x: 120, y: 120 },
  );
}

export function appendPdfQuoteTextNode(canvas: CanvasData, text: string) {
  const max = maxNodeExtent(canvas.nodes);
  const node: CanvasNode = {
    id: crypto.randomUUID(),
    type: 'text',
    content: text,
    position: { x: max.x + 32, y: max.y + 32 },
    width: 360,
    height: 220,
  };
  return {
    ...canvas,
    nodes: [...canvas.nodes, node],
  };
}

export function appendPdfSnapshotFileNode(canvas: CanvasData, imageRelativePath: string) {
  const max = maxNodeExtent(canvas.nodes);
  const node: CanvasNode = {
    id: crypto.randomUUID(),
    type: 'file',
    relativePath: imageRelativePath,
    position: { x: max.x + 32, y: max.y + 32 },
    width: 320,
    height: 240,
  };
  return {
    ...canvas,
    nodes: [...canvas.nodes, node],
  };
}
