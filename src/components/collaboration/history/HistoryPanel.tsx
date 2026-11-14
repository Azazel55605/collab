import { useCallback, useEffect, useState } from 'react';

import { FileClock, GitCompareArrows, History, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { createVaultClient } from '../../../lib/vaultClient';
import { getVaultDocumentTitle } from '../../../lib/vaultLinks';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useVaultStore } from '../../../store/vaultStore';
import type { SnapshotMeta } from '../../../types/collab';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';

import { relativeTime, supportsVersionHistoryTabType } from './historyUtils';
import { VersionHistoryModal } from './VersionHistoryModal';

const DAY_MS = 24 * 60 * 60 * 1000;

function dayGroup(timestamp: number): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday.getTime()) return 'Today';
  if (timestamp >= startOfToday.getTime() - DAY_MS) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(timestamp);
}

function clock(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    timestamp,
  );
}

/**
 * Versions of the open document as a timeline: named versions with their
 * author, unnamed snapshots in grey. Save version is the primary action;
 * compare opens the full history with its diff.
 */
export function HistoryPanel() {
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const openTabs = useEditorStore((state) => state.openTabs);
  const setForceReloadPath = useEditorStore((state) => state.setForceReloadPath);
  const vault = useVaultStore((state) => state.vault);
  const myUserId = useCollabStore((state) => state.myUserId);
  const myUserName = useCollabStore((state) => state.myUserName);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [namedOnly, setNamedOnly] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [versionName, setVersionName] = useState('');
  const [saving, setSaving] = useState(false);
  const activeTab = openTabs.find((tab) => tab.relativePath === activeTabPath) ?? null;
  const supportsHistory = supportsVersionHistoryTabType(activeTab?.type);

  const load = useCallback(async () => {
    if (!vault?.path || !activeTabPath || !supportsHistory) return;
    setLoading(true);
    try {
      const list = await createVaultClient(vault).listSnapshots(activeTabPath);
      setSnapshots([...list].sort((a, b) => b.timestamp - a.timestamp));
    } catch {
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    [activeTabPath, load, myUserId, myUserName, setForceReloadPath, vault],
  );

  const saveVersion = async () => {
    if (!vault || !activeTabPath) return;
    setSaving(true);
    try {
      const client = createVaultClient(vault);
      const document = await client.readDocument(activeTabPath);
      await client.createSnapshot(
        activeTabPath,
        document.content,
        myUserId,
        myUserName,
        versionName.trim() || undefined,
      );
      setSaveOpen(false);
      setVersionName('');
      await load();
      toast.success('Version saved');
    } catch (error) {
      toast.error(`Could not save the version: ${error}`);
    } finally {
      setSaving(false);
    }
  };

  if (!activeTabPath) {
    return (
      <p className="px-3 py-8 text-center text-xs text-muted-foreground">
        Open a note, kanban board, or canvas to see its history
      </p>
    );
  }

  if (!supportsHistory) {
    return (
      <p className="px-3 py-8 text-center text-xs text-muted-foreground">
        History is available for notes, kanban boards, and canvas boards.
      </p>
    );
  }

  const shown = namedOnly ? snapshots.filter((snapshot) => snapshot.label) : snapshots;
  const groups: { label: string; items: SnapshotMeta[] }[] = [];
  for (const snapshot of shown) {
    const label = dayGroup(snapshot.timestamp);
    const group = groups[groups.length - 1];
    if (group?.label === label) group.items.push(snapshot);
    else groups.push({ label, items: [snapshot] });
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="shrink-0 px-2.5 pb-2">
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/50 p-2.5">
            <FileClock className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-medium">
                {getVaultDocumentTitle(activeTabPath)}
              </p>
              <p className="truncate text-[11.5px] text-muted-foreground">
                {snapshots[0]
                  ? `Last version ${relativeTime(snapshots[0].timestamp)}`
                  : 'No versions yet'}
              </p>
            </div>
            <Popover open={saveOpen} onOpenChange={setSaveOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" title="Save the document as it is saved now">
                  Save version
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64">
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveVersion();
                  }}
                >
                  <label htmlFor="version-name" className="text-xs font-medium">
                    Name this version
                  </label>
                  <Input
                    id="version-name"
                    autoFocus
                    value={versionName}
                    onChange={(event) => setVersionName(event.target.value)}
                    placeholder="Agenda finalised"
                    className="h-8"
                  />
                  <Button type="submit" size="sm" disabled={saving}>
                    {saving ? 'Saving…' : 'Save version'}
                  </Button>
                </form>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5 px-2.5 pb-2" role="group" aria-label="Show">
          {[
            { value: false, label: 'All changes' },
            { value: true, label: 'Named only' },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={namedOnly === option.value}
              onClick={() => setNamedOnly(option.value)}
              className={
                namedOnly === option.value
                  ? 'h-6 rounded-full bg-primary/15 px-2.5 text-[11.5px] font-medium text-foreground'
                  : 'h-6 rounded-full px-2.5 text-[11.5px] text-muted-foreground hover:bg-muted hover:text-foreground'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        {loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            {namedOnly ? 'No named versions yet.' : 'No versions yet. Save one to start.'}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-2">
            {groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h3 className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </h3>
                {group.items.map((snapshot) => (
                  <div
                    key={snapshot.id}
                    className="group flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1 transition-colors hover:bg-sidebar-accent/50"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-border bg-background text-muted-foreground">
                      <History className="size-3" />
                    </span>
                    <div className="min-w-0 flex-1 leading-tight">
                      <p
                        className={
                          snapshot.label
                            ? 'truncate text-[13px] font-medium'
                            : 'truncate text-[13px] text-muted-foreground'
                        }
                      >
                        {snapshot.label ?? 'Snapshot'}
                      </p>
                      <p className="truncate text-[11.5px] text-muted-foreground">
                        {snapshot.authorName} · {clock(snapshot.timestamp)}
                      </p>
                    </div>
                    <div className="flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Compare with the current version"
                        title="Compare"
                        onClick={() => setHistoryModalOpen(true)}
                      >
                        <GitCompareArrows />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Restore this version"
                        title="Restore"
                        disabled={restoringId === snapshot.id}
                        onClick={() => void handleRestore(snapshot)}
                      >
                        <RotateCcw />
                      </Button>
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
        <div className="flex h-10 shrink-0 items-center justify-end border-t border-sidebar-border/60 px-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-[12.5px] text-muted-foreground"
            onClick={() => setHistoryModalOpen(true)}
          >
            Open full history…
          </Button>
        </div>
      </div>
      <VersionHistoryModal
        open={historyModalOpen}
        relativePath={activeTabPath}
        onOpenChange={setHistoryModalOpen}
      />
    </>
  );
}
