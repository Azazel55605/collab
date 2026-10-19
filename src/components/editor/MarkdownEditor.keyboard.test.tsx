import { createRef } from 'react';

import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useUiStore } from '../../store/uiStore';

import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { pasteClipboardAtCursor } from './MarkdownEditorContextMenu';

vi.mock('./useMarkdownEditorIntegrations', () => ({
  useMarkdownEditorIntegrations: () => {},
  handleEditorDocumentLinkMouseDown: () => false,
}));

beforeEach(() => {
  useUiStore.setState({ webPreviewsEnabled: false, hoverWebLinkPreviewsEnabled: false });
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({
    left: 0,
    right: 1,
    top: 0,
    bottom: 20,
  });
});

function editor(content = '$$\n2+2\n$$', readOnly = false) {
  const ref = createRef<MarkdownEditorHandle>();
  const changed = vi.fn();
  const rendered = render(
    <MarkdownEditor
      ref={ref}
      content={content}
      onChange={changed}
      onSave={async () => {}}
      relativePath="Math.md"
      readOnly={readOnly}
    />,
  );
  const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
  act(() => ref.current!.revealRange(content.indexOf('\n') + 1));
  return { ref, changed, view, ...rendered };
}

it('dispatches one evaluation from the focused full editor, offers a hint, and supports undo', () => {
  const { view, changed } = editor();
  expect(screen.getByRole('note').textContent).toContain('Enter evaluate');
  fireEvent.keyDown(view.contentDOM, { key: 'Enter', code: 'Enter', ctrlKey: true });
  expect(view.state.doc.toString()).toBe('$$\n2+2 = 4\n$$');
  expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(view.contentDOM, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(view.state.doc.toString()).toBe('$$\n2+2\n$$');
});

it('approximates through keyboard dispatch and leaves ordinary/read-only text unchanged', () => {
  const writable = editor('$$\n1/2\n$$');
  fireEvent.keyDown(writable.view.contentDOM, {
    key: 'Enter',
    code: 'Enter',
    ctrlKey: true,
    altKey: true,
  });
  expect(writable.view.state.doc.toString()).toContain('\\approx 0.5');
  writable.unmount();
  const plain = editor('ordinary text');
  fireEvent.keyDown(plain.view.contentDOM, { key: 'Enter', ctrlKey: true });
  expect(plain.view.state.doc.toString()).not.toContain(' = ');
  plain.unmount();
  const locked = editor('$$\n2+2\n$$', true);
  expect(screen.queryByRole('note')).toBeNull();
  fireEvent.keyDown(locked.view.contentDOM, { key: 'Enter', ctrlKey: true });
  fireEvent.keyDown(locked.view.contentDOM, { key: 'b', ctrlKey: true });
  expect(locked.view.state.doc.toString()).toBe('$$\n2+2\n$$');
});

it('opens the variable chooser only for the originating editor pane', () => {
  const left = editor('$$\nx+y=2\n$$');
  const right = editor('$$\nx+y=2\n$$');
  act(() => left.ref.current!.revealRange(5));
  fireEvent.keyDown(left.view.contentDOM, { key: 'Enter', code: 'Enter', ctrlKey: true });
  expect(screen.getAllByRole('dialog', { name: 'Choose variable to solve' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /^x$/ }));
  expect(left.view.state.doc.toString()).toContain('\\Rightarrow');
  expect(right.view.state.doc.toString()).toBe('$$\nx+y=2\n$$');
});

it('does not apply an awaited clipboard read over intervening edits', async () => {
  const { view } = editor();
  let finish!: (text: string) => void;
  const paste = pasteClipboardAtCursor(view, {
    readText: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  act(() => view.dispatch({ changes: { from: 3, to: 6, insert: '3+3' } }));
  await act(async () => {
    finish('stale clipboard');
    await paste;
  });
  expect(view.state.doc.toString()).toBe('$$\n3+3\n$$');
});
