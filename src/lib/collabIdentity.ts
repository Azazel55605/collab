import { useCollabStore } from '../store/collabStore';
import { useServerStore } from '../store/serverStore';
import { useVaultStore } from '../store/vaultStore';
import { vaultKind, type VaultMeta } from '../types/vault';

import type { ServerConnectionStatus } from './tauri';
import { userColorForId } from './userColor';

export { userColorForId };

/**
 * Source of the active collaboration identity.
 *
 * - `local`  — the client-generated identity persisted in `localStorage`. Used
 *   for local vaults and for presence/chat/history labels there.
 * - `server` — the authenticated hosted-server user. Hosted vaults must label
 *   their collaborator under the server-authoritative identity, never the
 *   client-generated one.
 */
export type IdentitySource = 'local' | 'server';

export interface CollabIdentity {
  userId: string;
  userName: string;
  userColor: string;
  source: IdentitySource;
}

/**
 * Resolve the server-authoritative identity for a vault, or `null` when the
 * vault is not a hosted vault served by the currently connected session.
 *
 * Hosted identity is only trusted when the connected server URL matches the
 * vault's server URL so a stale or mismatched session can never relabel a
 * different server's vault.
 */
export function serverIdentityForVault(
  vault: VaultMeta | null,
  status: ServerConnectionStatus | null,
): CollabIdentity | null {
  if (!vault || vaultKind(vault) !== 'hosted') return null;
  if (!status?.connected || !status.user || !status.serverUrl) return null;
  if (vault.kind === 'hosted' && vault.serverUrl !== status.serverUrl) return null;
  return {
    userId: status.user.id,
    userName: status.user.displayName,
    userColor: userColorForId(status.user.id),
    source: 'server',
  };
}

/**
 * The effective collaboration identity for the currently open vault. Hosted
 * vaults resolve to the authenticated server user; everything else falls back
 * to the local client identity.
 */
export function useCollabIdentity(): CollabIdentity {
  const vault = useVaultStore((state) => state.vault);
  const status = useServerStore((state) =>
    vault?.kind === 'hosted' ? (state.connections[vault.serverUrl]?.status ?? null) : null,
  );
  const userId = useCollabStore((state) => state.myUserId);
  const userName = useCollabStore((state) => state.myUserName);
  const userColor = useCollabStore((state) => state.myUserColor);

  return serverIdentityForVault(vault, status) ?? { userId, userName, userColor, source: 'local' };
}
