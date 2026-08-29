/**
 * The alternative stroke outliner, for the Phase 0 comparison.
 *
 * `perfect-freehand` (MIT, no dependencies) is the obvious third-party
 * candidate for turning a pressure-sampled centre line into an outline. This
 * module is the whole of its integration: it translates Collab samples into
 * the shape that library wants and translates the result back. Nothing else in
 * the codebase imports it.
 *
 * Keeping the adapter around after the decision is deliberate. It is the proof
 * that `InkStrokeOutliner` is genuinely a seam and not a type that happens to
 * have one implementation, and it is what a future replacement would be
 * written against. See `docs/plans/digital-ink-phase0-contract.md` for the
 * measured comparison and the decision.
 */
import getStroke from 'perfect-freehand';

import { INK_SAMPLE_RANGES } from '../../types/ink';
import type { InkSample } from '../../types/ink';

import type { InkPoint, InkStrokeOutliner } from './stroke';

/**
 * `perfect-freehand` reads pressure as 0..1 and treats a missing value as 0.5.
 * Collab distinguishes "unreported" from "half", so an unreported channel is
 * passed with simulation left to the library only when the brush asked for it.
 */
function toFreehandPoints(samples: InkSample[]): number[][] {
  return samples.map((sample) => [
    sample.x,
    sample.y,
    sample.pressure === undefined ? 0.5 : sample.pressure / INK_SAMPLE_RANGES.pressureMax,
  ]);
}

export const outlineStrokeWithPerfectFreehand: InkStrokeOutliner = (samples, brush) => {
  if (samples.length === 0) return [];
  const hasReportedPressure = samples.some((sample) => sample.pressure !== undefined);
  const outline = getStroke(toFreehandPoints(samples), {
    size: brush.width,
    thinning: brush.thinning,
    smoothing: brush.smoothing,
    streamline: 0, // Collab streamlines during capture; doing it twice lags the line.
    simulatePressure: !hasReportedPressure && brush.simulatePressure === true,
    start: { taper: brush.taperStart, cap: true },
    end: { taper: brush.taperEnd, cap: true },
  });
  return outline.map(([x, y]) => ({ x, y }) as InkPoint);
};

/** Registry of the outliners Phase 0 compared. */
export const INK_STROKE_OUTLINERS = {
  firstParty: 'firstParty',
  perfectFreehand: 'perfectFreehand',
} as const;

export type InkStrokeOutlinerId = (typeof INK_STROKE_OUTLINERS)[keyof typeof INK_STROKE_OUTLINERS];
