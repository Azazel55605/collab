import { useCallback, useEffect, useMemo, useState } from 'react';

import { diffLines } from 'diff';
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  GitCompareArrows,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '../../../lib/utils';
import { createVaultClient } from '../../../lib/vaultClient';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useVaultStore } from '../../../store/vaultStore';
import type { SnapshotMeta } from '../../../types/collab';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';

import { relativeTime } from './historyUtils';

interface VersionHistoryModalProps {
  open: boolean;
  relativePath: string | null;
  onOpenChange: (open: boolean) => void;
}

type HistoryDangerAction =
  { type: 'delete-snapshot'; snapshot: SnapshotMeta } | { type: 'clear-history' };

interface DiffRow {
  kind: 'added' | 'removed' | 'unchanged';
  left: string | null;
  right: string | null;
  leftNumber: number | null;
  rightNumber: number | null;
}

interface DiffSection {
  id: string;
  kind: 'changed' | 'unchanged';
  rows: DiffRow[];
  collapsible: boolean;
}

const COLLAPSE_UNCHANGED_MIN_LINES = 8;

function splitChunkLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}

function buildDiffRows(snapshotContent: string, currentContent: string): DiffRow[] {
  const parts = diffLines(snapshotContent, currentContent);
  const rows: DiffRow[] = [];
  let leftLineNumber = 1;
  let rightLineNumber = 1;

  for (const part of parts) {
    const lines = splitChunkLines(part.value);
    for (const line of lines) {
      if (part.added) {
        rows.push({
          kind: 'added',
          left: null,
          right: line,
          leftNumber: null,
          rightNumber: rightLineNumber,
        });
        rightLineNumber += 1;
        continue;
      }

      if (part.removed) {
        rows.push({
          kind: 'removed',
          left: line,
          right: null,
          leftNumber: leftLineNumber,
          rightNumber: null,
        });
        leftLineNumber += 1;
        continue;
      }

      rows.push({
        kind: 'unchanged',
        left: line,
        right: line,
        leftNumber: leftLineNumber,
        rightNumber: rightLineNumber,
      });
      leftLineNumber += 1;
      rightLineNumber += 1;
    }
  }

  return rows;
}

function buildDiffSections(rows: DiffRow[]): DiffSection[] {
  if (rows.length === 0) return [];

  const sections: DiffSection[] = [];
  let currentRows: DiffRow[] = [];
  let currentKind: 'changed' | 'unchanged' = rows[0].kind === 'unchanged' ? 'unchanged' : 'changed';

  const flush = () => {
    if (currentRows.length === 0) return;
    sections.push({
      id: `section-${sections.length}`,
      kind: currentKind,
      rows: currentRows,
      collapsible: false,
    });
    currentRows = [];
  };

  for (const row of rows) {
    const rowKind = row.kind === 'unchanged' ? 'unchanged' : 'changed';
    if (rowKind !== currentKind) {
      flush();
      currentKind = rowKind;
    }
    currentRows.push(row);
  }
  flush();

  return sections.map((section) => {
    const shouldCollapse =
      section.kind === 'unchanged' && section.rows.length >= COLLAPSE_UNCHANGED_MIN_LINES;
    return {
      ...section,
      collapsible: shouldCollapse,
    };
  });
}

function buildInitialCollapsedSections(sections: DiffSection[]): Record<string, boolean> {
  return Object.fromEntries(
    sections.filter((section) => section.collapsible).map((section) => [section.id, true]),
  );
}

export function VersionHistoryModal({
  open,
  relativePath,
  onOpenChange,
}: VersionHistoryModalProps) {
  const { vault } = useVaultStore();
  const { myUserId, myUserName } = useCollabStore();
  const { setForceReloadPath } = useEditorStore();
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [snapshotContent, setSnapshotContent] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingSnapshotId, setDeletingSnapshotId] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [dangerAction, setDangerAction] = useState<HistoryDangerAction | null>(null);

  const selectedSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null,
    [selectedSnapshotId, snapshots],
  );
  const client = vault ? createVaultClient(vault) : null;
  const canDeleteHistory = client?.capabilities.destructiveSnapshotHistory ?? false;

  const loadSnapshots = useCallback(async () => {
    if (!open || !vault?.path || !relativePath) {
      setSnapshots([]);
      setSelectedSnapshotId(null);
      return;
    }

    setLoadingSnapshots(true);
    try {
      const list = await createVaultClient(vault).listSnapshots(relativePath);
      setSnapshots(list);
      setSelectedSnapshotId((current) =>
        current && list.some((snapshot) => snapshot.id === current)
          ? current
          : (list[0]?.id ?? null),
      );
    } catch {
      setSnapshots([]);
      setSelectedSnapshotId(null);
    } finally {
      setLoadingSnapshots(false);
    }
  }, [open, relativePath, vault?.path]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  useEffect(() => {
    if (!open || !vault?.path || !relativePath || !selectedSnapshotId) {
      setSnapshotContent(null);
      setCurrentContent(null);
      setLoadingComparison(false);
      return;
    }

    let cancelled = false;
    setLoadingComparison(true);
    void Promise.all([
      createVaultClient(vault).readSnapshot(relativePath, selectedSnapshotId),
      createVaultClient(vault)
        .readDocument(relativePath)
        .then((note) => note.content),
    ])
      .then(([snapshotText, currentText]) => {
        if (cancelled) return;
        setSnapshotContent(snapshotText);
        setCurrentContent(currentText);
      })
      .catch(() => {
        if (cancelled) return;
        setSnapshotContent(null);
        setCurrentContent(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingComparison(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, relativePath, selectedSnapshotId, vault?.path]);

  const diffRows = useMemo(
    () =>
      snapshotContent !== null && currentContent !== null
        ? buildDiffRows(snapshotContent, currentContent)
        : [],
    [currentContent, snapshotContent],
  );
  const diffSections = useMemo(() => buildDiffSections(diffRows), [diffRows]);
  const collapsibleSectionCount = useMemo(
    () => diffSections.filter((section) => section.collapsible).length,
    [diffSections],
  );
  const areAllCollapsibleSectionsCollapsed = useMemo(
    () =>
      collapsibleSectionCount > 0 &&
      diffSections.every((section) => !section.collapsible || collapsedSections[section.id]),
    [collapsedSections, collapsibleSectionCount, diffSections],
  );

  const summary = useMemo(
    () => ({
      additions: diffRows.filter((row) => row.kind === 'added').length,
      removals: diffRows.filter((row) => row.kind === 'removed').length,
    }),
    [diffRows],
  );

  useEffect(() => {
    setCollapsedSections(buildInitialCollapsedSections(diffSections));
  }, [diffSections]);

  const handleRestore = useCallback(async () => {
    if (!vault?.path || !relativePath || !selectedSnapshot) return;
    setRestoringId(selectedSnapshot.id);
    try {
      await createVaultClient(vault).restoreSnapshot(
        relativePath,
        selectedSnapshot.id,
        myUserId,
        myUserName,
      );
      setForceReloadPath(relativePath);
      await loadSnapshots();
    } finally {
      setRestoringId(null);
    }
  }, [
    loadSnapshots,
    myUserId,
    myUserName,
    relativePath,
    selectedSnapshot,
    setForceReloadPath,
    vault?.path,
  ]);

  const handleDeleteSnapshot = useCallback(
    async (snapshot: SnapshotMeta) => {
      if (!vault?.path || !relativePath) return;
      setDeletingSnapshotId(snapshot.id);
      try {
        await createVaultClient(vault).deleteSnapshot(relativePath, snapshot.id);
        await loadSnapshots();
        toast.success('Snapshot removed');
      } catch (error) {
        toast.error(`Failed to delete snapshot: ${error}`);
      } finally {
        setDeletingSnapshotId(null);
        setDangerAction(null);
      }
    },
    [loadSnapshots, relativePath, vault?.path],
  );

  const handleClearHistory = useCallback(async () => {
    if (!vault?.path || !relativePath) return;
    setClearingHistory(true);
    try {
      await createVaultClient(vault).clearSnapshotHistory(relativePath);
      setSelectedSnapshotId(null);
      setSnapshotContent(null);
      setCurrentContent(null);
      await loadSnapshots();
      toast.success('Version history cleared');
    } catch (error) {
      toast.error(`Failed to clear version history: ${error}`);
    } finally {
      setClearingHistory(false);
      setDangerAction(null);
    }
  }, [loadSnapshots, relativePath, vault?.path]);

  const toggleSectionCollapsed = useCallback((sectionId: string) => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  }, []);

  const setAllCollapsedSections = useCallback(
    (collapsed: boolean) => {
      setCollapsedSections((current) => {
        const next = { ...current };
        for (const section of diffSections) {
          if (section.collapsible) next[section.id] = collapsed;
        }
        return next;
      });
    },
    [diffSections],
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[92vh] max-h-[92vh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden p-0 gap-0 glass-strong border-border/40 sm:w-[min(1520px,calc(100vw-3rem))] sm:max-w-[min(1520px,calc(100vw-3rem))]"
        >
          <DialogHeader className="border-b border-border/50 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <DialogTitle className="flex items-center gap-2">
                  <GitCompareArrows size={16} className="text-primary" />
                  Version history
                </DialogTitle>
                <DialogDescription className="mt-1 truncate">
                  {relativePath ?? 'No file selected'}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2">
                {canDeleteHistory && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDangerAction({ type: 'clear-history' })}
                    disabled={snapshots.length === 0 || clearingHistory || loadingSnapshots}
                  >
                    <Trash2 size={14} />
                    Clear history
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-r border-border/50 bg-sidebar/35">
              <div className="border-b border-border/40 px-4 py-3">
                <div className="text-xs font-medium text-foreground/90">Snapshots</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {loadingSnapshots
                    ? 'Loading versions…'
                    : `${snapshots.length} version${snapshots.length === 1 ? '' : 's'} available`}
                </div>
              </div>
              <div className="min-h-0 overflow-y-auto">
                {loadingSnapshots ? (
                  <div className="px-4 py-6 text-xs text-muted-foreground">
                    Loading version history…
                  </div>
                ) : snapshots.length === 0 ? (
                  <div className="px-4 py-6 text-xs text-muted-foreground">
                    No snapshots yet. Save this document to create one.
                  </div>
                ) : (
                  <div className="p-2">
                    {snapshots.map((snapshot) => {
                      const isSelected = snapshot.id === selectedSnapshotId;
                      return (
                        <div
                          key={snapshot.id}
                          className={cn(
                            'mb-1.5 flex items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors app-motion-fast',
                            isSelected
                              ? 'border-primary/40 bg-primary/10 text-foreground shadow-sm'
                              : 'border-transparent bg-background/45 text-foreground/85 hover:border-border/60 hover:bg-accent/45',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedSnapshotId(snapshot.id)}
                            className="min-w-0 flex-1"
                          >
                            <span className="block truncate text-xs font-medium">
                              {snapshot.label ?? relativeTime(snapshot.timestamp)}
                            </span>
                            <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Clock3 size={10} />
                              {snapshot.authorName} · {relativeTime(snapshot.timestamp)}
                            </span>
                          </button>
                          {canDeleteHistory && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
                              disabled={deletingSnapshotId === snapshot.id || clearingHistory}
                              onClick={() => setDangerAction({ type: 'delete-snapshot', snapshot })}
                              title="Delete snapshot"
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            <section className="flex min-h-0 flex-col bg-background/70">
              {selectedSnapshot ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-5 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {selectedSnapshot.label ?? 'Snapshot'}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {selectedSnapshot.authorName} ·{' '}
                        {new Date(selectedSnapshot.timestamp).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-200">
                        +{summary.additions}
                      </div>
                      <div className="rounded-lg border border-rose-500/30 bg-rose-500/12 px-2 py-1 text-[11px] font-medium text-rose-700 dark:text-rose-200">
                        -{summary.removals}
                      </div>
                      {collapsibleSectionCount > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setAllCollapsedSections(!areAllCollapsibleSectionsCollapsed)
                          }
                        >
                          {areAllCollapsibleSectionsCollapsed
                            ? 'Expand all gaps'
                            : 'Collapse all gaps'}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRestore}
                        disabled={restoringId === selectedSnapshot.id}
                      >
                        <RotateCcw size={14} />
                        Restore this version
                      </Button>
                    </div>
                  </div>

                  {loadingComparison ? (
                    <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                      Loading comparison…
                    </div>
                  ) : snapshotContent === null || currentContent === null ? (
                    <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                      Preview unavailable for this version right now.
                    </div>
                  ) : (
                    <div className="grid min-h-0 flex-1 grid-rows-[auto,minmax(0,1fr)]">
                      <div className="grid grid-cols-2 border-b border-border/40 bg-sidebar/25">
                        <div className="px-5 py-2 text-xs font-medium text-muted-foreground">
                          Snapshot
                        </div>
                        <div className="border-l border-border/40 px-5 py-2 text-xs font-medium text-muted-foreground">
                          Current
                        </div>
                      </div>
                      <div className="min-h-0 overflow-auto">
                        {diffSections.length === 0 ? (
                          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
                            No differences found.
                          </div>
                        ) : (
                          <div className="font-mono text-[12px] leading-5">
                            {diffSections.map((section) => {
                              const isCollapsed =
                                section.collapsible && collapsedSections[section.id];
                              if (isCollapsed) {
                                const startLeft =
                                  section.rows[0]?.leftNumber ??
                                  section.rows[0]?.rightNumber ??
                                  '?';
                                const endLeft =
                                  section.rows[section.rows.length - 1]?.leftNumber ??
                                  section.rows[section.rows.length - 1]?.rightNumber ??
                                  '?';
                                return (
                                  <button
                                    key={section.id}
                                    type="button"
                                    onClick={() => toggleSectionCollapsed(section.id)}
                                    className="flex w-full items-center justify-between border-b border-border/30 bg-muted/35 px-4 py-2 text-left text-xs text-muted-foreground transition-colors app-motion-fast hover:bg-muted/55"
                                  >
                                    <span className="flex items-center gap-2">
                                      <ChevronRight size={14} />
                                      {section.rows.length} unchanged line
                                      {section.rows.length === 1 ? '' : 's'} hidden
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/80">
                                      Lines {startLeft}–{endLeft}
                                    </span>
                                  </button>
                                );
                              }

                              return (
                                <div key={section.id}>
                                  {section.collapsible && (
                                    <button
                                      type="button"
                                      onClick={() => toggleSectionCollapsed(section.id)}
                                      className="flex w-full items-center justify-between border-b border-border/30 bg-sidebar/20 px-4 py-1.5 text-left text-xs text-muted-foreground transition-colors app-motion-fast hover:bg-sidebar/35"
                                    >
                                      <span className="flex items-center gap-2">
                                        <ChevronDown size={14} />
                                        Showing {section.rows.length} unchanged line
                                        {section.rows.length === 1 ? '' : 's'}
                                      </span>
                                      <span>Collapse</span>
                                    </button>
                                  )}
                                  {section.rows.map((row, index) => (
                                    <div
                                      key={`${section.id}-${index}-${row.leftNumber ?? 'x'}-${row.rightNumber ?? 'y'}`}
                                      className="grid grid-cols-2"
                                    >
                                      <div
                                        className={cn(
                                          'grid min-w-0 grid-cols-[56px_minmax(0,1fr)] border-b border-border/30 px-3 py-1.5',
                                          row.kind === 'removed' && 'bg-rose-500/10',
                                          row.kind === 'unchanged' && 'bg-transparent',
                                        )}
                                      >
                                        <span className="select-none pr-3 text-right text-[10px] text-muted-foreground/80">
                                          {row.leftNumber ?? ''}
                                        </span>
                                        <pre className="whitespace-pre-wrap break-words text-foreground/90">
                                          {row.left ?? ''}
                                        </pre>
                                      </div>
                                      <div
                                        className={cn(
                                          'grid min-w-0 grid-cols-[56px_minmax(0,1fr)] border-b border-l border-border/30 px-3 py-1.5',
                                          row.kind === 'added' && 'bg-emerald-500/10',
                                          row.kind === 'unchanged' && 'bg-transparent',
                                        )}
                                      >
                                        <span className="select-none pr-3 text-right text-[10px] text-muted-foreground/80">
                                          {row.rightNumber ?? ''}
                                        </span>
                                        <pre className="whitespace-pre-wrap break-words text-foreground/90">
                                          {row.right ?? ''}
                                        </pre>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                  <div className="flex flex-col items-center gap-2 text-center">
                    <Eye size={18} className="text-muted-foreground/70" />
                    <div>Select a snapshot to compare it with the current file.</div>
                  </div>
                </div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={dangerAction !== null}
        onOpenChange={(next) => {
          if (!next) setDangerAction(null);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dangerAction?.type === 'clear-history'
                ? 'Clear version history?'
                : 'Delete snapshot?'}
            </DialogTitle>
            <DialogDescription>
              {dangerAction?.type === 'clear-history'
                ? 'This will permanently remove all saved snapshots for this file. This cannot be undone.'
                : 'This will permanently remove the selected snapshot from this file history. This cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
            <Button variant="outline" onClick={() => setDangerAction(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (dangerAction?.type === 'clear-history') {
                  void handleClearHistory();
                } else if (dangerAction?.type === 'delete-snapshot') {
                  void handleDeleteSnapshot(dangerAction.snapshot);
                }
              }}
              disabled={clearingHistory || deletingSnapshotId !== null}
            >
              {dangerAction?.type === 'clear-history' ? 'Clear history' : 'Delete snapshot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
