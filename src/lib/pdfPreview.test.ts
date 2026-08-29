import { describe, expect, it, vi } from 'vitest';

import type { LocalVaultMeta } from '../types/vault';

import { loadPdfPreviewDataUrl } from './pdfPreview';
import { LocalVaultClient, type VaultClient } from './vaultClient';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));

vi.mock('./tauri', () => ({
  tauriCommands: {
    readNoteAssetDataUrl: vi.fn(async () => 'data:application/pdf;base64,source'),
  },
}));

const localVault: LocalVaultMeta = {
  id: 'local-vault',
  kind: 'local',
  name: 'Local vault',
  path: '/vault',
  lastOpened: 1,
  isEncrypted: false,
};

describe('loadPdfPreviewDataUrl', () => {
  it('returns a valid cached preview without re-reading or rerendering the source pdf', async () => {
    const client = new LocalVaultClient(localVault);
    const readAssetSpy = vi.spyOn(client, 'readAssetDataUrl');
    const readCachedDocumentPreviewDataUrl = vi.fn(async () => 'data:image/png;base64,cached');
    const writeCachedDocumentPreviewDataUrl = vi.fn(async () => {});
    const renderPdfPreviewFromDataUrl = vi.fn(async () => 'data:image/png;base64,rendered');

    const result = await loadPdfPreviewDataUrl(client, 'Docs/spec.pdf', {
      readCachedDocumentPreviewDataUrl,
      writeCachedDocumentPreviewDataUrl,
      renderPdfPreviewFromDataUrl,
    });

    expect(result).toBe('data:image/png;base64,cached');
    expect(readCachedDocumentPreviewDataUrl).toHaveBeenCalledWith('/vault', 'Docs/spec.pdf');
    expect(readAssetSpy).not.toHaveBeenCalled();
    expect(renderPdfPreviewFromDataUrl).not.toHaveBeenCalled();
    expect(writeCachedDocumentPreviewDataUrl).not.toHaveBeenCalled();
  });

  it('renders and stores a preview through the local cache when it misses', async () => {
    const client = new LocalVaultClient(localVault);
    vi.spyOn(client, 'readAssetDataUrl').mockResolvedValue('data:application/pdf;base64,source');
    const readCachedDocumentPreviewDataUrl = vi.fn(async () => null);
    const writeCachedDocumentPreviewDataUrl = vi.fn(async () => {});
    const renderPdfPreviewFromDataUrl = vi.fn(async () => 'data:image/png;base64,rendered');

    const result = await loadPdfPreviewDataUrl(client, 'Docs/spec.pdf', {
      readCachedDocumentPreviewDataUrl,
      writeCachedDocumentPreviewDataUrl,
      renderPdfPreviewFromDataUrl,
    });

    expect(result).toBe('data:image/png;base64,rendered');
    expect(renderPdfPreviewFromDataUrl).toHaveBeenCalledWith('data:application/pdf;base64,source');
    expect(writeCachedDocumentPreviewDataUrl).toHaveBeenCalledWith(
      '/vault',
      'Docs/spec.pdf',
      'data:image/png;base64,rendered',
    );
  });

  it('renders hosted previews on demand without touching the native document cache', async () => {
    const readAssetDataUrl = vi.fn(async () => 'data:application/pdf;base64,source');
    const hostedClient = {
      id: 'hosted-vault',
      readAssetDataUrl,
    } as unknown as VaultClient;
    const readCachedDocumentPreviewDataUrl = vi.fn(async () => null);
    const writeCachedDocumentPreviewDataUrl = vi.fn(async () => {});
    const renderPdfPreviewFromDataUrl = vi.fn(async () => 'data:image/png;base64,rendered');

    const result = await loadPdfPreviewDataUrl(hostedClient, 'Docs/spec.pdf', {
      readCachedDocumentPreviewDataUrl,
      writeCachedDocumentPreviewDataUrl,
      renderPdfPreviewFromDataUrl,
    });

    expect(result).toBe('data:image/png;base64,rendered');
    expect(readAssetDataUrl).toHaveBeenCalledWith('Docs/spec.pdf');
    expect(readCachedDocumentPreviewDataUrl).not.toHaveBeenCalled();
    expect(writeCachedDocumentPreviewDataUrl).not.toHaveBeenCalled();
  });
});
