import type { ReplicaSummary } from '../../lib/vaultReplica';
import { confirmAction } from '../ui/confirm-dialog';

import { serverHost } from './launcher/vaultEntries';

/** Asks before deleting a hosted vault's offline copy, warning about unsent changes. */
export function confirmRemoveOfflineCopy(replica: ReplicaSummary): Promise<boolean> {
  const pending = replica.pendingCount;
  return confirmAction({
    title: `Remove the offline copy of “${replica.vaultName}”?`,
    description:
      pending > 0
        ? `${pending} change${pending === 1 ? ' has' : 's have'} not been sent to ${serverHost(replica.serverUrl)} yet and will be lost. The vault on the server is not affected.`
        : `The vault stays on ${serverHost(replica.serverUrl)}; only this device’s copy is removed.`,
    confirmLabel: 'Remove copy',
    destructive: true,
  });
}
