import { describe, expect, it } from 'vitest';

import type {
  LogicComponentDefinition,
  LogicDiagramNode,
  LogicDiagramWire,
} from '../../types/logicDiagram';

import {
  clockSignalAt,
  componentInputHandle,
  componentOutputHandle,
  evaluateLogicDiagram,
} from './logicDiagramEvaluator';

function input(id: string, value: boolean): LogicDiagramNode {
  return { id, kind: 'input', position: { x: 0, y: 0 }, value };
}

function wire(id: string, source: string, target: string, targetHandle = 'in'): LogicDiagramWire {
  return { id, source, target, sourceHandle: 'out', targetHandle };
}

function halfAdderComponent(version = 1): LogicComponentDefinition {
  return {
    id: 'half-adder',
    name: 'Half Adder',
    version,
    createdAt: 1,
    updatedAt: version,
    ports: [
      { id: 'a', label: 'A', direction: 'input', sourceNodeId: 'a' },
      { id: 'b', label: 'B', direction: 'input', sourceNodeId: 'b' },
      { id: 'sum', label: 'Sum', direction: 'output', sourceNodeId: 'sum-out' },
      { id: 'carry', label: 'Carry', direction: 'output', sourceNodeId: 'carry-out' },
    ],
    nodes: [
      { id: 'a', kind: 'input', position: { x: 0, y: 0 } },
      { id: 'b', kind: 'input', position: { x: 0, y: 0 } },
      { id: 'xor', kind: 'xor', position: { x: 0, y: 0 } },
      { id: 'and', kind: 'and', position: { x: 0, y: 0 } },
      { id: 'sum-out', kind: 'output', position: { x: 0, y: 0 } },
      { id: 'carry-out', kind: 'output', position: { x: 0, y: 0 } },
    ],
    wires: [
      wire('a-xor', 'a', 'xor', 'in-a'),
      wire('b-xor', 'b', 'xor', 'in-b'),
      wire('a-and', 'a', 'and', 'in-a'),
      wire('b-and', 'b', 'and', 'in-b'),
      wire('xor-sum', 'xor', 'sum-out'),
      wire('and-carry', 'and', 'carry-out'),
    ],
  };
}

describe('logic diagram evaluator', () => {
  it('evaluates a clock from its period, duty cycle, and phase', () => {
    const clock = { periodMs: 1000, dutyCycle: 0.5, phaseMs: 0 };
    expect(clockSignalAt(clock, 0)).toBe(true);
    expect(clockSignalAt(clock, 499)).toBe(true);
    expect(clockSignalAt(clock, 500)).toBe(false);
    expect(clockSignalAt(clock, 1000)).toBe(true);

    const result = evaluateLogicDiagram(
      [{ id: 'clock', kind: 'clock', position: { x: 0, y: 0 }, clock }],
      [],
      { clockElapsedMs: 750 },
    );
    expect(result.nodeValues.clock).toBe(false);
  });
  it('evaluates basic supported gates', () => {
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', false),
      { id: 'and', kind: 'and', position: { x: 0, y: 0 } },
      { id: 'or', kind: 'or', position: { x: 0, y: 0 } },
      { id: 'xor', kind: 'xor', position: { x: 0, y: 0 } },
      { id: 'nand', kind: 'nand', position: { x: 0, y: 0 } },
      { id: 'nor', kind: 'nor', position: { x: 0, y: 0 } },
      { id: 'xnor', kind: 'xnor', position: { x: 0, y: 0 } },
      { id: 'not', kind: 'not', position: { x: 0, y: 0 } },
    ];
    const wires: LogicDiagramWire[] = [
      wire('a-and', 'a', 'and', 'in-a'),
      wire('b-and', 'b', 'and', 'in-b'),
      wire('a-or', 'a', 'or', 'in-a'),
      wire('b-or', 'b', 'or', 'in-b'),
      wire('a-xor', 'a', 'xor', 'in-a'),
      wire('b-xor', 'b', 'xor', 'in-b'),
      wire('a-nand', 'a', 'nand', 'in-a'),
      wire('b-nand', 'b', 'nand', 'in-b'),
      wire('a-nor', 'a', 'nor', 'in-a'),
      wire('b-nor', 'b', 'nor', 'in-b'),
      wire('a-xnor', 'a', 'xnor', 'in-a'),
      wire('b-xnor', 'b', 'xnor', 'in-b'),
      wire('b-not', 'b', 'not'),
    ];

    const result = evaluateLogicDiagram(nodes, wires);

    expect(result.nodeValues).toMatchObject({
      and: false,
      or: true,
      xor: true,
      nand: true,
      nor: false,
      xnor: false,
      not: true,
    });
    expect(result.wireValues).toMatchObject({
      'a-and': true,
      'b-and': false,
      'b-not': false,
    });
    expect(result.warnings).toEqual([]);
  });

  it('evaluates a half adder', () => {
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', true),
      { id: 'sum', kind: 'xor', position: { x: 0, y: 0 } },
      { id: 'carry', kind: 'and', position: { x: 0, y: 0 } },
    ];
    const wires: LogicDiagramWire[] = [
      wire('a-sum', 'a', 'sum', 'in-a'),
      wire('b-sum', 'b', 'sum', 'in-b'),
      wire('a-carry', 'a', 'carry', 'in-a'),
      wire('b-carry', 'b', 'carry', 'in-b'),
    ];

    expect(evaluateLogicDiagram(nodes, wires).nodeValues).toMatchObject({
      sum: false,
      carry: true,
    });
  });

  it('evaluates a full adder', () => {
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', true),
      input('cin', true),
      { id: 'xor1', kind: 'xor', position: { x: 0, y: 0 } },
      { id: 'sum', kind: 'xor', position: { x: 0, y: 0 } },
      { id: 'carry1', kind: 'and', position: { x: 0, y: 0 } },
      { id: 'carry2', kind: 'and', position: { x: 0, y: 0 } },
      { id: 'cout', kind: 'or', position: { x: 0, y: 0 } },
    ];
    const wires: LogicDiagramWire[] = [
      wire('a-xor1', 'a', 'xor1', 'in-a'),
      wire('b-xor1', 'b', 'xor1', 'in-b'),
      wire('xor1-sum', 'xor1', 'sum', 'in-a'),
      wire('cin-sum', 'cin', 'sum', 'in-b'),
      wire('a-carry1', 'a', 'carry1', 'in-a'),
      wire('b-carry1', 'b', 'carry1', 'in-b'),
      wire('xor1-carry2', 'xor1', 'carry2', 'in-a'),
      wire('cin-carry2', 'cin', 'carry2', 'in-b'),
      wire('carry1-cout', 'carry1', 'cout', 'in-a'),
      wire('carry2-cout', 'carry2', 'cout', 'in-b'),
    ];

    expect(evaluateLogicDiagram(nodes, wires).nodeValues).toMatchObject({
      sum: true,
      cout: true,
    });
  });

  it('surfaces missing and duplicate input warnings without throwing', () => {
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', false),
      { id: 'and', kind: 'and', position: { x: 0, y: 0 } },
    ];
    const wires = [wire('a-and', 'a', 'and', 'in-a'), wire('b-and', 'b', 'and', 'in-a')];

    const result = evaluateLogicDiagram(nodes, wires);

    expect(result.nodeValues.and).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'duplicate-input',
      'missing-input',
    ]);
  });

  it('surfaces cycles without throwing', () => {
    const nodes: LogicDiagramNode[] = [
      { id: 'not-a', kind: 'not', position: { x: 0, y: 0 } },
      { id: 'not-b', kind: 'not', position: { x: 0, y: 0 } },
    ];
    const wires = [wire('a-b', 'not-a', 'not-b'), wire('b-a', 'not-b', 'not-a')];

    const result = evaluateLogicDiagram(nodes, wires);

    expect(result.nodeValues['not-a']).toBeUndefined();
    expect(result.nodeValues['not-b']).toBeUndefined();
    expect(result.warnings.some((warning) => warning.code === 'cycle')).toBe(true);
  });

  it('evaluates a snapshot component as a single multi-output node', () => {
    const component = halfAdderComponent();
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', true),
      {
        id: 'ha',
        kind: 'component',
        position: { x: 0, y: 0 },
        component: { mode: 'snapshot', componentId: component.id, definition: component },
      },
      { id: 'sum', kind: 'output', position: { x: 0, y: 0 } },
      { id: 'carry', kind: 'output', position: { x: 0, y: 0 } },
    ];
    const wires: LogicDiagramWire[] = [
      {
        id: 'a-ha',
        source: 'a',
        target: 'ha',
        sourceHandle: 'out',
        targetHandle: componentInputHandle('a'),
      },
      {
        id: 'b-ha',
        source: 'b',
        target: 'ha',
        sourceHandle: 'out',
        targetHandle: componentInputHandle('b'),
      },
      {
        id: 'ha-sum',
        source: 'ha',
        target: 'sum',
        sourceHandle: componentOutputHandle('sum'),
        targetHandle: 'in',
      },
      {
        id: 'ha-carry',
        source: 'ha',
        target: 'carry',
        sourceHandle: componentOutputHandle('carry'),
        targetHandle: 'in',
      },
    ];

    const result = evaluateLogicDiagram(nodes, wires);

    expect(result.nodeValues.sum).toBe(false);
    expect(result.nodeValues.carry).toBe(true);
    expect(result.wireValues['ha-sum']).toBe(false);
    expect(result.wireValues['ha-carry']).toBe(true);
    expect(result.nodeOutputValues.ha).toEqual({
      [componentOutputHandle('sum')]: false,
      [componentOutputHandle('carry')]: true,
    });
  });

  it('uses the latest library definition for linked components', () => {
    const snapshot = halfAdderComponent(1);
    const latest = {
      ...halfAdderComponent(2),
      ports: snapshot.ports,
      nodes: snapshot.nodes.map((node) =>
        node.id === 'and' ? { ...node, kind: 'or' as const } : node,
      ),
    };
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', false),
      {
        id: 'ha',
        kind: 'component',
        position: { x: 0, y: 0 },
        component: { mode: 'linked', componentId: snapshot.id, definition: snapshot },
      },
      { id: 'carry', kind: 'output', position: { x: 0, y: 0 } },
    ];
    const wires: LogicDiagramWire[] = [
      {
        id: 'a-ha',
        source: 'a',
        target: 'ha',
        sourceHandle: 'out',
        targetHandle: componentInputHandle('a'),
      },
      {
        id: 'b-ha',
        source: 'b',
        target: 'ha',
        sourceHandle: 'out',
        targetHandle: componentInputHandle('b'),
      },
      {
        id: 'ha-carry',
        source: 'ha',
        target: 'carry',
        sourceHandle: componentOutputHandle('carry'),
        targetHandle: 'in',
      },
    ];

    expect(evaluateLogicDiagram(nodes, wires).nodeValues.carry).toBe(false);
    expect(evaluateLogicDiagram(nodes, wires, { components: [latest] }).nodeValues.carry).toBe(
      true,
    );
  });

  it('falls back to cached linked component definitions when the library entry is missing', () => {
    const component = halfAdderComponent();
    const nodes: LogicDiagramNode[] = [
      input('a', true),
      input('b', false),
      {
        id: 'ha',
        kind: 'component',
        label: 'HA',
        position: { x: 0, y: 0 },
        component: { mode: 'linked', componentId: component.id, definition: component },
      },
      { id: 'sum', kind: 'output', position: { x: 0, y: 0 } },
    ];
    const wires: LogicDiagramWire[] = [
      {
        id: 'a-ha',
        source: 'a',
        target: 'ha',
        sourceHandle: 'out',
        targetHandle: componentInputHandle('a'),
      },
      {
        id: 'b-ha',
        source: 'b',
        target: 'ha',
        sourceHandle: 'out',
        targetHandle: componentInputHandle('b'),
      },
      {
        id: 'ha-sum',
        source: 'ha',
        target: 'sum',
        sourceHandle: componentOutputHandle('sum'),
        targetHandle: 'in',
      },
    ];

    const result = evaluateLogicDiagram(nodes, wires);

    expect(result.nodeValues.sum).toBe(true);
    expect(result.warnings.some((warning) => warning.code === 'missing-component')).toBe(true);
  });
});
