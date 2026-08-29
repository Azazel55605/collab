import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { listen } from '@tauri-apps/api/event';
import { LayoutDashboard, Loader2 } from 'lucide-react';

import { useCollabContext } from '../components/collaboration/CollabProvider';
import KanbanBoardView from '../components/kanban/KanbanBoard';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import { useCollabIdentity } from '../lib/collabIdentity';
import { saveConflictedCopy } from '../lib/conflictedCopy';
import { DOCUMENT_SNAPSHOT_INTERVAL_MS } from '../lib/documentSession';
import {
  compareDocumentVersions,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type DocumentStatus,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../lib/documentSessionController';
import {
  buildKanbanCardEditors,
  type LiveAwarenessUser,
  type LivePeer,
  useLivePeers,
} from '../lib/liveAwareness';
import {
  type JsonObject,
  type LiveJsonSession,
  openLiveJsonSession,
} from '../lib/liveJsonDocument';
import { useLiveDocumentStatus } from '../lib/useLiveDocumentStatus';
import { createVaultClient } from '../lib/vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../lib/vaultReplica';
import { useCollabStore } from '../store/collabStore';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useKanbanStore } from '../store/kanbanStore';
import { useVaultStore } from '../store/vaultStore';
import { type KanbanBoard, normalizeKanbanBoard, runKanbanAutomations } from '../types/kanban';
import { isVaultReadOnly, type KnownUser, vaultCan } from '../types/vault';

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * Per-action kanban capabilities for the open vault. Local vaults are always
 * fully capable; hosted vaults resolve each flag from the caller's effective
 * capabilities so controls that would be rejected by the server's semantic
 * kanban enforcement are never offered.
 */
export interface KanbanCapabilities {
  addCard: boolean;
  editContent: boolean;
  move: boolean;
  comment: boolean;
  archive: boolean;
  deleteCard: boolean;
  columnManage: boolean;
}

/** All capabilities granted — the default for local vaults and isolated tests. */
export const FULL_KANBAN_CAPABILITIES: KanbanCapabilities = {
  addCard: true,
  editContent: true,
  move: true,
  comment: true,
  archive: true,
  deleteCard: true,
  columnManage: true,
};

interface KanbanCtx {
  board: KanbanBoard;
  updateBoard: (updater: (b: KanbanBoard) => KanbanBoard) => void;
  knownUsers: KnownUser[];
  relativePath: string;
  /** Viewer access to a hosted vault: board mutations are disabled. */
  readOnly: boolean;
  /** Fine-grained capability gates for individual board actions. */
  caps: KanbanCapabilities;
  /**
   * Remote co-editors of this board from the live awareness relay (empty when
   * editing over REST). Drives the live co-editor strip.
   */
  livePeers: LivePeer[];
  /**
   * Map of card id -> remote peer currently editing that card, so cards can show
   * a "being edited by X" indicator. Empty when no live session is active.
   */
  remoteCardEditors: Map<string, LiveAwarenessUser>;
  /** Shared document-session status vocabulary for the REST fallback path. */
  sessionStatus: DocumentStatus;
}

const KanbanContext = createContext<KanbanCtx | null>(null);

export function useKanbanContext(): KanbanCtx {
  const ctx = useContext(KanbanContext);
  if (!ctx) throw new Error('useKanbanContext must be used inside KanbanPage');
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDefaultBoard(): KanbanBoard {
  return normalizeKanbanBoard({
    columns: [
      { id: crypto.randomUUID(), title: 'To Do', cards: [] },
      { id: crypto.randomUUID(), title: 'In Progress', cards: [] },
      { id: crypto.randomUUID(), title: 'Done', cards: [] },
    ],
  });
}

/** Plain-JSON snapshot of a board for the live CRDT structure. */
function boardToJson(board: KanbanBoard): JsonObject {
  return JSON.parse(JSON.stringify(normalizeKanbanBoard(board))) as JsonObject;
}

/** The board as displayed after opening (normalize + open-time automations). */
function displayBoard(raw: KanbanBoard): KanbanBoard {
  return runKanbanAutomations(normalizeKanbanBoard(raw), 'onBoardOpen');
}

/** Raw normalized serialization used as the controller's dirty-tracking form. */
function serializeBoardRaw(board: KanbanBoard): string {
  return JSON.stringify(normalizeKanbanBoard(board), null, 2);
}

function parseBoardContent(content: string): KanbanBoard {
  if (!content.trim()) return makeDefaultBoard();
  try {
    return normalizeKanbanBoard(JSON.parse(content) as KanbanBoard);
  } catch {
    return makeDefaultBoard();
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function KanbanPage({ relativePath }: { relativePath: string | null }) {
  const { vault } = useVaultStore();
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const liveVaultKey =
    vault?.kind === 'hosted' ? `${vault.serverUrl}::${vault.hostedVaultId}` : null;
  const liveClient = useMemo(
    () => (vault?.kind === 'hosted' ? createVaultClient(vault) : null),
    [liveVaultKey],
  );
  const readOnly = isVaultReadOnly(vault);
  // Per-action capability gates. A viewer (readOnly) holds none; local vaults
  // hold all. Hosted writes also require baseline file.write, which the viewer
  // role already reflects, so an editor-or-better resolves these from their
  // effective kanban capabilities.
  const caps = useMemo<KanbanCapabilities>(
    () => ({
      addCard: vaultCan(vault, 'kanban.card.create'),
      editContent: vaultCan(vault, 'kanban.card.editContent'),
      move: vaultCan(vault, 'kanban.card.move'),
      comment: vaultCan(vault, 'kanban.card.comment'),
      archive: vaultCan(vault, 'kanban.card.archive'),
      deleteCard: vaultCan(vault, 'kanban.card.delete'),
      columnManage: vaultCan(vault, 'kanban.column.manage'),
    }),
    [vault],
  );
  const { markDirty, markSaved, setSavedHash } = useEditorStore();
  const { peers } = useCollabStore();
  // Snapshot authorship follows the effective identity (server-authoritative for hosted).
  const { userId: myUserId, userName: myUserName, userColor: myUserColor } = useCollabIdentity();
  const collabTransport = useCollabContext();
  const [board, setBoard] = useState<KanbanBoard>({ columns: [] });
  const [knownUsers, setKnownUsers] = useState<KnownUser[]>([]);
  // Live co-editing session for hosted boards; null = REST optimistic-write path.
  const [liveSession, setLiveSession] = useState<LiveJsonSession | null>(null);
  const liveSessionRef = useRef<LiveJsonSession | null>(null);
  const [isLoadingBoard, setIsLoadingBoard] = useState(false);
  const [refreshPulse, setRefreshPulse] = useState(false);
  // Mirrors the latest board so live edits and remote merges always derive from
  // the freshest state (including just-applied remote changes).
  const boardRef = useRef(board);
  boardRef.current = board;
  const isMountedRef = useRef(true);
  const refreshPulseTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    };
  }, []);

  // Adopt a controller document (initial load, safe remote apply, or backend
  // merge) into the board, applying open-time automations for display.
  const applyBoard = useCallback(
    (candidate: RemoteCandidate<KanbanBoard>) => {
      if (!isMountedRef.current) return;
      const next = displayBoard(candidate.document);
      boardRef.current = next;
      setBoard(next);
      if (relativePath) setSavedHash(relativePath, candidate.version ?? '');
    },
    [relativePath, setSavedHash],
  );

  const { controller, snapshot } = useDocumentSessionController<KanbanBoard>({
    serialize: serializeBoardRaw,
    deserialize: parseBoardContent,
    applyDocument: applyBoard,
    read: async () => {
      if (!client || !relativePath) return null;
      const doc = await client.readDocument(relativePath);
      return {
        content: serializeBoardRaw(displayBoard(parseBoardContent(doc.content))),
        version: doc.version,
        source: doc.source && doc.source !== 'network' ? 'cache' : 'rest',
      };
    },
    write: async ({ content, expectedVersion, baseContent }) => {
      if (!client || !relativePath || readOnly) return { version: expectedVersion ?? '' };
      // Apply save-time automations before persisting (matches the legacy path).
      const automated = runKanbanAutomations(parseBoardContent(content), 'onBoardSave');
      const automatedContent = JSON.stringify(automated, null, 2);
      const result = await client.writeDocument(
        relativePath,
        automatedContent,
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
            theirContent: serializeBoardRaw(
              displayBoard(parseBoardContent(result.conflict.theirContent)),
            ),
            baseContent,
            theirVersion,
          },
        };
      }
      if (result.offlineQueued) return { version: result.version, offlineQueued: true };
      const savedContent = result.mergedContent ?? automatedContent;
      if (shouldCreateSnapshot(result.version)) {
        client.createSnapshot(relativePath, savedContent, myUserId, myUserName).catch(() => {});
      }
      // Return the automated/merged content so the controller adopts any
      // automation-applied changes back into the displayed board.
      return { version: result.version, mergedContent: result.mergedContent ?? automatedContent };
    },
    isLive: () => liveSessionRef.current !== null,
    compareVersions: compareDocumentVersions,
    autosaveDebounceMs: 600,
  });

  const updateBoard = useCallback(
    (updater: (b: KanbanBoard) => KanbanBoard) => {
      // Viewers cannot modify the board; drop every mutation so no write is attempted.
      if (readOnly) return;
      // Derive from the latest board (which includes remote merges) and avoid
      // mutating inside a setState updater so a double-invoked updater cannot apply
      // the edit twice.
      const next = updater(boardRef.current);
      if (next === boardRef.current) return;
      boardRef.current = next;
      setBoard(next);
      if (liveSessionRef.current) {
        // Live session: apply the edit to the shared CRDT structure; the server persists.
        liveSessionRef.current.writeJson(boardToJson(next));
      } else {
        // REST fallback: the controller debounces the autosave and serializes writes.
        controller.markLocalChange(next);
      }
    },
    [controller, readOnly],
  );

  const loadBoard = useCallback(
    async (isInitial = false): Promise<void> => {
      if (!client || !relativePath) return;
      if (isInitial) setIsLoadingBoard(true);
      try {
        const { content, version } = await client.readDocument(relativePath);
        if (!isMountedRef.current || liveSessionRef.current) return;
        if (content.trim()) {
          const displayed = displayBoard(normalizeKanbanBoard(JSON.parse(content) as KanbanBoard));
          controller.load(serializeBoardRaw(displayed), version, 'rest');
        } else if (isInitial && !readOnly) {
          const def = makeDefaultBoard();
          const result = await client.writeDocument(
            relativePath,
            JSON.stringify(def, null, 2),
            undefined,
          );
          if (!isMountedRef.current) return;
          controller.load(serializeBoardRaw(displayBoard(def)), result.version, 'rest');
        }
      } catch {
        // Best-effort; the current board state remains usable.
      } finally {
        if (isMountedRef.current && !liveSessionRef.current) setIsLoadingBoard(false);
      }
    },
    [client, controller, readOnly, relativePath],
  );

  useEffect(() => {
    loadBoard(true);
  }, [loadBoard]);

  useLiveDocumentStatus(controller, liveSession);

  // Bridge the controller's dirty/version state to the tab dirty indicator.
  useEffect(() => {
    if (!relativePath || liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, snapshot.loadedVersion);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const pulseRefresh = useCallback(() => {
    setRefreshPulse(true);
    if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    refreshPulseTimerRef.current = window.setTimeout(() => setRefreshPulse(false), 420);
  }, []);

  const onSaveAsNew = useCallback(
    async (localContent: string) => {
      if (!client || !relativePath) return;
      await saveConflictedCopy(client, relativePath, localContent);
    },
    [client, relativePath],
  );

  const documentStatus = useMemo(
    () => ({
      status: snapshot.status,
      controller: controller as DocumentSessionController<unknown>,
      snapshot: snapshot as DocumentSessionSnapshot<unknown>,
      onSaveAsNew,
      readOnly,
    }),
    [controller, onSaveAsNew, readOnly, snapshot],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  // Open a live co-editing session for hosted boards; fall back to REST when
  // unavailable. Remote changes (and the initial seeded state) flow in through
  // `onChange`; the board seeds the room if the server has not already.
  useEffect(() => {
    if (!liveClient || !relativePath || !liveClient.resolveLiveSession) {
      setLiveSession(null);
      return;
    }
    let cancelled = false;
    let opened: LiveJsonSession | null = null;
    let off: (() => void) | undefined;
    openLiveJsonSession(liveClient, relativePath)
      .then((session) => {
        if (cancelled || !session) {
          session?.destroy();
          return;
        }
        opened = session;
        const initial = session.readJson();
        if (initial && Object.keys(initial).length > 0) {
          const next = runKanbanAutomations(
            normalizeKanbanBoard(initial as unknown as KanbanBoard),
            'onBoardOpen',
          );
          boardRef.current = next;
          setBoard(next);
        } else {
          // The server owns seeding from the current REST revision. Do not seed
          // an empty live root from React state that may still be the initial
          // blank board. Discard the (empty) offline seed so it is not persisted.
          session.discardOfflineState();
          session.destroy();
          opened = null;
          return;
        }
        off = session.onChange((json) => {
          if (cancelled) return;
          const next = runKanbanAutomations(
            normalizeKanbanBoard(json as unknown as KanbanBoard),
            'onBoardOpen',
          );
          boardRef.current = next;
          setBoard(next);
        });
        liveSessionRef.current = session;
        setLiveSession(session);
        setIsLoadingBoard(false);
      })
      .catch(() => {
        // Best-effort; REST remains available.
      });
    return () => {
      cancelled = true;
      off?.();
      opened?.destroy();
      liveSessionRef.current = null;
      setLiveSession(null);
    };
  }, [liveClient, relativePath]);

  useEffect(() => {
    if (!liveSession) return;
    liveSession.awareness.setLocalStateField('user', {
      id: myUserId,
      name: myUserName,
      color: myUserColor,
    });
    liveSession.awareness.setLocalStateField('document', {
      kind: 'kanban',
      relativePath,
    });
  }, [liveSession, myUserColor, myUserId, myUserName, relativePath]);

  // ── Live awareness: publish the open card, consume remote peers ──────────
  const { boardPath: editingBoardPath, cardId: editingCardId } = useKanbanStore();
  const myOpenCardId = editingBoardPath === relativePath ? editingCardId : null;
  useEffect(() => {
    if (!liveSession) return;
    // Ephemeral only — the card a client has open is awareness, never persisted
    // as board content.
    liveSession.awareness.setLocalStateField('kanban', { editingCardId: myOpenCardId ?? null });
  }, [liveSession, myOpenCardId]);
  const livePeers = useLivePeers(liveSession);
  const remoteCardEditors = useMemo(() => buildKanbanCardEditors(livePeers), [livePeers]);

  // ── Collab: reload on peer edits ─────────────────────────────────────────

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
    }).then((u) => {
      unsub = u;
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

  // ── Known users (for assignee picker) ────────────────────────────────────

  useEffect(() => {
    if (!vault || !collabTransport) return;
    collabTransport
      .readVaultConfig()
      .then((config) => {
        if (isMountedRef.current) setKnownUsers(config.knownUsers ?? []);
      })
      .catch(() => {});
  }, [collabTransport, vault?.path, peers.length]);

  // ── Empty state ──────────────────────────────────────────────────────────

  if (!relativePath) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-muted-foreground gap-3 select-none">
        <LayoutDashboard size={40} className="opacity-30" />
        <p className="text-lg font-medium">Kanban Board</p>
        <p className="text-sm opacity-60">Select or create a board from the sidebar.</p>
      </div>
    );
  }

  if (!vault) return null;

  if (isLoadingBoard && board.columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        Loading board…
      </div>
    );
  }

  return (
    <KanbanContext.Provider
      value={{
        board,
        updateBoard,
        knownUsers,
        relativePath,
        readOnly,
        caps,
        livePeers,
        remoteCardEditors,
        sessionStatus: snapshot.status,
      }}
    >
      <div
        className={`h-full min-h-0 app-document-ready ${refreshPulse ? 'app-refresh-pulse' : ''}`}
      >
        {readOnly && <ReadOnlyBanner />}
        <KanbanBoardView />
      </div>
    </KanbanContext.Provider>
  );
}
