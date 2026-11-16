import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../components/ui/tooltip';
import { tauriCommands } from '../lib/tauri';
import { useCollabStore } from '../store/collabStore';
import type { DatabaseBinding, DatabaseWorkspace } from '../types/database';

import DatabasePage from './DatabasePage';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    databaseActivate: vi.fn(),
    databaseSave: vi.fn(),
    databaseConnect: vi.fn(),
    databaseDisconnect: vi.fn(),
    databaseOpenTab: vi.fn(),
    databaseCloseTab: vi.fn(),
    databaseMetadata: vi.fn(),
    databaseSqlitePick: vi.fn(),
    databaseRemove: vi.fn(),
  },
}));
vi.mock('../components/database/QueryPanel', () => ({
  default: () => <div>SQL query editor</div>,
}));
let workspace: DatabaseWorkspace;
const binding: DatabaseBinding = {
  profile_id: 'profile-a',
  connection_id: 'a',
  session_id: 'session-a',
  tab_id: 'tab-a',
  database: 'catalog-a',
  generation: 1,
};
function renderPage() {
  return render(
    <TooltipProvider>
      <DatabasePage />
    </TooltipProvider>,
  );
}
beforeEach(() => {
  useCollabStore.setState({ myUserId: 'profile-a' });
  workspace = {
    token: 'workspace-a',
    profiles: [
      {
        id: 'saved-a',
        label: 'Server A',
        environment: 'Development',
        host: 'a.example',
        port: 1433,
        database: 'master',
        username: 'reader',
        remember_password: false,
        certificate_hostname: null,
      },
      {
        id: 'saved-b',
        label: 'Server B',
        environment: 'Production',
        host: 'b.example',
        port: 1433,
        database: 'master',
        username: 'reader',
        remember_password: false,
        certificate_hostname: null,
      },
    ],
    connections: [
      {
        id: 'a',
        saved_id: 'saved-a',
        label: 'Server A',
        environment: 'Development',
        database: 'master',
      },
      {
        id: 'b',
        saved_id: 'saved-b',
        label: 'Server B',
        environment: 'Production',
        database: 'master',
      },
    ],
    tabs: [binding],
    durable_credentials: true,
  };
  vi.mocked(tauriCommands.databaseActivate).mockImplementation(async () =>
    structuredClone(workspace),
  );
  vi.mocked(tauriCommands.databaseMetadata).mockResolvedValue({ items: [], next: null });
});
describe('database workspace', () => {
  it('opens a native SQLite selection read-only and browses metadata with its binding', async () => {
    const sqliteBinding = {
      ...binding,
      connection_id: 'file',
      tab_id: 'sqlite-tab',
      database: 'main',
    };
    const file = { binding: sqliteBinding, label: 'inventory.sqlite', read_only: true };
    vi.mocked(tauriCommands.databaseSqlitePick).mockImplementationOnce(async () => {
      workspace.tabs.push(sqliteBinding);
      workspace.sqlite_files = [file];
      return file;
    });
    renderPage();
    const menu = await screen.findByRole('button', { name: 'Open SQLite file' });
    await waitFor(() => expect((menu as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(menu, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open SQLite read-only…' }));
    expect((await screen.findByRole('tab', { name: file.label })).getAttribute('data-state')).toBe(
      'active',
    );
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(tauriCommands.databaseSqlitePick).toHaveBeenCalledWith('workspace-a', 'read_only');
    fireEvent.click(screen.getByRole('button', { name: 'Browse metadata' }));
    await waitFor(() =>
      expect(tauriCommands.databaseMetadata).toHaveBeenCalledWith(
        'workspace-a',
        'file',
        sqliteBinding,
        { kind: 'schemas', after: 0 },
      ),
    );
  });

  it('browses a different server catalog without replacing or retargeting the query editor', async () => {
    vi.mocked(tauriCommands.databaseMetadata).mockImplementation(
      async (_token, _connection, _binding, request) => {
        const items = {
          databases: [{ id: 'other', name: 'catalog-b', kind: 'database', detail: '' }],
          schemas: [{ id: '1', name: 'dbo', kind: 'schema', detail: '' }],
          objects: [{ id: '5', name: 'Customers', kind: 'USER_TABLE', detail: '' }],
        };
        return {
          items: request.kind in items ? items[request.kind as keyof typeof items] : [],
          next: null,
        };
      },
    );
    renderPage();
    const tab = await screen.findByRole('tab', { name: 'Server A · catalog-a' });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('button', { name: 'catalog-b' }));
    fireEvent.click(await screen.findByRole('button', { name: 'dbo' }));
    expect(await screen.findByRole('button', { name: 'Customers' })).toBeTruthy();
    expect(screen.getByText('SQL query editor')).toBeTruthy();
    expect(tab.getAttribute('data-state')).toBe('active');
    expect(tauriCommands.databaseOpenTab).not.toHaveBeenCalled();
    expect(tauriCommands.databaseMetadata).toHaveBeenCalledWith(
      'workspace-a',
      'a',
      null,
      { kind: 'objects', schema_id: 1, after: 0 },
      'catalog-b',
    );
  });

  it('refreshes expanded branches across pages, using fresh cursors and dropping deleted objects', async () => {
    let refreshed = false;
    const item = (id: string, name: string, kind = '') => ({ id, name, kind, detail: '' });
    vi.mocked(tauriCommands.databaseMetadata).mockImplementation(
      async (_token, _connection, _binding, request) => {
        switch (request.kind) {
          case 'databases':
            return request.after
              ? { items: [item('catalog-b', 'catalog-b')], next: null }
              : {
                  items: [item('catalog-a', 'catalog-a')],
                  next: refreshed ? 'new-cursor' : 'old-cursor',
                };
          case 'schemas':
            return { items: [item('1', 'dbo')], next: null };
          case 'objects':
            return {
              items: refreshed
                ? [item('5', 'Customers', 'USER_TABLE')]
                : [item('5', 'Customers', 'USER_TABLE'), item('6', 'Deleted table')],
              next: null,
            };
          case 'columns':
            return { items: [item('7', refreshed ? 'New column' : 'Old column')], next: null };
          default:
            return { items: [], next: null };
        }
      },
    );
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Server A · catalog-a' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more databases' }));
    fireEvent.click(await screen.findByRole('button', { name: 'catalog-b' }));
    fireEvent.click(await screen.findByRole('button', { name: 'dbo' }));
    const table = await screen.findByRole('button', { name: 'Customers' });
    fireEvent.click(table);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(await screen.findByText('Old column')).toBeTruthy();

    refreshed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh server objects' }));
    expect(table.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('New column')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Customers' })).toBe(table);
    expect(screen.queryByRole('button', { name: 'Deleted table' })).toBeNull();
    expect(tauriCommands.databaseMetadata).toHaveBeenCalledWith('workspace-a', 'a', null, {
      kind: 'databases',
      after: 'new-cursor',
    });
  });

  it('pins an existing tab across sidebar selection and retires only an explicitly disconnected connection', async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Server A · catalog-a' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse metadata' }));
    await waitFor(() =>
      expect(tauriCommands.databaseMetadata).toHaveBeenCalledWith('workspace-a', 'a', binding, {
        kind: 'schemas',
        after: 0,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Server A' }));
    expect(screen.getByText('Server A · catalog-a · Development')).toBeTruthy();
    vi.mocked(tauriCommands.databaseDisconnect).mockImplementation(async () => {
      workspace.connections = workspace.connections.filter((c) => c.id !== 'a');
      workspace.tabs = [];
    });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More database actions' }), {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect Server A' }));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Server A · catalog-a' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Server B' })).toBeTruthy();
  });
  it('does not leak a late response into another profile workspace', async () => {
    let resolve!: (value: DatabaseWorkspace) => void;
    vi.mocked(tauriCommands.databaseActivate).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderPage();
    act(() => useCollabStore.setState({ myUserId: 'profile-b' }));
    await screen.findByRole('button', { name: 'Server A' });
    const old = {
      ...workspace,
      profiles: [{ ...workspace.profiles[0], label: 'OLD SECRET PROFILE' }],
    };
    await act(async () => resolve(old));
    expect(screen.queryByText('OLD SECRET PROFILE')).toBeNull();
  });
  it('uses one connection row and hides authentication controls after connecting', async () => {
    const server = workspace.connections.shift()!;
    workspace.tabs = [];
    vi.mocked(tauriCommands.databaseConnect).mockImplementationOnce(async () => {
      workspace.connections.push(server);
      return server;
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Server A' }));
    const password = screen.getByLabelText('Password for this connection');
    fireEvent.change(password, { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const tree = await screen.findByRole('region', { name: 'Server objects' });
    expect(screen.queryByLabelText('Password for this connection')).toBeNull();
    const list = screen.getByRole('region', { name: 'Connections' });
    expect(list.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Server A' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Server A' }));
    expect(screen.queryByLabelText('Password for this connection')).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage Server A' })).toBeTruthy();
  });

  it('clears entered passwords and displays a safe TLS error without backend details', async () => {
    workspace.connections = workspace.connections.filter((connection) => connection.id !== 'a');
    workspace.tabs = [];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Server A' }));
    fireEvent.change(screen.getByLabelText('Password for this connection'), {
      target: { value: 'fixture-password' },
    });
    vi.mocked(tauriCommands.databaseConnect).mockRejectedValueOnce('tls_rejected');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'certificate could not be verified',
    );
    expect((screen.getByLabelText('Password for this connection') as HTMLInputElement).value).toBe(
      '',
    );
    expect(tauriCommands.databaseConnect).toHaveBeenCalledWith(
      'workspace-a',
      'saved-a',
      'fixture-password',
      false,
    );
  });
});

it('uses Ctrl+W to request explicit SQL session discard', async () => {
  renderPage();
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Server A · catalog-a' }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
  expect(await screen.findByRole('dialog', { name: 'Close database session?' })).toBeTruthy();
  expect(tauriCommands.databaseCloseTab).not.toHaveBeenCalled();
});
