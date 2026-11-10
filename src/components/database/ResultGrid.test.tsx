import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import ResultGrid from './ResultGrid';

it('renders a bounded row window for 100,000 exact values and opens a read-only inspector', () => {
  const result = {
    columns: [
      {
        name: 'id',
        engine_type: 'bigint',
        nullable: false,
        generated: false,
        version_token: false,
        precision: null,
        scale: null,
      },
    ],
    rows: Array.from({ length: 100000 }, (_, index) => [
      { kind: 'integer' as const, decimal: String(index) },
    ]),
  };
  render(<ResultGrid result={result} />);
  expect(screen.getAllByRole('row').length).toBeLessThan(60);
  const grid = screen.getByRole('grid');
  expect(grid.getAttribute('aria-rowcount')).toBe('100001');
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 2799972 });
  fireEvent.scroll(grid);
  expect(screen.getByRole('gridcell', { name: '99999' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('gridcell', { name: '99999' }), { key: 'Enter' });
  expect(screen.getByRole('dialog').textContent).toContain('Read-only value');
  expect(screen.getByRole('dialog').textContent).toContain('"decimal": "99999"');
});
