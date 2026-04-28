import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TrashPanel from './TrashPanel';
import { TooltipProvider } from '../ui/tooltip';

const {
  listTrashEntries,
  restoreTrashedItem,
  purgeTrashedItem,
  purgeAllTrash,
  refreshFileTree,
} = vi.hoisted(() => ({
  listTrashEntries: vi.fn(),
  restoreTrashedItem: vi.fn(),
  purgeTrashedItem: vi.fn(),
  purgeAllTrash: vi.fn(),
  refreshFileTree: vi.fn(async () => {}),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    listTrashEntries,
    restoreTrashedItem,
    purgeTrashedItem,
    purgeAllTrash,
  },
}));

vi.mock('../../store/vaultStore', () => ({
  useVaultStore: Object.assign(
    () => ({
      vault: { path: '/vault' },
      refreshFileTree,
    }),
    {
      getState: () => ({
        refreshFileTree,
      }),
    },
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('TrashPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTrashEntries.mockResolvedValue([
      {
        id: 'one',
        originalRelativePath: 'Docs/spec.pdf',
        deletedAt: Date.now(),
        deletedByUserName: 'Alice',
        itemKind: 'file',
        extension: 'pdf',
        size: 1024,
        rootName: 'spec.pdf',
        restoreConflict: null,
      },
      {
        id: 'two',
        originalRelativePath: 'Notes/todo.md',
        deletedAt: Date.now(),
        deletedByUserName: 'Bob',
        itemKind: 'file',
        extension: 'md',
        size: 128,
        rootName: 'todo.md',
        restoreConflict: null,
      },
    ]);
  });

  it('filters trashed items through the search field', async () => {
    render(
      <TooltipProvider>
        <TrashPanel />
      </TooltipProvider>,
    );

    expect(await screen.findByText('spec.pdf')).not.toBeNull();
    expect(screen.getByText('todo.md')).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Search trash…'), {
      target: { value: 'spec' },
    });

    expect(screen.getByText('spec.pdf')).not.toBeNull();
    expect(screen.queryByText('todo.md')).toBeNull();
  });

  it('confirms purge all before deleting every trashed item', async () => {
    render(
      <TooltipProvider>
        <TrashPanel />
      </TooltipProvider>,
    );

    expect(await screen.findByText('spec.pdf')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /purge all/i }));

    expect(await screen.findByRole('button', { name: /purge all permanently/i })).not.toBeNull();
    expect(purgeAllTrash).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /purge all permanently/i }));

    await waitFor(() => {
      expect(purgeAllTrash).toHaveBeenCalledWith('/vault');
    });
  });
});
