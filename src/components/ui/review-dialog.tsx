import type { ReactNode } from 'react';

import { AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  type AppDialogTone,
} from './app-dialog';
import { Button } from './button';
import { Dialog } from './dialog';

/**
 * Template 7 — review and report.
 *
 * {@link ChangeReviewDialog}: before a change runs. The change in one line, a
 * summary as chips, then every affected item with what happens to it. A
 * blocking reason disables the primary action and says why.
 *
 * {@link ReportDialog}: after something ran. A header with the outcome, a few
 * numbers, then what changed or failed, worst first.
 */
export type ReviewTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const CHIP_TONE: Record<ReviewTone, string> = {
  neutral: 'bg-muted text-foreground/80',
  info: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/12 text-destructive',
};

export function ReviewChip({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: ReviewTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] whitespace-nowrap [&_svg]:size-3',
        CHIP_TONE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export interface ReviewItem {
  key: string;
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  chip?: { label: ReactNode; tone?: ReviewTone };
  /** A small action at the end of the row (e.g. Remove). */
  action?: ReactNode;
}

/** The bordered list of affected items or findings shared by both dialogs. */
export function ReviewList({
  items,
  emptyText,
  className,
  label,
}: {
  items: ReviewItem[];
  emptyText?: ReactNode;
  className?: string;
  /** Accessible name of the list. */
  label?: string;
}) {
  if (items.length === 0)
    return emptyText ? (
      <p className="rounded-[10px] border border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
        {emptyText}
      </p>
    ) : null;
  return (
    <ul
      aria-label={label}
      className={cn('max-h-72 overflow-y-auto rounded-[10px] border border-border/60', className)}
    >
      {items.map((item) => (
        <li
          key={item.key}
          className="flex items-start gap-2.5 border-b border-border/40 px-3 py-2 last:border-b-0"
        >
          {item.icon && (
            <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-3.5">
              {item.icon}
            </span>
          )}
          <span className="min-w-0 flex-1 leading-snug">
            <span className="block truncate text-[13px]">{item.title}</span>
            {item.detail && (
              <span className="block text-[11.5px] break-words text-muted-foreground">
                {item.detail}
              </span>
            )}
          </span>
          {item.chip && <ReviewChip tone={item.chip.tone}>{item.chip.label}</ReviewChip>}
          {item.action}
        </li>
      ))}
    </ul>
  );
}

export interface ChangeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: AppDialogTone;
  /** The change in one line, e.g. old path → new path. */
  change?: ReactNode;
  chips?: { key: string; label: ReactNode; tone?: ReviewTone; icon?: ReactNode }[];
  items: ReviewItem[];
  itemsLabel?: ReactNode;
  emptyText?: ReactNode;
  /** When set, the change cannot run; the reason is shown and the button disabled. */
  blockedReason?: ReactNode;
  confirmLabel: ReactNode;
  confirmDisabled?: boolean;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  cancelLabel?: ReactNode;
  secondary?: ReactNode;
  /** Content between the chips and the list (steps, options). */
  children?: ReactNode;
  wide?: boolean;
}

export function ChangeReviewDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone,
  change,
  chips,
  items,
  itemsLabel,
  emptyText,
  blockedReason,
  confirmLabel,
  confirmDisabled,
  destructive,
  busy,
  onConfirm,
  cancelLabel = 'Cancel',
  secondary,
  children,
  wide,
}: ChangeReviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AppDialogContent size="m" className={wide ? 'sm:max-w-[720px]' : 'sm:max-w-[640px]'}>
        <AppDialogHeader icon={icon} tone={tone} title={title} description={description} />
        <AppDialogBody className="gap-3">
          {change && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-border/70 px-3 py-2.5 font-mono text-[12.5px] break-all">
              {change}
            </div>
          )}
          {chips && chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <ReviewChip key={chip.key} tone={chip.tone} icon={chip.icon}>
                  {chip.label}
                </ReviewChip>
              ))}
            </div>
          )}
          {blockedReason && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-[10px] border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12.5px] text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {blockedReason}
            </p>
          )}
          {children}
          {itemsLabel && items.length > 0 && (
            <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {itemsLabel}
            </p>
          )}
          <ReviewList items={items} emptyText={emptyText} />
        </AppDialogBody>
        <AppDialogFooter start={secondary}>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || !!blockedReason || confirmDisabled}
            onClick={() => void onConfirm()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog>
  );
}

export interface ReportStat {
  key: string;
  label: ReactNode;
  value: ReactNode;
  tone?: ReviewTone;
}

export interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** success: green check; warning: something needs a look; danger: it failed. */
  outcome?: 'success' | 'warning' | 'danger' | 'info';
  stats?: ReportStat[];
  itemsLabel?: ReactNode;
  items?: ReviewItem[];
  emptyText?: ReactNode;
  /** Primary action (Open file); without it the primary button is Done. */
  primary?: ReactNode;
  secondary?: ReactNode;
  doneLabel?: ReactNode;
  children?: ReactNode;
  wide?: boolean;
  /** Accessible names for the stats row and the findings list. */
  statsLabel?: string;
  listLabel?: string;
  /** Called when focus would return to the trigger (e.g. to give it back to a canvas). */
  onCloseAutoFocus?: (event: Event) => void;
}

const STAT_TONE: Record<ReviewTone, string> = {
  neutral: 'text-foreground',
  info: 'text-sky-600 dark:text-sky-300',
  success: 'text-emerald-600 dark:text-emerald-300',
  warning: 'text-amber-600 dark:text-amber-300',
  danger: 'text-destructive',
};

export function ReportDialog({
  open,
  onOpenChange,
  title,
  description,
  outcome = 'success',
  stats,
  itemsLabel,
  items = [],
  emptyText,
  primary,
  secondary,
  doneLabel = 'Done',
  children,
  wide,
  statsLabel,
  listLabel,
  onCloseAutoFocus,
}: ReportDialogProps) {
  const icon =
    outcome === 'success' ? <CheckCircle2 /> : outcome === 'info' ? <Info /> : <AlertTriangle />;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        size="m"
        className={wide ? 'sm:max-w-[760px]' : 'sm:max-w-[640px]'}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AppDialogHeader
          icon={icon}
          tone={outcome === 'info' ? 'accent' : outcome}
          title={title}
          description={description}
        />
        <AppDialogBody className="gap-3">
          {stats && stats.length > 0 && (
            <div className="flex gap-2" aria-label={statsLabel}>
              {stats.map((stat) => (
                <div key={stat.key} className="min-w-0 flex-1 rounded-[10px] bg-muted/50 px-3 py-2">
                  <p className="truncate text-[11.5px] text-muted-foreground">{stat.label}</p>
                  <p
                    className={cn(
                      'text-lg font-semibold tabular-nums',
                      STAT_TONE[stat.tone ?? 'neutral'],
                    )}
                  >
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          )}
          {children}
          {itemsLabel && items.length > 0 && (
            <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {itemsLabel}
            </p>
          )}
          <ReviewList items={items} emptyText={emptyText} label={listLabel} />
        </AppDialogBody>
        <AppDialogFooter start={secondary}>
          {primary ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {doneLabel}
              </Button>
              {primary}
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{doneLabel}</Button>
          )}
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog>
  );
}
