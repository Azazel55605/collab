import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' },
  useStore: () => false,
}));

vi.mock('../editor/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { nodeTypes } from './CanvasNodeTypes';

describe('CanvasNodeTypes', () => {
  afterEach(() => {
    cleanup();
  });

  it('calls onTextChange from the text card node', () => {
    const onTextChange = vi.fn();
    const TextCardNode = nodeTypes.textCard;

    render(
      <TextCardNode
        id="text-1"
        selected={false}
        data={{
          title: 'Text',
          subtitle: 'Canvas note',
          content: 'hello',
          onTextChange,
        }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Write directly on the canvas…'), {
      target: { value: 'updated text' },
    });

    expect(onTextChange).toHaveBeenCalledWith('text-1', 'updated text');
  });

  it('opens the linked note on double click from the note card node', () => {
    const onOpen = vi.fn();
    const NoteCardNode = nodeTypes.noteCard;

    render(
      <NoteCardNode
        id="note-1"
        selected={false}
        data={{
          title: 'Note',
          subtitle: 'Notes',
          relativePath: 'Notes/test.md',
          excerpt: 'preview',
          onOpen,
        }}
      />,
    );

    fireEvent.doubleClick(screen.getByRole('button'));

    expect(onOpen).toHaveBeenCalledWith('Notes/test.md');
  });
});
