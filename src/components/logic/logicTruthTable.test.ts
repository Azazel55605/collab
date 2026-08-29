import { describe, expect, it } from 'vitest';

import type {
  LogicComponentDefinition,
  LogicDiagramNode,
  LogicDiagramWire,
} from '../../types/logicDiagram';

import { generateComponentTruthTable, generateLogicTruthTable } from './logicTruthTable';

function wire(id: string, source: string, target: string, targetHandle = 'in'): LogicDiagramWire {
  return { id, source, target, sourceHandle: 'out', targetHandle };
}

describe('logic truth tables', () => {
  it('calculates every input and output state for a three-input full adder', () => {
    const nodes: LogicDiagramNode[] = [
      { id: 'a', kind: 'input', label: 'A', position: { x: 0, y: 0 } },
      { id: 'b', kind: 'input', label: 'B', position: { x: 0, y: 80 } },
      { id: 'cin', kind: 'input', label: 'Cin', position: { x: 0, y: 160 } },
      { id: 'xor-ab', kind: 'xor', position: { x: 160, y: 0 } },
      { id: 'sum-gate', kind: 'xor', position: { x: 320, y: 0 } },
      { id: 'carry-ab', kind: 'and', position: { x: 160, y: 120 } },
      { id: 'carry-cin', kind: 'and', position: { x: 320, y: 120 } },
      { id: 'carry-gate', kind: 'or', position: { x: 480, y: 120 } },
      { id: 'sum', kind: 'output', label: 'Sum', position: { x: 640, y: 0 } },
      { id: 'carry', kind: 'output', label: 'Carry', position: { x: 640, y: 120 } },
    ];
    const wires = [
      wire('a-xor', 'a', 'xor-ab', 'in-a'),
      wire('b-xor', 'b', 'xor-ab', 'in-b'),
      wire('ab-sum', 'xor-ab', 'sum-gate', 'in-a'),
      wire('cin-sum', 'cin', 'sum-gate', 'in-b'),
      wire('sum-out', 'sum-gate', 'sum'),
      wire('a-carry', 'a', 'carry-ab', 'in-a'),
      wire('b-carry', 'b', 'carry-ab', 'in-b'),
      wire('ab-cin', 'xor-ab', 'carry-cin', 'in-a'),
      wire('cin-carry', 'cin', 'carry-cin', 'in-b'),
      wire('carry-ab-or', 'carry-ab', 'carry-gate', 'in-a'),
      wire('carry-cin-or', 'carry-cin', 'carry-gate', 'in-b'),
      wire('carry-out', 'carry-gate', 'carry'),
    ];

    const table = generateLogicTruthTable(nodes, wires);

    expect(table.inputs.map((column) => column.label)).toEqual(['A', 'B', 'Cin']);
    expect(table.outputs.map((column) => column.label)).toEqual(['Sum', 'Carry']);
    expect(table.rows).toHaveLength(8);
    expect(table.rows.map((row) => [row.outputs.sum, row.outputs.carry])).toEqual([
      [false, false],
      [true, false],
      [true, false],
      [false, true],
      [true, false],
      [false, true],
      [false, true],
      [true, true],
    ]);
  });

  it('uses component ports as table columns', () => {
    const component: LogicComponentDefinition = {
      id: 'inverter',
      name: 'Inverter',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ports: [
        { id: 'in', label: 'Signal', direction: 'input', sourceNodeId: 'source' },
        { id: 'out', label: 'Negated', direction: 'output', sourceNodeId: 'sink' },
      ],
      nodes: [
        { id: 'source', kind: 'input', position: { x: 0, y: 0 } },
        { id: 'not', kind: 'not', position: { x: 100, y: 0 } },
        { id: 'sink', kind: 'output', position: { x: 200, y: 0 } },
      ],
      wires: [wire('source-not', 'source', 'not'), wire('not-sink', 'not', 'sink')],
    };

    const table = generateComponentTruthTable(component);
    expect(table.inputs[0].label).toBe('Signal');
    expect(table.outputs[0].label).toBe('Negated');
    expect(table.rows.map((row) => row.outputs.sink)).toEqual([true, false]);
  });

  it('refuses tables large enough to lock the editor', () => {
    const nodes: LogicDiagramNode[] = Array.from({ length: 11 }, (_, index) => ({
      id: `input-${index}`,
      kind: 'input',
      position: { x: 0, y: index * 20 },
    }));
    const table = generateLogicTruthTable(nodes, [], { inputLimit: 10 });
    expect(table.rows).toEqual([]);
    expect(table.error).toContain('limited to 10 inputs');
  });
});
