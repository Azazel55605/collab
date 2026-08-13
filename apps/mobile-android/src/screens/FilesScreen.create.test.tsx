import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

import { loadPrefs } from '../lib/theme';
import type { HostedFileEntry, HostedVault } from '../mobileTauri';
import { useMobileStore } from '../state/store';
import { FilesScreen } from './FilesScreen';

const SERVER = 'https://server.test';

const vault: HostedVault = {
  id: 'vault-1',
  name: 'Vault',
  role: 'editor',
  status: 'active',
  members: 1,
  storageBytes: 10,
  manifestSequence: 3,
  updatedAt: null,
  capabilities: ['vault.read', 'file.create', 'file.write'],
};

/** Records every document the screen asks the server to create. */
interface Created {
  name: string;
  documentType: string;
  content: string;
}

function mockServer(created: Created[], capabilities = vault.capabilities) {
  useMobileStore.setState({
    selected: { serverUrl: SERVER, vault: { ...vault, capabilities } },
    statuses: {
      [SERVER]: {
        connected: true,
        serverUrl: SERVER,
        allowInvalidCertificates: false,
        user: null,
        accessExpiresAt: null,
      },
    },
    files: [],
    folderTrail: [{ id: null, name: 'Root' }],
    activeSheet: null,
    replicas: {},
  } as never);

  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === 'hosted_vault_request') {
      const path = String(args?.path ?? '');
      const method = String(args?.method ?? 'GET');
      if (method === 'POST' && path.endsWith('/files')) {
        const body = args?.body as Created & { parentId: string | null };
        created.push({
          name: body.name,
          documentType: body.documentType,
          content: body.content,
        });
        const entry: HostedFileEntry = {
          id: `new-${created.length}`,
          parentId: null,
          name: body.name,
          relativePath: body.name,
          kind: 'document',
          documentType: body.documentType as HostedFileEntry['documentType'],
          state: 'active',
          updatedAt: null,
          sizeBytes: body.content.length,
          contentHash: 'hash',
          revisionSequence: 1,
        };
        return Promise.resolve(entry);
      }
      // Manifest reload after creating.
      return Promise.resolve({ vaultId: vault.id, sequence: 4, files: [] });
    }
    if (command.startsWith('replica_')) return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

/** Opens the create picker and chooses a type. */
async function chooseType(label: string) {
  fireEvent.click(screen.getByLabelText('Create'));
  const picker = await screen.findByRole('dialog', { name: 'Create' });
  fireEvent.click(within(picker).getByText(label));
}

beforeEach(() => {
  invoke.mockReset();
});

afterEach(() => {
  useMobileStore.setState({ activeSheet: null } as never);
});

describe('FilesScreen creation', () => {
  it('offers every document type the app can fully edit', async () => {
    mockServer([]);
    render(<FilesScreen prefs={loadPrefs()} />);

    fireEvent.click(screen.getByLabelText('Create'));
    const picker = await screen.findByRole('dialog', { name: 'Create' });

    for (const label of ['Note', 'Board', 'Spreadsheet', 'Drawing']) {
      expect(within(picker).getByText(label)).toBeTruthy();
    }
    // Types with no editable mobile screen are deliberately absent.
    expect(within(picker).queryByText('Canvas')).toBeNull();
    expect(within(picker).queryByText('Logic diagram')).toBeNull();
  });

  it.each([
    ['Note', 'Plan', 'Plan.md', 'note'],
    ['Board', 'Roadmap', 'Roadmap.kanban', 'kanban'],
    ['Spreadsheet', 'Budget', 'Budget.sheet', 'sheet'],
    ['Drawing', 'Ideas', 'Ideas.ink', 'ink'],
  ])('creates a %s with the right extension and document type', async (
    label, typed, expectedName, expectedType,
  ) => {
    const created: Created[] = [];
    mockServer(created);
    render(<FilesScreen prefs={loadPrefs()} />);

    await chooseType(label);
    const form = await screen.findByRole('dialog', { name: new RegExp(`Create ${label}`, 'i') })
      .catch(() => screen.getByLabelText(`Create ${label.toLowerCase()}`));
    fireEvent.change(within(form as HTMLElement).getByLabelText('Name'), {
      target: { value: typed },
    });
    fireEvent.submit(form as HTMLElement);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].name).toBe(expectedName);
    expect(created[0].documentType).toBe(expectedType);
  });

  it('gives each new document content its own editor can open', async () => {
    const created: Created[] = [];
    mockServer(created);
    render(<FilesScreen prefs={loadPrefs()} />);

    await chooseType('Drawing');
    const form = screen.getByLabelText('Create drawing');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Ideas' } });
    fireEvent.submit(form);

    await waitFor(() => expect(created).toHaveLength(1));
    const document = JSON.parse(created[0].content);
    expect(document.kind).toBe('collab-ink');
    expect(document.pageOrder).toHaveLength(1);
  });

  it('opens the new document in its own editor', async () => {
    const created: Created[] = [];
    mockServer(created);
    render(<FilesScreen prefs={loadPrefs()} />);

    await chooseType('Spreadsheet');
    const form = screen.getByLabelText('Create spreadsheet');
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Budget' } });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(useMobileStore.getState().activeSheet?.kind).toBe('workbook'),
    );
  });

  it('hides creation entirely without the capability', () => {
    mockServer([], ['vault.read']);
    render(<FilesScreen prefs={loadPrefs()} />);
    expect(screen.queryByLabelText('Create')).toBeNull();
  });
});
