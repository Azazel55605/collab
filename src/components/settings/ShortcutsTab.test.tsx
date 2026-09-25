import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ShortcutsTab from './ShortcutsTab';

describe('ShortcutsTab', () => {
  it('includes the document editors that own keyboard commands', () => {
    render(<ShortcutsTab />);

    expect(screen.getByText('Spreadsheets')).toBeTruthy();
    expect(screen.getByText('Ink Drawings')).toBeTruthy();
    expect(screen.getByText('SVG Editor')).toBeTruthy();
    expect(screen.getAllByText('Duplicate selection').length).toBeGreaterThanOrEqual(2);
  });

  it('searches generated ink shortcuts', () => {
    render(<ShortcutsTab />);
    fireEvent.change(screen.getByPlaceholderText('Search shortcuts...'), {
      target: { value: 'eyedropper' },
    });

    expect(screen.getByText('Ink Drawings')).toBeTruthy();
    expect(screen.getByText('Eyedropper')).toBeTruthy();
  });
});
