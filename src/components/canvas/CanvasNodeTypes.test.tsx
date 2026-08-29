import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeTypes } from './CanvasNodeTypes';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Left: 'left', Right: 'right' },
  useStore: () => false,
}));

vi.mock('../editor/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));

describe('CanvasNodeTypes', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it('prefers a canvas-local note description over the note preview body', () => {
    const NoteCardNode = nodeTypes.noteCard;

    render(
      <NoteCardNode
        id="note-3"
        selected={false}
        data={{
          title: 'Note',
          subtitle: 'Notes',
          relativePath: 'Notes/test.md',
          excerpt: 'preview',
          content: 'Canvas-local description',
        }}
      />,
    );

    expect(screen.getByText('Canvas-local description')).toBeTruthy();
    expect(screen.getByText('preview')).toBeTruthy();
  });

  it('renders a process due-date badge when present', () => {
    const ProcessCardNode = nodeTypes.processCard;

    render(
      <ProcessCardNode
        id="process-1"
        selected={false}
        data={{
          title: 'Deploy',
          nodeKind: 'process',
          planning: { dueDate: '2026-05-20' },
        }}
      />,
    );

    expect(screen.getByText('2026-05-20')).toBeTruthy();
  });

  it('keeps note card titles on the foreground color without requiring hover', () => {
    const NoteCardNode = nodeTypes.noteCard;

    render(
      <NoteCardNode
        id="note-2"
        selected={false}
        data={{
          title: 'Visible title',
          subtitle: 'Notes',
          relativePath: 'Notes/visible.md',
          excerpt: 'preview',
        }}
      />,
    );

    expect(screen.getByRole('button').className).toContain('text-foreground');
    expect(screen.getByText('Visible title').className).toContain('text-foreground');
  });

  it('renders the symbol card with the selected glyph and label', () => {
    const SymbolCardNode = nodeTypes.symbolCard;

    render(
      <SymbolCardNode
        id="symbol-1"
        selected={false}
        data={{
          title: 'Pinned idea',
          symbolGlyph: '󰘧',
          symbolId: 'nf-md-star_four_points',
          symbolLabel: 'Star Four Points',
        }}
      />,
    );

    expect(screen.getByText('Pinned idea')).toBeTruthy();
    expect(screen.getByText('nf-md-star_four_points')).toBeTruthy();
    expect(screen.getByLabelText('Star Four Points')).toBeTruthy();
  });

  it('keeps the web card input responsive while delaying canvas url updates', () => {
    vi.useFakeTimers();
    const onWebUrlChange = vi.fn();
    const WebCardNode = nodeTypes.webCard;

    render(
      <WebCardNode
        id="web-1"
        selected={false}
        data={{
          title: 'Web card',
          subtitle: 'Website',
          url: '',
          onWebUrlChange,
        }}
      />,
    );

    const input = screen.getByPlaceholderText(
      'example.com or https://example.com',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'https://example.com' } });

    expect(input.value).toBe('https://example.com');
    expect(onWebUrlChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(220);

    expect(onWebUrlChange).toHaveBeenCalledWith('web-1', 'https://example.com');
  });
});
