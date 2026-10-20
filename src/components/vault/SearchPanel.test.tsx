import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';

import SearchPanel from './SearchPanel';

const mocks = vi.hoisted(() => ({ search: vi.fn(), page: vi.fn() }));
vi.mock('../../lib/vaultClient', () => ({
  createVaultClient: () => ({
    search: mocks.search,
    searchPage: mocks.page.getMockImplementation() ? mocks.page : undefined,
  }),
}));
afterEach(() => {
  cleanup();
  mocks.page.mockReset();
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

it('keeps rendering bounded and reaches later pages, clearing on server switch', async () => {
  vi.useFakeTimers();
  const hosted = (serverUrl: string) => ({
    id: 'same',
    hostedVaultId: 'same',
    kind: 'hosted' as const,
    role: 'editor' as const,
    serverUrl,
    path: 'hosted://same',
    name: 'Hosted',
    isEncrypted: false,
    lastOpened: 1,
  });
  useVaultStore.setState({ vault: hosted('https://a'), isVaultLocked: false });
  useNoteIndexStore.setState({ notes: [] });
  mocks.page.mockImplementation(async (_query: string, offset: number) => ({
    results: Array.from({ length: 50 }, (_, i) => ({
      relativePath: `${offset + i}.md`,
      title: `Result ${offset + i}`,
      excerpt: 'text',
      score: 10,
      matchType: 'content',
    })),
    total: 120,
    nextOffset: offset + 50 < 120 ? offset + 50 : null,
  }));
  render(<SearchPanel />);
  fireEvent.change(screen.getByPlaceholderText('Search notes...'), { target: { value: 'needle' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getAllByText(/^Result /)).toHaveLength(50);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getByText('Result 50')).toBeTruthy();
  expect(screen.queryByText('Result 0')).toBeNull();
  act(() => useVaultStore.setState({ vault: hosted('https://b') }));
  expect(screen.queryByText('Result 50')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(mocks.page).toHaveBeenLastCalledWith('needle', 0, 50);
});
