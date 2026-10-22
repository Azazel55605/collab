import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import PerformanceDiagnosticsControls from './PerformanceDiagnosticsControls';

const mocks = vi.hoisted(() => ({
  api: null as null | {
    start: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  },
}));
vi.mock('../../lib/performanceDiagnostics', () => ({ getPerformanceDiagnostics: () => mocks.api }));
beforeEach(() => {
  mocks.api = null;
});
it('keeps diagnostic-only controls out of normal builds', () => {
  render(<PerformanceDiagnosticsControls />);
  expect(screen.queryByLabelText('Performance diagnostics')).toBeNull();
});
it('captures across settings remounts and exports through the native save path', async () => {
  let active: string | null = null,
    scenarios = 0;
  mocks.api = {
    start: vi.fn(async (name: string) => {
      active = name;
    }),
    finish: vi.fn(async () => {
      active = null;
      scenarios++;
    }),
    export: vi.fn(async () => {}),
    status: vi.fn(() => ({ active, scenarios, interactions: 100 })),
  };
  const view = render(<PerformanceDiagnosticsControls />);
  fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
  await screen.findByText(/Recording interaction/);
  view.unmount();
  render(<PerformanceDiagnosticsControls />);
  expect(screen.getByText(/Recording interaction/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Finish capture' }));
  await screen.findByText(/1 scenario recorded/);
  fireEvent.click(screen.getByRole('button', { name: 'Save performance report' }));
  await waitFor(() => expect(mocks.api!.export).toHaveBeenCalledOnce());
});
it('shows a missing native diagnostics flag as a visible error', async () => {
  mocks.api = {
    start: vi.fn().mockRejectedValue(new Error('Enable native diagnostics')),
    finish: vi.fn(),
    export: vi.fn(),
    status: vi.fn(() => ({ active: null, scenarios: 0, interactions: 0 })),
  };
  render(<PerformanceDiagnosticsControls />);
  fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Enable native diagnostics');
});
