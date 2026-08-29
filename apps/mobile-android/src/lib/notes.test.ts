import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedFileEntry } from '../mobileTauri';

import {
  isNoteFile,
  readNoteDocument,
  renderMarkdown,
  renderMarkdownDocument,
  resolveVaultLink,
  saveNoteDocument,
} from './notes';
import { DEFAULT_PREFS } from './theme';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const SERVER = 'https://collab.example.com';
const VAULT = 'v1';

const NOTE: HostedFileEntry = {
  id: 'doc-1',
  parentId: null,
  name: 'Plan.md',
  relativePath: 'Plan.md',
  kind: 'document',
  documentType: 'note',
  state: 'active',
  updatedAt: null,
  sizeBytes: 7,
  contentHash: 'old-hash',
  revisionSequence: 3,
};

const NEXT_FILE = {
  id: 'doc-1',
  parentId: null,
  name: 'Plan.md',
  relativePath: 'Plan.md',
  kind: 'document',
  documentType: 'note',
  state: 'active',
  updatedAt: null,
  currentRevision: { sequence: 4, contentHash: 'new-hash', sizeBytes: 8 },
};

describe('mobile note helpers', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('identifies markdown note documents', () => {
    expect(isNoteFile(NOTE)).toBe(true);
    expect(isNoteFile({ ...NOTE, documentType: null, name: 'readme.markdown' })).toBe(true);
    expect(isNoteFile({ ...NOTE, kind: 'asset', name: 'Plan.md' })).toBe(false);
  });

  it('reads online and warms the replica document cache', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'hosted_vault_request') {
        return Promise.resolve({ file: NEXT_FILE, content: '# Online' });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const document = await readNoteDocument(SERVER, VAULT, NOTE, true);

    expect(document.content).toBe('# Online');
    expect(document.source).toBe('network');
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'doc-1', content: '# Online' }),
    );
  });

  it('reads cached content when offline', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'replica_read_cached_document') return Promise.resolve('# Cached');
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const document = await readNoteDocument(SERVER, VAULT, NOTE, false);

    expect(document.content).toBe('# Cached');
    expect(document.source).toBe('cache');
    expect(invoke).not.toHaveBeenCalledWith('hosted_vault_request', expect.anything());
  });

  it('saves with the current revision sequence and caches the saved content', async () => {
    invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
      if (command === 'hosted_vault_request') {
        expect(args.body).toEqual({ expectedRevisionSequence: 3, content: '# Edited' });
        return Promise.resolve({ file: NEXT_FILE, content: '# Edited' });
      }
      if (command === 'replica_cache_document') return Promise.resolve(null);
      return Promise.reject(new Error(`unhandled ${command}`));
    });

    const document = await saveNoteDocument(SERVER, VAULT, NOTE, '# Edited');

    expect(document.file.revisionSequence).toBe(4);
    expect(invoke).toHaveBeenCalledWith(
      'replica_cache_document',
      expect.objectContaining({ fileId: 'doc-1', content: '# Edited' }),
    );
  });

  it('renders markdown without allowing raw HTML through', () => {
    const html = renderMarkdown('# Title\n\n<script>alert(1)</script>\n\n**bold**');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
  });

  it('renders mobile preview markdown extensions', () => {
    const rendered = renderMarkdownDocument(
      [
        'one',
        'two',
        '',
        '$x^2$',
        '',
        '==marked==',
        '',
        '- [x] done',
        '',
        '[[Folder/Other|Other note]]',
        '',
        '$$',
        'y=x^2',
        '%plot2d x=-2..2',
        '$$',
      ].join('\n'),
    );

    expect(rendered.html).toContain('one<br');
    expect(rendered.html).toContain('class="katex"');
    expect(rendered.html).toContain('<mark>marked</mark>');
    expect(rendered.html).toContain('type="checkbox"');
    expect(rendered.html).toContain('checked');
    expect(rendered.html).toContain('class="wikilink"');
    expect(rendered.plotBlocks).toHaveLength(1);
    expect(rendered.plotBlocks[0].plots[0]).toMatchObject({ kind: '2d' });
  });

  it('preserves Mermaid fences for the shared asynchronous renderer', () => {
    const rendered = renderMarkdownDocument(
      [
        '```mermaid title="Widget sync"',
        'flowchart LR',
        'S["Foreground sync"] --> P["Snapshot"]',
        '```',
      ].join('\n'),
    );

    expect(rendered.html).toContain('class="md-mermaid-source"');
    expect(rendered.html).toContain('class="language-mermaid"');
    expect(rendered.html).toContain('flowchart LR');
    expect(rendered.html).toContain('S["Foreground sync"] --&gt; P["Snapshot"]');
  });

  it('resolves vault-relative links from the current note path', () => {
    const files: HostedFileEntry[] = [
      NOTE,
      {
        ...NOTE,
        id: 'doc-2',
        name: 'Other.md',
        relativePath: 'Folder/Other.md',
      },
      {
        ...NOTE,
        id: 'asset-1',
        name: 'Image.png',
        relativePath: 'Folder/Pictures/Image.png',
        kind: 'asset',
        documentType: null,
      },
    ];

    expect(resolveVaultLink(files, 'Folder/Plan.md', 'Other')).toMatchObject({ id: 'doc-2' });
    expect(resolveVaultLink(files, 'Folder/Plan.md', 'Pictures/Image.png')).toMatchObject({
      id: 'asset-1',
    });
    expect(resolveVaultLink(files, 'Folder/Plan.md', 'https://example.com')).toBeNull();
  });

  it('applies mobile color preview preferences to rendered notes', () => {
    const enabled = renderMarkdownDocument('Accent #a78bfa', DEFAULT_PREFS);
    expect(enabled.html).toContain('mobile-color-preview');
    expect(enabled.html).toContain('--preview-color');

    const disabled = renderMarkdownDocument('Accent #a78bfa', {
      ...DEFAULT_PREFS,
      showInlineColorPreviews: false,
    });
    expect(disabled.html).not.toContain('mobile-color-preview');
  });
});
