import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriCommands } from '../../lib/tauri';
import {
  discardPendingOperation,
  listPendingOperationRecoveries,
  type PendingOperation,
  type PendingOperationRecovery,
  retryPendingOperation,
  syncReplicaManifestDelta,
} from '../../lib/vaultReplica';
import { useServerStore } from '../../store/serverStore';
import { useSyncStore } from '../../store/syncStore';
import { useSyncTransferStore } from '../../store/syncTransferStore';
import { useVaultStore } from '../../store/vaultStore';
import type { HostedVaultMeta, LocalVaultMeta } from '../../types/vault';

import SyncStatusIndicator from './SyncStatusIndicator';

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn() },
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    replicaReadSyncState: vi.fn(),
    replicaListPendingOperations: vi.fn(),
    replicaDelete: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/vaultReplica', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/vaultReplica')>();
  return {
    onReplicaMutated: vi.fn(() => () => {}),
    listPendingOperationRecoveries: vi.fn(),
    retryPendingOperation: vi.fn().mockResolvedValue(undefined),
    discardPendingOperation: vi.fn().mockResolvedValue(undefined),
    syncReplicaManifestDelta: vi.fn().mockResolvedValue({}),
    classifyVaultAccessError: actual.classifyVaultAccessError,
    deriveVaultAccess: actual.deriveVaultAccess,
    isLikelyConnectivityError: actual.isLikelyConnectivityError,
  };
});

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

const localVault: LocalVaultMeta = {
  kind: 'local',
  id: 'local-1',
  name: 'Local Vault',
  path: '/vaults/local',
  lastOpened: 1,
  isEncrypted: false,
};

function pending(id: string): PendingOperation {
  return {
    id,
    kind: 'edit',
    fileId: 'f1',
    relativePath: 'Notes/Plan.md',
    payload: {},
    baseManifestSequence: 1,
    createdAt: '2026-06-18T00:00:00Z',
    status: 'pending',
  };
}

function recovery(id: string): PendingOperationRecovery {
  return {
    operation: { ...pending(id), status: 'failed' },
    failure: { code: 'manifest_conflict', message: 'The vault manifest changed.' },
    recommendedAction: 'retry-after-refresh',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSyncStore.getState().clear();
  useSyncTransferStore.getState().reset();
  useServerStore.setState({
    connections: {
      [hostedVault.serverUrl]: {
        status: { connected: true, serverUrl: hostedVault.serverUrl },
        hostedVaults: [],
      },
    },
  } as never);
  vi.mocked(tauriCommands.replicaReadSyncState).mockResolvedValue({
    manifestSequence: 3,
    lastSyncedAt: new Date().toISOString(),
    status: 'idle',
  });
  vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([]);
  vi.mocked(listPendingOperationRecoveries).mockResolvedValue([]);
});

describe('SyncStatusIndicator', () => {
  it('renders nothing for a local vault', () => {
    useVaultStore.setState({ vault: localVault } as never);
    const { container } = render(<SyncStatusIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('shows Synced when there is nothing pending', async () => {
    useVaultStore.setState({ vault: hostedVault } as never);
    render(<SyncStatusIndicator />);
    expect(await screen.findByText('Synced')).not.toBeNull();
  });

  it('shows a pending count and lists pending changes in the popover', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([pending('a')]);
    useVaultStore.setState({ vault: hostedVault } as never);
    render(<SyncStatusIndicator />);

    fireEvent.click(await screen.findByText('1 pending'));
    expect(await screen.findByText('Plan.md')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Sync now/ })).not.toBeNull();
  });

  it('surfaces conflicts with retry/discard and toasts once', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      { ...pending('a'), status: 'failed' },
    ]);
    vi.mocked(listPendingOperationRecoveries).mockResolvedValue([recovery('a')]);
    useVaultStore.setState({ vault: hostedVault } as never);
    render(<SyncStatusIndicator />);

    fireEvent.click(await screen.findByText('1 conflict'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(retryPendingOperation).toHaveBeenCalledWith(hostedVault, 'a'));
  });

  it('surfaces revoked access and removes the local copy on demand', async () => {
    const revoked: PendingOperationRecovery = {
      operation: { ...pending('a'), status: 'failed' },
      failure: { code: 'permission_revoked', message: 'forbidden' },
      recommendedAction: 'reconnect-account',
    };
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      { ...pending('a'), status: 'failed' },
    ]);
    vi.mocked(listPendingOperationRecoveries).mockResolvedValue([revoked]);
    useVaultStore.setState({ vault: hostedVault, closeVault: vi.fn() } as never);
    render(<SyncStatusIndicator />);

    fireEvent.click(await screen.findByText('Access revoked'));
    // Sync now is disabled when access is lost.
    expect((await screen.findByRole('button', { name: /Sync now/ })).hasAttribute('disabled')).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: /Remove offline copy/ }));
    await waitFor(() =>
      expect(tauriCommands.replicaDelete).toHaveBeenCalledWith(
        hostedVault.serverUrl,
        hostedVault.hostedVaultId,
      ),
    );
  });

  it('discards a conflicting operation', async () => {
    vi.mocked(tauriCommands.replicaListPendingOperations).mockResolvedValue([
      { ...pending('a'), status: 'failed' },
    ]);
    vi.mocked(listPendingOperationRecoveries).mockResolvedValue([recovery('a')]);
    useVaultStore.setState({ vault: hostedVault } as never);
    render(<SyncStatusIndicator />);

    fireEvent.click(await screen.findByText('1 conflict'));
    fireEvent.click(await screen.findByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(discardPendingOperation).toHaveBeenCalledWith(hostedVault, 'a'));
  });

  it('automatically syncs when the matching hosted server reconnects', async () => {
    useServerStore.setState({ connections: {} } as never);
    useVaultStore.setState({ vault: hostedVault } as never);
    render(<SyncStatusIndicator />);

    await screen.findByText('Synced');
    expect(syncReplicaManifestDelta).not.toHaveBeenCalled();

    useServerStore.setState({
      connections: {
        [hostedVault.serverUrl]: {
          status: { connected: true, serverUrl: hostedVault.serverUrl },
          hostedVaults: [],
        },
      },
    } as never);

    await waitFor(() =>
      expect(syncReplicaManifestDelta).toHaveBeenCalledWith(hostedVault, expect.any(Function)),
    );
  });

  it('shows active transfer progress and recent completion in the sync menu', async () => {
    useVaultStore.setState({ vault: hostedVault } as never);
    const transferId = useSyncTransferStore.getState().begin({
      vaultId: hostedVault.hostedVaultId,
      vaultName: hostedVault.name,
      direction: 'download',
      label: 'Downloading changes',
      detail: 'Notes/Plan.md',
      completed: 2,
      total: 4,
    });
    render(<SyncStatusIndicator />);

    fireEvent.click(await screen.findByText('Syncing…'));
    expect(await screen.findByText('Active transfers (1)')).not.toBeNull();
    expect(screen.getByText('50%')).not.toBeNull();
    expect(screen.getByText(/Team Vault · Notes\/Plan\.md/)).not.toBeNull();

    useSyncTransferStore.getState().complete(transferId, 'Download complete');
    expect(await screen.findByText('Recent')).not.toBeNull();
    expect(screen.getByText('Download complete')).not.toBeNull();
  });
});
