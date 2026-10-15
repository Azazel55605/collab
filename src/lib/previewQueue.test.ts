import { expect, it, vi } from 'vitest';

import { PreviewQueue } from './previewQueue';

it('bounds active work and skips obsolete queued IO', async () => {
  const queue = new PreviewQueue(2);
  const release: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const work = () =>
    new Promise<void>((done) => {
      active++;
      peak = Math.max(peak, active);
      release.push(() => {
        active--;
        done();
      });
    });
  const first = queue.run(work);
  const second = queue.run(work);
  const obsolete = vi.fn(work);
  const third = queue.run(obsolete, () => false);
  const failure = expect(third).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  expect(release).toHaveLength(2);
  release.forEach((done) => done());
  await Promise.all([first, second, failure]);
  expect(peak).toBe(2);
  expect(obsolete).not.toHaveBeenCalled();
});
