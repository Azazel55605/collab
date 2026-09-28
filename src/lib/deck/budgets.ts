/**
 * Performance budgets for `.deck` documents.
 *
 * These mirror the budget table in `docs/plans/presentation-phase0-contract.md`,
 * which records the measured Phase 0 baselines. They are ceilings roughly ten
 * times above those baselines: an ordinary slow machine passes, an
 * order-of-magnitude regression fails. Change one and change the other.
 */

export interface DeckPerformanceBudgets {
  /** Validate a 300-slide deck (the trust boundary on every open). */
  validateMs: number;
  /** Serialize a 300-slide deck for a save. */
  serializeMs: number;
  /** Parse and validate a 300-slide deck. */
  openMs: number;
  /** Resolve every slide of a 300-slide deck. */
  resolveDeckMs: number;
  /** Resolve and render one slide to SVG — a thumbnail or playback frame. */
  slideSvgMs: number;
  /** Render all 300 slides to SVG, as a full thumbnail rail or PDF export does. */
  deckSvgMs: number;
  /** Export 300 slides to `.pptx`, cold. */
  pptxExportMs: number;
  /** Stored bytes for a 300-slide deck. */
  threeHundredSlideBytes: number;
}

export const DECK_PERFORMANCE_BUDGETS: Readonly<DeckPerformanceBudgets> = {
  validateMs: 20,
  serializeMs: 100,
  openMs: 150,
  resolveDeckMs: 50,
  slideSvgMs: 8,
  deckSvgMs: 1_500,
  pptxExportMs: 5_000,
  threeHundredSlideBytes: 4 * 1024 * 1024,
};

export type DeckTimeBudgetKey = Exclude<keyof DeckPerformanceBudgets, 'threeHundredSlideBytes'>;

/** Multiplier from `COLLAB_DECK_BUDGET_SCALE`, for slow runners. Byte budgets never scale. */
export function deckBudgetScale(): number {
  const raw = typeof process !== 'undefined' ? process.env?.COLLAB_DECK_BUDGET_SCALE : undefined;
  const value = raw === undefined ? 1 : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function deckTimeBudget(key: DeckTimeBudgetKey): number {
  return DECK_PERFORMANCE_BUDGETS[key] * deckBudgetScale();
}
