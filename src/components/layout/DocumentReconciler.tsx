import { useCallback, useEffect, useMemo, useState } from 'react';

import { diffLines } from 'diff';
import { AlertTriangle, Check, ClipboardCopy, GitMerge } from 'lucide-react';
import { toast } from 'sonner';

import {
  deriveReconciliation,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type Reconciliation,
} from '../../lib/documentSessionController';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

import { DocumentStatusPill } from './DocumentStatusPill';

/**
 * Shared Phase 3 reconciliation surface. Renders the non-modal
 * {@link DocumentStatusPill} for every migrated document view and, when there is
 * unresolved remote content (a queued pending-remote or a hard save conflict),
 * exposes a "Review" affordance that opens a non-dismissible dialog showing the
 * base/local/remote content with a line diff, a copy-out escape hatch, and the
 * three resolution actions (Load remote / Keep mine / Save mine as new). Every
 * path preserves a recoverable copy of the local content.
 *
 * Views pass the controller + subscribed snapshot; all action wiring lives here
 * so each view no longer re-implements load/keep handlers.
 */
export interface DocumentReconcilerProps<TDocument> {
  controller: DocumentSessionController<TDocument>;
  snapshot: DocumentSessionSnapshot<TDocument>;
  /**
   * Persists the local content as a new revision/file ("Save mine as new").
   * Optional: when omitted, that action is hidden. Receives the local content.
   */
  onSaveAsNew?: (localContent: string) => Promise<void>;
  /** Read-only views (hosted viewers) never reconcile; the surface hides itself. */
  readOnly?: boolean;
  className?: string;
  hideWhenSaved?: boolean;
  compact?: boolean;
}

export function DocumentReconciler<TDocument>({
  controller,
  snapshot,
  onSaveAsNew,
  readOnly = false,
  className,
  hideWhenSaved,
  compact,
}: DocumentReconcilerProps<TDocument>) {
  const reconciliation = useMemo(() => deriveReconciliation(snapshot), [snapshot]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [savingAsNew, setSavingAsNew] = useState(false);

  // Keep autosave paused for the whole time the review dialog is open so a
  // debounced write cannot fire mid-review and race the user's decision.
  useEffect(() => {
    if (!reviewOpen) return;
    controller.pauseAutosave();
    return () => controller.resumeAutosave();
  }, [reviewOpen, controller]);

  // If the reconciliation clears while the dialog is open (e.g. resolved from
  // another surface), close it.
  useEffect(() => {
    if (reviewOpen && !reconciliation) setReviewOpen(false);
  }, [reviewOpen, reconciliation]);

  const loadRemote = useCallback(() => {
    controller.loadRemote();
    setReviewOpen(false);
  }, [controller]);

  const keepMine = useCallback(() => {
    controller.keepMine();
    setReviewOpen(false);
  }, [controller]);

  const saveAsNew = useCallback(async () => {
    if (!onSaveAsNew) return;
    setSavingAsNew(true);
    try {
      await controller.saveMineAsNew(onSaveAsNew);
      setReviewOpen(false);
    } catch (error) {
      toast.error(`Could not save your copy: ${String(error)}`);
    } finally {
      setSavingAsNew(false);
    }
  }, [controller, onSaveAsNew]);

  if (readOnly) return null;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DocumentStatusPill
        status={snapshot.status}
        onLoadRemote={reconciliation ? loadRemote : undefined}
        onKeepLocal={reconciliation ? keepMine : undefined}
        hideWhenSaved={hideWhenSaved}
        compact={compact}
      />
      {reconciliation && (
        <button
          type="button"
          onClick={() => setReviewOpen(true)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
            compact && 'px-1.5 py-0 text-[10px]',
          )}
        >
          <GitMerge size={12} />
          Review
        </button>
      )}
      {reconciliation && (
        <ReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          reconciliation={reconciliation}
          onLoadRemote={loadRemote}
          onKeepMine={keepMine}
          onSaveAsNew={onSaveAsNew ? saveAsNew : undefined}
          savingAsNew={savingAsNew}
        />
      )}
    </div>
  );
}

interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconciliation: Reconciliation;
  onLoadRemote: () => void;
  onKeepMine: () => void;
  onSaveAsNew?: () => void;
  savingAsNew: boolean;
}

function ReviewDialog({
  open,
  onOpenChange,
  reconciliation,
  onLoadRemote,
  onKeepMine,
  onSaveAsNew,
  savingAsNew,
}: ReviewDialogProps) {
  const { kind, base, ours, theirs } = reconciliation;
  const isConflict = kind === 'conflict';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Non-dismissible: unresolved data would be lost, so clicking the overlay
          or pressing Escape must not silently discard the user's local copy. */}
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="max-w-3xl gap-3"
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg',
                isConflict
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
              )}
            >
              <AlertTriangle size={16} />
            </span>
            <div>
              <DialogTitle>
                {isConflict ? 'Conflict needs review' : 'Remote changes available'}
              </DialogTitle>
              <DialogDescription className="mt-0.5">
                {isConflict
                  ? 'This document changed elsewhere while your save was in flight. Your local copy is safe below — choose how to reconcile.'
                  : 'A newer version arrived while you had unsaved edits. Your local copy is safe below — choose how to reconcile.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ContentPane label="Your version" tone="local" content={ours} />
          <ContentPane label="Their version" tone="remote" content={theirs} />
        </div>

        <DiffPane base={base} ours={ours} theirs={theirs} />

        <DialogFooter className="mt-1 gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Later
          </Button>
          {onSaveAsNew && (
            <Button variant="outline" size="sm" onClick={onSaveAsNew} disabled={savingAsNew}>
              {savingAsNew ? 'Saving copy…' : 'Save mine as new'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadRemote}
            className="border-destructive/30 text-destructive hover:bg-destructive/10"
          >
            Load remote
          </Button>
          <Button size="sm" onClick={onKeepMine}>
            Keep mine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContentPane({
  label,
  tone,
  content,
}: {
  label: string;
  tone: 'local' | 'remote';
  content: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }, [content]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              tone === 'local' ? 'bg-primary' : 'bg-destructive',
            )}
          />
          <span
            className={cn(
              'text-xs font-semibold',
              tone === 'local' ? 'text-primary' : 'text-destructive',
            )}
          >
            {label}
          </span>
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
        >
          {copied ? <Check size={11} /> : <ClipboardCopy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className={cn(
          'max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-[11px] leading-relaxed',
          tone === 'local'
            ? 'border-primary/15 bg-primary/5'
            : 'border-destructive/15 bg-destructive/5',
        )}
      >
        {content || <span className="text-muted-foreground italic">(empty)</span>}
      </pre>
    </div>
  );
}

function DiffPane({ base, ours, theirs }: { base: string | null; ours: string; theirs: string }) {
  const parts = useMemo(() => diffLines(ours, theirs), [ours, theirs]);
  return (
    <details className="rounded-lg border border-border/60 bg-muted/30">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground">
        Line differences (yours → theirs)
        {base === null && <span className="ml-1 opacity-70">· no common base</span>}
      </summary>
      <pre className="max-h-56 overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed">
        {parts.map((part, i) => (
          <span
            key={i}
            className={cn(
              part.added && 'block bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              part.removed && 'block bg-destructive/10 text-destructive line-through',
              !part.added && !part.removed && 'block text-muted-foreground',
            )}
          >
            {part.added ? '+ ' : part.removed ? '- ' : '  '}
            {part.value.replace(/\n$/, '')}
          </span>
        ))}
      </pre>
    </details>
  );
}
