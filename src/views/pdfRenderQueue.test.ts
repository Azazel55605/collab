import { describe, expect, it } from 'vitest';

import { enqueuePdfRender } from './pdfRenderQueue';

describe('enqueuePdfRender', () => {
  it('runs queued render jobs sequentially', async () => {
    const events: string[] = [];

    const slow = enqueuePdfRender(async () => {
      events.push('slow:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('slow:end');
      return 'slow';
    });

    const fast = enqueuePdfRender(async () => {
      events.push('fast:start');
      events.push('fast:end');
      return 'fast';
    });

    await expect(slow).resolves.toBe('slow');
    await expect(fast).resolves.toBe('fast');
    expect(events).toEqual([
      'slow:start',
      'slow:end',
      'fast:start',
      'fast:end',
    ]);
  });
});
