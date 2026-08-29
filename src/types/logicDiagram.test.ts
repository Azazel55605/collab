import { describe, expect, it } from 'vitest';

import {
  createEmptyLogicDiagram,
  defaultSchematicElectricalParameters,
  normalizeLogicDiagramDocument,
  parseLogicDiagramDocument,
} from './logicDiagram';

describe('logic diagram document helpers', () => {
  it('creates an empty v6 logic diagram document', () => {
    expect(createEmptyLogicDiagram('Adder')).toEqual({
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'logic',
      title: 'Adder',
      nodes: [],
      wires: [],
      components: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('normalizes clock timing and clamps unsafe values', () => {
    const document = normalizeLogicDiagramDocument({
      kind: 'logic-diagram',
      nodes: [
        {
          id: 'clock',
          kind: 'clock',
          position: { x: 1, y: 2 },
          clock: { periodMs: 20, dutyCycle: 2, phaseMs: -10 },
        },
      ],
      wires: [],
    });

    expect(document.nodes[0].clock).toEqual({ periodMs: 100, dutyCycle: 0.95, phaseMs: 0 });
  });

  it('normalizes unknown input into a safe diagram shape', () => {
    const normalized = normalizeLogicDiagramDocument({
      schemaVersion: 99,
      kind: 'legacy',
      nodes: [
        { id: 'a', kind: 'input', position: { x: 10, y: 20 }, value: true },
        { id: 'cluster', kind: 'group', position: { x: 0, y: 0 }, width: 240, height: 160 },
        { id: 'inside', kind: 'and', position: { x: 48, y: 48 }, parentId: 'cluster' },
        { id: 'bad', kind: 'timer', position: { x: 0, y: 0 } },
      ],
      wires: [
        { id: 'w1', source: 'a', target: 'out', label: 'sum' },
        { id: 'bad-wire', source: 'a' },
      ],
      viewport: { x: 5, y: Number.NaN, zoom: 1.25 },
    });

    expect(normalized).toMatchObject({
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'logic',
      components: [],
      nodes: [
        { id: 'a', kind: 'input', position: { x: 10, y: 20 }, value: true },
        { id: 'cluster', kind: 'group', position: { x: 0, y: 0 }, width: 240, height: 160 },
        { id: 'inside', kind: 'and', position: { x: 48, y: 48 }, parentId: 'cluster' },
      ],
      wires: [{ id: 'w1', source: 'a', target: 'out', label: 'sum' }],
      viewport: { x: 5, y: 0, zoom: 1.25 },
    });
  });

  it('preserves schematic mode and infers it for early electronic documents', () => {
    expect(
      normalizeLogicDiagramDocument({
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [{ id: 'r1', kind: 'resistor', position: { x: 0, y: 0 } }],
        wires: [],
      }),
    ).toMatchObject({ diagramMode: 'schematic', nodes: [{ kind: 'resistor' }] });

    expect(
      normalizeLogicDiagramDocument({
        kind: 'logic-diagram',
        nodes: [{ id: 'c1', kind: 'capacitor', position: { x: 0, y: 0 } }],
        wires: [],
      }).diagramMode,
    ).toBe('schematic');
  });

  it('normalizes persisted schematic rotation and defaults older symbols to zero', () => {
    expect(
      normalizeLogicDiagramDocument({
        kind: 'logic-diagram',
        diagramMode: 'schematic',
        nodes: [
          { id: 'r1', kind: 'resistor', position: { x: 0, y: 0 }, rotation: 90 },
          { id: 'c1', kind: 'capacitor', position: { x: 0, y: 0 }, rotation: 45 },
        ],
        wires: [],
      }).nodes,
    ).toMatchObject([
      { id: 'r1', rotation: 90 },
      { id: 'c1', rotation: 0 },
    ]);
  });

  it('normalizes SI electrical values without inventing values for migrated nodes', () => {
    const document = normalizeLogicDiagramDocument({
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [
        {
          id: 'r1',
          kind: 'resistor',
          position: { x: 0, y: 0 },
          electrical: { resistanceOhms: 2200 },
        },
        {
          id: 'r2',
          kind: 'resistor',
          position: { x: 0, y: 0 },
          electrical: { resistanceOhms: -1 },
        },
        {
          id: 'v1',
          kind: 'voltage-source',
          position: { x: 0, y: 0 },
          electrical: { voltageVolts: -5 },
        },
        { id: 'legacy', kind: 'capacitor', position: { x: 0, y: 0 } },
        {
          id: 'join',
          kind: 'junction',
          position: { x: 0, y: 0 },
          electrical: { resistanceOhms: 1 },
        },
      ],
      wires: [],
    });

    expect(document.schemaVersion).toBe(6);
    expect(document.nodes).toMatchObject([
      { id: 'r1', electrical: { resistanceOhms: 2200 } },
      { id: 'r2', electrical: undefined },
      { id: 'v1', electrical: { voltageVolts: -5 } },
      { id: 'legacy', electrical: undefined },
      { id: 'join', kind: 'junction', electrical: undefined },
    ]);
  });

  it('normalizes DC simulation probes and removes malformed probes', () => {
    const document = normalizeLogicDiagramDocument({
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [],
      wires: [],
      simulation: {
        analysis: 'dc-operating-point',
        probes: [
          { id: 'p1', kind: 'node-voltage', nodeId: 'r1', handleId: 'terminal-a', label: 'Input' },
          { id: 'bad', kind: 'temperature', nodeId: 'r1' },
        ],
      },
    });

    expect(document.simulation).toEqual({
      analysis: 'dc-operating-point',
      probes: [
        { id: 'p1', kind: 'node-voltage', nodeId: 'r1', handleId: 'terminal-a', label: 'Input' },
      ],
    });
  });

  it('normalizes bounded DC sweep configuration without breaking DC-only documents', () => {
    const document = normalizeLogicDiagramDocument({
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [],
      wires: [],
      simulation: {
        analysis: 'dc-sweep',
        probes: [],
        dcSweep: {
          sourceNodeId: 'source',
          start: -5,
          stop: 5,
          sampleCount: 10_000.8,
        },
      },
    });

    expect(document.simulation).toEqual({
      analysis: 'dc-sweep',
      probes: [],
      dcSweep: {
        sourceNodeId: 'source',
        start: -5,
        stop: 5,
        sampleCount: 4096,
      },
    });

    expect(
      normalizeLogicDiagramDocument({
        kind: 'logic-diagram',
        nodes: [],
        wires: [],
        simulation: {
          analysis: 'dc-sweep',
          probes: [],
          dcSweep: { sourceNodeId: '', start: 1, stop: 1, sampleCount: 1 },
        },
      }).simulation,
    ).toEqual({
      analysis: 'dc-operating-point',
      probes: [],
      dcSweep: undefined,
    });
  });

  it('normalizes bounded transient source waveforms and drops malformed entries', () => {
    const document = normalizeLogicDiagramDocument({
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [],
      wires: [],
      simulation: {
        analysis: 'transient',
        probes: [],
        transient: {
          durationSeconds: 10_000,
          maxTimeStepSeconds: 1e-9,
          sourceWaveforms: {
            pulse: {
              kind: 'pulse',
              lowValue: 0,
              highValue: 5,
              delaySeconds: 0.001,
              riseSeconds: 0,
              fallSeconds: 0,
              pulseWidthSeconds: 0.005,
              periodSeconds: 0.01,
            },
            sine: {
              kind: 'sine',
              offset: 1,
              amplitude: 2,
              frequencyHertz: 50,
              phaseDegrees: 90,
              delaySeconds: 0,
              dampingPerSecond: 0.1,
            },
            invalid: { kind: 'sine', frequencyHertz: 0 },
          },
        },
      },
    });

    expect(document.simulation).toEqual({
      analysis: 'transient',
      probes: [],
      dcSweep: undefined,
      transient: {
        durationSeconds: 3600,
        maxTimeStepSeconds: 3600 / 4095,
        sourceWaveforms: {
          pulse: {
            kind: 'pulse',
            lowValue: 0,
            highValue: 5,
            delaySeconds: 0.001,
            riseSeconds: 0,
            fallSeconds: 0,
            pulseWidthSeconds: 0.005,
            periodSeconds: 0.01,
          },
          sine: {
            kind: 'sine',
            offset: 1,
            amplitude: 2,
            frequencyHertz: 50,
            phaseDegrees: 90,
            delaySeconds: 0,
            dampingPerSecond: 0.1,
          },
        },
      },
    });
  });

  it('provides explicit electrical defaults only for newly inserted symbols', () => {
    expect(defaultSchematicElectricalParameters('resistor')).toEqual({ resistanceOhms: 1000 });
    expect(defaultSchematicElectricalParameters('voltage-source')).toEqual({ voltageVolts: 5 });
    expect(defaultSchematicElectricalParameters('ground')).toBeUndefined();
    expect(defaultSchematicElectricalParameters('junction')).toBeUndefined();
  });

  it('parses valid .logic JSON and rejects unsupported shapes', () => {
    expect(
      parseLogicDiagramDocument('{"kind":"logic-diagram","nodes":[],"wires":[]}'),
    ).toMatchObject({
      kind: 'logic-diagram',
      nodes: [],
      wires: [],
    });

    expect(() => parseLogicDiagramDocument('{')).toThrow(/valid JSON/);
    expect(() => parseLogicDiagramDocument('[]')).toThrow(/JSON object/);
    expect(() => parseLogicDiagramDocument('{"kind":"canvas","nodes":[],"wires":[]}')).toThrow(
      /logic-diagram/,
    );
    expect(() => parseLogicDiagramDocument('{"kind":"logic-diagram","nodes":[]}')).toThrow(
      /nodes and wires/,
    );
  });
});
