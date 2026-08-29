import type { CircuitJobOutcome, CircuitJobPhase, CircuitJobStatus } from '../types/circuitRuntime';
import type { LogicDiagramDocument } from '../types/logicDiagram';

export interface CircuitJobClient {
  start(document: LogicDiagramDocument): Promise<string>;
  status(jobId: string): Promise<CircuitJobStatus>;
  takeResult(jobId: string): Promise<CircuitJobOutcome | null>;
}

export interface CircuitJobRunOptions {
  pollIntervalMs?: number;
  onStarted?: (jobId: string) => void;
  onStatus?: (status: CircuitJobStatus) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

const TERMINAL_PHASES = new Set<CircuitJobPhase>(['completed', 'failed', 'cancelled']);

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export async function runCircuitJob(
  client: CircuitJobClient,
  document: LogicDiagramDocument,
  options: CircuitJobRunOptions = {},
): Promise<CircuitJobOutcome> {
  const jobId = await client.start(document);
  options.onStarted?.(jobId);
  const wait = options.wait ?? defaultWait;
  const pollIntervalMs = options.pollIntervalMs ?? 50;

  while (true) {
    const status = await client.status(jobId);
    options.onStatus?.(status);
    if (TERMINAL_PHASES.has(status.phase)) break;
    await wait(pollIntervalMs);
  }

  const outcome = await client.takeResult(jobId);
  if (!outcome) throw new Error('The circuit worker finished without a result.');
  return outcome;
}
