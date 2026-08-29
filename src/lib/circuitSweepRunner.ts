import type {
  CircuitJobOutcome,
  CircuitSweepChunk,
  CircuitSweepResult,
  CircuitSweepSummary,
} from '../types/circuitRuntime';
import type { LogicDiagramDocument } from '../types/logicDiagram';

import {
  type CircuitJobClient,
  type CircuitJobRunOptions,
  runCircuitJob,
} from './circuitJobRunner';

const SWEEP_CHUNK_SIZE = 512;

export interface CircuitSweepJobClient extends CircuitJobClient {
  readChunk(jobId: string, offset: number, limit: number): Promise<CircuitSweepChunk>;
  discard(jobId: string): Promise<void>;
}

function outputKey(output: CircuitSweepSummary['outputs'][number]): string {
  return output.kind === 'node-voltage' ? `node:${output.node}` : `component:${output.component}`;
}

export async function runCircuitSweepJob(
  client: CircuitSweepJobClient,
  document: LogicDiagramDocument,
  options: CircuitJobRunOptions = {},
): Promise<CircuitJobOutcome | CircuitSweepResult> {
  let jobId: string | null = null;
  const outcome = await runCircuitJob(client, document, {
    ...options,
    onStarted: (startedJobId) => {
      jobId = startedJobId;
      options.onStarted?.(startedJobId);
    },
  });
  if (outcome.state !== 'sweep-completed') return outcome;
  if (!jobId) throw new Error('The circuit sweep started without a job identifier.');

  const summary = outcome.summary;
  const sourceValues: number[] = [];
  const valuesByOutput = new Map(
    summary.outputs.map((output) => [outputKey(output), [] as number[]]),
  );
  let offset = 0;

  try {
    while (offset < summary.sampleCount) {
      const chunk = await client.readChunk(jobId, offset, SWEEP_CHUNK_SIZE);
      if (chunk.offset !== offset || chunk.sourceValues.length === 0) {
        throw new Error('The circuit sweep returned a non-contiguous result chunk.');
      }
      const expectedLength = Math.min(SWEEP_CHUNK_SIZE, summary.sampleCount - offset);
      if (chunk.sourceValues.length !== expectedLength) {
        throw new Error('The circuit sweep returned an incomplete result chunk.');
      }
      if (chunk.traces.length !== summary.outputs.length) {
        throw new Error('The circuit sweep returned an unexpected trace count.');
      }
      sourceValues.push(...chunk.sourceValues);
      for (const trace of chunk.traces) {
        const values = valuesByOutput.get(outputKey(trace.output));
        if (!values || trace.values.length !== chunk.sourceValues.length) {
          throw new Error('The circuit sweep returned a misaligned trace chunk.');
        }
        values.push(...trace.values);
      }
      offset += chunk.sourceValues.length;
      if (chunk.done !== (offset === summary.sampleCount)) {
        throw new Error('The circuit sweep returned an inconsistent completion marker.');
      }
    }

    return {
      ...summary,
      sourceValues,
      traces: summary.outputs.map((output) => ({
        output,
        values: valuesByOutput.get(outputKey(output)) ?? [],
      })),
    };
  } finally {
    await client.discard(jobId).catch(() => undefined);
  }
}
