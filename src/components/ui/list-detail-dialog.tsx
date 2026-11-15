import { type ReactNode, useEffect, useRef } from 'react';

import { Plus, Search } from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  type AppDialogTone,
} from './app-dialog';
import { Button } from './button';
import { Dialog } from './dialog';
import { Input } from './input';

/**
 * Template 4 — list and detail. A large dialog: a filterable list on the left
 * (rows with a one-line summary, an optional trailing control, New at the
 * bottom) and the selected item on the right as plain rows. Changes apply as the
 * person edits, so the footer only holds a destructive action on the left and
 * Done. With no items at all, an empty state replaces both panes.
 */
export interface ListDetailDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: AppDialogTone;
  items: T[];
  getKey: (item: T) => string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** One list row: title, summary, optional trailing control. */
  renderRow: (item: T, selected: boolean) => ReactNode;
  /** The detail pane for the selected item. Without a selection it shows `placeholder`. */
  renderDetail: (item: T) => ReactNode;
  /** Shown in the detail pane when nothing is selected (for example while creating). */
  placeholder?: ReactNode;
  /** Replaces the detail pane, e.g. a form for a new item. */
  detailOverride?: ReactNode;
  filter?: { value: string; onChange: (value: string) => void; placeholder?: string };
  newLabel?: ReactNode;
  onNew?: () => void;
  newDisabled?: boolean;
  /** Under the New button, e.g. a second creation path. */
  listFooter?: ReactNode;
  /** Destructive or secondary action on the left of the footer. */
  footerStart?: ReactNode;
  doneLabel?: ReactNode;
  /** Shown instead of both panes when there are no items and no override. */
  empty?: { title: ReactNode; description?: ReactNode; action?: ReactNode };
  listWidth?: number;
  className?: string;
}

export function ListDetailDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone,
  items,
  getKey,
  selectedKey,
  onSelect,
  renderRow,
  renderDetail,
  placeholder,
  detailOverride,
  filter,
  newLabel = 'New',
  onNew,
  newDisabled,
  listFooter,
  footerStart,
  doneLabel = 'Done',
  empty,
  listWidth = 280,
  className,
}: ListDetailDialogProps<T>) {
  const selected = items.find((item) => getKey(item) === selectedKey) ?? null;
  const showEmpty = items.length === 0 && !detailOverride && !filter?.value && empty;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent size={showEmpty ? 's' : 'l'} className={className}>
        <AppDialogHeader icon={icon} tone={tone} title={title} description={description} />
        {showEmpty ? (
          <div className="flex flex-col items-center gap-2 border-t border-border/60 px-6 pt-6 pb-7 text-center">
            {icon && (
              <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
                {icon}
              </span>
            )}
            <p className="text-sm font-semibold">{empty.title}</p>
            {empty.description && (
              <p className="max-w-xs text-[12.5px] text-muted-foreground">{empty.description}</p>
            )}
            {empty.action ??
              (onNew && (
                <Button className="mt-2" onClick={onNew} disabled={newDisabled}>
                  <Plus />
                  {newLabel}
                </Button>
              ))}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 border-t border-border/60">
            <aside
              className="flex shrink-0 flex-col gap-2 border-r border-border/60 p-3"
              style={{ width: listWidth }}
            >
              {filter && (
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter.value}
                    onChange={(event) => filter.onChange(event.target.value)}
                    placeholder={filter.placeholder ?? 'Filter'}
                    aria-label={filter.placeholder ?? 'Filter'}
                    className="h-8 pl-8 text-[13px]"
                  />
                </div>
              )}
              <ul
                role="listbox"
                aria-label="Items"
                className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1"
              >
                {items.map((item) => {
                  const key = getKey(item);
                  const isSelected = key === selectedKey && !detailOverride;
                  return (
                    <li
                      key={key}
                      role="option"
                      aria-selected={isSelected}
                      tabIndex={0}
                      onClick={() => onSelect(key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(key);
                        }
                      }}
                      className={cn(
                        'cursor-pointer rounded-[9px] px-2.5 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        isSelected ? 'bg-primary/15' : 'hover:bg-muted/50',
                      )}
                    >
                      {renderRow(item, isSelected)}
                    </li>
                  );
                })}
                {items.length === 0 && (
                  <li className="px-2 py-4 text-center text-xs text-muted-foreground">
                    {filter?.value ? 'Nothing matches' : 'Nothing here yet'}
                  </li>
                )}
              </ul>
              {onNew && (
                <Button variant="outline" onClick={onNew} disabled={newDisabled}>
                  <Plus />
                  {newLabel}
                </Button>
              )}
              {listFooter}
            </aside>
            <section className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto px-5 py-4 text-sm">
              {detailOverride ??
                (selected ? (
                  renderDetail(selected)
                ) : (
                  <div className="flex flex-1 items-center justify-center text-center text-[12.5px] text-muted-foreground">
                    {placeholder ?? 'Select an item to see its details.'}
                  </div>
                ))}
            </section>
          </div>
        )}
        {!showEmpty && (
          <AppDialogFooter start={footerStart}>
            <Button onClick={() => onOpenChange(false)}>{doneLabel}</Button>
          </AppDialogFooter>
        )}
      </AppDialogContent>
    </Dialog>
  );
}

/** A list row: title, one-line summary, optional trailing element (switch, chip). */
export function ListDetailRow({
  title,
  summary,
  icon,
  trailing,
  muted,
}: {
  title: ReactNode;
  summary?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {icon && (
        <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      )}
      <div className="min-w-0 flex-1 leading-snug">
        <div className={cn('truncate text-[13px] font-medium', muted && 'text-muted-foreground')}>
          {title}
        </div>
        {summary && (
          <div className="line-clamp-2 text-[11.5px] text-muted-foreground">{summary}</div>
        )}
      </div>
      {trailing && (
        <span
          className="shrink-0"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {trailing}
        </span>
      )}
    </div>
  );
}

/** One setting in a detail pane: label and description left, control right. */
export function DetailRow({
  label,
  description,
  danger,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-5 border-b border-border/40 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className={cn('text-[13px] font-medium', danger && 'text-destructive')}>{label}</p>
        {description && (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** Keeps the selection valid: picks the first item when the selected one goes away. */
export function useKeepSelection<T>(
  items: T[],
  getKey: (item: T) => string,
  selectedKey: string | null,
  onSelect: (key: string | null) => void,
  enabled = true,
) {
  const keys = items.map(getKey).join('\n');
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    if (!enabled) return;
    const list = keys ? keys.split('\n') : [];
    if (selectedKey && list.includes(selectedKey)) return;
    onSelectRef.current(list[0] ?? null);
  }, [keys, selectedKey, enabled]);
}
