import { describe, expect, it } from 'vitest';

import { createEmptyLogicDiagram } from '../../types/logicDiagram';

import {
  fromFlowGraph,
  logicComponentDimensions,
  logicHandleYOffset,
  logicNodeLabel,
  toFlowGraph,
} from './logicDiagramFlow';

describe('logic diagram flow helpers', () => {
  it('maps logic diagrams to React Flow graph data and back', () => {
    const diagram = {
      ...createEmptyLogicDiagram('Half Adder'),
      nodes: [
        { id: 'a', kind: 'input' as const, position: { x: 0, y: 0 }, label: 'A', value: false },
        {
          id: 'group-1',
          kind: 'group' as const,
          position: { x: -48, y: -48 },
          width: 304,
          height: 160,
        },
        { id: 'sum', kind: 'xor' as const, position: { x: 208, y: 48 }, parentId: 'group-1' },
      ],
      wires: [
        {
          id: 'w1',
          source: 'a',
          target: 'sum',
          sourceHandle: 'out',
          targetHandle: 'in-a',
          label: 'A',
        },
      ],
      viewport: { x: 10, y: 20, zoom: 1.5 },
    };

    const graph = toFlowGraph(diagram);
    expect(graph.nodes[0]).toMatchObject({
      id: 'a',
      type: 'logicGate',
      data: { kind: 'input', label: 'A', value: false },
    });
    expect(graph.edges[0]).toMatchObject({
      id: 'w1',
      source: 'a',
      target: 'sum',
      type: 'logicWire',
    });
    expect(graph.nodes[1]).toMatchObject({
      id: 'group-1',
      style: { width: 304, height: 160 },
    });
    expect(graph.nodes[2]).toMatchObject({
      id: 'sum',
      parentId: 'group-1',
      extent: 'parent',
      position: { x: 256, y: 96 },
    });

    expect(fromFlowGraph(diagram, graph.nodes, graph.edges, graph.viewport)).toEqual(diagram);
  });

  it('does not persist measured pixel sizes onto gate nodes', () => {
    const diagram = createEmptyLogicDiagram('Sizing');
    // Simulate React Flow after it has measured the nodes: gates gain a measured
    // size, while a group keeps its explicit style size.
    const measuredNodes = [
      {
        id: 'g1',
        type: 'logicGate' as const,
        position: { x: 0, y: 0 },
        data: { kind: 'and' as const },
        width: 112,
        height: 64,
        measured: { width: 112, height: 64 },
      },
      {
        id: 'group-1',
        type: 'logicGate' as const,
        position: { x: -48, y: -48 },
        data: { kind: 'group' as const, label: 'Group' },
        style: { width: 280, height: 180 },
        measured: { width: 280, height: 180 },
      },
    ];

    const result = fromFlowGraph(diagram, measuredNodes, [], diagram.viewport);
    const gate = result.nodes.find((node) => node.id === 'g1');
    const group = result.nodes.find((node) => node.id === 'group-1');
    expect(gate?.width).toBeUndefined();
    expect(gate?.height).toBeUndefined();
    expect(group?.width).toBe(280);
    expect(group?.height).toBe(180);
  });

  it('uses readable default labels for gate kinds', () => {
    expect(logicNodeLabel({ kind: 'nand' })).toBe('NAND');
    expect(logicNodeLabel({ kind: 'clock' })).toBe('Clock');
    expect(logicNodeLabel({ kind: 'group' })).toBe('Group');
    expect(logicNodeLabel({ kind: 'input', label: 'Clock' })).toBe('Clock');
  });

  it('round-trips persisted clock timing', () => {
    const diagram = {
      ...createEmptyLogicDiagram('Clocked'),
      nodes: [
        {
          id: 'clock',
          kind: 'clock' as const,
          position: { x: 10, y: 20 },
          clock: { periodMs: 500, dutyCycle: 0.25, phaseMs: 50 },
        },
      ],
    };

    const graph = toFlowGraph(diagram);
    expect(graph.nodes[0].data.clock).toEqual({ periodMs: 500, dutyCycle: 0.25, phaseMs: 50 });
    expect(fromFlowGraph(diagram, graph.nodes, graph.edges, graph.viewport)).toEqual(diagram);
  });

  it('round-trips schematic symbol rotation', () => {
    const diagram = {
      ...createEmptyLogicDiagram('Rotated', 'schematic'),
      nodes: [
        {
          id: 'r1',
          kind: 'resistor' as const,
          position: { x: 10, y: 20 },
          rotation: 270 as const,
          electrical: { resistanceOhms: 4700 },
        },
      ],
    };
    const graph = toFlowGraph(diagram);
    expect(graph.nodes[0].data.rotation).toBe(270);
    expect(graph.nodes[0].data.electrical).toEqual({ resistanceOhms: 4700 });
    expect(fromFlowGraph(diagram, graph.nodes, graph.edges, graph.viewport)).toEqual(diagram);
  });

  it('grows custom components and centers arbitrary port counts', () => {
    const component = {
      id: 'mux',
      name: 'Multiplexer',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ports: [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `in-${index}`,
          label: `In ${index}`,
          direction: 'input' as const,
          sourceNodeId: `in-${index}`,
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `out-${index}`,
          label: `Out ${index}`,
          direction: 'output' as const,
          sourceNodeId: `out-${index}`,
        })),
      ],
      nodes: [],
      wires: [],
    };

    const dimensions = logicComponentDimensions({
      mode: 'snapshot',
      componentId: component.id,
      definition: component,
    });
    expect(dimensions.height).toBeGreaterThan(80);

    const inputs = Array.from({ length: 5 }, (_, index) =>
      logicHandleYOffset('component', 5, index, dimensions.height),
    );
    const outputs = Array.from({ length: 3 }, (_, index) =>
      logicHandleYOffset('component', 3, index, dimensions.height),
    );

    expect(inputs).toEqual([...inputs].sort((a, b) => a - b));
    expect(outputs).toEqual([...outputs].sort((a, b) => a - b));
    expect(inputs[2]).toBe(dimensions.height / 2);
    expect(outputs[1]).toBe(dimensions.height / 2);
    expect(inputs.every((offset) => offset > 0 && offset < dimensions.height)).toBe(true);
  });
});
