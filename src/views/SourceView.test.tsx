import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useDocumentStatusStore } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import { useVaultStore } from '../store/vaultStore';

import SourceView from './SourceView';

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  snapshot: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../lib/collabIdentity', () => ({
  useCollabIdentity: () => ({ userId: 'a', userName: 'A' }),
}));
vi.mock('../lib/vaultClient', () => ({
  createVaultClient: () => ({
    kind: 'local',
    readSourceFile: fixture.read,
    writeSourceFile: fixture.write,
    createSnapshot: fixture.snapshot,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
  useEditorStore.getState().setPendingSearchJump(null);
  useVaultStore.setState({
    vault: { id: 'v', name: 'Vault', path: '/vault', lastOpened: 0, isEncrypted: false },
  });
});

afterEach(cleanup);

it('saves raw BOM and CRLF bytes against the original revision and keeps a conflicting draft', async () => {
  fixture.read.mockResolvedValue({
    content: '\uFEFFfirst\r\nlast',
    version: 'v1',
    preview: null,
    reason: null,
  });
  fixture.write.mockResolvedValue({
    version: 'v1',
    conflict: { content: 'external\n', version: 'v2' },
  });
  const { container } = render(<SourceView relativePath="test.py" />);
  await screen.findByText('CRLF');
  const editor = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
  expect(editor.state.doc.toString()).toBe('first\nlast');

  act(() => editor.dispatch({ changes: { from: 0, to: 5, insert: 'edited' } }));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() =>
    expect(fixture.write).toHaveBeenCalledWith('test.py', '\uFEFFedited\r\nlast', 'v1'),
  );
  await waitFor(() =>
    expect(useDocumentStatusStore.getState().statuses['test.py']?.status).toBe('conflict'),
  );
  expect(editor.state.doc.toString()).toBe('edited\nlast');
  expect(fixture.snapshot).not.toHaveBeenCalled();
});

it('shows a read-only excerpt and preserves access to the original copy', async () => {
  fixture.read.mockResolvedValue({
    content: null,
    version: null,
    preview: 'first line',
    reason: 'Source file is too large.',
  });
  const { container } = render(<SourceView relativePath="large.txt" />);
  await screen.findByText('Source file is too large.');
  expect(screen.getByText('first line').tagName).toBe('PRE');
  expect(screen.getByRole('button', { name: 'Download original' })).toBeTruthy();
  expect(container.querySelector('.cm-editor')).toBeNull();
});

it('opens a source search match on the requested line, including when the tab is already open', async () => {
  fixture.read.mockResolvedValue({
    content: '\uFEFFconst Name = 1;\r\nconst nameAgain = Name;\r\n',
    version: '1',
    preview: null,
    reason: null,
  });
  const jump = useEditorStore.getState().setPendingSearchJump;
  jump({ relativePath: 'match.ts', line: 2, query: 'Name' });
  const { container } = render(<SourceView relativePath="match.ts" />);
  await screen.findByText('CRLF');
  const editor = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
  const position = () => editor.state.doc.lineAt(editor.state.selection.main.from).number;
  expect(position()).toBe(2);
  act(() => jump({ relativePath: 'match.ts', line: 1, query: 'Name' }));
  expect(position()).toBe(1);
  expect(
    editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to),
  ).toBe('Name');
  expect(useEditorStore.getState().pendingSearchJump).toBeNull();
});
