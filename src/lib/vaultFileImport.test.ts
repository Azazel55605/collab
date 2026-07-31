import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fileBaseName,
  importCategoryForName,
  isImportableFile,
  importExternalFilesIntoVault,
} from './vaultFileImport';
import { tauriCommands } from './tauri';
import type { VaultClient } from './vaultClient';
import { useSyncTransferStore } from '../store/syncTransferStore';

vi.mock('./tauri', () => ({
  tauriCommands: {
    readFileForUpload: vi.fn(),
    sheetConvertImport: vi.fn(),
  },
}));

function makeClient(overrides: Partial<VaultClient> & { importMock?: ReturnType<typeof vi.fn> } = {}) {
  const importMock = overrides.importMock ?? vi.fn(async (_p: string, folder?: string) => `${folder ? folder + '/' : ''}asset.png`);
  const client = {
    runtime: { externalAssetImport: { import: importMock, importData: vi.fn() } },
    createDocument: vi.fn(async () => ({ relativePath: 'x', name: 'x', extension: 'md', modifiedAt: 0, size: 0, isFolder: false })),
    readDocument: vi.fn(async (path: string) => ({ relativePath: path, content: '', version: 'v0', modifiedAt: 0 })),
    writeDocument: vi.fn(async () => ({ version: 'v1' })),
    ...overrides,
  } as unknown as VaultClient & { createDocument: ReturnType<typeof vi.fn>; readDocument: ReturnType<typeof vi.fn>; writeDocument: ReturnType<typeof vi.fn> };
  return { client, importMock };
}

describe('vaultFileImport categorization', () => {
  it('classifies importable extensions', () => {
    expect(importCategoryForName('photo.PNG')).toBe('image');
    expect(importCategoryForName('icon.svg')).toBe('svg');
    expect(importCategoryForName('scan.pdf')).toBe('pdf');
    expect(importCategoryForName('notes.md')).toBe('markdown');
    expect(importCategoryForName('readme.markdown')).toBe('markdown');
    expect(importCategoryForName('diagram.canvas')).toBe('canvas');
    expect(importCategoryForName('tasks.kanban')).toBe('kanban');
    expect(importCategoryForName('adder.logic')).toBe('logic');
    expect(importCategoryForName('budget.sheet')).toBe('sheet');
    // `.xlsx`/`.csv` are converted into a new `.sheet`, never stored as-is.
    expect(importCategoryForName('budget.xlsx')).toBe('workbookConversion');
    expect(importCategoryForName('budget.XLSM')).toBe('workbookConversion');
    expect(importCategoryForName('data.csv')).toBe('workbookConversion');
    expect(importCategoryForName('data.tsv')).toBe('workbookConversion');
    expect(importCategoryForName('archive.zip')).toBeNull();
    expect(importCategoryForName('noext')).toBeNull();
  });

  it('exposes isImportableFile and fileBaseName helpers', () => {
    expect(isImportableFile('a.jpg')).toBe(true);
    expect(isImportableFile('a.exe')).toBe(false);
    expect(fileBaseName('/home/u/Pictures/cat.png')).toBe('cat.png');
    expect(fileBaseName('C:\\docs\\report.pdf')).toBe('report.pdf');
  });
});

describe('importExternalFilesIntoVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncTransferStore.getState().reset();
  });

  it('converts an .xlsx into a new .sheet document and reports what changed', async () => {
    const report = {
      notes: [
        { severity: 'skipped' as const, feature: 'Charts', detail: 'Not imported.', count: 1 },
      ],
      truncated: false,
    };
    vi.mocked(tauriCommands.sheetConvertImport).mockResolvedValue({
      document: '{"kind":"collab-sheet"}',
      suggestedName: 'Budget',
      report,
    });
    const { client } = makeClient();

    const result = await importExternalFilesIntoVault(client, ['/tmp/Budget.xlsx']);

    expect(result.imported).toEqual(['Budget.sheet']);
    expect(client.createDocument).toHaveBeenCalledWith('Budget.sheet');
    // The conversion result is written as the document's first real revision.
    expect(client.writeDocument).toHaveBeenCalledWith(
      'Budget.sheet',
      '{"kind":"collab-sheet"}',
      'v0',
      '',
    );
    // The caller must be able to surface the report: no conversion is
    // guaranteed lossless.
    expect(result.conversions).toEqual([
      { relativePath: 'Budget.sheet', sourceName: 'Budget.xlsx', report },
    ]);
  });

  it('never overwrites a workbook that is already in the vault', async () => {
    vi.mocked(tauriCommands.sheetConvertImport).mockResolvedValue({
      document: '{}',
      suggestedName: 'Budget',
      report: { notes: [], truncated: false },
    });
    const { client } = makeClient();

    const result = await importExternalFilesIntoVault(client, ['/tmp/Budget.csv'], {
      existingFiles: [
        { name: 'Budget.sheet', relativePath: 'Budget.sheet', isFolder: false },
      ] as never,
    });

    expect(result.imported).toEqual(['Budget 2.sheet']);
  });

  it('reports a failed conversion without aborting the rest of the import', async () => {
    vi.mocked(tauriCommands.sheetConvertImport).mockRejectedValue('not a workbook');
    const { client, importMock } = makeClient();

    const result = await importExternalFilesIntoVault(client, ['/tmp/bad.xlsx', '/tmp/cat.png']);

    expect(result.failed[0].name).toBe('bad.xlsx');
    expect(importMock).toHaveBeenCalled();
    expect(result.imported).toEqual(['Pictures/asset.png']);
  });

  it('routes images to Pictures and PDFs to the vault root by default', async () => {
    const { client, importMock } = makeClient();
    importMock
      .mockResolvedValueOnce('Pictures/cat.png')
      .mockResolvedValueOnce('report.pdf');

    const result = await importExternalFilesIntoVault(client, ['/x/cat.png', '/x/report.pdf']);

    expect(importMock).toHaveBeenNthCalledWith(1, '/x/cat.png', 'Pictures');
    expect(importMock).toHaveBeenNthCalledWith(2, '/x/report.pdf', '');
    expect(result.imported).toEqual(['Pictures/cat.png', 'report.pdf']);
    expect(result.failed).toEqual([]);
  });

  it('honours an explicit target folder for every type', async () => {
    const { client, importMock } = makeClient();
    importMock.mockResolvedValueOnce('Sub/cat.png');

    await importExternalFilesIntoVault(client, ['/x/cat.png'], { targetFolder: 'Sub' });

    expect(importMock).toHaveBeenCalledWith('/x/cat.png', 'Sub');
  });

  it('imports markdown as a text note (read, create, write)', async () => {
    const { client } = makeClient();
    vi.mocked(tauriCommands.readFileForUpload).mockResolvedValue({
      name: 'notes.md',
      mediaType: 'text/markdown',
      contentBase64: btoa('# Title'),
      expectedHash: 'hash',
    });

    const result = await importExternalFilesIntoVault(client, ['/x/notes.md'], { targetFolder: 'Docs' });

    expect((client as any).createDocument).toHaveBeenCalledWith('Docs/notes.md');
    expect((client as any).writeDocument).toHaveBeenCalledWith('Docs/notes.md', '# Title', 'v0', '');
    expect(result.imported).toEqual(['Docs/notes.md']);
  });

  it.each([
    ['canvas', 'diagram.canvas', '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}'],
    ['kanban', 'tasks.kanban', '{"columns":[]}'],
    ['logic', 'adder.logic', '{"kind":"logic-diagram","nodes":[],"wires":[]}'],
    ['sheet', 'budget.sheet', '{"kind":"collab-sheet","schemaVersion":1,"id":"wb1","name":"Budget","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","worksheets":[{"id":"ws1","name":"Sheet1","rowOrder":["r1"],"columnOrder":["c1"],"cells":{}}],"styles":{}}'],
  ])('imports valid %s files as text documents', async (_category, name, content) => {
    const { client } = makeClient();
    vi.mocked(tauriCommands.readFileForUpload).mockResolvedValue({
      name,
      mediaType: 'application/json',
      contentBase64: btoa(content),
      expectedHash: 'hash',
    });

    const result = await importExternalFilesIntoVault(client, [`/x/${name}`], { targetFolder: 'Recovered' });

    expect((client as any).createDocument).toHaveBeenCalledWith(`Recovered/${name}`);
    expect((client as any).writeDocument).toHaveBeenCalledWith(`Recovered/${name}`, content, 'v0', '');
    expect(result.imported).toEqual([`Recovered/${name}`]);
  });

  it('imports SVG as a text document defaulting to Pictures (not a binary asset)', async () => {
    const { client, importMock } = makeClient();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    vi.mocked(tauriCommands.readFileForUpload).mockResolvedValue({
      name: 'icon.svg',
      mediaType: 'image/svg+xml',
      contentBase64: btoa(svg),
      expectedHash: 'hash',
    });

    const result = await importExternalFilesIntoVault(client, ['/x/icon.svg']);

    expect(importMock).not.toHaveBeenCalled();
    expect((client as any).createDocument).toHaveBeenCalledWith('Pictures/icon.svg');
    expect((client as any).writeDocument).toHaveBeenCalledWith('Pictures/icon.svg', svg, 'v0', '');
    expect(result.imported).toEqual(['Pictures/icon.svg']);
  });

  it.each([
    ['broken.canvas', '{"nodes":[]}'],
    ['broken.kanban', '{"cards":[]}'],
    ['broken.logic', '{"kind":"logic-diagram","nodes":[]}'],
    ['broken.sheet', '{"kind":"collab-sheet"}'],
  ])('rejects structurally invalid Collab documents before creating them', async (name, content) => {
    const { client } = makeClient();
    vi.mocked(tauriCommands.readFileForUpload).mockResolvedValue({
      name,
      mediaType: 'application/json',
      contentBase64: btoa(content),
      expectedHash: 'hash',
    });

    const result = await importExternalFilesIntoVault(client, [`/x/${name}`]);

    expect((client as any).createDocument).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(1);
  });

  it('reports unsupported files without aborting the rest', async () => {
    const { client, importMock } = makeClient();
    importMock.mockResolvedValueOnce('Pictures/ok.png');

    const result = await importExternalFilesIntoVault(client, ['/x/bad.zip', '/x/ok.png']);

    expect(result.imported).toEqual(['Pictures/ok.png']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('bad.zip');
  });

  it('records a per-file error when an import throws', async () => {
    const { client, importMock } = makeClient();
    importMock.mockRejectedValueOnce(new Error('upload failed'));

    const result = await importExternalFilesIntoVault(client, ['/x/cat.png']);

    expect(result.imported).toEqual([]);
    expect(result.failed[0]).toEqual({ name: 'cat.png', error: 'Error: upload failed' });
  });

  it('reports hosted drag-import progress in the sync transfer list', async () => {
    const { client, importMock } = makeClient({ kind: 'hosted', id: 'vault-1', name: 'Team Vault' } as Partial<VaultClient>);
    importMock
      .mockResolvedValueOnce('Pictures/a.png')
      .mockResolvedValueOnce('Pictures/b.png');

    await importExternalFilesIntoVault(client, ['/x/a.png', '/x/b.png']);

    expect(useSyncTransferStore.getState().transfers[0]).toMatchObject({
      vaultId: 'vault-1',
      direction: 'upload',
      completed: 2,
      total: 2,
      label: 'Uploaded 2 files',
      status: 'completed',
    });
  });
});
