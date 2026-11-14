import { useCallback, useEffect, useMemo, useState } from 'react';

import { diffLines } from 'diff';
import { ChevronDown, ChevronRight, Copy, Eye, History, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '../../../lib/utils';
import { createVaultClient } from '../../../lib/vaultClient';
import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import { useVaultStore } from '../../../store/vaultStore';
import type { SnapshotMeta } from '../../../types/collab';
import { AppDialogContent, AppDialogFooter, AppDialogHeader } from '../../ui/app-dialog';
import { Button } from '../../ui/button';
import { confirmAction } from '../../ui/confirm-dialog';
import { Dialog } from '../../ui/dialog';

import { relativeTime } from './historyUtils';

interface VersionHistoryModalProps {
  open: boolean;
  relativePath: string | null;
  onOpenChange: (open: boolean) => void;
}

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
  const vault = useVaultStore((state) => state.vault);
  const myUserId = useCollabStore((state) => state.myUserId);
  const myUserName = useCollabStore((state) => state.myUserName);
  const setForceReloadPath = useEditorStore((state) => state.setForceReloadPath);
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

  const [view, setView] = useState<'changes' | 'split' | 'full'>('changes');
  const [namedOnly, setNamedOnly] = useState(false);
  const shownSnapshots = namedOnly ? snapshots.filter((snapshot) => snapshot.label) : snapshots;
  const groups: { label: string; items: SnapshotMeta[] }[] = [];
  for (const snapshot of shownSnapshots) {
    const label = historyDayLabel(snapshot.timestamp);
    const group = groups[groups.length - 1];
    if (group?.label === label) group.items.push(snapshot);
    else groups.push({ label, items: [snapshot] });
  }

  const confirmDelete = async (snapshot: SnapshotMeta) => {
    const confirmed = await confirmAction({
      title: 'Delete this version?',
      description: 'It is removed from this file’s history for good.',
      confirmLabel: 'Delete snapshot',
      destructive: true,
    });
    if (confirmed) await handleDeleteSnapshot(snapshot);
  };
  const confirmClear = async () => {
    const confirmed = await confirmAction({
      title: 'Clear the whole version history?',
      description: 'Every saved version of this file is removed for good. The file itself stays.',
      confirmLabel: 'Clear history',
      destructive: true,
    });
    if (confirmed) await handleClearHistory();
  };
  const copySnapshot = async () => {
    if (snapshotContent === null) return;
    try {
      await navigator.clipboard?.writeText(snapshotContent);
      toast.success('Version copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const renderGap = (section: DiffSection) => {
    const startLeft = section.rows[0]?.leftNumber ?? section.rows[0]?.rightNumber ?? '?';
    const endLeft =
      section.rows[section.rows.length - 1]?.leftNumber ??
      section.rows[section.rows.length - 1]?.rightNumber ??
      '?';
    return (
      <button
        key={section.id}
        type="button"
        onClick={() => toggleSectionCollapsed(section.id)}
        className="flex w-full items-center justify-between bg-muted/35 px-4 py-1.5 text-left font-sans text-xs text-muted-foreground transition-colors app-motion-fast hover:bg-muted/55"
      >
        <span className="flex items-center gap-2">
          <ChevronRight size={14} />
          {section.rows.length} unchanged line{section.rows.length === 1 ? '' : 's'} hidden
        </span>
        <span className="text-[11px] text-muted-foreground/80">
          Lines {startLeft}–{endLeft}
        </span>
      </button>
    );
  };
  const renderGapHeader = (section: DiffSection) =>
    section.collapsible ? (
      <button
        type="button"
        onClick={() => toggleSectionCollapsed(section.id)}
        className="flex w-full items-center justify-between bg-muted/20 px-4 py-1 text-left font-sans text-xs text-muted-foreground transition-colors app-motion-fast hover:bg-muted/40"
      >
        <span className="flex items-center gap-2">
          <ChevronDown size={14} />
          Showing {section.rows.length} unchanged line{section.rows.length === 1 ? '' : 's'}
        </span>
        <span>Collapse</span>
      </button>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        size="l"
        className="h-[min(780px,calc(100vh-2rem))] sm:max-w-[min(1240px,calc(100vw-3rem))]"
      >
        <AppDialogHeader
          icon={<History />}
          title="Version history"
          description={relativePath ?? 'No file selected'}
        />
        <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] border-t border-border/60">
          <aside aria-label="Versions" className="flex min-h-0 flex-col border-r border-border/60">
            <div className="flex shrink-0 gap-1.5 px-3 py-2.5" role="group" aria-label="Show">
              {[
                { value: false, label: 'All changes' },
                { value: true, label: 'Named only' },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={namedOnly === option.value}
                  onClick={() => setNamedOnly(option.value)}
                  className={cn(
                    'h-6 rounded-full px-2.5 text-[11.5px] transition-colors',
                    namedOnly === option.value
                      ? 'bg-primary/15 font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {loadingSnapshots ? (
                <p className="px-2 py-6 text-xs text-muted-foreground">Loading version history…</p>
              ) : shownSnapshots.length === 0 ? (
                <p className="px-2 py-6 text-xs text-muted-foreground">
                  {snapshots.length === 0
                    ? 'No snapshots yet. Save this document to create one.'
                    : 'No named versions yet.'}
                </p>
              ) : (
                groups.map((group) => (
                  <section key={group.label} aria-label={group.label}>
                    <h3 className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                      {group.label}
                    </h3>
                    {group.items.map((snapshot) => {
                      const isSelected = snapshot.id === selectedSnapshotId;
                      return (
                        <div
                          key={snapshot.id}
                          className={cn(
                            'group flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors app-motion-fast',
                            isSelected ? 'bg-primary/15' : 'hover:bg-muted/50',
                          )}
                        >
                          <span
                            className={cn(
                              'mt-1.5 size-2.5 shrink-0 rounded-full',
                              snapshot.label ? 'bg-primary' : 'bg-muted-foreground/40',
                            )}
                          />
                          <button
                            type="button"
                            onClick={() => setSelectedSnapshotId(snapshot.id)}
                            aria-current={isSelected ? 'true' : undefined}
                            className="min-w-0 flex-1 text-left leading-snug outline-none"
                          >
                            <span
                              className={cn(
                                'block truncate text-[13px]',
                                snapshot.label ? 'font-medium' : 'text-muted-foreground',
                              )}
                            >
                              {snapshot.label ?? 'Snapshot'}
                            </span>
                            <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
                              {snapshot.authorName} · {historyClock(snapshot.timestamp)}
                            </span>
                          </button>
                          {canDeleteHistory && (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                              disabled={deletingSnapshotId === snapshot.id || clearingHistory}
                              onClick={() => void confirmDelete(snapshot)}
                              title="Delete snapshot"
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </section>
                ))
              )}
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col">
            {selectedSnapshot ? (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border/60 px-4 py-2">
                  <div className="min-w-0 flex-1 text-[12.5px]">
                    <span className="font-semibold">{selectedSnapshot.label ?? 'Snapshot'}</span>{' '}
                    <span className="text-muted-foreground">
                      {relativeTime(selectedSnapshot.timestamp)}, compared with now
                    </span>
                  </div>
                  <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                    +{summary.additions}
                  </span>
                  <span className="rounded-full bg-rose-500/12 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                    −{summary.removals}
                  </span>
                  {collapsibleSectionCount > 0 && view !== 'full' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setAllCollapsedSections(!areAllCollapsibleSectionsCollapsed)}
                    >
                      {areAllCollapsibleSectionsCollapsed ? 'Expand all gaps' : 'Collapse all gaps'}
                    </Button>
                  )}
                  <div
                    role="group"
                    aria-label="Comparison view"
                    className="flex rounded-lg border border-border/70 bg-muted/40 p-0.5"
                  >
                    {(
                      [
                        ['changes', 'Changes'],
                        ['split', 'Side by side'],
                        ['full', 'Full text'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={view === value}
                        onClick={() => setView(value)}
                        className={cn(
                          'h-6 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
                          view === value && 'bg-background text-foreground shadow-sm',
                        )}
                      >
                        {label}
                      </button>
                    ))}
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
                ) : view === 'full' ? (
                  <pre className="min-h-0 flex-1 overflow-auto px-5 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">
                    {snapshotContent}
                  </pre>
                ) : diffSections.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                    No differences found.
                  </div>
                ) : view === 'changes' ? (
                  <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[12.5px] leading-relaxed">
                    {diffSections.map((section) =>
                      section.collapsible && collapsedSections[section.id] ? (
                        renderGap(section)
                      ) : (
                        <div key={section.id}>
                          {renderGapHeader(section)}
                          {section.rows.map((row, index) => (
                            <div
                              key={`${section.id}-${index}`}
                              className={cn(
                                'grid grid-cols-[48px_18px_minmax(0,1fr)] pr-4',
                                row.kind === 'added' &&
                                  'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
                                row.kind === 'removed' &&
                                  'bg-rose-500/10 text-rose-800 dark:text-rose-200',
                              )}
                            >
                              <span className="pr-3 text-right text-[11px] text-muted-foreground/70 select-none">
                                {row.kind === 'removed' ? row.leftNumber : row.rightNumber}
                              </span>
                              <span className="text-muted-foreground select-none">
                                {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}
                              </span>
                              <pre className="whitespace-pre-wrap break-words">
                                {(row.kind === 'added' ? row.right : row.left) ?? ''}
                              </pre>
                            </div>
                          ))}
                        </div>
                      ),
                    )}
                  </div>
                ) : (
                  <div className="grid min-h-0 flex-1 grid-rows-[auto,minmax(0,1fr)]">
                    <div className="grid grid-cols-2 border-b border-border/40 bg-muted/30 text-xs font-medium text-muted-foreground">
                      <div className="px-5 py-1.5">This version</div>
                      <div className="border-l border-border/40 px-5 py-1.5">Now</div>
                    </div>
                    <div className="min-h-0 overflow-auto font-mono text-[12px] leading-5">
                      {diffSections.map((section) =>
                        section.collapsible && collapsedSections[section.id] ? (
                          renderGap(section)
                        ) : (
                          <div key={section.id}>
                            {renderGapHeader(section)}
                            {section.rows.map((row, index) => (
                              <div
                                key={`${section.id}-${index}-${row.leftNumber ?? 'x'}-${row.rightNumber ?? 'y'}`}
                                className="grid grid-cols-2"
                              >
                                <div
                                  className={cn(
                                    'grid min-w-0 grid-cols-[48px_minmax(0,1fr)] px-3 py-1',
                                    row.kind === 'removed' && 'bg-rose-500/10',
                                  )}
                                >
                                  <span className="pr-3 text-right text-[10px] text-muted-foreground/80 select-none">
                                    {row.leftNumber ?? ''}
                                  </span>
                                  <pre className="whitespace-pre-wrap break-words text-foreground/90">
                                    {row.left ?? ''}
                                  </pre>
                                </div>
                                <div
                                  className={cn(
                                    'grid min-w-0 grid-cols-[48px_minmax(0,1fr)] border-l border-border/30 px-3 py-1',
                                    row.kind === 'added' && 'bg-emerald-500/10',
                                  )}
                                >
                                  <span className="pr-3 text-right text-[10px] text-muted-foreground/80 select-none">
                                    {row.rightNumber ?? ''}
                                  </span>
                                  <pre className="whitespace-pre-wrap break-words text-foreground/90">
                                    {row.right ?? ''}
                                  </pre>
                                </div>
                              </div>
                            ))}
                          </div>
                        ),
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
        <AppDialogFooter
          start={
            canDeleteHistory ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void confirmClear()}
                disabled={snapshots.length === 0 || clearingHistory || loadingSnapshots}
              >
                <Trash2 size={14} />
                Clear history
              </Button>
            ) : undefined
          }
        >
          <Button
            variant="outline"
            onClick={() => void copySnapshot()}
            disabled={snapshotContent === null}
          >
            <Copy size={14} />
            Copy text
          </Button>
          <Button
            onClick={handleRestore}
            disabled={!selectedSnapshot || restoringId === selectedSnapshot?.id}
          >
            <RotateCcw size={14} />
            Restore this version
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog>
  );
}

function historyDayLabel(timestamp: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (timestamp >= start.getTime()) return 'Today';
  if (timestamp >= start.getTime() - 86_400_000) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(timestamp);
}

function historyClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    timestamp,
  );
}
