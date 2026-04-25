import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node as FlowNode, Viewport } from '@xyflow/react';

import { tauriCommands } from '../../lib/tauri';
import type { CanvasData, CanvasEdge } from '../../types/canvas';
import type { VaultMeta } from '../../types/vault';
import type { CanvasNodeData } from './CanvasNodeTypes';
import type { CanvasFlowEdge } from './CanvasEdgeTypes';

const SAVE_DEBOUNCE_MS = 600;
const EMPTY_CANVAS: CanvasData = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

interface ReactFlowViewportApi {
  setViewport: (viewport: Viewport, options?: { duration?: number }) => void | Promise<unknown>;
}

interface UseCanvasDocumentSessionOptions {
  reactFlow: ReactFlowViewportApi;
  vault: VaultMeta | null;
  relativePath: string | null;
  nodes: FlowNode<CanvasNodeData>[];
  edges: CanvasFlowEdge[];
  viewport: Viewport;
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>;
  setNodes: React.Dispatch<React.SetStateAction<FlowNode<CanvasNodeData>[]>>;
  setEdges: React.Dispatch<React.SetStateAction<CanvasFlowEdge[]>>;
  buildFlowNode: (canvas: CanvasData) => FlowNode<CanvasNodeData>[];
  toFlowEdge: (edge: CanvasEdge) => CanvasFlowEdge;
  fromFlowNode: (node: FlowNode<CanvasNodeData>) => CanvasData['nodes'][number];
  fromFlowEdge: (edge: CanvasFlowEdge) => CanvasEdge;
  resetPreviewState: () => void;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
  setSavedHash: (path: string, hash: string) => void;
  addConflict: (conflict: { relativePath: string; ourContent: string; theirContent: string }) => void;
  myUserId: string;
  myUserName: string;
  isMountedRef: React.RefObject<boolean>;
  isDirtyRef: React.RefObject<boolean>;
  hashRef: React.RefObject<string | undefined>;
  lastWriteRef: React.RefObject<number>;
  markLoaded: (hash?: string | null) => void;
  shouldSkipAutosave: () => boolean;
  markWriteStarted: () => void;
  shouldCreateSnapshot: (hash: string) => boolean;
}

export function useCanvasDocumentSession({
  reactFlow,
  vault,
  relativePath,
  nodes,
  edges,
  viewport,
  setViewport,
  setNodes,
  setEdges,
  buildFlowNode,
  toFlowEdge,
  fromFlowNode,
  fromFlowEdge,
  resetPreviewState,
  markDirty,
  markSaved,
  setSavedHash,
  addConflict,
  myUserId,
  myUserName,
  isMountedRef,
  isDirtyRef,
  hashRef,
  lastWriteRef,
  markLoaded,
  shouldSkipAutosave,
  markWriteStarted,
  shouldCreateSnapshot,
}: UseCanvasDocumentSessionOptions) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  const loadCanvas = useCallback(async (isInitial = false) => {
    if (!vault || !relativePath) return;

    try {
      const { content, hash } = await tauriCommands.readNote(vault.path, relativePath);
      if (!isMountedRef.current) return;

      let canvas = EMPTY_CANVAS;
      let currentHash = hash;

      if (content.trim()) {
        canvas = JSON.parse(content) as CanvasData;
      } else if (isInitial) {
        const blank = EMPTY_CANVAS;
        const result = await tauriCommands.writeNote(vault.path, relativePath, JSON.stringify(blank, null, 2));
        currentHash = result.hash;
        canvas = blank;
      }

      markLoaded(currentHash);
      isDirtyRef.current = false;
      setSavedHash(relativePath, currentHash);
      resetPreviewState();
      setViewport(canvas.viewport ?? EMPTY_CANVAS.viewport);
      setNodes(buildFlowNode(canvas));
      setEdges(canvas.edges.map(toFlowEdge));
      pendingViewportRef.current = canvas.viewport ?? EMPTY_CANVAS.viewport;
      setLoadRevision((prev) => prev + 1);
    } catch {}
  }, [
    buildFlowNode,
    isDirtyRef,
    isMountedRef,
    markLoaded,
    relativePath,
    resetPreviewState,
    setEdges,
    setNodes,
    setSavedHash,
    setViewport,
    toFlowEdge,
    vault,
  ]);

  useEffect(() => {
    if (!relativePath) return;
    void loadCanvas(true);
  }, [loadCanvas, relativePath]);

  useEffect(() => {
    const nextViewport = pendingViewportRef.current;
    if (!nextViewport) return;
    pendingViewportRef.current = null;
    requestAnimationFrame(() => {
      void reactFlow.setViewport(nextViewport, { duration: 0 });
    });
  }, [loadRevision, reactFlow]);

  useEffect(() => {
    if (!vault || !relativePath) return;
    let unsub: (() => void) | undefined;

    listen<{ path: string }>('vault:file-modified', (event) => {
      if (event.payload.path !== relativePath) return;
      if (isDirtyRef.current) return;
      if (Date.now() - lastWriteRef.current < 2000) return;
      void loadCanvas(false);
    }).then((cleanup) => {
      unsub = cleanup;
    });

    return () => {
      unsub?.();
    };
  }, [isDirtyRef, lastWriteRef, loadCanvas, relativePath, vault]);

  const saveCanvas = useCallback(async () => {
    if (!vault || !relativePath) return;
    const payload: CanvasData = {
      nodes: nodes.map(fromFlowNode),
      edges: edges.map(fromFlowEdge),
      viewport,
    };
    const serialized = JSON.stringify(payload, null, 2);

    markWriteStarted();
    try {
      const result = await tauriCommands.writeNote(
        vault.path,
        relativePath,
        serialized,
        hashRef.current ?? undefined,
      );
      if (result.conflict) {
        addConflict({ ...result.conflict, ourContent: serialized });
        return;
      }
      if (isMountedRef.current) {
        hashRef.current = result.hash;
        isDirtyRef.current = false;
        markSaved(relativePath, result.hash);
        if (shouldCreateSnapshot(result.hash)) {
          tauriCommands.createSnapshot(
            vault.path,
            relativePath,
            serialized,
            myUserId,
            myUserName,
          ).catch(() => {});
        }
      }
    } catch {}
  }, [
    addConflict,
    edges,
    fromFlowEdge,
    fromFlowNode,
    hashRef,
    isDirtyRef,
    isMountedRef,
    markSaved,
    markWriteStarted,
    myUserId,
    myUserName,
    nodes,
    relativePath,
    shouldCreateSnapshot,
    vault,
    viewport,
  ]);

  useEffect(() => {
    if (!vault || !relativePath) return;
    if (shouldSkipAutosave()) {
      return;
    }
    isDirtyRef.current = true;
    markDirty(relativePath);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveCanvas();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [edges, isDirtyRef, markDirty, nodes, relativePath, saveCanvas, shouldSkipAutosave, vault, viewport]);
}
