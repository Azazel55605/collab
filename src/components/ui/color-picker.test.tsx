import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ColorPicker, hexToHsva, hsvaToHex, normalizeHex } from './color-picker';

describe('ColorPicker', () => {
  it('uses app-owned popover controls instead of a native color input', () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <ColorPicker value="#ffffff" label="Paper colour" onValueChange={onValueChange} />,
    );

    expect(container.querySelector('input[type="color"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Paper colour' }));
    expect(document.querySelector('input[type="range"]')).toBeNull();
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

  it('covers the full RGB range and normalizes shorthand values', () => {
    expect(hsvaToHex(hexToHsva('#00ff7f'), false)).toBe('#00ff7f');
    expect(hsvaToHex(hexToHsva('#000000'), false)).toBe('#000000');
    expect(hsvaToHex(hexToHsva('#ffffff'), false)).toBe('#ffffff');
    expect(normalizeHex('#f0a', false)).toBe('#ff00aa');
  });

  it('supports keyboard adjustment on the saturation and brightness plane', () => {
    const onValueChange = vi.fn();
    render(<ColorPicker value="#ff0000" label="Stroke colour" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stroke colour' }));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Stroke colour saturation and brightness' }), {
      key: 'ArrowLeft',
    });
    expect(onValueChange).toHaveBeenCalledWith('#ff0303');
  });

  it('emits alpha only when opacity is enabled', () => {
    const onValueChange = vi.fn();
    render(<ColorPicker value="#33669980" label="Overlay colour" allowAlpha onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay colour' }));
    fireEvent.change(screen.getByLabelText('Overlay colour hex'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onValueChange).toHaveBeenCalledWith('#12345678');
  });
});
