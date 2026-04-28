import { useState, useEffect, useCallback } from 'react';
import { RotateCcw, Eye, Clock } from 'lucide-react';
import { useEditorStore } from '../../../store/editorStore';
import { useVaultStore } from '../../../store/vaultStore';
import { useCollabStore } from '../../../store/collabStore';
import { tauriCommands } from '../../../lib/tauri';
import type { SnapshotMeta } from '../../../types/collab';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface DiffModalProps {
  snapshotContent: string;
  currentContent: string;
  onClose: () => void;
}

function DiffModal({ snapshotContent, currentContent, onClose }: DiffModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-xl shadow-2xl w-[80vw] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium">Snapshot content</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs px-2 py-1 rounded hover:bg-muted">
            Close
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 divide-x divide-border h-full">
            <div className="p-3">
              <p className="text-xs text-muted-foreground mb-2 font-medium">Snapshot</p>
              <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80">{snapshotContent}</pre>
            </div>
            <div className="p-3">
              <p className="text-xs text-muted-foreground mb-2 font-medium">Current</p>
              <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80">{currentContent}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HistoryPanel() {
  const { activeTabPath, openTabs, setForceReloadPath } = useEditorStore();
  const { vault } = useVaultStore();
  const { myUserId, myUserName } = useCollabStore();
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [diffState, setDiffState] = useState<{ snapshot: string; current: string } | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const activeTab = openTabs.find((tab) => tab.relativePath === activeTabPath) ?? null;
  const supportsHistory = activeTab ? ['note', 'kanban', 'canvas'].includes(activeTab.type) : false;

  const load = useCallback(async () => {
    if (!vault || !activeTabPath || !supportsHistory) return;
    setLoading(true);
    try {
      const list = await tauriCommands.listSnapshots(vault.path, activeTabPath);
      setSnapshots(list);
    } catch {
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, [vault?.path, activeTabPath, supportsHistory]);

  useEffect(() => { load(); }, [load]);

  const handleView = async (snap: SnapshotMeta) => {
    if (!vault || !activeTabPath) return;
    try {
      const [snapshotContent, noteContent] = await Promise.all([
        tauriCommands.readSnapshot(vault.path, activeTabPath, snap.id),
        tauriCommands.readNote(vault.path, activeTabPath).then((n) => n.content),
      ]);
      setDiffState({ snapshot: snapshotContent, current: noteContent });
    } catch {}
  };

  const handleRestore = async (snap: SnapshotMeta) => {
    if (!vault || !activeTabPath) return;
    setRestoringId(snap.id);
    try {
      await tauriCommands.restoreSnapshot(vault.path, activeTabPath, snap.id, myUserId, myUserName);
      setForceReloadPath(activeTabPath);
      load();
    } catch {
    } finally {
      setRestoringId(null);
    }
  };

  if (!activeTabPath) {
    return (
      <p className="px-3 py-8 text-xs text-muted-foreground text-center">
        Open a note, kanban board, or canvas to see its history
      </p>
    );
  }

  if (!supportsHistory) {
    return (
      <p className="px-3 py-8 text-xs text-muted-foreground text-center">
        History is available for notes, kanban boards, and canvas boards.
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-col">
        <div className="px-3 py-2 border-b border-border/50">
          <p className="text-xs text-muted-foreground truncate">{activeTabPath.split('/').pop()}</p>
        </div>
        {loading ? (
          <p className="px-3 py-6 text-xs text-muted-foreground text-center">Loading...</p>
        ) : snapshots.length === 0 ? (
          <p className="px-3 py-8 text-xs text-muted-foreground text-center">
            No snapshots yet. Save this document to create one.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border/40">
            {snapshots.map((snap) => (
              <div key={snap.id} className="flex items-center gap-2 px-3 py-2.5 hover:bg-muted/30 transition-colors group">
                <Clock size={13} className="text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">
                    {snap.label ?? relativeTime(snap.timestamp)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {snap.authorName} · {relativeTime(snap.timestamp)}
                  </p>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleView(snap)}
                    className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    title="View"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    onClick={() => handleRestore(snap)}
                    disabled={restoringId === snap.id}
                    className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40"
                    title="Restore"
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {diffState && (
        <DiffModal
          snapshotContent={diffState.snapshot}
          currentContent={diffState.current}
          onClose={() => setDiffState(null)}
        />
      )}
    </>
  );
}
