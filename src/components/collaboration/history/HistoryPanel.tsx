import { useCallback, useEffect, useState } from 'react';

import { Clock3, Eye, RotateCcw } from 'lucide-react';

import { createVaultClient } from '../../../lib/vaultClient';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useVaultStore } from '../../../store/vaultStore';
import type { SnapshotMeta } from '../../../types/collab';
import { Button } from '../../ui/button';

import { relativeTime, supportsVersionHistoryTabType } from './historyUtils';
import { VersionHistoryModal } from './VersionHistoryModal';

export function HistoryPanel() {
  const { activeTabPath, openTabs, setForceReloadPath } = useEditorStore();
  const { vault } = useVaultStore();
  const { myUserId, myUserName } = useCollabStore();
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const activeTab = openTabs.find((tab) => tab.relativePath === activeTabPath) ?? null;
  const supportsHistory = supportsVersionHistoryTabType(activeTab?.type);

  const load = useCallback(async () => {
    if (!vault?.path || !activeTabPath || !supportsHistory) return;
    setLoading(true);
    try {
      const list = await createVaultClient(vault).listSnapshots(activeTabPath);
      setSnapshots(list);
    } catch {
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, [activeTabPath, supportsHistory, vault?.path]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = useCallback(
    async (snapshot: SnapshotMeta) => {
      if (!vault?.path || !activeTabPath) return;
      setRestoringId(snapshot.id);
      try {
        await createVaultClient(vault).restoreSnapshot(
          activeTabPath,
          snapshot.id,
          myUserId,
          myUserName,
        );
        setForceReloadPath(activeTabPath);
        await load();
      } finally {
        setRestoringId(null);
      }
    },
    [activeTabPath, load, myUserId, myUserName, setForceReloadPath, vault?.path],
  );

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
      <div className="flex h-full flex-col">
        <div className="border-b border-border/50 px-3 py-3">
          <p className="truncate text-xs font-medium text-foreground">
            {activeTabPath.split('/').pop()}
          </p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{activeTabPath}</p>
          <Button
            className="mt-3 w-full justify-center"
            variant="outline"
            size="sm"
            onClick={() => setHistoryModalOpen(true)}
          >
            <Eye size={14} />
            Open full history
          </Button>
        </div>
        {loading ? (
          <p className="px-3 py-6 text-xs text-muted-foreground text-center">Loading...</p>
        ) : snapshots.length === 0 ? (
          <p className="px-3 py-8 text-xs text-muted-foreground text-center">
            No snapshots yet. Save this document to create one.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto divide-y divide-border/40">
            {snapshots.slice(0, 8).map((snapshot) => (
              <div
                key={snapshot.id}
                className="flex items-center gap-2 px-3 py-2.5 hover:bg-muted/30 transition-colors group"
              >
                <Clock3 size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {snapshot.label ?? relativeTime(snapshot.timestamp)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {snapshot.authorName} · {relativeTime(snapshot.timestamp)}
                  </p>
                </div>
                <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => setHistoryModalOpen(true)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="View full history"
                  >
                    <Eye size={13} />
                  </button>
                  <button
                    onClick={() => void handleRestore(snapshot)}
                    disabled={restoringId === snapshot.id}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
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
      <VersionHistoryModal
        open={historyModalOpen}
        relativePath={activeTabPath}
        onOpenChange={setHistoryModalOpen}
      />
    </>
  );
}
