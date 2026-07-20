import { describe, expect, it, vi } from 'vitest';

import type { LogicDiagramDocument } from '../types/logicDiagram';
import { runCircuitTransientJob, type CircuitTransientJobClient } from './circuitTransientRunner';

const DOCUMENT = {
  schemaVersion: 6,
  kind: 'logic-diagram',
  diagramMode: 'schematic',
  nodes: [],
  wires: [],
  viewport: { x: 0, y: 0, zoom: 1 },
} as LogicDiagramDocument;

const SUMMARY = {
  sampleCount: 3,
  outputs: [{ kind: 'node-voltage', node: '1' }] as const,
  sourceMap: { terminals: [], wires: [], probes: [] },
};

function clientWithChunk(chunk: unknown): CircuitTransientJobClient {
  return {
    start: vi.fn().mockResolvedValue('transient-1'),
    status: vi.fn().mockResolvedValue({ phase: 'completed', stage: null, elapsedMillis: 2 }),
    takeResult: vi.fn().mockResolvedValue({ state: 'transient-completed', summary: SUMMARY }),
    readChunk: vi.fn().mockResolvedValue(chunk),
    discard: vi.fn().mockResolvedValue(undefined),
  };
}

describe('circuit transient runner', () => {
  it('assembles aligned native chunks and always discards the retained job', async () => {
    const client = clientWithChunk({
      offset: 0,
      timeSeconds: [0, 0.001, 0.002],
      traces: [{ output: { kind: 'node-voltage', node: '1' }, values: [0, 2.5, 3.75] }],
      done: true,
    });

    await expect(runCircuitTransientJob(client, DOCUMENT)).resolves.toMatchObject({
      timeSeconds: [0, 0.001, 0.002],
      traces: [{ values: [0, 2.5, 3.75] }],
    });
    expect(client.readChunk).toHaveBeenCalledWith('transient-1', 0, 512);
    expect(client.discard).toHaveBeenCalledWith('transient-1');
  });

  it('rejects malformed chunks and still releases native memory', async () => {
    const client = clientWithChunk({
      offset: 0,
      timeSeconds: [0, 0.001, 0.002],
      traces: [{ output: { kind: 'node-voltage', node: '1' }, values: [0] }],
      done: true,
    });

    await expect(runCircuitTransientJob(client, DOCUMENT)).rejects.toThrow(/misaligned/);
    expect(client.discard).toHaveBeenCalledWith('transient-1');
  });
});
