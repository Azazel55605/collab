import { Position } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import {
  buildCanvasEdgeLayout,
  buildOrthogonalCanvasEdgePath,
  fromFlowEdge,
  getAnchoredEdgeGeometry,
  getCanvasEdgeData,
  getOrthogonalCanvasEdgeLabelPosition,
  toFlowEdge,
} from './CanvasEdgeTypes';

describe('CanvasEdgeTypes', () => {
  it('ignores transient live nodes without positions when building edge layout', () => {
    expect(() =>
      buildCanvasEdgeLayout(
        [{ id: 'partial-live-node' }] as Parameters<typeof buildCanvasEdgeLayout>[0],
        [],
      ),
    ).not.toThrow();
  });

  it('fills edge defaults for a new connection', () => {
    expect(getCanvasEdgeData()).toEqual({
      label: '',
      lineStyle: 'solid',
      routingStyle: 'curved',
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
      sourceHandle: 'top-in',
      targetHandle: 'bottom-out',
      label: 'depends on',
      lineStyle: 'dashed',
      routingStyle: 'orthogonal',
      animated: true,
      animationReverse: true,
      markerStart: true,
      markerEnd: false,
    });

    expect(fromFlowEdge(flowEdge)).toEqual({
      id: 'edge-1',
      source: 'node-a',
      target: 'node-b',
      sourceHandle: 'top-in',
      targetHandle: 'bottom-out',
      label: 'depends on',
      lineStyle: 'dashed',
      routingStyle: 'orthogonal',
      animated: true,
      animationReverse: true,
      markerStart: true,
      markerEnd: false,
    });
  });

  it('clamps orthogonal lead-out lanes before close facing handles can cross', () => {
    const geometry = getAnchoredEdgeGeometry({
      edge: {
        id: 'edge-close',
        source: 'node-a',
        target: 'node-b',
      },
      edges: [],
      nodeGeometry: new Map(),
      sourceX: 100,
      sourceY: 120,
      targetX: 140,
      targetY: 120,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    expect(geometry.controlSourceX).toBeLessThanOrEqual(geometry.controlTargetX);
    expect(geometry.controlSourceX).toBe(120);
    expect(geometry.controlTargetX).toBe(120);
  });

  it('stacks only against siblings on the same handle', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-top',
        source: 'node-a',
        sourceHandle: 'bottom-out',
        target: 'node-target',
        targetHandle: 'top-in',
      }),
      toFlowEdge({
        id: 'edge-left',
        source: 'node-b',
        sourceHandle: 'right-out',
        target: 'node-target',
        targetHandle: 'left-in',
      }),
    ];

    const nodeGeometry = new Map([
      ['node-a', { centerX: 120, centerY: 60, width: 240, height: 120 }],
      ['node-b', { centerX: 20, centerY: 150, width: 240, height: 120 }],
      ['node-target', { centerX: 200, centerY: 150, width: 300, height: 180 }],
    ]);

    const topGeometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry,
      sourceX: 120,
      sourceY: 120,
      targetX: 200,
      targetY: 60,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    });

    const leftGeometry = getAnchoredEdgeGeometry({
      edge: edges[1],
      edges,
      nodeGeometry,
      sourceX: 80,
      sourceY: 150,
      targetX: 50,
      targetY: 150,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    expect(topGeometry.targetX).toBe(200);
    expect(leftGeometry.targetY).toBe(150);
  });

  it('stacks siblings on the same physical handle even when loose connections flip source and target roles', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-outgoing',
        source: 'node-a',
        sourceHandle: 'bottom-out',
        target: 'node-b',
        targetHandle: 'bottom-out',
      }),
      toFlowEdge({
        id: 'edge-incoming',
        source: 'node-c',
        sourceHandle: 'right-out',
        target: 'node-a',
        targetHandle: 'bottom-out',
      }),
    ];

    const nodeGeometry = new Map([
      ['node-a', { centerX: 200, centerY: 120, width: 240, height: 120 }],
      ['node-b', { centerX: 420, centerY: 120, width: 240, height: 120 }],
      ['node-c', { centerX: 200, centerY: 320, width: 240, height: 120 }],
    ]);

    const outgoingGeometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry,
      sourceX: 200,
      sourceY: 180,
      targetX: 420,
      targetY: 180,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Bottom,
    });

    const incomingGeometry = getAnchoredEdgeGeometry({
      edge: edges[1],
      edges,
      nodeGeometry,
      sourceX: 320,
      sourceY: 320,
      targetX: 200,
      targetY: 180,
      sourcePosition: Position.Right,
      targetPosition: Position.Bottom,
    });

    expect(outgoingGeometry.sourceX).not.toBe(200);
    expect(incomingGeometry.targetX).not.toBe(200);
    expect(outgoingGeometry.sourceX).not.toBe(incomingGeometry.targetX);
  });

  it('stacks siblings that share the same handle side even when the raw handle ids differ', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-source-bottom',
        source: 'node-a',
        sourceHandle: 'bottom-out',
        target: 'node-b',
        targetHandle: 'left-in',
      }),
      toFlowEdge({
        id: 'edge-target-bottom',
        source: 'node-c',
        sourceHandle: 'right-out',
        target: 'node-a',
        targetHandle: 'bottom-incoming',
      }),
    ];

    const nodeGeometry = new Map([
      ['node-a', { centerX: 200, centerY: 120, width: 240, height: 120 }],
      ['node-b', { centerX: 420, centerY: 180, width: 240, height: 120 }],
      ['node-c', { centerX: 40, centerY: 260, width: 240, height: 120 }],
    ]);

    const firstGeometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry,
      sourceX: 200,
      sourceY: 180,
      targetX: 300,
      targetY: 180,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Left,
    });

    const secondGeometry = getAnchoredEdgeGeometry({
      edge: edges[1],
      edges,
      nodeGeometry,
      sourceX: 160,
      sourceY: 260,
      targetX: 200,
      targetY: 180,
      sourcePosition: Position.Right,
      targetPosition: Position.Bottom,
    });

    expect(firstGeometry.sourceX).not.toBe(200);
    expect(secondGeometry.targetX).not.toBe(200);
  });

  it('anchors loose-connection endpoints from the handle side instead of the fallback react-flow point', () => {
    const geometry = getAnchoredEdgeGeometry({
      edge: {
        id: 'edge-loose-bottom',
        source: 'node-a',
        sourceHandle: 'right-out',
        target: 'node-b',
        targetHandle: 'bottom-out',
      },
      edges: [],
      nodeGeometry: new Map([
        ['node-a', { centerX: 100, centerY: 100, width: 200, height: 120 }],
        ['node-b', { centerX: 400, centerY: 200, width: 240, height: 160 }],
      ]),
      sourceX: 200,
      sourceY: 100,
      targetX: 400,
      targetY: 120,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    expect(geometry.targetY).toBe(280);
  });

  it('does not offset an explicit-handle edge because of inferred siblings without matching handle ids', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-explicit',
        source: 'node-a',
        sourceHandle: 'right-out',
        target: 'node-b',
        targetHandle: 'left-in',
      }),
      toFlowEdge({
        id: 'edge-inferred',
        source: 'node-a',
        target: 'node-c',
      }),
    ];

    const geometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry: new Map([
        ['node-a', { centerX: 100, centerY: 100, width: 200, height: 120 }],
        ['node-b', { centerX: 360, centerY: 100, width: 200, height: 120 }],
        ['node-c', { centerX: 260, centerY: 20, width: 200, height: 120 }],
      ]),
      sourceX: 200,
      sourceY: 100,
      targetX: 260,
      targetY: 100,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    expect(geometry.sourceY).toBe(100);
    expect(geometry.targetY).toBe(100);
  });

  it('orders same-level siblings on a horizontal handle by proximity instead of arbitrary id order', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-far',
        source: 'junction',
        sourceHandle: 'right-out',
        target: 'target-far',
        targetHandle: 'left-in',
      }),
      toFlowEdge({
        id: 'edge-near',
        source: 'junction',
        sourceHandle: 'right-out',
        target: 'target-near',
        targetHandle: 'left-in',
      }),
    ];

    const nodeGeometry = new Map([
      ['junction', { centerX: 100, centerY: 300, width: 56, height: 56 }],
      ['target-near', { centerX: 280, centerY: 120, width: 220, height: 180 }],
      ['target-far', { centerX: 520, centerY: 120, width: 220, height: 180 }],
    ]);

    const farGeometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry,
      sourceX: 128,
      sourceY: 300,
      targetX: 170,
      targetY: 120,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    const nearGeometry = getAnchoredEdgeGeometry({
      edge: edges[1],
      edges,
      nodeGeometry,
      sourceX: 128,
      sourceY: 300,
      targetX: 170,
      targetY: 120,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });

    expect(nearGeometry.sourceY).toBeLessThan(farGeometry.sourceY);
  });

  it('orders same-level siblings correctly on a mirrored left-side target handle', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-far-left',
        source: 'target-far-left',
        sourceHandle: 'top-out',
        target: 'junction',
        targetHandle: 'left-in',
      }),
      toFlowEdge({
        id: 'edge-near-left',
        source: 'target-near-left',
        sourceHandle: 'top-out',
        target: 'junction',
        targetHandle: 'left-in',
      }),
    ];

    const nodeGeometry = new Map([
      ['junction', { centerX: 900, centerY: 220, width: 56, height: 56 }],
      ['target-far-left', { centerX: 200, centerY: 620, width: 220, height: 220 }],
      ['target-near-left', { centerX: 520, centerY: 620, width: 220, height: 220 }],
    ]);

    const farGeometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry,
      sourceX: 200,
      sourceY: 510,
      targetX: 872,
      targetY: 220,
      sourcePosition: Position.Top,
      targetPosition: Position.Left,
    });

    const nearGeometry = getAnchoredEdgeGeometry({
      edge: edges[1],
      edges,
      nodeGeometry,
      sourceX: 520,
      sourceY: 510,
      targetX: 872,
      targetY: 220,
      sourcePosition: Position.Top,
      targetPosition: Position.Left,
    });

    expect(farGeometry.targetY).toBeLessThan(nearGeometry.targetY);
  });

  it('orders same-level siblings correctly on a left-side target handle when the peers are above the anchor', () => {
    const edges = [
      toFlowEdge({
        id: 'edge-far-left-above',
        source: 'target-far-left-above',
        sourceHandle: 'bottom-out',
        target: 'junction',
        targetHandle: 'left-in',
      }),
      toFlowEdge({
        id: 'edge-near-left-above',
        source: 'target-near-left-above',
        sourceHandle: 'bottom-out',
        target: 'junction',
        targetHandle: 'left-in',
      }),
    ];

    const nodeGeometry = new Map([
      ['junction', { centerX: 900, centerY: 420, width: 56, height: 56 }],
      ['target-far-left-above', { centerX: 200, centerY: 120, width: 220, height: 220 }],
      ['target-near-left-above', { centerX: 520, centerY: 120, width: 220, height: 220 }],
    ]);

    const farGeometry = getAnchoredEdgeGeometry({
      edge: edges[0],
      edges,
      nodeGeometry,
      sourceX: 200,
      sourceY: 230,
      targetX: 872,
      targetY: 420,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Left,
    });

    const nearGeometry = getAnchoredEdgeGeometry({
      edge: edges[1],
      edges,
      nodeGeometry,
      sourceX: 520,
      sourceY: 230,
      targetX: 872,
      targetY: 420,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Left,
    });

    expect(nearGeometry.targetY).toBeLessThan(farGeometry.targetY);
  });

  it('routes bottom-to-right orthogonal edges with a single elbow', () => {
    const path = buildOrthogonalCanvasEdgePath({
      sourceX: 200,
      sourceY: 300,
      controlSourceX: 200,
      controlSourceY: 336,
      controlTargetX: 420,
      controlTargetY: 180,
      targetX: 384,
      targetY: 180,
      labelX: 0,
      labelY: 0,
    });

    expect(path).toBe('M 200 300 L 200 180 L 384 180');
  });

  it('places orthogonal labels on the main routed segment instead of the raw midpoint', () => {
    const label = getOrthogonalCanvasEdgeLabelPosition({
      sourceX: 73,
      sourceY: 120,
      controlSourceX: 73,
      controlSourceY: 150,
      controlTargetX: 610,
      controlTargetY: 340,
      targetX: 640,
      targetY: 340,
      labelX: 356.5,
      labelY: 230,
    });

    expect(label).toEqual({
      x: 356.5,
      y: 340,
    });
  });
});
