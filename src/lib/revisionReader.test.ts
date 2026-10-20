import { expect, it, vi } from 'vitest';

import { RevisionReader } from './revisionReader';

it('bounds overlapping reads, shares revisions, retries failures and prunes removed boards', async () => {
  const reader = new RevisionReader<number>(2);
  let running = 0,
    peak = 0;
  const releases: Array<() => void> = [];
  const load = vi.fn(async () => {
    peak = Math.max(peak, ++running);
    await new Promise<void>((resolve) => releases.push(resolve));
    running--;
    return 1;
  });
  const first = reader.read('a', '1', load);
  expect(reader.read('a', '1', load)).toBe(first);
  const jobs = [first, reader.read('b', '1', load), reader.read('c', '1', load)];
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  jobs.push(reader.read('a', '2', load));
  for (let i = 0; i < 4; i++) {
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(i));
    releases[i]();
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.all(jobs);
  expect(peak).toBe(2);
  expect(load).toHaveBeenCalledTimes(4);
  const fail = vi.fn().mockRejectedValueOnce(new Error('unreadable')).mockResolvedValue(2);
  await expect(reader.read('bad', '1', fail)).rejects.toThrow('unreadable');
  await expect(reader.read('bad', '1', fail)).resolves.toBe(2);
  reader.prune(new Set());
  await expect(reader.read('bad', '1', fail)).resolves.toBe(2);
  expect(fail).toHaveBeenCalledTimes(3);
});
