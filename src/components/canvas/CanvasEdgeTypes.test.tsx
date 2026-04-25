import { describe, expect, it } from 'vitest';

import { fromFlowEdge, getCanvasEdgeData, toFlowEdge } from './CanvasEdgeTypes';

describe('CanvasEdgeTypes', () => {
  it('fills edge defaults for a new connection', () => {
    expect(getCanvasEdgeData()).toEqual({
      label: '',
      lineStyle: 'solid',
      animated: false,
      animationReverse: false,
      markerStart: false,
      markerEnd: false,
    });
  });

  it('round-trips persisted edge data through flow edges', () => {
    const flowEdge = toFlowEdge({
      id: 'edge-1',
      source: 'node-a',
      target: 'node-b',
      label: 'depends on',
      lineStyle: 'dashed',
      animated: true,
      animationReverse: true,
      markerStart: true,
      markerEnd: false,
    });

    expect(fromFlowEdge(flowEdge)).toEqual({
      id: 'edge-1',
      source: 'node-a',
      target: 'node-b',
      label: 'depends on',
      lineStyle: 'dashed',
      animated: true,
      animationReverse: true,
      markerStart: true,
      markerEnd: false,
    });
  });
});
