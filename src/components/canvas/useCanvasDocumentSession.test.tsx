import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Node as FlowNode } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostedVaultClient } from '../../lib/vaultClient';

import type { CanvasFlowEdge } from './CanvasEdgeTypes';
import type { CanvasNodeData } from './CanvasNodeTypes';
import { sanitizeLoadedCanvasData, useCanvasDocumentSession } from './useCanvasDocumentSession';

const eventState = vi.hoisted(() => ({
  modifiedHandler: null as null | ((event: { payload: { path: string } }) => void),
}));

const tauriMocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  createSnapshot: vi.fn(),
}));

const liveMocks = vi.hoisted(() => ({
  openLiveJsonSession: vi.fn(async () => null as unknown),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (_eventName: string, handler: (event: { payload: { path: string } }) => void) => {
      eventState.modifiedHandler = handler;
      return () => {
        eventState.modifiedHandler = null;
      };
    },
  ),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    readNote: tauriMocks.readNote,
    writeNote: tauriMocks.writeNote,
    createSnapshot: tauriMocks.createSnapshot,
  },
}));

vi.mock('../../lib/liveJsonDocument', () => ({
  openLiveJsonSession: liveMocks.openLiveJsonSession,
}));

type SessionOptions = Parameters<typeof useCanvasDocumentSession>[0];

/** Base options for the local-vault REST path with sensible no-op defaults. */
function baseLocalOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    reactFlow: { setViewport: vi.fn() },
    vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
    relativePath: 'Boards/test.canvas',
    nodes: [],
    edges: [] as CanvasFlowEdge[],
    viewport: { x: 0, y: 0, zoom: 1 },
    setViewport: vi.fn(),
    setNodes: vi.fn(),
    setEdges: vi.fn(),
    buildFlowNode: () => [] as FlowNode<CanvasNodeData>[],
    toFlowEdge: (edge) => edge as never,
    fromFlowNode: vi.fn(),
    fromFlowEdge: vi.fn(),
    resetPreviewState: vi.fn(),
    markDirty: vi.fn(),
    markSaved: vi.fn(),
    setSavedHash: vi.fn(),
    myUserId: 'user-1',
    myUserName: 'User',
    isMountedRef: { current: true },
    ...overrides,
  };
}

describe('useCanvasDocumentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveMocks.openLiveJsonSession.mockResolvedValue(null);
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

  it('removes dangling edges from loaded canvas data', () => {
    expect(
      sanitizeLoadedCanvasData({
        nodes: [
          {
            id: 'node-a',
            type: 'text',
            content: 'A',
            position: { x: 0, y: 0 },
            width: 100,
            height: 100,
          },
        ],
        edges: [
          { id: 'edge-ok', source: 'node-a', target: 'node-a' },
          { id: 'edge-broken', source: 'node-a', target: 'missing-node' },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    ).toEqual({
      changed: true,
      canvas: {
        nodes: [
          {
            id: 'node-a',
            type: 'text',
            content: 'A',
            position: { x: 0, y: 0 },
            width: 100,
            height: 100,
          },
        ],
        edges: [{ id: 'edge-ok', source: 'node-a', target: 'node-a' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
  });

  it('drops malformed live nodes and their edges before they reach ReactFlow', () => {
    const result = sanitizeLoadedCanvasData({
      nodes: [
        {
          id: 'valid',
          type: 'text',
          content: 'A',
          position: { x: 0, y: 0 },
          width: 100,
          height: 100,
        },
        { id: 'partial', type: 'text', content: 'B' },
      ],
      edges: [
        { id: 'valid-edge', source: 'valid', target: 'valid' },
        { id: 'partial-edge', source: 'valid', target: 'partial' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    } as Parameters<typeof sanitizeLoadedCanvasData>[0]);

    expect(result.changed).toBe(true);
    expect(result.canvas.nodes.map((node) => node.id)).toEqual(['valid']);
    expect(result.canvas.edges.map((edge) => edge.id)).toEqual(['valid-edge']);
  });

  it('loads the canvas document and resets preview state', async () => {
    const setViewport = vi.fn();
    const resetPreviewState = vi.fn();
    const setSavedHash = vi.fn();

    renderHook(() =>
      useCanvasDocumentSession(
        baseLocalOptions({
          setViewport,
          resetPreviewState,
          setSavedHash,
        }),
      ),
    );

    await waitFor(() => {
      expect(setSavedHash).toHaveBeenCalledWith('Boards/test.canvas', 'hash-1');
    });

    expect(resetPreviewState).toHaveBeenCalled();
    expect(setViewport).toHaveBeenCalledWith({ x: 1, y: 2, zoom: 0.9 });
  });

  it('sanitizes dangling edges in memory without rewriting the source on open', async () => {
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({
        nodes: [],
        edges: [{ id: 'broken', source: 'missing', target: 'missing' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      hash: 'hash-1',
      modifiedAt: 1,
    });
    const options = baseLocalOptions();
    renderHook(() => useCanvasDocumentSession(options));
    await waitFor(() =>
      expect(options.setSavedHash).toHaveBeenCalledWith('Boards/test.canvas', 'hash-1'),
    );
    expect(tauriMocks.writeNote).not.toHaveBeenCalled();
  });

  it.each([new Error('permission denied'), new Error('offline')])(
    'never enables autosave after a failed load: %s',
    async (error) => {
      tauriMocks.readNote.mockRejectedValue(error);
      const options = baseLocalOptions();
      const hook = renderHook(() => useCanvasDocumentSession(options));
      await waitFor(() => expect(hook.result.current.loadError).toBe(String(error)));
      await hook.result.current.beforeLeave();
      await hook.result.current.controller.requestSave('flush');
      expect(tauriMocks.writeNote).not.toHaveBeenCalled();
      expect(options.markSaved).not.toHaveBeenCalled();
    },
  );

  it('reports invalid JSON without replacing the document with an empty canvas', async () => {
    tauriMocks.readNote.mockResolvedValue({ content: '{broken', hash: 'hash', modifiedAt: 1 });
    const hook = renderHook(() => useCanvasDocumentSession(baseLocalOptions()));
    await waitFor(() => expect(hook.result.current.loadError).toBeTruthy());
    expect(tauriMocks.writeNote).not.toHaveBeenCalled();
  });

  it('autosaves current canvas content and creates a snapshot on success', async () => {
    vi.useFakeTimers();
    // Match the file viewport to the prop viewport so the loaded baseline is
    // clean; only the added node makes the document dirty.
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
      hash: 'hash-1',
      modifiedAt: 1,
    });
    tauriMocks.writeNote.mockResolvedValue({ hash: 'hash-2' });
    tauriMocks.createSnapshot.mockResolvedValue(undefined);

    const options = baseLocalOptions({
      fromFlowNode: vi.fn((node: FlowNode<CanvasNodeData>) => ({
        id: node.id,
        type: 'text' as const,
        content: node.data.content ?? '',
        position: node.position,
        width: 100,
        height: 100,
      })),
      fromFlowEdge: vi.fn((edge: CanvasFlowEdge) => edge as never),
    });

    const { rerender } = renderHook(
      (props: { nodes: FlowNode<CanvasNodeData>[] }) =>
        useCanvasDocumentSession({
          ...options,
          nodes: props.nodes,
        }),
      {
        initialProps: { nodes: [] as FlowNode<CanvasNodeData>[] },
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(tauriMocks.readNote).toHaveBeenCalled();

    rerender({
      nodes: [
        {
          id: 'node-1',
          type: 'textCard',
          position: { x: 0, y: 0 },
          data: { content: 'hello' },
        } as FlowNode<CanvasNodeData>,
      ],
    });

    await vi.advanceTimersByTimeAsync(650);

    expect(tauriMocks.writeNote).toHaveBeenCalled();
    expect(tauriMocks.createSnapshot).toHaveBeenCalledWith(
      '/vault',
      'Boards/test.canvas',
      JSON.stringify(
        {
          nodes: [
            {
              id: 'node-1',
              type: 'text',
              content: 'hello',
              position: { x: 0, y: 0 },
              width: 100,
              height: 100,
            },
          ],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        null,
        2,
      ),
      'user-1',
      'User',
      undefined,
    );
  });

  it('ignores a slow response from a previously selected canvas', async () => {
    let release!: (value: unknown) => void;
    tauriMocks.readNote.mockImplementation((_vault, path) =>
      path === 'old.canvas'
        ? new Promise((done) => {
            release = done;
          })
        : Promise.resolve({
            content: JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }),
            hash: 'new',
            modifiedAt: 1,
          }),
    );
    const options = baseLocalOptions();
    const hook = renderHook(
      ({ path }) => useCanvasDocumentSession({ ...options, relativePath: path }),
      { initialProps: { path: 'old.canvas' } },
    );
    hook.rerender({ path: 'new.canvas' });
    await waitFor(() => expect(options.setSavedHash).toHaveBeenCalledWith('new.canvas', 'new'));
    await act(async () => release({ content: '{}', hash: 'old', modifiedAt: 1 }));
    expect(options.setSavedHash).not.toHaveBeenCalledWith('old.canvas', 'old');
  });

  it('serializes a drag at its checkpoint and saves the final authoritative position', async () => {
    const options = baseLocalOptions({
      viewport: { x: 1, y: 2, zoom: 0.9 },
      fromFlowNode: vi.fn((node) => ({
        id: node.id,
        type: 'text' as const,
        content: node.data.content ?? '',
        position: node.position,
        width: 100,
        height: 100,
      })),
    });
    tauriMocks.writeNote.mockResolvedValue({ hash: 'hash-2' });
    const hook = renderHook(
      ({ nodes, pause }: { nodes: FlowNode<CanvasNodeData>[]; pause: boolean }) =>
        useCanvasDocumentSession({ ...options, nodes, pauseAutosave: pause }),
      { initialProps: { nodes: [] as FlowNode<CanvasNodeData>[], pause: false } },
    );
    await waitFor(() => expect(options.setSavedHash).toHaveBeenCalled());
    vi.mocked(options.fromFlowNode).mockClear();
    for (let x = 0; x < 100; x++) {
      hook.rerender({
        nodes: [
          {
            id: 'node',
            type: 'textCard',
            data: { content: 'keep' },
            position: { x, y: 20 },
          } as FlowNode<CanvasNodeData>,
        ],
        pause: true,
      });
    }
    expect(options.fromFlowNode).not.toHaveBeenCalled();
    expect(hook.result.current.snapshot.dirty).toBe(true);
    await act(async () => {
      await hook.result.current.controller.requestSave('manual');
    });
    const saved = JSON.parse(tauriMocks.writeNote.mock.calls[0][2]);
    expect(saved.nodes[0]).toMatchObject({ content: 'keep', position: { x: 99, y: 20 } });
    tauriMocks.readNote.mockResolvedValue({
      content: JSON.stringify(saved),
      hash: 'hash-2',
      modifiedAt: 2,
    });
    hook.unmount();
    const reopened = baseLocalOptions({
      fromFlowNode: options.fromFlowNode,
      buildFlowNode: (canvas) =>
        canvas.nodes.map(
          (node) =>
            ({ id: node.id, data: {}, position: node.position }) as FlowNode<CanvasNodeData>,
        ),
    });
    renderHook(() => useCanvasDocumentSession(reopened));
    await waitFor(() =>
      expect(reopened.setNodes).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ position: { x: 99, y: 20 } })]),
      ),
    );
  });

  function hostedLiveOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
    vi.spyOn(HostedVaultClient.prototype, 'readDocument').mockResolvedValue({
      relativePath: 'Boards/test.canvas',
      version: '3',
      modifiedAt: 1,
      content: JSON.stringify({
        nodes: [
          {
            id: 'node-1',
            type: 'text',
            content: 'server',
            position: { x: 0, y: 0 },
            width: 100,
            height: 100,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    });
    return {
      reactFlow: { setViewport: vi.fn() },
      vault: {
        kind: 'hosted',
        id: 'hosted-vault',
        hostedVaultId: 'hosted-vault',
        serverUrl: 'https://collab.example.test',
        role: 'editor',
        path: 'hosted://hosted-vault',
        name: 'Hosted',
        isEncrypted: false,
        lastOpened: 1,
      },
      relativePath: 'Boards/test.canvas',
      nodes: [],
      edges: [] as CanvasFlowEdge[],
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport: vi.fn(),
      setNodes: vi.fn(),
      setEdges: vi.fn(),
      buildFlowNode: (canvas: {
        nodes: Array<{ id: string; content?: string; position: { x: number; y: number } }>;
      }) =>
        canvas.nodes.map((node) => ({
          id: node.id,
          type: 'textCard',
          position: node.position,
          data: { title: 'Text', content: node.content ?? '' },
        })) as FlowNode<CanvasNodeData>[],
      toFlowEdge: (edge) => edge as never,
      fromFlowNode: vi.fn((node: FlowNode<CanvasNodeData>) => ({
        id: node.id,
        type: 'text' as const,
        content: node.data.content ?? '',
        position: node.position,
        width: 100,
        height: 100,
      })),
      fromFlowEdge: vi.fn((edge: CanvasFlowEdge) => edge as never),
      resetPreviewState: vi.fn(),
      markDirty: vi.fn(),
      markSaved: vi.fn(),
      setSavedHash: vi.fn(),
      myUserId: 'user-1',
      myUserName: 'User',
      isMountedRef: { current: true },
      ...overrides,
    };
  }

  it('opens a hosted canvas live session but only writes after hydration', async () => {
    const writeJson = vi.fn();
    liveMocks.openLiveJsonSession.mockResolvedValue({
      readJson: () => ({
        nodes: [
          {
            id: 'node-1',
            type: 'text',
            content: 'server',
            position: { x: 0, y: 0 },
            width: 100,
            height: 100,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      writeJson,
      onChange: () => () => {},
      awareness: { setLocalStateField: vi.fn() },
      getStatus: () => 'connected',
      onStatus: () => () => {},
      destroy: vi.fn(),
    });

    const options = hostedLiveOptions();

    const { rerender, unmount } = renderHook(
      ({ nodes }: { nodes: FlowNode<CanvasNodeData>[] }) =>
        useCanvasDocumentSession({ ...options, nodes }),
      { initialProps: { nodes: [] as FlowNode<CanvasNodeData>[] } },
    );

    // The hosted canvas opens a live session (after the REST load resolves the
    // gate). Before the editor state has hydrated to match the server snapshot,
    // the initial (empty) React state must never be written.
    await waitFor(() => expect(liveMocks.openLiveJsonSession).toHaveBeenCalled());
    expect(writeJson).not.toHaveBeenCalled();

    const hydratedNode = {
      id: 'node-1',
      type: 'textCard',
      position: { x: 0, y: 0 },
      data: { title: 'Text', content: 'server' },
    } as FlowNode<CanvasNodeData>;
    // ReactFlow state now exactly matches the seeded snapshot: this clears the
    // hydration barrier but is not itself an edit, so still no write.
    rerender({ nodes: [hydratedNode] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(writeJson).not.toHaveBeenCalled();

    // A genuine post-hydration edit is pushed into the live doc.
    rerender({ nodes: [{ ...hydratedNode, data: { title: 'Text', content: 'edited' } }] });
    unmount();
    expect(writeJson).toHaveBeenCalledTimes(1);
    expect(writeJson.mock.calls[0][0].nodes[0].content).toBe('edited');
  });

  it('publishes the selected node ids as ephemeral canvas awareness', async () => {
    const setLocalStateField = vi.fn();
    liveMocks.openLiveJsonSession.mockResolvedValue({
      readJson: () => ({
        nodes: [
          {
            id: 'node-1',
            type: 'text',
            content: 'server',
            position: { x: 0, y: 0 },
            width: 100,
            height: 100,
          },
        ],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
      writeJson: vi.fn(),
      onChange: () => () => {},
      awareness: { setLocalStateField },
      getStatus: () => 'connected',
      onStatus: () => () => {},
      destroy: vi.fn(),
    });

    const options = hostedLiveOptions();

    const { rerender } = renderHook(
      ({ nodes }: { nodes: FlowNode<CanvasNodeData>[] }) =>
        useCanvasDocumentSession({ ...options, nodes }),
      { initialProps: { nodes: [] as FlowNode<CanvasNodeData>[] } },
    );

    await waitFor(() => expect(liveMocks.openLiveJsonSession).toHaveBeenCalled());
    // Identity + document context are published; an empty selection is not.
    await waitFor(() =>
      expect(setLocalStateField).toHaveBeenCalledWith('document', {
        kind: 'canvas',
        relativePath: 'Boards/test.canvas',
      }),
    );
    expect(setLocalStateField).not.toHaveBeenCalledWith('canvas', { selectedNodeIds: [] });

    // Selecting a node publishes it as ephemeral canvas awareness.
    rerender({
      nodes: [
        {
          id: 'node-1',
          type: 'textCard',
          position: { x: 0, y: 0 },
          selected: true,
          data: { title: 'Text', content: 'server' },
        } as FlowNode<CanvasNodeData>,
      ],
    });
    await waitFor(() =>
      expect(setLocalStateField).toHaveBeenCalledWith('canvas', { selectedNodeIds: ['node-1'] }),
    );
  });
});
