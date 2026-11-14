import { type ReactNode, useEffect, useRef } from 'react';

import { AlertTriangle, HelpCircle, Trash2 } from 'lucide-react';
import { create } from 'zustand';

import {
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  type AppDialogTone,
} from './app-dialog';
import { Button } from './button';
import { Dialog } from './dialog';

/**
 * Themed replacement for `window.confirm`: `await confirmAction({...})` resolves
 * true when the person confirms. The host is mounted once at the app root.
 */
export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button and a danger glyph for actions that delete or discard. */
  destructive?: boolean;
  tone?: AppDialogTone;
  icon?: ReactNode;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

const useConfirmStore = create<{ pending: PendingConfirm | null }>(() => ({ pending: null }));

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // A second request answers the first with "no" rather than leaving it hanging.
    useConfirmStore.getState().pending?.resolve(false);
    useConfirmStore.setState({ pending: { ...options, resolve } });
  });
}

function settle(confirmed: boolean) {
  const pending = useConfirmStore.getState().pending;
  if (!pending) return;
  useConfirmStore.setState({ pending: null });
  pending.resolve(confirmed);
}

export function ConfirmDialogHost() {
  const pending = useConfirmStore((state) => state.pending);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => () => settle(false), []);
  const tone = pending?.tone ?? (pending?.destructive ? 'danger' : 'accent');
  const icon =
    pending?.icon ??
    (pending?.destructive ? <Trash2 /> : tone === 'warning' ? <AlertTriangle /> : <HelpCircle />);
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && settle(false)}>
      {pending && (
        <AppDialogContent
          size="s"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmRef.current?.focus();
          }}
        >
          <AppDialogHeader
            icon={icon}
            tone={tone}
            title={pending.title}
            description={pending.description}
          />
          <AppDialogFooter>
            <Button variant="ghost" onClick={() => settle(false)}>
              {pending.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              ref={confirmRef}
              variant={pending.destructive ? 'destructive' : 'default'}
              onClick={() => settle(true)}
            >
              {pending.confirmLabel}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      )}
    </Dialog>
  );
}
