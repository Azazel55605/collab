/**
 * Phase 9 performance budgets for `.sheet` workbooks.
 *
 * These mirror the "Phase 9 budgets" table in
 * `docs/plans/advanced-tables-phase0-contract.md`. That document records the
 * measured Phase 0 baselines; this module is the executable half — the numbers
 * assertions run against. Change one and change the other.
 *
 * The budgets are ceilings, not targets: the measured baselines sit well below
 * them so an ordinary slow machine still passes while an order-of-magnitude
 * regression fails.
 */

export interface SheetPerformanceBudgets {
  /** Parse + normalize + index a 100,000-cell workbook. */
  firstOpenMs: number;
  /** Viewport computation plus cell resolution for one frame, excluding paint. */
  scrollFrameMs: number;
  /** Recalculation after a single edit. */
  interactiveRecalcMs: number;
  /** Cold full recalculation of a 100,000-cell workbook. */
  coldRecalcMs: number;
  /** Serializing a workbook for a save. */
  saveSerializeMs: number;
  /** Pasting 10,000 cells into a worksheet. */
  pasteTenThousandCellsMs: number;
  /** Resident memory over baseline for a 100,000-cell workbook. */
  residentMemoryOverBaselineBytes: number;
}

export const SHEET_PERFORMANCE_BUDGETS: Readonly<SheetPerformanceBudgets> = {
  firstOpenMs: 1_500,
  scrollFrameMs: 4,
  interactiveRecalcMs: 50,
  coldRecalcMs: 2_000,
  saveSerializeMs: 250,
  pasteTenThousandCellsMs: 500,
  residentMemoryOverBaselineBytes: 250 * 1024 * 1024,
};

/**
 * Multiplier applied to every time budget, from `COLLAB_SHEET_BUDGET_SCALE`.
 *
 * Shared CI runners and emulators are several times slower than the machine the
 * baselines were measured on. Rather than loosening the published budgets for
 * everyone, a slow environment sets this scale and the platform matrix records
 * which scale that platform was validated at. Memory is not scaled — a device
 * with less headroom does not get to use more of it.
 */
export function sheetBudgetScale(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): number {
  const raw = Number(env.COLLAB_SHEET_BUDGET_SCALE);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 20);
}

export type SheetTimeBudgetKey = {
  [K in keyof SheetPerformanceBudgets]: K extends `${string}Ms` ? K : never;
}[keyof SheetPerformanceBudgets];

/** The effective ceiling for a time budget on the current machine. */
export function sheetTimeBudget(key: SheetTimeBudgetKey): number {
  return SHEET_PERFORMANCE_BUDGETS[key] * sheetBudgetScale();
}
