import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type GridCell as GridCellType, useGridStore } from '../../store/gridStore';
import { useVaultStore } from '../../store/vaultStore';

import GridCell from './GridCell';

const canvasPageMock = vi.fn();
const kanbanPageMock = vi.fn();
const logicDiagramViewMock = vi.fn();
const imageViewMock = vi.fn();
const pdfViewMock = vi.fn();

vi.mock('../../views/CanvasPage', () => ({
  default: (props: { relativePath: string }) => {
    canvasPageMock(props);
    return <div data-testid="canvas-page">{props.relativePath}</div>;
  },
}));

vi.mock('../../views/KanbanPage', () => ({
  default: (props: { relativePath: string }) => {
    kanbanPageMock(props);
    return <div data-testid="kanban-page">{props.relativePath}</div>;
  },
}));

vi.mock('../../views/LogicDiagramView', () => ({
  default: (props: { relativePath: string }) => {
    logicDiagramViewMock(props);
    return <div data-testid="logic-diagram-view">{props.relativePath}</div>;
  },
}));

vi.mock('../../views/ImageView', () => ({
  default: (props: { relativePath: string }) => {
    imageViewMock(props);
    return <div data-testid="image-view">{props.relativePath}</div>;
  },
}));

vi.mock('../../views/PdfView', () => ({
  default: (props: { relativePath: string }) => {
    pdfViewMock(props);
    return <div data-testid="pdf-view">{props.relativePath}</div>;
  },
}));

vi.mock('../../views/NoteView', () => ({
  default: () => <div data-testid="note-view" />,
}));

vi.mock('../../views/GraphPage', () => ({
  default: () => <div data-testid="graph-page" />,
}));

vi.mock('../../views/SettingsPage', () => ({
  default: () => <div data-testid="settings-page" />,
}));

describe('GridCell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGridStore.setState({
      workspaces: [],
      activeWorkspaceId: 'default',
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      renameWorkspace: vi.fn(),
      setActiveWorkspace: vi.fn(),
      setLayout: vi.fn(),
      setCellContent: vi.fn(),
      swapCells: vi.fn(),
      reorderCells: vi.fn(),
      clearCell: vi.fn(),
      activateSplit: vi.fn(),
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
              relativePath: 'Boards/logic.logic',
              name: 'logic.logic',
              extension: 'logic',
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

  it('renders canvas cells with their board path', () => {
    const cell: GridCellType = {
      id: 'cell-1',
      content: {
        type: 'canvas',
        relativePath: 'Boards/network.canvas',
        title: 'Network',
      },
    };

    render(<GridCell cell={cell} />);

    expect(canvasPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'Boards/network.canvas' }),
    );
    expect(screen.getByTestId('canvas-page').textContent).toContain('Boards/network.canvas');
  });

  it('renders kanban cells with their board path', () => {
    const cell: GridCellType = {
      id: 'cell-2',
      content: {
        type: 'kanban',
        relativePath: 'Boards/tasks.kanban',
        title: 'Tasks',
      },
    };

    render(<GridCell cell={cell} />);

    expect(kanbanPageMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'Boards/tasks.kanban' }),
    );
    expect(screen.getByTestId('kanban-page').textContent).toContain('Boards/tasks.kanban');
  });

  it('renders logic cells with their diagram path', () => {
    const cell: GridCellType = {
      id: 'cell-logic',
      content: {
        type: 'logic',
        relativePath: 'Boards/logic.logic',
        title: 'Logic',
      },
    };

    render(<GridCell cell={cell} />);

    expect(logicDiagramViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'Boards/logic.logic' }),
    );
    expect(screen.getByTestId('logic-diagram-view').textContent).toContain('Boards/logic.logic');
  });

  it('accepts dragged vault board files into a cell', () => {
    const setCellContent = vi.fn();
    useGridStore.setState((state) => ({
      ...state,
      setCellContent,
    }));

    const cell: GridCellType = {
      id: 'cell-3',
      content: {
        type: 'empty',
        relativePath: null,
        title: '',
      },
    };

    const { container } = render(<GridCell cell={cell} />);
    const dropZone = container.querySelector('.h-full');
    expect(dropZone).not.toBeNull();

    fireEvent.drop(dropZone as Element, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-collab-vault-file' ? 'Boards/network.canvas' : '',
      },
    });

    expect(setCellContent).toHaveBeenCalledWith('cell-3', {
      type: 'canvas',
      relativePath: 'Boards/network.canvas',
      title: 'network',
    });
  });

  it('renders image cells with their asset path', () => {
    const cell: GridCellType = {
      id: 'cell-4',
      content: {
        type: 'image',
        relativePath: 'Boards/diagram.png',
        title: 'diagram',
      },
    };

    render(<GridCell cell={cell} />);

    expect(imageViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'Boards/diagram.png' }),
    );
    expect(screen.getByTestId('image-view').textContent).toContain('Boards/diagram.png');
  });

  it('renders pdf cells with their document path', () => {
    const cell: GridCellType = {
      id: 'cell-5',
      content: {
        type: 'pdf',
        relativePath: 'Boards/spec.pdf',
        title: 'spec',
      },
    };

    render(<GridCell cell={cell} />);

    expect(pdfViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'Boards/spec.pdf' }),
    );
    expect(screen.getByTestId('pdf-view').textContent).toContain('Boards/spec.pdf');
  });

  it('accepts dragged vault pdf files into a cell', () => {
    const setCellContent = vi.fn();
    useGridStore.setState((state) => ({
      ...state,
      setCellContent,
    }));

    const cell: GridCellType = {
      id: 'cell-6',
      content: {
        type: 'empty',
        relativePath: null,
        title: '',
      },
    };

    const { container } = render(<GridCell cell={cell} />);
    const dropZone = container.querySelector('.h-full');
    expect(dropZone).not.toBeNull();

    fireEvent.drop(dropZone as Element, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-collab-vault-file' ? 'Boards/spec.pdf' : '',
      },
    });

    expect(setCellContent).toHaveBeenCalledWith('cell-6', {
      type: 'pdf',
      relativePath: 'Boards/spec.pdf',
      title: 'spec',
    });
  });

  it('accepts dragged vault logic files into a cell', () => {
    const setCellContent = vi.fn();
    useGridStore.setState((state) => ({
      ...state,
      setCellContent,
    }));

    const cell: GridCellType = {
      id: 'cell-7',
      content: {
        type: 'empty',
        relativePath: null,
        title: '',
      },
    };

    const { container } = render(<GridCell cell={cell} />);
    const dropZone = container.querySelector('.h-full');
    expect(dropZone).not.toBeNull();

    fireEvent.drop(dropZone as Element, {
      dataTransfer: {
        getData: (type: string) =>
          type === 'application/x-collab-vault-file' ? 'Boards/logic.logic' : '',
      },
    });

    expect(setCellContent).toHaveBeenCalledWith('cell-7', {
      type: 'logic',
      relativePath: 'Boards/logic.logic',
      title: 'logic',
    });
  });
});
