import type {
  LogicClockConfig,
  LogicComponentDefinition,
  LogicComponentInstance,
  LogicDiagramNode,
  LogicDiagramWire,
  LogicGateKind,
} from '../../types/logicDiagram';
import { isLogicGateKind } from '../../types/logicDiagram';
import { isElectronicComponentKind } from '../../types/logicDiagram';

import { getSchematicSymbol } from './schematicSymbols';

export type LogicSignal = boolean | undefined;

export interface LogicEvaluationWarning {
  code: 'missing-input' | 'cycle' | 'duplicate-input' | 'missing-component';
  nodeId: string;
  message: string;
}

export interface LogicEvaluationResult {
  nodeValues: Record<string, LogicSignal>;
  nodeOutputValues: Record<string, Record<string, LogicSignal>>;
  wireValues: Record<string, LogicSignal>;
  warnings: LogicEvaluationWarning[];
}

export interface LogicEvaluationOptions {
  components?: LogicComponentDefinition[];
  clockElapsedMs?: number;
}

export function clockSignalAt(clock: LogicClockConfig | undefined, elapsedMs: number) {
  const periodMs = Math.max(100, clock?.periodMs ?? 1000);
  const dutyCycle = Math.min(0.95, Math.max(0.05, clock?.dutyCycle ?? 0.5));
  const phaseMs = Math.max(0, clock?.phaseMs ?? 0);
  const position = (((elapsedMs + phaseMs) % periodMs) + periodMs) % periodMs;
  return position < periodMs * dutyCycle;
}

export function componentInputHandle(portId: string) {
  return `in:${portId}`;
}

export function componentOutputHandle(portId: string) {
  return `out:${portId}`;
}

export function getLogicInputHandles(
  kind: LogicDiagramNode['kind'],
  component?: LogicComponentInstance,
) {
  if (isElectronicComponentKind(kind)) return getSchematicSymbol(kind).inputHandles;
  if (kind === 'component') {
    return (
      component?.definition.ports
        .filter((port) => port.direction === 'input')
        .map((port) => componentInputHandle(port.id)) ?? []
    );
  }
  if (!isLogicGateKind(kind) || kind === 'input' || kind === 'clock' || kind === 'group') return [];
  if (kind === 'not' || kind === 'output') return ['in'];
  return ['in-a', 'in-b'];
}

export function getLogicOutputHandles(
  kind: LogicDiagramNode['kind'],
  component?: LogicComponentInstance,
) {
  if (isElectronicComponentKind(kind)) return getSchematicSymbol(kind).outputHandles;
  if (kind === 'component') {
    return (
      component?.definition.ports
        .filter((port) => port.direction === 'output')
        .map((port) => componentOutputHandle(port.id)) ?? []
    );
  }
  if (!isLogicGateKind(kind) || kind === 'output' || kind === 'group') return [];
  return ['out'];
}

function fallbackInputHandle(kind: LogicDiagramNode['kind'], component?: LogicComponentInstance) {
  return getLogicInputHandles(kind, component)[0];
}

function normalizeTargetHandle(wire: LogicDiagramWire, target: LogicDiagramNode) {
  const handles = getLogicInputHandles(target.kind, target.component);
  return wire.targetHandle && handles.includes(wire.targetHandle)
    ? wire.targetHandle
    : fallbackInputHandle(target.kind, target.component);
}

function normalizeSourceHandle(wire: LogicDiagramWire, source: LogicDiagramNode) {
  const handles = getLogicOutputHandles(source.kind, source.component);
  return wire.sourceHandle && handles.includes(wire.sourceHandle) ? wire.sourceHandle : handles[0];
}

function evaluateGate(kind: LogicGateKind, inputs: LogicSignal[]) {
  if (inputs.some((input) => typeof input !== 'boolean')) return undefined;
  switch (kind) {
    case 'output':
      return inputs[0];
    case 'not':
      return !inputs[0];
    case 'and':
      return inputs[0] && inputs[1];
    case 'or':
      return inputs[0] || inputs[1];
    case 'xor':
      return inputs[0] !== inputs[1];
    case 'nand':
      return !(inputs[0] && inputs[1]);
    case 'nor':
      return !(inputs[0] || inputs[1]);
    case 'xnor':
      return inputs[0] === inputs[1];
    case 'input':
    case 'clock':
    case 'group':
      return undefined;
  }
}

export function evaluateLogicDiagram(
  nodes: LogicDiagramNode[],
  wires: LogicDiagramWire[],
  options: LogicEvaluationOptions = {},
): LogicEvaluationResult {
  const libraryById = new Map(
    (options.components ?? []).map((component) => [component.id, component]),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incomingByNode = new Map<string, LogicDiagramWire[]>();
  for (const wire of wires) {
    const incoming = incomingByNode.get(wire.target) ?? [];
    incoming.push(wire);
    incomingByNode.set(wire.target, incoming);
  }

  const nodeValues: Record<string, LogicSignal> = {};
  const nodeOutputs: Record<string, Record<string, LogicSignal>> = {};
  const wireValues: Record<string, LogicSignal> = {};
  const warnings: LogicEvaluationWarning[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleNodes = new Set<string>();
  const warned = new Set<string>();

  const warnOnce = (warning: LogicEvaluationWarning) => {
    const key = `${warning.code}:${warning.nodeId}:${warning.message}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(warning);
  };

  const evaluateNodeOutputs = (nodeId: string): Record<string, LogicSignal> => {
    if (visited.has(nodeId)) return nodeOutputs[nodeId] ?? {};
    const node = nodeById.get(nodeId);
    if (!node || node.kind === 'group') return {};

    if (visiting.has(nodeId)) {
      cycleNodes.add(nodeId);
      warnOnce({
        code: 'cycle',
        nodeId,
        message: `Cycle detected at ${node.label ?? node.id}.`,
      });
      nodeValues[nodeId] = undefined;
      nodeOutputs[nodeId] = {};
      return {};
    }

    visiting.add(nodeId);

    if (node.kind === 'input' || node.kind === 'clock') {
      const value =
        typeof node.value === 'boolean'
          ? node.value
          : node.kind === 'clock'
            ? clockSignalAt(node.clock, options.clockElapsedMs ?? 0)
            : undefined;
      nodeValues[node.id] = value;
      nodeOutputs[node.id] = { out: value };
    } else if (node.kind === 'component') {
      nodeOutputs[node.id] = evaluateComponentNode(node);
      const firstOutput = getLogicOutputHandles(node.kind, node.component)[0];
      nodeValues[node.id] = firstOutput ? nodeOutputs[node.id][firstOutput] : undefined;
    } else if (isLogicGateKind(node.kind)) {
      const handles = getLogicInputHandles(node.kind);
      const incoming = incomingByNode.get(node.id) ?? [];
      const inputValues = handles.map((handleId) => {
        const matching = incoming.filter((wire) => normalizeTargetHandle(wire, node) === handleId);
        if (matching.length === 0) {
          warnOnce({
            code: 'missing-input',
            nodeId: node.id,
            message: `${node.label ?? node.id} is missing ${handleId}.`,
          });
          return undefined;
        }
        if (matching.length > 1) {
          warnOnce({
            code: 'duplicate-input',
            nodeId: node.id,
            message: `${node.label ?? node.id} has multiple wires on ${handleId}.`,
          });
        }

        const wire = matching[0];
        const source = nodeById.get(wire.source);
        if (!source) return undefined;
        const sourceHandle = normalizeSourceHandle(wire, source);
        const value = evaluateNodeOutput(wire.source, sourceHandle);
        wireValues[wire.id] = value;
        return value;
      });
      const value = evaluateGate(node.kind, inputValues);
      nodeValues[node.id] = value;
      nodeOutputs[node.id] = { out: value };
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    return nodeOutputs[nodeId] ?? {};
  };

  const evaluateNodeOutput = (nodeId: string, sourceHandle?: string): LogicSignal => {
    const outputs = evaluateNodeOutputs(nodeId);
    if (sourceHandle && sourceHandle in outputs) return outputs[sourceHandle];
    return nodeValues[nodeId];
  };

  const evaluateComponentNode = (node: LogicDiagramNode): Record<string, LogicSignal> => {
    const instance = node.component;
    if (!instance) return {};
    const linkedDefinition =
      instance.mode === 'linked' && instance.componentId
        ? libraryById.get(instance.componentId)
        : null;
    const definition = linkedDefinition ?? instance.definition;
    if (instance.mode === 'linked' && instance.componentId && !linkedDefinition) {
      warnOnce({
        code: 'missing-component',
        nodeId: node.id,
        message: `${node.label ?? definition.name} uses a cached component because the linked definition is unavailable.`,
      });
    }

    const externalInputs: Record<string, LogicSignal> = {};
    for (const port of definition.ports.filter((candidate) => candidate.direction === 'input')) {
      const handleId = componentInputHandle(port.id);
      const incoming = (incomingByNode.get(node.id) ?? []).filter(
        (wire) => normalizeTargetHandle(wire, node) === handleId,
      );
      if (incoming.length === 0) {
        warnOnce({
          code: 'missing-input',
          nodeId: node.id,
          message: `${node.label ?? definition.name} is missing ${port.label}.`,
        });
        externalInputs[port.sourceNodeId] = undefined;
        continue;
      }
      if (incoming.length > 1) {
        warnOnce({
          code: 'duplicate-input',
          nodeId: node.id,
          message: `${node.label ?? definition.name} has multiple wires on ${port.label}.`,
        });
      }
      const wire = incoming[0];
      const source = nodeById.get(wire.source);
      if (!source) {
        externalInputs[port.sourceNodeId] = undefined;
        continue;
      }
      const sourceHandle = normalizeSourceHandle(wire, source);
      const value = evaluateNodeOutput(wire.source, sourceHandle);
      wireValues[wire.id] = value;
      externalInputs[port.sourceNodeId] = value;
    }

    const internalNodes = definition.nodes.map((internalNode) =>
      internalNode.kind === 'input'
        ? { ...internalNode, value: externalInputs[internalNode.id] }
        : internalNode,
    );
    const internal = evaluateLogicDiagram(internalNodes, definition.wires, options);
    for (const warning of internal.warnings) {
      warnOnce({
        ...warning,
        nodeId: node.id,
        message: `${node.label ?? definition.name}: ${warning.message}`,
      });
    }

    const outputs: Record<string, LogicSignal> = {};
    for (const port of definition.ports.filter((candidate) => candidate.direction === 'output')) {
      outputs[componentOutputHandle(port.id)] = internal.nodeValues[port.sourceNodeId];
    }
    return outputs;
  };

  for (const node of nodes) evaluateNodeOutputs(node.id);

  for (const wire of wires) {
    if (!(wire.id in wireValues)) {
      const source = nodeById.get(wire.source);
      const sourceHandle = source ? normalizeSourceHandle(wire, source) : undefined;
      wireValues[wire.id] = cycleNodes.has(wire.source)
        ? undefined
        : evaluateNodeOutput(wire.source, sourceHandle);
    }
  }

  return { nodeValues, nodeOutputValues: nodeOutputs, wireValues, warnings };
}
