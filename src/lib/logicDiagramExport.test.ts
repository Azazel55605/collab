import { describe, expect, it } from 'vitest';

import type { LogicDiagramDocument } from '../types/logicDiagram';

import {
  buildLogicDiagramSvg,
  buildLogicDiagramSvgDataUrl,
  extractLogicDiagramExportSource,
} from './logicDiagramExport';

const diagram: LogicDiagramDocument = {
  schemaVersion: 1,
  kind: 'logic-diagram',
  diagramMode: 'logic',
  title: 'Half adder',
  nodes: [
    { id: 'a', kind: 'input', position: { x: 0, y: 0 }, value: true },
    { id: 'xor', kind: 'xor', position: { x: 180, y: 0 } },
  ],
  wires: [{ id: 'w1', source: 'a', target: 'xor' }],
  viewport: { x: 0, y: 0, zoom: 1 },
};

describe('logicDiagramExport', () => {
  it('builds an SVG with source metadata and visible logic elements', () => {
    const svg = buildLogicDiagramSvg(diagram, 'Diagrams/half-adder.logic');

    expect(svg).toContain('<svg');
    expect(svg).toContain('collab-logic-diagram-export');
    expect(svg).toContain('Diagrams/half-adder.logic');
    expect(svg).toContain('XOR');
    expect(svg).toContain('<path');
    expect(svg).toContain('stroke="#2563eb"');
  });

  it('exports static schematic symbols without logic signal arrows', () => {
    const schematic: LogicDiagramDocument = {
      ...diagram,
      diagramMode: 'schematic',
      nodes: [
        { id: 'source', kind: 'voltage-source', position: { x: 0, y: 0 } },
        { id: 'r1', kind: 'resistor', label: 'R1 1k', position: { x: 180, y: 0 }, rotation: 90 },
      ],
      wires: [
        {
          id: 'wire',
          source: 'source',
          target: 'r1',
          sourceHandle: 'positive',
          targetHandle: 'terminal-a',
        },
      ],
    };

    const svg = buildLogicDiagramSvg(schematic, 'Diagrams/amplifier.logic');
    expect(svg).toContain('R1 1k');
    expect(svg).toContain('M0 32H20L26 20');
    expect(svg).toContain('translate(72 0) rotate(90)');
    expect(svg).toContain('cx="216" cy="0"');
    expect(svg).not.toContain('marker-end="url(#logic-arrow)"');
  });

  it('uses the selected IEC/DIN schematic notation without changing document data', () => {
    const schematic: LogicDiagramDocument = {
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [
        {
          id: 'r1',
          kind: 'resistor',
          position: { x: 0, y: 0 },
          electrical: { resistanceOhms: 1000 },
        },
      ],
      wires: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const ansi = buildLogicDiagramSvg(schematic, 'Diagrams/resistor.logic', 'ansi');
    const iec = buildLogicDiagramSvg(schematic, 'Diagrams/resistor.logic', 'iec');
    expect(ansi).toContain('L26 20');
    expect(iec).toContain('H76V44');
    expect(schematic.nodes[0].kind).toBe('resistor');
  });

  it('exports an explicit junction as a clean connection dot', () => {
    const schematic: LogicDiagramDocument = {
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [{ id: 'join', kind: 'junction', position: { x: 20, y: 20 } }],
      wires: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const svg = buildLogicDiagramSvg(schematic, 'Diagrams/junction.logic');
    expect(svg).toContain('<circle cx="50" cy="36" r="10" fill="#334155"/>');
    expect(svg).not.toContain('>Junction</text>');
    expect(svg.match(/<circle/g)).toHaveLength(1);
  });

  it('extracts source metadata from exported SVG data URLs', () => {
    const dataUrl = buildLogicDiagramSvgDataUrl(diagram, 'Diagrams/half-adder.logic');

    expect(extractLogicDiagramExportSource(dataUrl)).toBe('Diagrams/half-adder.logic');
    expect(extractLogicDiagramExportSource('data:image/png;base64,abc')).toBeNull();
  });
});
