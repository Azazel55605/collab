import { expect, it, vi } from 'vitest';

import { tauriCommands } from './tauri';
import { getCachedWebPreview, requestWebPreview, subscribeWebPreview } from './webPreviewCache';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('./tauri', () => ({ tauriCommands: { fetchLinkPreview: fetch } }));
it('bounds cached previews, reuses successes and retries expired failures', async () => {
  fetch.mockResolvedValue({ title: 'Preview' });
  await requestWebPreview('https://one.test');
  await requestWebPreview('https://one.test');
  expect(tauriCommands.fetchLinkPreview).toHaveBeenCalledOnce();
  fetch.mockRejectedValue(new Error('offline'));
  await expect(requestWebPreview('https://retry.test')).rejects.toThrow('offline');
  await expect(requestWebPreview('https://retry.test')).rejects.toThrow('offline');
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 31_000);
  fetch.mockResolvedValue({ title: 'Recovered' });
  await expect(requestWebPreview('https://retry.test')).resolves.toMatchObject({
    title: 'Recovered',
  });
  vi.useRealTimers();
  for (let i = 0; i < 140; i++) await requestWebPreview(`https://cache${i}.test`);
  expect(getCachedWebPreview('https://cache0.test').status).toBe('idle');
  expect(getCachedWebPreview('https://cache139.test').status).toBe('loaded');
});

it('publishes successful results even while a large prefetch batch is queued', async () => {
  fetch.mockResolvedValue({ title: 'Concurrent' });
  const states: string[] = [];
  const off = subscribeWebPreview('https://parallel0.test', () =>
    states.push(getCachedWebPreview('https://parallel0.test').status),
  );
  await Promise.all(
    Array.from({ length: 150 }, (_, i) => requestWebPreview(`https://parallel${i}.test`)),
  );
  expect(states).toContain('loaded');
  off();
});
