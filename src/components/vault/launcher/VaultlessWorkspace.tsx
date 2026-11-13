import type { ReactNode } from 'react';

import { type LauncherDestination, LauncherRail } from './LauncherRail';

/**
 * Chats and databases reached from the start screen, before any vault is open.
 * They get the start screen's rail instead of the vault ActivityBar, whose file,
 * calendar and vault-manager entries need an open vault, so Vaults stays one
 * click away.
 */
export function VaultlessWorkspace({
  current,
  children,
}: {
  current: Exclude<LauncherDestination, 'vaults'>;
  children: ReactNode;
}) {
  return (
    <div className="vault-bg flex h-screen min-h-0 flex-col overflow-hidden text-foreground md:flex-row">
      <LauncherRail current={current} />
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
