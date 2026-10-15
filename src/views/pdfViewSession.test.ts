import { describe, expect, it } from 'vitest';

import {
  buildPdfPageRenderCacheKey,
  buildPdfViewerState,
  flushPdfViewerStates,
  readPdfViewerState,
  rememberPdfViewerState,
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

it('keeps PDF view state across viewers with bounded identity-scoped retention', () => {
  const state = buildPdfViewerState({
    pageNumber: 5,
    zoomMode: 'custom',
    zoom: 2,
    rotation: 90,
    layoutMode: 'scroll',
    bookmarksOpen: false,
  });
  rememberPdfViewerState('server/account/doc.pdf', state);
  expect(readPdfViewerState('server/account/doc.pdf')).toEqual(state);
  expect(readPdfViewerState('other/account/doc.pdf')).toBeUndefined();
  for (let i = 0; i < 128; i++) rememberPdfViewerState(`recent-${i}`, state);
  expect(readPdfViewerState('server/account/doc.pdf')).toBeUndefined();
  flushPdfViewerStates();
});
