import type { ReactNode } from 'react';

import { Download, FileOutput } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

import { ChoiceGroup } from './app-dialog';
import { FormDialog } from './form-dialog';

/**
 * Template 6 — export. Formats as cards (icon, name, one line), options as rows
 * that follow the chosen format, then a summary of what will be written. The
 * primary button names the format ("Export PDF").
 */
export interface ExportFormat<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface ExportDialogProps<T extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  formats?: ExportFormat<T>[];
  format?: T;
  onFormatChange?: (format: T) => void;
  /** Option rows for the chosen format (use `DetailRow`). */
  children?: ReactNode;
  /** What will be written: "12 pages → Launch deck.pdf". */
  summary?: ReactNode;
  exportLabel: ReactNode;
  onExport: () => void | Promise<void>;
  exportDisabled?: boolean;
  busy?: boolean;
  error?: ReactNode;
  /** Alternative on the left of the footer (Print…). */
  secondary?: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
}

export function ExportDialog<T extends string>({
  open,
  onOpenChange,
  title,
  description,
  icon = <Download />,
  formats,
  format,
  onFormatChange,
  children,
  summary,
  exportLabel,
  onExport,
  exportDisabled,
  busy,
  error,
  secondary,
  onCloseAutoFocus,
}: ExportDialogProps<T>) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={icon}
      title={title}
      description={description}
      size="m"
      className="sm:max-w-[640px]"
      submitLabel={exportLabel}
      submitDisabled={exportDisabled}
      busy={busy}
      error={error}
      onSubmit={onExport}
      secondary={secondary}
      onCloseAutoFocus={onCloseAutoFocus}
      bodyClassName="gap-3"
    >
      {formats && formats.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground/85">Format</span>
          <ChoiceGroup
            value={format}
            onValueChange={(value) => onFormatChange?.(value as T)}
            aria-label="Format"
            className={cn(
              'grid gap-2',
              formats.length >= 5
                ? 'grid-cols-5'
                : formats.length === 4
                  ? 'grid-cols-4'
                  : 'grid-cols-3',
            )}
          >
            {formats.map((entry) => (
              <RadioGroupPrimitive.Item
                key={entry.value}
                value={entry.value}
                disabled={entry.disabled}
                aria-label={typeof entry.label === 'string' ? entry.label : undefined}
                className="group flex flex-col items-start gap-1 rounded-[10px] border border-border p-2.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:border-primary/70 data-[state=checked]:bg-primary/10"
              >
                <span className="text-muted-foreground group-data-[state=checked]:text-primary [&_svg]:size-[18px]">
                  {entry.icon ?? <FileOutput />}
                </span>
                <span className="text-[12.5px] font-medium">{entry.label}</span>
                {entry.description && (
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {entry.description}
                  </span>
                )}
              </RadioGroupPrimitive.Item>
            ))}
          </ChoiceGroup>
        </div>
      )}
      {children && <div className="flex flex-col border-t border-border/50">{children}</div>}
      {summary && (
        <div className="flex items-center gap-2 rounded-[10px] bg-muted/50 px-3 py-2.5 text-[12.5px]">
          <FileOutput className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">{summary}</span>
        </div>
      )}
    </FormDialog>
  );
}
