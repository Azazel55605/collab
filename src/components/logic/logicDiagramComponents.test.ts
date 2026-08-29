import { describe, expect, it } from 'vitest';

import type { LogicDiagramDocument } from '../../types/logicDiagram';
import { normalizeLogicDiagramDocument } from '../../types/logicDiagram';

import { captureLogicComponent, instantiateLogicComponentNode } from './logicDiagramComponents';

function doc(): LogicDiagramDocument {
  return normalizeLogicDiagramDocument({
    schemaVersion: 1,
    kind: 'logic-diagram',
    title: 'Half Adder',
    nodes: [
      { id: 'a', kind: 'input', label: 'A', position: { x: 0, y: 0 } },
      { id: 'b', kind: 'input', label: 'B', position: { x: 0, y: 100 } },
      { id: 'xor', kind: 'xor', position: { x: 160, y: 0 } },
      { id: 'sum', kind: 'output', label: 'Sum', position: { x: 320, y: 0 } },
      { id: 'outside', kind: 'output', label: 'Outside', position: { x: 320, y: 160 } },
    ],
    wires: [
      { id: 'a-xor', source: 'a', target: 'xor', sourceHandle: 'out', targetHandle: 'in-a' },
      { id: 'b-xor', source: 'b', target: 'xor', sourceHandle: 'out', targetHandle: 'in-b' },
      { id: 'xor-sum', source: 'xor', target: 'sum', sourceHandle: 'out', targetHandle: 'in' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

describe('logic diagram components', () => {
  it('normalizes v1 documents into the current logic document schema', () => {
    const normalized = doc();

    expect(normalized.schemaVersion).toBe(6);
    expect(normalized.diagramMode).toBe('logic');
    expect(normalized.components).toEqual([]);
    expect(normalized.nodes).toHaveLength(5);
  });

  it('captures selected nodes as a reusable component definition', () => {
    const capture = captureLogicComponent(doc(), ['a', 'b', 'xor', 'sum'], 'Half Adder');

    expect(capture.component.name).toBe('Half Adder');
    expect(capture.component.ports.map((port) => `${port.direction}:${port.label}`)).toEqual([
      'input:A',
      'input:B',
      'output:Sum',
    ]);
    expect(capture.component.nodes.map((node) => node.id)).toEqual(['a', 'b', 'xor', 'sum']);
  });

  it('captures the whole file when no nodes are selected', () => {
    const capture = captureLogicComponent(doc(), [], 'Whole File');

    expect(capture.component.nodes).toHaveLength(5);
    expect(capture.component.ports.some((port) => port.label === 'Outside')).toBe(true);
  });

  it('rejects a component selection with dangling boundary wires', () => {
    expect(() => captureLogicComponent(doc(), ['a', 'b', 'xor'], 'Invalid')).toThrow(
      /cross the selection boundary/,
    );
  });

  it('creates snapshot and linked component nodes with embedded cached definitions', () => {
    const component = captureLogicComponent(
      doc(),
      ['a', 'b', 'xor', 'sum'],
      'Half Adder',
    ).component;
    const snapshot = instantiateLogicComponentNode(component, 'snapshot', { x: 24, y: 48 });
    const linked = instantiateLogicComponentNode(component, 'linked', { x: 48, y: 96 });

    expect(snapshot.kind).toBe('component');
    expect(snapshot.component?.mode).toBe('snapshot');
    expect(snapshot.component?.definition.name).toBe('Half Adder');
    expect(linked.component?.mode).toBe('linked');
    expect(linked.component?.componentId).toBe(component.id);
  });
});
