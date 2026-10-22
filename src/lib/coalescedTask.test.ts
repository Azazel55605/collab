import { expect, it, vi } from 'vitest';

import { CoalescedTask } from './coalescedTask';

it('runs one trailing reconciliation for events during an active job and recovers after failure', async () => {
  const owner = new CoalescedTask();
  let finish!: () => void;
  const first = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    ),
    obsolete = vi.fn(async () => {}),
    latest = vi.fn(async () => {});
  const a = owner.run(first);
  const b = owner.run(obsolete);
  const c = owner.run(latest);
  expect(a).toBe(b);
  expect(b).toBe(c);
  finish();
  await c;
  expect(first).toHaveBeenCalledTimes(1);
  expect(obsolete).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  await expect(
    owner.run(async () => {
      throw new Error('retry');
    }),
  ).rejects.toThrow('retry');
  await owner.run(latest);
  expect(latest).toHaveBeenCalledTimes(2);
});
