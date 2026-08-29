import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedVaultMeta } from '../types/vault';

import { HostedServerTransport } from './collabTransport';
import { tauriCommands } from './tauri';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('./tauri', () => ({
  tauriCommands: {
    hostedVaultRequest: vi.fn(),
  },
}));

const hostedVault: HostedVaultMeta = {
  kind: 'hosted',
  id: 'vault-1',
  hostedVaultId: 'vault-1',
  serverUrl: 'https://collab.example.test',
  name: 'Team Vault',
  path: 'hosted://vault-1',
  lastOpened: 1,
  isEncrypted: false,
  role: 'editor',
};

describe('HostedServerTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists hosted presence through the server API', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue(undefined);
    const transport = new HostedServerTransport(hostedVault);

    await transport.broadcastPresence({
      userId: 'server-user-1',
      userName: 'Server User',
      userColor: '#8b5cf6',
      activeFile: 'Notes/a.md',
      cursorLine: 12,
      chatTypingUntil: 1234,
      lastSeen: 5678,
      appVersion: '1.2.3',
    });

    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'PUT',
      '/api/v1/vaults/vault-1/presence',
      {
        activeFile: 'Notes/a.md',
        cursorLine: 12,
        chatTypingUntil: 1234,
        appVersion: '1.2.3',
      },
    );
  });

  it('reads hosted presence from the server API', async () => {
    vi.mocked(tauriCommands.hostedVaultRequest).mockResolvedValue([]);
    const transport = new HostedServerTransport(hostedVault);

    await expect(transport.readPresence()).resolves.toEqual([]);

    expect(tauriCommands.hostedVaultRequest).toHaveBeenCalledWith(
      'https://collab.example.test',
      'GET',
      '/api/v1/vaults/vault-1/presence',
    );
  });
});
