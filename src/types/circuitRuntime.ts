export interface CircuitTerminalNet {
  terminal: { nodeId: string; handleId: string };
  electricalNode: string;
}

export interface CircuitWireNet {
  wireId: string;
  electricalNode: string;
}

export type CircuitDcDiagnostic = {
  code: 'npnOutsideForwardActive';
  context: {
    component: string;
    baseEmitterVoltage: number;
    collectorEmitterVoltage: number;
  };
};

export type CircuitProbeValue =
  | { kind: 'node-voltage'; probeId: string; label: string | null; valueVolts: number }
  | { kind: 'branch-current'; probeId: string; label: string | null; valueAmps: number };

export interface CircuitDcResult {
  operatingPoint: {
    nodeVoltages: Record<string, number>;
    componentCurrents: Record<string, number>;
    componentPowers: Record<string, number>;
    diagnostics: CircuitDcDiagnostic[];
    iterations: number;
  };
  sourceMap: {
    terminals: CircuitTerminalNet[];
    wires: CircuitWireNet[];
    probes: Array<{
      probeId: string;
      label: string | null;
      kind: 'node-voltage' | 'branch-current';
      electricalNode?: string;
      component?: string;
    }>;
  };
  probeValues: CircuitProbeValue[];
}

export type CircuitJobPhase =
  'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type CircuitJobStage = 'queued' | 'compiling' | 'solving' | 'finalizing';

export interface CircuitJobStatus {
  phase: CircuitJobPhase;
  stage: CircuitJobStage | null;
  elapsedMillis: number;
}

export type CircuitSweepOutput =
  { kind: 'node-voltage'; node: string } | { kind: 'component-current'; component: string };

export interface CircuitSweepSummary {
  source: string;
  sampleCount: number;
  outputs: CircuitSweepOutput[];
  sourceMap: CircuitDcResult['sourceMap'];
}

export interface CircuitSweepChunk {
  offset: number;
  sourceValues: number[];
  traces: Array<{ output: CircuitSweepOutput; values: number[] }>;
  done: boolean;
}

export interface CircuitSweepResult extends CircuitSweepSummary {
  sourceValues: number[];
  traces: Array<{ output: CircuitSweepOutput; values: number[] }>;
}

export type CircuitTransientOutput =
  { kind: 'node-voltage'; node: string } | { kind: 'component-current'; component: string };

export interface CircuitTransientSummary {
  sampleCount: number;
  outputs: CircuitTransientOutput[];
  sourceMap: CircuitDcResult['sourceMap'];
}

export interface CircuitTransientChunk {
  offset: number;
  timeSeconds: number[];
  traces: Array<{ output: CircuitTransientOutput; values: number[] }>;
  done: boolean;
}

export interface CircuitTransientResult extends CircuitTransientSummary {
  timeSeconds: number[];
  traces: Array<{ output: CircuitTransientOutput; values: number[] }>;
}

export type CircuitJobOutcome =
  | { state: 'completed'; result: CircuitDcResult }
  | { state: 'sweep-completed'; summary: CircuitSweepSummary }
  | { state: 'transient-completed'; summary: CircuitTransientSummary }
  | { state: 'failed'; error: unknown }
  | { state: 'cancelled' };
