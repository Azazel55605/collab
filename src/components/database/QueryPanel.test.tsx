import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { ensureQuery, updateQuery, useDatabaseQueries } from '../../lib/database/queryStore';
import { tauriCommands } from '../../lib/tauri';
import { createVaultClient } from '../../lib/vaultClient';
import { useVaultStore } from '../../store/vaultStore';
import type { DatabaseBinding } from '../../types/database';
import { Textarea } from '../ui/textarea';

import QueryPanel from './QueryPanel';

vi.mock('./SqlEditor', () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly: boolean;
  }) => (
    <Textarea
      aria-label="SQL editor"
      value={value}
      disabled={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    databaseQueryStatus: vi.fn(),
    databaseQueryStart: vi.fn(),
    databaseQueryPoll: vi.fn(),
    databaseQueryCancel: vi.fn(),
    databaseQueryHistory: vi.fn(),
    databaseMetadata: vi.fn(),
    databaseQueryExport: vi.fn(),
  },
}));
vi.mock('../../lib/vaultClient', () => ({ createVaultClient: vi.fn() }));
const binding: DatabaseBinding = {
  profile_id: 'p',
  connection_id: 'c',
  session_id: 's',
  tab_id: 'panel',
  database: 'db',
  generation: 1,
};
beforeEach(() => {
  useDatabaseQueries.setState({ tabs: {} });
  useVaultStore.setState({ vault: null, isVaultLocked: false });
  ensureQuery(binding);
  vi.mocked(tauriCommands.databaseQueryStatus).mockResolvedValue({
    query_id: null,
    phase: 'idle',
    transaction: 'none',
    reason: null,
  });
});
it('loads history text without executing it and requires an explicit run', async () => {
  vi.mocked(tauriCommands.databaseQueryHistory).mockResolvedValue([
    { sql: 'SELECT 123456789', executed_at: '2026-11-10' },
  ]);
  render(<QueryPanel token="token" binding={binding} />);
  fireEvent.click(screen.getByRole('button', { name: 'Session history' }));
  fireEvent.click(await screen.findByRole('button', { name: /SELECT 123456789/ }));
  expect((screen.getByLabelText('SQL editor') as HTMLTextAreaElement).value).toBe(
    'SELECT 123456789',
  );
  expect(tauriCommands.databaseQueryStart).not.toHaveBeenCalled();
  expect(useDatabaseQueries.getState().tabs.panel.dirty).toBe(true);
});
it('keeps the SQL draft and expected version when a saved script conflicts', async () => {
  const read = vi.fn().mockResolvedValue({ content: 'SELECT 1', version: 'v1' });
  const write = vi.fn().mockResolvedValue({ version: 'v2', conflict: {} });
  vi.mocked(createVaultClient).mockReturnValue({
    id: 'vault',
    readDocument: read,
    writeDocument: write,
  } as unknown as ReturnType<typeof createVaultClient>);
  useVaultStore.setState({
    vault: { id: 'vault', name: 'Vault', path: '/vault', isEncrypted: false, lastOpened: 0 },
  });
  render(<QueryPanel token="token" binding={binding} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open .sql' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open script' }));
  await waitFor(() =>
    expect((screen.getByLabelText('SQL editor') as HTMLTextAreaElement).value).toBe('SELECT 1'),
  );
  fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save .sql' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith('query.sql', 'SELECT 2', 'v1', 'SELECT 1'),
  );
  expect(useDatabaseQueries.getState().tabs.panel.sql).toBe('SELECT 2');
  expect(useDatabaseQueries.getState().tabs.panel.dirty).toBe(true);
  expect(tauriCommands.databaseQueryStart).not.toHaveBeenCalled();
});
it('freezes the executed source while receiving results and preserves context when remounted', async () => {
  render(<QueryPanel token="token" binding={binding} />);
  await act(async () =>
    updateQuery('panel', (tab) => ({
      ...tab,
      sql: 'SELECT 1',
      receiving: true,
      status: { ...tab.status, phase: 'running', query_id: 'q' },
    })),
  );
  expect((screen.getByLabelText('SQL editor') as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it('creates a new script instead of reusing a version from a copied vault with the same id', async () => {
  const read = vi.fn().mockResolvedValue({ content: 'SELECT 1', version: 'v1' });
  const write = vi.fn();
  const createDocument = vi.fn().mockRejectedValue('file_exists');
  vi.mocked(createVaultClient).mockReturnValue({
    id: 'vault',
    readDocument: read,
    writeDocument: write,
    createDocument,
  } as unknown as ReturnType<typeof createVaultClient>);
  const vault = {
    id: 'vault',
    name: 'Vault',
    path: '/original',
    isEncrypted: false,
    lastOpened: 0,
  };
  useVaultStore.setState({ vault });
  render(<QueryPanel token="token" binding={binding} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open .sql' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open script' }));
  await waitFor(() => expect(useDatabaseQueries.getState().tabs.panel.script?.version).toBe('v1'));
  act(() => useVaultStore.setState({ vault: { ...vault, path: '/copy' } }));
  fireEvent.change(screen.getByLabelText('SQL editor'), { target: { value: 'SELECT 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save .sql' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
  await waitFor(() => expect(createDocument).toHaveBeenCalledWith('query.sql'));
  expect(write).not.toHaveBeenCalled();
  expect(useDatabaseQueries.getState().tabs.panel.dirty).toBe(true);
});
