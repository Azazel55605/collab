import React from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../store/collabStore';
import { useDocumentStatusStore } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

import CanvasPage, {
  normalizeDirectedHandlePair,
  normalizeLooseConnectionHandles,
} from './CanvasPage';

const canvasEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as
    null | ((event: { payload: { path: string } }) => void | Promise<void>),
  reactFlowProps: null as null | Record<string, unknown>,
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
  readNoteAssetDataUrl: vi.fn(),
  fetchLinkPreview: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: { path: string } }) => void | Promise<void>,
    ) => {
      if (eventName === 'vault:file-modified') {
        canvasEvents.fileModifiedHandler = handler;
      }
      return () => {
        if (eventName === 'vault:file-modified') {
          canvasEvents.fileModifiedHandler = null;
        }
      };
    },
  ),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}));

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createSnapshot: tauriMocks.createSnapshot,
    readNoteAssetDataUrl: tauriMocks.readNoteAssetDataUrl,
    fetchLinkPreview: tauriMocks.fetchLinkPreview,
  },
}));

vi.mock('../lib/webPreviewCache', () => ({
  normalizeWebPreviewUrl: (url: string) => url,
  prefetchWebPreviews: vi.fn(),
  requestWebPreview: vi.fn(async () => ({
    resolvedUrl: 'https://example.com',
    title: 'Example',
  })),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));

vi.mock('@xyflow/react', async () => {
  const react = await import('react');

  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: ({
      children,
      ...props
    }: { children: React.ReactNode } & Record<string, unknown>) => {
      canvasEvents.reactFlowProps = props;
      return <div data-testid="react-flow">{children}</div>;
    },
    Background: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    BaseEdge: () => null,
    Handle: () => null,
    NodeResizer: () => null,
    Position: {},
    ConnectionMode: { Loose: 'loose' },
    BackgroundVariant: { Dots: 'dots' },
    addEdge: vi.fn((edge, edges) => [...edges, edge]),
    applyNodeChanges: vi.fn((changes, nodes) => {
      let nextNodes = [...nodes];
      for (const change of changes as Array<Record<string, unknown>>) {
        if (change.type === 'remove') {
          nextNodes = nextNodes.filter((node) => node.id !== change.id);
          continue;
        }
        if (change.type === 'select') {
          nextNodes = nextNodes.map((node) =>
            node.id === change.id ? { ...node, selected: change.selected } : node,
          );
        }
      }
      return nextNodes;
    }),
    reconnectEdge: vi.fn((_oldEdge, _connection, edges) => edges),
    useNodesState: (initial: unknown[]) => react.useState(initial).concat([vi.fn()]),
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = react.useState(initial);
      return [edges, setEdges, vi.fn()] as const;
    },
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setViewport: vi.fn(async () => {}),
      fitView: vi.fn(async () => {}),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
    useNodes: () => [],
    useEdges: () => [],
    useStore: vi.fn(),
  };
});

vi.mock('../components/editor/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('normalizeLooseConnectionHandles', () => {
  it('backfills missing handles for near-diagonal loose connections with stable physical sides', () => {
    expect(
      normalizeLooseConnectionHandles(
        {
          source: 'junction',
          target: 'printer',
          sourceHandle: undefined,
          targetHandle: undefined,
        },
        [
          {
            id: 'junction',
            position: { x: 200, y: 300 },
            width: 56,
            height: 56,
            measured: undefined,
            style: undefined,
          },
          {
            id: 'printer',
            position: { x: 260, y: 120 },
            width: 220,
            height: 180,
            measured: undefined,
            style: undefined,
          },
        ],
      ),
    ).toEqual({
      sourceHandle: 'top-in',
      targetHandle: 'bottom-out',
    });
  });

  it('remaps undirected saved handles onto renderable same-side source and target handles', () => {
    expect(
      normalizeDirectedHandlePair({
        sourceHandle: 'top-in',
        targetHandle: 'left-in',
      }),
    ).toEqual({
      sourceHandle: 'top-out',
      targetHandle: 'left-in',
    });

    expect(
      normalizeDirectedHandlePair({
        sourceHandle: 'right-out',
        targetHandle: 'bottom-out',
      }),
    ).toEqual({
      sourceHandle: 'right-out',
      targetHandle: 'bottom-in',
    });
  });
});

describe('CanvasPage save behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasEvents.fileModifiedHandler = null;
    canvasEvents.reactFlowProps = null;

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
      openTabs: [
        {
          relativePath: 'Boards/test.canvas',
          title: 'test',
          isDirty: false,
          savedHash: null,
          type: 'canvas',
        },
      ],
      activeTabPath: 'Boards/test.canvas',
      forceReloadPath: null,
    });

    useUiStore.setState({
      activeView: 'canvas',
      sidebarPanel: 'files',
      collabTab: 'peers',
      sidebarWidth: 240,
      isSidebarOpen: true,
      isSettingsOpen: false,
      isVaultManagerOpen: false,
      canvasWebCardDefaultMode: 'preview',
      canvasWebCardAutoLoad: false,
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    });

    useCollabStore.setState({
      myUserId: 'user-1',
      myUserName: 'Test User',
      myUserColor: '#22c55e',
      peers: [],
      chatMessages: [],
      chatTypingUntil: null,
    });

    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });
  });

  afterEach(() => {
    cleanup();
    useDocumentStatusStore.setState({ statuses: {} });
  });

  it('surfaces optimistic-write conflicts through the document status pill', async () => {
    tauriMocks.writeNote.mockResolvedValue({
      hash: 'hash-conflict',
      conflict: {
        relativePath: 'Boards/test.canvas',
        ourContent: 'ours',
        theirContent: JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
      },
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    await screen.findByText(/0 cards and 0 links/i);
    fireEvent.click(screen.getByRole('button', { name: /add text/i }));

    // The controller latches the conflict and publishes it to the central
    // status bar surface instead of the legacy modal dialog.
    await waitFor(
      () => {
        expect(useDocumentStatusStore.getState().statuses['Boards/test.canvas']?.status).toBe(
          'conflict',
        );
      },
      { timeout: 2000 },
    );
    expect(tauriMocks.createSnapshot).not.toHaveBeenCalled();
  });

  it('creates a snapshot after a successful save', async () => {
    tauriMocks.writeNote.mockResolvedValue({
      hash: 'hash-2',
    });
    tauriMocks.createSnapshot.mockResolvedValue({
      id: 'snap-1',
      relativePath: 'Boards/test.canvas',
      authorId: 'user-1',
      authorName: 'Test User',
      timestamp: 1,
      hash: 'hash-2',
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    await screen.findByText(/0 cards and 0 links/i);
    fireEvent.click(screen.getByRole('button', { name: /add text/i }));
    await wait(700);

    await waitFor(() => {
      expect(tauriMocks.writeNote).toHaveBeenCalledTimes(1);
      expect(tauriMocks.createSnapshot).toHaveBeenCalledTimes(1);
    });

    expect(tauriMocks.createSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Boards/test.canvas',
      expect.stringContaining('"type": "text"'),
      'user-1',
      'Test User',
      undefined,
    );
    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.canvas',
        isDirty: false,
        savedHash: 'hash-2',
      }),
    );
  });

  it('reloads when a watcher event arrives and there are no local edits', async () => {
    tauriMocks.readNote
      .mockResolvedValueOnce({
        content: JSON.stringify({
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
        hash: 'hash-1',
        modifiedAt: 1,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          nodes: [
            {
              id: 'node-1',
              type: 'text',
              content: 'Remote',
              position: { x: 0, y: 0 },
              width: 280,
              height: 160,
            },
          ],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        }),
        hash: 'hash-2',
        modifiedAt: 2,
      });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/0 cards and 0 links/i)).toBeTruthy();

    await canvasEvents.fileModifiedHandler?.({ payload: { path: 'Boards/test.canvas' } });

    await waitFor(() => {
      expect(screen.getByText(/1 card and 0 links/i)).toBeTruthy();
    });

    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.canvas',
        savedHash: 'hash-2',
      }),
    );
  });

  it('does not reload when a watcher event arrives during local unsaved edits', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/0 cards and 0 links/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /add text/i }));

    await canvasEvents.fileModifiedHandler?.({ payload: { path: 'Boards/test.canvas' } });
    await wait(50);

    expect(screen.getByText(/1 card and 0 links/i)).toBeTruthy();
    // The controller re-reads to evaluate the candidate, but with an unchanged
    // version it is stale and must not replace the dirty local canvas.
    expect(tauriMocks.readNote).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.canvas',
        isDirty: true,
      }),
    );
  });

  it('auto-connects a node created from the insert menu even when connect-start metadata is incomplete', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [
          {
            id: 'source-1',
            type: 'text',
            content: 'Source',
            position: { x: 0, y: 0 },
            width: 280,
            height: 160,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/1 card and 0 links/i)).toBeTruthy();

    await act(async () => {
      (
        canvasEvents.reactFlowProps?.onConnectStart as
          ((event: MouseEvent, params: { nodeId?: string; handleId?: string }) => void) | undefined
      )?.({} as MouseEvent, { handleId: 'right-out' });
      (
        canvasEvents.reactFlowProps?.onConnectEnd as
          | ((
              event: MouseEvent,
              state: { toNode: null; fromNode: { id: string }; fromHandle: { id: string } },
            ) => void)
          | undefined
      )?.({ clientX: 180, clientY: 200 } as MouseEvent, {
        toNode: null,
        fromNode: { id: 'source-1' },
        fromHandle: { id: 'right-out' },
      });
    });

    fireEvent.click(await screen.findByText('Text'));

    await waitFor(() => {
      expect(screen.getByText(/2 cards and 1 link/i)).toBeTruthy();
    });
  });

  it('uses selection drag, middle-mouse pan, and scroll panning', async () => {
    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/0 cards and 0 links/i)).toBeTruthy();

    expect(canvasEvents.reactFlowProps).toEqual(
      expect.objectContaining({
        selectionOnDrag: true,
        panOnDrag: [1],
        panOnScroll: true,
        zoomOnScroll: false,
      }),
    );
  });

  it('allows multiple parallel connections between the same nodes', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [
          {
            id: 'node-a',
            type: 'text',
            content: 'A',
            position: { x: 0, y: 0 },
            width: 280,
            height: 160,
          },
          {
            id: 'node-b',
            type: 'text',
            content: 'B',
            position: { x: 320, y: 0 },
            width: 280,
            height: 160,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/2 cards and 0 links/i)).toBeTruthy();

    act(() => {
      (
        canvasEvents.reactFlowProps?.onConnect as
          | ((connection: {
              source: string;
              target: string;
              sourceHandle: string;
              targetHandle: string;
            }) => void)
          | undefined
      )?.({
        source: 'node-a',
        target: 'node-b',
        sourceHandle: 'right-out',
        targetHandle: 'left-in',
      });
      (
        canvasEvents.reactFlowProps?.onConnect as
          | ((connection: {
              source: string;
              target: string;
              sourceHandle: string;
              targetHandle: string;
            }) => void)
          | undefined
      )?.({
        source: 'node-a',
        target: 'node-b',
        sourceHandle: 'right-out',
        targetHandle: 'left-in',
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/2 cards and 2 links/i)).toBeTruthy();
    });
  });

  it('duplicates a node with alt-drag while leaving the original in place', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [
          {
            id: 'node-a',
            type: 'text',
            content: 'A',
            position: { x: 0, y: 0 },
            width: 280,
            height: 160,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/1 card and 0 links/i)).toBeTruthy();

    act(() => {
      (
        canvasEvents.reactFlowProps?.onNodeDragStart as
          ((event: MouseEvent, node: Record<string, unknown>) => void) | undefined
      )?.({ altKey: true } as MouseEvent, {
        id: 'node-a',
        selected: false,
        position: { x: 0, y: 0 },
      });
      (
        canvasEvents.reactFlowProps?.onNodeDragStop as
          ((event: MouseEvent, node: Record<string, unknown>) => void) | undefined
      )?.({ altKey: true } as MouseEvent, {
        id: 'node-a',
        selected: false,
        position: { x: 180, y: 120 },
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/2 cards and 0 links/i)).toBeTruthy();
    });
  });

  it('removes edges attached to deleted selected nodes', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [
          {
            id: 'node-a',
            type: 'text',
            content: 'A',
            position: { x: 0, y: 0 },
            width: 280,
            height: 160,
          },
          {
            id: 'node-b',
            type: 'text',
            content: 'B',
            position: { x: 320, y: 0 },
            width: 280,
            height: 160,
          },
        ],
        edges: [
          {
            id: 'edge-ab',
            source: 'node-a',
            target: 'node-b',
            sourceHandle: 'right-out',
            targetHandle: 'left-in',
            lineStyle: 'solid',
            routingStyle: 'curved',
            animated: false,
            animationReverse: false,
            markerStart: false,
            markerEnd: false,
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    expect(await screen.findByText(/2 cards and 1 link/i)).toBeTruthy();

    act(() => {
      (
        canvasEvents.reactFlowProps?.onNodesChange as
          ((changes: Array<{ id: string; type: string; selected?: boolean }>) => void) | undefined
      )?.([{ id: 'node-a', type: 'select', selected: true }]);
    });

    fireEvent.keyDown(document, { key: 'Delete' });

    await waitFor(() => {
      expect(screen.getByText(/1 card and 0 links/i)).toBeTruthy();
    });
  });
});
