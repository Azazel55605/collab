import { describe, expect, it } from 'vitest';

import type { CircuitSweepResult } from '../types/circuitRuntime';

import { buildCircuitSweepCsv, buildCircuitSweepSvg, utf8ToBase64 } from './circuitSweepExport';

const RESULT: CircuitSweepResult = {
  source: 'source',
  sampleCount: 3,
  outputs: [{ kind: 'node-voltage', node: 'net1' }],
  sourceMap: {
    terminals: [],
    wires: [],
    probes: [
      { probeId: 'out', label: 'Output, "sense"', kind: 'node-voltage', electricalNode: 'net1' },
    ],
  },
  sourceValues: [0, 5, 10],
  traces: [{ output: { kind: 'node-voltage', node: 'net1' }, values: [0, 2.5, 5] }],
};

describe('circuit sweep export', () => {
  it('exports exact source samples as escaped CSV', () => {
    expect(buildCircuitSweepCsv(RESULT, 'Supply')).toBe(
      ['Supply (source value),"Output, ""sense"" (V)"', '0,0', '5,2.5', '10,5', ''].join('\n'),
    );
  });

  it('exports a standalone SVG and UTF-8-safe base64 bytes', () => {
    const svg = buildCircuitSweepSvg(RESULT, 'Süpply <A>');
    expect(svg).toMatch(/^<svg xmlns=/);
    expect(svg).toContain('Süpply &lt;A&gt; DC sweep');
    expect(svg).toContain('<polyline points="');
    const bytes = Uint8Array.from(atob(utf8ToBase64('Süpply')), (character) =>
      character.charCodeAt(0),
    );
    expect(new TextDecoder().decode(bytes)).toBe('Süpply');
  });

  it('grows the exported canvas when the legend spans multiple rows', () => {
    const result: CircuitSweepResult = {
      ...RESULT,
      outputs: Array.from({ length: 5 }, (_, index) => ({
        kind: 'node-voltage' as const,
        node: `net${index}`,
      })),
      traces: Array.from({ length: 5 }, (_, index) => ({
        output: { kind: 'node-voltage' as const, node: `net${index}` },
        values: [0, index + 1, index + 2],
      })),
    };
    const svg = buildCircuitSweepSvg(result);
    expect(svg).toContain('height="630"');
    expect(svg).toContain('translate(104 70)');
  });
});
