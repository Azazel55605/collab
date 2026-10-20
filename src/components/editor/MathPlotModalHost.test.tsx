import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { MathPlotModalHost, openMathPlotModal } from './MathPlotModalHost';

const load = vi.hoisted(() => ({ started: vi.fn(), finish: (() => {}) as () => void }));
vi.mock('./MathPlotModal', async () => {
  load.started();
  await new Promise<void>((resolve) => {
    load.finish = resolve;
  });
  return {
    MathPlotModal: ({ spec }: { spec: { expression: string } }) => (
      <div>Plot: {spec.expression}</div>
    ),
  };
});

it('keeps the plot bus active without loading controls and does not resurrect a cancelled opening', async () => {
  render(<MathPlotModalHost />);
  expect(load.started).not.toHaveBeenCalled();
  act(() =>
    openMathPlotModal({ kind: '2d', expression: 'x', x: { min: -1, max: 1 }, samples: 20 }),
  );
  await waitFor(() => expect(load.started).toHaveBeenCalledOnce());
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await act(async () => {
    load.finish();
  });
  expect(screen.queryByText('Plot: x')).toBeNull();
  act(() =>
    openMathPlotModal({ kind: '2d', expression: 'x^2', x: { min: -1, max: 1 }, samples: 20 }),
  );
  expect(await screen.findByText('Plot: x^2')).toBeTruthy();
});
