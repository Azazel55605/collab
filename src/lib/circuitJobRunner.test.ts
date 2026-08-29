import { describe, expect, it, vi } from 'vitest';

import type { LogicDiagramDocument } from '../types/logicDiagram';

import { type CircuitJobClient, runCircuitJob } from './circuitJobRunner';

const DOCUMENT = {
  schemaVersion: 6,
  kind: 'logic-diagram',
  diagramMode: 'schematic',
  nodes: [],
  wires: [],
  viewport: { x: 0, y: 0, zoom: 1 },
} as LogicDiagramDocument;

describe('circuit job runner', () => {
  it('polls staged status and consumes one terminal result', async () => {
    const statuses = [
      { phase: 'running', stage: 'compiling', elapsedMillis: 1 },
      { phase: 'running', stage: 'solving', elapsedMillis: 2 },
      { phase: 'completed', stage: null, elapsedMillis: 3 },
    ] as const;
    const client: CircuitJobClient = {
      start: vi.fn().mockResolvedValue('job-1'),
      status: vi
        .fn()
        .mockResolvedValueOnce(statuses[0])
        .mockResolvedValueOnce(statuses[1])
        .mockResolvedValueOnce(statuses[2]),
      takeResult: vi.fn().mockResolvedValue({ state: 'cancelled' }),
    };
    const onStarted = vi.fn();
    const onStatus = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(runCircuitJob(client, DOCUMENT, { onStarted, onStatus, wait })).resolves.toEqual({
      state: 'cancelled',
    });
    expect(client.start).toHaveBeenCalledWith(DOCUMENT);
    expect(onStarted).toHaveBeenCalledWith('job-1');
    expect(onStatus.mock.calls.map(([status]) => status.stage)).toEqual([
      'compiling',
      'solving',
      null,
    ]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(client.takeResult).toHaveBeenCalledOnce();
    expect(client.takeResult).toHaveBeenCalledWith('job-1');
  });

  it('rejects a terminal job whose result was already consumed', async () => {
    const client: CircuitJobClient = {
      start: vi.fn().mockResolvedValue('job-2'),
      status: vi.fn().mockResolvedValue({ phase: 'failed', stage: null, elapsedMillis: 4 }),
      takeResult: vi.fn().mockResolvedValue(null),
    };

    await expect(runCircuitJob(client, DOCUMENT)).rejects.toThrow('finished without a result');
  });
});
