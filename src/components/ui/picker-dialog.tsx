import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef } from 'react';

import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  type AppDialogSize,
} from './app-dialog';
import { Button } from './button';
import { Dialog } from './dialog';
import { Input } from './input';

/**
 * Template 5 — a picker. Search and scope chips on top; results as a list or a
 * grid, in groups; the selection's details on the right (optional). Arrow keys
 * move, Enter or a double-click picks, and the primary button names the item.
 */
export interface PickerGroup<T> {
  label?: ReactNode;
  items: T[];
}

export interface PickerDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  size?: AppDialogSize;
  query?: string;
  onQueryChange?: (query: string) => void;
  searchPlaceholder?: string;
  scopes?: { value: string; label: ReactNode }[];
  scope?: string;
  onScopeChange?: (scope: string) => void;
  groups: PickerGroup<T>[];
  getKey: (item: T) => string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  renderItem: (item: T, selected: boolean) => ReactNode;
  layout?: 'list' | 'grid';
  /** Details and options for the selection, shown on the right. */
  preview?: ReactNode;
  onPick: (item: T) => void;
  /** The primary button's label for the selection ("Insert Half adder"). */
  pickLabel: (item: T | null) => ReactNode;
  pickDisabled?: boolean;
  /** Alternative path on the left of the footer ("From this computer…"). */
  secondary?: ReactNode;
  emptyText?: ReactNode;
  /** Extra content above the results (a breadcrumb, a notice). */
  header?: ReactNode;
  className?: string;
  onCloseAutoFocus?: (event: Event) => void;
}

export function PickerDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  icon,
  size = 'l',
  query,
  onQueryChange,
  searchPlaceholder = 'Search',
  scopes,
  scope,
  onScopeChange,
  groups,
  getKey,
  selectedKey,
  onSelect,
  renderItem,
  layout = 'list',
  preview,
  onPick,
  pickLabel,
  pickDisabled,
  secondary,
  emptyText = 'Nothing matches.',
  header,
  className,
  onCloseAutoFocus,
}: PickerDialogProps<T>) {
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selected = flat.find((item) => getKey(item) === selectedKey) ?? null;
  const listRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Keep a valid selection: the first result when the current one disappears.
  const keys = flat.map(getKey).join('\n');
  useEffect(() => {
    if (!open) return;
    const list = keys ? keys.split('\n') : [];
    if (list.length && (!selectedKey || !list.includes(selectedKey))) onSelectRef.current(list[0]);
  }, [open, keys, selectedKey]);

  useEffect(() => {
    if (!selectedKey) return;
    listRef.current
      ?.querySelector(`[data-picker-key="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const move = (event: KeyboardEvent) => {
    if (!flat.length) return;
    const index = Math.max(
      0,
      flat.findIndex((item) => getKey(item) === selectedKey),
    );
    const columns = layout === 'grid' ? 3 : 1;
    let next = index;
    if (event.key === 'ArrowDown') next = Math.min(flat.length - 1, index + columns);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
    else if (layout === 'grid' && event.key === 'ArrowRight')
      next = Math.min(flat.length - 1, index + 1);
    else if (layout === 'grid' && event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (selected && !pickDisabled) onPick(selected);
      return;
    } else return;
    event.preventDefault();
    onSelect(getKey(flat[next]));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        size={size}
        className={className}
        onKeyDown={move}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AppDialogHeader icon={icon} title={title} description={description} />
        {(onQueryChange || scopes) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3">
            {onQueryChange && (
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={query ?? ''}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="h-8 pl-8 text-[13px]"
                />
              </div>
            )}
            {scopes && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
                {scopes.map((entry) => (
                  <button
                    key={entry.value}
                    type="button"
                    aria-pressed={scope === entry.value}
                    onClick={() => onScopeChange?.(entry.value)}
                    className={cn(
                      'h-7 rounded-full px-3 text-xs transition-colors',
                      scope === entry.value
                        ? 'bg-primary/15 font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {header}
        <div className="flex min-h-0 flex-1 border-t border-border/60">
          <div
            ref={listRef}
            role="listbox"
            aria-label="Results"
            className="min-w-0 flex-1 overflow-y-auto p-2.5"
          >
            {flat.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">
                {emptyText}
              </p>
            ) : (
              groups.map((group, groupIndex) =>
                group.items.length === 0 ? null : (
                  <div key={groupIndex} className="mb-2 last:mb-0">
                    {group.label && (
                      <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                        {group.label}
                      </p>
                    )}
                    <div
                      className={
                        layout === 'grid' ? 'grid grid-cols-3 gap-2' : 'flex flex-col gap-0.5'
                      }
                    >
                      {group.items.map((item) => {
                        const key = getKey(item);
                        const isSelected = key === selectedKey;
                        return (
                          <div
                            key={key}
                            role="option"
                            aria-selected={isSelected}
                            data-picker-key={key}
                            onClick={() => onSelect(key)}
                            onDoubleClick={() => !pickDisabled && onPick(item)}
                            className={cn(
                              'cursor-pointer transition-colors',
                              layout === 'grid'
                                ? cn(
                                    'rounded-[10px] border p-2.5',
                                    isSelected
                                      ? 'border-primary/70 bg-primary/10'
                                      : 'border-border hover:bg-muted/40',
                                  )
                                : cn(
                                    'rounded-lg px-2.5 py-1.5',
                                    isSelected ? 'bg-primary/15' : 'hover:bg-muted/50',
                                  ),
                            )}
                          >
                            {renderItem(item, isSelected)}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ),
              )
            )}
          </div>
          {preview && (
            <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/60 px-4 py-3.5 text-[12.5px]">
              {preview}
            </aside>
          )}
        </div>
        <AppDialogFooter start={secondary}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!selected || pickDisabled} onClick={() => selected && onPick(selected)}>
            {pickLabel(selected)}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog>
  );
}

/** A list row for pickers: icon tile, name, detail, trailing meta. */
export function PickerRow({
  icon,
  title,
  detail,
  meta,
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {icon && (
        <span className="flex h-7 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 leading-snug">
        <span className="block truncate text-[13px]">{title}</span>
        {detail && (
          <span className="block truncate text-[11.5px] text-muted-foreground">{detail}</span>
        )}
      </span>
      {meta && <span className="shrink-0 text-[11.5px] text-muted-foreground">{meta}</span>}
    </div>
  );
}
