import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';

import CellContentPicker from './CellContentPicker';

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('CellContentPicker', () => {
  beforeEach(() => {
    useNoteIndexStore.setState({
      notes: [],
      setNotes: vi.fn(),
    });
    useVaultStore.setState({
      vault: null,
      isVaultLocked: false,
      fileTree: [
        {
          relativePath: 'Boards',
          name: 'Boards',
          extension: '',
          modifiedAt: 0,
          size: 0,
          isFolder: true,
          children: [
            {
              relativePath: 'Boards/network.canvas',
              name: 'network.canvas',
              extension: 'canvas',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
            {
              relativePath: 'Boards/tasks.kanban',
              name: 'tasks.kanban',
              extension: 'kanban',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
            {
              relativePath: 'Boards/spec.pdf',
              name: 'spec.pdf',
              extension: 'pdf',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
            {
              relativePath: 'Boards/diagram.png',
              name: 'diagram.png',
              extension: 'png',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
          ],
        },
      ],
      recentVaults: [],
      lastOpenedVaultPath: null,
      isLoading: false,
    });
  });

  it('selects real canvas, kanban, pdf, and image paths', () => {
    const onSelect = vi.fn();

    render(
      <CellContentPicker onSelect={onSelect}>
        <button type="button">Open picker</button>
      </CellContentPicker>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'network' }));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'canvas',
      relativePath: 'Boards/network.canvas',
      title: 'network',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'tasks' }));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'kanban',
      relativePath: 'Boards/tasks.kanban',
      title: 'tasks',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'spec' }));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'pdf',
      relativePath: 'Boards/spec.pdf',
      title: 'spec',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open picker' }));
    fireEvent.click(screen.getByRole('button', { name: 'diagram' }));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'image',
      relativePath: 'Boards/diagram.png',
      title: 'diagram',
    });
  });
});
