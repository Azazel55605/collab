import { BoundedWorkerPool } from '../../lib/boundedWorkerPool';

import type { MathPlotSpec, Sampled2DPlot, Sampled3DPlot } from './mathPlotSpec';
import type { MathInputAnalysis, MathSolveMode, MathSolveResult } from './mathSolver';

export type MathRequest =
  | { kind: 'sample'; spec: MathPlotSpec }
  | { kind: 'solve'; source: string; mode: MathSolveMode; variable?: string };
export interface MathEvaluation {
  analysis: MathInputAnalysis;
  result: MathSolveResult | null;
}
const pool = new BoundedWorkerPool(
  () => new Worker(new URL('./math.worker.ts', import.meta.url), { type: 'module' }),
);
export function evaluateMath(
  source: string,
  mode: MathSolveMode,
  signal: AbortSignal,
  variable?: string,
) {
  if (source.length > 8192)
    return Promise.reject(new Error('Math expressions must be at most 8192 characters.'));
  return pool.run<MathEvaluation>({ kind: 'solve', source, mode, variable }, signal);
}
export function sampleMathPlot(spec: MathPlotSpec, signal: AbortSignal) {
  if (spec.expression.length > 8192)
    return Promise.reject(new Error('Math expressions must be at most 8192 characters.'));
  return pool.run<Sampled2DPlot | Sampled3DPlot>({ kind: 'sample', spec }, signal);
}
