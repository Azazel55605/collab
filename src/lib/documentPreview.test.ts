import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDocumentPreviewDataUrl, supportsDocumentPreview } from './documentPreview';
import { tauriCommands } from './tauri';
import { HostedVaultClient, LocalVaultClient } from './vaultClient';

vi.mock('./tauri', () => ({
  tauriCommands: {
    readCachedDocumentPreviewDataUrl: vi.fn(),
    writeCachedDocumentPreviewDataUrl: vi.fn(),
    generateDocumentPreview: vi.fn(),
  },
}));
const vault = { id: 'v', name: 'Vault', path: '/vault', isEncrypted: false, lastOpened: 0 };
beforeEach(() => {
  vi.mocked(tauriCommands.readCachedDocumentPreviewDataUrl).mockResolvedValue(null);
  vi.mocked(tauriCommands.generateDocumentPreview).mockResolvedValue(
    'data:image/svg+xml;base64,preview',
  );
  vi.mocked(tauriCommands.writeCachedDocumentPreviewDataUrl).mockResolvedValue();
});

describe('document previews', () => {
  it('loads native cached previews and regenerates a cache miss with the source version', async () => {
    const client = new LocalVaultClient(vault);
    const read = vi.spyOn(client, 'readDocument').mockResolvedValue({
      relativePath: 'Hi.md',
      content: '# Hi',
      version: 'hash',
      modifiedAt: 0,
    });
    vi.mocked(tauriCommands.readCachedDocumentPreviewDataUrl).mockResolvedValueOnce('cached');
    expect(await getDocumentPreviewDataUrl(client, 'Hi.md')).toBe('cached');
    expect(read).not.toHaveBeenCalled();
    await getDocumentPreviewDataUrl(client, 'Hi.md');
    expect(tauriCommands.writeCachedDocumentPreviewDataUrl).toHaveBeenCalledWith(
      '/vault',
      'Hi.md',
      'data:image/svg+xml;base64,preview',
      'hash',
    );
  });
  it('shares simultaneous hosted loads and evicts failures so a later request can retry', async () => {
    const client = new HostedVaultClient({
      ...vault,
      kind: 'hosted',
      serverUrl: 'https://server.example',
      hostedVaultId: 'v',
      role: 'viewer',
    });
    const load = vi
      .spyOn(client, 'readDocumentPreviewDataUrl')
      .mockRejectedValueOnce(new Error('offline'));
    const a = getDocumentPreviewDataUrl(client, 'a.sheet');
    expect(getDocumentPreviewDataUrl(client, 'a.sheet')).toBe(a);
    await expect(a).rejects.toThrow('offline');
    load.mockResolvedValue('server-preview');
    expect(await getDocumentPreviewDataUrl(client, 'a.sheet')).toBe('server-preview');
    expect(load).toHaveBeenCalledTimes(2);
    expect(tauriCommands.generateDocumentPreview).not.toHaveBeenCalled();
  });
  it('supports every internal document format without treating arbitrary JSON as a document', () => {
    for (const extension of ['md', 'sheet', 'deck', 'ink', 'canvas', 'kanban', 'logic'])
      expect(supportsDocumentPreview(`a.${extension}`)).toBe(true);
    expect(supportsDocumentPreview('a.DECK')).toBe(true);
    expect(supportsDocumentPreview('a.json')).toBe(false);
  });
});
