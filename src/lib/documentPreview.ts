import { previewIdentity } from './previewIdentity';
import { type PreviewPriority, previewScheduler } from './previewScheduler';
import { tauriCommands } from './tauri';
import { HostedVaultClient, LocalVaultClient, type VaultClient } from './vaultClient';

export { supportsDocumentPreview } from './filePreviewType';
export function getDocumentPreviewDataUrl(
  client: VaultClient,
  path: string,
  options: { signal?: AbortSignal; priority?: PreviewPriority } = {},
): Promise<string> {
  const key = previewIdentity(client, path, 'document:v2');
  return previewScheduler.run(
    key,
    async (signal) => {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const preview = await load(client, path, key, signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return preview;
    },
    options,
  );
}

async function load(client: VaultClient, path: string, scope: string, signal?: AbortSignal) {
  if (client instanceof HostedVaultClient)
    return client.readDocumentPreviewDataUrl(path, scope, signal);
  const localPath = client instanceof LocalVaultClient ? client.vault.path : null;
  if (localPath) {
    const cached = await tauriCommands
      .readCachedDocumentPreviewDataUrl(localPath, path)
      .catch(() => null);
    if (cached) return cached;
  }
  const document = await client.readDocument(path);
  const preview = await tauriCommands.generateDocumentPreview(path, document.content, signal);
  if (localPath) {
    await tauriCommands
      .writeCachedDocumentPreviewDataUrl(localPath, path, preview, document.version)
      .catch(() => {});
  }
  return preview;
}
