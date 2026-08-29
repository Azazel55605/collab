import type { CanvasEdge, PlanningCanvasNode } from '../../types/canvas';

export function supportsPlanningMetadata(kind: PlanningCanvasNode['type']) {
  return ['process', 'document', 'milestone', 'actor'].includes(kind);
}

export function supportsLinkedPath(kind: PlanningCanvasNode['type']) {
  return ['process', 'document', 'milestone', 'actor', 'group'].includes(kind);
}

export function createSplitJunctionNode(
  position: { x: number; y: number },
  id = crypto.randomUUID(),
): PlanningCanvasNode {
  return {
    id,
    type: 'junction',
    title: 'Junction',
    body: '',
    position,
    width: 56,
    height: 56,
  };
}

export function splitEdgeWithJunction(
  edge: CanvasEdge,
  junctionNode: PlanningCanvasNode,
  firstEdgeId = crypto.randomUUID(),
  secondEdgeId = crypto.randomUUID(),
) {
  const base = {
    lineStyle: edge.lineStyle,
    routingStyle: edge.routingStyle,
    animated: edge.animated,
    animationReverse: edge.animationReverse,
    markerStart: edge.markerStart,
    markerEnd: edge.markerEnd,
  };

  return {
    node: junctionNode,
    edges: [
      {
        id: firstEdgeId,
        source: edge.source,
        target: junctionNode.id,
        sourceHandle: edge.sourceHandle,
        targetHandle: 'left-in',
        label: edge.label,
        ...base,
        markerEnd: false,
      },
      {
        id: secondEdgeId,
        source: junctionNode.id,
        target: edge.target,
        sourceHandle: 'right-out',
        targetHandle: edge.targetHandle,
        ...base,
        markerStart: false,
      },
    ] satisfies CanvasEdge[],
  };
}

export function mergeSingleJunction(nodeId: string, edges: CanvasEdge[]) {
  const incoming = edges.filter((edge) => edge.target === nodeId);
  const outgoing = edges.filter((edge) => edge.source === nodeId);
  if (incoming.length !== 1 || outgoing.length !== 1) return null;

  const [entry] = incoming;
  const [exit] = outgoing;
  if (entry.source === exit.target) return null;

  return {
    removedEdgeIds: [entry.id, exit.id],
    mergedEdge: {
      id: crypto.randomUUID(),
      source: entry.source,
      target: exit.target,
      sourceHandle: entry.sourceHandle,
      targetHandle: exit.targetHandle,
      label: entry.label || exit.label,
      lineStyle: exit.lineStyle ?? entry.lineStyle,
      routingStyle: exit.routingStyle ?? entry.routingStyle,
      animated: exit.animated ?? entry.animated,
      animationReverse: exit.animationReverse ?? entry.animationReverse,
      markerStart: entry.markerStart,
      markerEnd: exit.markerEnd,
    } satisfies CanvasEdge,
  };
}
