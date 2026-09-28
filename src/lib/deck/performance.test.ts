/**
 * Phase 0 scale proofs for `.deck`, against `DECK_PERFORMANCE_BUDGETS`.
 *
 * Each timing is the best of several runs after a warm-up, so a busy machine
 * does not fail a healthy build; set `COLLAB_DECK_BUDGET_SCALE` on a slow
 * runner rather than loosening the numbers.
 */
import { describe, expect, it } from 'vitest';

import { DECK_PERFORMANCE_BUDGETS, deckTimeBudget } from './budgets';
import type { DeckTimeBudgetKey } from './budgets';
import { buildScaleDeck } from './fixture';
import { exportDeckToPptx } from './pptx/exportDeckToPptx';
import { resolveDeck, resolveSlide } from './resolve';
import { renderSlideSvg } from './svg';
import { createApproximateMeasurer } from './textLayout';
import { parseDeck, serializeDeck, validateDeck } from './validate';

const SLIDES = 300;
const deck = buildScaleDeck(SLIDES);
const measurer = createApproximateMeasurer();

function best(run: () => unknown, runs = 5): number {
  run();
  let fastest = Infinity;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

function expectWithin(cost: number, key: DeckTimeBudgetKey): void {
  expect(cost, `${key} took ${cost.toFixed(1)} ms against ${deckTimeBudget(key)} ms`).toBeLessThan(
    deckTimeBudget(key),
  );
}

describe(`a ${SLIDES}-slide deck`, () => {
  const json = serializeDeck(deck);

  it('stays well inside the document size limit', () => {
    expect(new TextEncoder().encode(json).length).toBeLessThan(
      DECK_PERFORMANCE_BUDGETS.threeHundredSlideBytes,
    );
  });

  it('validates, serializes, and opens within budget', () => {
    expectWithin(
      best(() => validateDeck(deck)),
      'validateMs',
    );
    expectWithin(
      best(() => serializeDeck(deck)),
      'serializeMs',
    );
    expectWithin(
      best(() => parseDeck(json)),
      'openMs',
    );
  });

  it('resolves every slide within budget', () => {
    expectWithin(
      best(() => resolveDeck(deck)),
      'resolveDeckMs',
    );
  });

  it('renders one slide inside a frame and the whole deck within budget', () => {
    expectWithin(
      best(() => renderSlideSvg(resolveSlide(deck, 'scale-1'), { measurer }), 20),
      'slideSvgMs',
    );
    const slides = resolveDeck(deck);
    expectWithin(
      best(() => slides.map((slide) => renderSlideSvg(slide, { measurer })), 2),
      'deckSvgMs',
    );
  });

  it('exports to PowerPoint within budget', async () => {
    const started = performance.now();
    const result = await exportDeckToPptx(deck);
    expectWithin(performance.now() - started, 'pptxExportMs');
    expect(result.report.slides).toBe(SLIDES);
  }, 30_000);
});
