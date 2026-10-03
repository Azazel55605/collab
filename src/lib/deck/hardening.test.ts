/** Phase 10 workload and hostile-document release gates. */
import { describe, expect, it } from 'vitest';

import type { DeckChartElement, DeckDocument, DeckImageElement } from '../../types/deck';

import { normalizeDeckDocument } from './document';
import { buildScaleDeck, FIXTURE_IMAGE_PATH } from './fixture';
import { resolveSlide } from './resolve';
import { renderSlideSvg } from './svg';
import { createApproximateMeasurer } from './textLayout';
import { parseDeck, serializeDeck, validateDeck } from './validate';

const measurer = createApproximateMeasurer();

function imageHeavyDeck(): DeckDocument {
  const deck = buildScaleDeck(120);
  for (const slide of Object.values(deck.slides)) {
    for (let index = 0; index < 12; index += 1) {
      const id = `${slide.id}-image-${index}`;
      const image: DeckImageElement = {
        id,
        type: 'image',
        name: `Product image ${index + 1}`,
        altText: `Product image ${index + 1}`,
        frame: {
          x: 4_000 + (index % 4) * 21_000,
          y: 13_000 + Math.floor(index / 4) * 12_000,
          width: 18_000,
          height: 9_000,
        },
        asset: {
          path: FIXTURE_IMAGE_PATH,
          mediaType: 'image/png',
          pixelWidth: 1_600,
          pixelHeight: 1_000,
        },
      };
      slide.elements[id] = image;
      slide.elementOrder.push(id);
    }
  }
  return deck;
}

function textHeavyDeck(): DeckDocument {
  const deck = buildScaleDeck(120);
  for (const slide of Object.values(deck.slides)) {
    const body = slide.elements[`${slide.id}-body`];
    if (body.type !== 'text') throw new Error('scale fixture changed');
    body.text.content.paragraphs[0].runs = [
      { kind: 'text', text: 'Accessible long-form presentation text. '.repeat(180) },
    ];
  }
  return deck;
}

function chartHeavyDeck(): DeckDocument {
  const deck = buildScaleDeck(60);
  for (const slide of Object.values(deck.slides)) {
    const id = `${slide.id}-chart`;
    const categories = Array.from({ length: 100 }, (_, index) => `Q${index + 1}`);
    const chart: DeckChartElement = {
      id,
      type: 'chart',
      kind: 'line',
      title: `Trend for ${slide.id}`,
      altText: `Line chart showing ten deterministic series across 100 quarters`,
      frame: { x: 4_000, y: 13_000, width: 82_000, height: 34_000 },
      categories,
      series: Array.from({ length: 10 }, (_, series) => ({
        id: `${id}-series-${series}`,
        name: `Series ${series + 1}`,
        values: categories.map((_, point) => (point * (series + 3)) % 97),
      })),
      showLegend: true,
    };
    slide.elements[id] = chart;
    slide.elementOrder.push(id);
  }
  return deck;
}

describe('Phase 10 presentation hardening workloads', () => {
  it.each([
    ['image-heavy', imageHeavyDeck],
    ['text-heavy', textHeavyDeck],
    ['chart-heavy', chartHeavyDeck],
  ] as const)(
    'opens, round-trips, and renders a %s deck',
    (_name, build) => {
      const deck = build();
      expect(validateDeck(deck).ok).toBe(true);
      const result = parseDeck(serializeDeck(deck));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.issues[0]?.message);
      const reopened = result.deck;
      expect(reopened.slideOrder).toHaveLength(deck.slideOrder.length);
      for (const slideId of [
        reopened.slideOrder[0],
        reopened.slideOrder[reopened.slideOrder.length - 1],
      ]) {
        expect(renderSlideSvg(resolveSlide(reopened, slideId), { measurer })).toContain('<svg');
      }
    },
    20_000,
  );

  it('rejects malformed and adversarial variants at the document boundary', () => {
    const mutations: Array<(deck: DeckDocument) => void> = [
      (deck) => {
        deck.size.width = Number.NaN;
      },
      (deck) => {
        deck.slideOrder.push(deck.slideOrder[0]);
      },
      (deck) => {
        deck.slides['scale-1'].elementOrder.push('missing');
      },
      (deck) => {
        deck.slides['scale-1'].elements['scale-1-title'].frame = {
          x: 0,
          y: 0,
          width: Number.POSITIVE_INFINITY,
          height: 100,
        };
      },
      (deck) => {
        deck.slides['scale-1'].readingOrder = ['missing'];
      },
    ];
    for (const mutate of mutations) {
      const deck = buildScaleDeck(3);
      mutate(deck);
      expect(validateDeck(deck).ok).toBe(false);
      try {
        const repaired = normalizeDeckDocument(deck);
        expect(validateDeck(repaired.document).ok).toBe(true);
        expect(repaired.warnings.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
