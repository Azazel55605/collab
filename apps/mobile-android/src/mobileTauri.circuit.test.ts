import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogicDiagramDocument } from '../../../src/types/logicDiagram';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  circuitCancelJob,
  circuitDiscardJob,
  circuitJobStatus,
  circuitReadSweepChunk,
  circuitReadTransientChunk,
  circuitStartDc,
  circuitStartDcSweep,
  circuitStartTransient,
  circuitTakeJobResult,
} from './mobileTauri';

describe('mobile circuit commands', () => {
  beforeEach(() => invoke.mockReset());

  it('uses the shared native job commands with typed arguments', async () => {
    const document: LogicDiagramDocument = {
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [],
      wires: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    invoke
      .mockResolvedValueOnce('job-1')
      .mockResolvedValueOnce({ phase: 'running', stage: 'solving', elapsedMillis: 2 })
      .mockResolvedValueOnce('cancelling')
      .mockResolvedValueOnce({ state: 'cancelled' });

    await circuitStartDc(document);
    await circuitJobStatus('job-1');
    await circuitCancelJob('job-1');
    await circuitTakeJobResult('job-1');

    expect(invoke.mock.calls).toEqual([
      ['circuit_start_dc', { document }],
      ['circuit_job_status', { jobId: 'job-1' }],
      ['circuit_cancel_job', { jobId: 'job-1' }],
      ['circuit_take_job_result', { jobId: 'job-1' }],
    ]);
  });

  it('starts, reads, and discards bounded sweep jobs', async () => {
    const document: LogicDiagramDocument = {
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [],
      wires: [],
      simulation: {
        analysis: 'dc-sweep',
        probes: [],
        dcSweep: { sourceNodeId: 'source', start: 0, stop: 5, sampleCount: 11 },
      },
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    invoke
      .mockResolvedValueOnce('sweep-1')
      .mockResolvedValueOnce({ offset: 0, sourceValues: [], traces: [], done: true })
      .mockResolvedValueOnce(undefined);

    await circuitStartDcSweep(document);
    await circuitReadSweepChunk('sweep-1', 0, 256);
    await circuitDiscardJob('sweep-1');

    expect(invoke.mock.calls).toEqual([
      ['circuit_start_dc_sweep', { document }],
      ['circuit_read_sweep_chunk', { jobId: 'sweep-1', offset: 0, limit: 256 }],
      ['circuit_discard_job', { jobId: 'sweep-1' }],
    ]);
  });

  it('starts, reads, and discards bounded transient jobs', async () => {
    const document: LogicDiagramDocument = {
      schemaVersion: 6,
      kind: 'logic-diagram',
      diagramMode: 'schematic',
      nodes: [],
      wires: [],
      simulation: {
        analysis: 'transient',
        probes: [],
        transient: { durationSeconds: 0.01, maxTimeStepSeconds: 0.001, sourceWaveforms: {} },
      },
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    invoke
      .mockResolvedValueOnce('transient-1')
      .mockResolvedValueOnce({ offset: 0, timeSeconds: [], traces: [], done: true })
      .mockResolvedValueOnce(undefined);

    await circuitStartTransient(document);
    await circuitReadTransientChunk('transient-1', 0, 256);
    await circuitDiscardJob('transient-1');

    expect(invoke.mock.calls).toEqual([
      ['circuit_start_transient', { document }],
      ['circuit_read_transient_chunk', { jobId: 'transient-1', offset: 0, limit: 256 }],
      ['circuit_discard_job', { jobId: 'transient-1' }],
    ]);
  });
});
