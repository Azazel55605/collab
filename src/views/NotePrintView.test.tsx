import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_NOTE_PAGE_SETTINGS } from '../lib/notePageLayout';
import { useNotePageStore } from '../store/notePageStore';
import { useVaultStore } from '../store/vaultStore';

import NotePrintView from './NotePrintView';

const client = vi.hoisted(() => ({ readDocument: vi.fn(), readAssetDataUrl: vi.fn() }));
vi.mock('../lib/vaultClient', () => ({ createVaultClient: () => client }));
vi.mock('../components/editor/NotePageControls', () => ({
  NotePageControls: () => <div>Page layout</div>,
}));
vi.mock('../components/editor/PaginatedNotePreview', () => ({
  PaginatedNotePreview: ({
    content,
    onReady,
  }: {
    content: string;
    onReady: (pages: number) => void;
  }) => (
    <div>
      <span>{content}</span>
      <button onClick={() => onReady(3)}>Finish pagination</button>
    </div>
  ),
}));

beforeEach(() => {
  useVaultStore.setState({
    vault: { id: 'test-vault', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 0 },
  });
  useNotePageStore.setState({ settings: DEFAULT_NOTE_PAGE_SETTINGS });
  client.readDocument.mockResolvedValue({ content: 'Saved note' });
  vi.spyOn(window, 'print').mockImplementation(() => {});
});

it('waits for pagination and prints only after an explicit request', async () => {
  render(<NotePrintView relativePath="Note.md" />);
  await screen.findByText('Saved note');
  const print = screen.getByRole('button', { name: 'Print / Save PDF' }) as HTMLButtonElement;
  expect(print.disabled).toBe(true);
  expect(window.print).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Finish pagination'));
  expect(screen.getByRole('status').textContent).toBe('3 pages');
  fireEvent.click(print);
  await waitFor(() => expect(window.print).toHaveBeenCalledOnce());
});

it('renders the current unsaved snapshot without reloading an older stored note', async () => {
  render(<NotePrintView relativePath="Note.md" contentSnapshot="Fresh unsaved edit" />);
  await screen.findByText('Fresh unsaved edit');
  expect(client.readDocument).not.toHaveBeenCalled();
});
