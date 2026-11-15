import { type FormEvent, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { PopoverContent } from './popover';

/**
 * The app's pop-over patterns. Every pop-over shares one shell — header,
 * body, footer strip — and takes one of four shapes:
 *
 * A · search picker ({@link PickerCommand} and its parts): search, grouped
 *     results as a list, a grid or a select, Enter picks.
 * B · date (`DatePanel` in ./date-panel.tsx): quick picks, the month, clear and optional time.
 * C · mini form ({@link PopoverForm}): a title naming the target, a few fields,
 *     Cancel and the action — or no footer when changes apply live.
 * D · panel: a title with one action, a list, a footer with reset and commit.
 */

/** The shared shell: no padding of its own, so header, body and footer line up. */
export function PopoverPanel({ className, ...props }: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      className={cn('gap-0 overflow-hidden rounded-xl p-0 text-[13px]', className)}
      {...props}
    />
  );
}

export function PopoverPanelHeader({
  title,
  meta,
  action,
  className,
}: {
  title: ReactNode;
  /** Short secondary text on the right ("2 waiting"). */
  meta?: ReactNode;
  /** One small action on the right ("Sort A→Z"). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-10 items-center gap-2 px-3 pt-2.5 pb-2', className)}>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
      {meta && <span className="shrink-0 text-[11.5px] text-muted-foreground">{meta}</span>}
      {action}
    </div>
  );
}

export function PopoverPanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-3 px-3 pb-3', className)} {...props} />;
}

/** The footer strip: an alternative or reset on the left, the commit on the right. */
export function PopoverPanelFooter({
  start,
  children,
  className,
}: {
  start?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-11 shrink-0 items-center gap-1.5 border-t border-border/60 bg-muted/40 px-2.5 py-2',
        className,
      )}
    >
      {start}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Keyboard hints for a picker footer: [["↑↓", "move"], ["↵", "attach"]]. */
export function KeyHints({ hints }: { hints: [string, string][] }) {
  return (
    <span className="flex gap-2.5 text-[11.5px] text-muted-foreground">
      {hints.map(([key, label]) => (
        <span key={key} className="inline-flex items-center gap-1">
          <kbd className="rounded-[5px] border border-b-2 border-border px-1 font-mono text-[10px] leading-4">
            {key}
          </kbd>
          {label}
        </span>
      ))}
    </span>
  );
}

// ─── A · search picker ────────────────────────────────────────────────────────

export function PickerCommand({ className, ...props }: React.ComponentProps<typeof Command>) {
  return <Command className={cn('rounded-none! bg-transparent p-0', className)} {...props} />;
}

export function PickerInput(props: React.ComponentProps<typeof CommandInput>) {
  return (
    <div className="px-1.5 pt-1.5 pb-1 [&_[data-slot=command-input-wrapper]]:p-0">
      <CommandInput {...props} />
    </div>
  );
}

export function PickerList({ className, ...props }: React.ComponentProps<typeof CommandList>) {
  return <CommandList className={cn('max-h-80 px-1.5 pb-1.5', className)} {...props} />;
}

export function PickerEmpty({ className, ...props }: React.ComponentProps<typeof CommandEmpty>) {
  return (
    <CommandEmpty
      className={cn('py-6 text-center text-[12.5px] text-muted-foreground', className)}
      {...props}
    />
  );
}

export function PickerGroup({ className, ...props }: React.ComponentProps<typeof CommandGroup>) {
  return (
    <CommandGroup
      className={cn(
        'p-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-[10.5px] **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:tracking-wider **:[[cmdk-group-heading]]:uppercase',
        className,
      )}
      {...props}
    />
  );
}

/** A picker row: icon tile, title, detail below, meta on the right. */
export function PickerItem({
  icon,
  title,
  detail,
  meta,
  className,
  ...props
}: Omit<React.ComponentProps<typeof CommandItem>, 'title' | 'children'> & {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <CommandItem
      className={cn('gap-2.5 rounded-lg px-2 py-1.5 data-selected:bg-primary/15', className)}
      {...props}
    >
      {icon && (
        <span className="flex h-6 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
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
    </CommandItem>
  );
}

// B · date lives in ./date-panel.tsx so the calendar only loads with it.

// ─── C · mini form ────────────────────────────────────────────────────────────

/**
 * Template C — a small form inside a pop-over. The title names the target;
 * Enter saves, Esc (the pop-over) cancels. Leave out `onSubmit` for a live
 * form that applies as the person changes it: then there is no footer.
 */
export function PopoverForm({
  title,
  meta,
  children,
  submitLabel = 'Save',
  submitDisabled,
  onSubmit,
  onCancel,
  start,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  submitLabel?: ReactNode;
  submitDisabled?: boolean;
  onSubmit?: () => void;
  onCancel?: () => void;
  /** A destructive or alternative action on the left of the footer. */
  start?: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!submitDisabled) onSubmit?.();
  };
  return (
    <form className="flex flex-col" onSubmit={submit} noValidate>
      <PopoverPanelHeader title={title} meta={meta} />
      <PopoverPanelBody>{children}</PopoverPanelBody>
      {onSubmit && (
        <PopoverPanelFooter start={start}>
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </PopoverPanelFooter>
      )}
    </form>
  );
}

/** A small label above a control inside pop-overs. */
export function PopoverField({
  label,
  htmlFor,
  meta,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="flex text-[12px] font-medium text-foreground/85">
        <span className="flex-1">{label}</span>
        {meta && <span className="font-normal text-muted-foreground">{meta}</span>}
      </label>
      {children}
    </div>
  );
}

// ─── Preview card ─────────────────────────────────────────────────────────────

/**
 * A read-only hover preview (file, web link) with the pop-over surface. It is
 * positioned by its caller because it follows the pointer rather than a
 * trigger; the header matches picker rows: icon tile, title, detail.
 */
export function PreviewCard({
  icon,
  title,
  detail,
  media,
  mediaClassName,
  children,
  className,
  style,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** An image or thumbnail under the header. */
  media?: ReactNode;
  mediaClassName?: string;
}) {
  return (
    <div
      className={cn('pointer-events-none fixed z-[120] max-w-[calc(100vw-1.5rem)]', className)}
      style={style}
      {...props}
    >
      <div className="max-h-[calc(100dvh-1.5rem)] overflow-hidden rounded-xl bg-popover text-[13px] text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 animate-in fade-in-0 zoom-in-95">
        <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-2">
          <span className="flex h-6 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
            {icon}
          </span>
          <span className="min-w-0 flex-1 leading-snug">
            <span className="block truncate font-semibold">{title}</span>
            {detail && (
              <span className="block truncate text-[11.5px] text-muted-foreground">{detail}</span>
            )}
          </span>
        </div>
        {media && (
          <div className={cn('border-t border-border/60 bg-muted/30 p-2', mediaClassName)}>
            {media}
          </div>
        )}
        {children && (
          <div className="border-t border-border/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
