import { AlertTriangle, Check, CloudOff, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';

import type { DocumentStatus } from '../../lib/documentSessionController';
import { cn } from '../../lib/utils';

/**
 * Shared, non-modal document-session status surface. Renders the controller's
 * `status` vocabulary consistently across every migrated document view (Phase 2
 * of the document session plan) and exposes the inline recovery actions for
 * `remote-pending` and `conflict` states. Phase 3 expands the merge/conflict UX
 * on top of this same surface.
 */
export interface DocumentStatusPillProps {
  status: DocumentStatus;
  /** Called for "Load latest" on a pending remote or a conflict. */
  onLoadRemote?: () => void;
  /**
   * Called for "Keep mine": discards a pending remote (keeps editing) or keeps
   * local content when resolving a conflict.
   */
  onKeepLocal?: () => void;
  className?: string;
  hideWhenSaved?: boolean;
  compact?: boolean;
}

interface StatusPresentation {
  label: string;
  icon: React.ReactNode;
  tone: 'muted' | 'active' | 'warning' | 'danger' | 'live';
}

function present(status: DocumentStatus): StatusPresentation {
  switch (status) {
    case 'saving':
      return {
        label: 'Saving…',
        icon: <Loader2 size={12} className="animate-spin" />,
        tone: 'active',
      };
    case 'saved':
      return { label: 'Saved', icon: <Check size={12} />, tone: 'muted' };
    case 'dirty':
      return { label: 'Unsaved changes', icon: <RefreshCw size={12} />, tone: 'active' };
    case 'remote-pending':
      return {
        label: 'Remote changes available',
        icon: <AlertTriangle size={12} />,
        tone: 'warning',
      };
    case 'conflict':
      return { label: 'Conflict needs review', icon: <AlertTriangle size={12} />, tone: 'danger' };
    case 'offline-queued':
      return { label: 'Offline changes queued', icon: <CloudOff size={12} />, tone: 'warning' };
    case 'live-connected':
      return { label: 'Live', icon: <Wifi size={12} />, tone: 'live' };
    case 'live-reconnecting':
      return { label: 'Reconnecting…', icon: <WifiOff size={12} />, tone: 'warning' };
    case 'idle':
    default:
      return { label: 'Saved', icon: <Check size={12} />, tone: 'muted' };
  }
}

const TONE_CLASS: Record<StatusPresentation['tone'], string> = {
  muted: 'border-border/60 text-muted-foreground',
  active: 'border-primary/30 text-primary',
  warning: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  danger: 'border-destructive/40 text-destructive',
  live: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
};

export function DocumentStatusPill({
  status,
  onLoadRemote,
  onKeepLocal,
  className,
  hideWhenSaved = false,
  compact = false,
}: DocumentStatusPillProps) {
  if (hideWhenSaved && (status === 'idle' || status === 'saved')) return null;
  const { label, icon, tone } = present(status);
  const showActions = status === 'remote-pending' || status === 'conflict';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium',
          compact && 'px-1.5 py-0 text-[10px]',
          TONE_CLASS[tone],
        )}
      >
        {icon}
        {label}
      </span>
      {showActions && (
        <span className="flex items-center gap-1">
          {onLoadRemote && (
            <button
              type="button"
              onClick={onLoadRemote}
              className={cn(
                'rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
                compact && 'px-1.5 py-0 text-[10px]',
              )}
            >
              Load latest
            </button>
          )}
          {onKeepLocal && (
            <button
              type="button"
              onClick={onKeepLocal}
              className={cn(
                'rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
                compact && 'px-1.5 py-0 text-[10px]',
              )}
            >
              {status === 'conflict' ? 'Keep mine' : 'Keep editing'}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
