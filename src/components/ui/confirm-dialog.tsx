import { type ReactNode, useEffect, useRef, useState } from 'react';

import { AlertTriangle, HelpCircle, Loader2, Trash2 } from 'lucide-react';
import { create } from 'zustand';

import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  type AppDialogTone,
  ChoiceCard,
  ChoiceGroup,
} from './app-dialog';
import { Button } from './button';
import { Dialog } from './dialog';

/**
 * Template 1 — confirm and choose. A small dialog that asks one question: a
 * plain yes/no, or a pick between choice cards. Use the declarative
 * {@link ConfirmDialog} when the caller owns state (a busy flag, extra content
 * such as a checkbox); use {@link confirmAction} / {@link chooseAction} for a
 * one-off question that just needs an answer. Never `window.confirm`.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Text of the confirm button; it names the action ("Delete event"). */
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  /** Red confirm button and a danger glyph for actions that delete or discard. */
  destructive?: boolean;
  tone?: AppDialogTone;
  icon?: ReactNode;
  /** Shows a spinner and disables both buttons while the action runs. */
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
  /** Extra content between the header and the footer: choices, a checkbox, a note. */
  children?: ReactNode;
  /** A third, alternative action on the left of the footer. */
  secondary?: ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  tone,
  icon,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  children,
  secondary,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const resolvedTone = tone ?? (destructive ? 'danger' : 'accent');
  const resolvedIcon =
    icon ??
    (destructive ? <Trash2 /> : resolvedTone === 'warning' ? <AlertTriangle /> : <HelpCircle />);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AppDialogContent
        size="s"
        onOpenAutoFocus={(event) => {
          // Land on the action, unless the body has its own control to focus.
          if (children) return;
          event.preventDefault();
          confirmRef.current?.focus();
        }}
      >
        <AppDialogHeader
          icon={resolvedIcon}
          tone={resolvedTone}
          title={title}
          description={description}
        />
        {children && <AppDialogBody className="gap-2.5">{children}</AppDialogBody>}
        <AppDialogFooter start={secondary}>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || confirmDisabled}
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

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  tone?: AppDialogTone;
  icon?: ReactNode;
}

export interface Choice<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface ChooseOptions<T extends string> extends Omit<ConfirmOptions, 'confirmLabel'> {
  choices: Choice<T>[];
  defaultValue?: T;
  /** A fixed label, or one per choice ("Delete event" / "Delete series"). */
  confirmLabel: string | ((value: T) => string);
}

type Pending =
  | ({ kind: 'confirm'; resolve: (confirmed: boolean) => void } & ConfirmOptions)
  | ({ kind: 'choose'; resolve: (value: string | null) => void } & ChooseOptions<string>);

const useConfirmStore = create<{ pending: Pending | null }>(() => ({ pending: null }));

function cancelPending() {
  const pending = useConfirmStore.getState().pending;
  if (!pending) return;
  if (pending.kind === 'confirm') pending.resolve(false);
  else pending.resolve(null);
}

/** Asks a yes/no question; resolves true when the person confirms. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // A second request answers the first with "no" rather than leaving it hanging.
    cancelPending();
    useConfirmStore.setState({ pending: { kind: 'confirm', ...options, resolve } });
  });
}

/** Asks for one of several choices; resolves the chosen value, or null when cancelled. */
export function chooseAction<T extends string>(options: ChooseOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    cancelPending();
    useConfirmStore.setState({
      pending: {
        kind: 'choose',
        ...(options as unknown as ChooseOptions<string>),
        resolve: resolve as (value: string | null) => void,
      },
    });
  });
}

function close(answer: boolean | string | null) {
  const pending = useConfirmStore.getState().pending;
  if (!pending) return;
  useConfirmStore.setState({ pending: null });
  if (pending.kind === 'confirm') pending.resolve(answer === true);
  else pending.resolve(typeof answer === 'string' ? answer : null);
}

export function ConfirmDialogHost() {
  const pending = useConfirmStore((state) => state.pending);
  const [choice, setChoice] = useState<string>('');
  useEffect(() => () => cancelPending(), []);
  useEffect(() => {
    if (pending?.kind === 'choose')
      setChoice(
        pending.defaultValue ?? pending.choices.find((entry) => !entry.disabled)?.value ?? '',
      );
  }, [pending]);
  if (!pending) return null;
  const confirmLabel =
    pending.kind === 'choose'
      ? typeof pending.confirmLabel === 'function'
        ? pending.confirmLabel(choice)
        : pending.confirmLabel
      : pending.confirmLabel;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && close(null)}
      title={pending.title}
      description={pending.description}
      confirmLabel={confirmLabel}
      cancelLabel={pending.cancelLabel}
      destructive={pending.destructive}
      tone={pending.tone}
      icon={pending.icon}
      confirmDisabled={pending.kind === 'choose' && !choice}
      onConfirm={() => close(pending.kind === 'confirm' ? true : choice)}
    >
      {pending.kind === 'choose' ? (
        <ChoiceGroup value={choice} onValueChange={setChoice} aria-label="Choose one">
          {pending.choices.map((entry) => (
            <ChoiceCard
              key={entry.value}
              value={entry.value}
              title={entry.title}
              description={entry.description}
              disabled={entry.disabled}
            />
          ))}
        </ChoiceGroup>
      ) : undefined}
    </ConfirmDialog>
  );
}
