import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useVaultStore } from '../../../store/vaultStore';

import { VersionHistoryModal } from './VersionHistoryModal';

const { tauriCommandsMock } = vi.hoisted(() => ({
  tauriCommandsMock: {
    listSnapshots: vi.fn(),
    readSnapshot: vi.fn(),
    readNote: vi.fn(),
    deleteSnapshot: vi.fn(),
    clearSnapshotHistory: vi.fn(),
    restoreSnapshot: vi.fn(),
  },
}));

vi.mock('@/lib/tauri', () => ({
  tauriCommands: tauriCommandsMock,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('VersionHistoryModal', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vault: {
        id: 'vault-1',
        path: '/vault',
        name: 'Vault',
        isEncrypted: false,
        lastOpened: Date.now(),
      },
      isVaultLocked: false,
      fileTree: [],
      recentVaults: [],
      lastOpenedVaultPath: '/vault',
      isLoading: false,
      refreshFileTree: vi.fn(async () => {}),
      openVault: vi.fn(async () => {}),
      unlockVault: vi.fn(async () => {}),
      closeVault: vi.fn(),
      loadRecentVaults: vi.fn(async () => {}),
      removeRecentVault: vi.fn(async () => {}),
    });

    useEditorStore.setState({
      sessionVaultPath: '/vault',
      openTabs: [],
      activeTabPath: 'Docs/plan.md',
      forceReloadPath: null,
      setForceReloadPath: vi.fn(),
    });

    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    });

    tauriCommandsMock.listSnapshots.mockResolvedValue([
      {
        id: 'snap-1',
        relativePath: 'Docs/plan.md',
        authorId: 'user-1',
        authorName: 'Test User',
        timestamp: Date.now() - 1_000,
        hash: 'aaa',
        label: 'Before edits',
      },
    ]);
    tauriCommandsMock.readSnapshot.mockResolvedValue(
      [
        'line one',
        'line old',
        'shared 1',
        'shared 2',
        'shared 3',
        'shared 4',
        'shared 5',
        'shared 6',
        'shared 7',
        'shared 8',
        'shared 9',
        'shared 10',
        'tail old',
        '',
      ].join('\n'),
    );
    tauriCommandsMock.readNote.mockResolvedValue({
      content: [
        'line one',
        'line new',
        'shared 1',
        'shared 2',
        'shared 3',
        'shared 4',
        'shared 5',
        'shared 6',
        'shared 7',
        'shared 8',
        'shared 9',
        'shared 10',
        'tail new',
        '',
      ].join('\n'),
      hash: 'bbb',
    });
    tauriCommandsMock.restoreSnapshot.mockResolvedValue({
      hash: 'ccc',
      merged: false,
      conflict: null,
    });
    tauriCommandsMock.deleteSnapshot.mockResolvedValue(undefined);
    tauriCommandsMock.clearSnapshotHistory.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads snapshots and shows a roomy diff view', async () => {
    render(<VersionHistoryModal open relativePath="Docs/plan.md" onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(tauriCommandsMock.listSnapshots).toHaveBeenCalledWith('/vault', 'Docs/plan.md');
    });

    expect((await screen.findAllByText('Before edits')).length).toBeGreaterThan(0);
    expect(await screen.findByText('line old')).toBeTruthy();
    expect(await screen.findByText('line new')).toBeTruthy();
    expect(await screen.findByText('10 unchanged lines hidden')).toBeTruthy();
    expect(screen.getByText('Restore this version')).toBeTruthy();
  });

  it('restores the selected snapshot', async () => {
    render(<VersionHistoryModal open relativePath="Docs/plan.md" onOpenChange={() => {}} />);

    expect((await screen.findAllByText('Before edits')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Restore this version'));

    await waitFor(() => {
      expect(tauriCommandsMock.restoreSnapshot).toHaveBeenCalledWith(
        '/vault',
        'Docs/plan.md',
        'snap-1',
        'user-1',
        'Test User',
      );
    });
  });

  it('expands and collapses unchanged gaps in the diff', async () => {
    render(<VersionHistoryModal open relativePath="Docs/plan.md" onOpenChange={() => {}} />);

    expect(await screen.findByText('10 unchanged lines hidden')).toBeTruthy();
    expect(screen.queryByText('shared 5')).toBeNull();

    fireEvent.click(screen.getByText('Expand all gaps'));

    expect(await screen.findByText('Showing 10 unchanged lines')).toBeTruthy();
    expect((await screen.findAllByText('shared 5')).length).toBe(2);

    fireEvent.click(screen.getByText('Collapse all gaps'));

    expect(await screen.findByText('10 unchanged lines hidden')).toBeTruthy();
  });

  it('collapses leading and trailing unchanged sections too', async () => {
    tauriCommandsMock.readSnapshot.mockResolvedValue(
      [
        'lead 1',
        'lead 2',
        'lead 3',
        'lead 4',
        'lead 5',
        'lead 6',
        'lead 7',
        'lead 8',
        'lead 9',
        'middle old',
        'tail 1',
        'tail 2',
        'tail 3',
        'tail 4',
        'tail 5',
        'tail 6',
        'tail 7',
        'tail 8',
        'tail 9',
        '',
      ].join('\n'),
    );
    tauriCommandsMock.readNote.mockResolvedValue({
      content: [
        'lead 1',
        'lead 2',
        'lead 3',
        'lead 4',
        'lead 5',
        'lead 6',
        'lead 7',
        'lead 8',
        'lead 9',
        'middle new',
        'tail 1',
        'tail 2',
        'tail 3',
        'tail 4',
        'tail 5',
        'tail 6',
        'tail 7',
        'tail 8',
        'tail 9',
        '',
      ].join('\n'),
      hash: 'bbb',
    });

    render(<VersionHistoryModal open relativePath="Docs/plan.md" onOpenChange={() => {}} />);

    expect((await screen.findAllByText('9 unchanged lines hidden')).length).toBe(2);
    expect(screen.queryByText('lead 5')).toBeNull();
    expect(screen.queryByText('tail 5')).toBeNull();

    fireEvent.click(screen.getByText('Expand all gaps'));

    expect((await screen.findAllByText('lead 5')).length).toBe(2);
    expect((await screen.findAllByText('tail 5')).length).toBe(2);
  });

  it('deletes a selected snapshot after confirmation', async () => {
    render(<VersionHistoryModal open relativePath="Docs/plan.md" onOpenChange={() => {}} />);

    await screen.findAllByText('Before edits');
    fireEvent.click(screen.getByTitle('Delete snapshot'));
    fireEvent.click(screen.getByText('Delete snapshot'));

    await waitFor(() => {
      expect(tauriCommandsMock.deleteSnapshot).toHaveBeenCalledWith(
        '/vault',
        'Docs/plan.md',
        'snap-1',
      );
    });
  });

  it('clears history after confirmation', async () => {
    render(<VersionHistoryModal open relativePath="Docs/plan.md" onOpenChange={() => {}} />);

    await screen.findAllByText('Before edits');
    fireEvent.click(screen.getByText('Clear history'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));

    await waitFor(() => {
      expect(tauriCommandsMock.clearSnapshotHistory).toHaveBeenCalledWith('/vault', 'Docs/plan.md');
    });
  });
});
