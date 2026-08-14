import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ColorPicker } from './color-picker';

describe('ColorPicker', () => {
  it('uses app-owned popover controls instead of a native color input', () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <ColorPicker value="#ffffff" label="Paper colour" onValueChange={onValueChange} />,
    );

    expect(container.querySelector('input[type="color"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Paper colour' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Paper colour #7c3aed' }));
    expect(onValueChange).toHaveBeenCalledWith('#7c3aed');
  });

  it('accepts a valid custom hex value and rejects native-looking invalid input', () => {
    const onValueChange = vi.fn();
    render(<ColorPicker value="#ffffff" label="Ink colour" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ink colour' }));
    const input = screen.getByLabelText('Ink colour hex');
    fireEvent.change(input, { target: { value: '#123abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onValueChange).toHaveBeenCalledWith('#123abc');
  });
});
