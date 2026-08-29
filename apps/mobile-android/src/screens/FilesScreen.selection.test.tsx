import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPrefs } from '../lib/theme';
import type { HostedFileEntry, HostedVault } from '../mobileTauri';
import { useMobileStore } from '../state/store';

import { FilesScreen } from './FilesScreen';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

const vault: HostedVault = {
  id: 'vault-1',
  name: 'Vault',
  role: 'editor',
  status: 'active',
  members: 1,
  storageBytes: 10,
  manifestSequence: 1,
  updatedAt: null,
  capabilities: ['vault.read'],
};

function file(id: string, name: string): HostedFileEntry {
  return {
    id,
    parentId: null,
    name,
    relativePath: name,
    kind: 'document',
    documentType: 'note',
    state: 'active',
    updatedAt: null,
    sizeBytes: 4,
    contentHash: 'hash',
    revisionSequence: 1,
  };
}

afterEach(() => vi.useRealTimers());

describe('mobile file selection', () => {
  it('enters multi-selection on long press without reserving a row download button', async () => {
    vi.useFakeTimers();
    useMobileStore.setState({
      selected: { serverUrl: 'https://server.test', vault },
      statuses: {
        'https://server.test': {
          connected: true,
          serverUrl: 'https://server.test',
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      },
      files: [file('one', 'one.md'), file('two', 'two.md')],
      filesBusy: false,
      filesError: null,
      filesOffline: false,
      fileCache: {},
      folderTrail: [{ id: null, name: 'Root' }],
      activeSheet: null,
      replicas: {},
    });

    render(<FilesScreen prefs={loadPrefs()} />);
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    const first = screen.getByRole('button', { name: /one\.md/i });
    fireEvent.pointerDown(first, { pointerType: 'touch', clientX: 10, clientY: 10 });
    await act(async () => {
      vi.advanceTimersByTime(450);
    });

    expect(screen.getByText('1 selected')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /two\.md/i }));
    expect(screen.getByText('2 selected')).not.toBeNull();
    expect(screen.queryByLabelText('Download one.md')).toBeNull();
    expect(screen.getByLabelText('Download selected')).not.toBeNull();
  });
});
