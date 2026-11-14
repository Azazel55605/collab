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
import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  ChoiceCard,
  ChoiceGroup,
} from '../ui/app-dialog';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';

import { DocumentStatusPill } from './DocumentStatusPill';

/**
 * Reconciliation of a document that changed elsewhere: a queued remote version
 * while there are local edits, or a hard save conflict. The state lives in
 * {@link useDocumentReconciliation} so any surface (the sync center, a status
 * pill) can offer Review; {@link ReviewDialog} shows both versions side by side
 * and three plain choices. Every path keeps a recoverable copy of local content.
 */
export interface DocumentReconcilerProps<TDocument> {
  controller: DocumentSessionController<TDocument>;
  snapshot: DocumentSessionSnapshot<TDocument>;
  /** Persists the local content as a new revision/file ("Keep both"). Optional. */
  onSaveAsNew?: (localContent: string) => Promise<void>;
  /** Read-only views (hosted viewers) never reconcile; the surface hides itself. */
  readOnly?: boolean;
  /** Shown in the review dialog's title. */
  documentName?: string;
  className?: string;
  hideWhenSaved?: boolean;
  compact?: boolean;
}

export function useDocumentReconciliation<TDocument>(
  controller: DocumentSessionController<TDocument> | null,
  snapshot: DocumentSessionSnapshot<TDocument> | null,
  onSaveAsNew?: (localContent: string) => Promise<void>,
) {
  const reconciliation = useMemo(
    () => (snapshot ? deriveReconciliation(snapshot) : null),
    [snapshot],
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [savingAsNew, setSavingAsNew] = useState(false);

  // Keep autosave paused while reviewing so a debounced write cannot race the decision.
  useEffect(() => {
    if (!reviewOpen || !controller) return;
    controller.pauseAutosave();
    return () => controller.resumeAutosave();
  }, [reviewOpen, controller]);

  // Resolved from another surface while open: close.
  useEffect(() => {
    if (reviewOpen && !reconciliation) setReviewOpen(false);
  }, [reviewOpen, reconciliation]);

  const loadRemote = useCallback(() => {
    controller?.loadRemote();
    setReviewOpen(false);
  }, [controller]);

  const keepMine = useCallback(() => {
    controller?.keepMine();
    setReviewOpen(false);
  }, [controller]);

  const saveAsNew = useCallback(async () => {
    if (!onSaveAsNew || !controller) return;
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

  return {
    reconciliation,
    reviewOpen,
    setReviewOpen,
    loadRemote,
    keepMine,
    saveAsNew: onSaveAsNew ? saveAsNew : undefined,
    savingAsNew,
  };
}

export function DocumentReconciler<TDocument>({
  controller,
  snapshot,
  onSaveAsNew,
  readOnly = false,
  documentName,
  className,
  hideWhenSaved,
  compact,
}: DocumentReconcilerProps<TDocument>) {
  const state = useDocumentReconciliation(controller, snapshot, onSaveAsNew);
  if (readOnly) return null;
  const { reconciliation } = state;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DocumentStatusPill
        status={snapshot.status}
        onLoadRemote={reconciliation ? state.loadRemote : undefined}
        onKeepLocal={reconciliation ? state.keepMine : undefined}
        hideWhenSaved={hideWhenSaved}
        compact={compact}
      />
      {reconciliation && (
        <button
          type="button"
          onClick={() => state.setReviewOpen(true)}
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
          open={state.reviewOpen}
          onOpenChange={state.setReviewOpen}
          reconciliation={reconciliation}
          documentName={documentName}
          onLoadRemote={state.loadRemote}
          onKeepMine={state.keepMine}
          onSaveAsNew={state.saveAsNew}
          savingAsNew={state.savingAsNew}
        />
      )}
    </div>
  );
}

type Choice = 'mine' | 'theirs' | 'both';

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconciliation: Reconciliation;
  documentName?: string;
  onLoadRemote: () => void;
  onKeepMine: () => void;
  onSaveAsNew?: () => void;
  savingAsNew: boolean;
}

export function ReviewDialog({
  open,
  onOpenChange,
  reconciliation,
  documentName,
  onLoadRemote,
  onKeepMine,
  onSaveAsNew,
  savingAsNew,
}: ReviewDialogProps) {
  const { kind, base, ours, theirs } = reconciliation;
  const isConflict = kind === 'conflict';
  const [choice, setChoice] = useState<Choice>('mine');
  useEffect(() => {
    if (open) setChoice('mine');
  }, [open]);
  const name = documentName ?? 'This document';
  const changed = useMemo(() => changedLines(ours, theirs), [ours, theirs]);

  const apply = () => {
    if (choice === 'mine') onKeepMine();
    else if (choice === 'theirs') onLoadRemote();
    else onSaveAsNew?.();
  };
  const actionLabel =
    choice === 'mine'
      ? 'Keep mine'
      : choice === 'theirs'
        ? 'Use theirs'
        : savingAsNew
          ? 'Saving copy…'
          : 'Keep both';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Non-dismissible by overlay or Escape: unresolved data must not be dropped
          by accident. "Decide later" closes it explicitly. */}
      <AppDialogContent
        size="l"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="h-[min(680px,calc(100dvh-2rem))] sm:max-w-[960px]"
      >
        <AppDialogHeader
          icon={<AlertTriangle />}
          tone={isConflict ? 'danger' : 'warning'}
          title={isConflict ? 'Conflict needs review' : 'Remote changes available'}
          description={
            isConflict
              ? `${name} changed elsewhere while your save was on its way. Pick what to keep; nothing is lost either way.`
              : `A newer version of ${name.toLowerCase() === 'this document' ? 'this document' : name} arrived while you had unsaved edits. Pick what to keep; nothing is lost either way.`
          }
        />
        <AppDialogBody className="gap-3">
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
            <ContentPane
              label="Your version"
              detail="on this device"
              tone="local"
              content={ours}
              changed={changed.ours}
            />
            <ContentPane
              label="Their version"
              detail={base === null ? 'no common base' : 'from the server'}
              tone="remote"
              content={theirs}
              changed={changed.theirs}
            />
          </div>
          <ChoiceGroup
            value={choice}
            onValueChange={(value) => setChoice(value as Choice)}
            aria-label="What to keep"
            className={cn('shrink-0', onSaveAsNew ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}
          >
            <ChoiceCard
              value="mine"
              title="Keep mine"
              description="Mine is saved on top; theirs stays in history"
            />
            <ChoiceCard
              value="theirs"
              title="Use theirs"
              description="Load their version; copy mine first if needed"
            />
            {onSaveAsNew && (
              <ChoiceCard
                value="both"
                title="Keep both"
                description="Save mine as a new copy, then load theirs"
              />
            )}
          </ChoiceGroup>
        </AppDialogBody>
        <AppDialogFooter
          start={
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Decide later
            </Button>
          }
        >
          <Button onClick={apply} disabled={choice === 'both' && savingAsNew}>
            {actionLabel}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog>
  );
}

/** Line numbers (0-based) that differ between the two versions, per side. */
function changedLines(ours: string, theirs: string) {
  const result = { ours: new Set<number>(), theirs: new Set<number>() };
  let oursLine = 0;
  let theirsLine = 0;
  for (const part of diffLines(ours, theirs)) {
    const count = part.count ?? part.value.split('\n').length - 1;
    if (part.added) {
      for (let i = 0; i < count; i += 1) result.theirs.add(theirsLine + i);
      theirsLine += count;
    } else if (part.removed) {
      for (let i = 0; i < count; i += 1) result.ours.add(oursLine + i);
      oursLine += count;
    } else {
      oursLine += count;
      theirsLine += count;
    }
  }
  return result;
}

function ContentPane({
  label,
  detail,
  tone,
  content,
  changed,
}: {
  label: string;
  detail: string;
  tone: 'local' | 'remote';
  content: string;
  changed: Set<number>;
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

  const lines = content.split('\n');
  return (
    <section
      aria-label={label}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-border/70"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
        <span
          className={cn('size-2 rounded-full', tone === 'local' ? 'bg-primary' : 'bg-sky-400')}
        />
        <span className="text-[13px] font-semibold">{label}</span>
        <span className="flex-1 truncate text-[11.5px] text-muted-foreground">{detail}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
        >
          {copied ? <Check size={11} /> : <ClipboardCopy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-relaxed">
        {content ? (
          lines.map((line, index) => (
            <span
              key={index}
              className={cn(
                'block px-3 whitespace-pre-wrap break-all',
                changed.has(index) && (tone === 'local' ? 'bg-primary/12' : 'bg-sky-400/12'),
              )}
            >
              {line || ' '}
            </span>
          ))
        ) : (
          <span className="px-3 text-muted-foreground italic">(empty)</span>
        )}
      </pre>
    </section>
  );
}
