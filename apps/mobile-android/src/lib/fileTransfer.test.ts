import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const open = vi.fn();
const save = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args), Channel: class {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => open(...args),
  save: (...args: unknown[]) => save(...args),
}));

import type { HostedVault } from '../mobileTauri';
import { downloadEntireVault, downloadEntry, normalizedNoteName, pickAndUploadFiles } from './fileTransfer';

const vault = (capabilities: string[]): HostedVault => ({
  id: 'vault-1',
  name: 'Team Vault',
  role: 'editor',
  status: 'active',
  members: 2,
  storageBytes: 100,
  manifestSequence: 3,
  updatedAt: null,
  capabilities,
});

const rawFile = (id: string, name: string, kind: 'asset' | 'document' | 'folder') => ({
  id,
  parentId: null,
  name,
  relativePath: name,
  kind,
  documentType: kind === 'document' ? 'note' : null,
  state: 'active',
  updatedAt: null,
  currentRevision: kind === 'folder' ? null : { sequence: 1, sizeBytes: 4, contentHash: 'hash' },
});

beforeEach(() => {
  vi.clearAllMocks();
  open.mockResolvedValue([]);
  save.mockResolvedValue(null);
});

describe('mobile file transfer', () => {
  it('uploads binary assets and text documents through their permission-specific routes', async () => {
    open.mockResolvedValue(['/picked/photo.png', '/picked/readme.md']);
    invoke.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === 'hosted_vault_upload_file') return Promise.resolve(rawFile('asset-1', 'photo.png', 'asset'));
      if (command === 'read_file_for_upload') {
        return Promise.resolve({ name: 'readme.md', mediaType: 'text/markdown', contentBase64: btoa('# Readme'), expectedHash: 'hash' });
      }
      if (command === 'hosted_vault_request') return Promise.resolve(rawFile('doc-1', 'readme.md', 'document'));
      return Promise.reject(new Error(`Unexpected ${command} ${JSON.stringify(args)}`));
    });

    const result = await pickAndUploadFiles('https://server.test', vault(['file.create', 'file.uploadAsset']), null);

    expect(result.completed.map((file) => file.name)).toEqual(['photo.png', 'readme.md']);
    expect(result.failed).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('hosted_vault_request', expect.objectContaining({
      path: '/api/v1/vaults/vault-1/files',
      body: expect.objectContaining({ name: 'readme.md', documentType: 'note', content: '# Readme' }),
    }));
  });

  it('rejects uploads when the required capability is absent', async () => {
    open.mockResolvedValue('/picked/photo.png');
    const result = await pickAndUploadFiles('https://server.test', vault(['vault.read']), null);
    expect(result.completed).toEqual([]);
    expect(result.failed[0].error).toMatch(/permission/i);
    expect(invoke).not.toHaveBeenCalledWith('hosted_vault_upload_file', expect.anything());
  });

  it('downloads files, folders, and full vault exports through separate native commands', async () => {
    save.mockResolvedValueOnce('/downloads/note.md').mockResolvedValueOnce('/downloads/Folder.zip').mockResolvedValueOnce('/downloads/Vault.zip');
    invoke.mockResolvedValue(undefined);
    const allowed = vault(['vault.read', 'vault.export']);

    await downloadEntry('https://server.test', allowed, rawFile('doc-1', 'note.md', 'document') as never);
    await downloadEntry('https://server.test', allowed, rawFile('folder-1', 'Folder', 'folder') as never);
    await downloadEntireVault('https://server.test', allowed);

    expect(invoke).toHaveBeenCalledWith('hosted_vault_download_entry', expect.objectContaining({ fileId: 'doc-1', archive: false }));
    expect(invoke).toHaveBeenCalledWith('hosted_vault_download_entry', expect.objectContaining({ fileId: 'folder-1', archive: true }));
    expect(invoke).toHaveBeenCalledWith('hosted_vault_export_zip', expect.objectContaining({ vaultId: 'vault-1' }));
  });

  it('normalizes note names', () => {
    expect(normalizedNoteName('Meeting')).toBe('Meeting.md');
    expect(normalizedNoteName('Meeting.md')).toBe('Meeting.md');
    expect(() => normalizedNoteName(' ')).toThrow(/name/);
  });
});
