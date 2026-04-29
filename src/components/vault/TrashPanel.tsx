import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Trash2, Trash, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';
import { useVaultStore } from '../../store/vaultStore';
import type { TrashEntry } from '../../types/vault';
import { ConfirmDeleteDialog, RestoreTrashDialog } from './VaultDialogs';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

function formatRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function TrashPanel() {
  const { vault } = useVaultStore();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoreEntry, setRestoreEntry] = useState<TrashEntry | null>(null);
  const [restoreTarget, setRestoreTarget] = useState('');
  const [purgeEntry, setPurgeEntry] = useState<TrashEntry | null>(null);
  const [purgeRemoveReferences, setPurgeRemoveReferences] = useState(false);
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadEntries = async () => {
    if (!vault) return;
    setLoading(true);
    try {
      setEntries(await tauriCommands.listTrashEntries(vault.path));
    } catch (error) {
      toast.error(`Failed to load trash: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadEntries();
  }, [vault?.path]);

  const totalSize = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.size, 0),
    [entries],
  );

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return entries;
    return entries.filter((entry) =>
      entry.rootName.toLocaleLowerCase().includes(query)
      || entry.originalRelativePath.toLocaleLowerCase().includes(query)
      || entry.itemKind.toLocaleLowerCase().includes(query)
      || (entry.extension ?? '').toLocaleLowerCase().includes(query)
      || (entry.deletedByUserName ?? '').toLocaleLowerCase().includes(query),
    );
  }, [entries, searchQuery]);

  const handleRestore = async () => {
    if (!vault || !restoreEntry) return;
    try {
      await tauriCommands.restoreTrashedItem(vault.path, restoreEntry.id, restoreTarget.trim());
      setRestoreEntry(null);
      setRestoreTarget('');
      await loadEntries();
      await useVaultStore.getState().refreshFileTree();
      toast.success(`Restored ${restoreEntry.rootName}`);
    } catch (error) {
      toast.error(`Failed to restore item: ${error}`);
    }
  };

  const handlePurge = async (entry: TrashEntry) => {
    if (!vault) return;
    try {
      await tauriCommands.purgeTrashedItem(vault.path, entry.id, purgeRemoveReferences);
      setPurgeEntry(null);
      setPurgeRemoveReferences(false);
      await loadEntries();
      toast.success(`Permanently deleted ${entry.rootName}`);
    } catch (error) {
      toast.error(`Failed to purge item: ${error}`);
    }
  };

  const handlePurgeAll = async () => {
    if (!vault) return;
    try {
      await tauriCommands.purgeAllTrash(vault.path);
      await loadEntries();
      toast.success('Purged all trashed items');
    } catch (error) {
      toast.error(`Failed to purge trash: ${error}`);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <RestoreTrashDialog
        open={!!restoreEntry}
        entry={restoreEntry}
        targetPath={restoreTarget}
        onTargetPathChange={setRestoreTarget}
        onConfirm={() => void handleRestore()}
        onCancel={() => {
          setRestoreEntry(null);
          setRestoreTarget('');
        }}
      />
      <ConfirmDeleteDialog
        open={!!purgeEntry}
        name={purgeEntry?.rootName ?? ''}
        isFolder={purgeEntry?.itemKind === 'folder'}
        primaryActionLabel="Delete permanently"
        showReferenceOption
        removeReferences={purgeRemoveReferences}
        onRemoveReferencesChange={setPurgeRemoveReferences}
        onConfirm={() => {
          if (purgeEntry) void handlePurge(purgeEntry);
        }}
        onCancel={() => {
          setPurgeEntry(null);
          setPurgeRemoveReferences(false);
        }}
      />
      <ConfirmDeleteDialog
        open={purgeAllOpen}
        name="all trashed items"
        isFolder
        primaryActionLabel="Purge all permanently"
        onConfirm={() => {
          setPurgeAllOpen(false);
          void handlePurgeAll();
        }}
        onCancel={() => setPurgeAllOpen(false)}
      />

      <div className="flex items-center justify-between gap-2 border-b border-border/30 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Vault Trash</div>
          <div className="text-[11px] text-muted-foreground">
            {entries.length} items · {Math.round(totalSize / 1024)} KB
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => void loadEntries()}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
              >
                <RefreshCw size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs text-foreground">Refresh trash</TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPurgeAllOpen(true)}
            disabled={entries.length === 0 || loading}
            className="h-6 px-2 text-[11px]"
          >
            <Trash size={12} className="mr-1" />
            Purge all
          </Button>
        </div>
      </div>

      <div className="border-b border-border/30 px-2 py-2">
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search trash…"
          className="h-8 text-xs"
        />
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground/60">Loading trash…</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground/50">
            <Trash size={24} className="mx-auto mb-2 opacity-30" />
            <p>Trash is empty.</p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground/50">
            <p>No trashed items match “{searchQuery.trim()}”.</p>
          </div>
        ) : (
          filteredEntries.map((entry) => (
            <div key={entry.id} className="mx-1 rounded-sm px-2 py-2 hover:bg-accent/40">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-medium text-foreground">{entry.rootName}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground truncate">{entry.originalRelativePath}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {entry.itemKind} · {formatRelativeTime(entry.deletedAt)}
                    {entry.deletedByUserName ? ` · ${entry.deletedByUserName}` : ''}
                  </div>
                  {entry.restoreConflict && (
                    <div className="mt-1 text-[10px] text-amber-500">
                      Original path occupied · suggested: {entry.restoreConflict.suggestedRelativePath}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          setRestoreEntry(entry);
                          setRestoreTarget(entry.restoreConflict?.suggestedRelativePath ?? entry.originalRelativePath);
                        }}
                        aria-label={`Restore ${entry.rootName}`}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/70 hover:text-foreground transition-colors"
                      >
                        <RotateCcw size={12} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs text-foreground">Restore</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          setPurgeEntry(entry);
                          setPurgeRemoveReferences(false);
                        }}
                        aria-label={`Purge ${entry.rootName}`}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs text-foreground">Delete permanently</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
