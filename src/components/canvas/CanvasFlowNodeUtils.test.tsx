import { describe, expect, it, vi } from 'vitest';

import { fromFlowNode, toFlowNode } from './CanvasFlowNodeUtils';

describe('CanvasFlowNodeUtils', () => {
  it('maps a note canvas node into a note card flow node', () => {
    const flowNode = toFlowNode(
      {
        id: 'note-1',
        type: 'note',
        relativePath: 'Notes/alpha.md',
        position: { x: 10, y: 20 },
        width: 300,
        height: 180,
      },
      { excerpt: 'preview body' },
      {
        onOpen: vi.fn(),
        onTextChange: vi.fn(),
        onSnapToGrid: vi.fn(),
        onWebUrlChange: vi.fn(),
        onWebDisplayModeOverrideChange: vi.fn(),
        onRequestWebPreview: vi.fn(),
        onOpenUrl: vi.fn(),
      },
      'preview',
      false,
      false,
    );

    expect(flowNode).toMatchObject({
      id: 'note-1',
      type: 'noteCard',
      position: { x: 10, y: 20 },
      data: {
        title: 'alpha',
        relativePath: 'Notes/alpha.md',
        excerpt: 'preview body',
      },
    });
  });

  it('round-trips a text flow node back into a text canvas node', () => {
    expect(fromFlowNode({
      id: 'text-1',
      type: 'textCard',
      position: { x: 5, y: 6 },
      width: 280,
      height: 160,
      data: {
        content: 'hello',
      },
    } as never)).toEqual({
      id: 'text-1',
      type: 'text',
      position: { x: 5, y: 6 },
      width: 280,
      height: 160,
      content: 'hello',
    });
  });
});
