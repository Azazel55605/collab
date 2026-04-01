import { useEffect, useCallback, useRef, useState, createContext, useContext } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LayoutDashboard } from 'lucide-react';
import { tauriCommands } from '../lib/tauri';
import { useVaultStore } from '../store/vaultStore';
import { useCollabStore } from '../store/collabStore';
import type { KanbanBoard } from '../types/kanban';
import type { KnownUser } from '../types/vault';
import KanbanBoardView from '../components/kanban/KanbanBoard';

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
  const { peers } = useCollabStore();
  const [board, setBoard]           = useState<KanbanBoard>({ columns: [] });
  const [knownUsers, setKnownUsers] = useState<KnownUser[]>([]);
  const hashRef         = useRef<string | undefined>(undefined);
  const saveTimerRef    = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastWriteRef    = useRef(0);
  const isMountedRef    = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // ── Save ─────────────────────────────────────────────────────────────────

  const saveBoard = useCallback(async (newBoard: KanbanBoard) => {
    if (!vault || !relativePath) return;
    lastWriteRef.current = Date.now();
    try {
      const result = await tauriCommands.writeNote(
        vault.path,
        relativePath,
        JSON.stringify(newBoard, null, 2),
        hashRef.current,
      );
      if (isMountedRef.current && !result.conflict) {
        hashRef.current = result.hash;
      }
    } catch {}
  }, [vault?.path, relativePath]);

  const updateBoard = useCallback((updater: (b: KanbanBoard) => KanbanBoard) => {
    setBoard(prev => {
      const next = updater(prev);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => saveBoard(next), 600);
      return next;
    });
  }, [saveBoard]);

  // ── Load ─────────────────────────────────────────────────────────────────

  const loadBoard = useCallback(async (isInitial = false) => {
    if (!vault || !relativePath) return;
    try {
      const { content, hash } = await tauriCommands.readNote(vault.path, relativePath);
      if (!isMountedRef.current) return;
      if (content.trim()) {
        const parsed: KanbanBoard = JSON.parse(content);
        setBoard(parsed);
        hashRef.current = hash;
      } else if (isInitial) {
        const def = makeDefaultBoard();
        setBoard(def);
        const result = await tauriCommands.writeNote(
          vault.path, relativePath, JSON.stringify(def, null, 2), undefined,
        );
        hashRef.current = result.hash;
      }
    } catch {}
  }, [vault?.path, relativePath]);

  useEffect(() => {
    loadBoard(true);
  }, [loadBoard]);

  // ── Collab: reload on peer edits ─────────────────────────────────────────

  useEffect(() => {
    if (!vault || !relativePath) return;
    let unsub: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', (event) => {
      if (event.payload.path !== relativePath) return;
      if (Date.now() - lastWriteRef.current < 2000) return; // skip self-writes
      loadBoard(false);
    }).then(u => { unsub = u; });
    return () => { unsub?.(); };
  }, [vault?.path, relativePath, loadBoard]);

  // ── Known users (for assignee picker) ────────────────────────────────────

  useEffect(() => {
    if (!vault) return;
    tauriCommands.getVaultConfig(vault.path)
      .then(config => { if (isMountedRef.current) setKnownUsers(config.knownUsers ?? []); })
      .catch(() => {});
  }, [vault?.path, peers.length]);

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
