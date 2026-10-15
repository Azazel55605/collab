import { expect, it, vi } from 'vitest';

import type { HostedVaultMeta } from '../types/vault';

import { subscribeToNativeReplicaSync } from './nativeReplicaSync';
import { onReplicaMutated } from './vaultReplica';

const events = vi.hoisted(() => ({ listen: vi.fn(), cleanup: vi.fn() }));
vi.mock('./nativeSubscription', () => ({ listenSafely: events.listen }));

it('publishes only nonempty native downloads for the selected server and vault', () => {
  events.listen.mockReturnValue(events.cleanup);
  const vault = { serverUrl: 'https://server.test', hostedVaultId: 'vault' } as HostedVaultMeta;
  const listener = vi.fn();
  const unsubscribe = onReplicaMutated(listener, { kinds: ['manifest'] });
  const cleanup = subscribeToNativeReplicaSync(vault);
  const handler = events.listen.mock.calls[0][1];
  handler({ payload: { serverUrl: 'https://other.test', vaultId: 'vault', changed: 2 } });
  handler({ payload: { serverUrl: vault.serverUrl, vaultId: 'other', changed: 2 } });
  handler({ payload: { serverUrl: vault.serverUrl, vaultId: 'vault', changed: 0 } });
  expect(listener).not.toHaveBeenCalled();
  handler({ payload: { serverUrl: vault.serverUrl, vaultId: 'vault', changed: 2 } });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ kind: 'manifest' });
  cleanup();
  expect(events.cleanup).toHaveBeenCalledOnce();
  unsubscribe();
});
