import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabStore } from '../store/collabStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';

const canvasEvents = vi.hoisted(() => ({
  fileModifiedHandler: null as null | ((event: { payload: { path: string } }) => void | Promise<void>),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
  readNoteAssetDataUrl: vi.fn(),
  fetchLinkPreview: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: { path: string } }) => void | Promise<void>) => {
    if (eventName === 'vault:file-modified') {
      canvasEvents.fileModifiedHandler = handler;
    }
    return () => {
      if (eventName === 'vault:file-modified') {
        canvasEvents.fileModifiedHandler = null;
      }
    };
  }),
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
    ReactFlow: ({ children }: { children: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
    Background: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    BaseEdge: () => null,
    Handle: () => null,
    NodeResizer: () => null,
    Position: {},
    BackgroundVariant: { Dots: 'dots' },
    addEdge: vi.fn((edge, edges) => [...edges, edge]),
    applyNodeChanges: vi.fn((_changes, nodes) => nodes),
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

import CanvasPage from './CanvasPage';

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('CanvasPage save behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasEvents.fileModifiedHandler = null;

    useVaultStore.setState({
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: Date.now() },
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
      openTabs: [{ relativePath: 'Boards/test.canvas', title: 'test', isDirty: false, savedHash: null, type: 'canvas' }],
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
      myRole: null,
      peers: [],
      conflicts: [],
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
  });

  it('surfaces optimistic-write conflicts through collabStore', async () => {
    tauriMocks.writeNote.mockResolvedValue({
      hash: 'hash-conflict',
      conflict: {
        relativePath: 'Boards/test.canvas',
        ourContent: 'ours',
        theirContent: 'theirs',
      },
    });

    render(<CanvasPage relativePath="Boards/test.canvas" />);

    await screen.findByText(/0 cards and 0 links/i);
    fireEvent.click(screen.getByRole('button', { name: /add text/i }));
    await wait(700);

    await waitFor(() => {
      expect(useCollabStore.getState().conflicts).toHaveLength(1);
    });

    expect(useCollabStore.getState().conflicts[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.canvas',
        theirContent: 'theirs',
      }),
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
          nodes: [{ id: 'node-1', type: 'text', content: 'Remote', position: { x: 0, y: 0 }, width: 280, height: 160 }],
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
    expect(tauriMocks.readNote).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().openTabs[0]).toEqual(
      expect.objectContaining({
        relativePath: 'Boards/test.canvas',
        isDirty: true,
      }),
    );
  });
});
