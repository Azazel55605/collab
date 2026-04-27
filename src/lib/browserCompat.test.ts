import { describe, expect, it, vi } from 'vitest';
import { subscribeMediaQueryChange } from './browserCompat';

describe('subscribeMediaQueryChange', () => {
  it('uses modern addEventListener when available', () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const query = {
      addEventListener,
      removeEventListener,
    } as unknown as MediaQueryList;
    const listener = vi.fn();

    const unsubscribe = subscribeMediaQueryChange(query, listener);

    expect(addEventListener).toHaveBeenCalledWith('change', listener);
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith('change', listener);
  });

  it('falls back to addListener/removeListener for older WebKit media queries', () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    const query = {
      addListener,
      removeListener,
    } as unknown as MediaQueryList;
    const listener = vi.fn();

    const unsubscribe = subscribeMediaQueryChange(query, listener);

    expect(addListener).toHaveBeenCalledWith(listener);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
});
