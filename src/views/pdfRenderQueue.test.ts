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
    expect(events).toEqual(['slow:start', 'slow:end', 'fast:start', 'fast:end']);
  });
});

it('removes a cancelled page/zoom closure before it reaches the renderer', async () => {
  let release!: () => void;
  const slow = enqueuePdfRender(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const request = new AbortController();
  let ran = false;
  const obsolete = enqueuePdfRender(
    async () => {
      ran = true;
    },
    { signal: request.signal },
  );
  const rejection = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
  request.abort();
  await rejection;
  release();
  await slow;
  expect(ran).toBe(false);
});
