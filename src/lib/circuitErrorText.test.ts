import { describe, expect, it } from 'vitest';

import { circuitErrorText } from './circuitErrorText';

describe('circuit error text', () => {
  it('formats shared compiler and execution-limit diagnostics', () => {
    expect(
      circuitErrorText({
        stage: 'compilation',
        detail: { code: 'disconnectedTerminal', context: { nodeId: 'r1', handleId: 'terminal-b' } },
      }),
    ).toBe("Connect r1's terminal-b before running DC.");
    expect(
      circuitErrorText({
        stage: 'simulation',
        detail: { code: 'timeLimitExceeded', context: { limitMillis: 10_000 } },
      }),
    ).toBe('The DC simulation exceeded its 10000 ms execution limit.');
    expect(
      circuitErrorText({
        stage: 'simulation',
        detail: {
          code: 'denseSolverSizeLimitExceeded',
          context: { unknowns: 640, maxUnknowns: 512 },
        },
      }),
    ).toContain('640 solver unknowns');
  });

  it('formats transient limits and nested sample failures', () => {
    expect(
      circuitErrorText({
        stage: 'transient',
        detail: { code: 'timeLimitExceeded', context: { limitMillis: 30_000 } },
      }),
    ).toBe('The transient analysis exceeded its 30000 ms execution limit.');
    expect(
      circuitErrorText({
        stage: 'transient',
        detail: {
          code: 'sampleFailed',
          context: {
            sampleIndex: 4,
            timeSeconds: 0.004,
            error: { code: 'singularSystem', context: { index: 2 } },
          },
        },
      }),
    ).toBe(
      'Transient sample 4 at 0.004 s failed: The circuit is floating, underconstrained, or contains conflicting ideal sources.',
    );
  });
});
