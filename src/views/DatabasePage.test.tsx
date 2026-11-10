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
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Server A' }));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Server A · catalog-a' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Server B · Browse databases' })).toBeTruthy();
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
  it('clears entered passwords and displays a safe TLS error without backend details', async () => {
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
