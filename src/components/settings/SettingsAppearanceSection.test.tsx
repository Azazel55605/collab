import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsAppearanceSection from './SettingsAppearanceSection';

describe('SettingsAppearanceSection', () => {
  it('handles theme, accent, font, and interface font size changes', () => {
    const setTheme = vi.fn();
    const setAccentColor = vi.fn();
    const setInterfaceFont = vi.fn();
    const setInterfaceFontSize = vi.fn();

    render(
      <SettingsAppearanceSection
        theme="dark"
        setTheme={setTheme}
        accentColor="violet"
        setAccentColor={setAccentColor}
        interfaceFont="geist"
        setInterfaceFont={setInterfaceFont}
        interfaceFontSize={14}
        setInterfaceFontSize={setInterfaceFontSize}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /light/i }));
    expect(setTheme).toHaveBeenCalledWith('light');

    fireEvent.click(screen.getByLabelText(/accent emerald/i));
    expect(setAccentColor).toHaveBeenCalledWith('emerald');

    fireEvent.click(screen.getByRole('button', { name: /inter/i }));
    expect(setInterfaceFont).toHaveBeenCalledWith('inter');

    fireEvent.click(screen.getByRole('button', { name: '16px' }));
    expect(setInterfaceFontSize).toHaveBeenCalledWith(16);
  });
});
