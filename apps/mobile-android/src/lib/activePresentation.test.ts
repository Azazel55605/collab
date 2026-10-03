import { describe, expect, it, vi } from 'vitest';

import { hostedRequest } from '../mobileTauri';

import { listActivePresentations, preferredRemotePresentation } from './activePresentation';

vi.mock('../mobileTauri', () => ({ hostedRequest: vi.fn() }));

describe('mobile active presentation discovery', () => {
  it('lists through the authenticated native proxy and prefers the newest enabled remote', async () => {
    vi.mocked(hostedRequest).mockResolvedValue([]);
    await listActivePresentations('https://collab.example');
    expect(hostedRequest).toHaveBeenCalledWith(
      'https://collab.example',
      'GET',
      '/api/v1/presentations/active',
    );

    const base = {
      vaultId: 'vault-1',
      fileId: 'deck-1',
      relativePath: 'Demo.deck',
      title: 'Demo',
      slideId: 'slide-1',
      position: 1,
      total: 2,
      serverUrl: 'https://collab.example',
    };
    expect(
      preferredRemotePresentation([
        { ...base, showId: 'disabled', remoteEnabled: false, updatedAt: '2026-10-03T10:03:00Z' },
        { ...base, showId: 'older', remoteEnabled: true, updatedAt: '2026-10-03T10:01:00Z' },
        { ...base, showId: 'newer', remoteEnabled: true, updatedAt: '2026-10-03T10:02:00Z' },
      ])?.showId,
    ).toBe('newer');
  });
});
