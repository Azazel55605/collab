import { describe, expect, it, vi } from 'vitest';

import { fromFlowNode, toFlowNode } from './CanvasFlowNodeUtils';

describe('CanvasFlowNodeUtils', () => {
  it('maps a note canvas node into a note card flow node', () => {
    const flowNode = toFlowNode(
      {
        id: 'note-1',
        type: 'note',
        relativePath: 'Notes/alpha.md',
        description: 'Canvas summary',
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
        content: 'Canvas summary',
        excerpt: 'preview body',
      },
    });
  });

  it('round-trips a file-backed description through the flow mapping', () => {
    expect(
      fromFlowNode({
        id: 'file-1',
        type: 'fileCard',
        position: { x: 5, y: 6 },
        width: 280,
        height: 160,
        data: {
          relativePath: 'Docs/spec.pdf',
          content: 'Reference PDF',
        },
      } as never),
    ).toEqual({
      id: 'file-1',
      type: 'file',
      position: { x: 5, y: 6 },
      width: 280,
      height: 160,
      relativePath: 'Docs/spec.pdf',
      description: 'Reference PDF',
    });
  });

  it('round-trips a text flow node back into a text canvas node', () => {
    expect(
      fromFlowNode({
        id: 'text-1',
        type: 'textCard',
        position: { x: 5, y: 6 },
        width: 280,
        height: 160,
        data: {
          content: 'hello',
        },
      } as never),
    ).toEqual({
      id: 'text-1',
      type: 'text',
      position: { x: 5, y: 6 },
      width: 280,
      height: 160,
      content: 'hello',
    });
  });

  it('round-trips a symbol node through the flow mapping', () => {
    const flowNode = toFlowNode(
      {
        id: 'symbol-1',
        type: 'symbol',
        glyph: '󰘧',
        iconId: 'nf-md-star_four_points',
        iconLabel: 'Star Four Points',
        title: 'Important',
        position: { x: 30, y: 40 },
        width: 180,
        height: 180,
      },
      undefined,
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
      id: 'symbol-1',
      type: 'symbolCard',
      data: {
        title: 'Important',
        subtitle: 'Star Four Points',
        symbolGlyph: '󰘧',
        symbolId: 'nf-md-star_four_points',
        symbolLabel: 'Star Four Points',
      },
    });

    expect(fromFlowNode(flowNode as never)).toEqual({
      id: 'symbol-1',
      type: 'symbol',
      glyph: '󰘧',
      iconId: 'nf-md-star_four_points',
      iconLabel: 'Star Four Points',
      title: 'Important',
      position: { x: 30, y: 40 },
      width: 180,
      height: 180,
    });
  });

  it('round-trips a planning flow node back into a persisted planning node', () => {
    expect(
      fromFlowNode({
        id: 'decision-1',
        type: 'decisionCard',
        position: { x: 12, y: 14 },
        width: 280,
        height: 180,
        data: {
          title: 'Approve?',
          content: 'If approved, continue to delivery.',
          planning: {
            status: 'blocked',
            priority: 'high',
            ownerLabel: 'Lead',
          },
        },
      } as never),
    ).toEqual({
      id: 'decision-1',
      type: 'decision',
      position: { x: 12, y: 14 },
      width: 280,
      height: 180,
      title: 'Approve?',
      body: 'If approved, continue to delivery.',
      linkedRelativePath: undefined,
      planning: {
        status: 'blocked',
        priority: 'high',
        ownerLabel: 'Lead',
      },
    });
  });
});
