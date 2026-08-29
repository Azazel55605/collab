import { describe, expect, it, vi } from 'vitest';

import {
  createSplitJunctionNode,
  mergeSingleJunction,
  splitEdgeWithJunction,
  supportsLinkedPath,
  supportsPlanningMetadata,
} from './canvasDiagramUtils';

describe('canvasDiagramUtils', () => {
  it('limits planning metadata on structural nodes', () => {
    expect(supportsPlanningMetadata('process')).toBe(true);
    expect(supportsPlanningMetadata('decision')).toBe(false);
    expect(supportsPlanningMetadata('junction')).toBe(false);
    expect(supportsPlanningMetadata('crossing')).toBe(false);
    expect(supportsLinkedPath('document')).toBe(true);
    expect(supportsLinkedPath('decision')).toBe(false);
    expect(supportsLinkedPath('swimlane')).toBe(false);
  });

  it('splits an edge with a junction node', () => {
    const junction = createSplitJunctionNode(
      { x: 120, y: 180 },
      '11111111-1111-1111-1111-111111111111',
    );
    const split = splitEdgeWithJunction(
      {
        id: 'edge-1',
        source: 'node-a',
        target: 'node-b',
        label: 'Yes',
        routingStyle: 'orthogonal',
        markerEnd: true,
      },
      junction,
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    );

    expect(split.node.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(split.edges).toEqual([
      expect.objectContaining({
        id: '22222222-2222-2222-2222-222222222222',
        source: 'node-a',
        target: '11111111-1111-1111-1111-111111111111',
        label: 'Yes',
        markerEnd: false,
      }),
      expect.objectContaining({
        id: '33333333-3333-3333-3333-333333333333',
        source: '11111111-1111-1111-1111-111111111111',
        target: 'node-b',
      }),
    ]);
  });

  it('merges a simple one-in one-out junction back into a single edge', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('99999999-9999-9999-9999-999999999999');

    expect(
      mergeSingleJunction('junction-1', [
        {
          id: 'edge-1',
          source: 'node-a',
          target: 'junction-1',
          label: 'Yes',
          routingStyle: 'orthogonal',
        },
        {
          id: 'edge-2',
          source: 'junction-1',
          target: 'node-b',
          markerEnd: true,
          routingStyle: 'orthogonal',
        },
      ]),
    ).toEqual({
      removedEdgeIds: ['edge-1', 'edge-2'],
      mergedEdge: expect.objectContaining({
        id: '99999999-9999-9999-9999-999999999999',
        source: 'node-a',
        target: 'node-b',
        label: 'Yes',
        routingStyle: 'orthogonal',
        markerEnd: true,
      }),
    });
  });
});
