/**
 * Performance budgets for `.ink` documents.
 *
 * These mirror the budget table in
 * `docs/plans/digital-ink-phase0-contract.md`. That document records the
 * measured Phase 0 baselines; this module is the executable half — the numbers
 * assertions run against. Change one and change the other.
 *
 * They are ceilings, not targets. The measured baselines sit well below them so
 * an ordinary slow machine still passes while an order-of-magnitude regression
 * fails.
 */

export interface InkPerformanceBudgets {
  /** Capture pipeline for one completed handwriting stroke. */
  strokeCaptureMs: number;
  /** Outline generation for one stroke, the per-frame rendering cost. */
  strokeOutlineMs: number;
  /** Parse plus decode of a 10,000-stroke page. */
  pageOpenMs: number;
  /** Serializing a 10,000-stroke page for a save. */
  pageSerializeMs: number;
  /** Deciding which tiles a viewport needs and which an edit dirtied. */
  tileResolveMs: number;
  /**
   * Re-outlining the strokes in one dirty tile — the actual per-frame cost of
   * an edit, and the number that has to fit inside a frame.
   */
  tileRepaintMs: number;
  /**
   * Outlining every stroke a viewport can see. This is a *cold* cost paid on
   * first paint and after a zoom change, not per frame: at Phase 0 density it
   * is nearly two frames' worth of work, which is the whole reason the
   * renderer is tile-cached rather than redrawn.
   */
  viewportOutlineMs: number;
  /** Hit-testing a tap against a 10,000-stroke page through the index. */
  hitTestMs: number;
  /** Deterministic SVG export of a 10,000-stroke page. */
  svgExportMs: number;
  /** Stored bytes for a 10,000-stroke page. */
  tenThousandStrokeBytes: number;
}

export const INK_PERFORMANCE_BUDGETS: Readonly<InkPerformanceBudgets> = {
  strokeCaptureMs: 4,
  strokeOutlineMs: 2,
  pageOpenMs: 1_500,
  pageSerializeMs: 750,
  tileResolveMs: 4,
  tileRepaintMs: 8,
  viewportOutlineMs: 120,
  hitTestMs: 8,
  svgExportMs: 3_000,
  tenThousandStrokeBytes: 24 * 1024 * 1024,
};

/**
 * Multiplier applied to every time budget, from `COLLAB_INK_BUDGET_SCALE`.
 *
 * Shared CI runners and Android emulators are several times slower than the
 * machine the baselines were measured on. Rather than loosening the published
 * budgets for everyone, a slow environment sets this scale and the platform
 * matrix records which scale that platform was validated at. Byte budgets are
 * not scaled — a slower device does not get to store more.
 */
export function inkBudgetScale(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): number {
  const raw = Number(env.COLLAB_INK_BUDGET_SCALE);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 20);
}

export type InkTimeBudgetKey = {
  [K in keyof InkPerformanceBudgets]: K extends `${string}Ms` ? K : never;
}[keyof InkPerformanceBudgets];

/** The effective ceiling for a time budget on the current machine. */
export function inkTimeBudget(key: InkTimeBudgetKey): number {
  return INK_PERFORMANCE_BUDGETS[key] * inkBudgetScale();
}
