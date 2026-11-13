import { cn } from '../../../lib/utils';

import type { ServerEntryState } from './vaultEntries';

/** Filled green for a live session, an amber ring when signed out, grey when only cached. */
export function ServerStatusDot({
  state,
  className,
}: {
  state: ServerEntryState;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'connected' && 'bg-emerald-500',
        state === 'signed-out' && 'border-2 border-amber-500',
        state === 'offline-only' && 'border-2 border-muted-foreground/60',
        className,
      )}
    />
  );
}
