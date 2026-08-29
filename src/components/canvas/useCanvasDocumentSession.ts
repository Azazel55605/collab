import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';
import type { Node as FlowNode, Viewport } from '@xyflow/react';

import { saveConflictedCopy } from '../../lib/conflictedCopy';
import { DOCUMENT_SNAPSHOT_INTERVAL_MS } from '../../lib/documentSession';
import {
  compareDocumentVersions,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type DocumentStatus,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../../lib/documentSessionController';
import {
  type JsonObject,
  type LiveJsonSession,
  openLiveJsonSession,
} from '../../lib/liveJsonDocument';
import { useLiveDocumentStatus } from '../../lib/useLiveDocumentStatus';
import { createVaultClient } from '../../lib/vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../../lib/vaultReplica';
import type { CanvasData, CanvasEdge } from '../../types/canvas';
import type { VaultMeta } from '../../types/vault';

import type { CanvasFlowEdge } from './CanvasEdgeTypes';
import type { CanvasNodeData } from './CanvasNodeTypes';

const SAVE_DEBOUNCE_MS = 600;
const LIVE_WRITE_DEBOUNCE_MS = 300;
// Re-enabled once the canvas CRDT path gained safety guarantees: the client only
// writes after the live state exactly matches the initial server snapshot
// (`liveHydratedRef`), refuses to open a session whose live state has lost REST
// nodes (`lostRestNodes`), and falls back to REST on an empty live root; the
// server refuses to materialize a node-losing canvas over a populated revision
// and reseeds a degenerate room from the canonical revision on load.
const LIVE_CANVAS_ENABLED = true;

/** Plain-JSON snapshot of canvas data for the live CRDT structure. */
function canvasToJson(canvas: CanvasData): JsonObject {
  return JSON.parse(JSON.stringify(canvas)) as JsonObject;
}
const EMPTY_CANVAS: CanvasData = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

export function sanitizeLoadedCanvasData(canvas: CanvasData) {
  const inputNodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
  const inputEdges = Array.isArray(canvas?.edges) ? canvas.edges : [];
  const nodes = inputNodes.filter(
    (node) =>
      !!node &&
      typeof node.id === 'string' &&
      typeof node.type === 'string' &&
      !!node.position &&
      Number.isFinite(node.position.x) &&
      Number.isFinite(node.position.y),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = inputEdges.filter(
    (edge) =>
      !!edge &&
      typeof edge.id === 'string' &&
      typeof edge.source === 'string' &&
      typeof edge.target === 'string' &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target),
  );
  const viewport =
    canvas?.viewport &&
    Number.isFinite(canvas.viewport.x) &&
    Number.isFinite(canvas.viewport.y) &&
    Number.isFinite(canvas.viewport.zoom)
      ? canvas.viewport
      : EMPTY_CANVAS.viewport;
  const changed =
    nodes.length !== inputNodes.length ||
    edges.length !== inputEdges.length ||
    viewport !== canvas?.viewport;

  if (!changed) {
    return { canvas, changed: false };
  }

  return {
    canvas: {
      ...canvas,
      nodes,
      edges,
      viewport,
    },
    changed: true,
  };
}

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
  myUserId: string;
  myUserName: string;
  myUserColor?: string;
  isMountedRef: React.RefObject<boolean>;
  /** Autosave is paused during transient interactions (e.g. drag). */
  pauseAutosave?: boolean;
  /** Viewer access to a hosted vault: never persist or auto-create the canvas. */
  readOnly?: boolean;
}

export interface CanvasDocumentSession {
  liveSession: LiveJsonSession | null;
  isLoading: boolean;
  refreshPulse: boolean;
  /** Shared document-session status vocabulary for the REST fallback path. */
  sessionStatus: DocumentStatus;
  /** Session controller for the central reconciliation review surface. */
  controller: DocumentSessionController<CanvasData>;
  /** Latest subscribed snapshot for the reconciliation surface. */
  snapshot: DocumentSessionSnapshot<CanvasData>;
  /** Persist the local canvas as a new revision/file ("Save mine as new"). */
  onSaveAsNew: (localContent: string) => Promise<void>;
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
  myUserId,
  myUserName,
  myUserColor,
  isMountedRef,
  pauseAutosave = false,
  readOnly = false,
}: UseCanvasDocumentSessionOptions): CanvasDocumentSession {
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const refreshPulseTimerRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const restCanvasRef = useRef<CanvasData | null>(null);
  const [restLoadedPath, setRestLoadedPath] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshPulse, setRefreshPulse] = useState(false);
  // Live co-editing session for hosted canvases; null = REST optimistic writes.
  const [liveSession, setLiveSession] = useState<LiveJsonSession | null>(null);
  const liveWriteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liveHydratedRef = useRef(false);
  const expectedLiveCanvasRef = useRef<string | null>(null);
  // After a controller-driven apply (load / remote adopt / merge), skip exactly
  // one local-change mark so re-applying the just-loaded state never marks dirty
  // even if the flow round-trip normalizes the serialization slightly.
  const firstMarkAfterApplyRef = useRef(false);

  // Periodic collaboration snapshot throttle (successful REST saves only).
  const lastSnapshotHashRef = useRef<string | null>(null);
  const lastSnapshotTimeRef = useRef(0);
  const shouldCreateSnapshot = useCallback((hash: string, now = Date.now()) => {
    if (hash === lastSnapshotHashRef.current) return false;
    if (now - lastSnapshotTimeRef.current < DOCUMENT_SNAPSHOT_INTERVAL_MS) return false;
    lastSnapshotHashRef.current = hash;
    lastSnapshotTimeRef.current = now;
    return true;
  }, []);

  // Applies a canvas document (remote live change or seed) to the editor state.
  const applyCanvas = useCallback(
    (canvas: CanvasData) => {
      const sanitized = sanitizeLoadedCanvasData(canvas).canvas;
      resetPreviewState();
      setViewport(sanitized.viewport ?? EMPTY_CANVAS.viewport);
      setNodes(buildFlowNode(sanitized));
      setEdges((sanitized.edges ?? []).map(toFlowEdge));
      pendingViewportRef.current = sanitized.viewport ?? EMPTY_CANVAS.viewport;
      setLoadRevision((prev) => prev + 1);
    },
    [buildFlowNode, resetPreviewState, setEdges, setNodes, setViewport, toFlowEdge],
  );

  const applyLiveCanvas = useCallback(
    (canvas: CanvasData) => {
      const sanitized = sanitizeLoadedCanvasData(canvas).canvas;
      liveHydratedRef.current = false;
      // Compare hydration against the exact ReactFlow round-trip because flow
      // conversion normalizes defaults and object key order.
      expectedLiveCanvasRef.current = JSON.stringify(
        canvasToJson({
          nodes: buildFlowNode(sanitized).map(fromFlowNode),
          edges: sanitized.edges.map(toFlowEdge).map(fromFlowEdge),
          viewport: sanitized.viewport,
        }),
      );
      applyCanvas(sanitized);
    },
    [applyCanvas, buildFlowNode, fromFlowEdge, fromFlowNode, toFlowEdge],
  );

  // Canonical serialized form of a canvas as it round-trips through the flow
  // editor. Used as the controller baseline so re-applying loaded content and the
  // first local-change mark produce byte-identical content (no spurious dirty).
  const roundTripCanonical = useCallback(
    (canvas: CanvasData): string =>
      JSON.stringify(
        canvasToJson({
          nodes: buildFlowNode(canvas).map(fromFlowNode),
          edges: canvas.edges.map(toFlowEdge).map(fromFlowEdge),
          viewport: canvas.viewport,
        }),
        null,
        2,
      ),
    [buildFlowNode, fromFlowEdge, fromFlowNode, toFlowEdge],
  );

  const parseCanvasContent = useCallback((content: string): CanvasData => {
    if (!content.trim()) return EMPTY_CANVAS;
    try {
      return sanitizeLoadedCanvasData(JSON.parse(content) as CanvasData).canvas;
    } catch {
      return EMPTY_CANVAS;
    }
  }, []);

  const pulseRefresh = useCallback(() => {
    setRefreshPulse(true);
    if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    refreshPulseTimerRef.current = window.setTimeout(() => setRefreshPulse(false), 420);
  }, []);

  // Adopt a controller document (initial load, safe remote apply, or backend
  // merge) into the editor and re-baseline the live-guard reference.
  const applyCanvasDocument = useCallback(
    (candidate: RemoteCandidate<CanvasData>) => {
      if (!isMountedRef.current) return;
      restCanvasRef.current = candidate.document;
      firstMarkAfterApplyRef.current = true;
      applyCanvas(candidate.document);
      setRestLoadedPath(relativePath);
      if (relativePath) setSavedHash(relativePath, candidate.version ?? '');
    },
    [applyCanvas, isMountedRef, relativePath, setSavedHash],
  );

  const { controller, snapshot } = useDocumentSessionController<CanvasData>({
    serialize: (canvas) => JSON.stringify(canvasToJson(canvas), null, 2),
    deserialize: parseCanvasContent,
    applyDocument: applyCanvasDocument,
    read: async () => {
      if (!client || !relativePath) return null;
      const doc = await client.readDocument(relativePath);
      return {
        content: roundTripCanonical(parseCanvasContent(doc.content)),
        version: doc.version,
        source: doc.source && doc.source !== 'network' ? 'cache' : 'rest',
      };
    },
    write: async ({ content, expectedVersion, baseContent }) => {
      if (!client || !relativePath || readOnly) return { version: expectedVersion ?? '' };
      const result = await client.writeDocument(
        relativePath,
        content,
        expectedVersion ?? undefined,
        baseContent,
      );
      if (result.conflict) {
        let theirVersion: string | null = null;
        try {
          theirVersion = (await client.readDocument(relativePath)).version;
        } catch {
          // Best-effort; a null version makes a keep-mine resolution overwrite.
        }
        return {
          version: expectedVersion ?? '',
          conflict: {
            theirContent: roundTripCanonical(parseCanvasContent(result.conflict.theirContent)),
            baseContent,
            theirVersion,
          },
        };
      }
      if (result.offlineQueued) return { version: result.version, offlineQueued: true };
      const savedContent = result.mergedContent ?? content;
      if (shouldCreateSnapshot(result.version)) {
        client.createSnapshot(relativePath, savedContent, myUserId, myUserName).catch(() => {});
      }
      return { version: result.version, mergedContent: result.mergedContent };
    },
    isLive: () => liveSession !== null,
    compareVersions: compareDocumentVersions,
    autosaveDebounceMs: SAVE_DEBOUNCE_MS,
  });
  useLiveDocumentStatus(controller, liveSession);

  // Initial load: sanitize, repair/seed the file if needed, then establish the
  // controller baseline (force explicit reload policy).
  const loadInitialCanvas = useCallback(async () => {
    if (!client || !relativePath) return;
    setIsLoading(true);
    try {
      const { content, version } = await client.readDocument(relativePath);
      if (!isMountedRef.current) return;

      let canvas = EMPTY_CANVAS;
      let currentVersion = version;

      if (content.trim()) {
        const sanitized = sanitizeLoadedCanvasData(JSON.parse(content) as CanvasData);
        canvas = sanitized.canvas;
        // Viewers cannot persist; skip the dangling-edge repair write.
        if (sanitized.changed && !readOnly && client.capabilities.nativeFilesystem) {
          try {
            const repaired = await client.writeDocument(
              relativePath,
              JSON.stringify(canvas, null, 2),
              currentVersion ?? undefined,
              content,
            );
            currentVersion = repaired.version;
          } catch {
            // Repair is best-effort; keep the sanitized canvas in memory.
          }
        }
      } else if (!readOnly) {
        const result = await client.writeDocument(
          relativePath,
          JSON.stringify(EMPTY_CANVAS, null, 2),
        );
        currentVersion = result.version;
      }

      if (!isMountedRef.current) return;
      controller.load(roundTripCanonical(canvas), currentVersion, 'rest');
    } catch {
      setRestLoadedPath(relativePath);
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, [client, controller, isMountedRef, readOnly, relativePath, roundTripCanonical]);

  useEffect(() => {
    if (!relativePath) return;
    void loadInitialCanvas();
  }, [loadInitialCanvas, relativePath]);

  // Open a live co-editing session for hosted canvases; fall back to REST when
  // unavailable. Remote changes flow in through `onChange`.
  useEffect(() => {
    if (
      !LIVE_CANVAS_ENABLED ||
      !client ||
      !relativePath ||
      !client.resolveLiveSession ||
      restLoadedPath !== relativePath
    ) {
      liveHydratedRef.current = false;
      expectedLiveCanvasRef.current = null;
      setLiveSession(null);
      return;
    }
    let cancelled = false;
    let opened: LiveJsonSession | null = null;
    let off: (() => void) | undefined;
    openLiveJsonSession(client, relativePath)
      .then((session) => {
        if (cancelled || !session) {
          session?.destroy();
          return;
        }
        opened = session;
        const initial = session.readJson();
        if (initial && Object.keys(initial).length > 0) {
          const liveCanvas = sanitizeLoadedCanvasData(initial as unknown as CanvasData).canvas;
          const restCanvas = restCanvasRef.current;
          const liveNodeIds = new Set(liveCanvas.nodes.map((node) => node.id));
          const lostRestNodes =
            restCanvas?.nodes.some((node) => !liveNodeIds.has(node.id)) ?? false;
          if (lostRestNodes) {
            // A live room must not replace the current canonical revision with a
            // suspiciously sparse state. This recovers rooms damaged by the
            // early structured-live startup/bigint regressions without
            // automatically writing or guessing at the missing content. Discard
            // the offline replica seed too so a degenerate cached state cannot
            // persist and re-trigger this on the next open.
            session.discardOfflineState();
            session.destroy();
            opened = null;
            return;
          }
          applyLiveCanvas(liveCanvas);
        } else {
          // The server owns seeding from the current REST revision. An empty
          // root means it could not provide a valid live canvas; keep the REST
          // document visible instead of seeding from potentially stale React
          // state (which may still be the initial empty canvas). Discard the
          // (empty) offline seed so it is not persisted back.
          session.discardOfflineState();
          session.destroy();
          opened = null;
          return;
        }
        off = session.onChange((json) => {
          if (!cancelled) applyLiveCanvas(json as unknown as CanvasData);
        });
        setLiveSession(session);
      })
      .catch(() => {
        // Best-effort; REST remains available.
      });
    return () => {
      cancelled = true;
      off?.();
      opened?.destroy();
      liveHydratedRef.current = false;
      expectedLiveCanvasRef.current = null;
      setLiveSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyLiveCanvas, client, relativePath, restLoadedPath]);

  useEffect(() => {
    if (!liveSession) return;
    liveSession.awareness.setLocalStateField('user', {
      id: myUserId,
      name: myUserName,
      color: myUserColor,
    });
    liveSession.awareness.setLocalStateField('document', {
      kind: 'canvas',
      relativePath,
    });
  }, [liveSession, myUserColor, myUserId, myUserName, relativePath]);

  // Publish the nodes this client currently has selected as ephemeral canvas
  // awareness so peers can see what each collaborator is working on. Only sent
  // when the selection set actually changes (not on every drag tick), and never
  // persisted as document content.
  const publishedSelectionRef = useRef<string>('');
  useEffect(() => {
    if (!liveSession) return;
    const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id);
    const key = selectedNodeIds.join(',');
    if (key === publishedSelectionRef.current) return;
    publishedSelectionRef.current = key;
    liveSession.awareness.setLocalStateField('canvas', { selectedNodeIds });
  }, [liveSession, nodes]);

  // Push local canvas edits into the live structure (debounced). Writing a value
  // that already matches the shared document is a no-op, so remote-applied
  // changes do not echo back.
  useEffect(() => {
    if (!liveSession || readOnly) return;
    const localCanvas = canvasToJson({
      nodes: nodes.map(fromFlowNode),
      edges: edges.map(fromFlowEdge),
      viewport,
    });
    if (!liveHydratedRef.current) {
      if (JSON.stringify(localCanvas) === expectedLiveCanvasRef.current) {
        liveHydratedRef.current = true;
      }
      return;
    }
    if (liveWriteTimerRef.current) clearTimeout(liveWriteTimerRef.current);
    liveWriteTimerRef.current = setTimeout(() => {
      liveSession.writeJson(localCanvas);
    }, LIVE_WRITE_DEBOUNCE_MS);
    return () => {
      if (liveWriteTimerRef.current) clearTimeout(liveWriteTimerRef.current);
    };
  }, [liveSession, readOnly, nodes, edges, viewport, fromFlowNode, fromFlowEdge]);

  useEffect(() => {
    const nextViewport = pendingViewportRef.current;
    if (!nextViewport) return;
    pendingViewportRef.current = null;
    requestAnimationFrame(() => {
      void reactFlow.setViewport(nextViewport, { duration: 0 });
    });
  }, [loadRevision, reactFlow]);

  // Local edits drive the controller (REST path only). Fires on any node/edge/
  // viewport change; the controller's content-equality treats selection-only or
  // no-op changes as clean, so they never autosave. Skipped while live (the CRDT
  // relay persists) or read-only.
  useEffect(() => {
    if (!vault || !relativePath || readOnly || liveSession) return;
    if (restLoadedPath !== relativePath) return;
    if (firstMarkAfterApplyRef.current) {
      firstMarkAfterApplyRef.current = false;
      return;
    }
    controller.markLocalChange({
      nodes: nodes.map(fromFlowNode),
      edges: edges.map(fromFlowEdge),
      viewport,
    });
  }, [
    controller,
    edges,
    fromFlowEdge,
    fromFlowNode,
    liveSession,
    nodes,
    readOnly,
    relativePath,
    restLoadedPath,
    vault,
    viewport,
  ]);

  // Pause/resume the controller autosave for transient interactions (drag, etc.).
  useEffect(() => {
    if (pauseAutosave) controller.pauseAutosave();
    else controller.resumeAutosave();
  }, [controller, pauseAutosave]);

  // Bridge the controller's dirty/version state to the tab dirty indicator.
  useEffect(() => {
    if (!relativePath || liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, snapshot.loadedVersion);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  // Local filesystem watcher: another writer changed this file. The controller
  // auto-applies when clean, queues when dirty, and ignores our own echo/stale.
  useEffect(() => {
    if (!client || !client.capabilities.filesystemWatch || !relativePath) return;
    let unsub: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', (event) => {
      if (event.payload.path !== relativePath) return;
      if (Date.now() - controller.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      void controller.handleExternalMutation('rest').then((decision) => {
        if (decision === 'applied') pulseRefresh();
      });
    }).then((cleanup) => {
      unsub = cleanup;
    });
    return () => {
      unsub?.();
    };
  }, [client, controller, pulseRefresh, relativePath]);

  // Hosted replica refresh: route through the same safe remote policy.
  useEffect(() => {
    if (!client || client.kind !== 'hosted' || !relativePath) return;
    return onReplicaMutated(
      (event) => {
        if (!replicaMutationAffectsPath(event, relativePath)) return;
        void controller.handleExternalMutation('cache').then((decision) => {
          if (decision === 'applied') pulseRefresh();
        });
      },
      { kinds: ['manifest'] },
    );
  }, [client, controller, pulseRefresh, relativePath]);

  useEffect(
    () => () => {
      if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    },
    [],
  );

  const onSaveAsNew = useCallback(
    async (localContent: string) => {
      if (!client || !relativePath) return;
      await saveConflictedCopy(client, relativePath, localContent);
    },
    [client, relativePath],
  );

  return {
    liveSession,
    isLoading,
    refreshPulse,
    sessionStatus: snapshot.status,
    controller,
    snapshot,
    onSaveAsNew,
  };
}
