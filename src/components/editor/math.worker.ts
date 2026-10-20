/// <reference lib="webworker" />
import { samplePlot2D, samplePlot3D } from './mathPlotSampling';
import { analyzeMathInput, solveMathInput } from './mathSolver';
import type { MathRequest } from './mathWorkerClient';

self.onmessage = (event: MessageEvent<MathRequest>) => {
  try {
    const request = event.data;
    const source = request.kind === 'sample' ? request.spec.expression : request.source;
    if (typeof source !== 'string' || source.length > 8192)
      throw new Error('Math expressions must be at most 8192 characters.');
    let result;
    if (request.kind === 'sample') {
      const { spec } = request;
      for (const domain of [spec.x, spec.kind === '3d' ? spec.y : undefined]) {
        if (
          domain &&
          (!Number.isFinite(domain.min) || !Number.isFinite(domain.max) || domain.min >= domain.max)
        )
          throw new Error('Invalid plot domain.');
      }
      if (!Number.isFinite(spec.samples)) throw new Error('Invalid sample count.');
      result = spec.kind === '2d' ? samplePlot2D(spec) : samplePlot3D(spec);
    } else {
      const analysis = analyzeMathInput(request.source);
      result =
        analysis.kind === 'equation' &&
        !analysis.defaultVariable &&
        analysis.variables.length > 1 &&
        !request.variable
          ? { analysis, result: null }
          : { analysis, result: solveMathInput(request.source, request.mode, request.variable) };
    }
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
