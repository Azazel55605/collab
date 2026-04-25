import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';

import type { CanvasNodeData } from './CanvasNodeTypes';
import type { CanvasFlowEdge } from './CanvasEdgeTypes';
import { useCanvasDocumentSession } from './useCanvasDocumentSession';

const eventState = vi.hoisted(() => ({
  modifiedHandler: null as null | ((event: { payload: { path: string } }) => void),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_eventName: string, handler: (event: { payload: { path: string } }) => void) => {
    eventState.modifiedHandler = handler;
    return () => {
      eventState.modifiedHandler = null;
    };
  }),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createSnapshot: tauriMocks.createSnapshot,
  },
}));

describe('useCanvasDocumentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({ nodes: [], edges: [], viewport: { x: 1, y: 2, zoom: 0.9 } }),
      hash: 'hash-1',
      modifiedAt: 1,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('loads the canvas document and resets preview state', async () => {
    const setViewport = vi.fn();
    const setNodes = vi.fn();
    const setEdges = vi.fn();
    const resetPreviewState = vi.fn();
    const setSavedHash = vi.fn();
    const markLoaded = vi.fn((hash?: string | null) => {
      hashRef.current = hash ?? undefined;
    });
    const hashRef = { current: undefined as string | undefined };

    renderHook(() => useCanvasDocumentSession({
      reactFlow: { setViewport: vi.fn() },
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
      relativePath: 'Boards/test.canvas',
      nodes: [],
      edges: [] as CanvasFlowEdge[],
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport,
      setNodes,
      setEdges,
      buildFlowNode: () => [] as FlowNode<CanvasNodeData>[],
      toFlowEdge: (edge) => edge as never,
      fromFlowNode: vi.fn(),
      fromFlowEdge: vi.fn(),
      resetPreviewState,
      markDirty: vi.fn(),
      markSaved: vi.fn(),
      setSavedHash,
      addConflict: vi.fn(),
      myUserId: 'user-1',
      myUserName: 'User',
      isMountedRef: { current: true },
      isDirtyRef: { current: false },
      hashRef,
      lastWriteRef: { current: 0 },
      markLoaded,
      shouldSkipAutosave: () => true,
      markWriteStarted: vi.fn(),
      shouldCreateSnapshot: () => false,
    }));

    await waitFor(() => {
      expect(setSavedHash).toHaveBeenCalledWith('Boards/test.canvas', 'hash-1');
    });

    expect(markLoaded).toHaveBeenCalledWith('hash-1');
    expect(resetPreviewState).toHaveBeenCalled();
    expect(setViewport).toHaveBeenCalledWith({ x: 1, y: 2, zoom: 0.9 });
  });

  it('autosaves current canvas content and creates a snapshot on success', async () => {
    vi.useFakeTimers();
    const hashRef = { current: 'hash-1' as string | undefined };
    let skipAutosave = true;
    tauriMocks.writeNote.mockResolvedValue({ hash: 'hash-2' });

    const baseOptions = {
      reactFlow: { setViewport: vi.fn() },
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
      relativePath: 'Boards/test.canvas',
      setViewport: vi.fn(),
      setNodes: vi.fn(),
      setEdges: vi.fn(),
      buildFlowNode: () => [] as FlowNode<CanvasNodeData>[],
      toFlowEdge: (edge: unknown) => edge as never,
      fromFlowNode: vi.fn((node: FlowNode<CanvasNodeData>) => ({ id: node.id, type: 'text' as const, content: node.data.content ?? '', position: node.position, width: 100, height: 100 })),
      fromFlowEdge: vi.fn((edge: CanvasFlowEdge) => edge as never),
      resetPreviewState: vi.fn(),
      markDirty: vi.fn(),
      markSaved: vi.fn(),
      setSavedHash: vi.fn(),
      addConflict: vi.fn(),
      myUserId: 'user-1',
      myUserName: 'User',
      isMountedRef: { current: true },
      isDirtyRef: { current: false },
      hashRef,
      lastWriteRef: { current: 0 },
      markLoaded: vi.fn((hash?: string | null) => {
        hashRef.current = hash ?? undefined;
      }),
      shouldSkipAutosave: () => skipAutosave,
      markWriteStarted: vi.fn(),
      shouldCreateSnapshot: () => true,
    };

    const { rerender } = renderHook((props: { nodes: FlowNode<CanvasNodeData>[] }) => useCanvasDocumentSession({
      ...baseOptions,
      nodes: props.nodes,
      edges: [] as CanvasFlowEdge[],
      viewport: { x: 0, y: 0, zoom: 1 },
    }), {
      initialProps: {
        nodes: [] as FlowNode<CanvasNodeData>[],
      },
    });

    await Promise.resolve();
    expect(tauriMocks.readNote).toHaveBeenCalled();

    skipAutosave = false;
    rerender({
      nodes: [{
        id: 'node-1',
        type: 'textCard',
        position: { x: 0, y: 0 },
        data: { content: 'hello' },
      } as FlowNode<CanvasNodeData>],
    });

    await vi.advanceTimersByTimeAsync(650);
    await Promise.resolve();

    expect(tauriMocks.writeNote).toHaveBeenCalled();

    expect(tauriMocks.createSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Boards/test.canvas',
      JSON.stringify({
        nodes: [{ id: 'node-1', type: 'text', content: 'hello', position: { x: 0, y: 0 }, width: 100, height: 100 }],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }, null, 2),
      'user-1',
      'User',
    );
  });
});
