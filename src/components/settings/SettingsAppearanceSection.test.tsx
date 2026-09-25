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

    for (const label of ['Dark', 'Midnight', 'Warm', 'Light']) {
      const button = screen.getByRole('button', { name: new RegExp(`^${label}\\b`, 'i') });
      expect(button.className).toContain('grid-cols-[1rem_minmax(0,1fr)_1rem]');
      expect(button.children).toHaveLength(3);
    }

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
