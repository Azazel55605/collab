import { beforeEach, describe, expect, it } from 'vitest';

import { buildFixtureDeck, FIXTURE_IMAGE_PATH } from '../../../../src/lib/deck/fixture';
import type { HostedFileEntry } from '../mobileTauri';

import {
  clampDeckPan,
  clampDeckZoom,
  deckAssetFiles,
  deckName,
  fitDeckSlide,
  inspectDeckContent,
  isDeckFile,
  loadDeckViewState,
  saveDeckViewState,
  thumbnailColumns,
  visibleThumbnailRange,
  zoomDeckAbout,
} from './deck';

function entry(overrides: Partial<HostedFileEntry>): HostedFileEntry {
  return {
    id: 'f',
    parentId: null,
    name: 'Talk.deck',
    relativePath: 'Talk.deck',
    kind: 'document',
    documentType: 'deck',
    state: 'active',
    updatedAt: null,
    sizeBytes: 1,
    contentHash: null,
    revisionSequence: 1,
    ...overrides,
  } as HostedFileEntry;
}

describe('mobile deck files', () => {
  it('recognizes presentations by document type or extension', () => {
    expect(isDeckFile(entry({}))).toBe(true);
    expect(isDeckFile(entry({ documentType: null }))).toBe(true);
    expect(isDeckFile(entry({ name: 'x.md', relativePath: 'x.md', documentType: 'note' }))).toBe(
      false,
    );
    expect(isDeckFile(entry({ kind: 'asset' }))).toBe(false);
    expect(deckName(entry({}))).toBe('Talk');
  });

  it('parses a stored deck and refuses malformed text', () => {
    const inspected = inspectDeckContent(JSON.stringify(buildFixtureDeck()));
    expect(inspected.support).toBe('supported');
    expect(inspected.document.slideOrder).toHaveLength(5);
    expect(() => inspectDeckContent('{not json')).toThrow();
  });

  it('finds the vault file for each image and lists the missing ones', () => {
    const deck = buildFixtureDeck();
    const image = entry({
      id: 'img',
      name: 'deck-fixture.png',
      relativePath: FIXTURE_IMAGE_PATH.toUpperCase(),
      kind: 'asset',
      documentType: null,
    });
    expect(deckAssetFiles(deck, [image]).found.get(FIXTURE_IMAGE_PATH)?.id).toBe('img');
    expect(deckAssetFiles(deck, []).missing).toEqual([FIXTURE_IMAGE_PATH]);
  });
});

describe('touch zoom and pan', () => {
  it('never zooms out past fit and keeps the slide covering the frame', () => {
    expect(clampDeckZoom(0.2)).toBe(1);
    expect(clampDeckZoom(99)).toBe(5);
    expect(clampDeckZoom(Number.NaN)).toBe(1);
    expect(clampDeckPan({ zoom: 1, panX: 50, panY: -20 }, 400, 225)).toEqual({
      zoom: 1,
      panX: 0,
      panY: 0,
    });
    // At 2x a 400px-wide slide can move 200px either way, no further.
    expect(clampDeckPan({ zoom: 2, panX: 500, panY: -500 }, 400, 225)).toEqual({
      zoom: 2,
      panX: 200,
      panY: -112.5,
    });
  });

  it('zooms about the fingers so the content under them stays put', () => {
    const zoomed = zoomDeckAbout({ zoom: 1, panX: 0, panY: 0 }, 2, 100, 50, 400, 225);
    expect(zoomed).toEqual({ zoom: 2, panX: -100, panY: -50 });
    // The slide point under the fingers is the same before and after.
    expect((100 - zoomed.panX) / zoomed.zoom).toBe(100);
    expect(zoomDeckAbout(zoomed, 1, 0, 0, 400, 225)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('fits a slide into the frame at its aspect', () => {
    expect(fitDeckSlide(400, 800, 16 / 9)).toEqual({ width: 400, height: 225 });
    expect(fitDeckSlide(800, 300, 16 / 9)).toEqual({ width: 533, height: 300 });
    expect(fitDeckSlide(0, 300, 16 / 9)).toEqual({ width: 0, height: 0 });
  });
});

describe('thumbnail windowing', () => {
  it('mounts only the rows near the viewport', () => {
    expect(visibleThumbnailRange(0, 600, 150, 250)).toEqual({ start: 0, end: 6 });
    expect(visibleThumbnailRange(15_000, 600, 150, 250)).toEqual({ start: 98, end: 106 });
    expect(visibleThumbnailRange(99_999, 600, 150, 250)).toEqual({ start: 250, end: 250 });
    expect(visibleThumbnailRange(0, 600, 150, 0)).toEqual({ start: 0, end: 0 });
  });

  it('adds columns as the screen widens', () => {
    expect(thumbnailColumns(320)).toBe(1);
    expect(thumbnailColumns(412)).toBe(2);
    expect(thumbnailColumns(800)).toBe(3);
    expect(thumbnailColumns(1280)).toBe(4);
  });
});

describe('view state', () => {
  beforeEach(() => sessionStorage.clear());

  it('survives process recreation and tolerates a corrupt store', () => {
    expect(loadDeckViewState('f')).toBeNull();
    saveDeckViewState('f', {
      slideId: 'slide-3',
      mode: 'slide',
      notes: true,
      viewport: { zoom: 2, panX: 10, panY: 5 },
    });
    expect(loadDeckViewState('f')).toEqual({
      slideId: 'slide-3',
      mode: 'slide',
      notes: true,
      viewport: { zoom: 2, panX: 10, panY: 5 },
    });
    sessionStorage.setItem('collab.deck.viewState', '{broken');
    expect(loadDeckViewState('f')).toBeNull();
  });
});
