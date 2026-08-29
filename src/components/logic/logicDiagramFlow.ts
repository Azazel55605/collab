import type { Edge, Node } from '@xyflow/react';

import type {
  LogicComponentInstance,
  LogicDiagramDocument,
  LogicDiagramNode,
  LogicDiagramWire,
  SchematicRotation,
} from '../../types/logicDiagram';
import { isElectronicComponentKind } from '../../types/logicDiagram';

import { getSchematicSymbol } from './schematicSymbols';

export interface LogicFlowNodeData extends Record<string, unknown> {
  kind: LogicDiagramNode['kind'];
  label?: string;
  value?: boolean;
  clock?: LogicDiagramNode['clock'];
  rotation?: SchematicRotation;
  electrical?: LogicDiagramNode['electrical'];
  evaluatedValue?: boolean;
  inputSignals?: Record<string, boolean | undefined>;
  outputSignals?: Record<string, boolean | undefined>;
  component?: LogicComponentInstance;
}

export interface LogicFlowEdgeData extends Record<string, unknown> {
  signal?: boolean;
  analogVoltage?: number;
}

export type LogicFlowNode = Node<LogicFlowNodeData, 'logicGate'>;
export type LogicFlowEdge = Edge<LogicFlowEdgeData, 'logicWire'>;

export const LOGIC_COMPONENT_WIDTH = 176;
export const LOGIC_COMPONENT_MIN_HEIGHT = 80;
export const LOGIC_COMPONENT_PORT_SPACING = 24;

export function logicComponentDimensions(component?: LogicComponentInstance) {
  const inputCount =
    component?.definition.ports.filter((port) => port.direction === 'input').length ?? 0;
  const outputCount =
    component?.definition.ports.filter((port) => port.direction === 'output').length ?? 0;
  const rows = Math.max(1, inputCount, outputCount);
  return {
    width: LOGIC_COMPONENT_WIDTH,
    height: Math.max(LOGIC_COMPONENT_MIN_HEIGHT, 48 + (rows - 1) * LOGIC_COMPONENT_PORT_SPACING),
  };
}

export function logicHandleYOffset(
  kind: LogicDiagramNode['kind'],
  count: number,
  index: number,
  height: number,
) {
  if (count <= 1) return height / 2;
  if (kind === 'component') {
    return height / 2 + (index - (count - 1) / 2) * LOGIC_COMPONENT_PORT_SPACING;
  }
  return height * ((index + 1) / (count + 1));
}

export function logicNodeLabel(node: Pick<LogicDiagramNode, 'kind' | 'label'>) {
  if (node.label?.trim()) return node.label.trim();
  switch (node.kind) {
    case 'input':
      return 'Input';
    case 'clock':
      return 'Clock';
    case 'output':
      return 'Output';
    case 'group':
      return 'Group';
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'not':
      return 'NOT';
    case 'xor':
      return 'XOR';
    case 'nand':
      return 'NAND';
    case 'nor':
      return 'NOR';
    case 'xnor':
      return 'XNOR';
    case 'component':
      return 'Component';
    default:
      return isElectronicComponentKind(node.kind)
        ? getSchematicSymbol(node.kind).label
        : 'Component';
  }
}

function getNodeWidth(node: LogicFlowNode) {
  return (
    numericStyleValue(node.style?.width) ??
    numericStyleValue(node.width) ??
    numericStyleValue(node.measured?.width)
  );
}

function getNodeHeight(node: LogicFlowNode) {
  return (
    numericStyleValue(node.style?.height) ??
    numericStyleValue(node.height) ??
    numericStyleValue(node.measured?.height)
  );
}

function toFlowNode(node: LogicDiagramNode, parent?: LogicDiagramNode): LogicFlowNode {
  return {
    id: node.id,
    type: 'logicGate',
    position: parent
      ? {
          x: node.position.x - parent.position.x,
          y: node.position.y - parent.position.y,
        }
      : node.position,
    data: {
      kind: node.kind,
      label: node.label,
      value: node.value,
      clock: node.clock,
      rotation: node.rotation,
      electrical: node.electrical,
      component: node.component,
    },
    parentId: node.parentId,
    extent: node.parentId ? 'parent' : undefined,
    zIndex: node.kind === 'group' ? 0 : 1,
    style:
      node.width || node.height
        ? {
            width: node.width,
            height: node.height,
          }
        : undefined,
  };
}

function fromFlowNode(node: LogicFlowNode, parent?: LogicFlowNode): LogicDiagramNode {
  return {
    id: node.id,
    kind: node.data.kind,
    position: parent
      ? {
          x: parent.position.x + node.position.x,
          y: parent.position.y + node.position.y,
        }
      : node.position,
    label: typeof node.data.label === 'string' ? node.data.label : undefined,
    value: typeof node.data.value === 'boolean' ? node.data.value : undefined,
    clock: node.data.kind === 'clock' ? node.data.clock : undefined,
    rotation: isElectronicComponentKind(node.data.kind) ? (node.data.rotation ?? 0) : undefined,
    electrical: isElectronicComponentKind(node.data.kind) ? node.data.electrical : undefined,
    parentId: typeof node.parentId === 'string' ? node.parentId : undefined,
    // Only groups carry an explicit size; gate nodes are intrinsically sized, so
    // persisting their measured pixel dimensions would make the serialized
    // document churn on every open once React Flow measures them.
    width: node.data.kind === 'group' ? getNodeWidth(node) : undefined,
    height: node.data.kind === 'group' ? getNodeHeight(node) : undefined,
    component: node.data.kind === 'component' ? node.data.component : undefined,
  };
}

export function toFlowEdge(wire: LogicDiagramWire): LogicFlowEdge {
  return {
    id: wire.id,
    source: wire.source,
    target: wire.target,
    sourceHandle: wire.sourceHandle,
    targetHandle: wire.targetHandle,
    label: wire.label,
    type: 'logicWire',
  };
}

export function fromFlowEdge(edge: LogicFlowEdge): LogicDiagramWire {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    label: typeof edge.label === 'string' ? edge.label : undefined,
  };
}

export function toFlowGraph(diagram: LogicDiagramDocument) {
  const nodesById = new Map(diagram.nodes.map((node) => [node.id, node]));
  const sortedNodes = [...diagram.nodes].sort((a, b) => {
    if (b.parentId === a.id) return -1;
    if (a.parentId === b.id) return 1;
    return 0;
  });

  return {
    nodes: sortedNodes.map((node) =>
      toFlowNode(node, node.parentId ? nodesById.get(node.parentId) : undefined),
    ),
    edges: diagram.wires.map(toFlowEdge),
    viewport: diagram.viewport,
  };
}

export function fromFlowGraph(
  base: LogicDiagramDocument,
  nodes: LogicFlowNode[],
  edges: LogicFlowEdge[],
  viewport: LogicDiagramDocument['viewport'],
): LogicDiagramDocument {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return {
    ...base,
    nodes: nodes.map((node) =>
      fromFlowNode(node, node.parentId ? nodesById.get(node.parentId) : undefined),
    ),
    wires: edges.map(fromFlowEdge),
    viewport,
  };
}

function numericStyleValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
