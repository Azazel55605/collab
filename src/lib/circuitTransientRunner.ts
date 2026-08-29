import type {
  CircuitJobOutcome,
  CircuitTransientChunk,
  CircuitTransientResult,
  CircuitTransientSummary,
} from '../types/circuitRuntime';
import type { LogicDiagramDocument } from '../types/logicDiagram';

import {
  type CircuitJobClient,
  type CircuitJobRunOptions,
  runCircuitJob,
} from './circuitJobRunner';

const TRANSIENT_CHUNK_SIZE = 512;

export interface CircuitTransientJobClient extends CircuitJobClient {
  readChunk(jobId: string, offset: number, limit: number): Promise<CircuitTransientChunk>;
  discard(jobId: string): Promise<void>;
}

function outputKey(output: CircuitTransientSummary['outputs'][number]): string {
  return output.kind === 'node-voltage' ? `node:${output.node}` : `component:${output.component}`;
}

export async function runCircuitTransientJob(
  client: CircuitTransientJobClient,
  document: LogicDiagramDocument,
  options: CircuitJobRunOptions = {},
): Promise<CircuitJobOutcome | CircuitTransientResult> {
  let jobId: string | null = null;
  const outcome = await runCircuitJob(client, document, {
    ...options,
    onStarted: (startedJobId) => {
      jobId = startedJobId;
      options.onStarted?.(startedJobId);
    },
  });
  if (outcome.state !== 'transient-completed') return outcome;
  if (!jobId) throw new Error('The transient analysis started without a job identifier.');

  const summary = outcome.summary;
  const timeSeconds: number[] = [];
  const valuesByOutput = new Map(
    summary.outputs.map((output) => [outputKey(output), [] as number[]]),
  );
  let offset = 0;

  try {
    while (offset < summary.sampleCount) {
      const chunk = await client.readChunk(jobId, offset, TRANSIENT_CHUNK_SIZE);
      if (chunk.offset !== offset || chunk.timeSeconds.length === 0) {
        throw new Error('The transient analysis returned a non-contiguous result chunk.');
      }
      const expectedLength = Math.min(TRANSIENT_CHUNK_SIZE, summary.sampleCount - offset);
      if (chunk.timeSeconds.length !== expectedLength) {
        throw new Error('The transient analysis returned an incomplete result chunk.');
      }
      if (chunk.traces.length !== summary.outputs.length) {
        throw new Error('The transient analysis returned an unexpected trace count.');
      }
      timeSeconds.push(...chunk.timeSeconds);
      for (const trace of chunk.traces) {
        const values = valuesByOutput.get(outputKey(trace.output));
        if (!values || trace.values.length !== chunk.timeSeconds.length) {
          throw new Error('The transient analysis returned a misaligned trace chunk.');
        }
        values.push(...trace.values);
      }
      offset += chunk.timeSeconds.length;
      if (chunk.done !== (offset === summary.sampleCount)) {
        throw new Error('The transient analysis returned an inconsistent completion marker.');
      }
    }

    return {
      ...summary,
      timeSeconds,
      traces: summary.outputs.map((output) => ({
        output,
        values: valuesByOutput.get(outputKey(output)) ?? [],
      })),
    };
  } finally {
    await client.discard(jobId).catch(() => undefined);
  }
}
