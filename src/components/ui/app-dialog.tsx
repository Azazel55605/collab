import * as React from 'react';

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

import { DialogContent, DialogDescription, DialogTitle } from './dialog';

/**
 * The app's one dialog shape. Three sizes: `s` (420 px) for confirmations and
 * short choices, `m` (520 px) for forms, `l` (880 × 600) for workspaces such as
 * list + detail or history. Every dialog has the same header (optional tinted
 * glyph, title, one-line description, close), a scrolling body and a tinted
 * footer strip: alternative path on the left, Cancel then the primary action on
 * the right.
 */
export type AppDialogSize = 's' | 'm' | 'l';
export type AppDialogTone = 'accent' | 'warning' | 'danger' | 'success' | 'neutral';

const SIZE_CLASS: Record<AppDialogSize, string> = {
  s: 'sm:max-w-[420px]',
  m: 'sm:max-w-[520px]',
  l: 'h-[600px] max-h-[calc(100vh-2rem)] sm:max-w-[880px]',
};

const TONE_CLASS: Record<AppDialogTone, string> = {
  accent: 'bg-primary/15 text-primary',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  danger: 'bg-destructive/15 text-destructive',
  success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  neutral: 'bg-muted text-muted-foreground',
};

function AppDialogContent({
  size = 'm',
  className,
  ...props
}: React.ComponentProps<typeof DialogContent> & { size?: AppDialogSize }) {
  return (
    <DialogContent
      data-size={size}
      className={cn(
        'flex max-h-[calc(100vh-2rem)] w-full flex-col gap-0 overflow-hidden p-0 [&>[data-slot=dialog-close]]:top-3.5 [&>[data-slot=dialog-close]]:right-3.5',
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    />
  );
}

function AppDialogHeader({
  icon,
  tone = 'accent',
  title,
  description,
  children,
  className,
}: {
  icon?: React.ReactNode;
  tone?: AppDialogTone;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Extra controls on the right of the title, before the close button. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="app-dialog-header"
      className={cn('flex shrink-0 items-start gap-3 py-4 pr-12 pl-5', className)}
    >
      {icon && (
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-[18px]',
            TONE_CLASS[tone],
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <DialogTitle className="text-[15px] leading-snug font-semibold">{title}</DialogTitle>
        {description ? (
          <DialogDescription className="mt-0.5 text-[12.5px] leading-relaxed">
            {description}
          </DialogDescription>
        ) : (
          <DialogDescription className="sr-only">{title}</DialogDescription>
        )}
      </div>
      {children}
    </div>
  );
}

function AppDialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="app-dialog-body"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-5 text-sm',
        className,
      )}
      {...props}
    />
  );
}

function AppDialogFooter({
  start,
  children,
  className,
}: {
  /** Alternative path or secondary information, on the left. */
  start?: React.ReactNode;
  /** Cancel, then the primary action. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="app-dialog-footer"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-t border-border/60 bg-muted/40 px-5 py-3',
        className,
      )}
    >
      {start}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Choices as cards rather than small radios. */
function ChoiceGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-2', className)} {...props} />;
}

function ChoiceCard({
  value,
  title,
  description,
  className,
  ...props
}: Omit<React.ComponentProps<typeof RadioGroupPrimitive.Item>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <RadioGroupPrimitive.Item
      value={value}
      className={cn(
        'group flex w-full items-start gap-2.5 rounded-[10px] border border-border px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:border-primary/70 data-[state=checked]:bg-primary/10',
        className,
      )}
      {...props}
    >
      <span className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-muted-foreground/50 transition-[border] group-data-[state=checked]:border-[5px] group-data-[state=checked]:border-primary" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{title}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

export {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  ChoiceCard,
  ChoiceGroup,
};
