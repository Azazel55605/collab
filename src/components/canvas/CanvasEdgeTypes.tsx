import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  BaseEdge,
  type ConnectionLineComponentProps,
  type EdgeProps,
  type Edge as FlowEdge,
  type Node as FlowNode,
  Position,
} from '@xyflow/react';

import type { CanvasEdge, CanvasEdgeLineStyle, CanvasEdgeRoutingStyle } from '../../types/canvas';

import type { CanvasNodeData } from './CanvasNodeTypes';

const DEFAULT_NODE_HEIGHT = 180;
const CANVAS_EDGE_LANE = 30;
const CANVAS_EDGE_SLOT_SPACING = 18;
const CANVAS_EDGE_SLOT_PADDING = 26;
const CANVAS_EDGE_REROUTE_MS = 220;
const CANVAS_EDGE_REROUTE_LIMIT = 12;
const DEFAULT_EDGE_STROKE = 'color-mix(in oklch, var(--primary) 78%, white 22%)';
const EDGE_ANIMATION_STROKE = 'color-mix(in oklch, white 84%, var(--primary) 16%)';
const SOLID_EDGE_ANIMATION_DASH = 28;
const SOLID_EDGE_ANIMATION_GAP = 240;

export const DEFAULT_CANVAS_EDGE_STYLE = {
  strokeWidth: 2,
  stroke: DEFAULT_EDGE_STROKE,
  transition: 'stroke 180ms ease, filter 180ms ease, opacity 180ms ease',
} satisfies CSSProperties;

export interface CanvasEdgeData extends Record<string, unknown> {
  label?: string;
  lineStyle: CanvasEdgeLineStyle;
  routingStyle: CanvasEdgeRoutingStyle;
  animated: boolean;
  animationReverse: boolean;
  markerStart: boolean;
  markerEnd: boolean;
}

export type CanvasFlowEdge = FlowEdge<CanvasEdgeData>;

interface NodeGeometry {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

interface EdgeGeometry {
  sourceX: number;
  sourceY: number;
  controlSourceX: number;
  controlSourceY: number;
  controlTargetX: number;
  controlTargetY: number;
  targetX: number;
  targetY: number;
  labelX: number;
  labelY: number;
}

interface PathPoint {
  x: number;
  y: number;
}

interface EdgeSiblingDescriptor {
  key: string;
  oppositeId: string;
}

interface EdgeSiblingLookup {
  all: Map<string, EdgeSiblingDescriptor[]>;
  explicit: Map<string, EdgeSiblingDescriptor[]>;
}

interface CanvasEdgeLayout {
  edges: CanvasFlowEdge[];
  nodeGeometry: Map<string, NodeGeometry>;
  siblingLookup: EdgeSiblingLookup;
  animateReroutes: boolean;
}

const CanvasEdgeLayoutContext = createContext<CanvasEdgeLayout | null>(null);

function isHorizontalPosition(position: Position) {
  return position === Position.Left || position === Position.Right;
}

function normalizeVector(x: number, y: number) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

export function getCanvasEdgeData(
  edge?: {
    label?: string;
    lineStyle?: CanvasEdgeLineStyle;
    routingStyle?: CanvasEdgeRoutingStyle;
    animated?: boolean;
    animationReverse?: boolean;
    markerStart?: boolean;
    markerEnd?: boolean;
  } | null,
): CanvasEdgeData {
  return {
    label: edge?.label ?? '',
    lineStyle: edge?.lineStyle ?? 'solid',
    routingStyle: edge?.routingStyle ?? 'curved',
    animated: edge?.animated ?? false,
    animationReverse: edge?.animationReverse ?? false,
    markerStart: edge?.markerStart ?? false,
    markerEnd: edge?.markerEnd ?? false,
  };
}

function getEdgeDashArray(lineStyle: CanvasEdgeLineStyle) {
  if (lineStyle === 'dashed') return '10 8';
  if (lineStyle === 'dotted') return '2 7';
  return undefined;
}

function getCanvasArrowMarkerId(kind: 'start' | 'end') {
  return `canvas-edge-arrow-${kind}`;
}

function getCanvasArrowMarkerIdForEdge(edgeId: string, kind: 'start' | 'end') {
  return `${getCanvasArrowMarkerId(kind)}-${edgeId}`;
}

function buildCanvasEdgePath(geometry: EdgeGeometry) {
  return `M ${geometry.sourceX} ${geometry.sourceY} C ${geometry.controlSourceX} ${geometry.controlSourceY}, ${geometry.controlTargetX} ${geometry.controlTargetY}, ${geometry.targetX} ${geometry.targetY}`;
}

function getOrthogonalCanvasEdgePoints(geometry: EdgeGeometry): PathPoint[] {
  const sourceHorizontal = geometry.controlSourceX !== geometry.sourceX;
  const targetHorizontal = geometry.controlTargetX !== geometry.targetX;

  if (sourceHorizontal && targetHorizontal) {
    const midX = (geometry.controlSourceX + geometry.controlTargetX) / 2;
    return [
      { x: geometry.sourceX, y: geometry.sourceY },
      { x: geometry.controlSourceX, y: geometry.controlSourceY },
      { x: midX, y: geometry.controlSourceY },
      { x: midX, y: geometry.controlTargetY },
      { x: geometry.controlTargetX, y: geometry.controlTargetY },
      { x: geometry.targetX, y: geometry.targetY },
    ];
  }

  if (!sourceHorizontal && !targetHorizontal) {
    const midY = (geometry.controlSourceY + geometry.controlTargetY) / 2;
    return [
      { x: geometry.sourceX, y: geometry.sourceY },
      { x: geometry.controlSourceX, y: geometry.controlSourceY },
      { x: geometry.controlSourceX, y: midY },
      { x: geometry.controlTargetX, y: midY },
      { x: geometry.controlTargetX, y: geometry.controlTargetY },
      { x: geometry.targetX, y: geometry.targetY },
    ];
  }

  if (!sourceHorizontal && targetHorizontal) {
    return [
      { x: geometry.sourceX, y: geometry.sourceY },
      { x: geometry.sourceX, y: geometry.targetY },
      { x: geometry.targetX, y: geometry.targetY },
    ];
  }

  return [
    { x: geometry.sourceX, y: geometry.sourceY },
    { x: geometry.targetX, y: geometry.sourceY },
    { x: geometry.targetX, y: geometry.targetY },
  ];
}

export function buildOrthogonalCanvasEdgePath(geometry: EdgeGeometry) {
  const points = getOrthogonalCanvasEdgePoints(geometry);
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

export function getOrthogonalCanvasEdgeLabelPosition(geometry: EdgeGeometry) {
  const points = getOrthogonalCanvasEdgePoints(geometry);
  const fallbackMidpoint = {
    x: geometry.labelX,
    y: geometry.labelY,
  };

  let bestSegment: { start: PathPoint; end: PathPoint; length: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < 1) continue;

    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const distanceToFallback = Math.hypot(midX - fallbackMidpoint.x, midY - fallbackMidpoint.y);

    if (
      !bestSegment ||
      length > bestSegment.length ||
      (Math.abs(length - bestSegment.length) < 0.5 && distanceToFallback < bestDistance)
    ) {
      bestSegment = { start, end, length };
      bestDistance = distanceToFallback;
    }
  }

  if (!bestSegment) return fallbackMidpoint;

  return {
    x: (bestSegment.start.x + bestSegment.end.x) / 2,
    y: (bestSegment.start.y + bestSegment.end.y) / 2,
  };
}

function interpolateGeometry(from: EdgeGeometry, to: EdgeGeometry, progress: number): EdgeGeometry {
  const mix = (start: number, end: number) => start + (end - start) * progress;
  return {
    sourceX: mix(from.sourceX, to.sourceX),
    sourceY: mix(from.sourceY, to.sourceY),
    controlSourceX: mix(from.controlSourceX, to.controlSourceX),
    controlSourceY: mix(from.controlSourceY, to.controlSourceY),
    controlTargetX: mix(from.controlTargetX, to.controlTargetX),
    controlTargetY: mix(from.controlTargetY, to.controlTargetY),
    targetX: mix(from.targetX, to.targetX),
    targetY: mix(from.targetY, to.targetY),
    labelX: mix(from.labelX, to.labelX),
    labelY: mix(from.labelY, to.labelY),
  };
}

function easeOutCubic(value: number) {
  return 1 - (1 - value) ** 3;
}

export function fromFlowEdge(edge: CanvasFlowEdge): CanvasEdge {
  const data = getCanvasEdgeData(edge.data);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    label: data.label || undefined,
    lineStyle: data.lineStyle,
    routingStyle: data.routingStyle,
    animated: data.animated,
    animationReverse: data.animationReverse,
    markerStart: data.markerStart,
    markerEnd: data.markerEnd,
  };
}

export function toFlowEdge(edge: CanvasEdge): CanvasFlowEdge {
  const data = getCanvasEdgeData(edge);
  return {
    id: edge.id,
    type: 'stacked',
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: data.label,
    data,
    markerStart: data.markerStart ? `url(#${getCanvasArrowMarkerId('start')})` : undefined,
    markerEnd: data.markerEnd ? `url(#${getCanvasArrowMarkerId('end')})` : undefined,
    animated: false,
    style: {
      ...DEFAULT_CANVAS_EDGE_STYLE,
      strokeDasharray: getEdgeDashArray(data.lineStyle),
      strokeLinecap: data.lineStyle === 'dotted' ? 'round' : 'butt',
    },
    labelStyle: {
      fill: 'var(--foreground)',
      fontSize: 11,
      fontWeight: 600,
    },
    labelBgStyle: {
      fill: 'color-mix(in oklch, var(--card) 92%, var(--background))',
      fillOpacity: 0.92,
      stroke: 'color-mix(in oklch, var(--border) 85%, white 15%)',
      strokeWidth: 1,
    },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 6,
  };
}

function getSlotOffset(index: number, count: number, nodeHeight: number) {
  if (count <= 1) return 0;
  const availableSpread = Math.max(
    nodeHeight - CANVAS_EDGE_SLOT_PADDING * 2,
    CANVAS_EDGE_SLOT_SPACING,
  );
  const spacing = Math.min(CANVAS_EDGE_SLOT_SPACING, availableSpread / (count - 1));
  return (index - (count - 1) / 2) * spacing;
}

function getHandleAnchorKey(handleId: string | null) {
  if (!handleId) return null;
  if (handleId.startsWith('left')) return 'left';
  if (handleId.startsWith('right')) return 'right';
  if (handleId.startsWith('top')) return 'top';
  if (handleId.startsWith('bottom')) return 'bottom';
  return handleId;
}

function getPositionFromHandleId(handleId: string | null, fallback: Position) {
  const anchorKey = getHandleAnchorKey(handleId);
  if (anchorKey === 'left') return Position.Left;
  if (anchorKey === 'right') return Position.Right;
  if (anchorKey === 'top') return Position.Top;
  if (anchorKey === 'bottom') return Position.Bottom;
  return fallback;
}

function getAnchorCoordinates(
  geometry: NodeGeometry | undefined,
  position: Position,
  fallbackX: number,
  fallbackY: number,
) {
  if (!geometry) {
    return { x: fallbackX, y: fallbackY };
  }

  if (position === Position.Left) {
    return { x: geometry.centerX - geometry.width / 2, y: geometry.centerY };
  }
  if (position === Position.Right) {
    return { x: geometry.centerX + geometry.width / 2, y: geometry.centerY };
  }
  if (position === Position.Top) {
    return { x: geometry.centerX, y: geometry.centerY - geometry.height / 2 };
  }

  return { x: geometry.centerX, y: geometry.centerY + geometry.height / 2 };
}

function getSiblingLookupKey(nodeId: string, anchorPosition: Position) {
  return `${nodeId}:${anchorPosition}`;
}

function sortSiblingDescriptors(
  descriptors: EdgeSiblingDescriptor[],
  nodeId: string,
  anchorPosition: Position,
  nodeGeometry: Map<string, NodeGeometry>,
) {
  const anchorNode = nodeGeometry.get(nodeId);

  const getLocalMetrics = (node: NodeGeometry | undefined) => {
    if (!anchorNode || !node) {
      return {
        angle: 0,
        distance: Number.POSITIVE_INFINITY,
      };
    }

    const deltaX = node.centerX - anchorNode.centerX;
    const deltaY = node.centerY - anchorNode.centerY;

    let outward = 0;
    let tangent = 0;

    switch (anchorPosition) {
      case Position.Left:
        outward = -deltaX;
        tangent = deltaY;
        break;
      case Position.Right:
        outward = deltaX;
        tangent = deltaY;
        break;
      case Position.Top:
        outward = -deltaY;
        tangent = deltaX;
        break;
      case Position.Bottom:
      default:
        outward = deltaY;
        tangent = deltaX;
        break;
    }

    return {
      angle: Math.atan2(tangent, outward),
      distance: Math.hypot(deltaX, deltaY),
    };
  };

  descriptors.sort((left, right) => {
    const leftNode = nodeGeometry.get(left.oppositeId);
    const rightNode = nodeGeometry.get(right.oppositeId);
    const leftMetrics = getLocalMetrics(leftNode);
    const rightMetrics = getLocalMetrics(rightNode);

    if (leftMetrics.angle !== rightMetrics.angle) return leftMetrics.angle - rightMetrics.angle;
    if (leftMetrics.distance !== rightMetrics.distance)
      return leftMetrics.distance - rightMetrics.distance;
    if (left.oppositeId !== right.oppositeId)
      return left.oppositeId.localeCompare(right.oppositeId);
    return left.key.localeCompare(right.key);
  });
}

function inferEndpointPositionFromNodes(
  nodeId: string,
  oppositeId: string,
  nodeGeometry: Map<string, NodeGeometry>,
  fallback: Position,
) {
  const node = nodeGeometry.get(nodeId);
  const opposite = nodeGeometry.get(oppositeId);
  if (!node || !opposite) return fallback;

  const deltaX = opposite.centerX - node.centerX;
  const deltaY = opposite.centerY - node.centerY;

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return deltaX >= 0 ? Position.Right : Position.Left;
  }

  return deltaY >= 0 ? Position.Bottom : Position.Top;
}

function getEndpointPosition(
  edge: Pick<CanvasFlowEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>,
  endpoint: 'source' | 'target',
  nodeGeometry: Map<string, NodeGeometry>,
  fallback: Position,
) {
  if (endpoint === 'source') {
    const sourcePosition = getPositionFromHandleId(edge.sourceHandle ?? null, fallback);
    if (edge.sourceHandle) return sourcePosition;
    return inferEndpointPositionFromNodes(edge.source, edge.target, nodeGeometry, sourcePosition);
  }

  const targetPosition = getPositionFromHandleId(edge.targetHandle ?? null, fallback);
  if (edge.targetHandle) return targetPosition;
  return inferEndpointPositionFromNodes(edge.target, edge.source, nodeGeometry, targetPosition);
}

function getOrderedEndpointSiblings(
  edges: CanvasFlowEdge[],
  endpoint: 'source' | 'target',
  nodeGeometry: Map<string, NodeGeometry>,
  nodeId: string,
  anchorPosition: Position,
  requireExplicitHandle: boolean,
  siblingLookup?: EdgeSiblingLookup,
  pendingEdge?: Pick<CanvasFlowEdge, 'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'>,
) {
  const lookup = requireExplicitHandle ? siblingLookup?.explicit : siblingLookup?.all;
  const lookupKey = getSiblingLookupKey(nodeId, anchorPosition);
  if (!pendingEdge && lookup?.has(lookupKey)) {
    return lookup.get(lookupKey) ?? [];
  }

  const getSiblingDescriptors = (
    candidate: Pick<CanvasFlowEdge, 'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'>,
  ) => {
    const descriptors: Array<{ key: string; oppositeId: string }> = [];
    if (
      candidate.source === nodeId &&
      (!requireExplicitHandle || !!candidate.sourceHandle) &&
      getEndpointPosition(candidate, 'source', nodeGeometry, Position.Right) === anchorPosition
    ) {
      descriptors.push({ key: `${candidate.id}:source`, oppositeId: candidate.target });
    }
    if (
      candidate.target === nodeId &&
      (!requireExplicitHandle || !!candidate.targetHandle) &&
      getEndpointPosition(candidate, 'target', nodeGeometry, Position.Left) === anchorPosition
    ) {
      descriptors.push({ key: `${candidate.id}:target`, oppositeId: candidate.source });
    }
    return descriptors;
  };

  const siblings = edges.reduce<Array<{ key: string; oppositeId: string }>>((acc, candidate) => {
    acc.push(...getSiblingDescriptors(candidate));
    return acc;
  }, []);

  if (
    pendingEdge &&
    !siblings.some((candidate) => candidate.key === `${pendingEdge.id}:${endpoint}`)
  ) {
    siblings.push(...getSiblingDescriptors(pendingEdge));
  }

  sortSiblingDescriptors(siblings, nodeId, anchorPosition, nodeGeometry);

  return siblings;
}

function getOrthogonalFacingLaneLimit({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}) {
  if (sourcePosition === Position.Right && targetPosition === Position.Left && targetX >= sourceX) {
    return (targetX - sourceX) / 2;
  }

  if (sourcePosition === Position.Left && targetPosition === Position.Right && sourceX >= targetX) {
    return (sourceX - targetX) / 2;
  }

  if (sourcePosition === Position.Bottom && targetPosition === Position.Top && targetY >= sourceY) {
    return (targetY - sourceY) / 2;
  }

  if (sourcePosition === Position.Top && targetPosition === Position.Bottom && sourceY >= targetY) {
    return (sourceY - targetY) / 2;
  }

  return null;
}

export function getAnchoredEdgeGeometry({
  edge,
  edges,
  nodeGeometry,
  siblingLookup,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: {
  edge: Pick<CanvasFlowEdge, 'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'>;
  edges: CanvasFlowEdge[];
  nodeGeometry: Map<string, NodeGeometry>;
  siblingLookup?: EdgeSiblingLookup;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}): EdgeGeometry {
  const sourceNode = nodeGeometry.get(edge.source);
  const targetNode = nodeGeometry.get(edge.target);
  const resolvedSourcePosition = getPositionFromHandleId(edge.sourceHandle ?? null, sourcePosition);
  const resolvedTargetPosition = getPositionFromHandleId(edge.targetHandle ?? null, targetPosition);
  const sourceAnchor = getAnchorCoordinates(sourceNode, resolvedSourcePosition, sourceX, sourceY);
  const targetAnchor = getAnchorCoordinates(targetNode, resolvedTargetPosition, targetX, targetY);
  const sourceSiblings = getOrderedEndpointSiblings(
    edges,
    'source',
    nodeGeometry,
    edge.source,
    resolvedSourcePosition,
    !!edge.sourceHandle,
    siblingLookup,
    edge,
  );
  const targetSiblings = getOrderedEndpointSiblings(
    edges,
    'target',
    nodeGeometry,
    edge.target,
    resolvedTargetPosition,
    !!edge.targetHandle,
    siblingLookup,
    edge,
  );
  const sourceIndex = Math.max(
    0,
    sourceSiblings.findIndex((candidate) => candidate.key === `${edge.id}:source`),
  );
  const targetIndex = Math.max(
    0,
    targetSiblings.findIndex((candidate) => candidate.key === `${edge.id}:target`),
  );
  const sourceNodeHeight = nodeGeometry.get(edge.source)?.height ?? DEFAULT_NODE_HEIGHT;
  const targetNodeHeight = nodeGeometry.get(edge.target)?.height ?? DEFAULT_NODE_HEIGHT;
  const sourceNodeWidth = sourceNode?.width ?? 300;
  const targetNodeWidth = targetNode?.width ?? 300;
  const sourceAxisSpread = isHorizontalPosition(resolvedSourcePosition)
    ? sourceNodeHeight
    : sourceNodeWidth;
  const targetAxisSpread = isHorizontalPosition(resolvedTargetPosition)
    ? targetNodeHeight
    : targetNodeWidth;
  const normalizedSourceOffset = getSlotOffset(
    sourceIndex,
    sourceSiblings.length,
    sourceAxisSpread,
  );
  const normalizedTargetOffset = getSlotOffset(
    targetIndex,
    targetSiblings.length,
    targetAxisSpread,
  );
  const anchoredSourceX = isHorizontalPosition(resolvedSourcePosition)
    ? sourceAnchor.x
    : sourceAnchor.x + normalizedSourceOffset;
  const anchoredSourceY = isHorizontalPosition(resolvedSourcePosition)
    ? sourceAnchor.y + normalizedSourceOffset
    : sourceAnchor.y;
  const anchoredTargetX = isHorizontalPosition(resolvedTargetPosition)
    ? targetAnchor.x
    : targetAnchor.x + normalizedTargetOffset;
  const anchoredTargetY = isHorizontalPosition(resolvedTargetPosition)
    ? targetAnchor.y + normalizedTargetOffset
    : targetAnchor.y;
  const directionFromSourceX =
    resolvedSourcePosition === Position.Left
      ? -1
      : resolvedSourcePosition === Position.Right
        ? 1
        : 0;
  const directionFromSourceY =
    resolvedSourcePosition === Position.Top
      ? -1
      : resolvedSourcePosition === Position.Bottom
        ? 1
        : 0;
  const directionFromTargetX =
    resolvedTargetPosition === Position.Left
      ? -1
      : resolvedTargetPosition === Position.Right
        ? 1
        : 0;
  const directionFromTargetY =
    resolvedTargetPosition === Position.Top
      ? -1
      : resolvedTargetPosition === Position.Bottom
        ? 1
        : 0;
  const baseLaneDistance = Math.max(
    CANVAS_EDGE_LANE,
    Math.min(
      Math.max(
        Math.abs(anchoredTargetX - anchoredSourceX),
        Math.abs(anchoredTargetY - anchoredSourceY),
      ) * 0.32,
      96,
    ),
  );
  const facingLaneLimit = getOrthogonalFacingLaneLimit({
    sourceX: anchoredSourceX,
    sourceY: anchoredSourceY,
    targetX: anchoredTargetX,
    targetY: anchoredTargetY,
    sourcePosition: resolvedSourcePosition,
    targetPosition: resolvedTargetPosition,
  });
  const laneDistance =
    facingLaneLimit == null
      ? baseLaneDistance
      : Math.max(0, Math.min(baseLaneDistance, facingLaneLimit));
  const controlSourceX = anchoredSourceX + directionFromSourceX * laneDistance;
  const controlTargetX = anchoredTargetX + directionFromTargetX * laneDistance;
  const controlSourceY = anchoredSourceY + directionFromSourceY * laneDistance;
  const controlTargetY = anchoredTargetY + directionFromTargetY * laneDistance;
  const labelX = (anchoredSourceX + anchoredTargetX) / 2;
  const labelY = (anchoredSourceY + anchoredTargetY) / 2;

  return {
    sourceX: anchoredSourceX,
    sourceY: anchoredSourceY,
    controlSourceX,
    controlSourceY,
    controlTargetX,
    controlTargetY,
    targetX: anchoredTargetX,
    targetY: anchoredTargetY,
    labelX,
    labelY,
  };
}

function getNodeGeometryMap(nodes: FlowNode<CanvasNodeData>[]) {
  return new Map(
    nodes
      .filter(
        (node) =>
          !!node &&
          typeof node.id === 'string' &&
          !!node.position &&
          Number.isFinite(node.position.x) &&
          Number.isFinite(node.position.y),
      )
      .map((node) => [
        node.id,
        {
          centerX:
            (node.position.x ?? 0) +
            (typeof node.width === 'number'
              ? node.width
              : typeof node.measured?.width === 'number'
                ? node.measured.width
                : typeof node.style?.width === 'number'
                  ? node.style.width
                  : 300) /
              2,
          centerY:
            (node.position.y ?? 0) +
            (typeof node.height === 'number'
              ? node.height
              : typeof node.measured?.height === 'number'
                ? node.measured.height
                : typeof node.style?.height === 'number'
                  ? node.style.height
                  : DEFAULT_NODE_HEIGHT) /
              2,
          height:
            typeof node.height === 'number'
              ? node.height
              : typeof node.measured?.height === 'number'
                ? node.measured.height
                : typeof node.style?.height === 'number'
                  ? node.style.height
                  : DEFAULT_NODE_HEIGHT,
          width:
            typeof node.width === 'number'
              ? node.width
              : typeof node.measured?.width === 'number'
                ? node.measured.width
                : typeof node.style?.width === 'number'
                  ? node.style.width
                  : 300,
        } satisfies NodeGeometry,
      ]),
  );
}

function buildEdgeSiblingLookup(
  edges: CanvasFlowEdge[],
  nodeGeometry: Map<string, NodeGeometry>,
): EdgeSiblingLookup {
  const all = new Map<string, EdgeSiblingDescriptor[]>();
  const explicit = new Map<string, EdgeSiblingDescriptor[]>();

  const pushDescriptor = (
    lookup: Map<string, EdgeSiblingDescriptor[]>,
    nodeId: string,
    anchorPosition: Position,
    descriptor: EdgeSiblingDescriptor,
  ) => {
    const key = getSiblingLookupKey(nodeId, anchorPosition);
    const current = lookup.get(key);
    if (current) {
      current.push(descriptor);
      return;
    }
    lookup.set(key, [descriptor]);
  };

  for (const edge of edges) {
    const sourcePosition = getEndpointPosition(edge, 'source', nodeGeometry, Position.Right);
    const targetPosition = getEndpointPosition(edge, 'target', nodeGeometry, Position.Left);
    const sourceDescriptor = { key: `${edge.id}:source`, oppositeId: edge.target };
    const targetDescriptor = { key: `${edge.id}:target`, oppositeId: edge.source };

    pushDescriptor(all, edge.source, sourcePosition, sourceDescriptor);
    pushDescriptor(all, edge.target, targetPosition, targetDescriptor);

    if (edge.sourceHandle) {
      pushDescriptor(explicit, edge.source, sourcePosition, sourceDescriptor);
    }
    if (edge.targetHandle) {
      pushDescriptor(explicit, edge.target, targetPosition, targetDescriptor);
    }
  }

  for (const [key, descriptors] of all) {
    const [nodeId, position] = key.split(':');
    sortSiblingDescriptors(descriptors, nodeId, position as Position, nodeGeometry);
  }
  for (const [key, descriptors] of explicit) {
    const [nodeId, position] = key.split(':');
    sortSiblingDescriptors(descriptors, nodeId, position as Position, nodeGeometry);
  }

  return { all, explicit };
}

export function buildCanvasEdgeLayout(
  nodes: FlowNode<CanvasNodeData>[],
  edges: CanvasFlowEdge[],
): CanvasEdgeLayout {
  const nodeGeometry = getNodeGeometryMap(nodes);
  return {
    edges,
    nodeGeometry,
    siblingLookup: buildEdgeSiblingLookup(edges, nodeGeometry),
    animateReroutes: edges.length <= CANVAS_EDGE_REROUTE_LIMIT && nodes.length <= 24,
  };
}

export function CanvasEdgeLayoutProvider({
  value,
  children,
}: {
  value: CanvasEdgeLayout;
  children: ReactNode;
}) {
  return (
    <CanvasEdgeLayoutContext.Provider value={value}>{children}</CanvasEdgeLayoutContext.Provider>
  );
}

function StackedCanvasEdge(props: EdgeProps<CanvasFlowEdge>) {
  const layout = useContext(CanvasEdgeLayoutContext);
  if (!layout) {
    throw new Error('StackedCanvasEdge must be rendered within a CanvasEdgeLayoutProvider.');
  }
  const targetGeometry = useMemo(
    () =>
      getAnchoredEdgeGeometry({
        edge: props,
        edges: layout.edges,
        nodeGeometry: layout.nodeGeometry,
        siblingLookup: layout.siblingLookup,
        sourceX: props.sourceX,
        sourceY: props.sourceY,
        targetX: props.targetX,
        targetY: props.targetY,
        sourcePosition: props.sourcePosition,
        targetPosition: props.targetPosition,
      }),
    [
      layout,
      props.id,
      props.source,
      props.target,
      props.sourcePosition,
      props.sourceX,
      props.sourceY,
      props.targetPosition,
      props.targetX,
      props.targetY,
    ],
  );
  const [displayGeometry, setDisplayGeometry] = useState(targetGeometry);
  const currentGeometryRef = useRef(targetGeometry);

  useEffect(() => {
    const previous = currentGeometryRef.current;
    const next = targetGeometry;
    const changed = (Object.keys(next) as (keyof EdgeGeometry)[]).some(
      (key) => Math.abs(previous[key] - next[key]) > 0.25,
    );

    if (!changed) {
      currentGeometryRef.current = next;
      setDisplayGeometry(next);
      return;
    }

    if (!layout.animateReroutes) {
      currentGeometryRef.current = next;
      setDisplayGeometry(next);
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / CANVAS_EDGE_REROUTE_MS);
      const interpolated = interpolateGeometry(previous, next, easeOutCubic(progress));
      currentGeometryRef.current = interpolated;
      setDisplayGeometry(interpolated);
      if (progress < 1) frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [layout.animateReroutes, targetGeometry]);

  const data = getCanvasEdgeData(props.data);
  const baseStrokeWidth =
    typeof props.style?.strokeWidth === 'number'
      ? props.style.strokeWidth
      : DEFAULT_CANVAS_EDGE_STYLE.strokeWidth;
  const interactionStrokeWidth = Math.max(baseStrokeWidth + 12, 16);
  const markerStartId = getCanvasArrowMarkerIdForEdge(props.id, 'start');
  const markerEndId = getCanvasArrowMarkerIdForEdge(props.id, 'end');
  const visibleStroke = DEFAULT_EDGE_STROKE;
  const selectedHighlightStroke = 'color-mix(in oklch, var(--primary) 48%, white 22%)';
  const visibleDashArray = getEdgeDashArray(data.lineStyle);
  const visibleStrokeLinecap = data.lineStyle === 'dotted' ? 'round' : 'butt';
  const markerInset = 6;
  const sourceDirection = normalizeVector(
    displayGeometry.controlSourceX - displayGeometry.sourceX,
    displayGeometry.controlSourceY - displayGeometry.sourceY,
  );
  const targetDirection = normalizeVector(
    displayGeometry.targetX - displayGeometry.controlTargetX,
    displayGeometry.targetY - displayGeometry.controlTargetY,
  );
  const pathSourceX = props.markerStart
    ? displayGeometry.sourceX + sourceDirection.x * markerInset
    : displayGeometry.sourceX;
  const pathSourceY = props.markerStart
    ? displayGeometry.sourceY + sourceDirection.y * markerInset
    : displayGeometry.sourceY;
  const pathTargetX = props.markerEnd
    ? displayGeometry.targetX - targetDirection.x * markerInset
    : displayGeometry.targetX;
  const pathTargetY = props.markerEnd
    ? displayGeometry.targetY - targetDirection.y * markerInset
    : displayGeometry.targetY;
  const pathGeometry: EdgeGeometry = {
    ...displayGeometry,
    sourceX: pathSourceX,
    sourceY: pathSourceY,
    targetX: pathTargetX,
    targetY: pathTargetY,
  };
  const path =
    data.routingStyle === 'orthogonal'
      ? buildOrthogonalCanvasEdgePath(pathGeometry)
      : buildCanvasEdgePath(pathGeometry);
  const labelPosition =
    data.routingStyle === 'orthogonal'
      ? getOrthogonalCanvasEdgeLabelPosition(displayGeometry)
      : { x: displayGeometry.labelX, y: displayGeometry.labelY };

  return (
    <>
      <defs>
        <marker
          id={markerEndId}
          viewBox="0 0 12 10"
          refX="5.6"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="strokeWidth"
          orient="auto"
        >
          <path
            d="M10.6 5L5.2 1.6C3.6 0.6 1.6 1.75 1.6 3.62V6.38C1.6 8.25 3.6 9.4 5.2 8.4L10.6 5Z"
            fill="color-mix(in oklch, var(--primary) 82%, white 18%)"
            stroke="color-mix(in oklch, var(--background) 88%, transparent)"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M9.1 5H5.75"
            fill="none"
            stroke="color-mix(in oklch, var(--background) 84%, transparent)"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
        </marker>
        <marker
          id={markerStartId}
          viewBox="0 0 12 10"
          refX="5.6"
          refY="5"
          markerWidth="10"
          markerHeight="10"
          markerUnits="strokeWidth"
          orient="auto-start-reverse"
        >
          <path
            d="M10.6 5L5.2 1.6C3.6 0.6 1.6 1.75 1.6 3.62V6.38C1.6 8.25 3.6 9.4 5.2 8.4L10.6 5Z"
            fill="color-mix(in oklch, var(--primary) 82%, white 18%)"
            stroke="color-mix(in oklch, var(--background) 88%, transparent)"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M9.1 5H5.75"
            fill="none"
            stroke="color-mix(in oklch, var(--background) 84%, transparent)"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
        </marker>
      </defs>
      {props.selected ? (
        <path
          d={path}
          fill="none"
          stroke={selectedHighlightStroke}
          strokeWidth={baseStrokeWidth + 5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.22}
          pointerEvents="none"
        />
      ) : null}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={interactionStrokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="stroke"
      />
      <path
        d={path}
        fill="none"
        stroke={visibleStroke}
        strokeWidth={baseStrokeWidth}
        strokeLinecap={visibleStrokeLinecap}
        strokeLinejoin="round"
        strokeDasharray={visibleDashArray}
        markerStart={props.markerStart ? `url(#${markerStartId})` : undefined}
        markerEnd={props.markerEnd ? `url(#${markerEndId})` : undefined}
        style={{
          filter: props.selected
            ? 'drop-shadow(0 0 10px color-mix(in oklch, var(--primary) 35%, transparent))'
            : undefined,
        }}
      >
        {data.animated && data.lineStyle !== 'solid' ? (
          <animate
            attributeName="stroke-dashoffset"
            from={data.animationReverse ? '-18' : '18'}
            to="0"
            dur="700ms"
            repeatCount="indefinite"
          />
        ) : null}
      </path>
      {data.animated && data.lineStyle === 'solid' ? (
        <path
          d={path}
          fill="none"
          stroke={EDGE_ANIMATION_STROKE}
          strokeWidth={baseStrokeWidth + 0.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${SOLID_EDGE_ANIMATION_DASH} ${SOLID_EDGE_ANIMATION_GAP}`}
          opacity={1}
          pointerEvents="none"
          style={{
            filter: 'drop-shadow(0 0 3px color-mix(in oklch, var(--primary) 32%, transparent))',
          }}
        >
          <animate
            attributeName="stroke-dashoffset"
            from={
              data.animationReverse
                ? `-${SOLID_EDGE_ANIMATION_DASH + SOLID_EDGE_ANIMATION_GAP}`
                : `${SOLID_EDGE_ANIMATION_DASH + SOLID_EDGE_ANIMATION_GAP}`
            }
            to="0"
            dur="1200ms"
            repeatCount="indefinite"
          />
        </path>
      ) : null}
      <BaseEdge
        {...props}
        path={path}
        labelX={labelPosition.x}
        labelY={labelPosition.y}
        interactionWidth={interactionStrokeWidth}
        style={{
          stroke: 'transparent',
          strokeWidth: 0,
          opacity: 0,
        }}
      />
    </>
  );
}

export function StackedConnectionLine({
  connectionLineStyle,
  fromNode,
  fromHandle,
  fromX,
  fromY,
  fromPosition,
  toNode,
  toHandle,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps<FlowNode<CanvasNodeData>>) {
  const layout = useContext(CanvasEdgeLayoutContext);
  if (!layout) {
    throw new Error('StackedConnectionLine must be rendered within a CanvasEdgeLayoutProvider.');
  }
  const previewEdge: Pick<
    CanvasFlowEdge,
    'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'
  > = {
    id: '__canvas-connection-preview__',
    source: fromNode.id,
    sourceHandle: fromHandle.id ?? undefined,
    target: toNode?.id ?? '__pointer__',
    targetHandle: toHandle?.id ?? undefined,
  };
  const geometry = getAnchoredEdgeGeometry({
    edge: previewEdge,
    edges: layout.edges,
    nodeGeometry: layout.nodeGeometry,
    siblingLookup: layout.siblingLookup,
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });
  const path = buildCanvasEdgePath(geometry);
  const previewPath = buildOrthogonalCanvasEdgePath(geometry);

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={DEFAULT_EDGE_STROKE}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="7 7"
        style={{
          ...connectionLineStyle,
          transition: 'd 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          opacity: 0.9,
        }}
      />
      <path d={previewPath} fill="none" stroke="transparent" strokeWidth={0} />
    </g>
  );
}

export const edgeTypes = {
  stacked: StackedCanvasEdge,
};
