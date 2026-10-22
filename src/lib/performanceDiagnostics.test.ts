import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it('disabled diagnostics do not inspect payloads or install browser observers', async () => {
  vi.stubEnv('VITE_COLLAB_PERFORMANCE_DIAGNOSTICS', '0');
  const { traceIpc, installPerformanceDiagnostics } = await import('./performanceDiagnostics');
  const inspect = vi.fn(() => {
    throw new Error('must not inspect');
  });
  const payload = Object.defineProperty({}, 'content', { get: inspect });
  const run = vi.fn(async () => 42);
  expect(await traceIpc('read_note', payload, run)).toBe(42);
  expect(inspect).not.toHaveBeenCalled();
  const snapshot = vi.fn();
  installPerformanceDiagnostics(snapshot);
  expect(snapshot).not.toHaveBeenCalled();
});
