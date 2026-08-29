import { describe, expect, it } from 'vitest';

import {
  buildPdfPageRenderCacheKey,
  buildPdfViewerState,
  resolvePdfBookmarksOpen,
} from './pdfViewSession';

describe('pdfViewSession helpers', () => {
  it('builds stable cache keys for page renders', () => {
    expect(buildPdfPageRenderCacheKey('vault/doc.pdf', 3, 1.23456, 90)).toBe(
      'vault/doc.pdf::3::1.2346::90',
    );
  });

  it('defaults bookmarks panel to open unless persisted closed', () => {
    expect(resolvePdfBookmarksOpen(undefined)).toBe(true);
    expect(resolvePdfBookmarksOpen({ lastBookmarksOpen: false })).toBe(false);
  });

  it('includes bookmarks panel visibility in persisted viewer state', () => {
    expect(
      buildPdfViewerState({
        pageNumber: 4,
        zoomMode: 'fit-width',
        zoom: 1.2,
        layoutMode: 'single',
        rotation: 90,
        bookmarksOpen: false,
      }).lastBookmarksOpen,
    ).toBe(false);
  });
});
