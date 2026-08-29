import type {
  LogicComponentDefinition,
  LogicComponentInstanceMode,
  LogicComponentPort,
  LogicDiagramDocument,
  LogicDiagramNode,
  LogicDiagramWire,
} from '../../types/logicDiagram';
import { LOGIC_DIAGRAM_SCHEMA_VERSION } from '../../types/logicDiagram';

export interface LogicComponentCaptureResult {
  component: LogicComponentDefinition;
  sourceNodeIds: Set<string>;
}

export function logicComponentNodeId() {
  return `component-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function logicComponentId(name: string) {
  const safe =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'component';
  return `logic-component-${safe}-${Date.now().toString(36)}`;
}

function portId(label: string, direction: 'input' | 'output') {
  const safe =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || direction;
  return `${direction}-${safe}`;
}

function uniquePortId(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `${base}-${Date.now()}`;
  used.add(fallback);
  return fallback;
}

function nodeLabel(node: LogicDiagramNode) {
  return node.label?.trim() || (node.kind === 'input' ? 'Input' : 'Output');
}

function cloneNode(node: LogicDiagramNode): LogicDiagramNode {
  return {
    ...node,
    position: { ...node.position },
    component: node.component
      ? {
          ...node.component,
          definition: cloneComponentDefinition(node.component.definition),
        }
      : undefined,
  };
}

function cloneWire(wire: LogicDiagramWire): LogicDiagramWire {
  return { ...wire };
}

export function cloneComponentDefinition(
  component: LogicComponentDefinition,
): LogicComponentDefinition {
  return {
    ...component,
    ports: component.ports.map((port) => ({ ...port })),
    nodes: component.nodes.map(cloneNode),
    wires: component.wires.map(cloneWire),
  };
}

export function captureLogicComponent(
  document: LogicDiagramDocument,
  selectedNodeIds: string[],
  name: string,
  description?: string,
): LogicComponentCaptureResult {
  const selected = new Set(selectedNodeIds);
  const captureAll = selected.size === 0;
  const sourceNodes = document.nodes.filter((node) => captureAll || selected.has(node.id));
  if (sourceNodes.length === 0)
    throw new Error('Select gates to save as a component, or use a non-empty logic file.');

  const sourceNodeIds = new Set(sourceNodes.map((node) => node.id));
  const internalWires = document.wires.filter(
    (wire) => sourceNodeIds.has(wire.source) && sourceNodeIds.has(wire.target),
  );
  const danglingWire = document.wires.find(
    (wire) => sourceNodeIds.has(wire.source) !== sourceNodeIds.has(wire.target),
  );
  if (danglingWire)
    throw new Error('Component selections cannot include wires that cross the selection boundary.');

  const usedPortIds = new Set<string>();
  const ports: LogicComponentPort[] = sourceNodes
    .filter((node) => node.kind === 'input' || node.kind === 'output')
    .map((node) => {
      const direction = node.kind === 'input' ? 'input' : 'output';
      const label = nodeLabel(node);
      return {
        id: uniquePortId(portId(label, direction), usedPortIds),
        label,
        direction,
        sourceNodeId: node.id,
      };
    });

  if (!ports.some((port) => port.direction === 'input')) {
    throw new Error('A component needs at least one input node.');
  }
  if (!ports.some((port) => port.direction === 'output')) {
    throw new Error('A component needs at least one output node.');
  }

  const labels = new Set<string>();
  for (const port of ports) {
    const key = `${port.direction}:${port.label.toLocaleLowerCase()}`;
    if (labels.has(key))
      throw new Error('Component input and output labels must be unique per direction.');
    labels.add(key);
  }

  const now = Date.now();
  return {
    sourceNodeIds,
    component: {
      id: logicComponentId(name),
      name: name.trim(),
      description: description?.trim() || undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ports,
      nodes: sourceNodes.map(cloneNode),
      wires: internalWires.map(cloneWire),
    },
  };
}

export function instantiateLogicComponentNode(
  component: LogicComponentDefinition,
  mode: LogicComponentInstanceMode,
  position: { x: number; y: number },
): LogicDiagramNode {
  const definition = cloneComponentDefinition(component);
  return {
    id: logicComponentNodeId(),
    kind: 'component',
    label: definition.name,
    position,
    component: {
      mode,
      componentId: definition.id,
      definition,
    },
  };
}

export function logicDocumentFromComponent(
  component: LogicComponentDefinition,
): LogicDiagramDocument {
  return {
    schemaVersion: LOGIC_DIAGRAM_SCHEMA_VERSION,
    kind: 'logic-diagram',
    diagramMode: 'logic',
    title: component.name,
    nodes: component.nodes.map(cloneNode),
    wires: component.wires.map(cloneWire),
    components: [cloneComponentDefinition(component)],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
