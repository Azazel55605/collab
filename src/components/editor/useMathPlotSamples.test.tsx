import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { MathPlot2DSpec, Sampled2DPlot } from './mathPlotSpec';
import { sampleMathPlot } from './mathWorkerClient';
import { useMathPlotSamples } from './useMathPlotSamples';

vi.mock('./mathWorkerClient', () => ({ sampleMathPlot: vi.fn() }));
it('cancels superseded domains and never publishes obsolete samples', async () => {
  const requests: Array<{ signal: AbortSignal; resolve: (value: Sampled2DPlot) => void }> = [];
  vi.mocked(sampleMathPlot).mockImplementation(
    (_spec, signal) => new Promise((resolve) => requests.push({ signal, resolve })),
  );
  const spec: MathPlot2DSpec = {
    kind: '2d',
    expression: 'x',
    x: { min: -123, max: 123 },
    samples: 20,
  };
  const rendered = renderHook(({ spec, active }) => useMathPlotSamples(spec, active), {
    initialProps: { spec, active: true },
  });
  const latest = { ...spec, x: { min: -124, max: 124 } };
  rendered.rerender({ spec: latest, active: true });
  expect(requests[0].signal.aborted).toBe(true);
  await act(async () => {
    requests[0].resolve({ spec, segments: [], yDomain: spec.x });
  });
  expect(rendered.result.current.sampled).toBeUndefined();
  await act(async () => {
    requests[1].resolve({ spec: latest, segments: [], yDomain: latest.x });
  });
  await waitFor(() => expect(rendered.result.current.sampled?.spec).toEqual(latest));
  rendered.rerender({ spec: latest, active: false });
  expect(requests[1].signal.aborted).toBe(true);
  rendered.rerender({ spec: latest, active: true });
  expect(sampleMathPlot).toHaveBeenCalledTimes(2);
});
