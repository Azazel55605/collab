import { useEffect, useCallback, useRef, useState, createContext, useContext } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LayoutDashboard } from 'lucide-react';
import { tauriCommands } from '../lib/tauri';
import { useVaultStore } from '../store/vaultStore';
import { useCollabStore } from '../store/collabStore';
import type { KanbanBoard } from '../types/kanban';
import type { KnownUser } from '../types/vault';
import KanbanBoardView from '../components/kanban/KanbanBoard';
import { useEditorStore } from '../store/editorStore';
import { useDocumentSessionState } from '../lib/documentSession';
import { useCollabContext } from '../components/collaboration/CollabProvider';

// ── Context ───────────────────────────────────────────────────────────────────

interface KanbanCtx {
  board: KanbanBoard;
  updateBoard: (updater: (b: KanbanBoard) => KanbanBoard) => void;
  knownUsers: KnownUser[];
  relativePath: string;
}

const KanbanContext = createContext<KanbanCtx | null>(null);

export function useKanbanContext(): KanbanCtx {
  const ctx = useContext(KanbanContext);
  if (!ctx) throw new Error('useKanbanContext must be used inside KanbanPage');
  return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDefaultBoard(): KanbanBoard {
  return {
    columns: [
      { id: crypto.randomUUID(), title: 'To Do',       cards: [] },
      { id: crypto.randomUUID(), title: 'In Progress', cards: [] },
      { id: crypto.randomUUID(), title: 'Done',        cards: [] },
    ],
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function KanbanPage({ relativePath }: { relativePath: string | null }) {
  const { vault } = useVaultStore();
  const { markDirty, markSaved, setSavedHash } = useEditorStore();
  const { peers, addConflict, myUserId, myUserName } = useCollabStore();
  const collabTransport = useCollabContext();
  const [board, setBoard]           = useState<KanbanBoard>({ columns: [] });
  const [knownUsers, setKnownUsers] = useState<KnownUser[]>([]);
  const isMountedRef    = useRef(true);
  const isDirtyRef      = useRef(false);
  const saveTimerRef    = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { hashRef, lastWriteRef, markLoaded, markWriteStarted, shouldCreateSnapshot } = useDocumentSessionState();

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const saveBoard = useCallback(async (newBoard: KanbanBoard) => {
    if (!vault || !relativePath) return;
    markWriteStarted();
    try {
      const serialized = JSON.stringify(newBoard, null, 2);
      const result = await tauriCommands.writeNote(
        vault.path,
        relativePath,
        serialized,
        hashRef.current,
      );
      if (result.conflict) {
        addConflict({
          ...result.conflict,
          ourContent: serialized,
        });
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
  }, [addConflict, markSaved, markWriteStarted, myUserId, myUserName, relativePath, shouldCreateSnapshot, vault?.path]);

  const updateBoard = useCallback((updater: (b: KanbanBoard) => KanbanBoard) => {
    setBoard(prev => {
      const next = updater(prev);
      if (next === prev) return prev;
      isDirtyRef.current = true;
      if (relativePath) markDirty(relativePath);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => saveBoard(next), 600);
      return next;
    });
  }, [markDirty, relativePath, saveBoard]);

  const loadBoard = useCallback(async (isInitial = false) => {
    if (!vault || !relativePath) return;
    try {
      const { content, hash } = await tauriCommands.readNote(vault.path, relativePath);
      if (!isMountedRef.current) return;
      if (content.trim()) {
        const parsed: KanbanBoard = JSON.parse(content);
        setBoard(parsed);
        isDirtyRef.current = false;
        markLoaded(hash);
        setSavedHash(relativePath, hash);
      } else if (isInitial) {
        const def = makeDefaultBoard();
        setBoard(def);
        const result = await tauriCommands.writeNote(
          vault.path, relativePath, JSON.stringify(def, null, 2), undefined,
        );
        isDirtyRef.current = false;
        markLoaded(result.hash);
        setSavedHash(relativePath, result.hash);
      }
    } catch {}
  }, [markLoaded, relativePath, setSavedHash, vault?.path]);

  useEffect(() => {
    loadBoard(true);
  }, [loadBoard]);

  // ── Collab: reload on peer edits ─────────────────────────────────────────

  useEffect(() => {
    if (!vault || !relativePath) return;
    let unsub: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', (event) => {
      if (event.payload.path !== relativePath) return;
      if (isDirtyRef.current) return;
      if (Date.now() - lastWriteRef.current < 2000) return;
      loadBoard(false);
    }).then(u => { unsub = u; });
    return () => { unsub?.(); };
  }, [vault?.path, relativePath, loadBoard]);

  // ── Known users (for assignee picker) ────────────────────────────────────

  useEffect(() => {
    if (!vault || !collabTransport) return;
    collabTransport.readVaultConfig()
      .then(config => { if (isMountedRef.current) setKnownUsers(config.knownUsers ?? []); })
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

  return (
    <KanbanContext.Provider value={{ board, updateBoard, knownUsers, relativePath }}>
      <KanbanBoardView />
    </KanbanContext.Provider>
  );
}
