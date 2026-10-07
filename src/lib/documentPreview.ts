import { useServerStore } from '../store/serverStore';

import { tauriCommands } from './tauri';
import { HostedVaultClient, LocalVaultClient, type VaultClient } from './vaultClient';

const INTERNAL_EXTENSIONS = new Set(['md', 'sheet', 'deck', 'ink', 'canvas', 'kanban', 'logic']);
const inFlight = new Map<string, Promise<string>>();

export function supportsDocumentPreview(path: string) {
  return INTERNAL_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '');
}

/** Share a single load across simultaneous hovers/canvas cards. Completed
 * results live in the version-aware native/server cache, not an unbounded map. */
export function getDocumentPreviewDataUrl(client: VaultClient, path: string): Promise<string> {
  const scope =
    client instanceof HostedVaultClient
      ? `${client.vault.serverUrl}:${useServerStore.getState().statusFor(client.vault.serverUrl)?.user?.id ?? 'unknown'}:${client.vault.hostedVaultId}`
      : client.id;
  const key = `${scope}::${path}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = load(client, path).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function load(client: VaultClient, path: string) {
  if (client instanceof HostedVaultClient) return client.readDocumentPreviewDataUrl(path);
  const localPath = client instanceof LocalVaultClient ? client.vault.path : null;
  if (localPath) {
    const cached = await tauriCommands
      .readCachedDocumentPreviewDataUrl(localPath, path)
      .catch(() => null);
    if (cached) return cached;
  }
  const document = await client.readDocument(path);
  const preview = await tauriCommands.generateDocumentPreview(path, document.content);
  if (localPath) {
    await tauriCommands
      .writeCachedDocumentPreviewDataUrl(localPath, path, preview, document.version)
      .catch(() => {});
  }
  return preview;
}
