import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  type AppDialogSize,
  type AppDialogTone,
} from './app-dialog';
import { Button } from './button';
import { Dialog } from './dialog';
import { Input } from './input';
import { Textarea } from './textarea';

/**
 * Template 3 — a form. Medium by default: header, fields with their label above,
 * pairs side by side ({@link FormRow}), an inline error, and the footer with
 * Cancel and the submit action. Enter submits (the body is a real form).
 */
export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: AppDialogTone;
  size?: AppDialogSize;
  /** Text of the submit button; it names the result ("Create calendar"). */
  submitLabel: ReactNode;
  cancelLabel?: ReactNode;
  submitDisabled?: boolean;
  /** Spinner on the submit button; the dialog cannot be closed meanwhile. */
  busy?: boolean;
  /** A form-level error shown above the footer. */
  error?: ReactNode;
  /** Called on submit (button or Enter). */
  onSubmit: () => void | Promise<void>;
  /** An alternative path on the left of the footer. */
  secondary?: ReactNode;
  /** Use for the destructive variant of a form (rare). */
  destructive?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone,
  size = 'm',
  submitLabel,
  cancelLabel = 'Cancel',
  submitDisabled = false,
  busy = false,
  error,
  onSubmit,
  secondary,
  destructive = false,
  className,
  bodyClassName,
  children,
}: FormDialogProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy || submitDisabled) return;
    void onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AppDialogContent size={size} className={className}>
        <form className="contents" onSubmit={submit} noValidate>
          <AppDialogHeader icon={icon} tone={tone} title={title} description={description} />
          <AppDialogBody className={bodyClassName}>
            {children}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </AppDialogBody>
          <AppDialogFooter start={secondary}>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={busy || submitDisabled}
            >
              {busy && <Loader2 className="animate-spin" />}
              {submitLabel}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </Dialog>
  );
}

/** A labelled field: label above, control, then a hint or an error. */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-foreground/85">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Fields side by side (two columns, one on narrow widths). */
export function FormRow({
  className,
  columns = 2,
  children,
}: {
  className?: string;
  columns?: 2 | 3;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('grid gap-3', columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2', className)}
    >
      {children}
    </div>
  );
}

/** A labelled section inside a long form. */
export function FormSection({
  title,
  className,
  children,
}: {
  title: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Template 2 — a quick prompt: one text field in a small form. Enter saves; the
 * value is trimmed; `validate` returns an error message or null.
 */
export interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  label: ReactNode;
  initialValue?: string;
  placeholder?: string;
  submitLabel: ReactNode;
  multiline?: boolean;
  /** Selects the name part of a file name (before the extension) when opened. */
  selectBaseName?: boolean;
  validate?: (value: string) => string | null;
  /** Throwing shows the message inline and keeps the dialog open. */
  onSubmit: (value: string) => void | Promise<void>;
  /** Extra fields or notes under the main field. */
  children?: ReactNode;
}

export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  label,
  initialValue = '',
  placeholder,
  submitLabel,
  multiline = false,
  selectBaseName = false,
  validate,
  onSubmit,
  children,
}: PromptDialogProps) {
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(null);
    setBusy(false);
    if (multiline) return;
    // Select the editable part once the dialog has focused the field.
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const dot = initialValue.lastIndexOf('.');
      if (selectBaseName && dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialValue, multiline, selectBaseName]);

  const trimmed = value.trim();
  const submit = async () => {
    const problem = validate?.(trimmed) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="s"
      title={title}
      description={description}
      icon={icon}
      submitLabel={submitLabel}
      submitDisabled={!trimmed}
      busy={busy}
      error={error}
      onSubmit={submit}
    >
      <FormField label={label} htmlFor={id}>
        {multiline ? (
          <Textarea
            id={id}
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            className="min-h-24 text-sm"
          />
        ) : (
          <Input
            id={id}
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            className="h-9"
          />
        )}
      </FormField>
      {children}
    </FormDialog>
  );
}
