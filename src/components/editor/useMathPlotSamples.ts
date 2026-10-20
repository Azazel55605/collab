import { useEffect, useState } from 'react';

import type { MathPlotSpec, Sampled2DPlot, Sampled3DPlot } from './mathPlotSpec';
import { sampleMathPlot } from './mathWorkerClient';

// Immutable sampled data only; bounded to 12 entries / about 100k points.
const cache = new Map<string, Sampled2DPlot | Sampled3DPlot>();
export function useMathPlotSamples(spec: MathPlotSpec, active: boolean) {
  const key = JSON.stringify(spec);
  const [state, setState] = useState<{
    key: string;
    sampled?: Sampled2DPlot | Sampled3DPlot;
    error?: string;
  }>({ key });
  useEffect(() => {
    if (!active) return;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      setState({ key, sampled: cached });
      return;
    }
    const request = new AbortController();
    setState({ key });
    void sampleMathPlot(JSON.parse(key) as MathPlotSpec, request.signal)
      .then((sampled) => {
        if (request.signal.aborted) return;
        cache.set(key, sampled);
        while (cache.size > 12) cache.delete(cache.keys().next().value!);
        setState({ key, sampled });
      })
      .catch((error) => {
        if (!request.signal.aborted)
          setState({ key, error: error instanceof Error ? error.message : String(error) });
      });
    return () => request.abort();
  }, [key, active]);
  return state.key === key ? state : { key };
}
