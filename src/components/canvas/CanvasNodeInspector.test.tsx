import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasNodeInspector } from './CanvasNodeInspector';

vi.mock('../ui/button', () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('../ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock('../ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => <span>Select value</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../ui/calendar', () => ({
  Calendar: () => <div>Calendar widget</div>,
}));

describe('CanvasNodeInspector', () => {
  afterEach(() => {
    cleanup();
  });

  const sharedProps = {
    knownUsers: [{ userId: 'user-1', userName: 'Ada', userColor: '#ff0000', lastSeen: 1 }],
    availableTags: ['infra', 'vpn', 'critical'],
    dateFormat: 'YYYY_MM_DD' as const,
    onTitleChange: vi.fn(),
    onBodyChange: vi.fn(),
    onPickSymbol: vi.fn(),
    onPickLinkedPath: vi.fn(),
    onLinkedPathChange: vi.fn(),
    onPlanningChange: vi.fn(),
    onOrientationChange: vi.fn(),
    onDeleteSelected: vi.fn(),
  };

  it('renders a usable description field for note cards', () => {
    render(
      <CanvasNodeInspector
        {...sharedProps}
        selectedNode={{
          id: 'note-1',
          type: 'noteCard',
          title: 'Alpha',
          relativePath: 'Notes/alpha.md',
          content: 'Existing description',
        }}
      />,
    );

    expect(screen.getByPlaceholderText('Add a canvas-local description')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Node title')).toBeNull();
  });

  it('does not render a dead description field for junction nodes', () => {
    render(
      <CanvasNodeInspector
        {...sharedProps}
        selectedNode={{
          id: 'junction-1',
          type: 'junctionCard',
          title: 'Junction',
          content: 'Unused',
        }}
      />,
    );

    expect(
      screen.queryByPlaceholderText('Description, branch notes, or supporting context'),
    ).toBeNull();
  });

  it('suggests tags from the app tag system for planning nodes', () => {
    const onPlanningChange = vi.fn();

    render(
      <CanvasNodeInspector
        {...sharedProps}
        onPlanningChange={onPlanningChange}
        selectedNode={{
          id: 'process-1',
          type: 'processCard',
          title: 'Process',
          planning: { tags: ['infra'] },
        }}
      />,
    );

    fireEvent.focus(screen.getByPlaceholderText('Type tag, press Enter'));
    fireEvent.click(screen.getByText('vpn'));

    expect(onPlanningChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['infra', 'vpn'],
      }),
    );
  });

  it('offers a file picker action for linked vault paths', () => {
    const onPickLinkedPath = vi.fn();

    render(
      <CanvasNodeInspector
        {...sharedProps}
        onPickLinkedPath={onPickLinkedPath}
        selectedNode={{
          id: 'process-2',
          type: 'processCard',
          title: 'Process',
          linkedRelativePath: 'Docs/spec.pdf',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /select file/i }));
    expect(onPickLinkedPath).toHaveBeenCalled();
  });
});
