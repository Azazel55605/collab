import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { useVaultStore } from '../../store/vaultStore';

import SearchPanel from './SearchPanel';

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../../lib/vaultClient', () => ({ createVaultClient: () => ({ search: mocks.search }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps newer results when an older search finishes late, including clearing the query', async () => {
  vi.useFakeTimers();
  useVaultStore.setState({
    vault: { id: 'v', name: 'v', kind: 'local', path: '/vault', isEncrypted: false, lastOpened: 1 },
  });
  const replies: Array<(rows: unknown[]) => void> = [];
  mocks.search.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  render(<SearchPanel />);
  const input = screen.getByPlaceholderText('Search notes...');
  fireEvent.change(input, { target: { value: 'older' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  fireEvent.change(input, { target: { value: 'newer' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  await act(async () => {
    replies[1]([{ relativePath: 'new.md', title: 'New result', excerpt: 'new' }]);
  });
  await act(async () => {
    replies[0]([{ relativePath: 'old.md', title: 'Old result', excerpt: 'old' }]);
  });
  expect(screen.getByText('New result')).toBeTruthy();
  expect(screen.queryByText('Old result')).toBeNull();
  fireEvent.change(input, { target: { value: 'third' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  fireEvent.change(input, { target: { value: '' } });
  await act(async () => {
    replies[2]([{ relativePath: 'old.md', title: 'Old result', excerpt: 'old' }]);
  });
  expect(screen.queryByText('Old result')).toBeNull();
});
