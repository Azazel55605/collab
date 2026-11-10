import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { tauriCommands } from '../../lib/tauri';

import MetadataExplorer from './MetadataExplorer';

vi.mock('../../lib/tauri', () => ({ tauriCommands: { databaseMetadata: vi.fn() } }));
it('replaces each bounded page and uses the typed cursor; permission errors clear old rows', async () => {
  vi.mocked(tauriCommands.databaseMetadata)
    .mockResolvedValueOnce({
      items: [{ id: 'db-one', name: 'Database one', kind: 'database', detail: '' }],
      next: 'db-one',
    })
    .mockResolvedValueOnce({
      items: [{ id: 'db-two', name: 'Database two', kind: 'database', detail: '' }],
      next: null,
    })
    .mockRejectedValueOnce('permission_denied');
  const open = vi.fn();
  render(<MetadataExplorer token="token" connectionId="c" binding={null} onOpen={open} />);
  await screen.findByText('Database one');
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Database two');
  expect(screen.queryByText('Database one')).toBeNull();
  expect(tauriCommands.databaseMetadata).toHaveBeenLastCalledWith('token', 'c', null, {
    kind: 'databases',
    after: 'db-one',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
  expect(open).toHaveBeenCalledWith('Database two');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh metadata' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('permission'));
  expect(screen.queryByText('Database two')).toBeNull();
});
