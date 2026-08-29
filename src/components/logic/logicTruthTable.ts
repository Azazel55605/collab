import type {
  LogicComponentDefinition,
  LogicDiagramNode,
  LogicDiagramWire,
} from '../../types/logicDiagram';

import { evaluateLogicDiagram, type LogicSignal } from './logicDiagramEvaluator';
import { logicNodeLabel } from './logicDiagramFlow';

export const DEFAULT_TRUTH_TABLE_INPUT_LIMIT = 10;

export interface LogicTruthTableColumn {
  id: string;
  label: string;
  direction: 'input' | 'output';
}

export interface LogicTruthTableRow {
  inputs: Record<string, boolean>;
  outputs: Record<string, LogicSignal>;
}

export interface LogicTruthTable {
  inputs: LogicTruthTableColumn[];
  outputs: LogicTruthTableColumn[];
  rows: LogicTruthTableRow[];
  error?: string;
}

interface TruthTableOptions {
  components?: LogicComponentDefinition[];
  inputLimit?: number;
  inputNodes?: Array<{ id: string; label: string }>;
  outputNodes?: Array<{ id: string; label: string }>;
}

function orderedNodes(nodes: LogicDiagramNode[], kinds: LogicDiagramNode['kind'][]) {
  const accepted = new Set(kinds);
  return nodes
    .filter((node) => accepted.has(node.kind))
    .slice()
    .sort(
      (a, b) =>
        a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id),
    );
}

export function generateLogicTruthTable(
  nodes: LogicDiagramNode[],
  wires: LogicDiagramWire[],
  options: TruthTableOptions = {},
): LogicTruthTable {
  const inputSources =
    options.inputNodes ??
    orderedNodes(nodes, ['input', 'clock']).map((node) => ({
      id: node.id,
      label: logicNodeLabel(node),
    }));
  const outputSources =
    options.outputNodes ??
    orderedNodes(nodes, ['output']).map((node) => ({ id: node.id, label: logicNodeLabel(node) }));
  const inputs = inputSources.map((source) => ({ ...source, direction: 'input' as const }));
  const outputs = outputSources.map((source) => ({ ...source, direction: 'output' as const }));
  const inputLimit = options.inputLimit ?? DEFAULT_TRUTH_TABLE_INPUT_LIMIT;

  if (inputs.length > inputLimit) {
    return {
      inputs,
      outputs,
      rows: [],
      error: `This circuit has ${inputs.length} inputs. Truth tables are limited to ${inputLimit} inputs (${2 ** inputLimit} rows).`,
    };
  }

  const rows: LogicTruthTableRow[] = [];
  const rowCount = 2 ** inputs.length;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowInputs: Record<string, boolean> = {};
    for (let columnIndex = 0; columnIndex < inputs.length; columnIndex += 1) {
      const bit = inputs.length - columnIndex - 1;
      rowInputs[inputs[columnIndex].id] = ((rowIndex >> bit) & 1) === 1;
    }
    const evaluation = evaluateLogicDiagram(
      nodes.map((node) =>
        Object.prototype.hasOwnProperty.call(rowInputs, node.id)
          ? { ...node, value: rowInputs[node.id] }
          : node,
      ),
      wires,
      { components: options.components },
    );
    rows.push({
      inputs: rowInputs,
      outputs: Object.fromEntries(
        outputs.map((output) => [output.id, evaluation.nodeValues[output.id]]),
      ),
    });
  }

  return { inputs, outputs, rows };
}

export function generateComponentTruthTable(
  component: LogicComponentDefinition,
  components: LogicComponentDefinition[] = [],
  inputLimit = DEFAULT_TRUTH_TABLE_INPUT_LIMIT,
) {
  return generateLogicTruthTable(component.nodes, component.wires, {
    components,
    inputLimit,
    inputNodes: component.ports
      .filter((port) => port.direction === 'input')
      .map((port) => ({ id: port.sourceNodeId, label: port.label })),
    outputNodes: component.ports
      .filter((port) => port.direction === 'output')
      .map((port) => ({ id: port.sourceNodeId, label: port.label })),
  });
}
