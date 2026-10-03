import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../tauri';

import { publishActivePresentation, stopPublishingActivePresentation } from './activePresentation';

vi.mock('../tauri', () => ({
  tauriCommands: { hostedVaultRequest: vi.fn() },
}));

describe('active presentation discovery publisher', () => {
  beforeEach(() => vi.mocked(tauriCommands.hostedVaultRequest).mockReset());

  it('heartbeats and removes one show through the bounded hosted API proxy', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue({});
    const heartbeat = {
      vaultId: 'vault-1',
      fileId: 'deck-1',
      relativePath: 'Talks/Demo.deck',
      title: 'Demo',
      slideId: 'slide-2',
      position: 2,
      total: 5,
      remoteEnabled: true,
    };
    await publishActivePresentation('https://collab.example', 'show-1', heartbeat);
    await stopPublishingActivePresentation('https://collab.example', 'show-1');

    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      1,
      'https://collab.example',
      'PUT',
      '/api/v1/presentations/active/show-1',
      heartbeat,
    );
    expect(tauriCommands.hostedVaultRequest).toHaveBeenNthCalledWith(
      2,
      'https://collab.example',
      'DELETE',
      '/api/v1/presentations/active/show-1',
    );
  });
});
