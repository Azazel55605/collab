import type { UnlistenFn } from '@tauri-apps/api/event';
import { listen } from '@tauri-apps/api/event';

import type { BackgroundStatusSnapshot } from '../../../../src/lib/tauri';

/**
 * Background work used to be invisible to the app: the coordinator wrote to its
 * ledger and nothing told the webview. A sync could finish and bring in new
 * content while the file list kept showing what it had read minutes ago, and
 * nothing reported that a run was in progress at all.
 *
 * These are the two events the native observer emits. Both are advisory — the
 * durable state is always the ledger and the replica — so a missed event costs
 * a stale view until the next read, never correctness.
 */
export const BACKGROUND_STATUS_EVENT = 'background:status';
export const BACKGROUND_VAULT_SYNCED_EVENT = 'background:vault-synced';

export interface VaultSyncedEvent {
  serverUrl: string;
  vaultId: string;
  /** How many files the run brought in. Always at least 1. */
  changed: number;
}

export interface BackgroundEventHandlers {
  onStatus?: (snapshot: BackgroundStatusSnapshot) => void;
  onVaultSynced?: (event: VaultSyncedEvent) => void;
}

/**
 * Subscribes to native background events. Returns a disposer that is safe to
 * call before the listeners have finished registering, which matters because
 * React strict mode mounts and unmounts effects immediately.
 */
export function listenToBackgroundEvents(handlers: BackgroundEventHandlers): () => void {
  let disposed = false;
  const unlisteners: UnlistenFn[] = [];

  const register = async (event: string, handle: (payload: never) => void) => {
    const unlisten = await listen(event, (message) => {
      handle(message.payload as never);
    });
    if (disposed) {
      unlisten();
      return;
    }
    unlisteners.push(unlisten);
  };

  if (handlers.onStatus) {
    void register(BACKGROUND_STATUS_EVENT, handlers.onStatus as (payload: never) => void).catch(
      () => {},
    );
  }
  if (handlers.onVaultSynced) {
    void register(
      BACKGROUND_VAULT_SYNCED_EVENT,
      handlers.onVaultSynced as (payload: never) => void,
    ).catch(() => {});
  }

  return () => {
    disposed = true;
    while (unlisteners.length > 0) {
      unlisteners.pop()?.();
    }
  };
}
