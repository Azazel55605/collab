import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  BaseEdge,
  Position,
  useEdges,
  useNodes,
  type ConnectionLineComponentProps,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
} from '@xyflow/react';

import type { CanvasEdge, CanvasEdgeLineStyle } from '../../types/canvas';
import type { CanvasNodeData } from './CanvasNodeTypes';

const DEFAULT_NODE_HEIGHT = 180;
const CANVAS_EDGE_LANE = 30;
const CANVAS_EDGE_SLOT_SPACING = 18;
const CANVAS_EDGE_SLOT_PADDING = 26;
const CANVAS_EDGE_REROUTE_MS = 220;
const DEFAULT_EDGE_STROKE = 'color-mix(in oklch, var(--primary) 78%, white 22%)';
const EDGE_ANIMATION_STROKE = 'color-mix(in oklch, var(--primary) 90%, white 10%)';

export const DEFAULT_CANVAS_EDGE_STYLE = {
  strokeWidth: 2,
  stroke: DEFAULT_EDGE_STROKE,
  transition: 'stroke 180ms ease, filter 180ms ease, opacity 180ms ease',
} satisfies CSSProperties;

export interface CanvasEdgeData extends Record<string, unknown> {
  label?: string;
  lineStyle: CanvasEdgeLineStyle;
  animated: boolean;
  animationReverse: boolean;
  markerStart: boolean;
  markerEnd: boolean;
}

export type CanvasFlowEdge = FlowEdge<CanvasEdgeData>;

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

function normalizeVector(x: number, y: number) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

export function getCanvasEdgeData(edge?: {
  label?: string;
  lineStyle?: CanvasEdgeLineStyle;
  animated?: boolean;
  animationReverse?: boolean;
  markerStart?: boolean;
  markerEnd?: boolean;
} | null): CanvasEdgeData {
  return {
    label: edge?.label ?? '',
    lineStyle: edge?.lineStyle ?? 'solid',
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

function getSolidHighlightGradientId(edgeId: string) {
  return `canvas-edge-solid-highlight-${edgeId}`;
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

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function fromFlowEdge(edge: CanvasFlowEdge): CanvasEdge {
  const data = getCanvasEdgeData(edge.data);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: data.label || undefined,
    lineStyle: data.lineStyle,
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
  const availableSpread = Math.max(nodeHeight - CANVAS_EDGE_SLOT_PADDING * 2, CANVAS_EDGE_SLOT_SPACING);
  const spacing = Math.min(CANVAS_EDGE_SLOT_SPACING, availableSpread / (count - 1));
  return (index - (count - 1) / 2) * spacing;
}

function getOrderedSiblingEdges(
  edges: CanvasFlowEdge[],
  nodeId: string,
  direction: 'source' | 'target',
  nodeGeometry: Map<string, { centerY: number; height: number }>,
  pendingEdge?: Pick<CanvasFlowEdge, 'id' | 'source' | 'target'>,
) {
  const subjectKey = direction === 'source' ? 'source' : 'target';
  const oppositeKey = direction === 'source' ? 'target' : 'source';
  const siblings = edges
    .filter((edge) => edge[subjectKey] === nodeId)
    .map((edge) => ({ id: edge.id, oppositeId: edge[oppositeKey] }));

  if (pendingEdge && pendingEdge[subjectKey] === nodeId && !siblings.some((edge) => edge.id === pendingEdge.id)) {
    siblings.push({ id: pendingEdge.id, oppositeId: pendingEdge[oppositeKey] });
  }

  siblings.sort((left, right) => {
    const leftCenter = nodeGeometry.get(left.oppositeId)?.centerY ?? 0;
    const rightCenter = nodeGeometry.get(right.oppositeId)?.centerY ?? 0;
    if (leftCenter !== rightCenter) return leftCenter - rightCenter;
    if (left.oppositeId !== right.oppositeId) return left.oppositeId.localeCompare(right.oppositeId);
    return left.id.localeCompare(right.id);
  });

  return siblings;
}

function getAnchoredEdgeGeometry({
  edge,
  edges,
  nodeGeometry,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: {
  edge: Pick<CanvasFlowEdge, 'id' | 'source' | 'target'>;
  edges: CanvasFlowEdge[];
  nodeGeometry: Map<string, { centerY: number; height: number }>;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
}): EdgeGeometry {
  const sourceSiblings = getOrderedSiblingEdges(edges, edge.source, 'source', nodeGeometry, edge);
  const targetSiblings = getOrderedSiblingEdges(edges, edge.target, 'target', nodeGeometry, edge);
  const sourceIndex = Math.max(0, sourceSiblings.findIndex((candidate) => candidate.id === edge.id));
  const targetIndex = Math.max(0, targetSiblings.findIndex((candidate) => candidate.id === edge.id));
  const sourceNodeHeight = nodeGeometry.get(edge.source)?.height ?? DEFAULT_NODE_HEIGHT;
  const targetNodeHeight = nodeGeometry.get(edge.target)?.height ?? DEFAULT_NODE_HEIGHT;
  const sourceOffset = getSlotOffset(sourceIndex, sourceSiblings.length, sourceNodeHeight);
  const targetOffset = getSlotOffset(targetIndex, targetSiblings.length, targetNodeHeight);
  const anchoredSourceY = sourceY + sourceOffset;
  const anchoredTargetY = targetY + targetOffset;
  const directionFromSource = sourcePosition === Position.Left ? -1 : sourcePosition === Position.Right ? 1 : 0;
  const directionFromTarget = targetPosition === Position.Left ? -1 : targetPosition === Position.Right ? 1 : 0;
  const horizontalDistance = Math.max(Math.abs(targetX - sourceX), CANVAS_EDGE_LANE * 2);
  const laneDistance = Math.max(CANVAS_EDGE_LANE, Math.min(horizontalDistance * 0.38, 96));
  const controlSourceX = sourceX + directionFromSource * laneDistance;
  const controlTargetX = targetX + directionFromTarget * laneDistance;
  const controlSourceY = anchoredSourceY + sourceOffset * 0.18;
  const controlTargetY = anchoredTargetY + targetOffset * 0.18;
  const labelX = (sourceX + targetX) / 2 + (sourceOffset - targetOffset) * 0.18;
  const labelY = (anchoredSourceY + anchoredTargetY) / 2;

  return {
    sourceX,
    sourceY: anchoredSourceY,
    controlSourceX,
    controlSourceY,
    controlTargetX,
    controlTargetY,
    targetX,
    targetY: anchoredTargetY,
    labelX,
    labelY,
  };
}

function getNodeGeometryMap(nodes: FlowNode<CanvasNodeData>[]) {
  return new Map(nodes.map((node) => [
    node.id,
    {
      centerY: (node.position.y ?? 0) + (
        typeof node.height === 'number'
          ? node.height
          : typeof node.measured?.height === 'number'
            ? node.measured.height
            : typeof node.style?.height === 'number'
              ? node.style.height
              : DEFAULT_NODE_HEIGHT
      ) / 2,
      height: typeof node.height === 'number'
        ? node.height
        : typeof node.measured?.height === 'number'
          ? node.measured.height
          : typeof node.style?.height === 'number'
            ? node.style.height
            : DEFAULT_NODE_HEIGHT,
    },
  ]));
}

function StackedCanvasEdge(props: EdgeProps<CanvasFlowEdge>) {
  const edges = useEdges<CanvasFlowEdge>();
  const nodes = useNodes<FlowNode<CanvasNodeData>>();
  const nodeGeometry = useMemo(() => getNodeGeometryMap(nodes), [nodes]);
  const targetGeometry = useMemo(() => getAnchoredEdgeGeometry({
    edge: props,
    edges,
    nodeGeometry,
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  }), [
    edges,
    nodeGeometry,
    props.id,
    props.source,
    props.target,
    props.sourcePosition,
    props.sourceX,
    props.sourceY,
    props.targetPosition,
    props.targetX,
    props.targetY,
  ]);
  const [displayGeometry, setDisplayGeometry] = useState(targetGeometry);
  const currentGeometryRef = useRef(targetGeometry);

  useEffect(() => {
    const previous = currentGeometryRef.current;
    const next = targetGeometry;
    const changed = (Object.keys(next) as (keyof EdgeGeometry)[])
      .some((key) => Math.abs(previous[key] - next[key]) > 0.25);

    if (!changed) {
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
  }, [targetGeometry]);

  const data = getCanvasEdgeData(props.data);
  const baseStrokeWidth = typeof props.style?.strokeWidth === 'number'
    ? props.style.strokeWidth
    : DEFAULT_CANVAS_EDGE_STYLE.strokeWidth;
  const gradientId = getSolidHighlightGradientId(props.id);
  const markerStartId = getCanvasArrowMarkerIdForEdge(props.id, 'start');
  const markerEndId = getCanvasArrowMarkerIdForEdge(props.id, 'end');
  const [solidAnimationProgress, setSolidAnimationProgress] = useState(0);
  const visibleStroke = data.animated && data.lineStyle === 'solid'
    ? `url(#${gradientId})`
    : DEFAULT_EDGE_STROKE;
  const visibleDashArray = getEdgeDashArray(data.lineStyle);
  const visibleStrokeLinecap = data.lineStyle === 'dotted' ? 'round' : 'butt';

  useEffect(() => {
    if (!data.animated || data.lineStyle !== 'solid') {
      setSolidAnimationProgress(0);
      return;
    }

    let frameId = 0;
    const durationMs = 1600;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - startedAt) % durationMs;
      const linearProgress = elapsed / durationMs;
      setSolidAnimationProgress(data.animationReverse ? 1 - linearProgress : linearProgress);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [data.animated, data.animationReverse, data.lineStyle]);

  const solidHighlightLead = clamp01(solidAnimationProgress - 0.12);
  const solidHighlightCoreStart = clamp01(solidAnimationProgress - 0.05);
  const solidHighlightCoreEnd = clamp01(solidAnimationProgress + 0.05);
  const solidHighlightTrail = clamp01(solidAnimationProgress + 0.12);
  const markerInset = 6;
  const sourceDirection = normalizeVector(
    displayGeometry.controlSourceX - displayGeometry.sourceX,
    displayGeometry.controlSourceY - displayGeometry.sourceY,
  );
  const targetDirection = normalizeVector(
    displayGeometry.targetX - displayGeometry.controlTargetX,
    displayGeometry.targetY - displayGeometry.controlTargetY,
  );
  const pathSourceX = props.markerStart ? displayGeometry.sourceX + sourceDirection.x * markerInset : displayGeometry.sourceX;
  const pathSourceY = props.markerStart ? displayGeometry.sourceY + sourceDirection.y * markerInset : displayGeometry.sourceY;
  const pathTargetX = props.markerEnd ? displayGeometry.targetX - targetDirection.x * markerInset : displayGeometry.targetX;
  const pathTargetY = props.markerEnd ? displayGeometry.targetY - targetDirection.y * markerInset : displayGeometry.targetY;
  const pathGeometry: EdgeGeometry = {
    ...displayGeometry,
    sourceX: pathSourceX,
    sourceY: pathSourceY,
    targetX: pathTargetX,
    targetY: pathTargetY,
  };
  const path = buildCanvasEdgePath(pathGeometry);

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
      {data.animated && data.lineStyle === 'solid' ? (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={displayGeometry.sourceX - 140}
            y1={displayGeometry.sourceY}
            x2={displayGeometry.targetX + 140}
            y2={displayGeometry.targetY}
          >
            <stop offset="0%" stopColor={DEFAULT_EDGE_STROKE} />
            <stop offset={`${solidHighlightLead * 100}%`} stopColor={DEFAULT_EDGE_STROKE} />
            <stop offset={`${solidHighlightCoreStart * 100}%`} stopColor={EDGE_ANIMATION_STROKE} stopOpacity="0.25" />
            <stop offset={`${solidAnimationProgress * 100}%`} stopColor={EDGE_ANIMATION_STROKE} stopOpacity="1" />
            <stop offset={`${solidHighlightCoreEnd * 100}%`} stopColor={EDGE_ANIMATION_STROKE} stopOpacity="0.25" />
            <stop offset={`${solidHighlightTrail * 100}%`} stopColor={DEFAULT_EDGE_STROKE} />
            <stop offset="100%" stopColor={DEFAULT_EDGE_STROKE} />
          </linearGradient>
        </defs>
      ) : null}
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
          filter: props.selected ? 'drop-shadow(0 0 10px color-mix(in oklch, var(--primary) 35%, transparent))' : undefined,
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
      <BaseEdge
        {...props}
        path={path}
        labelX={displayGeometry.labelX}
        labelY={displayGeometry.labelY}
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
  fromX,
  fromY,
  fromPosition,
  toNode,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps<FlowNode<CanvasNodeData>>) {
  const edges = useEdges<CanvasFlowEdge>();
  const nodes = useNodes<FlowNode<CanvasNodeData>>();
  const nodeGeometry = useMemo(() => getNodeGeometryMap(nodes), [nodes]);
  const previewEdge: Pick<CanvasFlowEdge, 'id' | 'source' | 'target'> = {
    id: '__canvas-connection-preview__',
    source: fromNode.id,
    target: toNode?.id ?? '__pointer__',
  };
  const geometry = getAnchoredEdgeGeometry({
    edge: previewEdge,
    edges,
    nodeGeometry,
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });
  const path = buildCanvasEdgePath(geometry);

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
    </g>
  );
}

export const edgeTypes = {
  stacked: StackedCanvasEdge,
};
