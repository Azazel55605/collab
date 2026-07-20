export function circuitErrorText(error: unknown): string {
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as unknown;
      if (parsed !== error) return circuitErrorText(parsed);
    } catch {
      return error;
    }
  }
  if (!error || typeof error !== 'object') return String(error);
  const record = error as Record<string, unknown>;
  const detail = record.detail && typeof record.detail === 'object'
    ? record.detail as Record<string, unknown>
    : record;
  const code = typeof detail.code === 'string' ? detail.code : '';
  const context = detail.context && typeof detail.context === 'object'
    ? detail.context as Record<string, unknown>
    : {};
  switch (code) {
    case 'missingGround': return 'Add one ground reference before running the simulation.';
    case 'multipleGrounds': return 'This baseline currently requires exactly one ground symbol.';
    case 'unsupportedComponent':
      return `${String(context.kind ?? 'This component')} is not supported by the current DC solver.`;
    case 'unsupportedModel':
      return `${String(context.modelRef ?? 'This model')} is not supported for ${String(context.nodeId ?? 'the component')}.`;
    case 'missingElectricalValue':
      return `Configure ${String(context.field ?? 'the electrical value')} for ${String(context.nodeId ?? 'the component')}.`;
    case 'missingWireHandle': return 'A wire is not attached to a valid component terminal.';
    case 'unknownWireNode':
    case 'unknownTerminal': return 'A wire references a component or terminal that no longer exists.';
    case 'duplicateProbeId': return 'Two circuit probes use the same ID. Remove and recreate one of them.';
    case 'unknownProbeNode': return 'A circuit probe references a component that no longer exists.';
    case 'missingProbeHandle': return 'A voltage probe is not attached to a component terminal.';
    case 'unknownProbeTerminal': return 'A voltage probe references a terminal that no longer exists.';
    case 'invalidBranchProbeTarget': return 'Branch-current probes cannot target the ground reference or a junction.';
    case 'invalidJunctionDegree':
      return `Junction ${String(context.nodeId ?? '')} needs at least two connected wires.`.trim();
    case 'disconnectedTerminal':
      return `Connect ${String(context.nodeId ?? 'the component')}'s ${String(context.handleId ?? 'terminal')} before running DC.`;
    case 'floatingDcIsland': {
      const nodeIds = Array.isArray(context.nodeIds) ? context.nodeIds.join(', ') : 'part of the circuit';
      return `${nodeIds} has no DC path to the ground reference.`;
    }
    case 'invalidIdealVoltageSource':
      return `${String(context.nodeId ?? 'A voltage source')} has both terminals connected to the same electrical node.`;
    case 'conflictingIdealVoltageSources':
      return `${String(context.firstNodeId ?? 'One voltage source')} and ${String(context.secondNodeId ?? 'another voltage source')} impose conflicting voltages on the same nodes.`;
    case 'redundantIdealVoltageSources':
      return `${String(context.firstNodeId ?? 'One voltage source')} and ${String(context.secondNodeId ?? 'another voltage source')} redundantly constrain the same nodes.`;
    case 'oversizedCircuit':
      return `This schematic exceeds the bounded DC baseline (${String(context.components ?? '?')} components, ${String(context.wires ?? '?')} wires, ${String(context.probes ?? '?')} probes).`;
    case 'singularSystem': return 'The circuit is floating, underconstrained, or contains conflicting ideal sources.';
    case 'invalidResistance': return 'Every resistor must have resistance greater than zero.';
    case 'invalidCapacitance': return 'Every capacitor must have capacitance greater than zero.';
    case 'invalidInductance': return 'Every inductor must have inductance greater than zero.';
    case 'invalidSwitchResistance': return 'The switch model contains an invalid resistance.';
    case 'invalidDiodeModel': return 'The diode model contains invalid parameters.';
    case 'invalidBipolarModel': return 'The transistor model contains invalid parameters.';
    case 'convergenceFailed':
      return `The nonlinear DC solution did not converge after ${String(context.iterations ?? 'the maximum number of')} iterations.`;
    case 'invalidTimeRange': return 'Transient duration and maximum timestep must both be greater than zero.';
    case 'sampleLimitExceeded':
      return `The analysis requests ${String(context.sampleCount ?? '?')} samples; the current limit is ${String(context.maxSamples ?? '?')}.`;
    case 'resultBufferLimitExceeded': return 'The requested traces exceed the bounded circuit result-buffer limit.';
    case 'missingOutputs': return 'Add at least one voltage or current probe before running the analysis.';
    case 'duplicateOutput': return 'The analysis contains a duplicate output trace.';
    case 'unknownNodeOutput': return 'A voltage probe references an electrical node that no longer exists.';
    case 'unknownComponentOutput': return 'A current probe references a component that no longer exists.';
    case 'unknownWaveformSource': return 'A transient waveform references a source that no longer exists.';
    case 'unsupportedWaveformSource': return 'Transient waveforms can only target independent voltage or current sources.';
    case 'invalidWaveform':
      return `The transient source has an invalid ${String(context.field ?? 'waveform')} value.`;
    case 'sampleFailed':
      return `Transient sample ${String(context.sampleIndex ?? '?')} at ${String(context.timeSeconds ?? '?')} s failed: ${circuitErrorText(context.error)}`;
    case 'denseSolverSizeLimitExceeded':
      return `This circuit requires ${String(context.unknowns ?? '?')} solver unknowns; the bounded dense backend currently supports ${String(context.maxUnknowns ?? '?')}.`;
    case 'timeLimitExceeded': {
      const analysis = record.stage === 'transient'
        ? 'transient analysis'
        : record.stage === 'sweep' ? 'DC sweep' : 'DC simulation';
      return `The ${analysis} exceeded its ${String(context.limitMillis ?? '?')} ms execution limit.`;
    }
    case 'matrixMemoryLimitExceeded':
      return `The ${String(context.unknowns ?? '?')}-unknown DC system exceeds the bounded dense-solver memory limit.`;
    case 'nonFiniteValue': return 'A component contains an invalid numerical value.';
    default:
      if (typeof record.message === 'string') return record.message;
      try {
        return JSON.stringify(error);
      } catch {
        return 'The circuit could not be simulated.';
      }
  }
}
