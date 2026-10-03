import { describe, expect, it } from 'vitest';

import { DECK_LIMITS, DECK_SIZE_PRESETS } from '../../types/deck';
import type { DeckDocument } from '../../types/deck';

import {
  createDeckDocument,
  createSlide,
  DeckDocumentError,
  deckDocumentStats,
  isDeckPath,
  normalizeDeckDocument,
  parseDeckDocument,
} from './document';
import { buildFixtureDeck, buildScaleDeck } from './fixture';
import { resolveSlide } from './resolve';
import { renderSlideSvg } from './svg';
import { createApproximateMeasurer } from './textLayout';
import { serializeDeck, validateDeck } from './validate';

const NOW = '2026-09-29T00:00:00.000Z';
const measurer = createApproximateMeasurer();

function newDeck(
  sizePreset?: Parameters<typeof createDeckDocument>[0]['sizePreset'],
): DeckDocument {
  return createDeckDocument({ id: 'deck-1', name: 'Talk', now: NOW, sizePreset });
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DeckDocumentError ? error.code : 'other';
  }
  return undefined;
}

describe('createDeckDocument', () => {
  it('creates a valid deck for every size preset', () => {
    for (const preset of ['widescreen', 'standard', 'a4', 'letter'] as const) {
      const deck = newDeck(preset);
      expect(validateDeck(deck).ok, preset).toBe(true);
      expect(deck.size).toEqual(DECK_SIZE_PRESETS[preset]);
    }
  });

  it('starts with one title slide and six reusable layouts', () => {
    const deck = newDeck();
    expect(deck.slideOrder).toEqual(['slide-1']);
    expect(deck.slides['slide-1'].layoutId).toBe('layout-title');
    expect(Object.values(deck.layouts).map((layout) => layout.name)).toEqual([
      'Title slide',
      'Title and content',
      'Two content',
      'Section header',
      'Title only',
      'Blank',
    ]);
    expect(deckDocumentStats(deck)).toEqual({
      slides: 1,
      hiddenSlides: 0,
      elements: 2,
      layouts: 6,
    });
  });

  it('resolves and renders a slide on every layout, with placeholders inheriting geometry', () => {
    const deck = newDeck();
    const placeholders = {
      'layout-title': ['title', 'subtitle'],
      'layout-content': ['title', 'body'],
      'layout-section': ['title'],
      'layout-title-only': ['title'],
      'layout-blank': [],
    } as const;
    for (const [layoutId, types] of Object.entries(placeholders)) {
      const slide = createSlide(`s-${layoutId}`, layoutId, [...types]);
      deck.slides[slide.id] = slide;
      deck.slideOrder.push(slide.id);
      const resolved = resolveSlide(deck, slide.id);
      expect(resolved.items.filter((item) => item.origin === 'slide')).toHaveLength(types.length);
      for (const item of resolved.items) expect(item.frame.width).toBeGreaterThan(0);
      expect(renderSlideSvg(resolved, { measurer })).toContain('<svg');
    }
    expect(validateDeck(deck).ok).toBe(true);
  });

  it('is deterministic', () => {
    expect(serializeDeck(newDeck())).toBe(serializeDeck(newDeck()));
  });
});

describe('parseDeckDocument', () => {
  it('round-trips a created deck and the fixture without warnings', () => {
    for (const deck of [newDeck(), buildFixtureDeck()]) {
      const parsed = parseDeckDocument(serializeDeck(deck));
      expect(parsed.support).toBe('supported');
      expect(parsed.warnings).toEqual([]);
      expect(serializeDeck(parsed.document)).toBe(serializeDeck(deck));
    }
  });

  it('repairs ordering damage and reports every repair', () => {
    const deck = buildFixtureDeck() as unknown as Record<string, unknown> & DeckDocument;
    deck.slideOrder = ['slide-1', 'ghost', 'slide-2', 'slide-2'];
    deck.slides['slide-5'].elementOrder = ['s5-title', 'missing'];
    deck.slides['slide-2'].layoutId = 'layout-gone';
    const { document, warnings } = normalizeDeckDocument(deck);
    expect(document.slideOrder).toEqual(['slide-1', 'slide-2', 'slide-3', 'slide-4', 'slide-5']);
    expect(document.slides['slide-5'].elementOrder).toEqual(['s5-title', 's5-chart', 's5-note']);
    expect(document.slides['slide-2'].layoutId).toBeUndefined();
    expect(warnings).toEqual(
      expect.arrayContaining([
        'invalid or duplicate slide-order entries were dropped',
        "slide 'slide-3' was missing from the slide order and was appended",
        "slide 'slide-5': element 's5-chart' was missing from the paint order and was appended",
        "slide 'slide-2' used a missing layout; it now uses its master directly",
      ]),
    );
  });

  it('corrects mismatched element ids and drops missing group children', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-3'].elements['s3-card'].id = 'wrong';
    const group = deck.slides['slide-3'].elements['s3-group'];
    if (group.type !== 'group') throw new Error('fixture changed');
    group.childIds.push('nobody');
    const { document, warnings } = normalizeDeckDocument(deck);
    expect(document.slides['slide-3'].elements['s3-card'].id).toBe('s3-card');
    expect(warnings.join('\n')).toMatch(/mismatched id/);
    expect(warnings.join('\n')).toMatch(/missing or shared children/);
  });

  it('repairs stale accessibility reading order without changing paint order', () => {
    const deck = buildFixtureDeck();
    const slide = deck.slides['slide-3'];
    const paintOrder = [...slide.elementOrder];
    slide.readingOrder = ['s3-image', 'missing', 's3-image', 's3-title'];
    const { document, warnings } = normalizeDeckDocument(deck);
    expect(document.slides['slide-3'].readingOrder).toEqual(['s3-image', 's3-title']);
    expect(document.slides['slide-3'].elementOrder).toEqual(paintOrder);
    expect(warnings.join('\n')).toMatch(/reading-order entries were dropped/);
  });

  it('adds a blank slide, a theme, and a master rather than refusing an empty deck', () => {
    const empty = {
      kind: 'collab-deck',
      schemaVersion: 1,
      id: 'd',
      name: 'Empty',
      createdAt: NOW,
      updatedAt: NOW,
      size: DECK_SIZE_PRESETS.widescreen,
    };
    const { document, warnings } = normalizeDeckDocument(empty);
    expect(document.slideOrder).toHaveLength(1);
    expect(Object.keys(document.masters)).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/no slides/);
    expect(() => resolveSlide(document, document.slideOrder[0])).not.toThrow();
  });

  it('never mutates its input', () => {
    const deck = buildFixtureDeck();
    deck.slideOrder = ['slide-2'];
    const before = serializeDeck(deck);
    normalizeDeckDocument(deck);
    expect(serializeDeck(deck)).toBe(before);
  });

  it('opens a newer schema version read-only and untouched', () => {
    const future = { kind: 'collab-deck', schemaVersion: 2, holograms: [1, 2, 3] };
    const inspection = normalizeDeckDocument(future);
    expect(inspection.support).toBe('newer');
    expect(inspection.document).toBe(future);
  });

  it('refuses what it cannot repair, with a specific code', () => {
    expect(errorCode(() => parseDeckDocument('{'))).toBe('invalid-json');
    expect(errorCode(() => parseDeckDocument('[]'))).toBe('not-an-object');
    expect(errorCode(() => normalizeDeckDocument({ kind: 'collab-ink', schemaVersion: 1 }))).toBe(
      'wrong-kind',
    );
    expect(errorCode(() => normalizeDeckDocument({ kind: 'collab-deck', schemaVersion: 0 }))).toBe(
      'invalid-schema-version',
    );
    const nan = buildFixtureDeck();
    nan.slides['slide-5'].elements['s5-note'].frame!.x = Number.NaN;
    expect(errorCode(() => normalizeDeckDocument(nan))).toBe('invalid-structure');
    const long = buildFixtureDeck();
    const note = long.slides['slide-5'].elements['s5-note'];
    if (note.type === 'text')
      note.text.content.paragraphs[0].runs = [
        { kind: 'text', text: 'x'.repeat(DECK_LIMITS.textPerBody + 1) },
      ];
    expect(errorCode(() => normalizeDeckDocument(long))).toBe('limit-exceeded');
  });

  it('refuses a deck the hosted parser would reject', () => {
    // 1,000 simple slides is about 132,000 JSON entries, over the server cap.
    expect(errorCode(() => normalizeDeckDocument(buildScaleDeck(1_000)))).toBe('limit-exceeded');
    expect(normalizeDeckDocument(buildScaleDeck(300)).support).toBe('supported');
  });
});

describe('isDeckPath', () => {
  it('matches the extension case-insensitively', () => {
    expect(isDeckPath('Talks/Q3.DECK')).toBe(true);
    expect(isDeckPath('Talks/q3.deck.md')).toBe(false);
  });
});
