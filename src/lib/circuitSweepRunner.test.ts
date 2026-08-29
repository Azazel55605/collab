import { describe, expect, it, vi } from 'vitest';

import type { LogicDiagramDocument } from '../types/logicDiagram';

import { type CircuitSweepJobClient, runCircuitSweepJob } from './circuitSweepRunner';

const DOCUMENT = {
  schemaVersion: 6,
  kind: 'logic-diagram',
  diagramMode: 'schematic',
  nodes: [],
  wires: [],
  viewport: { x: 0, y: 0, zoom: 1 },
} as LogicDiagramDocument;

const SUMMARY = {
  source: 'source',
  sampleCount: 3,
  outputs: [{ kind: 'node-voltage', node: '1' }] as const,
  sourceMap: { terminals: [], wires: [], probes: [] },
};

function clientWithChunk(chunk: unknown): CircuitSweepJobClient {
  return {
    start: vi.fn().mockResolvedValue('sweep-1'),
    status: vi.fn().mockResolvedValue({ phase: 'completed', stage: null, elapsedMillis: 2 }),
    takeResult: vi.fn().mockResolvedValue({ state: 'sweep-completed', summary: SUMMARY }),
    readChunk: vi.fn().mockResolvedValue(chunk),
    discard: vi.fn().mockResolvedValue(undefined),
  };
}

describe('circuit sweep runner', () => {
  it('assembles aligned native chunks and always discards the retained job', async () => {
    const client = clientWithChunk({
      offset: 0,
      sourceValues: [0, 5, 10],
      traces: [{ output: { kind: 'node-voltage', node: '1' }, values: [0, 2.5, 5] }],
      done: true,
    });

    await expect(runCircuitSweepJob(client, DOCUMENT)).resolves.toMatchObject({
      source: 'source',
      sourceValues: [0, 5, 10],
      traces: [{ values: [0, 2.5, 5] }],
    });
    expect(client.readChunk).toHaveBeenCalledWith('sweep-1', 0, 512);
    expect(client.discard).toHaveBeenCalledWith('sweep-1');
  });

  it('rejects malformed trace chunks and still releases native memory', async () => {
    const client = clientWithChunk({
      offset: 0,
      sourceValues: [0, 5, 10],
      traces: [{ output: { kind: 'node-voltage', node: '1' }, values: [0] }],
      done: true,
    });

    await expect(runCircuitSweepJob(client, DOCUMENT)).rejects.toThrow(/misaligned/);
    expect(client.discard).toHaveBeenCalledWith('sweep-1');
  });
});
