import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backDismissDepth,
  clearBackDismissStack,
  pushBackDismiss,
  runTopBackDismiss,
} from './backStack';

describe('back dismiss stack', () => {
  beforeEach(() => {
    clearBackDismissStack();
  });

  it('reports that nothing handled the press when empty', () => {
    expect(runTopBackDismiss()).toBe(false);
  });

  it('unwinds surfaces in the reverse of the order they were opened', () => {
    const order: string[] = [];
    pushBackDismiss(() => order.push('screen'));
    pushBackDismiss(() => order.push('sheet'));
    pushBackDismiss(() => order.push('menu'));

    expect(runTopBackDismiss()).toBe(true);
    expect(runTopBackDismiss()).toBe(true);
    expect(runTopBackDismiss()).toBe(true);
    expect(runTopBackDismiss()).toBe(false);
    expect(order).toEqual(['menu', 'sheet', 'screen']);
  });

  it('runs each registration only once', () => {
    const dismiss = vi.fn();
    pushBackDismiss(dismiss);
    runTopBackDismiss();
    runTopBackDismiss();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('removes a registration when its surface closes on its own', () => {
    const closed = vi.fn();
    const stillOpen = vi.fn();
    const unregister = pushBackDismiss(closed);
    pushBackDismiss(stillOpen);

    unregister();
    expect(backDismissDepth()).toBe(1);
    runTopBackDismiss();
    expect(stillOpen).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
  });

  it('unregistering twice does not drop somebody else', () => {
    const other = vi.fn();
    const unregister = pushBackDismiss(vi.fn());
    unregister();
    pushBackDismiss(other);
    unregister();

    expect(backDismissDepth()).toBe(1);
    runTopBackDismiss();
    expect(other).toHaveBeenCalledTimes(1);
  });
});
