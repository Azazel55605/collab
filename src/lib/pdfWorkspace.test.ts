import { describe, expect, it, vi } from 'vitest';

import {
  appendMarkdownBlock,
  appendPdfQuoteTextNode,
  appendPdfSnapshotFileNode,
  buildPdfQuoteMarkdown,
  buildPdfSnapshotMarkdown,
} from './pdfWorkspace';

describe('pdfWorkspace', () => {
  it('builds quote markdown with source context', () => {
    expect(buildPdfQuoteMarkdown('Docs/spec.pdf', 6, 'Alpha\nBeta')).toContain('> Source: Docs/spec.pdf (page 6)');
  });

  it('appends markdown blocks with spacing', () => {
    expect(appendMarkdownBlock('# Title', '> Quote')).toBe('# Title\n\n> Quote\n');
  });

  it('adds quote text nodes to canvas data', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001');
    const result = appendPdfQuoteTextNode({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, 'Hello');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ id: '00000000-0000-0000-0000-000000000001', type: 'text', content: 'Hello' });
  });

  it('adds snapshot file nodes to canvas data', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000002');
    const result = appendPdfSnapshotFileNode({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, 'Pictures/page.png');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ id: '00000000-0000-0000-0000-000000000002', type: 'file', relativePath: 'Pictures/page.png' });
  });

  it('builds snapshot markdown with source line', () => {
    expect(buildPdfSnapshotMarkdown('Docs/spec.pdf', 2, 'Pictures/page.png')).toContain('Source: Docs/spec.pdf (page 2)');
  });
});
