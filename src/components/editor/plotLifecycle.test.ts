import { afterEach, expect, it, vi } from 'vitest';

import {
  createPlotInvalidator,
  hasPlotLease,
  PLOT_RENDERER_LIMIT,
  prioritizePlotLease,
  requestPlotLease,
} from './plotLifecycle';

afterEach(() => vi.restoreAllMocks());
it('renders only after invalidation and coalesces camera/resize changes', () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame');
  const draw = vi.fn();
  const scheduler = createPlotInvalidator(draw);
  scheduler.invalidate();
  scheduler.invalidate();
  expect(callbacks).toHaveLength(1);
  callbacks.shift()!(0);
  expect(draw).toHaveBeenCalledOnce();
  expect(callbacks).toHaveLength(0);
  scheduler.invalidate();
  scheduler.dispose();
  expect(cancel).toHaveBeenCalled();
  callbacks.shift()!(1);
  scheduler.invalidate();
  expect(draw).toHaveBeenCalledOnce();
  expect(callbacks).toHaveLength(0);
});
it('bounds renderer admission and lets a waiting visible plot recover a lease', () => {
  const ids = Array.from({ length: 12 }, () => Symbol());
  const release = ids.map(requestPlotLease);
  expect(ids.filter(hasPlotLease)).toHaveLength(PLOT_RENDERER_LIMIT);
  expect(hasPlotLease(ids[0])).toBe(false);
  prioritizePlotLease(ids[0]);
  expect(hasPlotLease(ids[0])).toBe(true);
  expect(ids.filter(hasPlotLease)).toHaveLength(PLOT_RENDERER_LIMIT);
  release.forEach((dispose) => dispose());
  expect(ids.some(hasPlotLease)).toBe(false);
});
